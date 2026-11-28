    // --- host data -----------------------------------------------------------

    /** sessionId → newest state payload from the host half. */
    const states = new Map();
    let hostInstance;
    let requestSequence = 0;
    let instanceRequestFloor = 0;
    let controlRevision = -1;
    let clientStopped = false;
    const retiredInstances = new Set();

    /** Instance changes replace the baseline; late replies cannot resurrect it. */
    function acceptInstance(value, request) {
      const instance = value?.instanceId;
      if (typeof instance !== 'string' || instance === '') return hostInstance === undefined;
      if (instance === hostInstance) return true;
      if (retiredInstances.has(instance) || request < instanceRequestFloor) return false;
      if (hostInstance !== undefined) retiredInstances.add(hostInstance);
      hostInstance = instance;
      instanceRequestFloor = request;
      states.clear();
      freshDecided.clear();
      branchHistory.clear();
      sessionSwitchRev = -1;
      controlRevision = -1;
      controlsReady = false;
      switchReady = false;
      sessionOff.clear();
      return true;
    }
    /**
     * Cache key for one row.
     *
     * `seq` is only unique inside a session, so keying these maps by `seq` alone
     * let session A's verdict about `seq: 1` be reused for session B's unrelated
     * `seq: 1` — a step could be treated as history in a session that had just
     * created it.
     */
    const rowKey = (sessionId, seq) => `${sessionId}:${seq}`;
    /** `${sessionId}:${seq}` → last rendered branch, for spotting a visible flash. */
    const branchHistory = new Map();
    /** `${sessionId}:${seq}` → whether the step was new when first seen. */
    const freshDecided = new Map();
    /** `${sessionId}:${seq}` → this step was rendered while it was running. */
    const liveSeen = new Set();
    /** `${sessionId}:${seq}` → the branch sequence, capped. */
    const diagnosticsTrail = new Map();
    const listeners = new Set();
    /** `${sessionId}` → poll handle, so several steps share one timer. */
    const pollers = new Map();
    const stateSubscriptions = new Set();
    let stateTransport;

    function syncSubscription(entry) {
      const status = stateTransport?.status(entry.sessionId);
      if (status === 'ready' || status === 'blocked') {
        entry.poll?.(); entry.poll = undefined;
      } else if (!entry.poll) entry.poll = watchPolling(entry.sessionId, entry.seq);
    }

    function watch(sessionId, seq) {
      const entry = { sessionId, seq };
      stateSubscriptions.add(entry);
      entry.remote = stateTransport?.subscribe(sessionId);
      syncSubscription(entry);
      return () => {
        stateSubscriptions.delete(entry);
        entry.poll?.(); entry.remote?.();
      };
    }

    /**
     * Per-session switch overrides. Only an explicit `false` is kept; a missing
     * entry means "follow the global switch", which keeps old sessions on.
     */
    const sessionOff = new Map();
    /** Monotonic map revision, matching the Host's answer. */
    let sessionSwitchRev = -1;
    /** Whether the first switch map has arrived; before that the UI is pending. */
    let switchReady = false;
    /** Listeners for components showing one session's switch. */
    const switchListeners = new Set();
    /** Last confirmed value of the global switch; false until the Host answers. */
    let globalEnabled = false;
    let controlsReady = false;
    let progressEnabled = false;
    const PROGRESS_WATCH = -1;
    const PROGRESS_PREFIX = '◈';
    const progressViewerId = `persona-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let progressViewRevision = 0;
    let progressViewerSession;
    /** Listeners for the global-switch state (the session switch respects it). */
    const globalListeners = new Set();

    function emit() {
      for (const listener of listeners) listener();
    }

    /** How long the Host may hold a state request before answering "no change". */
    const STATE_WAIT_MS = 15000;
    /** Backoff cap after a failed state request. */
    const STATE_ERROR_MAX_MS = 8000;

    /** An AbortError is the expected result of waking a held request. */
    function isAbortError(error) {
      return error !== null && typeof error === 'object' && error.name === 'AbortError';
    }

    /**
     * Read one session's state, optionally as a long-poll.
     *
     * `rev` is the revision the page already has. With `wait`, the Host holds
     * the request until a `touch()` moves that revision or the budget expires,
     * so a rewrite lands as soon as it moves instead of on a fixed cadence.
     * @param {string} sessionId
     * @param {{ rev?: number, wait?: number, signal?: AbortSignal }} [options]
     * @returns {Promise<{ ok: boolean, aborted?: boolean }>}
     */
    async function refresh(sessionId, options = {}) {
      const request = ++requestSequence;
      const { rev, wait, signal } = options;
      const query = new URLSearchParams({ session: sessionId });
      if (progressViewerSession === sessionId && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        query.set('viewing', '1'); query.set('viewer', progressViewerId); query.set('viewRev', String(progressViewRevision));
      }
      if (rev !== undefined) query.set('rev', String(rev));
      if (wait !== undefined) query.set('wait', String(wait));
      try {
        const response = await fetch(
          `${ROUTE}/state?${query.toString()}`,
          signal === undefined ? undefined : { signal },
        );
        if (!response.ok) {
          // Only failures are reported. A rejected fetch is the difference
          // between "no data yet" and "the route refuses this request", and it
          // is the one case with no other symptom — the transcript just stays
          // plain. Successes would be a write per poll for no extra insight.
          reportDiagnostics({ lastFetchError: { status: response.status, at: Date.now() } });
          return { ok: false };
        }
        const value = await response.json();
        if (clientStopped || signal?.aborted || !acceptInstance(value, request)) return { ok: true };
        applyState(sessionId, value);
        return { ok: true };
      } catch (error) {
        if (isAbortError(error)) return { ok: false, aborted: true };
        reportDiagnostics({
          lastFetchError: { error: error instanceof Error ? error.message : String(error), at: Date.now() },
        });
        return { ok: false };
      }
    }

    function applyState(sessionId, value) {
        const previous = states.get(sessionId);
        // A stale response must not overwrite a newer snapshot; the same rev can
        // still carry a meaningful switch-readiness transition after storage opens.
        if (previous !== undefined && Number.isFinite(previous.rev)
          && Number.isFinite(value?.rev) && value.rev < previous.rev) return;
        const changed = previous === undefined
          || previous.rev !== value?.rev
          || previous.sessionEnabled !== value?.sessionEnabled
          || previous.switchesReady !== value?.switchesReady
          || previous.settings?.enabled !== value?.settings?.enabled;
        states.set(sessionId, value);
        if (changed) emit();
    }

    /**
     * Keep one session's rewrites fresh with a long-poll loop.
     *
     * One poller per session, tracking every seq that asked for it. The previous
     * design asked on a fixed 100/300/6000ms cadence: a rewrite could finish just
     * after a poll and land in the visible jump the plugin exists to avoid. The
     * Host now holds the request open until something changes, and the client
     * immediately reissues it, so the loop only spends requests when there is
     * news (and still works through the Desktop IPC fetch carrier, unlike an
     * EventSource).
     */
    function watchPolling(sessionId, seq) {
      const key = sessionId;
      let poller = pollers.get(key);
      if (poller === undefined) {
        /** seq → subscriber count. Refcounted because several rows share a session. */
        const watched = new Map();
        let stopped = false;
        /** The single pending timer, or undefined when a request is in flight. */
        let timer;
        /** Whether a request is running. At most one, always. */
        let inFlight = false;
        /** Set when a sooner wake arrived while a request was running. */
        let wakePending = false;
        /** The AbortController of the request in flight, when the page has one. */
        let controller;
        let failures = 0;
        const canAbort = typeof AbortController === 'function';

        /** Schedule the next request, never creating a second timer. */
        const schedule = (delay) => {
          if (stopped) return;
          if (inFlight) {
            // A sooner wake arrived: abort the held request so a new row does
            // not wait out the Host's hold window.
            wakePending = true;
            if (delay === 0 && controller !== undefined) controller.abort();
            return;
          }
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(tick, delay);
        };

        /** Stop this poller and release its held request. */
        const stop = () => {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          if (controller !== undefined) controller.abort();
          pollers.delete(key);
        };

        const tick = async () => {
          timer = undefined;
          if (stopped) return;
          if (watched.size === 0) {
            // Nothing needs this session any more; release the poller.
            stop();
            return;
          }
          inFlight = true;
          controller = canAbort ? new AbortController() : undefined;
          // A held request that never settles would freeze this session's view
          // forever. The Host's own wait is 15s; abort a little later.
          const watchdog = canAbort
            ? setTimeout(() => { if (controller !== undefined) controller.abort(); }, STATE_WAIT_MS + 5000)
            : undefined;
          const currentRev = states.get(sessionId)?.rev;
          const knownRev = typeof currentRev === 'number';
          const started = Date.now();
          const result = await refresh(sessionId, {
            rev: knownRev ? currentRev : undefined,
            // No known revision means there is nothing to compare yet; fetch the
            // first state directly instead of asking the Host to hold. Without
            // AbortController a held request cannot be woken early, so use a
            // shorter hold instead of leaving a new row waiting 15s.
            wait: knownRev ? (canAbort ? STATE_WAIT_MS : 3000) : 0,
            signal: controller === undefined ? undefined : controller.signal,
          });
          if (watchdog !== undefined) clearTimeout(watchdog);
          inFlight = false;
          controller = undefined;
          if (stopped) return;
          if (result.aborted) {
            if (wakePending) {
              wakePending = false;
              schedule(0);
            } else {
              // Timeout/connection abort: retry, but do not spin.
              schedule(1000);
            }
            return;
          }
          if (result.ok) {
            failures = 0;
            wakePending = false;
            const afterRev = states.get(sessionId)?.rev;
            // A Host that does not implement `wait` answers immediately with the
            // same revision; do not turn that into a busy loop.
            const held = Date.now() - started > 200;
            schedule(afterRev !== currentRev || held ? 0 : 500);
            return;
          }
          failures += 1;
          schedule(Math.min(STATE_ERROR_MAX_MS, 500 * 2 ** Math.min(failures, 4)));
        };

        poller = {
          add(candidate) {
            if (typeof candidate !== 'number') return () => {};
            // Refcount, not a Set of ids.
            //
            // Two subscribers can watch the same seq — the shipped chat renders
            // one assistant node for both its reasoning and response partitions,
            // and this entry is asked about both. With a Set, the first unmount
            // removed the id and stopped polling while the other subscriber was
            // still displaying it.
            const next = (watched.get(candidate) ?? 0) + 1;
            watched.set(candidate, next);
            // A newly watched row must not wait behind the current hold.
            schedule(0);
            let released = false;
            return () => {
              if (released) return;
              released = true;
              const remaining = (watched.get(candidate) ?? 1) - 1;
              if (remaining <= 0) watched.delete(candidate);
              else watched.set(candidate, remaining);
              if (watched.size === 0) stop();
            };
          },
          /** Host-side teardown path: stop the held request and its timer. */
          stop,
        };
        pollers.set(key, poller);
      }
      return poller.add(seq);
    }

    // --- session-level switch -------------------------------------------------

    /** Installed by apply(); recomputes the chat takeover from both switches. */
    let refreshChatTakeover = () => {};

    function refreshTakeover(recover = false) {
      refreshChatTakeover(recover);
    }

    /** Keep report tools once the Host has answered; PersonaStep gates body replacement separately. */
    function reportToolsEnabled(ready) { return ready === true; }

    /** The Session whose header switch is currently mounted. */
    let activeSessionId;

    function setActiveSession(sessionId) {
      if (activeSessionId === sessionId) return;
      activeSessionId = sessionId;
      if (chatRuntime.opened && usableSessionId(sessionId)) chatRuntime.foreground(sessionId);
      // Warm the state cache before the chat rows mount. The header switch often
      // mounts first; this removes the cold-state gap for restored conversations.
      if (usableSessionId(sessionId)) void refresh(sessionId);
      refreshTakeover();
    }

    /** Update the client copy of the per-session switch map. */
    function applySessionSwitches(payload, request = ++requestSequence) {
      if (payload === null || typeof payload !== 'object') return;
      if (!acceptInstance(payload, request)) return;
      const rev = Number.isInteger(payload.rev) ? payload.rev : 0;
      // A settings poll that started before a newer toggle reply must not undo
      // the answer: the switch revision is monotonic on the Host.
      if (rev < sessionSwitchRev) return;
      sessionSwitchRev = rev;
      switchReady = true;
      sessionOff.clear();
      const values = payload.values !== null && typeof payload.values === 'object' ? payload.values : {};
      for (const [sessionId, value] of Object.entries(values)) {
        if (value === false) sessionOff.set(sessionId, false);
      }
      for (const listener of switchListeners) listener();
      refreshTakeover();
    }

    function applyControls(value, request) {
      if (!acceptInstance(value?.sessionSwitches ?? value, request)) return false;
      const rev = value.controlRev ?? value.rev;
      if (Number.isFinite(rev)) {
        if (rev < controlRevision) return false;
        controlRevision = rev;
      }
      if (typeof value.settings?.enabled === 'boolean') setGlobalEnabled(value.settings.enabled);
      setProgressEnabled(value.settings?.progressNotices === true);
      if (value.switchesReady !== false) applySessionSwitches(value.sessionSwitches, request);
      return true;
    }

    function useSessionSwitch(sessionId) {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        switchListeners.add(listener);
        return () => switchListeners.delete(listener);
      }, []);
      return sessionOff.get(sessionId) !== false;
    }

    function useSwitchReady() {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        switchListeners.add(listener);
        return () => switchListeners.delete(listener);
      }, []);
      return switchReady;
    }

    function useGlobalEnabled() {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        globalListeners.add(listener);
        return () => globalListeners.delete(listener);
      }, []);
      return globalEnabled;
    }

    function setGlobalEnabled(value) {
      const changed=!controlsReady||globalEnabled!==value;
      controlsReady=true;globalEnabled=value;
      if(!changed)return;
      for (const listener of globalListeners) listener();
      refreshTakeover(true);
    }

    function setProgressEnabled(value) {
      if (progressEnabled === value) return;
      progressEnabled = value;
      for (const listener of globalListeners) listener();
    }

    /** Explicit view changes release leases; existing long-polls renew them. */
    function announceProgressView(sessionId) {
      progressViewerSession = sessionId;
      progressViewRevision += 1;
      const visible = usableSessionId(sessionId) && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
      stateTransport?.setView({ sessionId, revision: progressViewRevision, visible });
      // The legacy route also releases any lease left by a fallback generation.
      void fetch(`${ROUTE}/progress-view`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewer: progressViewerId, revision: progressViewRevision, visible,
          sessionId: visible ? sessionId : undefined }),
      }).catch(() => {});
    }

    /** A separate composer-dock status, never a synthetic assistant message. */
