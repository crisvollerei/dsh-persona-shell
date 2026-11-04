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
    const CLIENT_BUILD = 2026110402;

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
        ready && row.final !== true && state?.settings?.processToolUsage === true
          && state?.settings?.includeToolSteps !== false && typeof row.processNote === 'string'
          && row.processNote !== '' && Array.from(row.processNote).length <= 40
          ? h('small', { 'data-persona-shell': 'process-note',
            title: t('shell.processNote') ?? '过程补充：依据本阶段工具统计与会话节奏生成，不计入正文措辞评分。',
            style: { display: 'block', marginTop: '4px', fontSize: '12px', lineHeight: '1.6',
              color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, row.processNote)
          : null,
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
    const memoryLineStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetNameStyle = { color: 'var(--dsw-alias-label-primary)' };
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
    const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.65' };
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
    const SETTINGS_CSS = [
      '[data-persona-shell="settings"],[data-persona-shell="memory-panel"]{--dsh-persona-accent:var(--dsw-alias-brand-primary,#3976c3);--dsh-persona-border:var(--dsw-alias-border-l1,#d8dfe7);--dsh-persona-bg:var(--dsw-alias-bg-layer-1,#fff);--dsh-persona-soft:var(--dsw-alias-bg-layer-2,#f5f7fa);--dsh-persona-text:var(--dsw-alias-label-primary,#203044);--dsh-persona-muted:var(--dsw-alias-label-secondary,#607080);color:var(--dsh-persona-text)}',
      '.dsh-persona-settings{max-width:880px;width:100%;min-width:0;font:inherit;line-height:1.6;padding:2px 0 12px}',
      '.dsh-persona-settings *,.dsh-persona-memory *{box-sizing:border-box}',
      '.dsh-persona-settings-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px;padding:22px 24px;border:1px solid var(--dsh-persona-border);border-radius:14px;background:var(--dsh-persona-soft);background:linear-gradient(115deg,color-mix(in srgb,var(--dsh-persona-accent) 8%,var(--dsh-persona-bg)),var(--dsh-persona-bg))}',
      '.dsh-persona-eyebrow{font-size:10px;letter-spacing:.16em;color:var(--dsh-persona-accent);font-weight:650;margin-bottom:5px}',
      '.dsh-persona-settings-hero h2{font:inherit;font-size:21px;line-height:1.4;font-weight:650;letter-spacing:-.02em;margin:0 0 7px}',
      '.dsh-persona-settings-hero p{font-size:12px;line-height:1.7;margin:0;color:var(--dsh-persona-muted)}',
      '.dsh-persona-save-state{font-size:11px;white-space:nowrap;color:var(--dsh-persona-muted);padding:4px 9px;border:1px solid var(--dsh-persona-border);border-radius:20px;background:var(--dsh-persona-bg)}',
      '.dsh-persona-section{border:1px solid var(--dsh-persona-border);border-radius:12px;margin:0 0 14px;padding:20px;background:var(--dsh-persona-bg);min-width:0}',
      '.dsh-persona-section-heading{display:flex;align-items:flex-start;gap:11px;margin-bottom:16px}',
      '.dsh-persona-step{font-size:11px;font-variant-numeric:tabular-nums;line-height:25px;color:var(--dsh-persona-accent);border-bottom:2px solid var(--dsh-persona-accent);min-width:21px}',
      '.dsh-persona-section-heading h3{font:inherit;font-weight:650;font-size:15px;margin:0 0 3px;line-height:1.5}',
      '.dsh-persona-section-heading p,.dsh-persona-section-note{font-size:12px;color:var(--dsh-persona-muted);margin:0;line-height:1.7}',
      '.dsh-persona-section-note{margin:0 0 14px}',
      '.dsh-persona-preset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;overflow:auto;overscroll-behavior:contain;padding:1px}',
      '.dsh-persona-preset-grid[data-many="true"]{max-height:320px}',
      '.dsh-persona-preset{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:13px 14px;border:1px solid var(--dsh-persona-border);border-radius:9px;min-width:0;background:var(--dsh-persona-bg)}',
      '.dsh-persona-preset[data-active="true"]{border-color:var(--dsh-persona-accent);background:color-mix(in srgb,var(--dsh-persona-accent) 5%,var(--dsh-persona-bg))}',
      '.dsh-persona-preset-name{min-width:0;flex:1 1 130px;overflow-wrap:anywhere;font-size:13px}',
      '.dsh-persona-preset-description{display:block;font-size:11px;line-height:1.5;color:var(--dsh-persona-muted);font-weight:400;white-space:normal;margin-top:3px}',
      '.dsh-persona-preset-tag{font-size:10px;color:var(--dsh-persona-muted);align-self:flex-start;border:1px solid var(--dsh-persona-border);border-radius:4px;padding:0 5px}',
      '.dsh-persona-preset-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex:1 0 100%}',
      '.dsh-persona-preset-actions button{font-size:12px;line-height:1.6}',
      '.dsh-persona-selected-label{font-size:11px;color:var(--dsh-persona-accent)}',
      '.dsh-persona-persona-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}',
      '.dsh-persona-persona-tools:has(>.dsh-persona-fold[open]){grid-template-columns:minmax(0,1fr)}',
      '.dsh-persona-fold{border:1px solid var(--dsh-persona-border);border-radius:10px;min-width:0;margin-bottom:14px;background:var(--dsh-persona-bg)}',
      '.dsh-persona-persona-tools>.dsh-persona-fold{margin-bottom:0}',
      '.dsh-persona-fold>summary{position:relative;display:flex;align-items:center;gap:12px;list-style:none;cursor:pointer;padding:15px 39px 15px 17px;min-height:66px;user-select:none}',
      '.dsh-persona-fold>summary::-webkit-details-marker{display:none}',
      '.dsh-persona-fold>summary::after{content:"+";position:absolute;right:17px;top:50%;transform:translateY(-50%);font-size:19px;line-height:1;color:var(--dsh-persona-muted);font-weight:400}',
      '.dsh-persona-fold[open]>summary::after{content:"-"}',
      '.dsh-persona-fold[open]>summary{border-bottom:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-fold-title{display:block;font-size:13px;font-weight:600;line-height:1.6}',
      '.dsh-persona-fold-note{display:block;font-size:11px;line-height:1.6;color:var(--dsh-persona-muted);margin-top:2px}',
      '.dsh-persona-fold-badge{margin-left:auto;white-space:nowrap;font-size:10px;color:var(--dsh-persona-muted);border:1px solid var(--dsh-persona-border);border-radius:20px;padding:1px 7px}',
      '.dsh-persona-fold-body{padding:17px;min-width:0}',
      '.dsh-persona-inline-fold{border:0;margin:0}.dsh-persona-inline-fold>summary{min-height:30px;padding:2px 25px 2px 0}.dsh-persona-inline-fold .dsh-persona-fold-note{display:none}.dsh-persona-inline-fold .dsh-persona-fold-title{font-size:12px;font-weight:400;color:var(--dsh-persona-muted)}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding:12px 0 0}.dsh-persona-inline-fold>summary::after{right:3px;font-size:15px}',
      '.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 20px;min-width:0}',
      '.dsh-persona-editor-field:first-child,.dsh-persona-editor-field:last-child,.dsh-persona-wide{grid-column:1/-1}',
      '.dsh-persona-settings textarea,.dsh-persona-settings select,.dsh-persona-settings input:not([type=checkbox]):not([type=range]):not([type=number]){max-width:100%;min-width:0;width:100%}',
      '.dsh-persona-settings textarea{line-height:1.7;resize:vertical}',
      '.dsh-persona-settings input[type=checkbox],.dsh-persona-memory input[type=checkbox]{accent-color:var(--dsh-persona-accent);flex-shrink:0;width:15px;height:15px;margin:1px 0}',
      '.dsh-persona-settings .dsh-persona-setting-field{margin-bottom:0!important;gap:7px!important;min-width:0}',
      '.dsh-persona-settings .dsh-persona-setting-field>label>span{font-size:13px!important;font-weight:550;color:var(--dsh-persona-text)!important}',
      '.dsh-persona-process-options{padding-bottom:17px;margin-bottom:17px;border-bottom:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-common-grid{margin-bottom:17px}',
      '.dsh-persona-settings .dsh-persona-subheading{font:inherit;font-size:13px;font-weight:600;margin:0 0 12px}',
      '.dsh-persona-help-copy{font-size:12px;line-height:1.8;color:var(--dsh-persona-muted)}',
      '.dsh-persona-help-copy p{margin:0 0 10px}.dsh-persona-help-copy p:last-child{margin-bottom:0}',
      '.dsh-persona-footer-note{font-size:11px;line-height:1.7;color:var(--dsh-persona-muted);margin:16px 2px 0}',
      '.dsh-persona-settings :is(button,input,select,textarea,summary):focus-visible,.dsh-persona-memory :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsh-persona-accent);outline-offset:3px}',
      '.dsh-persona-memory{font:inherit;min-width:0}',
      '.dsh-persona-memory .dsh-persona-fold{margin-top:13px;margin-bottom:0}',
      '.dsh-persona-memory .dsh-persona-fold>summary{min-height:52px;padding:11px 36px 11px 13px}',
      '.dsh-persona-memory .dsh-persona-fold-body{padding:13px}',
      '.dsh-persona-memory-list{max-height:390px;overflow:auto;overscroll-behavior:contain;min-width:0;padding-right:4px}',
      '.dsh-persona-memory-entry{padding:14px 0;border-top:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-memory-entry:first-child{border-top:0}',
      '.dsh-persona-memory-content{font-size:13px;line-height:1.8;margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.dsh-persona-memory-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 8px}',
      '.dsh-persona-memory-toolbar>select{min-width:0;max-width:100%}',
      '.dsh-persona-settings .dsh-persona-memory-toolbar>select{width:auto;max-width:230px;flex:1}',
      '.dsh-persona-settings .dsh-persona-memory .dsh-persona-fold-body select{width:auto;min-width:0;flex:1}',
      '.dsh-persona-memory-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}',
      '@media(max-width:600px){.dsh-persona-settings-hero{padding:18px;gap:12px;margin-bottom:15px}.dsh-persona-settings-hero h2{font-size:19px}.dsh-persona-section{padding:16px}.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid,.dsh-persona-persona-tools{grid-template-columns:minmax(0,1fr)}.dsh-persona-preset-grid[data-many="true"]{max-height:430px}.dsh-persona-common-grid{gap:20px}.dsh-persona-fold>summary{padding-left:15px}.dsh-persona-fold-body{padding:15px}.dsh-persona-inline-fold>summary{padding-left:0}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding-left:0;padding-right:0}}',
      '@media(max-width:400px){.dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-fold-note{font-size:11px}.dsh-persona-fold-badge{font-size:10px;padding:0 5px}}',
    ].join('\n');

    function settingsHeading(number, title, note) {
      return h('div', { className: 'dsh-persona-section-heading' }, h('span', { className: 'dsh-persona-step', 'aria-hidden': true }, number),
        h('div', null, h('h3', null, title), h('p', null, note)));
    }

    function settingsFold(id, title, description, content, options = {}) {
      return h('details', { className: 'dsh-persona-fold' + (options.compact ? ' dsh-persona-inline-fold' : ''), 'data-settings-fold': id, open: options.open },
        h('summary', null, h('span', null, h('span', { className: 'dsh-persona-fold-title' }, title),
          h('span', { className: 'dsh-persona-fold-note' }, description)),
        options.badge ? h('span', { className: 'dsh-persona-fold-badge' }, options.badge) : null),
        h('div', { className: 'dsh-persona-fold-body' }, content));
    }

    function personaSummary(preset) {
      if (preset.name.startsWith('大肥鱼')) return '鲸鲸的轻松口吻';
      if (preset.name.startsWith('大肥龙')) return '管事大姐大的直爽风格';
      if (preset.name.startsWith('Claude')) return '理性、克制，规矩感强';
      if (preset.name.startsWith('鲸鲸')) return '转述「姐姐」汇报的实验风格';
      return (preset.pack?.identity ?? '你自己的说话风格').replace(/\s+/g, ' ').slice(0, 36);
    }

    function MemoryPanel({ settings, save, presets }) {
      const [data, setData] = React.useState(undefined);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const revision = React.useRef(0);
      const currentPreset = React.useRef(settings.presetName);
      currentPreset.current = settings.presetName;
      const expectedPersona = presets.find((p) => p.name === settings.presetName)?.id;
      const scopePending = !data || (data.activePresetName !== undefined
        ? data.activePresetName !== settings.presetName : expectedPersona && expectedPersona !== data.activePersonaId);
      const [content, setContent] = React.useState('');
      const [kind, setKind] = React.useState('preference');
      const [scope, setScope] = React.useState('persona');
      const [filter, setFilter] = React.useState('current');
      const [editing, setEditing] = React.useState(undefined);
      const [editContent, setEditContent] = React.useState('');
      const [editScope, setEditScope] = React.useState('persona');
      const labels = { preference: '表达偏好', agreement: '互动约定', context: '会话情况', episode: '共同经历',
        shared: '所有人格共享', persona: '仅对应人格', session: '仅对应会话',
        active: '已采用', candidate: '待采纳', superseded: '已替代', rejected: '已忽略',
        manual: '手动记录', explicit: '用户明确表达', model: '后台整理', legacy: '旧版迁移' };
      const errorText = (code) => ({
        'memory-conflict': '这条记忆已被其他操作修改，请刷新后重试。',
        'storage-not-ready': '存储尚未就绪，请稍后重试。',
        'memory-save-failed': '保存失败，内容仍保留，请稍后重试。',
        'memory-capacity': '记忆已满，请删除不再需要的条目。',
        'private-memory-needs-scope': '互动约定和共同经历请保留在对应人格或会话中。',
        'memory-extraction-disabled': '请先开启记忆与后台整理。',
      }[code] ?? '操作未完成，请刷新后重试。');
      const refresh = async () => {
        const token = ++revision.current;
        try {
          const response = await fetch(ROUTE + '/memory');
          if (!response.ok) throw new Error('load');
          const value = await response.json();
          if (revision.current === token) setData(value);
        } catch { if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。'); }
      };
      React.useEffect(() => {
        void refresh();
        return () => { revision.current += 1; };
      }, [settings.memory, settings.memoryExtraction, settings.presetName]);
      const write = async (body) => {
        if (busyRef.current || scopePending || currentPreset.current !== settings.presetName) return false;
        busyRef.current = true; setBusy(true);
        const token = ++revision.current;
        setNotice('正在保存…');
        try {
          const response = await fetch(ROUTE + '/memory', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error);
          if (revision.current === token) {
            setData(value); setNotice(body.action === 'consolidate' ? '已安排整理，稍后可刷新查看候选。' : '已保存');
          }
          return true;
        } catch (error) { setNotice(errorText(error.message)); return false; }
        finally { busyRef.current = false; setBusy(false); }
      };
      const scopeFields = (value) => ({ scope: value,
        personaId: value === 'persona' ? data?.activePersonaId : null,
        sessionId: value === 'session' ? data?.sessionId : null });
      const scopeSelect = (value, change) => h('select', { style: inputStyle, value,
        disabled: busy || scopePending, onChange: (event) => change(event.target.value), 'aria-label': '记忆适用范围' },
      h('option', { value: 'persona' }, '当前人格'),
      h('option', { value: 'shared' }, '所有人格'),
      h('option', { value: 'session', disabled: !data?.sessionId }, '当前会话（角色共享）'));
      const entries = (scopePending ? [] : data?.entries ?? []).filter((entry) => filter === 'all' || (
        ['active', 'candidate'].includes(entry.status) && (entry.expiresAt === null || entry.expiresAt > Date.now())
          && (entry.scope === 'shared'
          || entry.personaId === data?.activePersonaId
          || (entry.scope === 'session' && !entry.personaId && entry.sessionId === data?.sessionId))));
      const memoryRows = entries.map((entry) => h('div', { key: entry.id, 'data-persona-shell': 'memory-entry', 'data-memory-id': entry.id,
            className: 'dsh-persona-memory-entry' },
          h('div', { style: hintStyle }, (labels[entry.kind] ?? entry.kind) + ' · '
            + (entry.expiresAt !== null && entry.expiresAt <= Date.now() ? '已过期' : labels[entry.status] ?? entry.status)
            + ' · ' + (labels[entry.origin] ?? '未知来源')
            + ' · ' + (entry.scope === 'persona'
              ? (presets.find((p) => p.id === entry.personaId)?.name ?? '已移除的人格') : labels[entry.scope])
            + (entry.pinned ? ' · 已置顶' : '')),
          editing?.id === entry.id ? h('div', null,
            h('textarea', { style: { ...inputStyle, width: '100%', minHeight: '64px' },
              maxLength: 240, value: editContent, disabled: busy,
              'aria-label': '修改记忆内容', onChange: (event) => setEditContent(event.target.value) }),
            scopeSelect(editScope, setEditScope),
            h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || !editContent.trim(),
              onClick: async () => {
                if (await write({ action: 'update', id: editing.id, version: editing.version,
                  content: editContent, pinned: editing.pinned, ...(editScope === editing.scope
                    ? { scope: editing.scope, personaId: editing.personaId, sessionId: editing.sessionId }
                    : scopeFields(editScope)) })) setEditing(undefined);
              } }, '保存记忆修改'),
            h('button', { type: 'button', style: toggleStyle, disabled: busy,
              onClick: () => setEditing(undefined) }, '取消修改'))
            : h('div', { className: 'dsh-persona-memory-content' }, entry.content),
          entry.evidence?.length ? h('details', null, h('summary', { style: hintStyle }, '查看来源'),
            ...entry.evidence.map((ref, index) => h('div', { key: index, style: { ...hintStyle, overflowWrap: 'anywhere' } },
              ref.quote))) : h('div', { style: hintStyle },
            entry.origin === 'legacy' ? '来自旧版记录，没有逐条原始依据。' : '由你手动记录。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' } },
            ...(entry.status === 'candidate' ? ['accept', 'reject'].map((action) => h('button', {
              key: action, type: 'button', style: toggleStyle, disabled: busy,
              onClick: () => write({ action, id: entry.id, version: entry.version }),
            }, action === 'accept' ? '采纳' : '忽略')) : []),
            h('button', { type: 'button', style: toggleStyle, disabled: busy,
              onClick: () => { setEditing(entry); setEditContent(entry.content); setEditScope(entry.scope); } }, '修改'),
            h('button', { type: 'button', style: toggleStyle, disabled: busy || entry.status !== 'active',
              onClick: () => write({ action: 'update', id: entry.id, version: entry.version, content: entry.content,
                pinned: !entry.pinned, scope: entry.scope, personaId: entry.personaId, sessionId: entry.sessionId }) },
            entry.pinned ? '取消置顶' : '置顶'),
            h('button', { type: 'button', style: toggleStyle, disabled: busy,
              onClick: () => write({ action: 'delete', id: entry.id, version: entry.version }) }, '删除'))));
      const manualEditor = h('div', { style: { marginTop: '12px' } },

            h('textarea', { style: { ...inputStyle, width: '100%', minHeight: '64px', margin: '6px 0' },
              value: content, maxLength: 240,
              disabled: busy, 'aria-label': '新增记忆内容', placeholder: '例如：称呼我为阿晴；汇报先说结果，再补充条件。',
              onChange: (event) => setContent(event.target.value) }),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
              h('select', { style: inputStyle, value: kind, disabled: busy, 'aria-label': '记忆类型',
                onChange: (event) => setKind(event.target.value) },
              ...['preference', 'agreement', 'context', 'episode'].map((value) =>
                h('option', { key: value, value }, labels[value]))),
              scopeSelect(scope, setScope),
              h('button', { type: 'button', style: primaryButtonStyle,
                disabled: busy || scopePending || !content.trim() || (scope === 'session' && !data?.sessionId),
                onClick: async () => {
                  if (await write({ action: 'add', entry: { kind, content, ...scopeFields(scope) } })) setContent('');
                } }, '添加记忆')));
      const clearControl = h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: async () => {
              if (busyRef.current) return;
              busyRef.current = true; setBusy(true); revision.current += 1;
              try {
                const result = await save({ clearMemory: true });
                if (result?.settings) { setEditing(undefined); await refresh(); setNotice('已清空记忆与待整理内容'); }
                else setNotice('清空未完成，请稍后重试。');
              } finally { busyRef.current = false; setBusy(false); }
            } }, '清空记忆');
      return h('div', { className: 'dsh-persona-memory', style: { ...fieldStyle, marginBottom: 0 }, 'data-persona-shell': 'memory-panel' },
        h('style', null, SETTINGS_CSS),
        h('label', { style: toggleRowStyle },
          h('input', { type: 'checkbox', checked: settings.memory !== false,
            onChange: (event) => save({ memory: event.target.checked }) }),
          h('span', { style: labelStyle }, '记住偏好与约定')),
        h('span', { style: hintStyle },
          '记住你希望怎样被回应。关闭后停止采集和使用，已有记录会保留。'),
        settingsFold('memory-extraction', '后台整理', '可选，额外调用转述模型',
          h('div', null, h('label', { style: { ...toggleRowStyle, marginTop: '8px' } },
          h('input', { type: 'checkbox', checked: settings.memoryExtraction === true,
            disabled: settings.memory === false,
            onChange: (event) => save({ memoryExtraction: event.target.checked }) }),
          h('span', { style: labelStyle }, '后台整理记忆候选（默认关闭）')),
        h('span', { style: hintStyle },
          '开启后会把有上限的用户短消息片段发送给当前转述模型，增加模型用量。约每5分钟或积累8条同会话消息整理一次，候选采纳后才使用。'),
            h('div', { className: 'dsh-persona-memory-footer' },
              h('span', { style: hintStyle }, data?.extraction?.status === 'running' ? '正在整理…'
                : data?.extraction?.status === 'failed' ? '上次整理未完成，可稍后重试。'
                : '待整理 ' + (data?.extraction?.pending ?? 0) + ' 条'),
              h('button', { type: 'button', style: toggleStyle,
                disabled: busy || !settings.memory || !settings.memoryExtraction,
                onClick: () => write({ action: 'consolidate' }) }, '整理一次'))),
          { badge: settings.memoryExtraction ? '已开启' : '已关闭' }),
        h('div', { className: 'dsh-persona-memory-toolbar' },
          h('span', { style: labelStyle }, '记忆管理'),
          h('select', { style: inputStyle, value: filter, 'aria-label': '筛选记忆',
            onChange: (event) => setFilter(event.target.value) },
            h('option', { value: 'current' }, '当前人格与共享'),
            h('option', { value: 'all' }, '全部（含历史状态）')),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: refresh }, '刷新记忆')),
        h('div', { style: hintStyle }, entries.filter((entry) => entry.status === 'active').length + ' 条已采用 · '
          + entries.filter((entry) => entry.status === 'candidate').length + ' 条待采纳'),
        h('div', { className: 'dsh-persona-memory-list' }, ...memoryRows),
        scopePending ? h('p', { style: hintStyle }, '正在读取当前人格的记忆…')
          : entries.length === 0 ? h('p', { style: hintStyle }, '还没有记忆。可以手动记一条，也可以继续对话。') : null,
        settingsFold('memory-add', '手动记一条', '选择内容与适用范围', manualEditor,
          { badge: content.trim() ? '有草稿' : undefined }),
        h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, notice)),
        settingsFold('memory-clear', '清理记忆', '清空全部记忆、待整理内容和交接记录', clearControl));
    }

    function SettingsSection() {
      const [settings, setSettings] = React.useState(undefined);
      const settingsRef = React.useRef(undefined);
      const [packDrafts, setPackDrafts] = React.useState({});
      const draftsRef = React.useRef({ values: {}, versions: {}, revision: 0 });
      const writes = React.useRef(Promise.resolve());
      const editorGeneration = React.useRef(0);
      const editorScope = editorGeneration.current;
      const [presetBusy, setPresetBusy] = React.useState(false);
      const presetBusyRef = React.useRef(false);
      const presetLoadRevision = React.useRef(0);
      const statusTimer = React.useRef(undefined);
      const mounted = React.useRef(true);
      const [rendererState, setRendererState] = React.useState(chatRendererState);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearTimeout(statusTimer.current); };
      }, []);
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
      const [generatedSource, setGeneratedSource] = React.useState('');
      const generatingRef = React.useRef(false);
      const [presetStatus, setPresetStatus] = React.useState('');
      /** Name the user chose for a freshly generated preset. */
      const [generatedName, setGeneratedName] = React.useState('');
      /** Preset id being renamed, if the inline editor is open. */
      const [renaming, setRenaming] = React.useState(undefined);
      const [renameValue, setRenameValue] = React.useState('');

      // Keep writes in user order; card drafts remain separate from server snapshots.
      const queueWrite = (write) => {
        const task = writes.current.then(write, write);
        writes.current = task.catch(() => {});
        return task;
      };
      const acceptSettings = (value) => { settingsRef.current = value; setSettings(value); };
      const showStatus = (value, temporary = false) => {
        if (!mounted.current) return;
        clearTimeout(statusTimer.current);
        setStatus(value);
        if (temporary) statusTimer.current = setTimeout(() => setStatus(''), 1500);
      };
      const setDraft = (field, value) => {
        if (presetBusyRef.current || editorGeneration.current !== editorScope) return false;
        const draft = draftsRef.current;
        const revision = draft.revision + 1;
        draftsRef.current = { values: { ...draft.values, [field]: value },
          versions: { ...draft.versions, [field]: revision }, revision };
        setPackDrafts(draftsRef.current.values);
        return true;
      };

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
          const revision = presetLoadRevision.current;
          try {
            const response = await fetch(`${ROUTE}/presets`);
            if (!response.ok) return;
            value = await response.json();
            if (revision !== presetLoadRevision.current) return;
          } catch {
            return;
          }
        } else presetLoadRevision.current += 1;
        const list = Array.isArray(value?.presets) ? value.presets : [];
        setPresets(list);
        const activeName = typeof value?.active === 'string' ? value.active : '';
        setActivePresetName(activeName);
        const match = list.find((preset) => preset.name === activeName);
        setActivePresetId(match !== undefined ? match.id : '');
      };

      React.useEffect(() => { void refreshPresets(); }, []);

      const presetAction = (body) => {
        if (presetBusyRef.current) return Promise.resolve({ ok: false, reason: 'preset-change-pending' });
        presetBusyRef.current = true;
        setPresetBusy(true);
        editorGeneration.current += 1;
        const replacesCard = body.action === 'apply' || body.action === 'save'
          || (body.action === 'delete' && body.id === activePresetId);
        return queueWrite(async () => {
          try {
            // A failed blur save must not disappear when another card is selected.
            const changes = draftChanges();
            if (replacesCard && changes.length > 0 && !(await persistPackChanges(changes))?.settings) {
              setPresetStatus('切换前保存人格修改失败，请重试。');
              return { ok: false, reason: 'unsaved-persona-edits' };
            }
            const result = await postPreset(body);
            if (result?.ok === true) {
              await refreshPresets({ presets: result.presets, active: result.active });
              if (result.settings !== undefined) acceptSettings(result.settings);
              setPresetStatus('');
            } else {
              setPresetStatus(`失败：${result?.reason ?? '未知原因'}`);
            }
            return result;
          } finally {
            presetBusyRef.current = false;
            setPresetBusy(false);
          }
        });
      };

      const generatePreset = async () => {
        if (generatingRef.current || presetBusyRef.current) return;
        generatingRef.current = true;
        const prompt = personaPrompt;
        setGenerating(true);
        setPresetStatus('正在读取人设…');
        setGenerated(undefined);
        setGeneratedName('');
        const result = await postPreset({ action: 'generate', prompt });
        generatingRef.current = false;
        setGenerating(false);
        if (result?.ok === true) {
          setGenerated(result.preset);
          setGeneratedSource(prompt);
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

      const writeSettings = async (patch) => {
        showStatus('正在保存…');
        const result = await postSettings(patch);
        if (result?.settings !== undefined) {
          acceptSettings(result.settings);
          // Saving can change the learned profile (a clear resets it), so the
          // memory panel refreshes from the same response rather than going stale.
          if (Array.isArray(result.memory)) setMemoryLines(result.memory);
          if (result.memoryStats !== undefined) setMemoryStats(result.memoryStats);
          // Editing the card writes back into a preset — or forks one from the
          // builtin — so the list and the selection both move with it.
          if (Array.isArray(result.presets)) {
            await refreshPresets({ presets: result.presets, active: result.settings.presetName });
          }
          showStatus('已保存', true);
        } else {
          showStatus('保存失败，请重试');
        }
        return result;
      };
      const save = (patch) => queueWrite(() => writeSettings(patch));
      const draftChanges = () => Object.entries(draftsRef.current.values)
        .map(([field, value]) => ({ field, value, version: draftsRef.current.versions[field] }));
      const persistPackChanges = async (changes) => {
        const nextPack = { ...settingsRef.current?.pack };
        for (const { field, value } of changes) {
          if (field === 'subagent') nextPack.address = { ...nextPack.address, subagent: value };
          else nextPack[field] = field === 'identity' ? value : value.split('\n').filter((line) => line.trim() !== '');
        }
        const result = await writeSettings({ pack: nextPack });
        if (result?.settings !== undefined) {
          const draft = draftsRef.current;
          const values = { ...draft.values };
          const versions = { ...draft.versions };
          for (const { field, version } of changes) if (versions[field] === version) {
            delete values[field]; delete versions[field];
          }
          draftsRef.current = { ...draft, values, versions };
          setPackDrafts(values);
        }
        return result;
      };
      const savePackField = (field, value) => {
        if (!setDraft(field, value)) return Promise.resolve();
        const change = { field, value, version: draftsRef.current.versions[field] };
        return queueWrite(() => persistPackChanges([change]));
      };
      const draftValue = (field, value) => Object.hasOwn(packDrafts, field) ? packDrafts[field] : value;

      if (settings === undefined) {
        return h('div', null,
          h('h2', { style: sectionTitleStyle }, '人格套壳'),
          h('div', { style: hintStyle }, '正在读取设置…'),
          h(LoadSettings, {
            onLoaded: (value) => {
              acceptSettings(value.settings);
              setMemoryLines(Array.isArray(value.memory) ? value.memory : []);
              setMemoryStats(value.memoryStats);
            },
          }),
        );
      }

      const processControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.includeToolSteps !== false,
              onChange: (event) => save({ includeToolSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '同时改写阶段性输出'),
          ),
          h('span', { style: hintStyle },
            '让带工具调用的阶段汇报也使用当前人格。',
          ),
          h('label', { style: { ...toggleRowStyle, marginTop: '10px' } },
            h('input', { type: 'checkbox', checked: settings?.processToolUsage === true,
              disabled: settings?.includeToolSteps === false,
              onChange: (event) => save({ processToolUsage: event.target.checked }) }),
            h('span', { style: labelStyle }, '允许过程转述参考运行信息'),
          ),
          h('span', { style: hintStyle },
            '参考这段工作的轻量统计，单独补充一句。可选，会增加一次模型续接。'),
        );
      const quietControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', { type: 'checkbox', checked: settings.progressNotices === true,
              onChange: (event) => save({ progressNotices: event.target.checked }) }),
            h('span', { style: labelStyle }, '静默状态播报'),
          ),
          h('span', { style: hintStyle },
            '等待较久时听到一句状态播报。可选，会额外调用模型。'),
          h('label', { hidden: settings.progressNotices !== true, style: { ...toggleRowStyle, display: settings.progressNotices === true ? 'flex' : 'none', marginTop: '8px', flexWrap: 'wrap' } },
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
        );
      const reviewControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings.reviewHints !== false,
              onChange: (event) => save({ reviewHints: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写变化提示'),
          ),
          h('span', { style: hintStyle },
            '变化较大时显示 ※，方便对照原文。只在本地检查，不增加模型调用。')
        );
      const thresholdControls = h('details', { style: { marginTop: '6px' } },
            h('summary', { style: { ...hintStyle, cursor: 'pointer' } }, '调整变化提示阈值'),
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
          );
      const subagentControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
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
        );
      const personaControls = h('div', { className: 'dsh-persona-personas' },


          // Say where edits go before they are made: an edit to the builtin
          // forks a new preset, and that is surprising if it is not announced.


          presets && presets.length > 0
            ? h('div', { className: 'dsh-persona-preset-grid', 'data-many': presets.length > 4 },
              ...[...presets].sort((a, b) => Number(b.id === activePresetId) - Number(a.id === activePresetId)).map((preset) => h('div', {
                key: preset.id,
                className: 'dsh-persona-preset', 'data-preset-id': preset.id, 'data-active': preset.id === activePresetId,
              },
              h('span', {
                className: 'dsh-persona-preset-name',
                style: {
                  ...presetNameStyle,
                  fontWeight: preset.id === activePresetId ? '600' : '400',
                },
              }, preset.name, h('small', { className: 'dsh-persona-preset-description' }, personaSummary(preset))),
              preset.builtin === true
                ? h('span', { className: 'dsh-persona-preset-tag' }, '内置')
                : null,
              h('div', { className: 'dsh-persona-preset-actions' },
                preset.id === activePresetId
                  ? h('span', { className: 'dsh-persona-selected-label' }, '已选择')
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    disabled: presetBusy,
                    onClick: () => presetAction({ action: 'apply', id: preset.id }),
                  }, '启用'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    disabled: presetBusy,
                    onClick: () => startRename(preset),
                  }, '改名'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: { ...toggleStyle, color: 'var(--dsw-alias-label-tertiary)' },
                    disabled: presetBusy,
                    onClick: () => presetAction({ action: 'delete', id: preset.id }),
                  }, '删除'),
              ))),
            )
            : null,

          // Inline rename: a dialog would be heavier than the operation, and the
          // page already has the preset in hand.
          renaming !== undefined
            ? h('div', { style: { ...presetPreviewStyle, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                style: { ...inputStyle, flex: 1 },
                value: renameValue,
                disabled: presetBusy,
                onChange: (event) => setRenameValue(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitRename(); },
              }),
              h('button', { type: 'button', style: primaryButtonStyle, disabled: presetBusy, onClick: commitRename }, '保存'),
              h('button', {
                type: 'button',
                style: toggleStyle,
                onClick: () => { setRenaming(undefined); setRenameValue(''); },
              }, '取消'),
            )
            : null,
        );
      const generatorControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: labelStyle }, '从人设提示词生成预设'),
          h('span', { style: hintStyle },
            '粘贴人设提示词，提取说话风格。生成后可预览、改名，再保存启用。',
          ),
          h('textarea', {
            style: { ...inputStyle, minHeight: '88px', resize: 'vertical' },
            'aria-label': '人设提示词', placeholder: '粘贴人设提示词…',
            value: personaPrompt,
            onChange: (event) => setPersonaPrompt(event.target.value),
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '6px' } },
            h('button', {
              type: 'button',
              style: primaryButtonStyle,
              disabled: generating || presetBusy || personaPrompt.trim().length < 20,
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
                  disabled: presetBusy,
                  'aria-label': '新预设名称', placeholder: '给这个预设起个名字',
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
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px' } },
                h('button', {
                  type: 'button',
                  style: primaryButtonStyle,
                  disabled: presetBusy || generatedName.trim() === '',
                  onClick: async () => {
                    const result = await presetAction({
                      action: 'save',
                      name: generatedName.trim(),
                      pack: generated,
                      source: generatedSource,
                    });
                    if (result?.ok === true) {
                      setGenerated(undefined);
                      setGeneratedName('');
                    }
                  },
                }, '保存并启用'),
                h('button', {
                  type: 'button',
                  style: toggleStyle,
                  disabled: presetBusy,
                  onClick: () => { setGenerated(undefined); setPresetStatus(''); },
                }, '丢弃'),
              ),
            )
            : null,
        );
      const editorControls = h('div', { className: 'dsh-persona-editor-grid' }, h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '身份'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '身份',
            value: draftValue('identity', pack?.identity ?? ''),
            onChange: (event) => setDraft('identity', event.target.value),
            onBlur: (event) => savePackField('identity', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '汇报里的说话规则（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '汇报里的说话规则',
            value: draftValue('report', (pack?.report ?? []).join('\n')),
            onChange: (event) => setDraft('report', event.target.value),
            onBlur: (event) => savePackField('report', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '通用语感（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '通用语感',
            value: draftValue('voice', (pack?.voice ?? []).join('\n')),
            onChange: (event) => setDraft('voice', event.target.value),
            onBlur: (event) => savePackField('voice', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '语气示例（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '语气示例',
            value: draftValue('samples', (pack?.samples ?? []).join('\n')),
            onChange: (event) => setDraft('samples', event.target.value),
            onBlur: (event) => savePackField('samples', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '避免出现（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '避免出现',
            value: draftValue('avoid', (pack?.avoid ?? []).join('\n')),
            onChange: (event) => setDraft('avoid', event.target.value),
            onBlur: (event) => savePackField('avoid', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '子代理称呼'),
          h('input', {
            style: inputStyle,
            disabled: presetBusy,
            'aria-label': '子代理称呼',
            value: draftValue('subagent', pack?.address?.subagent ?? ''),
            onChange: (event) => setDraft('subagent', event.target.value),
            onBlur: (event) => savePackField('subagent', event.target.value),
          }),
        ));
      const modelControls = h('div', { className: 'dsh-persona-model-fields' }, h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: labelStyle }, '改写所用模型'),
          h('select', {
            style: inputStyle,
            'aria-label': '改写所用模型', value: settings?.provider ?? '',
            onChange: (event) => save({ provider: event.target.value, model: '' }),
          },
          h('option', { value: '' }, '跟随会话当前模型'),
          providers.map((entry) => h('option', { key: entry.provider, value: entry.provider }, entry.name ?? entry.provider))),
          h('span', { style: hintStyle }, '留空即跟随当前会话；指定后所有会话都用它改写。'),
        ),

        settings?.provider !== undefined && settings.provider !== ''
          ? h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
            h('span', { style: labelStyle }, '模型'),
            h('select', {
              style: inputStyle,
              'aria-label': '模型', value: settings.model ?? '',
              onChange: (event) => save({ model: event.target.value }),
            },
            h('option', { value: '' }, '该提供方的默认模型'),
            models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
          )
          : null);
      return h('div', { 'data-persona-shell': 'settings', className: 'dsh-persona-settings' },
        h('style', null, SETTINGS_CSS),
        h('header', { className: 'dsh-persona-settings-hero' },
          h('div', null,
            h('div', { className: 'dsh-persona-eyebrow' }, 'PERSONA SHELL'),
            h('h2', null, '人格套壳'),
            h('p', null, '先选一个人格，其他选项可以慢慢调整。原文始终可查。')),
          h('span', { className: 'dsh-persona-save-state', role: 'status', 'aria-live': 'polite' }, status || '修改自动保存')),
        shippedRendererOk ? null : h('div', { style: warningStyle },
          '独立原文预览暂以纯文本显示，聊天正文仍由官方组件渲染。'),
        rendererState.status === 'incompatible' || rendererState.status === 'error'
          ? h('div', { style: warningStyle, role: 'status' }, '人格显示已暂停，当前保留官方原文。',
            h('details', null, h('summary', null, '查看原因'), rendererState.reason)) : null,
        h('section', { className: 'dsh-persona-section', 'aria-label': '选择人格' },
          settingsHeading('01', '选择人格', '当前：' + (settings.presetName || activePresetName || '大肥鱼（默认）')
            + (presets.length > 4 ? ' · 共 ' + presets.length + ' 个，可滚动选择' : '')),
          personaControls,
          h('div', { className: 'dsh-persona-persona-tools' },
            settingsFold('create-persona', '创建新人格', '从你的人设提示词开始', generatorControls,
              { open: generated !== undefined ? true : undefined }),
            settingsFold('edit-persona', '调整当前人格', Object.keys(packDrafts).length
              ? '有尚未保存的输入' : '身份、语气、示例与称呼',
              h('div', null, h('p', { className: 'dsh-persona-section-note' },
                '编辑后自动保存；调整内置人格会另存一份，原版始终保留。'), editorControls)))),
        h('section', { className: 'dsh-persona-section', 'aria-label': '日常转述' },
          settingsHeading('02', '日常转述', '常用开关放在这里，保持默认也能开始。'),
          h('div', { className: 'dsh-persona-process-options' }, processControls),
          h('div', { className: 'dsh-persona-common-grid' }, reviewControls, quietControls),
          settingsFold('rewrite-help', '这些选项如何工作', '调用用量与原文边界',
            h('div', { className: 'dsh-persona-help-copy' },
              h('p', null, '阶段性输出关闭后跳过带工具调用的步骤。严格只改最终汇报，需要在插件行配置 trigger: report。'),
              h('p', null, '过程运行信息仅提供分类统计与轻量会话节奏；可选补充最多40字、每轮最多3条，不进入最终汇报。查询会增加一次模型续接。'),
              h('p', null, '静默播报仅为前台正在查看的主会话生成，标记为 ◈；每轮最多3次，无新事实不重复调用，也不代表任务完成。'),
              h('p', null, '※ 只衡量措辞变化，不保证语义一致。重要事实、条件和风险仍应对照原文。')), { compact: true })),
        settingsFold('memory', '记忆与约定', '管理偏好、查看来源，按需要整理候选',
          h(MemoryPanel, { settings, save, presets }),
          { badge: settings.memory === false ? '已关闭' : '已开启' }),
        settingsFold('advanced', '高级设置', '转述模型、子代理与提示阈值',
          h('div', { className: 'dsh-persona-advanced-grid' },
            h('div', null, h('h3', { className: 'dsh-persona-subheading' }, '转述模型'), modelControls),
            h('div', null, subagentControls),
            h('div', { className: 'dsh-persona-wide' }, thresholdControls))),
        h('p', { className: 'dsh-persona-footer-note' }, '人格只影响表达。工作会话保留原始汇报，转述失败时自动显示原文。'));
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
        MemoryPanel,
        SettingsSection,
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
