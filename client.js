window.__ModuleLoader__.load({
  id: 'dsh-persona-shell',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    /** Run before paint when the shell's React provides it (the test mock does not). */
    const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

    const ROUTE = '/persona-shell';

    // BEGIN GENERATED STATE TRANSPORT
    function createRemoteContract() {
  const boundedString = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw new TypeError('Invalid state subscription');
    return value;
  };
  const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `persona-shell#${name}`, create: () => ({ parse }) });
  const session = codec('SessionKey', (value) => boundedString(value, 200));
  const view = codec('ViewLease', (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['viewer', 'revision', 'visible'].includes(key))
      || typeof value.visible !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || boundedString(value.viewer, 100) === '') throw new TypeError('Invalid view lease');
    return value;
  });
  const frame = codec('StateFrame', (value) => {
    if (!value || !['snapshot', 'delta'].includes(value.type)
      || typeof value.instanceId !== 'string' || !value.instanceId
      || !Number.isSafeInteger(value.rev) || value.rev < 0) throw new TypeError('Invalid state frame');
    return value;
  });
  return {
    package: 'dsh-persona-shell',
    descriptors: [{
      id: 'dsh-persona-shell#personaShell/observe', service: 'personaShell', namespace: 'personaShell',
      method: 'observe', mode: 'stream', invocation: { kind: 'direct' },
      parameters: [{ name: 'key', wire: 'key', source: 'json', codec: session }],
      cancellation: { parameter: 'signal' }, uplink: { codec: view }, result: frame,
    }],
  };
}

    function createClientTransport({ remote, SnapshotStream, CarrierError, contribution, onState, onStatus,
  nextRequest, viewer, bindRemote, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const entries = new Map();
  const pendingCloses = new Set();
  const compatibility = new Set(['gateway/definition-unavailable', 'gateway/invocation-unavailable',
    'gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/interactions-forbidden']);
  let stopped = false;
  let mounted = false;
  let mounting;
  let unmount;
  let unbind;
  let boundRemote = remote;
  let leaseTimer;
  let view;

  const status = (entry, value, error) => {
    if (entry.status === value && error === undefined) return;
    entry.status = value;
    onStatus(entry.key, value, error);
  };
  const trackClose = (promise) => {
    const task = Promise.resolve(promise).catch(() => {});
    pendingCloses.add(task);
    void task.finally(() => pendingCloses.delete(task));
    return task;
  };
  const close = (entry) => {
    clearTimer(entry.deadline);
    entry.token = undefined;
    const stream = entry.stream;
    entry.stream = undefined;
    entry.handle = undefined;
    return stream ? trackClose(stream.dispose()) : Promise.resolve();
  };
  const sendView = (entry) => {
    if (!entry.handle || entry.key === '') return;
    const visible = view?.visible === true && view.sessionId === entry.key;
    try { entry.handle.send({ viewer, revision: view?.revision ?? 0, visible }); } catch { /* generation is closing */ }
  };
  const scheduleLease = () => {
    clearTimer(leaseTimer);
    leaseTimer = undefined;
    if (stopped || view?.visible !== true) return;
    const entry = entries.get(view.sessionId);
    if (!entry?.handle) return;
    leaseTimer = setTimer(() => { sendView(entry); scheduleLease(); }, 15000);
  };

  function open(entry) {
    if (stopped || !mounted || !entry.count || entry.stream) return;
    const token = {};
    entry.token = token;
    const current = () => !stopped && entry.token === token && entries.get(entry.key) === entry;
    status(entry, 'starting');
    let baseline;
    let request;
    const failed = (error) => {
      if (!current()) return;
      const carrier = error instanceof CarrierError || error?.cause instanceof CarrierError;
      const fallback = compatibility.has(error?.code) || carrier || error?.code === 'persona-shell/stream-timeout';
      // Auth/business/protocol failures remain visible diagnostics, not compatibility probes.
      status(entry, fallback ? 'fallback' : 'blocked', error);
      void close(entry);
      scheduleLease();
    };
    const publish = (frame, snapshot) => {
      if (!current()) return;
      contribution.descriptors[0].result.create().parse(frame);
      if (!frame.settings || typeof frame.settings !== 'object') throw new Error('Missing state settings');
      if (snapshot) {
        if (!Array.isArray(frame.rows)) throw new Error('Missing state baseline');
        baseline = { ...frame };
      } else {
        if (!baseline || baseline.instanceId !== frame.instanceId || baseline.rev !== frame.baseRev
          || frame.rev < baseline.rev || !Array.isArray(frame.upsert) || !Array.isArray(frame.removed)) {
          throw new Error('State delta does not follow its baseline');
        }
        const rows = new Map(baseline.rows.map((row) => [row.seq, row]));
        for (const seq of frame.removed) rows.delete(seq);
        for (const row of frame.upsert) rows.set(row.seq, row);
        baseline = { ...frame, rows: [...rows.values()].sort((a, b) => a.seq - b.seq) };
      }
      if (onState(entry.key, baseline, request) === false) return;
      clearTimer(entry.deadline);
      status(entry, 'ready');
    };
    const logical = remote.$stream({ name: `persona-shell:${entry.key || 'control'}`,
      open(signal) {
        request = nextRequest();
        baseline = undefined;
        const handle = boundRemote.personaShell.observe(entry.key, signal);
        entry.handle = handle;
        signal.addEventListener('abort', () => {
          if (entry.handle === handle) { entry.handle = undefined; scheduleLease(); }
        }, { once: true });
        sendView(entry); scheduleLease();
        return handle;
      },
      ended: () => new CarrierError('Persona Shell state stream ended'),
    });
    entry.stream = new SnapshotStream(logical, {
      name: 'persona-shell', isSnapshot: (frame) => frame?.type === 'snapshot',
      replace: (frame) => publish(frame, true), update: (frame) => publish(frame, false), failed,
    });
    entry.deadline = setTimer(() => {
      const error = Object.assign(new Error('State stream did not open'), { code: 'persona-shell/stream-timeout' });
      failed(error);
    }, 10000);
    entry.stream.start();
  }

  return {
    start() {
      return mounting ??= (async () => {
        try {
          unmount = await remote.$mount(contribution);
          if (stopped) return;
          const bind = (value) => {
            if (stopped) return;
            boundRemote = value;
            mounted = value !== undefined;
            for (const entry of entries.values()) {
              if (mounted) open(entry);
              else { void close(entry); status(entry, 'fallback'); }
            }
          };
          if (bindRemote) unbind = bindRemote(bind);
          else bind(remote);
        } catch (error) {
          if (!stopped) for (const entry of entries.values()) status(entry, 'fallback', error);
        }
      })();
    },
    subscribe(key) {
      let entry = entries.get(key);
      if (!entry) { entry = { key, count: 0, status: 'fallback' }; entries.set(key, entry); }
      entry.count += 1;
      open(entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--entry.count > 0) return;
        entries.delete(key);
        void close(entry);
        scheduleLease();
      };
    },
    status: (key) => entries.get(key)?.status ?? 'fallback',
    setView(value) {
      view = value;
      for (const entry of entries.values()) sendView(entry);
      scheduleLease();
    },
    restart() {
      for (const entry of entries.values()) {
        if (!entry.stream && entry.status !== 'blocked') open(entry);
      }
    },
    async dispose() {
      stopped = true;
      clearTimer(leaseTimer);
      await Promise.all([...entries.values()].map(close));
      entries.clear();
      await Promise.all([...pendingCloses]);
      await mounting;
      const withdraw = unbind;
      unbind = undefined;
      await withdraw?.();
      const release = unmount;
      unmount = undefined;
      await release?.();
    },
  };
}
    // END GENERATED STATE TRANSPORT

    /**
     * Bumped whenever the client changes shape.
     *
     * Sent on load and on the first render, so "is the page running the code I
     * just installed?" is answerable instead of assumed. A stale bundle and a
     * broken one look identical otherwise.
     */
    const CLIENT_BUILD = 2026102902;

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

    function refreshTakeover() {
      refreshChatTakeover();
    }

    /**
     * Whether the page-level chat takeover should be installed.
     *
     * Registration is page-wide because `conversation.chat.node` is a keyed slot;
     * the Web UI shows one Session at a time, so gating on the active Session is
     * what makes "off" mean the official renderer comes back in full.
     */
    function chatTakeoverEnabled(global, sessionId, off) {
      return global === true && (sessionId === undefined || off.get(sessionId) !== false);
    }

    /** The Session whose header switch is currently mounted. */
    let activeSessionId;

    function setActiveSession(sessionId) {
      if (activeSessionId === sessionId) return;
      activeSessionId = sessionId;
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
      if (globalEnabled === value) return;
      globalEnabled = value;
      for (const listener of globalListeners) listener();
      refreshTakeover();
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
    function ProgressNotice({ sessionId, t }) {
      const master = useGlobalEnabled();
      const sessionOn = useSessionSwitch(sessionId);
      const enabled = master && progressEnabled && sessionOn;
      const [visible, setVisible] = React.useState(typeof document === 'undefined' || document.visibilityState !== 'hidden');
      React.useEffect(() => {
        if (!enabled || !usableSessionId(sessionId)) return undefined;
        const update = () => {
          const shown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
          setVisible(shown);
          announceProgressView(shown ? sessionId : undefined);
        };
        update();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update);
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update);
          // Do not let an old Session's cleanup release a newer Session's lease.
          if (progressViewerSession === sessionId) announceProgressView(undefined);
        };
      }, [sessionId, enabled]);
      // This subscriber exists even before the first assistant node is committed.
      const { state } = useHostState(sessionId, enabled && visible ? PROGRESS_WATCH : undefined);
      const notice = enabled && visible && state?.settings?.progressNotices === true
        && state?.settings?.enabled !== false && state?.sessionEnabled !== false ? state?.progress : undefined;
      if (typeof notice?.text !== 'string' || notice.text === '') return null;
      const label = shellTranslate(t)('shell.progressNotice') ?? '静默状态播报（插件生成，不是主模型消息）';
      return h('div', {
        'data-persona-shell': 'progress', role: 'status', 'aria-live': 'polite', 'aria-atomic': true, 'aria-label': label,
        style: { display: 'flex', gap: '8px', padding: '8px 12px', minWidth: 0, maxWidth: '100%',
          color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
          borderRadius: '8px', fontSize: '13px', lineHeight: '1.6', overflowWrap: 'anywhere' },
      }, h('span', { 'aria-hidden': true, title: `${label}\n${notice.source ?? ''}`,
        style: { color: 'var(--dsw-alias-brand-primary)', flex: 'none', cursor: 'help' } }, PROGRESS_PREFIX),
      h('span', { style: { minWidth: 0, whiteSpace: 'pre-wrap' } }, notice.text));
    }

    /**
     * The per-session switch in the conversation header.
     *
     * It also tells the controller which Session is on screen: the chat
     * takeover is page-wide, so "this session is off" is implemented by
     * releasing it while that Session is viewed, which gives the official
     * renderer back in full (reasoning, images, interrupted/running states).
     */
    function SessionPersonaSwitch({ sessionId, t }) {
      const enabled = useSessionSwitch(sessionId);
      const ready = useSwitchReady();
      const global = useGlobalEnabled();
      const [pending, setPending] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      useLayoutEffect(() => {
        if (typeof sessionId !== 'string') return undefined;
        setActiveSession(sessionId);
        return () => setActiveSession(undefined);
      }, [sessionId]);
      const toggle = async () => {
        if (pending || global !== true || typeof sessionId !== 'string') return;
        setPending(true);
        setFailed(false);
        const request = ++requestSequence;
        try {
          const response = await fetch(`${ROUTE}/session-switch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: !enabled }),
          });
          if (!response.ok) throw new Error(String(response.status));
          const value = await response.json();
          applySessionSwitches(value?.sessionSwitches, request);
        } catch {
          setFailed(true);
        } finally {
          setPending(false);
        }
      };

      const label = t?.('shell.personaSwitch') ?? '人格';
      const stateText = !ready
        ? '…'
        : pending
          ? '…'
          : enabled
            ? (t?.('shell.personaSwitchOn') ?? '开')
            : (t?.('shell.personaSwitchOff') ?? '关');
      const title = !ready
        ? (t?.('shell.personaSwitchLoading') ?? '正在读取会话开关')
        : global !== true
          ? (t?.('shell.personaSwitchGlobalOff') ?? '总开关已关闭')
          : failed
            ? (t?.('shell.personaSwitchFailed') ?? '保存失败')
            : (t?.('shell.personaSwitchHint') ?? '仅对当前会话生效');

      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        title,
        disabled: !ready || pending || global !== true,
        onClick: toggle,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '24px',
          padding: '0 8px',
          borderRadius: '999px',
          border: `0.5px solid ${enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
          background: enabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: failed
            ? 'var(--dsw-alias-state-error-primary)'
            : enabled
              ? 'var(--dsw-alias-brand-primary)'
              : 'var(--dsw-alias-label-tertiary)',
          fontSize: '12px',
          lineHeight: '1',
          cursor: pending || global !== true ? 'default' : 'pointer',
          opacity: pending ? 0.6 : 1,
        },
      }, h('span', null, label), h('span', null, stateText));
    }

    /**
     * Whether a value is usable as a session id.
     *
     * A literal `"undefined"` or `"null"` passes a plain `typeof` check and then
     * silently fetches nothing: the host answers `rows: []` for an unknown
     * session, so every row falls back to the plain report and the whole persona
     * view disappears with no error anywhere. Rejecting those values turns a
     * silent blank into a visible one.
     * @param {unknown} value
     */
    function usableSessionId(value) {
      if (typeof value !== 'string' || value === '') return false;
      if (value === 'undefined' || value === 'null') return false;
      return true;
    }

    function useHostState(sessionId, seq) {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        listeners.add(listener);
        const stop = usableSessionId(sessionId) && typeof seq === 'number' ? watch(sessionId, seq) : () => {};
        if (!usableSessionId(sessionId)) {
          // Report once per page: this is the difference between "the plugin is
          // off" and "the plugin cannot see the session", and they look identical.
          reportDiagnostics({ sessionId: String(sessionId), sessionIdUsable: false });
        }
        return () => {
          listeners.delete(listener);
          stop();
        };
      }, [sessionId, seq]);
      return { state: states.get(sessionId), version };
    }

    // --- text rendering ------------------------------------------------------

    /**
     * The shipped markdown renderer, resolved from the shell's module table.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is part of the frozen
     * `PLATFORM_MODULES` baseline the shell seeds before any plugin runs: the
     * shipped chat package resolves it exactly this way and declares no
     * `dsh.client.external` entry for it. Reusing it means the persona view runs
     * the host's real renderer — same parser, same Shiki highlighting, same
     * KaTeX, same tables — instead of a look-alike.
     *
     * Only isolated previews use this helper; the transcript uses the full
     * official assistant adapter below. Missing primitives get plain text,
     * never an imitation Markdown implementation.
     */
    /**
     * @typedef {object} MarkdownRenderer
     * @property {(props: object) => unknown} component - renderer for one markdown document.
     */

    /**
     * Resolve the shipped markdown renderer from the shell's module table.
     *
     * `MarkdownText` is `React.memo(...)`, so its runtime value is an exotic
     * object, **not** a function: a `typeof === 'function'` check rejects the
     * very thing it is looking for. What matters for rendering is that React can
     * treat the value as an element type, which is true for memo and forwardRef
     * objects alike, so the check asks for something callable *or* one of those
     * wrapper shapes.
     * @param {unknown} value
     * @returns {boolean}
     */
    function isElementType(value) {
      if (typeof value === 'function') return true;
      if (value === null || typeof value !== 'object') return false;
      // React.memo({$$typeof: Symbol(react.memo), type}) and forwardRef both
      // carry a $$typeof marker; either one is a valid element type.
      return typeof value.$$typeof === 'symbol';
    }

    /**
     * Whether the shipped renderer resolved. Mirrored locally so the settings
     * page can warn without a round trip: the degradation is visible in the
     * transcript, but the reason belongs next to the controls that cause it.
     */
    let shippedRendererOk = true;

    function shippedMarkdownText() {
      if (markdownResolved) return markdownComponent;
      markdownResolved = true;
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const candidate = primitives?.MarkdownText;
        markdownComponent = isElementType(candidate) ? candidate : undefined;
        shippedRendererOk = markdownComponent !== undefined;
        reportDiagnostics({
          ...describePrimitives(primitives, candidate),
          accepted: markdownComponent !== undefined,
        });
      } catch (error) {
        markdownComponent = undefined;
        shippedRendererOk = false;
        reportDiagnostics({
          shippedMarkdown: 'unresolvable',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return markdownComponent;
    }

    /**
     * Describe what the module table actually handed over.
     *
     * A bare "not a function" is not enough to act on: the value could be a
     * namespace without the key, a lazy proxy, or a module object that needs a
     * different access path. Reporting the shape once per page turns guesswork
     * into a fact.
     * @param {unknown} primitives
     * @param {unknown} component
     * @returns {Record<string, unknown>}
     */
    function describePrimitives(primitives, component) {
      const accepted = isElementType(component);
      const report = {
        shippedMarkdown: accepted ? 'ok' : 'missing',
        reason: accepted ? '' : `MarkdownText is ${component === null ? 'null' : typeof component}`,
        componentType: component === null ? 'null' : typeof component,
        moduleType: typeof primitives,
      };
      try {
        if (primitives !== null && typeof primitives === 'object') {
          const keys = Object.keys(primitives);
          report.keyCount = keys.length;
          report.markdownKeys = keys.filter((key) => /mark/i.test(key)).slice(0, 12);
          report.hasDefault = 'default' in primitives;
        }
      } catch (error) {
        report.shapeError = error instanceof Error ? error.message : String(error);
      }
      return report;
    }

    /**
     * Tell the host half whether the shipped renderer resolved in this page.
     *
     * There is no way to see a page's module table from the outside, and a
     * silent fallback is indistinguishable from a working one. Reporting it once
     * per page turns "did it work?" into a queryable fact.
     * @param {{ shippedMarkdown: string, reason: string }} payload
     */
    function reportDiagnostics(payload) {
      try {
        void fetch(`${ROUTE}/diagnostics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Every report carries the build id. The page cannot be force-reloaded
          // in the desktop client, so "is the running code the installed code?"
          // is otherwise unanswerable — and a stale bundle silently invalidates
          // every fix made since the last restart.
          body: JSON.stringify({ clientBuild: CLIENT_BUILD, ...payload }),
        }).catch(() => {});
      } catch {
        // Diagnostics must never interfere with rendering.
      }
    }

    let markdownResolved = false;
    let markdownComponent;

    /** Labels the shipped renderer shows on code blocks and footnote sections. */
    const MARKDOWN_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码',
          wrapLabel: '自动换行',
          unwrapLabel: '取消换行',
        },
      },
      footnotes: '脚注',
    };

    /**
     * Last-resort body when the shipped renderer cannot be resolved.
     *
     * Intentionally obvious: plain preformatted text with no attempt to look
     * like markdown. A fake markdown renderer would hide its own gaps (no
     * highlighting, no KaTeX, no footnotes) behind a plausible appearance, so
     * the reader would keep using a broken view for months. This cannot be
     * mistaken for correct, and the settings page raises a warning alongside it.
     */
    const PLAIN_FALLBACK_STYLE = {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      font: 'var(--dsw-font-markdown-base, inherit)',
      margin: '16px 0',
    };

    /**
     * Render one block of markdown through the shipped renderer.
     *
     * There is deliberately no local re-implementation behind this. A copy of
     * the shipped renderer never keeps up with the original, and "looks nearly
     * right but silently lacks highlighting, KaTeX and footnotes" is a worse
     * outcome than an obviously degraded one: the first hides the problem for
     * months, the second gets reported immediately.
     *
     * If the module table ever stops carrying `MarkdownText`, the preview degrades
     * to plain preformatted text — visibly wrong, cheap to maintain — and the
     * settings page shows a warning. Fidelity is the shipped component's job.
     * @param {string} text
     * @returns {any}
     */
    function renderMarkdown(text) {
      const MarkdownText = shippedMarkdownText();
      if (MarkdownText !== undefined) {
        return h(MarkdownText, { text, labels: MARKDOWN_LABELS });
      }
      return h('div', { style: PLAIN_FALLBACK_STYLE }, text);
    }

    // --- official assistant adapter -----------------------------------------

    const CHAT_SLOT = 'conversation.chat.node';
    const CHILD_FACTORIES = {
      'conversation.chat.reasoning.body': 'conversation.chat.reasoning.content',
      'conversation.chat.message.images': 'conversation.images.content',
    };
    let chatRendererState = { status: 'disabled', reason: '' };
    const rendererListeners = new Set();

    function setChatRendererState(status, reason = '') {
      if (chatRendererState.status === status && chatRendererState.reason === reason) return;
      chatRendererState = { status, reason };
      reportDiagnostics({ chatRenderer: status, chatRendererReason: reason });
      for (const listener of rendererListeners) listener();
    }

    function componentName(component) {
      return typeof component === 'function' ? component.name : component?.type?.name;
    }

    /** Read-only inspection; an unknown host/extension keeps its own renderer. */
    function resolveChatDelegate(slots, ownComponent) {
      const reject = (reason) => ({ ok: false, reason });
      if (['entries', 'entriesOfSlot', 'subscribe', 'snapshot', 'onEntryError'].some((key) => typeof slots?.[key] !== 'function')) {
        return reject('registry-api-unavailable');
      }
      const entries = slots.entries(CHAT_SLOT).filter((entry) => entry.options?.key === 'assistant-step'
        && entry.component !== ownComponent);
      if (entries.length !== 1) return reject(entries.length === 0 ? 'official-assistant-missing' : 'assistant-slot-conflict');
      const entry = entries[0];
      // `registrant` is a Cordis display name (often an ancestor's name), not
      // a package id. Check the supported contract, not diagnostic provenance.
      if (componentName(entry.component) !== 'AssistantNodeView' || (entry.options.priority ?? 0) !== 0
        || !isElementType(entry.component) || entry.locale !== 'chat' || typeof entry.inject !== 'function'
        || entry.store !== undefined || entry.select !== undefined) return reject('unsupported-assistant-contract');
      const childKeys = Object.keys(entry.children ?? {});
      if (childKeys.length !== 2 || childKeys.some((key) => !Object.hasOwn(CHILD_FACTORIES, key)
        || entry.children[key]?.kind !== 'single' || entry.children[key]?.scope !== 'session'
        || Object.keys(entry.children[key]).some((field) => field !== 'kind' && field !== 'scope'))) {
        return reject('unsupported-assistant-children');
      }
      const children = [];
      for (const key of childKeys) {
        const expectedName = key.endsWith('.images') ? 'MessageImages' : 'DefaultReasoningBody';
        const candidates = slots.entries(key);
        const winners = slots.entriesOfSlot(key);
        const child = winners[0];
        if (candidates.length !== 1 || winners.length !== 1 || child !== candidates[0]
          || child.options?.priority !== 100
          || componentName(child.component) !== expectedName
          || child.inject !== undefined || child.children !== undefined || child.store !== undefined
          || child.locale !== undefined || child.select !== undefined) return reject('child-slot-conflict');
        const factory = slots.snapshot(`factory:${CHILD_FACTORIES[key]}`)[0];
        if (factory?.type !== 'factory' || factory.name !== CHILD_FACTORIES[key]
          || factory.scope !== 'root' || factory.registrant !== child.registrant
          || factory.children?.length > 0) return reject('official-factory-unavailable');
        children.push(child);
      }
      return { ok: true, entry, children };
    }

    /** Only a display copy changes; the durable finalNode and other blocks stay shared. */
    function displayNode(node, text) {
      if (typeof text !== 'string' || node?.data?.status !== 'settled') return node;
      const blocks = node.data.blocks;
      if (!Array.isArray(blocks) || blocks.filter((block) => block?.kind === 'text').length !== 1) return node;
      if (blocks.some((block) => block?.kind === 'text' && block.text === text)) return node;
      return { ...node, data: { ...node.data, blocks: blocks.map((block) => block?.kind === 'text' ? { ...block, text } : block) } };
    }

    const childRendererCache = new WeakMap();
    const childAnchorStyle = { display: 'contents' };

    /** Equivalent to the two official default adapters, without claiming their children. */
    function renderOfficial(delegate, props, node = props.node) {
      if (typeof props.renderFactorySlot !== 'function') throw new Error('persona-shell: Factory renderer unavailable');
      let renderSlot = childRendererCache.get(props.renderFactorySlot);
      if (renderSlot === undefined) {
        const renderFactorySlot = props.renderFactorySlot;
        renderSlot = (key, owner) => {
          if (!Object.hasOwn(CHILD_FACTORIES, key)) throw new Error('persona-shell: unsupported official child');
          // Preserve the default outlet's addressable, layout-neutral anchor;
          // themes may select it even though we cannot borrow its authorization.
          return h('div', { 'data-slot': key, style: childAnchorStyle }, renderFactorySlot(CHILD_FACTORIES[key], owner));
        };
        childRendererCache.set(renderFactorySlot, renderSlot);
      }
      return h(delegate.entry.component, { ...props, node, renderSlot });
    }

    /** Chat owns its own locale seat; missing shell copy must not display a key. */
    function shellTranslate(t) {
      return (key) => {
        const value = t?.(key);
        return typeof value === 'string' && value !== key && !value.endsWith(`.${key}`) ? value : undefined;
      };
    }

    // --- components ----------------------------------------------------------

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '4px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '1.4',
    };
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 6px',
      borderRadius: '4px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
    };
    const toggleStyle = {
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
      font: 'inherit',
      padding: 0,
    };
    const paneLabelStyle = {
      marginBottom: '4px',
      fontSize: '11px',
      lineHeight: '16px',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    const COMPARISON_NARROW_WIDTH = 720;
    const COMPARISON_CSS = `
      .persona-shell-comparison[role="dialog"] {
        width: min(1100px, 100%); max-width: 100%; min-width: 0;
        height: min(720px, 80vh); height: min(720px, 80dvh);
        max-height: 100%; min-height: 0; padding: 0; gap: 0;
        color: var(--dsw-alias-label-primary);
      }
      .persona-shell-comparison-surface {
        display: flex; flex-direction: column; flex: 1;
        min-width: 0; min-height: 0; overflow: hidden;
        font-size: var(--dsh-content-font-size, 14px); line-height: 1.6;
      }
      .persona-shell-comparison-header {
        display: flex; align-items: center; justify-content: space-between;
        flex: none; gap: 12px; padding: 14px 18px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l1);
      }
      .persona-shell-comparison-header h2 {
        margin: 0; font-size: 16px; font-weight: 500; overflow-wrap: anywhere;
      }
      .persona-shell-comparison button {
        font: inherit; cursor: pointer; border: 0; border-radius: 4px;
        padding: 4px 10px; min-height: 32px;
        color: var(--dsw-alias-label-secondary); background: transparent;
      }
      .persona-shell-comparison button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .persona-shell-comparison-header button { flex: none; }
      .persona-shell-comparison-tabs { display: flex; flex: none; gap: 4px; padding: 8px 12px; }
      .persona-shell-comparison-tabs button { flex: 1; }
      .persona-shell-comparison-tabs [aria-selected="true"] {
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover);
      }
      .persona-shell-comparison-panes { display: grid; flex: 1; min-width: 0; min-height: 0; }
      .persona-shell-comparison-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .persona-shell-comparison-pane + .persona-shell-comparison-pane {
        border-inline-start: 0.5px solid var(--dsw-alias-border-l1);
      }
      .persona-shell-comparison-surface[data-narrow="true"] .persona-shell-comparison-pane { border: 0; }
      .persona-shell-comparison-pane h3 {
        flex: none; margin: 0; padding: 10px 18px; font-size: 12px;
        font-weight: 500; color: var(--dsw-alias-label-secondary);
      }
      .persona-shell-comparison-scroll {
        flex: 1; min-width: 0; min-height: 0; padding: 4px 18px 18px;
        overflow: auto; overscroll-behavior: contain; overflow-wrap: anywhere;
        scrollbar-gutter: stable;
      }
      .persona-shell-comparison-scroll pre { max-width: 100%; overflow: auto; }
      .persona-shell-comparison [hidden] { display: none; }
      .persona-shell-comparison[data-native] {
        box-sizing: border-box; position: fixed; margin: auto;
        width: min(1100px, calc(100vw - 48px));
        max-height: calc(100dvh - 48px); border: 0;
        border-radius: var(--dsw-radius-panel, 12px); overflow: hidden;
        background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent);
      }
      .persona-shell-comparison[data-native][open] { display: flex; flex-direction: column; }
      .persona-shell-comparison[data-native]::backdrop { background: var(--dsw-alias-bg-mask-1); }
      @media (pointer: coarse) { .persona-shell-comparison button { min-height: 44px; min-width: 44px; } }
    `;
    let nextComparisonId = 0;
    let comparisonModal;
    let comparisonModalResolved = false;
    const comparisonScrollLocks = new WeakMap();

    /** The host Modal traps focus, but wheel/page keys can still scroll the page. */
    function lockComparisonScroll(doc) {
      if (!doc.documentElement?.style || !doc.body?.style) return () => {};
      let lock = comparisonScrollLocks.get(doc);
      if (lock === undefined) {
        const root = doc.documentElement;
        const saved = [root, doc.body].map((element) => ({ element,
          overflow: ['overflow-x', 'overflow-y'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
        }));
        const gutter = root.style.getPropertyValue('scrollbar-gutter');
        const gutterPriority = root.style.getPropertyPriority('scrollbar-gutter');
        const reserveGutter = doc.defaultView?.innerWidth > root.clientWidth
          && !/\bstable\b/.test(doc.defaultView.getComputedStyle(root).scrollbarGutter);
        if (reserveGutter) root.style.setProperty('scrollbar-gutter', 'stable');
        for (const { element } of saved) element.style.setProperty('overflow', 'hidden');
        lock = { count: 0, restore() {
          for (const { element, overflow } of saved) {
            if (element.style.getPropertyValue('overflow') === 'hidden') {
              element.style.removeProperty('overflow');
              for (const [name, value, priority] of overflow) if (value) element.style.setProperty(name, value, priority);
            }
          }
          if (reserveGutter && root.style.getPropertyValue('scrollbar-gutter') === 'stable') {
            if (gutter) root.style.setProperty('scrollbar-gutter', gutter, gutterPriority);
            else root.style.removeProperty('scrollbar-gutter');
          }
        } };
        comparisonScrollLocks.set(doc, lock);
      }
      lock.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--lock.count !== 0) return;
        lock.restore(); comparisonScrollLocks.delete(doc);
      };
    }

    function shippedComparisonModal() {
      if (!comparisonModalResolved) {
        comparisonModalResolved = true;
        try {
          const candidate = require('@deepseek-ai/dsh-client-ui-primitives')?.Modal;
          if (isElementType(candidate)) comparisonModal = candidate;
        } catch { /* Older hosts can still use the browser's modal dialog. */ }
        if (comparisonModal === undefined) reportDiagnostics({ comparisonModal: 'native-fallback' });
      }
      return comparisonModal ?? NativeComparisonModal;
    }

    /** Only used when a host lacks Modal; native top-layer focus/escape semantics. */
    function NativeComparisonModal({ onClose, title, className, children }) {
      const ref = React.useRef(null);
      useLayoutEffect(() => {
        const dialog = ref.current;
        const previous = dialog.ownerDocument.activeElement;
        dialog.showModal();
        return () => {
          dialog.close();
          if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
      }, []);
      return h('dialog', {
        ref, className, role: 'dialog', 'aria-modal': true, 'aria-label': title, 'data-native': '',
        onCancel: (event) => { event.preventDefault(); onClose(); },
        onClick: (event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
        },
      }, children);
    }

    /** Read-only snapshots in a body portal; the live assistant is never moved. */
    function ComparisonDialog({ original, persona, onClose, t }) {
      const [active, setActive] = React.useState('original');
      const [narrow, setNarrow] = React.useState(false);
      const surfaceRef = React.useRef(null);
      const originalRef = React.useRef(null);
      const personaRef = React.useRef(null);
      const originalTabRef = React.useRef(null);
      const personaTabRef = React.useRef(null);
      const positions = React.useRef({ original: 0, persona: 0 });
      const idRef = React.useRef(null);
      if (idRef.current === null) idRef.current = `persona-shell-comparison-${++nextComparisonId}`;
      const id = idRef.current;
      useLayoutEffect(() => {
        const element = surfaceRef.current;
        const view = element.ownerDocument.defaultView;
        const releaseScroll = lockComparisonScroll(element.ownerDocument);
        const measure = () => {
          const width = element.getBoundingClientRect().width;
          if (width > 0) setNarrow(width < COMPARISON_NARROW_WIDTH);
        };
        measure();
        const observer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(measure) : undefined;
        observer?.observe(element);
        view?.addEventListener('resize', measure);
        return () => { observer?.disconnect(); view?.removeEventListener('resize', measure); releaseScroll(); };
      }, []);
      useLayoutEffect(() => {
        for (const [side, ref] of [['original', originalRef], ['persona', personaRef]]) {
          if (!narrow || active === side) ref.current.scrollTop = positions.current[side];
        }
      }, [active, narrow]);
      const title = t?.('shell.compareTitle') ?? '原文对照';
      const labels = { original: t?.('shell.originalLabel') ?? '原文', persona: t?.('shell.personaLabel') ?? '人格版' };
      const tabs = [['original', originalTabRef], ['persona', personaTabRef]];
      return h(shippedComparisonModal(), { open: true, onClose, title, headless: true, className: 'persona-shell-comparison' },
        h('style', null, COMPARISON_CSS),
        h('div', { ref: surfaceRef, className: 'persona-shell-comparison-surface', 'data-narrow': narrow },
          h('div', { className: 'persona-shell-comparison-header' },
            h('h2', null, title),
            h('button', { type: 'button', 'data-modal-autofocus': '', onClick: onClose,
              'aria-label': t?.('shell.compareClose') ?? '关闭原文对照' }, t?.('shell.compareCloseShort') ?? '关闭'),
          ),
          h('div', { className: 'persona-shell-comparison-tabs', role: 'tablist', 'aria-label': title, hidden: !narrow,
            onKeyDown: (event) => {
              if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey
                || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const side = event.key === 'Home' ? 'original' : event.key === 'End' ? 'persona' : active === 'original' ? 'persona' : 'original';
              setActive(side);
              (side === 'original' ? originalTabRef : personaTabRef).current.focus({ preventScroll: true });
            },
          }, tabs.map(([side, ref]) => h('button', { key: side, ref, type: 'button', role: 'tab',
            id: `${id}-${side}-tab`, 'aria-controls': `${id}-${side}`, 'aria-selected': active === side,
            tabIndex: active === side ? 0 : -1, onClick: () => setActive(side), onFocus: () => setActive(side),
          }, labels[side]))),
          h('div', { className: 'persona-shell-comparison-panes',
            style: { gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))' } },
            [['original', original, originalRef], ['persona', persona, personaRef]].map(([side, text, ref]) => h('section', {
              key: side, className: 'persona-shell-comparison-pane', id: `${id}-${side}`,
              role: narrow ? 'tabpanel' : 'region', hidden: narrow && active !== side,
              'aria-labelledby': `${id}-${side}-${narrow ? 'tab' : 'label'}`,
            },
            h('h3', { id: `${id}-${side}-label`, hidden: narrow }, labels[side]),
            h('div', { ref, className: 'persona-shell-comparison-scroll', 'data-comparison-side': side,
              tabIndex: 0, role: 'region', 'aria-label': labels[side],
              onScroll: (event) => { if (!narrow || active === side) positions.current[side] = event.currentTarget.scrollTop; },
            }, renderMarkdown(text)),
            )),
          ),
        ),
      );
    }

    // Cache integrity only, not a security hash. Keep in sync with lib/review.js.
    function reviewFingerprint(text) {
      let a = 0x811c9dc5;
      let b = 0x9e3779b9;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
      }
      return `v1:${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
    }

    const REVIEW_REASONS = ['negation-change', 'condition-change', 'uncertainty-change', 'quantity-change', 'literal-order'];

    function reviewNeeded(row, original, settings) {
      const review = row?.review;
      if (settings?.reviewHints === false || row?.status !== 'ready'
        || typeof row.text !== 'string' || typeof original !== 'string'
        || review?.version !== 1 || review.scope !== 'message' || review.method !== 'local-lexical-v1'
        || !Number.isFinite(review.editScore) || review.editScore < 0 || review.editScore > 1
        || !Array.isArray(review.reasons) || review.reasons.some((reason) => !REVIEW_REASONS.includes(reason))) return false;
      const threshold = Number.isFinite(settings?.reviewThreshold)
        && settings.reviewThreshold >= 0 && settings.reviewThreshold <= 1 ? settings.reviewThreshold : 0.55;
      // The threshold is the gate. Reasons can explain a high-scoring change but
      // must not make a below-threshold row show the hint on their own.
      if (!(review.editScore > 0 && review.editScore >= threshold)) return false;
      return review.sourceHash === reviewFingerprint(original) && review.targetHash === reviewFingerprint(row.text);
    }

    let nextReviewId = 0;
    let reviewPortal;
    try { reviewPortal = require('react-dom').createPortal; } catch { /* Old/minimal hosts keep the fixed-position fallback. */ }
    const reviewPanelStyle = {
      position: 'fixed',
      left: 0,
      top: 0,
      zIndex: 100,
      boxSizing: 'border-box',
      width: 'min(560px, calc(100vw - 24px))',
      maxHeight: 'min(420px, 55vh)',
      overflow: 'auto',
      overscrollBehavior: 'contain',
      padding: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 4px 18px #0002',
      fontSize: '13px',
      lineHeight: '1.6',
      overflowWrap: 'anywhere',
    };

    /** Prefer above when it fits; never hang a long preview underneath the composer. */
    function reviewPlacement(anchor, height, bounds) {
      const gap = 6;
      const width = Math.max(0, Math.min(560, bounds.right - bounds.left));
      const cap = Math.max(0, Math.min(420, (bounds.bottom - bounds.top) * 0.55));
      const above = Math.max(0, anchor.top - gap - bounds.top);
      const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
      const onTop = above >= Math.min(height, cap) || above >= below;
      const maxHeight = Math.min(cap, onTop ? above : below);
      return {
        left: Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)),
        top: onTop ? Math.max(bounds.top, anchor.top - gap - Math.min(height, maxHeight)) : anchor.bottom + gap,
        width,
        maxHeight,
      };
    }

    /** Hover/focus is a non-interactive preview; click pins an accessible dialog. */
    function ReviewHint({ original, review, t, renderOriginal }) {
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      const [pinned, setPinned] = React.useState(false);
      const [dismissed, setDismissed] = React.useState(false);
      const [position, setPosition] = React.useState(null);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const leaveTimer = React.useRef(undefined);
      const idRef = React.useRef(null);
      if (idRef.current == null) idRef.current = `persona-shell-review-${++nextReviewId}`;
      const id = idRef.current;
      const open = pinned || (!dismissed && (hovered || focused));
      const label = t?.('shell.reviewHint') ?? '改写变化提示，查看原文';
      const closeLabel = t?.('shell.reviewClose') ?? '关闭原文预览';
      const contains = (target) => rootRef.current?.contains(target) || panelRef.current?.contains(target);
      const cancelLeave = () => {
        if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current);
        leaveTimer.current = undefined;
      };
      const enter = () => { cancelLeave(); setHovered(true); setDismissed(false); };
      const leave = () => {
        cancelLeave();
        leaveTimer.current = setTimeout(() => { leaveTimer.current = undefined; setHovered(false); }, 150);
      };
      const dismiss = (restoreFocus) => {
        cancelLeave();
        setPinned(false);
        setDismissed(true);
        if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
      };

      React.useEffect(() => () => cancelLeave(), []);
      useLayoutEffect(() => {
        if (!open) { setPosition(null); return undefined; }
        const trigger = triggerRef.current;
        const panel = panelRef.current;
        const doc = trigger?.ownerDocument;
        const win = doc?.defaultView;
        if (!trigger || !panel || !win) return undefined;
        const scrollParents = new Set();
        const place = () => {
          const viewport = win.visualViewport;
          const width = viewport?.width ?? doc.documentElement?.clientWidth ?? win.innerWidth;
          const height = viewport?.height ?? doc.documentElement?.clientHeight ?? win.innerHeight;
          if (!(width > 0 && height > 0)) return;
          const left = viewport?.offsetLeft ?? 0;
          const top = viewport?.offsetTop ?? 0;
          const bounds = { left: left + 12, right: left + width - 12, top: top + 12, bottom: top + height - 12 };
          const clearance = Number.parseFloat(win.getComputedStyle?.(doc.documentElement).getPropertyValue('--dsh-frame-top-clearance'));
          if (Number.isFinite(clearance)) bounds.top = Math.max(bounds.top, (doc.documentElement.hasAttribute('data-fullscreen') ? 0 : clearance) + 20);
          // The chat scroller ends above the composer. Respect its vertical
          // reading area, but portal out of its clipping/transform context.
          for (let parent = trigger.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
            const overflow = win.getComputedStyle?.(parent).overflowY;
            if (!/^(auto|scroll)$/.test(overflow)) continue;
            scrollParents.add(parent);
            const rect = parent.getBoundingClientRect();
            bounds.top = Math.max(bounds.top, rect.top + 12);
            bounds.bottom = Math.min(bounds.bottom, rect.bottom - 12);
          }
          const anchor = trigger.getBoundingClientRect();
          if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom || anchor.right <= bounds.left || anchor.left >= bounds.right) {
            setHovered(false); setFocused(false); dismiss(false);
            return;
          }
          const next = reviewPlacement(anchor, panel.getBoundingClientRect().height, bounds);
          setPosition((current) => current && Object.keys(next).every((key) => current[key] === next[key]) ? current : next);
        };
        place();
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(place) : undefined;
        observer?.observe(trigger); observer?.observe(panel);
        for (const parent of scrollParents) observer?.observe(parent);
        win.addEventListener('scroll', place, true);
        win.addEventListener('resize', place);
        win.visualViewport?.addEventListener('resize', place);
        win.visualViewport?.addEventListener('scroll', place);
        return () => {
          observer?.disconnect();
          win.removeEventListener('scroll', place, true);
          win.removeEventListener('resize', place);
          win.visualViewport?.removeEventListener('resize', place);
          win.visualViewport?.removeEventListener('scroll', place);
        };
      }, [open, pinned]);
      React.useEffect(() => {
        const doc = rootRef.current?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
        if (!open || doc === undefined) return undefined;
        const onPointer = (event) => {
          if (!contains(event.target)) {
            setHovered(false);
            setFocused(false);
            dismiss(false);
          }
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          dismiss(pinned);
        };
        doc.addEventListener('pointerdown', onPointer, true);
        doc.addEventListener('keydown', onKey, true);
        return () => {
          doc.removeEventListener('pointerdown', onPointer, true);
          doc.removeEventListener('keydown', onKey, true);
        };
      }, [open, pinned]);
      React.useEffect(() => {
        if (pinned) panelRef.current?.focus({ preventScroll: true });
      }, [pinned]);

      const panel = open ? h('div', {
        id,
        ref: panelRef,
        'data-persona-shell': 'review-panel',
        role: pinned ? 'dialog' : 'tooltip',
        'aria-label': pinned ? label : undefined,
        tabIndex: pinned ? -1 : undefined,
        style: { ...reviewPanelStyle, ...position, visibility: position === null ? 'hidden' : undefined },
        onMouseEnter: enter,
        onMouseLeave: leave,
      },
      h('div', { style: { ...headerStyle, justifyContent: 'space-between' } },
        h('span', null, t?.('shell.originalLabel') ?? '原文'),
        pinned ? h('button', {
          type: 'button', style: toggleStyle, 'aria-label': closeLabel,
          onClick: () => dismiss(true),
        }, t?.('shell.reviewCloseShort') ?? '关闭') : null),
      h('div', { style: { ...paneLabelStyle, textTransform: 'none', letterSpacing: 'normal' } },
        t?.('shell.reviewNotice') ?? '本地措辞变化提示，不代表事实错误；低分也不保证语义一致。',
        ` (${Math.round(review.editScore * 100)}/100)`,
        review.reasons.length > 0
          ? h('div', null, review.reasons.map((reason) => t?.(`shell.reviewReasons.${reason}`) ?? ({
            'negation-change': '否定表达变化', 'condition-change': '条件表达变化',
            'uncertainty-change': '不确定性表达变化', 'quantity-change': '数字表达变化',
            'literal-order': '字面量顺序变化',
          })[reason]).join(' · '))
          : null),
      renderOriginal?.() ?? renderMarkdown(original),
      ) : null;
      const doc = rootRef.current?.ownerDocument;
      return h('div', {
        ref: rootRef,
        'data-persona-shell': 'review-hint',
        style: { display: 'inline-flex', width: 'fit-content', verticalAlign: 'middle', marginTop: '4px' },
        onMouseEnter: enter,
        onMouseLeave: leave,
        onFocus: (event) => {
          setFocused(true);
          if (!contains(event.relatedTarget)) setDismissed(false);
        },
        onBlur: (event) => {
          if (!contains(event.relatedTarget)) setFocused(false);
        },
      },
      h('button', {
        ref: triggerRef,
        type: 'button',
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-describedby': open && !pinned ? id : undefined,
        style: {
          ...toggleStyle, color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary))', fontSize: '15px', fontWeight: 600,
          minWidth: '28px', minHeight: '28px', borderRadius: '4px',
        },
        onClick: () => {
          if (pinned) dismiss(false);
          else { setPinned(true); setDismissed(false); }
        },
      }, h('span', { 'aria-hidden': true }, '※')),
      panel && typeof reviewPortal === 'function' && doc?.body ? reviewPortal(panel, doc.body) : panel);
    }

    /** Text of one assistant step, in the order the blocks carry it. */
    function textOf(data) {
      const blocks = data?.blocks ?? [];
      return blocks
        .filter((block) => block !== undefined && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /**
     * How long a placeholder may stand in for a rewrite that is genuinely coming.
     *
     * Deliberately short. It exists to cover the second between a step settling
     * and its rewrite arriving; anything longer turns "opening an old session"
     * into a page of blank boxes, because history rows reach this branch too.
     */
    const HOLD_PLACEHOLDER_MS = 2500;

    /**
     * How long an eligible row may stay in the state-loading placeholder
     * before falling back to the official report. The host's state route is
     * local and normally answers in a frame or two; this bound only protects
     * a failed or stalled request from leaving a permanent blank.
     */
    const STATE_LOADING_MS = 500;

    /**
     * Which body one settled row should render.
     *
     * Split out as a pure function because the interesting cases are timing
     * cases, and timing is exactly what a mocked React cannot reproduce.
     * @param {{ status?: string, text?: string } | undefined} row - the host's record for this step.
     * @param {boolean} conceded - whether the hold window for a pending rewrite has expired.
     * @param {boolean} [fresh] - this step arrived while the page was live, so a
     *   rewrite is plausibly on its way. History rows opened from a restart pass
     *   `false`: nothing is coming for them and a placeholder would be a lie.
     * @returns {'persona' | 'plain' | 'placeholder' | 'streaming'}
     */
    function rowBranch(row, conceded, fresh = false) {
      if (row !== undefined && row.status === 'ready' && typeof row.text === 'string' && row.text !== '') {
        return 'persona';
      }
      // Streaming text arrived before the row settled: show it growing rather
      // than a placeholder that says nothing.
      if (row !== undefined && typeof row.partial === 'string' && row.partial !== '') {
        return 'streaming';
      }
      // A rewrite that already failed will never arrive, so the report is the
      // honest answer immediately.
      if (row !== undefined && row.status !== 'pending') return 'plain';
      // A pending row is the only case where text is genuinely on its way.
      // The host keeps a rewrite pending until its own timeout; conceding here
      // would show the original report while the rewrite is still running.
      if (row !== undefined) return 'placeholder';
      // No row at all: the state has not caught up with this step yet. Showing
      // the report here is what produced the flash — the row is new, its rewrite
      // is being computed, and the plain text appeared first and was replaced a
      // moment later. A placeholder is the honest body for that gap, but only for
      // a step that just arrived; a restored history row would otherwise sit on a
      // blank box until its fetch landed.
      return fresh && !conceded ? 'placeholder' : 'plain';
    }

    /**
     * Put the shielded literals back into a partial rewrite.
     *
     * The streaming text is still masked, so `[[0]]` style markers stand in for
     * code, paths and commands. Those markers are only meaningful to the host
     * that issued them, so the row carries the table alongside.
     * @param {string} text
     * @param {readonly string[] | undefined} literals
     * @returns {string}
     */
    function unmaskPartial(text, literals) {
      if (!Array.isArray(literals) || literals.length === 0) return text;
      return text.replace(/\[\[\s*(\d+)\s*\]\]/g, (whole, digits) => {
        const index = Number(digits);
        return literals[index] ?? whole;
      });
    }

    /** Keep the official component mounted; change only one settled text block. */
    function PersonaStep({ delegate, ...props }) {
      const { node, sessionId, groupPart } = props;
      const data = node?.data;
      const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
      const seq = data?.finalNode?.seq;
      const original = textOf(data);
      const t = shellTranslate(props.t);
      const eligible = data?.status === 'settled' && groupPart !== 'reasoning'
        && (groupPart === undefined || groupPart === 'response') && typeof seq === 'number'
        && usableSessionId(sessionId) && original !== ''
        && blocks.filter((block) => block?.kind === 'text').length === 1;
      const key = rowKey(sessionId, seq);
      const liveKey = rowKey(sessionId, node?.key);
      if (typeof node?.key === 'string' && data?.status === 'running') liveSeen.add(liveKey);
      const { state } = useHostState(sessionId, eligible ? seq : undefined);
      const [comparison, setComparison] = React.useState(undefined);
      const [expiredKey, setExpiredKey] = React.useState(undefined);
      const [stateExpiredKey, setStateExpiredKey] = React.useState(undefined);
      const row = eligible ? state?.rows?.find((candidate) => candidate.seq === seq) : undefined;
      const switchesReady = state?.switchesReady !== false;
      const switchLoading = eligible && globalEnabled && state !== undefined && !switchesReady;
      const allowed = eligible && globalEnabled && !switchLoading && state?.sessionEnabled !== false
        && state?.settings?.enabled !== false && sessionOff.get(sessionId) !== false;
      React.useEffect(() => {
        if (!allowed) return undefined;
        const timer = setTimeout(() => setExpiredKey(key), HOLD_PLACEHOLDER_MS);
        return () => clearTimeout(timer);
      }, [allowed, key]);
      React.useEffect(() => {
        if (!allowed || state !== undefined) return undefined;
        const timer = setTimeout(() => setStateExpiredKey(key), STATE_LOADING_MS);
        return () => clearTimeout(timer);
      }, [allowed, key, state]);
      React.useEffect(() => { setComparison(undefined); }, [key, allowed, row?.status, row?.final]);

      if (allowed && !freshDecided.has(key) && state !== undefined) {
        freshDecided.set(key, liveSeen.has(liveKey));
      }
      const stateLoading = allowed && state === undefined && stateExpiredKey !== key;
      const branch = !allowed
        ? (switchLoading ? 'placeholder' : 'plain')
        : stateLoading ? 'placeholder'
          : rowBranch(row, expiredKey === key, freshDecided.get(key) === true);
      if (allowed && branchHistory.get(key) !== branch) {
        branchHistory.set(key, branch);
        const trace = diagnosticsTrail.get(key) ?? [];
        trace.push({ branch, at: Date.now() });
        diagnosticsTrail.set(key, trace.slice(-4));
        if (trace.length <= 4) reportDiagnostics({ branchTrail: { [key]: trace } });
      }
      const text = branch === 'persona' ? row.text
        : branch === 'streaming' ? unmaskPartial(row.partial, row.partialLiterals)
          : branch === 'placeholder' ? placeholderText(t) : undefined;
      const report = renderOfficial(delegate, props, displayNode(node, text));
      const ready = branch === 'persona';
      const showHeader = ready && row.final === true;
      // Original previews contain text only; images/reasoning remain in the
      // continuously mounted main renderer, not duplicated in a comparison.
      const renderOriginal = () => renderOfficial(delegate, { ...props, groupPart: 'response' }, {
        ...node, data: { ...data, blocks: blocks.filter((block) => block?.kind === 'text') },
      });
      const comparisonOpen = comparison?.key === key;
      // No layout wrapper or reparenting, even while the portaled modal is open.
      return h(React.Fragment, null,
        // The persona badge and original toggle belong above the report, where
        // the reader meets the row; the ※ review hint stays at the end, where
        // it does not compete with the reading flow.
        showHeader ? h('div', { style: headerStyle, 'data-persona-shell': 'controls' },
          h('span', { style: badgeStyle }, 'persona'),
          h('button', {
            type: 'button', style: toggleStyle, 'aria-expanded': comparisonOpen, 'aria-haspopup': 'dialog',
            onClick: () => setComparison({ key, original: blocks.find((block) => block?.kind === 'text').text, persona: row.text }),
          }, t('shell.showOriginal') ?? 'origin'),
        ) : null,
        report,
        ready && !comparisonOpen && reviewNeeded(row, original, state?.settings)
          ? h(ReviewHint, { key: `${key}:${row.review.sourceHash}:${row.review.targetHash}`, original, review: row.review, t, renderOriginal })
          : null,
        showHeader && comparisonOpen ? h(ComparisonDialog, { original: comparison.original,
          persona: comparison.persona, t, onClose: () => setComparison(undefined) }) : null,
      );
    }

    /** The three dots the placeholder shows while the rewrite is in flight. */
    function placeholderText(t) {
      const label = typeof t === 'function' ? t('shell.rewriting') : undefined;
      return typeof label === 'string' && label !== '' ? label : '…';
    }

    // --- settings page -------------------------------------------------------

    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 14px' };
    /** A checkbox and its label on one line. */
    const toggleRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' };
    /** A degradation notice that must not read as ordinary helper text. */
    const warningStyle = {
      margin: '10px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '1.5',
    };
    const labelStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };
    /** Box listing what long-term memory currently claims. */
    const memoryBoxStyle = {
      margin: '8px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontSize: '12px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const memoryLineStyle = { color: 'var(--dsw-alias-label-primary)' };
    /** Preset list rows: one line each, actions pushed to the right. */
    const presetListStyle = {
      margin: '8px 0 0',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
      overflow: 'hidden',
    };
    const presetRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '7px 10px',
      fontSize: '12px',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
    };
    const presetNameStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetTagStyle = {
      fontSize: '10px',
      padding: '0 5px',
      borderRadius: '4px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const presetPreviewStyle = {
      margin: '8px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontSize: '12px',
      lineHeight: '1.6',
    };
    const primaryButtonStyle = {
      padding: '5px 12px',
      borderRadius: '6px',
      border: 'none',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#ffffff',
      cursor: 'pointer',
      fontSize: '12px',
      fontFamily: 'inherit',
    };
    const inputStyle = {
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
    };
    const hintStyle = { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.5' };
    const sectionTitleStyle = { margin: '0 0 12px', fontSize: '15px', fontWeight: '600' };

    async function postSettings(patch) {
      try {
        const response = await fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return undefined;
        const value = await response.json();
        if (typeof value?.settings?.progressNotices === 'boolean') setProgressEnabled(value.settings.progressNotices);
        return value;
      } catch {
        return undefined;
      }
    }

    /**
     * Send one preset operation.
     *
     * Generation is a model call, so it can take many seconds or fail outright;
     * a failure is returned as data rather than thrown, so the page can say why
     * instead of appearing to hang.
     */
    async function postPreset(body) {
      try {
        const response = await fetch(`${ROUTE}/presets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          return { ok: false, reason: detail?.error ?? `http-${response.status}` };
        }
        return await response.json();
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'network' };
      }
    }

    /**
     * Settings page: the persona pack, the rewrite route, and the on/off switch.
     * Written through the plugin's own host route so no codegen is involved.
     */
    function SettingsSection() {
      const [settings, setSettings] = React.useState(undefined);
      const [rendererState, setRendererState] = React.useState(chatRendererState);
      React.useEffect(() => {
        const listener = () => setRendererState(chatRendererState);
        rendererListeners.add(listener);
        listener();
        return () => rendererListeners.delete(listener);
      }, []);
      const [providers, setProviders] = React.useState([]);
      const [models, setModels] = React.useState([]);
      const [status, setStatus] = React.useState('');
      const [reviewThresholdDraft, setReviewThresholdDraft] = React.useState(undefined);
      const [progressMinutesDraft, setProgressMinutesDraft] = React.useState(undefined);
      /** What long-term memory currently claims, so it can be inspected. */
      const [memoryLines, setMemoryLines] = React.useState([]);
      const [memoryStats, setMemoryStats] = React.useState(undefined);

      /** Named persona presets, plus the free-form prompt used to generate one. */
      const [presets, setPresets] = React.useState([]);
      const [activePresetId, setActivePresetId] = React.useState('');
      const [activePresetName, setActivePresetName] = React.useState('');
      const [personaPrompt, setPersonaPrompt] = React.useState('');
      const [generating, setGenerating] = React.useState(false);
      const [generated, setGenerated] = React.useState(undefined);
      const [presetStatus, setPresetStatus] = React.useState('');
      /** Name the user chose for a freshly generated preset. */
      const [generatedName, setGeneratedName] = React.useState('');
      /** Preset id being renamed, if the inline editor is open. */
      const [renaming, setRenaming] = React.useState(undefined);
      const [renameValue, setRenameValue] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/models`);
            if (!response.ok) return;
            const value = await response.json();
            if (!cancelled) setProviders(value.providers ?? []);
          } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
      }, []);

      // Presets load once, and again whenever a preset operation returns a new
      // list: the host is the source of truth, the page only mirrors it.
      /**
       * Mirror the host's preset state.
       *
       * Takes the whole payload, not just the array. The active name and id move
       * whenever a preset is applied, renamed, deleted or saved, and updating the
       * list without them left the page showing the previous selection — so
       * 「启用」 looked like it did nothing until a reload.
       * @param {{ presets?: unknown, active?: unknown }} [payload]
       */
      const refreshPresets = async (payload) => {
        let value = payload;
        if (value === undefined) {
          try {
            const response = await fetch(`${ROUTE}/presets`);
            if (!response.ok) return;
            value = await response.json();
          } catch {
            return;
          }
        }
        const list = Array.isArray(value?.presets) ? value.presets : [];
        setPresets(list);
        const activeName = typeof value?.active === 'string' ? value.active : '';
        setActivePresetName(activeName);
        const match = list.find((preset) => preset.name === activeName);
        setActivePresetId(match !== undefined ? match.id : '');
      };

      React.useEffect(() => { void refreshPresets(); }, []);

      const presetAction = async (body) => {
        const result = await postPreset(body);
        if (result?.ok === true) {
          // The whole reply: it carries both the list and which preset is now
          // active, and the selection must move with it or the button looks dead.
          await refreshPresets({ presets: result.presets, active: result.active });
          if (result.settings !== undefined) setSettings(result.settings);
          setPresetStatus('');
        } else {
          setPresetStatus(`失败：${result?.reason ?? '未知原因'}`);
        }
        return result;
      };

      const generatePreset = async () => {
        setGenerating(true);
        setPresetStatus('正在读取人设…');
        setGenerated(undefined);
        setGeneratedName('');
        const result = await postPreset({ action: 'generate', prompt: personaPrompt });
        setGenerating(false);
        if (result?.ok === true) {
          setGenerated(result.preset);
          // Seeded from the generated suggestion, but editable: it is a starting
          // point, not the user's decision.
          setGeneratedName(result.preset?.name ?? '');
          setPresetStatus('已生成，确认后保存');
        } else {
          setPresetStatus(`生成失败：${result?.reason ?? '未知原因'}`);
        }
      };

      const startRename = (preset) => {
        setRenaming(preset.id);
        setRenameValue(preset.name);
      };

      const commitRename = async () => {
        const name = renameValue.trim();
        if (renaming === undefined || name === '') return;
        const result = await presetAction({ action: 'rename', id: renaming, name });
        if (result?.ok === true) {
          setRenaming(undefined);
          setRenameValue('');
        }
      };

      React.useEffect(() => {
        if (settings?.provider === undefined || settings.provider === '') { setModels([]); return; }
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/models?provider=${encodeURIComponent(settings.provider)}`);
            if (!response.ok) return;
            const value = await response.json();
            if (!cancelled) setModels(value.models ?? []);
          } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
      }, [settings?.provider]);

      const pack = settings?.pack;

      const save = async (patch) => {
        const result = await postSettings(patch);
        if (result?.settings !== undefined) {
          setSettings(result.settings);
          // Saving can change the learned profile (a clear resets it), so the
          // memory panel refreshes from the same response rather than going stale.
          if (Array.isArray(result.memory)) setMemoryLines(result.memory);
          if (result.memoryStats !== undefined) setMemoryStats(result.memoryStats);
          // Editing the card writes back into a preset — or forks one from the
          // builtin — so the list and the selection both move with it.
          if (Array.isArray(result.presets)) {
            await refreshPresets({ presets: result.presets, active: result.settings.presetName });
          }
          setStatus('已保存');
          setTimeout(() => setStatus(''), 1500);
        } else {
          setStatus('保存失败');
        }
      };

      if (settings === undefined) {
        return h('div', null,
          h('h2', { style: sectionTitleStyle }, '人格套壳'),
          h('div', { style: hintStyle }, '正在读取设置…'),
          h(LoadSettings, {
            onLoaded: (value) => {
              setSettings(value.settings);
              setMemoryLines(Array.isArray(value.memory) ? value.memory : []);
              setMemoryStats(value.memoryStats);
            },
          }),
        );
      }

      return h('div', null,
        h('h2', { style: sectionTitleStyle }, '人格套壳'),
        h('div', { style: hintStyle },
          '在系统提示词之外，为每条助手汇报套一层人格化转述。原汇报始终可查，套壳失败时自动保留原文。',
        ),
        // The transcript already shows the degradation; this explains it where
        // the reader can act on it. Silence here would send them hunting.
        shippedRendererOk
          ? null
          : h('div', { style: warningStyle },
            '独立预览的备用 Markdown 组件不可用，备用预览显示为纯文本；主消息仍由官方组件渲染。',
          ),
        rendererState.status === 'incompatible' || rendererState.status === 'error'
          ? h('div', { style: warningStyle, role: 'status' },
            '未能安全接入官方助手渲染器，已暂停人格显示并保留官方原文。',
            ` (${rendererState.reason})`,
          ) : null,
        h('div', { style: { height: '14px' } }),

        h('div', { style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.includeToolSteps !== false,
              onChange: (event) => save({ includeToolSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '同时改写阶段性输出'),
          ),
          h('span', { style: hintStyle },
            '开启后，带工具调用的中间步骤（"现在改常量…"这类叙述）也会套壳；'
            + '关掉则只改写每轮最终的汇报，中间步骤保持原样。',
          ),
        ),

        h('div', { style: { height: '6px' } }),

        h('div', { style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', { type: 'checkbox', checked: settings.progressNotices === true,
              onChange: (event) => save({ progressNotices: event.target.checked }) }),
            h('span', { style: labelStyle }, '静默状态播报（默认关闭）'),
          ),
          h('span', { style: hintStyle },
            '当前正在查看的主会话长时间没有正文时，根据可观察的活动额外调用一次模型，生成一两句人格播报。'
            + '固定前缀 ◈；不写入主会话，无新事实不重复调用，每轮最多 3 次。不能据此判断任务完成或是否卡住。'),
          h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
            h('span', { style: labelStyle }, '静默多久后播报（分钟）'),
            h('input', { type: 'number', min: 1, max: 60, step: 1, style: { ...inputStyle, width: '76px' },
              disabled: settings.progressNotices !== true,
              value: progressMinutesDraft ?? settings.progressMinutes ?? 5,
              onChange: (event) => setProgressMinutesDraft(event.target.value),
              onBlur: async (event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 60 && value !== settings.progressMinutes) {
                  await save({ progressMinutes: value });
                }
                setProgressMinutesDraft(undefined);
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
            }),
          ),
        ),

        h('div', { style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings.reviewHints !== false,
              onChange: (event) => save({ reviewHints: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写变化提示'),
          ),
          h('span', { style: hintStyle },
            '措辞变化分数达到阈值时，在该条汇报末尾显示 ※；否定、条件、不确定性、数字、字面量顺序等只作为提示面板里的解释。'
            + '悬停或键盘聚焦预览原文，点击固定。本地启发式检查，不增加模型调用，也不保证语义一致。'),
          h('details', { style: { marginTop: '6px' } },
            h('summary', { style: { ...hintStyle, cursor: 'pointer' } }, '高级：提示阈值'),
            h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
              h('span', { style: labelStyle }, `措辞变化阈值：${Math.round((reviewThresholdDraft ?? settings.reviewThreshold ?? 0.55) * 100)}/100`),
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.05,
                'aria-label': '措辞变化提示阈值',
                value: reviewThresholdDraft ?? settings.reviewThreshold ?? 0.55,
                disabled: settings.reviewHints === false,
                onChange: (event) => setReviewThresholdDraft(Number(event.target.value)),
                // Commit once on blur, not one network request per slider tick.
                onBlur: async (event) => {
                  const value = Number(event.target.value);
                  if (value !== settings.reviewThreshold) await save({ reviewThreshold: value });
                  setReviewThresholdDraft(undefined);
                },
                onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
              })),
            h('span', { style: hintStyle },
              '默认 55；越低越容易提示，移开焦点后保存。低于阈值不显示；关键表达变化只作解释，不绕过阈值。'
              + '修改只影响已有评估的显示，不重新改写；旧记录不补算。'),
          ),
        ),

        h('div', { style: { height: '6px' } }),

        // --- subagent conversations -------------------------------------------
        // Two switches, not one: a helper's progress chatter and its conclusion
        // are read by different people at different times.
        h('div', { style: fieldStyle },
          h('span', { style: { ...labelStyle, marginBottom: '2px' } }, '子代理会话'),
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.subagentSteps === true,
              onChange: (event) => save({ subagentSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写子代理的过程输出'),
          ),
          h('span', { style: hintStyle }, '子代理的中间步骤基本没人看，默认不改写。'),
          h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
            h('input', {
              type: 'checkbox',
              checked: settings?.subagentReports === true,
              onChange: (event) => save({ subagentReports: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写子代理的结论输出'),
          ),
          h('span', { style: hintStyle }, '子代理的最终答复；如果会转述给你，可以打开。'),
        ),

        h('div', { style: { height: '6px' } }),

        // --- long-term memory ------------------------------------------------
        h('div', { style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.memory !== false,
              onChange: (event) => save({ memory: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '记住我的习惯'),
          ),
          h('span', { style: hintStyle },
            '跨会话统计你的提问语言、称呼方式和句子长短，用来微调套壳语气。'
            + '只保存计数，不保存你说过的话。',
          ),
          memoryLines && memoryLines.length > 0
            ? h('div', { style: memoryBoxStyle },
              h('div', { style: { ...labelStyle, marginBottom: '4px' } }, '目前学到的'),
              ...memoryLines.map((line, index) => h('div', { key: index, style: memoryLineStyle }, `· ${line}`)),
              memoryStats !== undefined
                ? h('div', { style: { ...hintStyle, marginTop: '6px' } },
                  `基于 ${memoryStats.messages} 条消息`
                  + (memoryStats.meanSentence > 0 ? `，平均每句 ${memoryStats.meanSentence} 字` : ''),
                )
                : null,
            )
            : h('div', { style: hintStyle }, '还没有足够的样本，继续聊天就会开始学习。'),
          h('div', { style: { marginTop: '6px' } },
            h('button', {
              type: 'button',
              style: toggleStyle,
              onClick: () => save({ clearMemory: true }),
            }, '清空记忆'),
          ),
        ),

        h('div', { style: { height: '6px' } }),

        // --- persona presets --------------------------------------------------
        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '人设预设'),
          h('span', { style: hintStyle }, '当前：' + (activePresetName ?? '大肥鱼（默认）')),
          // Say where edits go before they are made: an edit to the builtin
          // forks a new preset, and that is surprising if it is not announced.
          h('span', { style: hintStyle },
            '下面编辑的人格卡会保存到当前预设；编辑内置预设时会自动另存为一个新预设。',
          ),

          presets && presets.length > 0
            ? h('div', { style: presetListStyle },
              ...presets.map((preset) => h('div', {
                key: preset.id,
                style: presetRowStyle,
              },
              h('span', {
                style: {
                  ...presetNameStyle,
                  fontWeight: preset.id === activePresetId ? '600' : '400',
                },
              }, preset.name),
              preset.builtin === true
                ? h('span', { style: presetTagStyle }, '内置')
                : null,
              h('div', { style: { display: 'flex', gap: '10px', marginLeft: 'auto' } },
                preset.id === activePresetId
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    onClick: () => presetAction({ action: 'apply', id: preset.id }),
                  }, '启用'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    onClick: () => startRename(preset),
                  }, '改名'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: { ...toggleStyle, color: 'var(--dsw-alias-label-tertiary)' },
                    onClick: () => presetAction({ action: 'delete', id: preset.id }),
                  }, '删除'),
              ))),
            )
            : null,

          // Inline rename: a dialog would be heavier than the operation, and the
          // page already has the preset in hand.
          renaming !== undefined
            ? h('div', { style: { ...presetPreviewStyle, display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                style: { ...inputStyle, flex: 1 },
                value: renameValue,
                onChange: (event) => setRenameValue(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitRename(); },
              }),
              h('button', { type: 'button', style: primaryButtonStyle, onClick: commitRename }, '保存'),
              h('button', {
                type: 'button',
                style: toggleStyle,
                onClick: () => { setRenaming(undefined); setRenameValue(''); },
              }, '取消'),
            )
            : null,
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '从人设提示词生成预设'),
          h('span', { style: hintStyle },
            '把你写的人设提示词整段粘进来，会提取出「说话风格」，丢掉外貌和背景故事——'
            + '因为这里只需要知道怎么把汇报换种口气讲。生成后可以先预览再保存。',
          ),
          h('textarea', {
            style: { ...inputStyle, minHeight: '88px', resize: 'vertical' },
            placeholder: '粘贴人设提示词…',
            value: personaPrompt,
            onChange: (event) => setPersonaPrompt(event.target.value),
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' } },
            h('button', {
              type: 'button',
              style: primaryButtonStyle,
              disabled: generating || personaPrompt.trim().length < 20,
              onClick: () => generatePreset(),
            }, generating ? '生成中…' : '生成预设'),
            presetStatus !== '' ? h('span', { style: hintStyle }, presetStatus) : null,
          ),
          generated !== undefined
            ? h('div', { style: presetPreviewStyle },
              h('div', { style: { ...labelStyle, marginBottom: '4px' } }, '预览'),
              // The generated name is a suggestion, not a decision: the user
              // names their own presets.
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                h('span', { style: labelStyle }, '名称'),
                h('input', {
                  style: { ...inputStyle, flex: 1 },
                  value: generatedName,
                  placeholder: '给这个预设起个名字',
                  onChange: (event) => setGeneratedName(event.target.value),
                }),
              ),
              h('div', { style: { ...memoryLineStyle, marginTop: '4px' } }, `身份：${generated.identity ?? ''}`),
              (generated.report ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  `汇报规则：${generated.report.join(' ／ ')}`)
                : null,
              (generated.samples ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  `示例：${generated.samples.join(' ／ ')}`)
                : null,
              h('div', { style: { display: 'flex', gap: '10px', marginTop: '8px' } },
                h('button', {
                  type: 'button',
                  style: primaryButtonStyle,
                  disabled: generatedName.trim() === '',
                  onClick: () => {
                    presetAction({
                      action: 'save',
                      name: generatedName.trim(),
                      pack: generated,
                      source: personaPrompt,
                    });
                    setGenerated(undefined);
                    setGeneratedName('');
                  },
                }, '保存并启用'),
                h('button', {
                  type: 'button',
                  style: toggleStyle,
                  onClick: () => { setGenerated(undefined); setPresetStatus(''); },
                }, '丢弃'),
              ),
            )
            : null,
        ),

        h('div', { style: { height: '6px' } }),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '身份'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            value: pack?.identity ?? '',
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, identity: event.target.value },
            }),
            onBlur: (event) => save({ pack: { ...pack, identity: event.target.value } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '汇报里的说话规则（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            value: (pack?.report ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, report: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, report: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '通用语感（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            value: (pack?.voice ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, voice: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, voice: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '语气示例（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            value: (pack?.samples ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, samples: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, samples: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '避免出现（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            value: (pack?.avoid ?? []).join('\n'),
            onChange: (event) => setSettings({
              ...settings, pack: { ...pack, avoid: event.target.value.split('\n') },
            }),
            onBlur: (event) => save({ pack: { ...pack, avoid: event.target.value.split('\n').filter((line) => line.trim() !== '') } }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '子代理称呼'),
          h('input', {
            style: inputStyle,
            value: pack?.address?.subagent ?? '',
            onChange: (event) => setSettings({
              ...settings,
              pack: { ...pack, address: { ...(pack?.address ?? {}), subagent: event.target.value } },
            }),
            onBlur: (event) => save({
              pack: { ...pack, address: { ...(pack?.address ?? {}), subagent: event.target.value } },
            }),
          }),
        ),

        h('div', { style: fieldStyle },
          h('span', { style: labelStyle }, '改写所用模型'),
          h('select', {
            style: inputStyle,
            value: settings?.provider ?? '',
            onChange: (event) => save({ provider: event.target.value, model: '' }),
          },
          h('option', { value: '' }, '跟随会话当前模型'),
          providers.map((entry) => h('option', { key: entry.provider, value: entry.provider }, entry.name ?? entry.provider))),
          h('span', { style: hintStyle }, '留空即跟随当前会话；指定后所有会话都用它改写。'),
        ),

        settings?.provider !== undefined && settings.provider !== ''
          ? h('div', { style: fieldStyle },
            h('span', { style: labelStyle }, '模型'),
            h('select', {
              style: inputStyle,
              value: settings.model ?? '',
              onChange: (event) => save({ model: event.target.value }),
            },
            h('option', { value: '' }, '该提供方的默认模型'),
            models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
          )
          : null,

        status === '' ? null : h('div', { style: { ...hintStyle, color: 'var(--dsw-alias-brand-primary)' } }, status),
      );
    }

    /** Loads settings once, from any session the host knows. */
    function LoadSettings({ onLoaded }) {
      React.useEffect(() => {
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/settings`);
            if (!response.ok) return;
            const value = await response.json();
            // The whole payload, not just `settings`: it also carries the learned
            // memory, and the page renders both from one fetch.
            if (value?.settings !== undefined) onLoaded(value);
          } catch { /* ignore */ }
        })();
      }, []);
      return null;
    }

    return {
      inject: ['slots'],
      /**
       * Rendering decisions, exposed for the offline suite.
       *
       * Pure timing/compatibility decisions plus components for the stateful
       * offline harness. renderMarkdown is only an isolated-preview fallback;
       * the main transcript always delegates to the official assistant.
       */
      __testing: {
        rowBranch,
        renderMarkdown,
        resolveChatDelegate,
        displayNode,
        renderOfficial,
        PersonaStep,
        refreshState: refresh,
        watchState: watch,
        getHostState: (sessionId) => states.get(sessionId),
        applyControls,
        getChatRendererState: () => chatRendererState,
        unmaskPartial,
        chatTakeoverEnabled,
        HOLD_PLACEHOLDER_MS,
        STATE_WAIT_MS,
        reviewFingerprint,
        reviewNeeded,
        reviewPlacement,
        ReviewHint,
        ComparisonDialog,
        NativeComparisonModal,
        COMPARISON_NARROW_WIDTH,
        ProgressNotice,
        setProgressEnabled,
        PROGRESS_PREFIX,
      },
      apply(ctx) {
        clientStopped = false;
        // Owned by the plugin lifetime; both are cleared on unload below.
        let heartbeatTimer;
        // Announce this build as soon as the plugin is applied, then keep saying
        // so. The desktop client has no hard reload, so the only way to tell a
        // stale bundle from a broken one is a heartbeat that names the build:
        // without it, "my fix did nothing" and "my fix never loaded" look the
        // same, and that ambiguity cost this plugin several rounds.
        reportDiagnostics({ applied: true, at: Date.now() });
        //
        // Wrapped in try/catch on purpose: diagnostics are a convenience, and a
        // missing timer global must never take the whole plugin down with it.
        try {
          heartbeatTimer = setInterval(() => {
            reportDiagnostics({ heartbeat: Date.now() });
          }, 30000);
          if (typeof heartbeatTimer?.unref === 'function') heartbeatTimer.unref();
        } catch {
          // No timers here; the apply-time report is still enough to prove a load.
        }


        // Keep the official entry (and its child declarations) live. Our entry
        // borrows its inject/locale contract, not its exclusive child ownership.
        let releaseChat = undefined;
        let chatComponent;
        let chatDelegate;
        let rendererFailed = false;
        const rendererSubscriptions = [];
        const releaseChatSlot = () => {
          const release = releaseChat;
          releaseChat = undefined;
          chatDelegate = undefined;
          if (release !== undefined) release();
        };
        refreshChatTakeover = () => {
          if (stopped) return;
          if (!chatTakeoverEnabled(globalEnabled, activeSessionId, sessionOff)) {
            releaseChatSlot();
            rendererFailed = false;
            setChatRendererState('disabled');
            return;
          }
          if (rendererFailed) {
            releaseChatSlot();
            setChatRendererState('error', 'delegate-render-failed');
            return;
          }
          try {
            const delegate = resolveChatDelegate(ctx.slots, chatComponent);
            if (!delegate.ok) {
              releaseChatSlot();
              setChatRendererState('incompatible', delegate.reason);
              return;
            }
            if (chatDelegate?.entry === delegate.entry
              && chatDelegate.children.every((entry, index) => entry === delegate.children[index])) return;
            releaseChatSlot();
            chatComponent = function PersonaDelegate(props) { return h(PersonaStep, { ...props, delegate }); };
            releaseChat = ctx.slots.register({
              name: CHAT_SLOT, key: 'assistant-step', priority: -1,
              locale: delegate.entry.locale, inject: delegate.entry.inject,
            }, chatComponent);
            chatDelegate = delegate;
            setChatRendererState('delegated');
          } catch {
            releaseChatSlot();
            rendererFailed = true;
            setChatRendererState('error', 'delegate-setup-failed');
          }
        };

        // Track the switch. The host is the source of truth.
        //
        // Three rules, each from a real failure:
        //
        // 1. Start NOT taken over. Taking over unconditionally meant that if the
        //    settings request kept failing (403, offline), the plugin stayed
        //    shadowing the shipped renderer forever without ever confirming the
        //    server wanted it. The shipped renderer is the safe default.
        // 2. Only an explicit boolean counts. `enabled !== false` reads a missing
        //    field or a malformed payload as "on".
        // 3. One request at a time. `setInterval` allowed overlap, so a stale
        //    `enabled:true` response could land after a newer `enabled:false` and
        //    re-install the takeover — the switch would flip itself back.
        let stopped = false;
        let syncTimer;
        let inFlightController;

        if (typeof ctx.slots.subscribe === 'function') {
          for (const key of [CHAT_SLOT, ...Object.keys(CHILD_FACTORIES)]) {
            rendererSubscriptions.push(ctx.slots.subscribe(key, () => refreshTakeover()));
          }
        }
        if (typeof ctx.slots.onEntryError === 'function') {
          rendererSubscriptions.push(ctx.slots.onEntryError((key, entry) => {
            const ownCrash = key === CHAT_SLOT && entry.component === chatComponent;
            const factoryCrash = releaseChat !== undefined && Object.values(CHILD_FACTORIES)
              .some((name) => key === `factory:${name}`);
            if (!ownCrash && !factoryCrash) return;
            rendererFailed = true;
            // Leave the failing render/commit before releasing its entry. Do
            // not repeatedly reinstall a component the host just abdicated.
            void Promise.resolve().then(() => refreshTakeover());
          }));
        }

        const scheduleSync = (delay) => {
          if (stopped) return;
          clearTimeout(syncTimer);
          syncTimer = setTimeout(() => { void syncEnabled(); }, delay);
        };

        const syncEnabled = async () => {
          if (stopped) return;
          if (['ready', 'blocked'].includes(stateTransport?.status(''))) {
            refreshTakeover(); stateTransport.restart(); scheduleSync(5000); return;
          }
          const request = ++requestSequence;
          // `AbortController` is a host global, not part of the module sandbox.
          // The guard is not paranoia: when it is missing the whole apply() throws
          // and the plugin never registers anything, which looks exactly like "the
          // plugin is off".
          const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
          inFlightController = controller;
          // A hung request must not stop the sync loop for good.
          const timeout = setTimeout(() => controller?.abort(), 10000);
          try {
            const response = await fetch(`${ROUTE}/settings`, controller === undefined ? undefined : { signal: controller.signal });
            if (stopped) return;
            if (response.ok) {
              const value = await response.json();
              if (stopped) return;
              applyControls(value, request);
            }
          } catch {
            // Keep the last confirmed state; a transient failure is not evidence
            // of a switch change.
          } finally {
            clearTimeout(timeout);
            if (inFlightController === controller) inFlightController = undefined;
          }
          // Factory definitions have no public subscription on SlotRegistry;
          // child-slot changes wake us immediately, this also checks quiet churn.
          refreshTakeover();
          stateTransport?.restart();
          scheduleSync(5000);
        };

        // Everything this controller owns is torn down with the plugin. Native
        // timers are not part of Cordis's scope, so without this every reload left
        // one more poller and one more heartbeat behind.
        const removeTimers = () => {
          stopped = true;
          clientStopped = true;
          if (progressViewerSession !== undefined) announceProgressView(undefined);
          progressEnabled = false;
          clearTimeout(syncTimer);
          if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
          if (inFlightController !== undefined) inFlightController.abort();
          for (const entry of stateSubscriptions) { entry.poll?.(); entry.remote?.(); }
          stateSubscriptions.clear();
          const closingTransport = stateTransport;
          stateTransport = undefined;
          // The pollers are not part of the chat slot; a disabled plugin would
          // otherwise keep one 15s request per session alive after its UI was
          // unmounted.
          for (const poller of pollers.values()) poller.stop();
          pollers.clear();
          states.clear();
          hostInstance = undefined;
          retiredInstances.clear();
          instanceRequestFloor = 0;
          controlRevision = -1;
          sessionOff.clear();
          sessionSwitchRev = -1;
          switchReady = false;
          globalEnabled = false;
          activeSessionId = undefined;
          for (const unsubscribe of rendererSubscriptions.splice(0)) unsubscribe();
          releaseChatSlot();
          refreshChatTakeover = () => {};
          branchHistory.clear();
          freshDecided.clear();
          liveSeen.clear();
          diagnosticsTrail.clear();
          setChatRendererState('disabled');
          return closingTransport?.dispose();
        };
        try {
          ctx.effect(() => removeTimers, 'persona-shell.client-timers');
        } catch {
          // No effect scope here; the timers still stop on the next stop().
        }

        // Start the loop; the first response decides whether to take over.
        void syncEnabled();

        // Optional compatibility path: older compositions continue using the
        // authenticated long-poll routes. Official Remote owns transport/auth.
        if (typeof ctx.inject === 'function') ctx.inject(['remote'], (owner) => {
          let gateway;
          try { gateway = require('@deepseek-ai/dsh-api-gateway'); } catch { return; }
          const remote = owner.get('remote');
          if (stopped || stateTransport || typeof remote?.$stream !== 'function'
            || typeof gateway.RemoteSnapshotStream !== 'function') return;
          stateTransport = createClientTransport({ remote, SnapshotStream: gateway.RemoteSnapshotStream,
            CarrierError: gateway.RemoteStreamCarrierError, contribution: createRemoteContract(),
            bindRemote(bind) {
              return owner.inject(['remote', 'remote.personaShell'], (consumer) => {
                bind(consumer.get('remote'));
                consumer.effect(() => () => bind(undefined));
              });
            },
            viewer: progressViewerId, nextRequest: () => ++requestSequence,
            onState(sessionId, value, request) {
              if (stopped || !acceptInstance(value, request)) return false;
              if (sessionId === '') {
                applyControls(value, request);
              } else applyState(sessionId, value);
              return true;
            },
            onStatus(sessionId, status, error) {
              for (const entry of stateSubscriptions) if (entry.sessionId === sessionId) syncSubscription(entry);
              reportDiagnostics({ stateTransport: { status, error: error?.code ?? (error ? 'local-error' : undefined),
                message: typeof error?.message === 'string' ? error.message.slice(0, 160) : undefined } });
            },
          });
          stateTransport.subscribe('');
          for (const entry of stateSubscriptions) entry.remote = stateTransport.subscribe(entry.sessionId);
          if (progressViewerSession !== undefined) stateTransport.setView({ sessionId: progressViewerSession,
            revision: progressViewRevision, visible: typeof document === 'undefined' || document.visibilityState !== 'hidden' });
          void stateTransport.start();
          const transport = stateTransport;
          if (typeof owner.on === 'function') owner.on('connection/reset', () => transport.restart());
          owner.effect(() => () => {
            if (stateTransport === transport) {
              stateTransport = undefined;
              for (const entry of stateSubscriptions) { entry.remote = undefined; syncSubscription(entry); }
            }
            return transport.dispose();
          });
        });

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'persona-shell',
          order: 30,
          label: '人格套壳',
        }, SettingsSection));

        // One switch per Session, in the header's right-aligned utilities.
        // It also tells the page-wide takeover which Session is on screen.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'persona-shell',
          order: 10,
        }, SessionPersonaSwitch));

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'persona-shell-progress', order: 30, locale: 'dsh-persona-shell',
        }, ProgressNotice));
      },
    };
  },
});
