window.__ModuleLoader__.load({
  id: 'dsh-persona-shell',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let createChatPortal;
    try { createChatPortal = require('react-dom').createPortal; } catch { /* Older clients render the fixed window inline. */ }
    let createChatRoot;
    try { createChatRoot = require('react-dom/client').createRoot; } catch {
      try { createChatRoot = require('react-dom').createRoot; } catch { /* The chat entry explains unsupported hosts. */ }
    }
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
    const CLIENT_BUILD = 2026110724;

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
      const [panel, setPanel] = React.useState(false);
      const { state } = useHostState(sessionId, -2);
      const conversation = state?.conversation;

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

      return h(React.Fragment, null, h('button', {
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
      }, h('span', null, label), h('span', null, stateText)),
      h('button', { type: 'button', onClick: () => setPanel(true), style: headerButtonStyle,
        'aria-haspopup': 'dialog', title: '设置当前会话的人格、转述范围与接力' },
        '会话设置'),
      panel ? h(ConversationPanel, { key: sessionId, sessionId, conversation, onClose: () => setPanel(false) }) : null,
      h(PersonaChatLauncher, { sessionId, conversation }));
    }

    const chatDrafts = new Map();
    const chatRoomLayout = { wide:false, composeExpanded:false };
    const chatRetryIds = new Map();
    const chatAnimatedAttempts = new Set();
    const markChatAnimation=id=>{chatAnimatedAttempts.add(id);while(chatAnimatedAttempts.size>200)chatAnimatedAttempts.delete(chatAnimatedAttempts.values().next().value);};
    const chatLaunchListeners = new Set();
    const chatUpdates = new Set();
    const chatProfileUpdates = new Set();
    const chatPersonaChoices = new Map();
    let chatContextCache;
    let chatForegroundSession;
    const chatForegroundListeners = new Set();
    const chatRuntime = {
      opened: false, minimized: false, root: undefined, container: undefined, sessionId: undefined, conversation: undefined, focusAt: 0,
      setMinimized(value) {
        if (!this.opened || this.minimized===value) return;
        this.minimized=value;
        for(const update of chatLaunchListeners)update();
      },
      foreground(sessionId) {
        if (!sessionId) return;
        const changed = chatForegroundSession!==sessionId; chatForegroundSession=sessionId;
        if (changed) for (const update of chatForegroundListeners) update();
        if (!this.opened || this.minimized || document.visibilityState==='hidden' || !chatContextCache?.initialized || (!changed && Date.now()-this.focusAt<5000)) return;
        this.focusAt=Date.now();
        void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({action:'focus',roomId:chatContextCache.roomId,sessionId,viewer:'foreground'})}).catch(()=>{});
      },
      open(sessionId,conversation) {
        this.foreground(sessionId);
        if (!this.root) {
          if (typeof createChatRoot!=='function') throw Error('当前客户端暂不支持独立聊天室，请升级 DSH。');
          this.container=document.createElement('div');this.container.dataset.personaShell='chat-runtime';document.body.appendChild(this.container);
          this.root=createChatRoot(this.container);
        }
        if (this.opened) { if(this.minimized)this.setMinimized(false);else document.getElementById('dsh-persona-chat-input')?.focus();return; }
        this.opened=true;this.minimized=false;
        if (!this.sessionId) {this.sessionId=sessionId;this.conversation=conversation;}
        this.root.render(h(RoomChatWorkspace,{sessionId:chatForegroundSession??this.sessionId,conversation:this.conversation,onClose:()=>this.close()}));
        for(const update of chatLaunchListeners)update();
      },
      close() {this.opened=false;this.minimized=false;this.root?.render(null);chatAnimatedAttempts.clear();for(const update of chatLaunchListeners)update();},
      dispose() {this.opened=false;this.minimized=false;this.root?.unmount();this.container?.remove();this.root=undefined;this.container=undefined;this.sessionId=undefined;this.conversation=undefined;chatContextCache=undefined;},
    };
    const chatNonce = () => window.crypto?.randomUUID?.() ?? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const emptyChatDraft = () => ({ text: '', requestId: chatNonce() });
    const chatErrorText = (code) => ({
      'storage-not-ready': '聊天记录暂时无法保存，请稍后重试。输入仍保留。',
      'chat-save-failed': '保存没有完成，请重试。输入仍保留。',
      'chat-conflict': '聊天记录刚有更新，已重新读取，请核对后再操作。',
      'chat-id-conflict': '这条消息已提交过不同内容，请重新编辑后发送。',
      'chat-busy': '这位角色还在回复，可以先写下一条，或停止这次回复。',
      'chat-context-changed': '参考来源已变化，请核对来源后重新发送。输入仍保留。',
      'chat-context-unsaved': '参考来源还未保存，请打开来源面板刷新后重试。消息仍保留。',
      'context-not-open': '参考服务尚未连接，请打开参考来源后重试。输入仍保留。',
      'chat-capacity': '已达到 32 个聊天室上限，请在房间资料中删除不再需要的聊天室。',
      'chat-primary-limit': '每条消息最多 @ 两位主讲。先取消一位，即可换人。',
      'chat-legacy-mentions': '这条旧消息曾点名超过两位。请选择一至两位主讲，重新发送。',
      'persona-not-found': '这位角色已经移除，保留的记录仍可查看。',
      'chat-room-not-found': '这个聊天室已移除，请重新选择或新建。',
      'chat-recipient-not-member': '这位角色已不在房间中，请重新选择回复对象。',
      'invalid-chat-members': '每个聊天室需要 1–8 位不同的人格。',
    }[code] ?? '暂时没有连接成功，输入仍保留，可以稍后重试。');
    const chatReplyStateText = (turn, running) => turn.status === 'pending' && running ? '输入中…' : ({
      format: '回复格式暂未识别，消息已保留，可以重试。',
      'too-long': '回复过长，未保存不完整内容，可以重试。',
      length: '模型回复达到长度限制，消息已保留，可以重试。',
      timeout: '回复超时，消息已保留，可以重试。',
      unavailable: '聊天模型暂不可用，请检查聊天室模型设置。',
      auth: '模型认证或访问权限未通过，请检查提供方设置。',
      'rate-limit': '模型调用较频繁，请稍后重试。',
      network: '连接模型时中断，消息已保留，可以重试。',
      model: '模型调用未成功，消息已保留，可以重试。',
      incomplete: '模型回复未正常结束，消息已保留，可以重试。',
      'source-changed': '参考来源已更新，旧回复已停止。',
      'persona-changed': '人格设定已更新，旧回复已停止。',
      'memory-changed': '记忆偏好已更新，旧回复已停止。',
      'member-removed':'原回复对象已移出聊天室，回复已停止。',
      save: '回复保存未完成，消息已保留，可以重试。',
    }[turn.failure] ?? (turn.status === 'cancelled' ? '回复已停止' : '上次回复未完成，消息已保留'));
    const CHAT_CSS = `
      .dsh-persona-chat{--chat-bg:var(--dsw-alias-bg-layer-1,#fff);--chat-soft:var(--dsw-alias-bg-layer-2,#f3f5f8);--chat-border:var(--dsw-alias-border-l1,#d6dfe9);--chat-text:var(--dsw-alias-label-primary,#203044);--chat-muted:var(--dsw-alias-label-secondary,#65758a);--chat-brand:var(--dsw-alias-brand-primary,#3976c3);position:fixed;right:20px;bottom:20px;width:min(430px,calc(100vw - 32px));height:min(650px,calc(100dvh - 40px));z-index:1100;display:flex;flex-direction:column;min-width:0;border:1px solid var(--chat-border);border-radius:16px;background:var(--chat-bg);color:var(--chat-text);box-shadow:0 18px 70px #0003;font:14px/1.65 system-ui,sans-serif;overflow:hidden}
      .dsh-persona-chat[data-wide=true]{width:min(740px,calc(100vw - 32px));height:min(780px,calc(100dvh - 40px))}
      .dsh-persona-chat-sources{max-height:36%;overflow:auto;flex:none}.dsh-persona-chat-sources p{font-size:11px;margin:8px 0}.dsh-persona-chat-sources button{font-size:11px;min-height:26px;padding:2px 7px}.dsh-persona-source-item{display:flex;align-items:center;gap:8px;margin:7px 0}.dsh-persona-source-item>span{flex:1;min-width:0;overflow-wrap:anywhere}.dsh-persona-chat-source-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.dsh-persona-chat-source-actions select{min-width:0;max-width:100%;font-size:12px;border:1px solid var(--chat-border);border-radius:6px;background:var(--chat-bg);padding:5px}.dsh-persona-context-notices{flex:none;max-height:20%;overflow:auto;padding:8px 14px;border-bottom:1px solid var(--chat-border);font-size:12px}.dsh-persona-context-notices summary{cursor:pointer}
      .dsh-persona-chat *{box-sizing:border-box}.dsh-persona-chat button,.dsh-persona-chat select,.dsh-persona-chat textarea{font:inherit;color:inherit}.dsh-persona-chat button{cursor:pointer;border:1px solid var(--chat-border);border-radius:7px;background:var(--chat-bg);padding:5px 10px;min-height:32px}.dsh-persona-chat button:disabled{opacity:.5;cursor:default}.dsh-persona-chat :is(button,select,textarea):focus-visible{outline:2px solid var(--chat-brand);outline-offset:2px}
      .dsh-persona-chat-top{flex:none;min-height:64px;height:auto;margin:0;transform:none;overflow:visible;display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--chat-border);background:var(--chat-bg)}.dsh-persona-chat-title{min-width:0;flex:1}.dsh-persona-chat-title strong{display:block;font-size:14px}.dsh-persona-chat-title small{display:block;color:var(--chat-muted);font-size:11px}.dsh-persona-chat-top button{padding:3px 8px;font-size:12px}.dsh-persona-chat select{max-width:100%;min-width:0;border:0;border-radius:5px;background:var(--chat-soft);padding:3px 5px;font-size:13px}
      .dsh-persona-chat-avatar{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--chat-soft);border:1px solid var(--chat-border);font-size:13px;font-weight:600}.dsh-persona-chat-top>.dsh-persona-chat-avatar{color:var(--chat-brand);width:36px;height:36px}
      .dsh-persona-chat-thread{position:relative;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:16px 14px;background:var(--chat-soft);scroll-padding:14px}.dsh-persona-chat-time{text-align:center;font-size:10px;color:var(--chat-muted);margin:0 0 14px}.dsh-persona-chat-message{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px}.dsh-persona-chat-message[data-user=true]{flex-direction:row-reverse}.dsh-persona-chat-bubble{max-width:calc(100% - 48px);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chat-bg);border:1px solid var(--chat-border);border-radius:3px 12px 12px;padding:9px 12px}.dsh-persona-chat-message[data-user=true]>.dsh-persona-chat-bubble{background:var(--chat-brand);color:#fff;border-color:transparent;border-radius:12px 3px 12px 12px}.dsh-persona-chat-turn-state{font-size:11px;color:var(--chat-muted);text-align:right;margin:-5px 0 14px}.dsh-persona-chat-turn-state button{font-size:11px;padding:2px 8px;min-height:26px;margin-left:8px}
      .dsh-persona-chat-empty{height:100%;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--chat-muted);gap:8px;padding:18px}.dsh-persona-chat-empty strong{font-size:15px;color:var(--chat-text)}.dsh-persona-chat-empty p{margin:0;font-size:12px;max-width:270px}.dsh-persona-chat-compose{flex:none;padding:12px 14px;background:var(--chat-bg);border:0}.dsh-persona-chat-compose textarea{display:block;width:100%;min-height:70px;max-height:140px;resize:vertical;border:0;outline:0;background:transparent;line-height:1.65;padding:2px;color:var(--chat-text)}.dsh-persona-chat-compose-row{margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:10px}.dsh-persona-chat-compose-row small{font-size:10px;color:var(--chat-muted)}.dsh-persona-chat-compose button[data-primary]{background:var(--chat-brand);color:#fff;border-color:transparent;min-width:68px}.dsh-persona-chat-info{flex:none;font-size:11px;color:var(--chat-muted);padding:7px 14px;border-bottom:1px solid var(--chat-border);overflow-wrap:anywhere}.dsh-persona-chat-info button{font-size:11px;min-height:25px;margin-left:6px}
      .dsh-persona-chat-suggest{padding-bottom:8px;margin-bottom:7px;border-bottom:1px solid var(--chat-border)}.dsh-persona-chat-suggest-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px}.dsh-persona-chat-suggest-head label{display:flex;align-items:center;gap:5px}.dsh-persona-chat-suggest-head button{font-size:11px;min-height:28px;padding:3px 8px}.dsh-persona-chat-suggest small{display:block;font-size:10px;color:var(--chat-muted);margin:5px 0}.dsh-persona-chat-suggestions{max-height:155px;overflow:auto;display:grid;gap:5px}.dsh-persona-chat-suggestions button{font-size:12px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chat-soft)}
      @media(max-width:520px){.dsh-persona-chat,.dsh-persona-chat[data-wide=true]{right:8px;bottom:max(8px,env(safe-area-inset-bottom));width:calc(100vw - 16px);height:calc(100dvh - 24px);border-radius:12px}.dsh-persona-chat-top{padding:10px}.dsh-persona-chat-compose-row small{max-width:200px}.dsh-persona-chat-top button{font-size:11px;padding:3px 6px}}
      .dsh-persona-chat{--chat-brand:#4f6cdb}.dsh-persona-chat-top{display:grid;grid-template-columns:36px minmax(0,1fr) repeat(4,auto);gap:9px}.dsh-persona-chat-title{display:contents}.dsh-persona-chat-title strong{grid-column:2;grid-row:1}.dsh-persona-chat-title select{grid-column:1/-1;grid-row:2;width:100%;padding:7px 9px;background:var(--chat-soft);border:1px solid var(--chat-border);border-radius:7px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{grid-column:1;grid-row:1}.dsh-persona-chat-top>button{grid-row:1}
      .dsh-persona-chat-compose textarea{padding:9px 10px;border:1px solid var(--chat-border);border-radius:9px;background:var(--chat-soft);font-size:13px;box-shadow:none}.dsh-persona-chat-compose textarea:focus-visible{outline:none!important;border-color:#7890e8;box-shadow:0 0 0 2px #7185e520}
      .dsh-persona-chat-thread-wrap{position:relative;min-height:0;flex:1;display:flex;overflow:hidden}.dsh-persona-chat-thread{min-width:0;width:100%}
      .dsh-persona-chat-bubble{min-width:0;font-family:inherit;line-height:1.7}.dsh-persona-chat-body{white-space:normal;font:var(--dsw-font-markdown-base,inherit);line-height:1.7;min-width:0;max-width:100%;overflow-wrap:anywhere}.dsh-persona-chat-body>div{margin-block:0}.dsh-persona-chat-body :is(p,ul,ol,blockquote,pre):first-child{margin-top:0}.dsh-persona-chat-body :is(p,ul,ol,blockquote,pre):last-child{margin-bottom:0}.dsh-persona-chat-body pre{max-width:100%;overflow-x:auto}.dsh-persona-chat-body pre code{overflow-wrap:normal;word-break:normal}.dsh-persona-chat-body table{max-width:100%}.dsh-persona-chat-body img{max-width:100%;height:auto}
      .dsh-persona-chat-typing .dsh-persona-chat-bubble{display:flex;align-items:center;gap:1px;min-height:40px;padding:8px 12px;color:var(--chat-muted);background:var(--chat-bg);border-style:dashed;border-radius:3px 12px 12px;font-size:12px}.dsh-persona-chat-typing-dots{display:inline-flex;width:1.8em;font-family:ui-monospace,monospace;overflow:hidden;vertical-align:bottom}.dsh-persona-chat-typing-dots>span{display:inline-block;width:0;overflow:hidden;white-space:nowrap;animation:dsh-persona-chat-ellipsis 1.4s steps(3,end) infinite}
      @keyframes dsh-persona-chat-ellipsis{0%,10%{width:0}80%,100%{width:1.8em}}
      .dsh-persona-chat button.dsh-persona-chat-jump{position:absolute;right:14px;bottom:12px;z-index:1;border-radius:18px;padding:4px 12px;min-height:30px;font-size:11px;box-shadow:0 3px 12px #0002;color:var(--chat-muted);background:var(--chat-bg)}
      @media(prefers-reduced-motion:reduce){.dsh-persona-chat-typing-dots>span{animation:none;width:1.8em}}
      @media(max-width:520px){.dsh-persona-chat-top{gap:7px;grid-template-columns:32px minmax(0,1fr) repeat(4,auto)}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:32px;height:32px}}
      .dsh-persona-chat{--chat-top-safe:max(52px,env(safe-area-inset-top,0px));box-sizing:border-box;right:16px;bottom:max(12px,env(safe-area-inset-bottom,0px));height:min(650px,calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px))));max-height:calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px)));-webkit-app-region:no-drag}
      .dsh-persona-chat[data-wide=true]{width:min(780px,calc(100vw - 32px));height:min(780px,calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px))))}
      .dsh-persona-chat-top{grid-template-columns:28px minmax(0,1fr) auto;gap:6px 8px;min-height:0;padding:9px 12px 8px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:28px;height:28px}.dsh-persona-chat-title{display:block;grid-column:2;grid-row:1;font-size:14px;line-height:28px;min-width:0}.dsh-persona-chat-actions{grid-column:3;grid-row:1;display:flex;align-items:center;gap:4px}.dsh-persona-chat-actions button{min-height:27px;padding:2px 7px;font-size:11px}
      .dsh-persona-chat-context-row{grid-column:1/-1;grid-row:2;display:flex;align-items:center;gap:7px;min-width:0}.dsh-persona-chat-context-row select{flex:1;min-width:0;width:0;max-width:100%;padding:4px 7px;border:1px solid var(--chat-border);background:var(--chat-soft);font-size:12px;line-height:20px;height:29px;border-radius:6px}.dsh-persona-chat-context-row button{flex:none;font-size:11px;min-height:29px;padding:3px 8px;white-space:nowrap}.dsh-persona-chat-sources{max-height:28%;flex:0 1 auto;min-height:0;padding:6px 12px}.dsh-persona-chat-sources>p:first-child{margin-top:0}
      .dsh-persona-chat-thread-wrap{min-height:min(84px,18dvh)}.dsh-persona-chat-thread{padding:12px}.dsh-persona-chat-empty{min-height:0;gap:7px;padding:12px}.dsh-persona-chat-empty strong{font-size:14px}.dsh-persona-chat-empty p{font-size:11px;max-width:240px;line-height:1.65}
      .dsh-persona-chat-compose{padding:8px 12px;min-height:0;max-height:56%;display:flex;flex-direction:column;gap:6px;overflow:auto}.dsh-persona-chat-compose textarea{flex:0 1 auto;height:56px;min-height:48px;max-height:none;resize:none;padding:7px 9px;border-radius:8px;font-size:13px}.dsh-persona-chat[data-compose-expanded=true] .dsh-persona-chat-compose textarea{height:clamp(88px,26dvh,220px);min-height:64px}.dsh-persona-chat-compose-row{flex:none;display:flex;align-items:center;gap:7px;margin-top:0;min-height:29px}.dsh-persona-chat-compose-row>label{display:flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap}.dsh-persona-chat-compose-row input[type=checkbox]{margin:0;accent-color:var(--chat-brand)}.dsh-persona-chat-compose-row small{font-size:10px;color:var(--chat-muted);margin-left:auto;white-space:nowrap}.dsh-persona-chat-compose-row>button{min-height:29px;padding:3px 9px;font-size:12px}.dsh-persona-chat-compose-row button[data-primary]{min-width:56px}.dsh-persona-chat-compose-row .dsh-persona-chat-compose-expand{margin-left:auto;display:grid;place-items:center;width:28px;min-width:28px;padding:4px;background:transparent;border-color:transparent;color:var(--chat-muted)}.dsh-persona-chat-compose-row small+.dsh-persona-chat-compose-expand{margin-left:0}.dsh-persona-chat-compose-expand:hover{background:var(--chat-soft);border-color:var(--chat-border)}.dsh-persona-chat-compose-expand svg{display:block}
      .dsh-persona-chat-suggest{flex:0 1 auto;min-height:0;max-height:150px;overflow:auto;padding-bottom:6px;margin:0;border-bottom:1px solid var(--chat-border)}.dsh-persona-chat-suggest-head{font-size:11px;color:var(--chat-muted)}.dsh-persona-chat-suggest-head>small{margin:0;flex:1}.dsh-persona-chat-suggest-head>button{flex:none}.dsh-persona-chat-suggestions{max-height:110px}.dsh-persona-chat-appearance{top:80px;max-height:calc(100% - 94px)}
      @media(max-width:520px){.dsh-persona-chat,.dsh-persona-chat[data-wide=true]{right:8px;bottom:max(8px,env(safe-area-inset-bottom,0px));width:calc(100vw - 16px);height:calc(100dvh - var(--chat-top-safe) - max(8px,env(safe-area-inset-bottom,0px)));max-height:calc(100dvh - var(--chat-top-safe) - max(8px,env(safe-area-inset-bottom,0px)))}.dsh-persona-chat-top{grid-template-columns:28px minmax(0,1fr) auto;padding:8px 10px 7px;gap:5px 7px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:28px;height:28px}.dsh-persona-chat-actions{gap:3px}.dsh-persona-chat-actions button{padding:2px 6px}.dsh-persona-chat-compose{padding:7px 10px}}
      @media(max-width:420px){.dsh-persona-chat-compose-row small{display:none}.dsh-persona-chat-compose-row button.dsh-persona-chat-compose-expand{margin-left:auto}}
    `;
    const CHAT_APPEARANCE_CSS = '.dsh-persona-chat-appearance{position:absolute;z-index:2;top:84px;right:12px;width:calc(100% - 24px);max-height:calc(100% - 96px);overflow:auto;padding:14px;border:1px solid var(--chat-border);border-radius:12px;background:var(--chat-bg);box-shadow:0 12px 32px #0003}';
    const ROOM_CHAT_CSS = `
      .dsh-persona-chat-dock{--chat-bg:var(--dsw-alias-bg-layer-1,#fff);--chat-border:var(--dsw-alias-border-l1,#d6dfe9);--chat-soft:var(--dsw-alias-bg-layer-2,#f3f5f8);--chat-muted:var(--dsw-alias-label-secondary,#65758a);--chat-text:var(--dsw-alias-label-primary,#203044);--chat-brand:var(--dsw-alias-brand-primary,#3976c3);position:fixed;z-index:1100;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:2px;max-width:calc(100vw - 32px);padding:3px 4px 3px 3px;border:1px solid var(--chat-border);border-radius:18px;background:var(--chat-bg);box-shadow:0 3px 16px #0002;color:var(--chat-text);font:12px/1.35 system-ui,sans-serif}
      .dsh-persona-chat-dock button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:2px 6px;border:0;border-radius:12px;background:transparent;color:inherit;cursor:pointer;font:inherit}.dsh-persona-chat-dock button:hover{background:var(--chat-soft)}.dsh-persona-chat-dock button:focus-visible{outline:2px solid var(--chat-brand);outline-offset:1px}.dsh-persona-chat-dock button:first-of-type{padding-left:2px;min-height:36px}.dsh-persona-chat-dock button:last-of-type{color:var(--chat-muted);width:24px;height:28px;font-size:16px}.dsh-persona-chat-dock .dsh-persona-room-avatar{width:30px;height:30px}
      .dsh-persona-chat-dock-count{min-width:16px;box-sizing:border-box;padding:2px 4px;border-radius:10px;text-align:center;background:var(--chat-brand);color:#fff;font:600 10px/1.2 system-ui,sans-serif;font-variant-numeric:tabular-nums}.dsh-persona-chat-dock-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @keyframes dsh-persona-chat-arrived{0%,100%{transform:scale(1)}45%{transform:scale(1.22)}}@media(prefers-reduced-motion:no-preference){.dsh-persona-chat-dock-count{animation:dsh-persona-chat-arrived .52s ease-out 2}}
      @media(max-width:380px){
        .dsh-persona-chat .dsh-persona-chat-top[data-room=true]{grid-template-columns:40px minmax(0,1fr) repeat(3,30px);gap:2px 4px}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-room-avatar-display{grid-column:1;grid-row:1/span 2}
        .dsh-persona-chat-top[data-room=true] :is(.dsh-persona-chat-room-heading,.dsh-persona-chat-actions){display:contents}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-title{grid-column:2;grid-row:1}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-tools{grid-column:2;grid-row:2}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button{padding:1px;min-height:24px;font-size:11px;grid-row:1}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button:nth-child(-n+2){grid-row:2;min-height:20px;border:none;color:var(--chat-muted)}
        .dsh-persona-chat-actions button:nth-child(3){grid-column:3}.dsh-persona-chat-actions button:is(:nth-child(1),:nth-child(4)){grid-column:4}.dsh-persona-chat-actions button:is(:nth-child(2),:nth-child(5)){grid-column:5}
      }
      .dsh-persona-chat-top[data-room=true]{grid-template-columns:44px minmax(0,1fr) auto}.dsh-persona-chat-room-heading{grid-column:2;grid-row:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dsh-persona-chat-room-title{display:flex;align-items:center;gap:5px;min-width:0;min-height:20px!important;border:0!important;background:transparent!important;padding:0!important;text-align:left;font-weight:600;font-size:13px!important;line-height:20px}.dsh-persona-chat-room-title>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-persona-chat-room-title>span:last-child{font-size:10px;color:var(--chat-muted)}.dsh-persona-room-avatar-display{grid-column:1;grid-row:1;align-self:center}.dsh-persona-chat-room-tools{display:flex;align-items:center;gap:10px;min-width:0}.dsh-persona-chat-room-tools button{border:0;min-height:20px;padding:0;font-size:10px;background:transparent;white-space:nowrap;color:var(--chat-muted)}.dsh-persona-chat-room-tools button:hover{color:var(--chat-brand)}.dsh-persona-chat-room-tools button[aria-expanded=true]{color:var(--chat-brand)}.dsh-persona-chat-room-heading+.dsh-persona-chat-actions{align-self:start}
      .dsh-persona-room-avatar{--room-avatar-letter:9px;position:relative;display:block;width:44px;height:44px;flex:none;isolation:isolate}.dsh-persona-room-avatar-tile{position:absolute;display:block;border:1px solid var(--chat-bg);border-radius:24%;background:var(--chat-bg);transform:translate(-50%,-50%) rotate(var(--tile-angle,0deg));transform-origin:center;box-shadow:0 1px 0 var(--chat-border),0 2px 4px #0002}.dsh-persona-room-avatar-tile::after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(135deg,#ffffff0c,transparent 55%);pointer-events:none}.dsh-persona-room-avatar[data-count='1']{--room-avatar-letter:12px}.dsh-persona-room-avatar[data-count='2']{--room-avatar-letter:10px}.dsh-persona-room-avatar-more{display:grid;place-items:center;color:var(--chat-muted);background:var(--chat-soft);font-size:var(--room-avatar-letter);line-height:1;font-weight:600}.dsh-persona-chat-empty>.dsh-persona-room-avatar{--room-avatar-letter:12px;width:64px;height:64px;margin-bottom:5px}.dsh-persona-chat-mentions{display:block;font-size:9px;line-height:1.4;opacity:.72;margin-bottom:3px;font-weight:400}
      .dsh-persona-chat-participants{min-width:0;flex:none;container-type:inline-size}
      .dsh-persona-chat-recipient{display:flex;flex-wrap:wrap;align-items:center;gap:2px 5px;min-width:0;padding:2px}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:142px;min-height:30px;padding:3px 7px 3px 4px;border:0;border-radius:9px;background:transparent;font:inherit;font-size:11px;line-height:18px;color:var(--chat-muted);text-align:start}
      .dsh-persona-chat-recipient-option>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-persona-chat-recipient-portrait{position:relative;display:inline-flex;flex:none}
      .dsh-persona-chat-recipient-option .dsh-persona-chat-avatar{width:22px;height:22px;border-radius:7px;font-size:9px}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option[aria-checked=true]{background:color-mix(in srgb,var(--chat-brand) 12%,var(--chat-bg));color:var(--chat-text);font-weight:600}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait::after{content:'✓';position:absolute;right:-2px;bottom:-1px;display:grid;place-items:center;width:11px;height:11px;border:1px solid var(--chat-bg);border-radius:50%;background:var(--chat-brand);color:white;font:bold 8px/1 system-ui}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait[data-order]::after{content:attr(data-order)}
      .dsh-persona-chat-recipient-option:not(:disabled):hover{background:var(--chat-soft)}
      @container(max-width:620px){.dsh-persona-chat-recipient[data-crowded=true]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.dsh-persona-chat-recipient[data-crowded=true]>button{max-width:100%}}
      @container(max-width:335px){.dsh-persona-chat-recipient[data-crowded=true]{grid-template-columns:repeat(3,minmax(0,1fr))}}
      .dsh-persona-chat-room-panel{position:absolute;z-index:5;inset:84px 10px auto;max-height:calc(100% - 98px);overflow:auto;padding:12px;border:1px solid var(--chat-border);border-radius:11px;background:var(--chat-bg);box-shadow:0 12px 35px #0003;font-size:12px}.dsh-persona-chat-room-panel header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.dsh-persona-chat-room-panel header button{min-height:25px;padding:2px 7px;font-size:11px}.dsh-persona-chat-room-panel p{font-size:11px;color:var(--chat-muted);line-height:1.7}.dsh-persona-chat-room-panel input[type=text]{box-sizing:border-box;width:100%;padding:7px 9px;margin:6px 0 10px;border:1px solid var(--chat-border);border-radius:7px;background:var(--chat-soft);font:inherit;color:inherit}.dsh-persona-chat-room-list{display:grid;gap:5px}.dsh-persona-chat-room-list>button{display:flex;align-items:center;gap:9px;width:100%;text-align:left}.dsh-persona-chat-room-list>button[aria-pressed=true]{border-color:var(--chat-brand);background:var(--chat-soft)}.dsh-persona-chat-room-list>button>span:last-child{min-width:0;display:grid;gap:2px}.dsh-persona-chat-room-list strong{font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dsh-persona-chat-room-list small{font-size:10px;color:var(--chat-muted)}.dsh-persona-chat-room-buttons{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.dsh-persona-chat-room-buttons button{font-size:12px;min-height:29px}
      .dsh-persona-chat-room-members{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:8px 0}.dsh-persona-chat-room-members label{display:flex;align-items:center;gap:6px;min-width:0;padding:6px;border:1px solid var(--chat-border);border-radius:7px}.dsh-persona-chat-room-members label>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-persona-chat-room-members .dsh-persona-chat-avatar{width:26px;height:26px;font-size:10px}.dsh-persona-chat-speaker{display:block;font-size:10px;line-height:1.5;color:var(--chat-muted);margin-bottom:3px}.dsh-persona-chat-message[data-user=true] .dsh-persona-chat-speaker{color:inherit;opacity:.8}.dsh-persona-chat-room-loading{padding:24px;display:grid;gap:10px;font-size:12px}
    `;
    function PersonaAvatar({ src, name = '角色', id, fallback = true, className = '', style }) {
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => setFailed(false), [src]);
      const safe = typeof src === 'string' && (src.startsWith(ROUTE + '/avatar/') || src.startsWith(ROUTE + '/chat-profile/avatar?'));
      if ((!safe || failed) && !fallback) return null;
      const defaults = { '大肥鱼（默认）': '鲸', '大肥龙': '龙', 'Claude小姐': 'C', '鲸鲸（实验性）': '鱼', Gemini: '猫' };
      const catPortrait = safe && src.endsWith('&frame=cat-portrait');
      const initials = Object.hasOwn(defaults, id) ? defaults[id]
        : (/^[a-z]/i.test(name) ? name.slice(0, 2).toUpperCase() : Array.from(name).slice(0, 2).join(''));
      return h('span', { className, role: 'img', 'aria-label': name + '头像', style: { overflow: 'hidden', ...style } },
        safe && !failed ? h('img', { src, alt: '', draggable: false, referrerPolicy: 'no-referrer',
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit',
            ...(catPortrait ? { objectPosition: 'center 7%', transform: 'scale(2.15)', transformOrigin: 'center top' } : {}) }, onError: () => setFailed(true) }) : initials);
    }
    // Only the official display-safe account projection is read. No account
    // identity, address or credential is kept in plugin storage or model input.
    function createAccountAvatarSource() {
      const subscribers = new Set(), timers = new Map();
      let remote, metadata, url = null, generation = 0, stream;
      const publish = (next) => { url = next; for (const fn of subscribers) fn(); };
      const deadline = (promise) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { timers.delete(timer); reject(Error('account-timeout')); }, 5000);
        timers.set(timer, () => { clearTimeout(timer); reject(Error('account-stopped')); });
        Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timer); timers.delete(timer); });
      });
      const stop = () => {
        generation++; const current = stream; stream = undefined;
        try { Promise.resolve(current?.dispose()).catch(() => {}); } catch { /* Optional account service. */ }
        for (const cancel of timers.values()) cancel(); timers.clear(); publish(null);
      };
      const profile = async (token) => {
        try {
          const result = await deadline(remote.account.getProfile(metadata()));
          if (token !== generation || !subscribers.size) return;
          const raw = result?.ok && result.value?.status === 'ready' ? result.value.value?.avatarUrl : null;
          let safe = null;
          if (typeof raw === 'string' && raw.length <= 4096) {
            try { const parsed = new URL(raw); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) safe = parsed.href; } catch { /* Hide invalid addresses. */ }
          }
          publish(safe);
        } catch { if (token === generation) publish(null); }
      };
      const refresh = async () => {
        if (!remote?.account || !subscribers.size) return;
        const token = ++generation; publish(null);
        try {
          const state = await deadline(remote.account.getState());
          if (token !== generation || !subscribers.size) return;
          if (state?.ok && state.value?.status === 'credential-stored') await profile(token);
        } catch { if (token === generation) publish(null); }
      };
      const start = () => {
        if (!remote?.account || !subscribers.size) return;
        if (typeof remote.$stream !== 'function' || typeof remote.account.watch !== 'function') { void refresh(); return; }
        try {
          const opened = remote.$stream({ name: 'persona-shell.account-avatar', open: (signal) => remote.account.watch(signal),
            ended: () => Error('account-stream-ended') }); stream = opened;
          void (async () => {
            for await (const frame of opened) {
              if (stream !== opened) return;
              const token = ++generation; publish(null); frame.accept();
              if (frame.value?.status === 'credential-stored') void profile(token);
            }
          })().catch(() => { if (stream === opened) { generation++; publish(null); } });
        } catch { void refresh(); }
      };
      return {
        read: () => url, refresh,
        subscribe(fn) { subscribers.add(fn); if (subscribers.size === 1) start(); return () => { subscribers.delete(fn); if (!subscribers.size) stop(); }; },
        bind(value, clientMetadata) { stop(); remote = value; metadata = clientMetadata; start(); return () => { if (remote === value) { stop(); remote = undefined; } }; },
      };
    }
    const accountAvatarSource = createAccountAvatarSource();
    function useAccountAvatar(enabled) {
      const [url, setUrl] = React.useState(null);
      React.useEffect(() => {
        if (!enabled) { setUrl(null); return; }
        const update = () => setUrl(accountAvatarSource.read());
        const unsubscribe = accountAvatarSource.subscribe(update); update();
        const focus = () => { void accountAvatarSource.refresh(); };
        window.addEventListener?.('focus', focus);
        return () => { unsubscribe(); window.removeEventListener?.('focus', focus); };
      }, [enabled]);
      return enabled ? url : null;
    }
    const userAvatarMode = (profile) => profile?.avatarMode ?? (profile?.avatar ? 'custom' : 'account');
    function UserChatAvatar({ profile, accountUrl, className }) {
      const mode = userAvatarMode(profile);
      const src = mode === 'account' ? accountUrl : mode === 'custom' ? profile?.avatar : null;
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => setFailed(false), [src]);
      const safe = typeof src === 'string' && (mode === 'account' ? /^https:\/\//.test(src) : src.startsWith(ROUTE + '/chat-profile/avatar?'));
      if (!safe || failed) return null;
      return h('span', { className, role: 'img', 'aria-label': '你的头像', style: { overflow: 'hidden' } },
        h('img', { src, alt: '', draggable: false, referrerPolicy: 'no-referrer', onError: () => setFailed(true),
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' } }));
    }
    function PersonaChatLauncher({ sessionId, conversation } = {}) {
      const [open, setOpen] = React.useState(false);
      const [error,setError]=React.useState('');
      React.useEffect(() => {
        const update = () => setOpen(chatRuntime.opened&&!chatRuntime.minimized);
        chatLaunchListeners.add(update);
        update(); return () => chatLaunchListeners.delete(update);
      }, []);
      React.useEffect(()=>{if(sessionId)chatRuntime.foreground(sessionId);},[sessionId]);
      return h(React.Fragment, null,
        h('button', { type: 'button', style: headerButtonStyle, 'aria-haspopup': 'dialog', 'aria-expanded':open, title:error||'打开聊天室', onClick: () => {
          try {chatRuntime.open(sessionId,conversation);setError('');}catch(e){setError(e.message);}
        } }, '聊天室'));
    }
    function useChatContext(sessionId,roomId,paused) {
      const [value,setValue]=React.useState(()=>chatContextCache?.roomId===roomId?chatContextCache:undefined),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
      const state=React.useRef({live:false,request:0,sequence:0,viewer:chatNonce(),abort:null,busy:false,value});
      state.current.value=value;
      const accept=next=>{chatContextCache=next;setValue(next);};
      const action=async(body,quiet=false)=>{
        const own=state.current;if(!own.live||(own.busy&&!quiet))return;
        const token=++own.request;if(!quiet){own.busy=token;setBusy(true);}own.abort?.abort();const abort=new AbortController();own.abort=abort;
        try{
          const response=await fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
            body:JSON.stringify({...body,roomId,viewer:own.viewer,sequence:++own.sequence,revision:own.value?.revision})});
          const next=await response.json();if(!own.live||token!==own.request)return;
          if(!response.ok){if(next.state?.initialized)accept(next.state);throw Error(next.error);}
          if(body.action!=='sessions')accept(next);setError('');return next;
        }catch(e){if(own.live&&token===own.request&&!abort.signal.aborted)setError(e.message==='context-capacity'
          ?'最多同时接入 6 个会话，请先移除不需要的来源。':e.message==='chat-context-changed'
            ?'参考来源已在其他窗口更新，请核对当前列表后再操作。':'参考信息暂未更新，已有来源保留，可以重试。');}
        finally{if(!quiet&&own.busy===token){own.busy=false;if(own.live)setBusy(false);}}
      };
      React.useEffect(()=>{
        if(paused)return;
        const own=state.current;own.live=true;own.busy=false;setBusy(false);let timer,active=true;
        const loop=async()=>{
          clearTimeout(timer);if(!own.live||document.visibilityState==='hidden')return;
          if(!own.busy){
            if(!own.value?.initialized)await action({action:'open',sessionId,visible:true},true);
            else{
              const token=++own.request;const abort=new AbortController();own.abort?.abort();own.abort=abort;
              try{const r=await fetch(ROUTE+'/chat-context?'+new URLSearchParams({...(roomId?{room:roomId}:{}),viewer:own.viewer,sequence:String(++own.sequence)}),{signal:abort.signal});
                const next=await r.json();if(own.live&&token===own.request){if(r.ok){accept(next);setError('');}else{chatContextCache=undefined;own.value=undefined;setError('参考服务需要重新连接，正在重试。');}}}catch{if(own.live&&!abort.signal.aborted)setError('参考信息暂未更新，已有来源保留。');}
            }
          }
          if(active&&document.visibilityState!=='hidden')timer=setTimeout(loop,15000);
        };
        const presence=()=>{
          clearTimeout(timer);own.abort?.abort();
          if(document.visibilityState==='hidden')void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'presence',roomId,viewer:own.viewer,sequence:++own.sequence,visible:false})}).catch(()=>{});
          else void action({action:'open',sessionId,visible:true},true).then(()=>{if(active)timer=setTimeout(loop,15000);});
        };
        void action({action:'open',sessionId,visible:document.visibilityState!=='hidden'},true).then(()=>{if(active&&document.visibilityState!=='hidden')timer=setTimeout(loop,15000);});
        document.addEventListener('visibilitychange',presence);
        return()=>{active=false;own.live=false;own.request++;own.abort?.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',presence);
          if(chatContextCache?.roomId===roomId)chatContextCache=undefined;
          void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,
            body:JSON.stringify({action:'presence',roomId,viewer:own.viewer,sequence:++own.sequence,visible:false})}).catch(()=>{});};
      },[paused]);
      return{value,error,busy,action};
    }
    const roomLiveConnections=new Map();
    function subscribeRoomLive(roomId,instance,attempt,listener) {
      const key=JSON.stringify([roomId,instance]);let own=roomLiveConnections.get(key);
      if(!own){
        own={listeners:new Map(),abort:null,generation:0,connected:false,frames:[],live:true,timer:null,delay:750};roomLiveConnections.set(key,own);
        const emit=()=>{for(const update of own.listeners.keys())update(own.frames,own.connected);};
        const needed=()=>[...own.listeners.values()].some(id=>!own.frames.some(f=>f.attemptId===id&&['ready','failed','cancelled'].includes(f.status)));
        own.start=async()=>{
          if(!own.live||own.abort||own.timer!==null||!needed()||document.visibilityState==='hidden')return;
          const token=++own.generation,abort=new AbortController();own.abort=abort;
          try{
            const response=await fetch(ROUTE+'/chat/live?'+new URLSearchParams({room:roomId,batch:'1'}),{signal:abort.signal});
            if(!response.ok||!response.body?.getReader)throw Error('stream-unavailable');
            if(!own.live||token!==own.generation){abort.abort();return;}own.connected=true;emit();
            const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
            try{while(own.live&&token===own.generation&&!abort.signal.aborted){const chunk=await reader.read();if(chunk.done||!own.live||token!==own.generation||abort.signal.aborted)break;
              buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>262144)throw Error('stream-too-large');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event.startsWith('data:'))continue;
                const value=JSON.parse(event.slice(5));if(value.instanceId!==instance||value.roomId!==roomId||!Array.isArray(value.frames)||value.frames.length>8)continue;
                own.frames=value.frames;if(value.status==='streaming')own.delay=750;emit();if(value.status!=='streaming')return;
              }
            }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch{/* Canonical snapshot polling remains available. */}
          finally{if(own.live&&token===own.generation){own.abort=null;own.connected=false;emit();
            if(needed()&&document.visibilityState!=='hidden'){
              own.timer=setTimeout(()=>{own.timer=null;void own.start();},own.delay);own.delay=Math.min(8000,own.delay*2);
            }}}
        };
        own.visibility=()=>{own.generation++;clearTimeout(own.timer);own.timer=null;own.abort?.abort();own.abort=null;own.connected=false;own.delay=750;emit();if(document.visibilityState!=='hidden')void own.start();};
        document.addEventListener('visibilitychange',own.visibility);
      }
      own.listeners.set(listener,attempt);listener(own.frames,own.connected);void own.start();
      return()=>{own.listeners.delete(listener);if(!own.listeners.size){own.live=false;own.generation++;clearTimeout(own.timer);own.abort?.abort();
        document.removeEventListener('visibilitychange',own.visibility);roomLiveConnections.delete(key);}};
    }
    function useChatLive(personaId,turn,instance,onFinish,roomId) {
      const [frame,setFrame]=React.useState(null),[connected,setConnected]=React.useState(false);
      const finish=React.useRef(onFinish);finish.current=onFinish;
      const attempt=turn?.status==='pending'?turn.attemptId:undefined;
      React.useEffect(()=>{
        if(!attempt){setConnected(false);return;}
        let live=true,abort,generation=0;setFrame(null);
        if(roomId){let finished=false;const stop=subscribeRoomLive(roomId,instance,attempt,(frames,online)=>{
          if(!live)return;setConnected(online);const value=frames.find(f=>f.attemptId===attempt&&f.personaId===personaId);
          if(!value||value.instanceId!==instance||value.roomId!==roomId||!['queued','streaming','ready','failed','cancelled'].includes(value.status)
            ||!Array.isArray(value.messages)||value.messages.length>6||value.messages.some(m=>typeof m.text!=='string'||m.text.length>2000||typeof m.complete!=='boolean'))return;
          setFrame(previous=>previous?.attemptId===attempt&&previous.revision>value.revision?previous:value);
          if(!['streaming','queued'].includes(value.status)&&!finished){finished=true;finish.current?.();}
        });return()=>{live=false;stop();};}
        let retryTimer,delay=750,terminal=false;
        const start=async()=>{
          if(document.visibilityState==='hidden')return;
          const token=++generation,controller=new AbortController();abort=controller;
          try{
            const response=await fetch(ROUTE+'/chat/live?'+new URLSearchParams({persona:personaId,attempt,...(roomId?{room:roomId}:{})}),{signal:controller.signal});
            if(!response.ok||!response.body?.getReader)throw Error('stream-unavailable');
            if(!live||token!==generation){controller.abort();return;}setConnected(true);
            const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
            try{while(live&&token===generation&&!controller.signal.aborted){const chunk=await reader.read();if(chunk.done||!live||token!==generation)break;buffer+=decoder.decode(chunk.value,{stream:true});
              if(buffer.length>65536)throw Error('stream-too-large');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event.startsWith('data:'))continue;
                const value=JSON.parse(event.slice(5));if(value.instanceId!==instance||value.personaId!==personaId||value.attemptId!==attempt||(roomId&&value.roomId!==roomId))continue;
                if(!['streaming','ready','failed','cancelled','closed'].includes(value.status)||!Array.isArray(value.messages)||value.messages.length>6
                  ||value.messages.some(m=>typeof m.text!=='string'||m.text.length>2000||typeof m.complete!=='boolean'))continue;
                if(live)setFrame(previous=>previous?.attemptId===attempt&&previous.revision>value.revision?previous:value);
                if(value.status!=='streaming'){terminal=value.status!=='closed';if(live)finish.current?.();return;}
                delay=750;
              }
            }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch{/* The canonical snapshot poller remains the compatibility fallback. */}
          finally{if(live&&token===generation){setConnected(false);if(!terminal&&document.visibilityState!=='hidden'){
            retryTimer=setTimeout(start,delay);delay=Math.min(8000,delay*2);
          }}}
        };
        const visibility=()=>{generation++;clearTimeout(retryTimer);abort?.abort();delay=750;setConnected(false);if(!terminal&&document.visibilityState!=='hidden')void start();};
        void start();document.addEventListener('visibilitychange',visibility);
        return()=>{live=false;generation++;clearTimeout(retryTimer);abort?.abort();document.removeEventListener('visibilitychange',visibility);};
      },[personaId,attempt,instance,roomId]);
      return {frame,connected};
    }
    function ChatReplyBubbles({turn,frame,avatar,onProgress,onPresented,latest=true,running=false,showSpeaker=false}) {
      const animate=latest&&(chatAnimatedAttempts.has(turn.attemptId)||turn.status==='pending');
      const messages=turn.status==='ready'?turn.assistant.map(text=>({text,complete:true}))
        :turn.status==='pending'&&frame?.attemptId===turn.attemptId?frame.messages??[]:[];
      const [count,setCount]=React.useState(()=>animate?1:messages.length);
      const visible=animate?messages.slice(0,count):messages;
      const waiting = (turn.status === 'pending' && running) || (turn.status === 'ready' && animate && count < messages.length);
      const typing = waiting && (!visible.at(-1)?.text || visible.at(-1).complete);
      React.useEffect(()=>{
        if(!animate)return;
        if(turn.status==='pending')markChatAnimation(turn.attemptId);
        if(turn.status!=='pending'&&turn.status!=='ready'){chatAnimatedAttempts.delete(turn.attemptId);return;}
        if(count>=messages.length){if(turn.status==='ready'){chatAnimatedAttempts.delete(turn.attemptId);onPresented?.(turn);}return;}
        if(count===0){setCount(1);return;}
        if(!messages[count-1]?.complete)return;
        const wait=Math.min(1250,650+messages[count-1].text.length*12);
        const timer=setTimeout(()=>setCount(n=>n+1),wait);return()=>clearTimeout(timer);
      },[turn.attemptId,turn.status,count,messages.length,messages[Math.max(0,count-1)]?.complete,animate]);
      useLayoutEffect(()=>{onProgress?.();},[count,typing,visible.map(m=>m.text).join('\n')]);
      return h(React.Fragment,null,...visible.filter(m=>m.text).map((message,n)=>h('div',{key:n,className:'dsh-persona-chat-message','data-user':'false',
        'data-provisional':turn.status==='pending'},avatar(),h('div',{className:'dsh-persona-chat-bubble','data-live':!message.complete},
          showSpeaker?h('small',{className:'dsh-persona-chat-speaker'},turn.speakerName):null,
          h('div',{className:'dsh-persona-chat-body'},renderMarkdown(message.text,turn.status==='pending'&&!message.complete,{margin:0}))))),
        typing ? h('div', { key:visible.length, className:'dsh-persona-chat-message dsh-persona-chat-typing', 'data-user':'false',
          role:'status','aria-label':turn.status==='pending'?'角色输入中':'还有后续消息','aria-live':'polite','aria-atomic':true }, avatar(),
          h('div',{className:'dsh-persona-chat-bubble'},turn.status==='pending'?'输入中':'',h('span',{className:'dsh-persona-chat-typing-dots','aria-hidden':true},h('span',null,'...')))) : null);
    }
    function ChatExpandIcon({ expanded }) {
      return h('svg', { width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,
        strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false },
        h('path', { d:expanded ? 'M20 4l-6 6M14 4v6h6M4 20l6-6M4 14h6v6' : 'M14 4h6v6M20 4l-6 6M10 20H4v-6M4 20l6-6' }));
    }
    function ChatTurnReply({turn,instance,roomId,running,started,onFinish,held,...props}) {
      const live=useChatLive(turn.recipientId,turn,instance,onFinish,roomId);
      return held?null:h(ChatReplyBubbles,{...props,turn,running:running&&(live.frame?live.frame.status==='streaming':started),frame:live.frame});
    }
    function RoomAvatar({ memberIds = [], contacts = [] }) {
      const count=memberIds.length,visible=memberIds.slice(0,count>4?3:4);
      const layout=count===1?[[50,50,82,0]]:count===2?[[32,32,64,-2],[68,68,64,2]]
        :count===3?[[27,27,55,-2],[73,27,55,2],[50,73,55,0]]:[[25,25,46,0],[75,25,46,0],[25,75,46,0],[75,75,46,0]];
      const position=index=>{const [left,top,size,angle]=layout[index];return{left:left+'%',top:top+'%',width:size+'%',height:size+'%',
        '--tile-angle':angle+'deg',zIndex:index+1};};
      const names=memberIds.map(id=>contacts.find(p=>p.id===id)?.name??'已移除的人格');
      return h('span',{className:'dsh-persona-room-avatar','data-count':String(count),'data-visible-count':String(visible.length),role:'img',
        'aria-label':count?'聊天室成员：'+names.join('、')+'，共 '+count+' 位':'暂无成员的聊天室'},
        ...visible.map((id,index)=>{const person=contacts.find(p=>p.id===id);return h('span',{key:id,'aria-hidden':true,
          className:'dsh-persona-room-avatar-tile',style:position(index)},h(PersonaAvatar,{id,name:person?.name??'角色',src:person?.avatar,
            style:{display:'grid',placeItems:'center',width:'100%',height:'100%',borderRadius:'inherit',background:'var(--chat-soft)',
              color:'var(--chat-text)',fontSize:'var(--room-avatar-letter)'}}));}),
        count>4?h('span',{className:'dsh-persona-room-avatar-tile dsh-persona-room-avatar-more','aria-hidden':true,style:position(3)},'+'+(count-3)):null);
    }
    function RoomRecipient({ contacts, memberIds, value, disabled, onChange }) {
      const root=React.useRef(null);
      if(memberIds.length<2)return null;
      const targets=value.filter(id=>memberIds.includes(id)&&contacts.some(p=>p.id===id&&!p.archived));
      return h('div',{className:'dsh-persona-chat-recipient',ref:root,role:'group','aria-label':'回复对象','aria-description':'已选 '+targets.length+' 位，最多两位主讲','data-crowded':memberIds.length>4,title:'每条消息可 @ 一至两位主讲，其他成员可以接话',onKeyDown:e=>{
        if(disabled||!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
        e.preventDefault();const options=[...root.current.querySelectorAll('[role=checkbox]:not(:disabled)')];
        if(!options.length)return;const index=options.indexOf(document.activeElement);
        const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+options.length)%options.length;
        options[next].focus({preventScroll:true});
      }},
        ...memberIds.map(id=>{const person=contacts.find(p=>p.id===id),selected=targets.includes(id),atLimit=!selected&&targets.length>=2;
        const order=selected&&targets.length>1?targets.indexOf(id)+1:undefined;
        const hint=person?.archived?'这位角色已移除':atLimit?'已选两位主讲；先取消一位即可换人。未点名的成员仍可接话。':selected?targets.length===1?'至少保留一位主讲':'第 '+order+' 位主讲，点击取消 @'+person.name:'同时 @'+(person?.name??'角色');
        return h('button',{
        key:id,type:'button',role:'checkbox',className:'dsh-persona-chat-recipient-option','aria-label':person?.name??'已移除的人格',
        'aria-checked':selected,'aria-disabled':atLimit||undefined,'aria-description':hint,disabled:disabled||!person||person.archived,
        title:(person?.name??'已移除的人格')+' · '+hint,onClick:()=>{if(atLimit)return;const next=selected?targets.filter(p=>p!==id):[...targets,id];if(next.length)void onChange(next);}},
        h('span',{className:'dsh-persona-chat-recipient-portrait','data-order':order},h(PersonaAvatar,{id,name:person?.name??'已移除的人格',src:person?.avatar,className:'dsh-persona-chat-avatar'})),
        h('span',null,((id==='大肥鱼（默认）'&&person?.name==='大肥鱼（默认）')?'大肥鱼':(id==='鲸鲸（实验性）'&&person?.name==='小肥鱼（实验性）')?'小肥鱼':person?.name??'已移除的人格')+(person?.archived?'（已移除）':'')));}));
    }
    function RoomChatWorkspace({sessionId,conversation,onClose}) {
      const [data,setData]=React.useState(null),[roomId,setRoomId]=React.useState(null),[panel,setPanel]=React.useState(null);
      const [notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[name,setName]=React.useState(''),[members,setMembers]=React.useState([]),[deleting,setDeleting]=React.useState(false);
      const lifetime=React.useRef({live:true,sequence:0,busy:false,readAbort:null,needsFirstRoom:true}),selected=React.useRef(null),creation=React.useRef(chatNonce()),editVersion=React.useRef(0);
      const draftMembersEdited=React.useRef(false);
      const accept=value=>{setData(value);selected.current=value.room?.id??null;if(selected.current)lifetime.current.needsFirstRoom=false;setRoomId(selected.current);};
      const readChat=async(signal)=>{
        const query=new URLSearchParams(),foreground=chatForegroundSession??sessionId;
        if(selected.current)query.set('room',selected.current);if(foreground)query.set('session',foreground);
        const response=await fetch(ROUTE+'/chat?'+query,{signal}),value=await response.json();
        if(!response.ok)throw Error(value.error);return value;
      };
      const request=async(body)=>{const response=await fetch(ROUTE+'/chat-rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{state:value.state});return value;};
      const load=async(createDefault=false)=>{
        const own=lifetime.current,token=++own.sequence;setNotice('');
        own.readAbort?.abort();const abort=new AbortController();own.readAbort=abort;
        try{let value=await readChat(abort.signal);
          if(!own.live||token!==own.sequence)return;
          if(value.chatSchema!==3||value.discussionVersion!==2){accept(value);setNotice('聊天室后台需要重新加载，请完整退出并重新打开 DSH。');return;}
          if(!value.room&&createDefault&&value.ready){const id=value.reportPersonaId??value.defaultPersonaId,person=value.contacts.find(p=>p.id===id&&!p.archived);
            if(person)value=await request({action:'ensure-first',requestId:creation.current,name:('与'+person.name+'的聊天').slice(0,60),memberIds:[id],targetPersonaId:id,epoch:value.epoch});}
          if(own.live&&token===own.sequence)accept(value);
        }catch(error){if(own.live&&token===own.sequence&&!abort.signal.aborted)setNotice(chatErrorText(error.message));}
      };
      React.useEffect(()=>{lifetime.current.live=true;void load(true);return()=>{lifetime.current.live=false;lifetime.current.sequence++;lifetime.current.readAbort?.abort();};},[]);
      const change=async(body)=>{
        const own=lifetime.current;if(own.busy)return;own.busy=true;setBusy(true);setNotice('');const token=++own.sequence;
        try{const value=await request({...body,epoch:data.epoch});if(!own.live||token!==own.sequence)return;
          accept(value);setPanel(value.room?null:'rooms');setDeleting(false);return true;
        }catch(error){if(own.live&&token===own.sequence){if(error.state?.room?.id===selected.current)setData(error.state);
          setNotice(error.message==='chat-conflict'?'聊天室资料已变化，草稿保留。请重新载入成员核对后保存。':chatErrorText(error.message));}return false;
        }finally{own.busy=false;if(own.live)setBusy(false);}
      };
      const openCreate=()=>{creation.current=chatNonce();let number=1;while(data?.rooms?.some(r=>r.name==='新聊天室 '+number))number++;
        setName('新聊天室 '+number);draftMembersEdited.current=false;setMembers([]);setPanel('create');setDeleting(false);setNotice('');};
      React.useEffect(()=>{
        if(panel!=='create')return;
        // Read the foreground work persona when starting this draft. Room snapshots normally describe the fixed source.
        const abort=new AbortController();
        void readChat(abort.signal).then(value=>{
          if(abort.signal.aborted)return;
          const id=value.reportPersonaId??value.defaultPersonaId;
          if(!value.ready||!value.contacts.some(p=>p.id===id&&!p.archived))throw Error('persona-unavailable');
          setData(previous=>previous?{...previous,contacts:value.contacts}:previous);
          if(!draftMembersEdited.current)setMembers([id]);
        }).catch(()=>{if(!abort.signal.aborted&&!draftMembersEdited.current)setNotice('暂时无法读取当前汇报人格，请手动选择参与人格。');});
        return()=>abort.abort();
      },[panel]);
      const openEdit=()=>{if(!data?.room)return;setName(data.room.name);setMembers([...data.room.memberIds]);editVersion.current=data.room.configRevision;setPanel('edit');setDeleting(false);setNotice('');};
      const openRooms=()=>{setPanel('rooms');setDeleting(false);void load(false);};
      const contacts=data?.contacts??[],room=data?.room;
      const panelView=panel?h('div',{className:'dsh-persona-chat-room-panel',role:'region','aria-label':panel==='rooms'?'聊天室列表':panel==='create'?'创建聊天室':'管理聊天室'},
        h('header',null,h('strong',null,panel==='rooms'?'聊天室':panel==='create'?'新建聊天室':'房间资料与成员'),h('button',{type:'button',onClick:()=>setPanel(null)},'收起面板')),
        notice?h('p',{role:'status'},notice):null,
        panel==='rooms'?h(React.Fragment,null,h('div',{className:'dsh-persona-chat-room-list'},...(data?.rooms??[]).map(item=>h('button',{
          key:item.id,type:'button','aria-label':'打开聊天室 '+item.name,'aria-pressed':item.id===roomId,disabled:busy,onClick:()=>void change({action:'select',roomId:item.id})},
          h(RoomAvatar,{memberIds:item.memberIds,contacts}),h('span',null,h('strong',null,item.name),h('small',null,item.memberIds.length+' 位人格 · '+item.turnCount+' 轮聊天'))))),
          h('div',{className:'dsh-persona-chat-room-buttons'},h('button',{type:'button',disabled:busy||!data?.ready,onClick:openCreate},'新建聊天室'),h('button',{type:'button',disabled:busy,onClick:()=>void load(false)},'刷新列表')))
          :h(React.Fragment,null,h('label',null,'聊天室名称',h('input',{type:'text','aria-label':'聊天室名称',maxLength:60,value:name,disabled:busy,onChange:e=>setName(e.target.value)})),
            h('strong',null,'参与人格 · '+members.length+'/8'),
            h('div',{className:'dsh-persona-chat-room-members'},...contacts.map(person=>h('label',{key:person.id},h('input',{type:'checkbox','aria-label':'成员 '+person.name,
              checked:members.includes(person.id),disabled:busy||(person.archived&&!members.includes(person.id))||(!members.includes(person.id)&&members.length>=8),onChange:e=>{draftMembersEdited.current=true;const checked=e.target.checked;setMembers(previous=>checked?[...previous,person.id]:previous.filter(id=>id!==person.id));}}),
              h(PersonaAvatar,{id:person.id,name:person.name,src:person.avatar,className:'dsh-persona-chat-avatar'}),h('span',null,person.name+(person.archived?'（已移除）':''))))),
            h('p',null,'加入的角色可以阅读本房间近期聊天。其他房间的记录和各人格的私有记忆仍分别隔离；修改成员不会自动发言。'),
            h('div',{className:'dsh-persona-chat-room-buttons'},h('button',{type:'button','data-primary':'',disabled:busy||!name.trim()||!members.length,onClick:()=>void change(panel==='create'
              ?{action:'create',requestId:creation.current,name:name.trim(),memberIds:members,targetPersonaId:members[0]}
              :{action:'update',roomId,configRevision:editVersion.current,name:name.trim(),memberIds:members})},busy?'保存中…':panel==='create'?'创建聊天室':'保存聊天室'),
              panel==='edit'?h('button',{type:'button',disabled:busy,onClick:openEdit},'重新载入成员'):null,
              panel==='edit'?h('button',{type:'button',disabled:busy,onClick:()=>setDeleting(true)},'删除聊天室'):null),
            deleting?h('div',null,h('p',null,'删除这个聊天室及其聊天记录？其他聊天室、人格和长期记忆都会保留。'),h('div',{className:'dsh-persona-chat-room-buttons'},
              h('button',{type:'button',disabled:busy,onClick:()=>void change({action:'delete',roomId,revision:room.revision})},'确认删除聊天室'),
              h('button',{type:'button',onClick:()=>setDeleting(false)},'取消删除'))):null)) : null;
      if(roomId&&room&&data.chatSchema===3&&data.discussionVersion===2)return h(PersonaChatWindow,{key:roomId,roomId,initialState:data,roomBusy:busy,sessionId:chatForegroundSession??sessionId,conversation,onClose,
        roomPanel:panelView,onDismissPanel:()=>setPanel(null),onOpenRooms:openRooms,onOpenMembers:openEdit,
        onRoomState:value=>{if(lifetime.current.live&&value.room?.id===selected.current)setData(value);},onRoomMissing:()=>{selected.current=null;setRoomId(null);setPanel('rooms');void load(false);}});
      return h('section',{className:'dsh-persona-chat',role:'dialog','aria-label':'聊天室',onKeyDown:e=>{if(e.key==='Escape'&&!e.nativeEvent?.isComposing){e.stopPropagation();if(panel)setPanel(null);else onClose();}}},h('style',null,CHAT_CSS,ROOM_CHAT_CSS),
        h('header',{style:{display:'flex',justifyContent:'space-between',padding:'12px'}},h('strong',null,'聊天室'),h('button',{type:'button','aria-label':'关闭聊天室',onClick:onClose},'关闭')),
        h('div',{className:'dsh-persona-chat-room-loading'},h('p',{role:'status'},notice||(!data?'正在读取聊天室…':!data.ready?'聊天存储正在准备，稍后可重新读取。':'选择一个聊天室，或新建一段讨论。')),
          h('button',{type:'button',onClick:()=>void load(lifetime.current.needsFirstRoom)},'重新读取'),data?.chatSchema===3&&data.ready&&!panel?h('button',{type:'button',onClick:openCreate},'新建聊天室'):null),panelView);
    }
    function PersonaChatWindow({ onClose, sessionId, conversation,roomId:explicitRoomId,initialState,roomBusy=false,onRoomState,onRoomMissing,
      roomPanel,onDismissPanel,onOpenRooms,onOpenMembers }) {
      const [minimized,setMinimized]=React.useState(()=>chatRuntime.minimized);
      const dockButton=React.useRef(null),dockSession=React.useRef(null);
      useLayoutEffect(()=>{const update=()=>setMinimized(chatRuntime.minimized);chatLaunchListeners.add(update);update();
        return()=>chatLaunchListeners.delete(update);},[]);
      const contextState=useChatContext(sessionId,explicitRoomId,minimized),context=contextState.value;
      const fixedSessionId=context?.primarySessionId??sessionId;
      const fixedReportPersona=context?.reportPersonaId??conversation?.effectivePersonaId;
      const [foreground,setForeground]=React.useState(chatForegroundSession??sessionId);
      const [sourcesOpen,setSourcesOpen]=React.useState(false),[projectId,setProjectId]=React.useState(''),[sessionChoices,setSessionChoices]=React.useState([]);
      const [sessionChoice,setSessionChoice]=React.useState('');
      React.useEffect(()=>{const update=()=>setForeground(chatForegroundSession);chatForegroundListeners.add(update);return()=>chatForegroundListeners.delete(update);},[]);
      const [data, setData] = React.useState(initialState);
      const latestData=React.useRef(initialState),roomMembers=React.useRef(initialState?.room?.memberIds??[]);
      const windowOwner = React.useRef({});
      const scope = '@global-chat';
      const [choice, setChoice] = React.useState(() => chatPersonaChoices.get(scope) ?? '');
      const [persona, setPersona] = React.useState(() => explicitRoomId?initialState?.personaId:chatPersonaChoices.get(scope) || fixedReportPersona);
      const personaRef = React.useRef(persona); personaRef.current = persona;
      const draftScope=explicitRoomId??persona;
      const [draft, setDraft] = React.useState(() => chatDrafts.get(explicitRoomId??persona) ?? emptyChatDraft());
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [info, setInfo] = React.useState('');
      const [syncDelayed,setSyncDelayed]=React.useState(false);
      const [wide, setWide] = React.useState(()=>explicitRoomId?chatRoomLayout.wide:false);
      const [composeExpanded, setComposeExpanded] = React.useState(()=>explicitRoomId?chatRoomLayout.composeExpanded:false);
      const [portal, setPortal] = React.useState(null);
      const [clearConfirm, setClearConfirm] = React.useState(false);
      const [retryConfirm, setRetryConfirm] = React.useState(null);
      const [appearance, setAppearance] = React.useState(false);
      const [suggestMode, setSuggestMode] = React.useState(false);
      const [suggestions, setSuggestions] = React.useState([]);
      const [suggestBusy, setSuggestBusy] = React.useState(false);
      const [suggestInfo, setSuggestInfo] = React.useState('');
      const suggestRequest = React.useRef({ revision: 0, abort: undefined, busy: false });
      const [scrolledUp, setScrolledUp] = React.useState(false);
      const readRevision = React.useRef(0), live = React.useRef(true), reading = React.useRef(undefined);
      const host = React.useRef({ id: undefined, retired: new Set() });
      const input = React.useRef(null), thread = React.useRef(null), atBottom = React.useRef(true), appearanceButton = React.useRef(null);
      const minimize=()=>{
        const snapshot=latestData.current;
        const known=new Set((snapshot?.room?.turns??[]).filter(t=>t.status==='ready').map(t=>t.attemptId));
        for(const id of known)chatAnimatedAttempts.delete(id);
        dockSession.current={instance:snapshot?.instanceId,generation:snapshot?.room?.generation,known,count:0,
          scroll:thread.current?.scrollTop??0,start:input.current?.selectionStart,end:input.current?.selectionEnd};
        chatRuntime.setMinimized(true);
      };
      useLayoutEffect(()=>{
        if(minimized){dockButton.current?.focus({preventScroll:true});return;}
        const last=dockSession.current;if(!last)return;
        dockSession.current=null;
        if(last.missing){onRoomMissing?.();return;}
        if(thread.current)thread.current.scrollTop=atBottom.current?thread.current.scrollHeight:last.scroll;
        input.current?.focus({preventScroll:true});if(last.start!=null)input.current?.setSelectionRange(last.start,last.end);
        if(!busyRef.current)void currentLoad.current(undefined,true);
      },[minimized]);
      const closeAppearance = () => { setAppearance(false); appearanceButton.current?.focus(); };
      const focusOnce = React.useRef(true);
      useLayoutEffect(() => {
        if (typeof createChatPortal !== 'function' || typeof document === 'undefined') return;
        const root = document.createElement('div'); root.dataset.personaShell = 'chat-window-root';
        document.body.appendChild(root); setPortal(root);
        return () => root.remove();
      }, []);
      const contact = data?.contacts?.find((p) => p.id === persona);
      const ready = data?.personaId === persona && (!explicitRoomId||data?.room?.id===explicitRoomId) && data?.ready && context?.initialized;
      roomMembers.current=data?.room?.memberIds??[];
      const turns = ready ? data.room?.turns ?? [] : [];
      const latestMessage=turns.at(-1)?.messageId;
      const [presented,setPresented]=React.useState({messageId:null,attempts:[]});
      const afterPresentation=turn=>setPresented(old=>{
        const attempts=old.messageId===turn.messageId?old.attempts:[];
        return attempts.includes(turn.attemptId)?old:{messageId:turn.messageId,attempts:[...attempts.slice(-7),turn.attemptId]};
      });
      // A queued speaker can receive stream updates, but cannot appear ahead of an earlier speaker's last bubble.
      // Historical groups render immediately, including when the user sends a new message during local playback.
      const barrier=turns.findIndex(t=>t.messageId===latestMessage&&(t.status==='pending'||(t.status==='ready'&&chatAnimatedAttempts.has(t.attemptId)
        &&!(presented.messageId===latestMessage&&presented.attempts.includes(t.attemptId)))));
      const pending = ready && data.running;
      const stopMessageId=pending && data.roundId && data.roundPhase!=='preparing' && (data.roundMessageId??latestMessage);
      const pendingTurn=stopMessageId?turns.find(t=>t.messageId===stopMessageId && t.status==='pending'):undefined;
      const stopTurn=pendingTurn??(stopMessageId && data.roundPhase==='listening'?turns.find(t=>t.messageId===stopMessageId):undefined);
      const currentContextKey = context?.id ? context.id + ':' + context.revision : null;
      const avatar = (id, name) => h(PersonaAvatar, { src:data?.contacts?.find(p=>p.id===id)?.avatar, id, name, className: 'dsh-persona-chat-avatar' });
      const accept = (value, token) => {
        if (!live.current || token !== readRevision.current || (explicitRoomId?value.room?.id!==explicitRoomId:personaRef.current && value.personaId !== personaRef.current)) return;
        if (host.current.retired.has(value.instanceId) || retiredInstances.has(value.instanceId)) return;
        if(latestData.current?.instanceId===value.instanceId&&latestData.current.room?.id===value.room?.id
          &&latestData.current.room?.revision>value.room?.revision)return;
        if (host.current.id && host.current.id !== value.instanceId) host.current.retired.add(host.current.id);
        host.current.id = value.instanceId;
        personaRef.current = value.personaId; setPersona(value.personaId);
        // Reactions or retry successors may finish between two snapshots. Pace those new attempts
        // just like the original recipients, without replaying a room's saved history on opening.
        const previous=latestData.current,lastMessage=value.room?.turns.at(-1)?.messageId;
        if(lastMessage&&previous?.instanceId===value.instanceId&&previous.room?.id===value.room.id&&previous.room.turns.at(-1)?.messageId===lastMessage){
          const known=new Set(previous.room.turns.filter(t=>t.messageId===lastMessage).map(t=>t.attemptId));
          for(const t of value.room.turns)if(t.messageId===lastMessage&&!known.has(t.attemptId))markChatAnimation(t.attemptId);
        }
        latestData.current=value;
        setData((previous) => previous?.instanceId === value.instanceId && (previous.userProfile?.revision ?? -1) > (value.userProfile?.revision ?? -1)
          ? { ...value, userProfile: previous.userProfile } : value);
        const key=explicitRoomId??value.personaId;
        for(const turn of value.room?.turns??[])if(chatRetryIds.get(key+':'+turn.id)===turn.attemptId)chatRetryIds.delete(key+':'+turn.id);
        const current = chatDrafts.get(key);
        if (current && value.room?.turns.some((t) => t.id === current.requestId && t.user === current.text)) {
          for(const turn of value.room.turns)if(turn.messageId===current.requestId)markChatAnimation(turn.attemptId);
          const empty = emptyChatDraft(); keepDraft(chatDrafts, key, empty); setDraft(empty);
        } else setDraft(current ?? emptyChatDraft());
        // Only durable replies completed while this particular room was tucked away are unread.
        // A streaming delta, a cancelled attempt and the three bubbles of a single answer are not three replies.
        const dock=dockSession.current;
        if(dock&&chatRuntime.minimized){
          const reset=dock.instance!==value.instanceId||dock.generation!==value.room?.generation;
          if(reset){dock.instance=value.instanceId;dock.generation=value.room?.generation;dock.known.clear();dock.count=0;}
          for(const t of value.room?.turns??[])if(t.status==='ready'){
            if(!reset&&!dock.known.has(t.attemptId))dock.count++;
            dock.known.add(t.attemptId);chatAnimatedAttempts.delete(t.attemptId);
          }
        }
        onRoomState?.(value);
      };
      const load = async (id = personaRef.current, background = false) => {
        reading.current?.abort();
        const abort = new AbortController(); reading.current = abort;
        let timedOut=false;
        const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        const token = ++readRevision.current;
        try {
          const query = new URLSearchParams(); if(explicitRoomId)query.set('room',explicitRoomId);else if (id) query.set('persona', id); if (fixedSessionId) query.set('session', fixedSessionId);
          const response = await fetch(ROUTE + '/chat' + (query.size ? '?' + query : ''), { signal: abort.signal });
          if (!live.current || token !== readRevision.current) return;
          if (response.status === 404 && id) {
            if(explicitRoomId){
              if(chatRuntime.minimized&&dockSession.current){
                // Another window removed the room. Stay tucked away until the user opens the room list.
                dockSession.current.missing=true;setSyncDelayed(false);setData(old=>old?.running?{...old,running:false}:old);return true;
              }
              onRoomMissing?.();return;
            }
            personaRef.current = undefined; chatPersonaChoices.delete(scope); setChoice(''); setPersona(undefined); void load(undefined); return;
          }
          const value = await response.json();
          if (!live.current||token!==readRevision.current||abort.signal.aborted)return;
          if (!response.ok) throw new Error(value.error);
          accept(value, token);setSyncDelayed(false);return true;
        } catch (error) {
          if (live.current && token === readRevision.current && (!abort.signal.aborted||timedOut)) {
            setSyncDelayed(true);
            if(!background&&error.message!=='Failed to fetch')setInfo(chatErrorText(error.message));
          }
          return false;
        }finally{clearTimeout(timeout);}
      };
      const currentLoad=React.useRef(load);currentLoad.current=load;
      React.useEffect(() => {
        live.current = true; const previous = typeof document !== 'undefined' ? document.activeElement : undefined;
        const update = (id, owner) => { if (owner !== windowOwner.current && (explicitRoomId?id===explicitRoomId||roomMembers.current.includes(id):id === personaRef.current) && !busyRef.current) void load(id); };
        const profileUpdate = (value) => setData((previous) => previous?.instanceId === value.instanceId
          && (previous.userProfile?.revision ?? -1) <= value.revision ? { ...previous, userProfile: value } : previous);
        chatUpdates.add(update);
        chatProfileUpdates.add(profileUpdate);
        void load(); input.current?.focus();
        return () => { live.current = false; chatUpdates.delete(update); chatProfileUpdates.delete(profileUpdate); readRevision.current += 1; reading.current?.abort();
          if(explicitRoomId)for(const turn of latestData.current?.room?.turns??[])chatAnimatedAttempts.delete(turn.attemptId);
          suggestRequest.current.revision += 1; suggestRequest.current.abort?.abort(); if (previous?.isConnected) previous.focus(); };
      }, []);
      React.useEffect(()=>{if(explicitRoomId&&initialState)accept(initialState,readRevision.current);},[initialState]);
      React.useEffect(() => {
        if (explicitRoomId || choice || !fixedReportPersona || personaRef.current === fixedReportPersona) return;
        const id = fixedReportPersona;
        personaRef.current = id; setPersona(id); setData(undefined); setInfo(''); setClearConfirm(false);
        atBottom.current = true; setScrolledUp(false); void load(id);
      }, [choice, fixedReportPersona]);
      const accountAvatar = useAccountAvatar(!minimized && !!data?.userProfile && userAvatarMode(data.userProfile) === 'account');
      React.useEffect(() => {
        if (ready && focusOnce.current) { input.current?.focus(); focusOnce.current = false; }
      }, [ready]);
      React.useEffect(() => {
        if ((!pending&&!syncDelayed) || busy) return;
        let timer,sequence=0,alive=true,interval=1000;
        const poll=async()=>{
          if(!alive||busyRef.current||document.visibilityState==='hidden')return;
          const token=++sequence,ok=await currentLoad.current(undefined,true);
          if(!alive||token!==sequence||document.visibilityState==='hidden'||(ok&&!latestData.current?.running))return;
          interval=ok?1000:Math.min(8000,interval*2);
          timer=setTimeout(poll,interval);
        };
        const visibility=()=>{sequence++;clearTimeout(timer);interval=1000;
          if(document.visibilityState!=='hidden')void poll();else reading.current?.abort();
        };
        if(document.visibilityState!=='hidden')timer=setTimeout(poll,interval);
        document.addEventListener('visibilitychange',visibility);
        return()=>{alive=false;sequence++;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
      }, [pending,syncDelayed,busy,explicitRoomId,persona,data?.instanceId]);
      React.useEffect(() => {
        if (atBottom.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
      }, [data?.room?.revision, persona]);
      const resetSuggestions = () => {
        suggestRequest.current.revision += 1; suggestRequest.current.abort?.abort(); suggestRequest.current.busy = false;
        setSuggestions([]); setSuggestBusy(false); setSuggestInfo('');
      };
      const chatGeneration=explicitRoomId?(data?.room?.generation??0):data?.epoch;
      React.useEffect(resetSuggestions, [persona, data?.room?.id, data?.room?.revision, data?.instanceId, chatGeneration, suggestMode, context?.id, context?.revision]);
      React.useEffect(() => setRetryConfirm(null), [persona, data?.room?.revision, data?.instanceId, chatGeneration, currentContextKey]);
      const edit = (text) => {
        resetSuggestions();
        const next = { text, requestId: chatNonce() }; keepDraft(chatDrafts, draftScope, next); setDraft(next);
      };
      const generateSuggestions = async () => {
        if (!ready || !suggestMode || suggestRequest.current.busy || pending || contact?.archived) return;
        const abort = new AbortController(), token = ++suggestRequest.current.revision;
        suggestRequest.current.abort = abort; suggestRequest.current.busy = true;
        setSuggestBusy(true); setSuggestInfo(''); setSuggestions([]);
        try {
          const response = await fetch(ROUTE + '/chat/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ personaId: persona, roomId: data.room?.id ?? null, revision: data.room?.revision ?? 0, epoch: data.epoch, instruction: draft.text,
              contextKey:context?.id?context.id+':'+context.revision:undefined }), signal: abort.signal });
          const value = await response.json();
          if (!live.current || token !== suggestRequest.current.revision || abort.signal.aborted) return;
          if (!response.ok) throw new Error(value.error);
          setSuggestions(value.suggestions);
        } catch (error) {
          if (live.current && token === suggestRequest.current.revision && !abort.signal.aborted) setSuggestInfo(error.message === 'suggestions-context-changed'
            ? '讨论或参考来源已经更新，请重新生成参考。' : error.message==='suggestions-no-context'
              ?'请先在当前参考范围下聊几句，或在输入框中说明希望生成什么。':'暂时没有生成参考，输入仍保留，可以重试。');
        } finally {
          if (token === suggestRequest.current.revision) { suggestRequest.current.busy = false; if (live.current) setSuggestBusy(false); }
        }
      };
      const act = async (body,endpoint='chat') => {
        if (busyRef.current || !ready) return;
        busyRef.current = true; setBusy(true); setInfo(''); reading.current?.abort();
        const id = persona, token = ++readRevision.current;
        try {
          const { ok, value } = await actionRequest(endpoint, { ...body,roomId:explicitRoomId, personaId: id, epoch: data.epoch,
            contextKey:context?.id?context.id+':'+context.revision:undefined });
          if (value?.state) accept(value.state, token); else if (ok) accept(value, token);
          if (!ok) throw new Error(value.error);
          if (body.action === 'clear' && live.current && personaRef.current === id) {
            setClearConfirm(false); setInfo('已清空此角色的聊天记录，已保存偏好仍在设置中管理。');
            if (!value.contacts?.some((p) => p.id === id)) { personaRef.current = undefined; setPersona(undefined); void load(); }
          }
        } catch (error) {
          if (live.current && token === readRevision.current) { setInfo(chatErrorText(error.message)); void load(id); }
        } finally {
          busyRef.current = false; if (live.current) setBusy(false);
          for (const update of chatUpdates) update(explicitRoomId??id, windowOwner.current);
        }
      };
      const send = () => {
        if (!draft.text.trim() || pending || roomBusy || contact?.archived || !data?.modelReady || contextState.busy) return;
        resetSuggestions();
        keepDraft(chatDrafts, draftScope, draft); atBottom.current = true; setScrolledUp(false);
        markChatAnimation(draft.requestId);
        return act({ action: 'send', requestId: draft.requestId, content: draft.text, revision: data.room?.revision ?? 0,
          ...(explicitRoomId?{recipientIds:data.room.targetPersonaIds}:{}) });
      };
      const retry = (turn, confirmed = false) => {
        if (!ready || busyRef.current || roomBusy || contextState.busy || pending || !data.modelReady) return;
        const sameScope=explicitRoomId&&turn.scopeKey&&turn.scopeKey===(context?.scopeKey??data.scopeKey);
        if ((turn.contextKey ?? null) !== currentContextKey && !sameScope && !confirmed) { setRetryConfirm(turn); return; }
        setRetryConfirm(null); resetSuggestions(); atBottom.current = true; setScrolledUp(false);
        const key = draftScope + ':' + turn.id, id = chatRetryIds.get(key) ?? chatNonce();
        keepDraft(chatRetryIds, key, id); markChatAnimation(id);
        return act({ action: 'retry', id: turn.id, attemptId: id, revision: data.room.revision,
          ...(confirmed ? { previousContextKey: turn.contextKey ?? null } : {}) });
      };
      const unread=dockSession.current?.count??0;
      const view = minimized?h('aside',{className:'dsh-persona-chat-dock','aria-label':'已最小化的聊天室'},
        h('style',null,ROOM_CHAT_CSS),
        h('button',{type:'button',ref:dockButton,'aria-label':'还原聊天室'+(unread?'，'+unread+' 条新回复':''),title:'还原 · '+(data?.room?.name??'聊天室'),onClick:()=>chatRuntime.setMinimized(false)},
          h('span',{'aria-hidden':true},h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts})),h('span',null,'聊天室'),
          unread?h('span',{key:unread,className:'dsh-persona-chat-dock-count','aria-hidden':true},unread>99?'99+':String(unread)):null),
        h('button',{type:'button','aria-label':'关闭聊天室',title:'关闭聊天室',onClick:onClose},'×'),
        h('span',{className:'dsh-persona-chat-dock-status',role:'status','aria-live':'polite','aria-atomic':true},unread?'聊天室收到 '+unread+' 条新回复':'')):
        h('section', { className: 'dsh-persona-chat', 'data-wide': String(wide), 'data-compose-expanded':String(composeExpanded), role: 'dialog', 'aria-modal': false,
        'aria-label': '聊天室', onKeyDown: (event) => { if (event.key === 'Escape' && !event.nativeEvent?.isComposing) {
          event.stopPropagation(); if (roomPanel) onDismissPanel?.(); else if (appearance) closeAppearance(); else onClose();
        } } },
        h('style', null, CHAT_CSS, CHAT_APPEARANCE_CSS,ROOM_CHAT_CSS),
        h('header', { className: 'dsh-persona-chat-top','data-room':String(!!explicitRoomId) }, explicitRoomId?h('span',{className:'dsh-persona-room-avatar-display'},
          h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts})):avatar(persona, contact?.name),
          explicitRoomId?h('div',{className:'dsh-persona-chat-room-heading'},
            h('button',{type:'button',className:'dsh-persona-chat-room-title','aria-label':'切换聊天室',disabled:roomBusy,title:'切换聊天室 · '+(data?.room?.name??'聊天室'),onClick:onOpenRooms},
              h('span',null,data?.room?.name??'聊天室'),h('span',{'aria-hidden':true},'⌄')),
            h('nav',{className:'dsh-persona-chat-room-tools','aria-label':'聊天室管理'},
              h('button',{type:'button','aria-label':'管理聊天室成员',disabled:roomBusy,
                title:'管理成员 · '+(data?.room?.memberIds.length??0)+' 位人格',onClick:onOpenMembers},'成员'),
              h('button',{type:'button','aria-label':sourcesOpen?'收起来源':'参考来源','aria-expanded':sourcesOpen,'aria-controls':'dsh-persona-chat-source-panel',
                title:context?.initialized?'固定参考 · '+(context.sources?.length??0)+' 个会话，切换工作页不会更换来源':'正在初始化参考来源',
                onClick:()=>setSourcesOpen(!sourcesOpen)},context?.initialized?'来源 · '+(context.sources?.length??0):'连接中'))):h('strong', { className:'dsh-persona-chat-title' }, '聊天室'),
          h('div', { className:'dsh-persona-chat-actions' },
            h('button', { type: 'button', onClick: () => setClearConfirm(!clearConfirm), disabled: !turns.length || busy || roomBusy }, '清空'),
            h('button', { type: 'button', ref: appearanceButton, 'aria-expanded': appearance, onClick: () => setAppearance(!appearance) }, '外观'),
            h('button', { type:'button',disabled:roomBusy,'aria-label':'最小化聊天室',title:'最小化到右下角，收到回复时提醒',onClick:minimize },
              h('svg',{width:13,height:13,viewBox:'0 0 16 16',fill:'none','aria-hidden':true,style:{verticalAlign:'middle'}},
                h('path',{d:'M3 11h10',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round'}))),
            h('button', { type: 'button', onClick: () => {if(explicitRoomId)chatRoomLayout.wide=!wide;setWide(!wide);} }, wide ? '还原' : '放大'),
            h('button', { type: 'button', 'aria-label': '关闭聊天室', onClick: onClose }, '关闭')),
          !explicitRoomId?h('div', { className:'dsh-persona-chat-context-row' },
            h('select', { 'aria-label': '聊天人格',title:choice?contact?.name:'跟随主要参考会话的汇报人格', value: choice, disabled: busy || !data,
              onChange: (event) => {
                resetSuggestions();
                const selected = event.target.value; setChoice(selected);
                if (selected) keepDraft(chatPersonaChoices, scope, selected); else chatPersonaChoices.delete(scope);
                const id = selected || fixedReportPersona || data?.reportPersonaId || data?.defaultPersonaId;
                personaRef.current = id; setPersona(id);
                setDraft(chatDrafts.get(id) ?? emptyChatDraft()); setInfo(''); setClearConfirm(false); atBottom.current = true; setScrolledUp(false); void load(id);
              } }, !data ? h('option', { value: '' }, '正在读取…') : null,
              data ? h('option', { value: '' }, '跟随汇报 · ' + (data.contacts?.find(p => p.id === (fixedReportPersona || data.reportPersonaId || data.defaultPersonaId))?.name ?? '默认人格')) : null,
              ...(data?.contacts ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name + (p.archived ? '（已移除）' : '')))),
            h('button',{type:'button','aria-label':sourcesOpen?'收起来源':'参考来源','aria-expanded':sourcesOpen,'aria-controls':'dsh-persona-chat-source-panel',
              title:context?.initialized?'固定参考 · '+(context.sources?.length??0)+' 个会话，切换工作页不会更换来源':'正在初始化参考来源',
              onClick:()=>setSourcesOpen(!sourcesOpen)},context?.initialized?'来源 · '+(context.sources?.length??0):'连接中')):null),
        sourcesOpen || contextState.error ? h('div', { id:'dsh-persona-chat-source-panel', className: 'dsh-persona-chat-info dsh-persona-chat-sources' },
          contextState.error?h('p',{role:'status'},contextState.error,h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'open',sessionId,visible:true})},'重试连接')):null,
          sourcesOpen?h('div',null,
            h('p',null,'切换工作页会保留这些来源。未接入项目只显示文件夹名称，不读取会话正文。'),
            ...(context?.sources??[]).map(source=>h('div',{key:source.sessionId,className:'dsh-persona-source-item'},
              h('span',null,source.sessionId===context.primarySessionId?'主要 · ':'',source.name,source.focused?' · 焦点':'',source.error?' · 更新暂未完成':!source.available?' · 暂不可读':''),
              h('button',{type:'button',disabled:contextState.busy,'aria-label':'移除来源'+source.name,onClick:()=>contextState.action({action:'detach',sessionId:source.sessionId})},'移除'))),
            h('div',{className:'dsh-persona-chat-source-actions'},
              h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'refresh'})},'刷新参考'),
              h('button',{type:'button',disabled:!foreground||!context?.initialized||contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:foreground,primary:true})},'接入当前会话'),
              h('select',{'aria-label':'选择项目',value:projectId,disabled:contextState.busy,onChange:async e=>{const id=e.target.value;setProjectId(id);setSessionChoices([]);setSessionChoice('');
                if(id){const result=await contextState.action({action:'sessions',projectId:id});if(result?.items)setSessionChoices(result.items);}}},
                h('option',{value:''},'其他项目…'),...(context?.projects??[]).map(p=>h('option',{key:p.id,value:p.id},p.name))),
              projectId?h('select',{'aria-label':'选择参考会话',value:sessionChoice,onChange:e=>setSessionChoice(e.target.value)},h('option',{value:''},sessionChoices.length?'选择会话…':'没有可用会话'),
                ...sessionChoices.map(s=>h('option',{key:s.sessionId,value:s.sessionId},s.name))):null,
              sessionChoice?h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:sessionChoice})},'接入所选会话'):null),
            h('p',null,'焦点依据近期查看、接入和聊天操作计算，仅调整已接入来源的更新频率。改变参考范围后，后续回复使用新的来源；旧范围的聊天不自动提供给模型。')):null) : null,
          (context?.notices??[]).some(n=>!n.read)?h('details',{className:'dsh-persona-context-notices'},h('summary',null,'相关会话更新 · '+context.notices.filter(n=>!n.read).length),
            ...context.notices.filter(n=>!n.read).map(n=>h('div',{key:n.id,className:'dsh-persona-source-item'},
              h('span',null,n.name+' · '+(n.kind==='error'?'出现运行异常':'一轮汇报已结束')),
              !n.attached?h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:n.sessionId})},'接入查看'):null,
              h('button',{type:'button',onClick:()=>contextState.action({action:'dismiss',noticeId:n.id})},'已读')))):null,
        appearance ? h('div', { className: 'dsh-persona-chat-appearance' }, h(ChatUserSettings, { onClose: closeAppearance })) : null,
        roomPanel,
        clearConfirm ? h('div', { className: 'dsh-persona-chat-info' }, explicitRoomId?'清空这个聊天室的记录？成员、参考来源和长期记忆仍保留。':'清空这个角色的聊天？已保存偏好仍保留。',
          h('button', { type: 'button', disabled: busy, onClick: () => act({ action: 'clear', revision: data.room?.revision ?? 0 }) }, '确认清空聊天'),
          h('button', { type: 'button', onClick: () => setClearConfirm(false) }, '取消清空')) : null,
        info ? h('div', { className: 'dsh-persona-chat-info', role: 'status', 'aria-live': 'polite' }, info,
          h('button', { type: 'button', onClick: () => { setInfo(''); void load(); } }, '刷新')) : null,
        syncDelayed?h('div',{className:'dsh-persona-chat-info',role:'status'},'连接暂时中断，正在重新读取回复…'):null,
        contact?.archived ? h('div', { className: 'dsh-persona-chat-info' }, explicitRoomId?'这位角色已移除，请选择其他回复对象，或在成员管理中加入新角色。原有聊天保留。':'角色已移除，可以查看或清空历史记录。') : null,
        h('div', { className: 'dsh-persona-chat-thread-wrap' }, h('div', { className: 'dsh-persona-chat-thread', ref: thread, 'aria-label': '聊天消息', onScroll: () => {
          const el = thread.current; if (!el) return;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setScrolledUp(!atBottom.current);
        } }, turns.length === 0 ? h('div', { className: 'dsh-persona-chat-empty' },
          explicitRoomId?h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts}):avatar(persona, contact?.name),
          h('strong', null, ready ? data?.room?.targetPersonaIds.length>1?'和大家聊点什么吧':`和${contact?.name ?? '这位角色'}聊点什么吧` : '正在读取聊天记录…'),
          h('p', null, explicitRoomId&&data?.room?.memberIds.length>1?'在下方 @ 一至两位一起聊，其他成员也可以接话。':'从一个想法，或今天的小事开始。')) : null,
          ...turns.map((turn, index) => h('div', { key: turn.id, 'data-chat-turn': turn.id },
            (index === 0 || turn.at - turns[index - 1].at > 300000) ? h('p', { className: 'dsh-persona-chat-time' }, new Date(turn.at).toLocaleString()) : null,
            index===0||turn.messageId!==turns[index-1].messageId?h('div', { className: 'dsh-persona-chat-message', 'data-user': 'true' },
              h(UserChatAvatar, { profile: data.userProfile, accountUrl: accountAvatar, className: 'dsh-persona-chat-avatar' }), h('div', { className: 'dsh-persona-chat-bubble' },
                explicitRoomId&&(turn.memberIdsAtSend?.length>1||turn.recipients.length>1)?h('small',{className:'dsh-persona-chat-mentions'},turn.recipients.map(p=>'@'+p.name).join(' ')):null,turn.user)):null,
            h(ChatTurnReply,{key:turn.attemptId,turn,instance:data.instanceId,roomId:explicitRoomId,running:data.running,
              held:barrier>=0&&index>barrier,latest:turn.messageId===latestMessage,onPresented:afterPresentation,
              started:data.activeAttemptIds?.includes(turn.attemptId),
              onFinish:()=>{if(live.current&&!busyRef.current&&document.visibilityState!=='hidden')void load(undefined,true);},
              showSpeaker:!!explicitRoomId&&(data.room.memberIds.length>1||turn.recipientId!==persona),
              avatar:()=>avatar(turn.recipientId??persona,turn.speakerName),
              onProgress:()=>{if(atBottom.current&&thread.current)thread.current.scrollTop=thread.current.scrollHeight;}}),
            !(barrier>=0&&index>barrier)&&turn.status !== 'ready' && !(turn.status === 'pending' && data.running) ? h('div', { className: 'dsh-persona-chat-turn-state', role: 'status', 'aria-live': 'polite' },
              explicitRoomId&&(data.room.memberIds.length>1||turn.recipients.length>1||turn.phase==='reaction')?h('strong',null,turn.speakerName+' · '):null,
              h('span',null,chatReplyStateText(turn, data.running)),
              turn.messageId === turns.at(-1)?.messageId && !pending
                &&(!explicitRoomId||data.room.memberIds.includes(turn.recipientId)&&!data.contacts.find(p=>p.id===turn.recipientId)?.archived)
                ? h('button', { type: 'button', disabled: busy || roomBusy || contextState.busy || !ready || !data.modelReady,
                  title:'从 '+turn.speakerName+' 开始重试；后续接话会重新生成，前面的回复保留。',onClick: () => void retry(turn) },
                  turns.slice(index+1).some(t=>t.messageId===turn.messageId)?'从这里重试':'重试回复') : null) : null))),
        scrolledUp && turns.length ? h('button', { type: 'button', className:'dsh-persona-chat-jump', onClick: () => {
          atBottom.current = true; setScrolledUp(false); if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
        } }, '回到最新消息') : null),
        pending&&barrier<0&&data.roundPhase==='listening'?h('div',{role:'status',style:{fontSize:11,color:'var(--chat-muted)',padding:'0 12px 6px'}},'大家在听…'):null,
        retryConfirm ? h('div', { className: 'dsh-persona-chat-info', role: 'status' },
          '参考来源与这条消息发送时不同。按当前来源重试同一句话？旧范围的聊天不会带入，用户消息不会重复。',
          h('button', { type: 'button', disabled: busy || contextState.busy, onClick: () => void retry(retryConfirm, true) }, '按当前来源重试'),
          h('button', { type: 'button', onClick: () => setRetryConfirm(null) }, '暂不重试')) : null,
        h('div', { className: 'dsh-persona-chat-compose' },
          explicitRoomId&&data?.room?.memberIds.length>1?h('div',{className:'dsh-persona-chat-participants'},
            h(RoomRecipient,{contacts:data?.contacts??[],memberIds:data?.room?.memberIds??[],value:data.room.targetPersonaIds,disabled:busy||roomBusy||!data,
              onChange:ids=>act({action:'update',targetPersonaIds:ids,configRevision:data.room.configRevision},'chat-rooms')})):null,
          suggestMode ? h('div', { className: 'dsh-persona-chat-suggest' }, h('div', { className: 'dsh-persona-chat-suggest-head' },
            h('small',null,'点选参考后，可修改再发送。'),
            h('button', { type: 'button', onClick: generateSuggestions, disabled: suggestBusy || busy || !ready || pending || contact?.archived
              || !data?.modelReady || (!draft.text.trim() && !turns.length) }, suggestBusy ? '正在生成…' : '生成参考')),
            suggestInfo ? h('small', { role: 'status', 'aria-live': 'polite' }, suggestInfo) : null,
            h('div', { className: 'dsh-persona-chat-suggestions', 'aria-label': '参考快捷回复' }, ...suggestions.map((text, index) =>
              h('button', { type: 'button', key: index, onClick: () => {
                const next = { text, requestId: chatNonce() }; keepDraft(chatDrafts, draftScope, next); setDraft(next); input.current?.focus(); setSuggestInfo('已填入，可修改后发送。');
              } }, text)))) : null,
          h('textarea', { id:'dsh-persona-chat-input', ref: input, value: draft.text, maxLength: 4000, rows:2,
          'aria-label': '发送给角色的消息', title:'Enter 发送 · Shift+Enter 换行', placeholder: contact?.archived ? '这位角色已移除' : '说点什么…', disabled: !ready, readOnly: contact?.archived === true,
          onChange: (event) => edit(event.target.value), onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
          } }),
          !data?.modelReady && ready ? h('p', { style: { fontSize: '11px', margin: '0 0 7px' } }, '请先在插件设置中选择聊天室或转述模型。') : null,
          h('div', { className: 'dsh-persona-chat-compose-row' },
            h('label', null, h('input', { type: 'checkbox', checked: suggestMode, 'aria-label': '快捷回复参考', onChange: (event) => setSuggestMode(event.target.checked) }), '快捷回复参考'),
            h('small', {title:'Enter 发送 · Shift+Enter 换行'}, 'Enter 发送'),
            h('button', {type:'button',className:'dsh-persona-chat-compose-expand','aria-label':composeExpanded?'收起输入框':'展开输入框',
              title:composeExpanded?'收起输入框':'展开输入框','aria-expanded':composeExpanded,'aria-controls':'dsh-persona-chat-input',
              onClick:()=>{if(explicitRoomId)chatRoomLayout.composeExpanded=!composeExpanded;setComposeExpanded(!composeExpanded);input.current?.focus({preventScroll:true});}},h(ChatExpandIcon,{expanded:composeExpanded})),
            stopTurn ? h('button', { type: 'button', disabled: busy, onClick: () => {
              void act({ action: 'cancel', id: stopTurn.id, attemptId: stopTurn.attemptId,messageId:stopTurn.messageId,roundId:data.roundId,
                attempts:turns.filter(t=>t.messageId===stopTurn.messageId&&t.status==='pending').map(t=>({id:t.id,attemptId:t.attemptId})) });
            } }, data.roundPhase==='listening'?'停止接话':'停止回复') : h('button', { type: 'button', 'data-primary': '', disabled: pending || busy || roomBusy || contextState.busy || !ready || !draft.text.trim() || contact?.archived || !data?.modelReady,
              onClick: send }, pending ? (data.roundPhase==='preparing'?'正在确认…':'同步中…') : busy ? '发送中…' : '发送'))));
      return portal && typeof createChatPortal === 'function' ? createChatPortal(view, portal) : view;
    }

    // Drafts stay on the client; closing a dialog never submits or discards them.
    const conversationDrafts = new Map();
    const feedbackDrafts = new Map();
    function keepDraft(map, key, value) {
      if (!map.has(key) && map.size >= 100) map.delete(map.keys().next().value);
      map.set(key, value);
    }
    const ACTION_CSS = `
      .dsh-persona-action[data-native]{box-sizing:border-box;position:fixed;inset:0;margin:auto;transform:none;width:min(520px,calc(100vw - 32px));height:fit-content;max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px);border:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary);overflow:visible;text-align:left}
      .dsh-persona-action::backdrop{background:#0007}
      .dsh-persona-action-surface{box-sizing:border-box;position:relative;width:100%;max-width:100%;min-width:0;max-height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain;padding:24px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 20px 80px #0003;font-size:14px;line-height:1.65;overflow-wrap:anywhere}
      .dsh-persona-action-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
      .dsh-persona-action-top h2{font-size:18px;margin:0}.dsh-persona-action-top button{flex:none}
      .dsh-persona-action-surface label{display:grid;gap:6px;margin:14px 0}
      .dsh-persona-action-surface select,.dsh-persona-action-surface textarea{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#f6f8fb);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px;min-width:0}
      .dsh-persona-action-surface textarea{min-height:96px;resize:vertical}
      .dsh-persona-action-surface button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);cursor:pointer;min-height:34px}
      .dsh-persona-action-surface button:disabled{opacity:.5;cursor:default}.dsh-persona-action-surface button:focus-visible,.dsh-persona-action-surface select:focus-visible,.dsh-persona-action-surface textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
      .dsh-persona-action-surface button[data-primary]{background:var(--dsw-alias-brand-primary,#386fba);color:var(--dsw-alias-on-brand-primary,var(--dsw-alias-bg-layer-1,#fff));border-color:transparent}
      .dsh-persona-action-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:8px 0}
      .dsh-persona-action-box{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);margin:16px 0}
      .dsh-persona-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
      @media(max-width:520px){.dsh-persona-action-surface{padding:18px}}
    `;
    function ActionDialog({ title, onClose, children }) {
      const surface = React.useRef(null);
      useLayoutEffect(() => lockComparisonScroll(surface.current.ownerDocument), []);
      // Native top-layer geometry is independent of the header container and host Modal sizing.
      return h(NativeComparisonModal, { onClose, title, className: 'dsh-persona-action' },
        h('style', null, ACTION_CSS), h('div', { ref: surface, className: 'dsh-persona-action-surface' },
          h('div', { className: 'dsh-persona-action-top' }, h('h2', null, title),
            h('button', { type: 'button', onClick: onClose, 'aria-label': `关闭${title}` }, '关闭')), children));
    }
    const actionError = (error) => ({
      'conversation-conflict': '会话选择已在别处更新。已读入最新状态，请核对后重新保存。',
      'relay-conflict': '这次接力状态已经变化，请核对最新状态。',
      'relay-already-pending': '已有一项等待中的接力，请先取消。',
      'relay-same-persona': '请选择另一位接手角色。',
      'session-capacity': '独立会话选择已达上限，暂时无法新增。已有会话仍可调整。',
      'persona-not-found': '这个人格已经被删除，请重新选择。',
      'storage-not-ready': '保存服务尚未就绪，请稍后重试。输入已经保留。',
      'memory-capacity': '记忆已满，请先在设置里整理旧条目。输入已经保留。',
      'memory-conflict': '保存期间记忆又有更新，请核对后重试。输入已经保留。',
      'memory-disabled': '记忆已关闭。可以只调整这一次，或先到设置开启记忆。',
      'report-conflict': '这份汇报已经更新，请核对后再提交。输入已经保留。',
      'feedback-in-progress': '这份汇报正在调整，请等本次完成。',
      'rewrite-disabled': '当前转述已关闭，开启后可以重试。',
      'source-unavailable': '这份旧汇报没有保存原始来源，暂时不能重新转述。',
      'feedback-rewrite-failed': '这次调整没有完成，已保留原来的汇报和你的输入。',
    }[error] ?? '没有保存成功，请重试。你的输入已经保留。');
    async function actionRequest(path, body) {
      const response = await fetch(`${ROUTE}/${path}`, body === undefined ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json();
      return { ok: response.ok, value };
    }
    function ConversationPanel({ sessionId, conversation, onClose }) {
      const [data, setData] = React.useState(conversation);
      const [draft, setDraft] = React.useState(() => conversationDrafts.get(sessionId) ?? null);
      const [target, setTarget] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [message, setMessage] = React.useState('');
      const accept = (next, request) => {
        if (!acceptInstance(next, request)) return false;
        setData((old) => {
          if (!old || old.instanceId !== next.instanceId) return next;
          if (Number.isSafeInteger(old.stateRev) && Number.isSafeInteger(next.stateRev)) {
            return next.stateRev >= old.stateRev ? next : old;
          }
          return next.revision >= old.revision ? next : old;
        });
        return true;
      };
      React.useEffect(() => { if (conversation) accept(conversation, ++requestSequence); }, [conversation]);
      React.useEffect(() => {
        let stopped = false;
        const request = ++requestSequence;
        actionRequest(`conversation?session=${encodeURIComponent(sessionId)}`).then(({ ok, value }) => {
          if (!stopped) { if (ok) accept(value, request); else setMessage(actionError(value.error)); }
        }).catch(() => { if (!stopped) setMessage('暂时无法读取会话设置，请关闭后重试。'); });
        return () => { stopped = true; };
      }, [sessionId]);
      const choice = draft ?? { personaId: data?.personaId ?? null, trigger: data?.trigger ?? 'inherit' };
      const edit = (patch) => { const next = { ...choice, ...patch }; setDraft(next); keepDraft(conversationDrafts, sessionId, next); };
      const write = async (body) => {
        if (busyRef.current || !data) return;
        busyRef.current = true; setBusy(true); setMessage('正在保存…');
        const request = ++requestSequence;
        try {
          const { ok, value } = await actionRequest('conversation', { sessionId, revision: data.revision, ...body });
          if (!ok) { if (value.conversation) accept(value.conversation, request); setMessage(actionError(value.error)); return; }
          if (!accept(value, request)) { setMessage('插件状态已更新，请核对当前会话后重试。输入已经保留。'); return; }
          if (body.action === 'select' && conversationDrafts.get(sessionId) === draft) {
            conversationDrafts.delete(sessionId); setDraft(null);
          }
          setMessage(body.action === 'relay' ? '已安排，下一份符合范围的原始汇报到达后接手。'
            : body.action === 'cancel' ? '已取消等待中的接力。' : '已保存，从后续汇报开始生效。');
          void refresh(sessionId);
        } catch { setMessage(actionError()); }
        finally { busyRef.current = false; setBusy(false); }
      };
      const presets = data?.presets ?? [];
      const relay = data?.relay;
      const name = (id) => presets.find((p) => p.id === id)?.name ?? '已删除的人格';
      const disabled = busy || !data?.ready;
      return h(ActionDialog, { title: '当前会话的人格', onClose },
        h('p', { className: 'dsh-persona-action-note' }, '只影响这个会话的后续转述。其他会话和历史署名保持各自的选择。'),
        data ? h('div', null,
          h('div', { className: 'dsh-persona-action-box' }, `正在使用：${data.effectivePersonaName}`,
            data.missingPersona ? h('p', { className: 'dsh-persona-action-note' }, '原先选择的人格已被删除，当前使用全局默认。') : null),
          data.relayError ? h('p', { role: 'status', className: 'dsh-persona-action-note' }, data.relayError) : null,
          h('label', null, '会话人格', h('select', { 'aria-label': '会话人格', value: choice.personaId ?? '', disabled,
            onChange: (e) => edit({ personaId: e.target.value || null }) }, h('option', { value: '' }, '跟随全局默认'),
            choice.personaId && !presets.some((p) => p.id === choice.personaId)
              ? h('option', { value: choice.personaId, disabled: true }, '已删除的人格，请重新选择') : null,
            presets.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
          h('label', null, '转述范围', h('select', { 'aria-label': '会话转述范围', value: choice.trigger, disabled,
            onChange: (e) => edit({ trigger: e.target.value }) },
            h('option', { value: 'inherit' }, '跟随全局设置'), h('option', { value: 'step' }, '全部汇报'),
            h('option', { value: 'report' }, '仅最终汇报'))),
          h('div', { className: 'dsh-persona-action-buttons' },
            h('button', { type: 'button', disabled: disabled || (!!choice.personaId && !presets.some((p) => p.id === choice.personaId)),
              'data-primary': '', onClick: () => write({ action: 'select', ...choice }) }, '保存会话选择'),
            draft ? h('button', { type: 'button', disabled: busy, onClick: () => { setDraft(null); conversationDrafts.delete(sessionId); setMessage('已放弃未提交的选择。'); } }, '放弃修改') : null),
          h('details', { style: { marginTop: '22px' } }, h('summary', { style: { cursor: 'pointer' } },
            relay?.status === 'pending' ? `等待${name(relay.toPersonaId)}接手 · 查看接力` : '交给另一位角色'),
            h('p', { className: 'dsh-persona-action-note' }, '从下一份原始汇报接手，不重写对方的改写稿，也不接管底层工作。仅共享偏好与适用的会话偏好会继续参考。'),
            relay ? h('div', { className: 'dsh-persona-action-box', role: 'status' },
              `${relay.status === 'pending' ? '等待接手' : relay.status === 'active' ? '上次接力已接手' : '上次接力已取消'}：${name(relay.toPersonaId)}`,
              relay.status === 'pending' ? h('div', { className: 'dsh-persona-action-buttons' },
                h('button', { type: 'button', disabled, onClick: () => write({ action: 'cancel', relayId: relay.id }) }, '取消接力')) : null) : null,
            h('label', null, '接手角色', h('select', { 'aria-label': '接手角色', disabled: disabled || relay?.status === 'pending',
              value: relay?.status === 'pending' ? relay.toPersonaId : target, onChange: (e) => setTarget(e.target.value) }, h('option', { value: '' }, '选择一位角色'),
              presets.filter((p) => p.id !== data.effectivePersonaId).map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
            h('button', { type: 'button', disabled: disabled || !target || relay?.status === 'pending' || !!draft,
              onClick: () => write({ action: 'relay', toPersonaId: target }) }, '安排下一份汇报接力'),
            draft ? h('p', { className: 'dsh-persona-action-note' }, '请先保存或放弃上面的会话选择，再安排接力。') : null))
          : h('p', null, '正在读取…'),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-persona-action-note' }, message || (!data?.ready ? '正在等待保存服务就绪…' : '修改后点击保存。')));
    }

    function ReportFeedback({ sessionId, row, onClose }) {
      const key = rowKey(sessionId, row.seq);
      const [draft, setDraft] = React.useState(() => {
        const existing = feedbackDrafts.get(key);
        if (existing?.scope === 'once') return existing;
        const next = { content: existing?.content ?? '', scope: 'once' };
        if (existing) keepDraft(feedbackDrafts, key, next);
        return next;
      });
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [message, setMessage] = React.useState('');
      const edit = (patch) => { const next = { ...draft, ...patch }; setDraft(next); keepDraft(feedbackDrafts, key, next); };
      const submit = async () => {
        if (busyRef.current || row.retrying || !row.canRetry || !draft.content.trim()) return;
        busyRef.current = true; setBusy(true); setMessage('正在调整，当前正文会保留到新版本完成…');
        try {
          const { ok, value } = await actionRequest('feedback', { sessionId, seq: row.seq, version: row.version,
            personaId: row.speaker.id, content: draft.content, scope: 'once' });
          if (!ok) { setMessage(actionError(value.error)); void refresh(sessionId); return; }
          if (feedbackDrafts.get(key) === draft) {
            feedbackDrafts.delete(key); setDraft({ content: '', scope: 'once' });
          }
          setMessage('已按这次偏好重新转述。'); void refresh(sessionId);
        } catch { setMessage(actionError()); }
        finally { busyRef.current = false; setBusy(false); }
      };
      return h(ActionDialog, { title: '调整这份汇报的表达', onClose },
        h('p', { className: 'dsh-persona-action-note' }, `对应人格：${row.speaker?.name ?? '未知'}。只调整措辞，事实、条件和风险仍以原文为准。`),
        h('label', null, '希望怎么说', h('textarea', { 'aria-label': '表达反馈', maxLength: 240,
          disabled: busy || row.retrying, value: draft.content, placeholder: '例如：少一点调侃，先说结论，再解释原因。',
          onChange: (e) => edit({ content: e.target.value }) })),
        h('p', { className: 'dsh-persona-action-note' }, '仅调整这份汇报。长期偏好与记忆请在插件设置的「记忆与约定」中管理。'),
        !row.canRetry ? h('p', { className: 'dsh-persona-action-note' }, '这份旧汇报缺少可用原文，暂时无法重写。') : null,
        h('div', { className: 'dsh-persona-action-buttons' },
          h('button', { type: 'button', 'data-primary': '', disabled: busy || row.retrying || !draft.content.trim() || !row.canRetry,
            onClick: submit }, busy || row.retrying ? '处理中…' : '重新转述'),
          h('button', { type: 'button', disabled: busy, onClick: () => { feedbackDrafts.delete(key); setDraft({ content: '', scope: 'once' }); setMessage('已清空输入。'); } }, '清空输入')),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-persona-action-note' }, message || '关闭后保留未提交的输入。'));
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
     * Isolated previews and role-chat bubbles use this helper; the transcript uses the full
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
    function renderMarkdown(text, streaming = false, plainStyle) {
      const MarkdownText = shippedMarkdownText();
      if (MarkdownText !== undefined) {
        return h(MarkdownText, { text, streaming, labels: MARKDOWN_LABELS });
      }
      return h('div', { style: plainStyle ? { ...PLAIN_FALLBACK_STYLE, ...plainStyle } : PLAIN_FALLBACK_STYLE }, text);
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
    const headerButtonStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      height: '24px', padding: '0 8px', margin: 0, borderRadius: '999px',
      border: '0.5px solid var(--dsw-alias-border-l2,#d8dce4)',
      background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-secondary,#525c6b)',
      fontFamily: 'inherit', fontSize: '12px', fontWeight: 400, lineHeight: 1, whiteSpace: 'nowrap', cursor: 'pointer',
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
      const [feedbackOpen, setFeedbackOpen] = React.useState(false);
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
      React.useEffect(() => { setFeedbackOpen(false); }, [key, allowed]);

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
          h('span', { style: badgeStyle }, row.speaker?.name ?? '历史人格', row.speaker?.mode === 'relay' ? ' · 转述' : ''),
          h('button', {
            type: 'button', style: toggleStyle, 'aria-expanded': comparisonOpen, 'aria-haspopup': 'dialog',
            onClick: () => setComparison({ key, original: blocks.find((block) => block?.kind === 'text').text, persona: row.text }),
          }, t('shell.showOriginal') ?? 'origin'),
          row.speaker ? h('button', { type: 'button', style: toggleStyle, 'aria-haspopup': 'dialog',
            onClick: () => setFeedbackOpen(true) }, row.retrying ? '正在调整…' : '调整表达') : null,
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
        showHeader && feedbackOpen ? h(ReportFeedback, { key, sessionId, row, onClose: () => setFeedbackOpen(false) }) : null,
        ready && row.feedbackError ? h('small', { role: 'status', style: { display: 'block', color: 'var(--dsw-alias-label-secondary)' } }, row.feedbackError) : null,
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
      '.dsh-persona-preset-name{min-width:0;flex:1 1 130px;overflow-wrap:anywhere;font-size:13px}',
      '.dsh-persona-preset-description{display:block;font-size:11px;line-height:1.5;color:var(--dsh-persona-muted);font-weight:400;white-space:normal;margin-top:3px}',
      '.dsh-persona-preset-tag{font-size:10px;color:var(--dsh-persona-muted);align-self:flex-start;border:1px solid var(--dsh-persona-border);border-radius:4px;padding:0 5px}',
      '.dsh-persona-preset-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex:1 0 100%}',
      '.dsh-persona-preset-actions button{font-size:12px;line-height:1.6}',
      '.dsh-persona-preset-avatar{flex:none;display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--dsh-persona-border);border-radius:12px;background:var(--dsh-persona-soft)}',
      '.dsh-persona-avatar-editor{margin-top:14px;padding:16px;border:1px solid var(--dsh-persona-border);border-radius:10px;background:var(--dsh-persona-soft)}.dsh-persona-avatar-workbench{display:grid;grid-template-columns:128px minmax(0,1fr);gap:18px;align-items:start;margin:14px 0}.dsh-persona-avatar-workbench canvas,.dsh-persona-avatar-preview{display:grid;place-items:center;width:128px;height:128px;border:1px solid var(--dsh-persona-border);border-radius:14px;background:var(--dsh-persona-bg);font-size:26px;color:var(--dsh-persona-accent)}.dsh-persona-avatar-workbench input[type=file]{max-width:100%;font-size:12px}.dsh-persona-avatar-crop{display:grid;gap:8px}.dsh-persona-avatar-crop label{display:flex;gap:12px;align-items:center;font-size:12px}.dsh-persona-avatar-crop input{min-width:0;flex:1;accent-color:var(--dsh-persona-accent)}@media(max-width:520px){.dsh-persona-avatar-workbench{grid-template-columns:minmax(0,1fr)}.dsh-persona-avatar-workbench canvas,.dsh-persona-avatar-preview{justify-self:center}}',
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
      '.dsh-persona-memory-list{position:relative;max-height:min(64vh,680px);overflow:auto;overscroll-behavior:contain;min-width:0;padding-right:4px;scroll-padding:10px}',
      '.dsh-persona-memory-entry{padding:14px 0;border-top:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-memory-entry:first-child{border-top:0}',
      '.dsh-persona-memory-content{font-size:13px;line-height:1.8;margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.dsh-persona-memory-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 8px}',
      '.dsh-persona-memory-toolbar>select{min-width:0;max-width:100%}',
      '.dsh-persona-settings .dsh-persona-memory-toolbar>select{width:auto;max-width:230px;flex:1}',
      '.dsh-persona-settings .dsh-persona-memory .dsh-persona-fold-body select{width:auto;min-width:0;flex:1}',
      '.dsh-persona-memory-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}',
      '.dsh-persona-memory-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.dsh-persona-memory-tabs button{font:inherit;font-size:12px;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:6px 11px;color:var(--dsh-persona-muted);background:transparent}.dsh-persona-memory-tabs button[aria-pressed=true]{color:var(--dsh-persona-text);border-color:var(--dsh-persona-border);background:var(--dsh-persona-soft);font-weight:600}',
      '.dsh-persona-memory button:disabled{opacity:.5;cursor:default}.dsh-persona-memory-review:focus{outline:2px solid var(--dsh-persona-accent);outline-offset:-2px}',
      '.dsh-persona-memory-review,.dsh-persona-memory-editor{border:1px solid var(--dsh-persona-border);border-radius:9px;padding:14px;margin:10px 0;background:var(--dsh-persona-soft);overflow-wrap:anywhere}',
      '.dsh-persona-memory-review-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px}.dsh-persona-memory-evidence blockquote{margin:5px 0 10px;padding:8px 12px;border-left:2px solid var(--dsh-persona-accent);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.8;background:var(--dsh-persona-bg)}',
      '.dsh-persona-usage-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.dsh-persona-usage-stat{padding:10px;border:1px solid var(--dsh-persona-border);border-radius:8px;background:var(--dsh-persona-soft);font-size:11px;color:var(--dsh-persona-muted)}.dsh-persona-usage-stat strong{display:block;font-size:20px;line-height:1.4;font-weight:600;color:var(--dsh-persona-text);font-variant-numeric:tabular-nums}',
      '.dsh-persona-usage-list{max-height:420px;overflow:auto;overscroll-behavior:contain;padding:1px}.dsh-persona-usage-record{border:1px solid var(--dsh-persona-border);border-radius:8px;margin:0 0 8px;overflow-wrap:anywhere}.dsh-persona-usage-record>summary{padding:11px;cursor:pointer;font-size:12px;line-height:1.7}.dsh-persona-usage-record>summary>span{margin-right:8px;display:inline-block;max-width:100%}.dsh-persona-usage-record-body{padding:0 12px 12px;font-size:12px}.dsh-persona-usage-record-body ul{list-style:none;padding:0;margin:7px 0 12px}.dsh-persona-usage-record-body li{padding:6px 0;border-bottom:1px solid var(--dsh-persona-border)}.dsh-persona-usage-reason{display:block;color:var(--dsh-persona-muted);font-size:11px;margin-top:2px}',
      '.dsh-persona-usage-bar{height:6px;display:flex;overflow:hidden;border-radius:8px;background:var(--dsh-persona-border);margin:10px 0}.dsh-persona-usage-bar>span{height:100%;background:var(--dsh-persona-accent)}.dsh-persona-usage-bar[data-sent=false]>span{background:var(--dsh-persona-muted)}',
      '.dsh-persona-memory-editor textarea,.dsh-persona-memory textarea{width:100%;min-height:72px;margin:6px 0;resize:vertical}.dsh-persona-memory-delete{margin-top:10px;font-size:11px}.dsh-persona-memory-review p{margin:8px 0}',
      '.dsh-persona-memory-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}',
      '@media(max-width:600px){.dsh-persona-settings-hero{padding:18px;gap:12px;margin-bottom:15px}.dsh-persona-settings-hero h2{font-size:19px}.dsh-persona-section{padding:16px}.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid,.dsh-persona-persona-tools{grid-template-columns:minmax(0,1fr)}.dsh-persona-preset-grid[data-many="true"]{max-height:430px}.dsh-persona-common-grid{gap:20px}.dsh-persona-fold>summary{padding-left:15px}.dsh-persona-fold-body{padding:15px}.dsh-persona-inline-fold>summary{padding-left:0}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding-left:0;padding-right:0}}',
      '@media(max-width:400px){.dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-fold-note{font-size:11px}.dsh-persona-fold-badge{font-size:10px;padding:0 5px}}',
    ].join('\n');

    const SETTINGS_REDESIGN_CSS = `
      .dsh-persona-settings[data-persona-shell=settings]{max-width:800px;font:14px/1.65 system-ui,"Microsoft YaHei",sans-serif;padding:4px 0 20px;--dsh-persona-accent:var(--dsw-alias-brand-primary,#4d63d8);--dsh-persona-wash:color-mix(in srgb,var(--dsh-persona-accent) 6%,var(--dsh-persona-bg))}
      .dsh-persona-settings [hidden]{display:none!important}
      .dsh-persona-settings .dsh-persona-settings-hero{padding:0 0 18px;margin:0;border:0;border-radius:0;background:none;gap:12px;align-items:center}
      .dsh-persona-settings .dsh-persona-settings-hero h2{font-size:20px;font-weight:650;letter-spacing:-.02em;margin:0 0 5px}
      .dsh-persona-settings .dsh-persona-settings-hero p{font-size:13px;color:var(--dsh-persona-muted);margin:0}
      .dsh-persona-settings .dsh-persona-save-state{border:0;padding:0;background:none;font-size:11px;display:inline-flex;align-items:center;gap:6px}
      .dsh-persona-settings .dsh-persona-save-state::before{content:'';width:6px;height:6px;border-radius:50%;background:#539574;flex:none}
      .dsh-persona-settings .dsh-persona-save-state[data-state=pending]::before{background:#7884bc}
      .dsh-persona-settings .dsh-persona-save-state[data-state=error]::before{background:#c66d55}
      .dsh-persona-settings .dsh-persona-settings-tabs{display:flex;gap:8px;padding:0 0 1px;margin:0 0 24px;border-bottom:1px solid var(--dsh-persona-border);overflow:auto;scrollbar-width:thin}
      .dsh-persona-settings button{font-family:inherit!important;font-size:12px!important;line-height:1.5!important;min-height:28px;padding:4px 10px!important;border-radius:7px!important;border:1px solid var(--dsh-persona-border)!important;transition:background .12s,border-color .12s}
      .dsh-persona-settings button:hover:not(:disabled){filter:brightness(.96)}
      .dsh-persona-settings .dsh-persona-settings-tabs button{position:relative;flex:1;min-width:48px;min-height:38px;padding:8px 10px!important;border:0!important;border-radius:0!important;background:none;color:var(--dsh-persona-muted);font-size:13px!important;font-weight:500;white-space:nowrap}
      .dsh-persona-settings .dsh-persona-settings-tabs button[aria-selected=true]{color:var(--dsh-persona-accent);font-weight:650}
      .dsh-persona-settings .dsh-persona-settings-tabs button[aria-selected=true]::after{content:'';position:absolute;bottom:0;left:16px;right:16px;height:2px;border-radius:2px;background:var(--dsh-persona-accent)}
      .dsh-persona-settings .dsh-persona-section{padding:0;margin:0;border:0;border-radius:0;background:none}
      .dsh-persona-settings .dsh-persona-section-heading{margin-bottom:18px;gap:0}
      .dsh-persona-settings .dsh-persona-step{display:none}
      .dsh-persona-settings .dsh-persona-section-heading h3{font-size:15px;font-weight:650;margin:0 0 4px}
      .dsh-persona-settings .dsh-persona-section-heading p{font-size:12px;line-height:1.6}
      .dsh-persona-settings .dsh-persona-preset-grid{grid-auto-rows:1fr;gap:10px;padding:1px;max-height:none}
      .dsh-persona-settings .dsh-persona-preset-grid[data-many=true]{max-height:400px}
      .dsh-persona-settings .dsh-persona-preset{align-items:center;padding:14px;gap:10px;border-radius:10px;border-color:var(--dsh-persona-border);background:var(--dsh-persona-bg)}
      .dsh-persona-settings .dsh-persona-preset-avatar{width:46px;height:46px;border-radius:11px;border-color:color-mix(in srgb,var(--dsh-persona-border) 60%,transparent)}
      .dsh-persona-settings .dsh-persona-preset-name{flex:1 1 100px;font-size:14px;line-height:1.45}
      .dsh-persona-settings .dsh-persona-preset-description{font-size:12px;line-height:1.55;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .dsh-persona-settings .dsh-persona-preset-tag{font-size:10px;padding:1px 5px;border:0;background:var(--dsh-persona-soft);border-radius:4px;align-self:flex-start}
      .dsh-persona-settings .dsh-persona-preset-actions{gap:7px;margin-top:2px;min-height:28px}
      .dsh-persona-settings .dsh-persona-selected-label{font-size:11px;color:var(--dsh-persona-accent);display:flex;align-items:center;gap:5px}
      .dsh-persona-settings .dsh-persona-selected-label::before{content:'✓';font-weight:650}
      .dsh-persona-settings .dsh-persona-persona-tools{margin-top:18px;gap:10px}
      .dsh-persona-settings .dsh-persona-fold{border-radius:9px;background:none;border-color:var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-fold>summary{padding:12px 34px 12px 13px;min-height:58px;gap:10px}
      .dsh-persona-settings .dsh-persona-fold>summary::after{right:13px;font-size:16px}
      .dsh-persona-settings .dsh-persona-fold-title{font-size:12px;font-weight:600}
      .dsh-persona-settings .dsh-persona-fold-note{font-size:11px}
      .dsh-persona-settings .dsh-persona-fold-body{padding:15px}
      .dsh-persona-settings .dsh-persona-inline-fold>summary{min-height:30px;padding:3px 24px 3px 0}
      .dsh-persona-settings .dsh-persona-inline-fold>.dsh-persona-fold-body{padding:10px 0}
      .dsh-persona-settings .dsh-persona-process-options{padding:18px 0;margin:0;border-bottom:1px solid var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-common-grid{padding:18px 0;margin:0;gap:20px;border-bottom:1px solid var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-common-grid>div{min-width:0}
      .dsh-persona-settings .dsh-persona-advanced-grid{gap:22px}
      .dsh-persona-settings input,.dsh-persona-settings select,.dsh-persona-settings textarea{font-size:13px!important}
      .dsh-persona-settings textarea,.dsh-persona-settings select,.dsh-persona-settings input:not([type=checkbox]):not([type=range]):not([type=file]){border-radius:7px!important;min-height:34px}
      .dsh-persona-settings .dsh-persona-footer-note{padding-top:14px;margin-top:22px;border-top:1px solid var(--dsh-persona-border);font-size:11px}
      .dsh-persona-settings .dsh-persona-avatar-editor{background:var(--dsh-persona-soft)}
      .dsh-persona-settings .dsh-persona-memory-toolbar{margin-top:18px}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-hero{align-items:flex-start}.dsh-persona-settings .dsh-persona-save-state{padding-top:6px}.dsh-persona-settings .dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-settings .dsh-persona-preset{padding:12px}.dsh-persona-settings .dsh-persona-persona-tools,.dsh-persona-settings .dsh-persona-common-grid,.dsh-persona-settings .dsh-persona-advanced-grid{grid-template-columns:minmax(0,1fr)}}
      @media(prefers-reduced-motion:reduce){.dsh-persona-settings button{transition:none}}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-tabs{gap:4px}.dsh-persona-settings .dsh-persona-settings-tabs button{padding:8px 6px!important}}
    `;
    function settingsHeading(number, title, note) {
      return h('div', { className: 'dsh-persona-section-heading' }, h('span', { className: 'dsh-persona-step', 'aria-hidden': true }, number),
        h('div', null, h('h3', null, title), h('p', null, note)));
    }

    const USAGE_SECTIONS = [
      { label: '工作转述', keys: ['rewrite', 'progress'], tone: 'rewrite' },
      { label: '聊天室', keys: ['chat', 'chat-participation', 'reply-suggestions'], tone: 'chat' },
      { label: '其他功能', keys: ['preset', 'memory'], tone: 'other' },
    ];
    const USAGE_NAMES = { rewrite: '汇报改写', progress: '静默播报', chat: '角色发言',
      'chat-participation': '接话判断', 'reply-suggestions': '快捷回复', preset: '预设生成', memory: '记忆提取' };
    const usageNumber = (n) => Number.isSafeInteger(n) && n >= 0 ? n.toLocaleString('zh-CN') : '—';
    const usageTokens = (m) => m.calls > 0 && !m.usageCalls ? '未上报' : usageNumber(m.totalTokens);
    const usageDay = (iso) => String(iso ?? '').slice(5).replace('-', '/');
    const MODEL_USAGE_CSS = `
      .dsh-model-usage{--usage-ink:var(--dsh-persona-text);--usage-quiet:var(--dsh-persona-muted);--usage-rule:var(--dsh-persona-border);--usage-first:var(--dsw-alias-brand-primary,#4e6ebb);--usage-second:#398879;--usage-third:#b78544;container-type:inline-size;color:var(--usage-ink);font-variant-numeric:tabular-nums}
      .dsh-model-usage h3,.dsh-model-usage h4,.dsh-model-usage p,.dsh-model-usage figure{margin:0}
      .dsh-model-usage small,.dsh-model-usage p,.dsh-model-usage figcaption{font-size:12px;color:var(--usage-quiet);line-height:1.6}
      .dsh-model-usage .mu-head,.dsh-model-usage .mu-actions,.dsh-model-usage .mu-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-model-usage .mu-head{justify-content:space-between;gap:9px 20px;margin-bottom:14px}
      .dsh-model-usage h3{font-size:16px;font-weight:650}.dsh-model-usage h4{font-size:14px;font-weight:650}
      .dsh-model-usage .mu-range{display:inline-flex;border-radius:9px;background:var(--dsh-persona-soft);padding:3px;gap:1px}
      .dsh-model-usage .mu-range button{min-height:27px;padding:3px 9px!important;border:0!important;line-height:1.5;background:transparent;color:var(--usage-quiet)}
      .dsh-model-usage .mu-range button[aria-pressed=true]{background:var(--dsh-persona-bg);color:var(--usage-ink);box-shadow:0 1px 3px #0002;font-weight:650}
      .dsh-model-usage .mu-refresh{background:transparent;color:var(--usage-quiet)}
      .dsh-model-usage .mu-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px 26px;padding:18px;border:1px solid var(--usage-rule);border-radius:14px;background:linear-gradient(115deg,var(--dsh-persona-wash),var(--dsh-persona-bg) 85%)}
      .dsh-model-usage .mu-metric{display:block;font-size:clamp(24px,5cqi,38px);font-weight:650;line-height:1.2;letter-spacing:-.035em;overflow-wrap:anywhere;margin:4px 0}
      .dsh-model-usage .mu-metric[data-unknown=true]{font-size:23px}
      .dsh-model-usage .mu-chart{display:flex;flex-direction:column;min-width:0;align-self:center}
      .dsh-model-usage .mu-bars{display:flex;align-items:end;gap:clamp(2px,.6cqi,5px);height:46px;margin:5px 0 0;border-bottom:1px solid var(--usage-rule)}
      .dsh-model-usage .mu-bars i{flex:1;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--usage-first) 65%,var(--dsh-persona-bg))}.dsh-model-usage .mu-bars i:only-child{max-width:36px}
      .dsh-model-usage .mu-bars i:last-child{background:var(--usage-first)}.dsh-model-usage .mu-dates{display:flex;justify-content:space-between;font-size:10px;color:var(--usage-quiet)}
      .dsh-model-usage .mu-card{padding-top:20px}.dsh-model-usage .mu-legend{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
      .dsh-model-usage .mu-card .mu-head{margin:0}.dsh-model-usage .mu-head select{width:auto;font:inherit;color:var(--usage-ink);background:var(--dsh-persona-bg);border:1px solid var(--usage-rule);padding:3px 7px}
      .dsh-model-usage .mu-share{display:flex;height:9px;gap:2px;background:var(--dsh-persona-soft);border-radius:6px;overflow:hidden;margin:11px 0}
      .dsh-model-usage [data-tone=rewrite]{--tone:var(--usage-first)}.dsh-model-usage [data-tone=chat]{--tone:var(--usage-second)}.dsh-model-usage [data-tone=other]{--tone:var(--usage-third)}
      .dsh-model-usage .mu-share i{background:var(--tone)}.dsh-model-usage .mu-label{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600}
      .dsh-model-usage .mu-label::before{content:'';width:8px;height:8px;border-radius:2px;background:var(--tone);flex:none}
      .dsh-model-usage .mu-legend small{display:block}.dsh-model-usage .mu-panel{border:1px solid var(--usage-rule);border-radius:10px;margin-top:8px}
      .dsh-model-usage .mu-model+ .mu-model{border-top:1px solid var(--usage-rule)}
      .dsh-model-usage .mu-model>summary{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;list-style:none}
      .dsh-model-usage .mu-model>summary::-webkit-details-marker{display:none}
      .dsh-model-usage .mu-model>summary::after{content:'›';display:block;transform:rotate(90deg);color:var(--usage-quiet)}
      .dsh-model-usage .mu-model[open]>summary::after{transform:rotate(-90deg)}
      .dsh-model-usage .mu-model strong{font-size:13px;overflow-wrap:anywhere}.dsh-model-usage .mu-model small{display:block}.dsh-model-usage .mu-model-amount{text-align:right;font-size:13px}
      .dsh-model-usage .mu-breakdown{border-top:1px dashed var(--usage-rule);margin:0 12px;padding:6px 0 9px}.dsh-model-usage .mu-breakdown .mu-line{justify-content:space-between;font-size:12px;padding:2px 0}
      .dsh-model-usage .mu-foot{margin-top:16px}.dsh-model-usage .mu-foot>summary{font-size:12px;color:var(--usage-quiet);cursor:pointer}
      .dsh-model-usage .mu-foot p{margin-top:6px}.dsh-model-usage .mu-notice{border:1px dashed var(--usage-rule);border-radius:12px;padding:20px;color:var(--usage-quiet)}
      .dsh-model-usage .mu-notice strong{display:block;font-size:14px;color:var(--usage-ink);margin-bottom:4px}
      @container(max-width:470px){.dsh-model-usage .mu-hero{grid-template-columns:minmax(0,1fr);gap:12px;padding:14px}.dsh-model-usage .mu-bars{height:35px}.dsh-model-usage .mu-legend{gap:6px}.dsh-model-usage .mu-legend small{font-size:11px}.dsh-model-usage .mu-metric{font-size:29px}}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-tabs{gap:2px}.dsh-persona-settings .dsh-persona-settings-tabs button{min-width:37px;padding:8px 3px!important}}
    `;

    function ModelUsagePanel({ visible }) {
      const [days, setDays] = React.useState(7);
      const [revision, refresh] = React.useState(0);
      const [snapshot, setSnapshot] = React.useState(null);
      const [source, setSource] = React.useState('all');
      React.useEffect(() => {
        if (!visible) return;
        const ctl = new AbortController();
        setSnapshot({ days, state: 'loading' });
        (async () => {
          try {
            const res = await fetch(ROUTE + '/model-usage?days=' + days, { signal: ctl.signal });
            if (!res.ok) throw Error();
            const data = await res.json();
            if (data?.days !== days || !Number.isSafeInteger(data.totals?.calls)
              || !['daily', 'purposes', 'models', 'breakdown'].every((key) => Array.isArray(data[key]))) throw Error();
            if (!ctl.signal.aborted) setSnapshot({ days, state: 'ready', data });
          } catch {
            if (!ctl.signal.aborted) setSnapshot({ days, state: 'error' });
          }
        })();
        return () => ctl.abort();
      }, [days, revision, visible]);
      const state = snapshot?.days === days ? snapshot.state : 'loading';
      const data = state === 'ready' ? snapshot.data : null;
      const line = (name, content, key) => h('div', { className: 'mu-line', key }, h('span', null, name), h('span', null, content));
      const summary = () => {
        const { totals, daily, models, breakdown } = data;
        const inSection = (section, purpose) => section.keys.includes(purpose)
          || (section.tone === 'other' && !USAGE_SECTIONS.some((s) => s.keys.includes(purpose)));
        const addMetrics = (rows) => Object.fromEntries(['calls', 'usageCalls', 'totalTokens', 'inputTokens',
          'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'].map((key) => [key, rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)]));
        const groups = USAGE_SECTIONS.map((section) => {
          const rows = data.purposes.filter(({ purpose }) => inSection(section, purpose));
          return { ...section, ...addMetrics(rows) };
        });
        const section = USAGE_SECTIONS.find((s) => s.tone === source);
        const selectedRows = section ? breakdown.filter((r) => inSection(section, r.purpose)) : breakdown;
        const groupKey = (m) => JSON.stringify([m.provider, m.model]);
        const byModel = new Map();
        for (const row of selectedRows) {
          const key = groupKey(row);
          if (!byModel.has(key)) byModel.set(key, []);
          byModel.get(key).push(row);
        }
        const modelRows = section ? Array.from(byModel.values(), (rows) =>
          ({ provider: rows[0].provider, model: rows[0].model, ...addMetrics(rows) })) : [...models];
        const shareKey = totals.totalTokens > 0 ? 'totalTokens' : 'calls';
        const peak = Math.max(1, ...daily.map((day) => day.calls));
        const known = totals.usageCalls > 0;
        return h(React.Fragment, null,
          h('div', { className: 'mu-hero' },
            h('div', null, h('small', null, '已上报 token'), h('strong', { className: 'mu-metric', 'data-unknown': !known }, usageTokens(totals)),
              h('p', null, '共 ' + usageNumber(totals.calls) + ' 次调用 · ' + usageNumber(totals.usageCalls) + ' 次有用量回执'),
              totals.failedCalls ? h('p', null, '其中 ' + usageNumber(totals.failedCalls) + ' 次未正常完成') : null),
            h('figure', { className: 'mu-chart', 'aria-label': '每日调用次数' }, h('figcaption', null, days === 1 ? '今天的调用' : '每日调用'),
              h('div', { className: 'mu-bars', role: 'img', 'aria-label': daily.map((d) => usageDay(d.date) + '：' + d.calls + ' 次').join('；') },
                ...daily.map((d) => h('i', { key: d.date, title: d.date + ' · ' + d.calls + ' 次',
                  style: { height: d.calls ? Math.max(5, 100 * d.calls / peak) + '%' : '0%' } }))),
              h('div', { className: 'mu-dates' }, h('span', null, usageDay(daily[0]?.date)), daily.length > 1 ? h('span', null, usageDay(daily.at(-1)?.date)) : null))),
          h('section', { className: 'mu-card', 'aria-label': '按用途' }, h('h4', null, '用在哪里'), h('p', null,
            shareKey === 'totalTokens' ? '色带表示各用途占已上报 token 的比例。' : '暂无可比较的 token 消耗，色带按调用次数展示。'),
            h('div', { className: 'mu-share', 'aria-hidden': true }, ...groups.filter((g) => g[shareKey] > 0).map((g) =>
              h('i', { key: g.tone, 'data-tone': g.tone, style: { flex: g[shareKey] } }))),
            h('div', { className: 'mu-legend' }, ...groups.map((g) => h('div', { key: g.tone, 'data-tone': g.tone },
              h('span', { className: 'mu-label' }, g.label), h('small', null, usageNumber(g.calls) + ' 次'),
              h('small', null, g.calls && !g.usageCalls ? 'token 未上报' : usageNumber(g.totalTokens) + ' token'))))),
          h('section', { className: 'mu-card', 'aria-label': '按模型' },
            h('div', { className: 'mu-head' }, h('div', null, h('h4', null, '模型明细'), h('p', null, '展开模型可查看调用与 token 构成。')),
              h('select', { 'aria-label': '筛选模型用途', value: source, onChange: (e) => setSource(e.target.value) },
                h('option', { value: 'all' }, '全部用途'), ...USAGE_SECTIONS.map((s) => h('option', { key: s.tone, value: s.tone }, s.label)))),
            !modelRows.length ? h('p', { className: 'mu-notice' }, '这个时段内没有此用途的调用。') :
            h('div', { className: 'mu-panel' }, ...modelRows.sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens).map((m) => {
              const rows = byModel.get(groupKey(m)) ?? [];
              const tokens = [['inputTokens', '未缓存输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'],
                ['outputTokens', '输出']].filter(([key]) => m[key] > 0).map(([key, label]) => label + ' ' + usageNumber(m[key]));
              return h('details', { className: 'mu-model', key: groupKey(m) },
                h('summary', null, h('div', null, h('strong', null, m.model === '(other)' ? '其他模型（合并）' :
                  !m.model || m.model === '(unknown)' ? '未标明模型' : m.model),
                  h('small', null, m.provider === '(other)' ? '合并统计' : !m.provider || m.provider === '(unknown)' ? '未标明提供方' : m.provider)),
                  h('div', { className: 'mu-model-amount' }, usageNumber(m.calls) + ' 次', h('small', null, m.usageCalls ? usageTokens(m) + ' token' : 'token 未上报'))),
                h('div', { className: 'mu-breakdown' }, ...rows.map((r) => line(USAGE_NAMES[r.purpose] ?? '其他用途',
                  usageNumber(r.calls) + ' 次 · ' + (r.usageCalls ? usageTokens(r) + ' token' : 'token 未上报'), r.purpose)),
                  h('small', null, usageNumber(m.usageCalls) + ' / ' + usageNumber(m.calls) + ' 次有用量回执'),
                  tokens.length ? h('small', null, '已上报 token：' + tokens.join(' · ')) : null,
                  m.usageCalls && m.reasoningTokens > 0 ? h('small', null, '其中推理 ' + usageNumber(m.reasoningTokens) + '（已含在输出，不重复计入）') : null));
            }))),
          h('details', { className: 'mu-foot' }, h('summary', null, '统计口径与费用'), h('p', null,
            '每次实际发出的模型请求计一次，重试与多人发言分别计数。时间按本地自然日划分。没有回执的请求只计次数；未提供货币账单，不估算金额。')));
      };
      return h('section', { className: 'dsh-model-usage', 'aria-label': '模型用量' },
        h('style', null, MODEL_USAGE_CSS),
        h('div', { className: 'mu-head' }, h('div', null, h('h3', null, '模型用量'), h('p', null, '只统计人格套壳发起的模型调用。')),
          h('div', { className: 'mu-actions' }, h('div', { className: 'mu-range', role: 'group', 'aria-label': '统计时段' },
            ...[[1, '今天'], [7, '近 7 天'], [30, '近 30 天']].map(([n, label]) => h('button', {
              type: 'button', key: n, 'aria-pressed': n === days, onClick: () => setDays(n) }, label))),
            h('button', { type: 'button', className: 'mu-refresh', disabled: state === 'loading', onClick: () => refresh((n) => n + 1) }, '刷新'))),
        data && ['failed', 'memory-only'].includes(data.persistence) ? h('p', { role: 'status', style: { marginBottom: '10px' } },
          data.persistence === 'failed' ? '最近一次保存失败，这部分用量可能无法在重启后保留。' : '本地存储不可用，当前记录仅在这次运行中保留。') : null,
        data?.totals.calls ? summary() : h('div', { className: 'mu-notice', role: 'status' },
          h('strong', null, state === 'error' ? '暂时读不到用量' : data ? '这段时间还没有调用记录' : '正在读取用量…'),
          h('p', null, state === 'error' ? '可以点击刷新重试。' : data ? '从启用统计后的第一次模型调用开始记录，也可以切换时段查看。' : '')));
    }

    function settingsFold(id, title, description, content, options = {}) {
      return h('details', { className: 'dsh-persona-fold' + (options.compact ? ' dsh-persona-inline-fold' : ''), 'data-settings-fold': id, open: options.open, onToggle: options.onToggle },
        h('summary', null, h('span', null, h('span', { className: 'dsh-persona-fold-title' }, title),
          h('span', { className: 'dsh-persona-fold-note' }, description)),
        options.badge ? h('span', { className: 'dsh-persona-fold-badge' }, options.badge) : null),
        h('div', { className: 'dsh-persona-fold-body' }, content));
    }

    function MemoryUsagePanel({ data, presets, settings, filter, refresh, busy, scopePending }) {
      const [channel, setChannel] = React.useState('all');
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshInfo, setRefreshInfo] = React.useState('');
      const refreshState = React.useRef({ busy: false, personaId: undefined });
      refreshState.current.personaId = data?.activePersonaId;
      React.useEffect(() => { setRefreshInfo(''); }, [data?.activePersonaId]);
      const reload = async () => {
        if (refreshState.current.busy || busy || scopePending) return;
        const personaId = data?.activePersonaId;
        refreshState.current.busy = true; setRefreshing(true); setRefreshInfo('');
        try {
          const ok = await refresh();
          if (refreshState.current.personaId === personaId) setRefreshInfo(ok ? '已刷新' : '暂未更新，已有记录仍保留，请稍后重试。');
        } catch { if (refreshState.current.personaId === personaId) setRefreshInfo('暂未更新，已有记录仍保留，请稍后重试。'); }
        finally { refreshState.current.busy = false; setRefreshing(false); }
      };
      const channels = { report: '汇报转述', process: '过程转述与补充', retry: '单次重说', progress: '静默播报', chat: '角色聊天' };
      const outcomes = { pending: '请求进行中', generated: '转述已生成', rejected: '生成内容未采用',
        failed: '生成未完成', cancelled: '请求已取消', interrupted: '重启前结束状态未知' };
      const reasons = { candidate: '等待确认', superseded: '已被替代', rejected: '已忽略', retracted: '已撤销',
        expired: '已过期', 'not-expression': '共同经历或会话情况，不用于表达转述', overridden: '已有优先级更高的同类偏好',
        budget: '超出本次内容预算', limit: '超出本次条数上限' };
      const name = (id) => presets.find((p) => p.id === id)?.name ?? '已移除的人格';
      const allRecords = scopePending || data?.usage?.version !== 1 ? [] : (data.usage.records ?? []);
      const records = allRecords.filter((record) =>
        (filter === 'all' || record.personaId === data.activePersonaId) && (channel === 'all' || channel === record.channel)).slice().reverse();
      const sent = (record) => Number.isFinite(record.sentAt);
      const resolve = (ref, record, selected) => {
        const entry = (data.entries ?? []).find((e) => e.id === ref.id && e.version === ref.version);
        const allowed = entry && (entry.scope === 'shared' || (entry.scope === 'persona' && entry.personaId === record.personaId)
          || (entry.scope === 'session' && entry.sessionId === record.sessionId && (!entry.personaId || entry.personaId === record.personaId)));
        if (!allowed || (selected && (entry.status !== 'active' || (entry.expiresAt !== null && entry.expiresAt <= Date.now())))) return undefined;
        return entry.content;
      };
      const list = records.map((record) => {
        const provided = sent(record); const total = record.selected.length + record.omitted.length;
        const selectionLabel = (provided ? '已提供 ' : '准备选入 ') + record.selected.length + ' 条';
        const refList = (refs, selected) => refs.length ? h('ul', null, ...refs.map((ref) => h('li', { key: ref.id },
          resolve(ref, record, selected) ?? '原版本已更改、删除或不再适用，无法展示当时内容。',
          !selected ? h('span', { className: 'dsh-persona-usage-reason' }, reasons[ref.reason] ?? '本次未选中') : null)))
          : h('p', { style: hintStyle }, selected ? '本次没有选入表达偏好。' : '没有其他同范围记忆被排除。');
        return h('details', { key: record.id, className: 'dsh-persona-usage-record', 'data-memory-usage': record.id },
          h('summary', null, h('span', null, channels[record.channel]), h('span', { style: hintStyle }, name(record.personaId)),
            h('span', { style: hintStyle }, new Date(record.at).toLocaleString()), h('span', { style: { whiteSpace: 'nowrap' } }, selectionLabel)),
          h('div', { className: 'dsh-persona-usage-record-body' },
            h('p', { style: hintStyle }, (record.sessionId === data.sessionId ? '当前会话' : '其他会话') + ' · '
              + (provided ? '已提供给模型请求' : '尚未提供给模型请求') + ' · ' + (outcomes[record.outcome] ?? '状态未知')),
            total ? h('div', { className: 'dsh-persona-usage-bar', 'data-sent': String(provided), role: 'img',
              'aria-label': selectionLabel + '，未选中 ' + record.omitted.length + ' 条' },
              h('span', { style: { width: (record.selected.length / total * 100) + '%' } })) : null,
            h('strong', null, provided ? '已提供的偏好' : '准备选入的偏好（尚未提供）'), refList(record.selected, true),
            record.omitted.length ? h('details', null, h('summary', { style: hintStyle }, '为什么其他 ' + record.omitted.length + ' 条没有选中'),
              refList(record.omitted, false)) : null));
      });
      const content = h('section', { 'aria-label': '记忆使用情况', 'data-persona-shell': 'memory-usage' },
        h('p', { style: hintStyle }, '这里只记录偏好是否提供给模型，不代表模型一定遵守。只保留最近 24 次请求，不保存原话或汇报副本。'),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('select', { style: inputStyle, value: channel, 'aria-label': '筛选使用渠道', onChange: (e) => setChannel(e.target.value) },
            h('option', { value: 'all' }, '所有发言渠道'), ...Object.entries(channels).map(([id, label]) => h('option', { key: id, value: id }, label))),
          h('button', { type: 'button', style: toggleStyle, disabled: busy || scopePending || refreshing, onClick: reload }, refreshing ? '正在刷新…' : '刷新使用情况'),
          h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, refreshInfo)),
        h('div', { className: 'dsh-persona-usage-stats' }, ...[
          ['已记录请求', records.length], ['提供了偏好', records.filter((r) => sent(r) && r.selected.length > 0).length],
          ['未发出请求', records.filter((r) => !sent(r)).length],
        ].map(([label, value]) => h('div', { key: label, className: 'dsh-persona-usage-stat' }, h('strong', null, value), label))),
        settings.memory === false ? h('p', { style: hintStyle }, '记忆已关闭，暂停记录新的使用情况；已有记录保留。') : null,
        data?.usage?.persistence === 'failed' ? h('p', { style: hintStyle }, '最近记录暂未保存成功，重启后可能丢失；不影响正常转述。') : null,
        h('div', { className: 'dsh-persona-usage-list' }, ...list),
        records.length === 0 ? h('p', { style: hintStyle }, scopePending ? '正在读取使用情况…'
          : '这个筛选下还没有记录。开启记忆后发起人格转述，即可在这里查看。') : null,
        filter !== 'all' && records.length === 0 && allRecords.some((record) => record.personaId !== data?.activePersonaId
          && (channel === 'all' || record.channel === channel))
          ? h('p', { style: hintStyle }, '其他人格还有记录，可在上方选择「全部人格」查看。') : null,
        h('p', { style: hintStyle }, '跟随上方人格筛选。展开面板时刷新，也可以手动刷新；不会在聊天中显示。'));
      return settingsFold('memory-usage', '最近使用情况', '看看偏好有没有提供，以及未选中的原因', content,
        { badge: records.length ? records.length + ' 次' : undefined,
          onToggle: (event) => { if (event.target === event.currentTarget && event.currentTarget.open) void reload(); } });
    }

    function personaSummary(preset) {
      if (preset.builtin) {
        if (preset.id === '大肥鱼（默认）') return '鲸鲸的轻松口吻';
        if (preset.id === '大肥龙') return 'GPT，直爽又有主见';
        if (preset.id === 'Claude小姐') return '理性、克制，规矩感强';
        if (preset.id === '鲸鲸（实验性）') return '转达原助手「姐姐」的汇报';
        if (preset.id === 'Gemini') return '猫猫，好奇心旺，接梗快';
      }
      return (preset.pack?.identity ?? '你自己的说话风格').replace(/\s+/g, ' ').slice(0, 36);
    }

    const memoryAddDrafts = new Map();
    const memoryEditDrafts = new Map();
    function MemoryPanel({ settings, save, presets }) {
      const [data, setData] = React.useState(undefined);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const revision = React.useRef(0);
      const currentPreset = React.useRef(settings.presetName);
      currentPreset.current = settings.presetName;
      const expectedPersona = presets.find((p) => p.name === settings.presetName)?.id;
      const draftKey = expectedPersona ?? settings.presetName;
      const [manual, setManual] = React.useState(() => memoryAddDrafts.get(draftKey)
        ?? { content: '', kind: 'preference', scope: 'persona' });
      const editManual = (patch) => {
        const next = { ...manual, ...patch }; setManual(next); keepDraft(memoryAddDrafts, draftKey, next);
      };
      const scopePending = !data || (data.activePresetName !== undefined
        ? data.activePresetName !== settings.presetName : expectedPersona && expectedPersona !== data.activePersonaId);
      const [filter, setFilter] = React.useState('current');
      const [view, setView] = React.useState('active');
      const memoryList = React.useRef(null);
      const focusOperation = React.useRef(undefined);
      const [editing, setEditing] = React.useState(undefined);
      const [editDraft, setEditDraft] = React.useState({ content: '', statement: '' });
      const [clearConfirm, setClearConfirm] = React.useState(false);
      React.useEffect(() => {
        const list = memoryList.current;
        if (!list) return;
        const review = [...list.querySelectorAll('[data-memory-operation]')].find((el) => el.dataset.memoryOperation === focusOperation.current);
        if (review) {
          list.scrollTop = review.offsetTop;
          review.focus({ preventScroll: true });
          review.querySelector('.dsh-persona-memory-review-heading')?.scrollIntoView({ block: 'nearest' });
          focusOperation.current = undefined;
        }
      }, [data, view]);
      const labels = { preference: '表达偏好', agreement: '互动约定', context: '会话情况', episode: '共同经历',
        active: '使用中', candidate: '待核对', superseded: '已替代', rejected: '已忽略', retracted: '已撤销',
        manual: '手动记录', explicit: '用户明确表达', model: '后台整理', legacy: '旧版迁移', correction: '已确认更正' };
      const personaName = (id) => presets.find((p) => p.id === id)?.name ?? '已移除的人格';
      const scopeLabel = (entry) => entry.scope === 'shared' ? '所有人格共享'
        : entry.scope === 'persona' ? '仅 ' + personaName(entry.personaId)
        : (entry.sessionId === data?.sessionId ? '当前会话' : '会话 ' + String(entry.sessionId).slice(0, 16))
          + (entry.personaId ? ' · 仅 ' + personaName(entry.personaId) : ' · 角色共享');
      const errorText = (code) => ({
        'memory-conflict': '记录已变化，尚未应用这次操作。请刷新后重新核对；草稿会保留。',
        'storage-not-ready': '存储尚未就绪，请稍后重试。',
        'memory-save-failed': '保存失败，内容仍保留，请稍后重试。',
        'memory-capacity': '记忆已满，请删除不再需要的历史记录。',
        'memory-operation-capacity': '待确认项目已满，请先处理不再需要的项目。',
        'memory-target-inactive': '这条记录已失效，请刷新后核对当前记录。',
        'memory-statement-required': '请留下你这次更正或撤销的原话。',
        'invalid-memory-replacement': '请填写与旧记录不同的新内容。',
        'private-memory-needs-scope': '互动约定和共同经历请保留在对应人格或会话中。',
        'memory-extraction-disabled': '请先开启记忆与后台整理。',
      }[code] ?? '操作未完成，输入仍保留，请刷新后重试。');
      const refresh = async () => {
        if (busyRef.current) return false;
        const token = ++revision.current;
        try {
          const response = await fetch(ROUTE + '/memory');
          if (!response.ok) throw new Error('load');
          const value = await response.json();
          if (revision.current === token) {
            setData(value);
            setNotice((previous) => previous.startsWith('暂时无法读取记忆') ? '' : previous);
            return true;
          }
          return false;
        } catch {
          if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。');
          return false;
        }
      };
      React.useEffect(() => {
        setManual(memoryAddDrafts.get(draftKey) ?? { content: '', kind: 'preference', scope: 'persona' });
        setEditing(undefined); setClearConfirm(false); setNotice('');
        // A persona change retires the old response, even if it is still saving.
        revision.current += 1;
        void (async () => {
          const token = revision.current;
          try {
            const response = await fetch(ROUTE + '/memory');
            if (!response.ok) throw new Error('load');
            const value = await response.json();
            if (revision.current === token) setData(value);
          } catch { if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。'); }
        })();
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
          if (revision.current !== token) return false;
          if (['propose', 'propose-add'].includes(body.action)) focusOperation.current = value.result?.id;
          setData(value); setNotice(body.action === 'consolidate' ? '已安排整理，稍后可刷新查看。'
            : ['propose', 'propose-add'].includes(body.action) ? '已生成核对单，确认前不会改变正在使用的记忆。'
            : body.action === 'confirm' ? '已确认，后续转述会使用新状态；历史汇报保持原样。'
            : body.action === 'dismiss' ? '已放弃这次操作，原记录保持原样。' : '已保存');
          return true;
        } catch (error) {
          if (revision.current === token) setNotice(errorText(error.message));
          return false;
        } finally { busyRef.current = false; setBusy(false); }
      };
      const scoped = (entry) => filter === 'all' || entry.scope === 'shared'
        || (entry.scope === 'persona' && entry.personaId === data?.activePersonaId)
        || (entry.scope === 'session' && entry.sessionId === data?.sessionId
          && (!entry.personaId || entry.personaId === data?.activePersonaId));
      const live = (entry) => entry.status === 'active' && (entry.expiresAt === null || entry.expiresAt > Date.now());
      const all = scopePending ? [] : (data?.entries ?? []).filter(scoped);
      const pending = scopePending ? [] : (data?.operations ?? []).filter((op) => op.status === 'pending' && scoped(op.target));
      const adoptionIds = new Set(pending.filter((op) => op.kind === 'accept').map((op) => op.targetId));
      const candidates = all.filter((entry) => entry.status === 'candidate' && !adoptionIds.has(entry.id));
      const entries = all.filter((entry) => view === 'history' ? !live(entry) && entry.status !== 'candidate'
        : view === 'pending' ? entry.status === 'candidate' && !adoptionIds.has(entry.id) : live(entry));
      const evidenceView = (evidence, missing = '没有保存完整原话，请根据实际情况核对。') => evidence?.length
        ? h('div', { className: 'dsh-persona-memory-evidence' }, ...evidence.map((ref, i) => h('div', { key: i },
          h('span', { style: hintStyle }, ref.source === 'settings' ? '你在设置页的说明'
            : ref.complete ? '用户原话 · 当前保存的完整片段' : '历史片段 · 完整原话未保存'),
          ref.quote.length > 320 ? h('details', null,
            h('summary', { style: hintStyle }, (ref.source === 'settings' ? '展开完整说明'
              : ref.complete ? '展开完整原话' : '展开已保存片段') + '（' + ref.quote.length + ' 字符）'),
            h('blockquote', null, ref.quote)) : h('blockquote', null, ref.quote)))) : h('p', { style: hintStyle }, missing);
      const beginEdit = (entry, operation) => {
        const key = entry.id + ':' + operation;
        setEditing({ ...entry, operation });
        setEditDraft(memoryEditDrafts.get(key) ?? { content: operation === 'revise' ? entry.content : '', statement: '' });
      };
      const changeEdit = (patch) => {
        const next = { ...editDraft, ...patch }; setEditDraft(next);
        keepDraft(memoryEditDrafts, editing.id + ':' + editing.operation, next);
      };
      const pendingRows = pending.map((op) => {
        const target = data.entries.find((e) => e.id === op.targetId);
        const currentConflicts = target && op.kind === 'accept' ? data.entries.filter((e) => e.id !== target.id && live(e)
          && e.kind === target.kind && e.key === target.key && e.scope === target.scope
          && e.personaId === target.personaId && e.sessionId === target.sessionId).map((e) => ({ id: e.id, version: e.version })) : [];
        const stale = !target || target.version !== op.targetVersion
          || (target.expiresAt !== null && target.expiresAt <= Date.now())
          || (op.kind === 'accept' && JSON.stringify(currentConflicts) !== JSON.stringify(op.conflicts));
        const name = { revise: '更正', retract: '撤销', accept: '采用' }[op.kind];
        return h('section', { key: op.id, className: 'dsh-persona-memory-review', 'data-memory-operation': op.id, tabIndex: -1,
          'aria-label': '待确认' + name },
        h('div', { className: 'dsh-persona-memory-review-heading' }, h('strong', null, '核对' + name),
          h('span', { style: hintStyle }, scopeLabel(op.target))),
        h('p', { style: hintStyle }, op.origin === 'model' ? '后台整理建议，尚未确认。'
          : op.origin === 'local' ? '从明确表达识别，尚未确认。' : '由你在设置页提出。'),
        target?.expiresAt ? h('p', { style: hintStyle }, '有效至 ' + new Date(target.expiresAt).toLocaleString() + '，本次操作不会延长。') : null,
        h('p', { style: hintStyle }, op.kind === 'accept' ? '准备采用的内容' : '原先的记录'),
        h('div', { className: 'dsh-persona-memory-content' }, op.target.content),
        op.kind === 'revise' ? h('div', null, h('p', { style: hintStyle }, '更正后'),
          h('div', { className: 'dsh-persona-memory-content', 'data-memory-replacement': '' }, op.content)) : null,
        op.kind === 'retract' ? h('p', { style: hintStyle }, '确认后停止使用这条记录。保留撤销记录，不建立相反偏好，也不恢复同范围内已被替代的偏好。') : null,
        evidenceView(op.evidence),
        op.kind === 'accept' && op.conflicts?.length ? h('div', null,
          h('p', { style: hintStyle }, '采用后将替代以下同范围记录：'),
          ...op.conflicts.map((ref) => h('p', { key: ref.id, className: 'dsh-persona-memory-content' },
            data.entries.find((e) => e.id === ref.id)?.content ?? '记录已变化，请重新核对。'))) : null,
        h('p', { style: hintStyle }, '仅影响上述范围的后续表达。原汇报的事实、条件和风险仍以原文为准。'),
        stale ? h('p', { role: 'status', style: hintStyle }, '原记录已经变化，请放弃这张核对单，再对当前记录操作。') : null,
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || stale || scopePending,
            onClick: () => write({ action: 'confirm', id: op.id, version: op.version }) }, '确认' + name),
          h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'dismiss', id: op.id, version: op.version }) }, '放弃这次操作')));
      });
      const memoryRows = entries.map((entry) => h('div', { key: entry.id, 'data-persona-shell': 'memory-entry', 'data-memory-id': entry.id,
        className: 'dsh-persona-memory-entry' },
      h('div', { style: hintStyle }, (labels[entry.kind] ?? entry.kind) + ' · '
        + (entry.expiresAt !== null && entry.expiresAt <= Date.now() ? '已过期' : labels[entry.status] ?? entry.status)),
      h('div', { className: 'dsh-persona-memory-content' }, entry.content),
      h('div', { style: hintStyle }, scopeLabel(entry) + (entry.pinned ? ' · 已置顶' : '')),
      h('details', null, h('summary', { style: hintStyle }, '查看来源'),
        h('p', { style: hintStyle }, labels[entry.origin] ?? '未知来源'), evidenceView(entry.evidence,
          entry.origin === 'legacy' ? '来自旧版迁移，没有逐条原始依据。' : '旧记录没有保存原话依据。'),
        ...(data.operations ?? []).filter((op) => op.status === 'applied' && op.targetId === entry.id).map((op) =>
          h('div', { key: op.id }, h('p', { style: hintStyle }, { revise: '更正时的说明', retract: '撤销时的说明', accept: '采用时的依据' }[op.kind]),
            op.kind === 'revise' ? h('p', { className: 'dsh-persona-memory-content' }, '更正为：' + op.content) : null,
            evidenceView(op.evidence)))),
      editing?.id === entry.id ? h('div', { className: 'dsh-persona-memory-editor', 'aria-label': editing.operation === 'revise' ? '更正记忆' : '撤销记忆' },
        h('p', { style: hintStyle }, scopeLabel(editing) + '。更正与撤销不会改变记录的归属。'),
        editing.operation === 'revise' ? h('label', { style: labelStyle }, '现在应该怎样记',
          h('textarea', { style: inputStyle, maxLength: 240, value: editDraft.content, disabled: busy,
            'aria-label': '更正后的记忆内容', onChange: (e) => changeEdit({ content: e.target.value }) })) : null,
        h('label', { style: labelStyle }, '你的原话',
          h('textarea', { style: inputStyle, maxLength: 1000, value: editDraft.statement, disabled: busy,
            'aria-label': '本次更正或撤销的原话', placeholder: editing.operation === 'revise'
              ? '例如：以前说要简短，现在我希望把必要的解释讲清楚。' : '例如：不用再记着提醒我休息了。',
            onChange: (e) => changeEdit({ statement: e.target.value }) })),
        h('span', { style: hintStyle }, '这段说明按原样保存，仅作为你在设置页提交的依据；不会发送到工作对话。'),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle,
            disabled: busy || !editDraft.statement.trim() || (editing.operation === 'revise'
              && (!editDraft.content.trim() || editDraft.content.trim() === editing.content)),
            onClick: async () => {
              const key = editing.id + ':' + editing.operation;
              if (await write({ action: 'propose', operation: editing.operation, id: editing.id,
                version: editing.version, content: editDraft.content, statement: editDraft.statement })) {
                memoryEditDrafts.delete(key); setEditing(undefined); setView('pending');
              }
            } }, editing.operation === 'revise' ? '预览更正' : '预览撤销'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setEditing(undefined) }, '收起，保留草稿')))
        : h('div', { className: 'dsh-persona-memory-actions' },
          entry.status === 'candidate' ? h('button', { type: 'button', style: primaryButtonStyle, disabled: busy,
            onClick: async () => { if (await write({ action: 'propose', operation: 'accept', id: entry.id, version: entry.version })) setView('pending'); } }, '核对并采用') : null,
          entry.status === 'candidate' ? h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'reject', id: entry.id, version: entry.version }) }, '忽略') : null,
          ...(['revise', 'retract'].filter(() => live(entry)).map((operation) => h('button', { key: operation,
            type: 'button', style: toggleStyle, disabled: busy, onClick: () => beginEdit(entry, operation) },
          operation === 'revise' ? '更正' : '撤销'))),
          live(entry) ? h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'pin', id: entry.id, version: entry.version, pinned: !entry.pinned }) }, entry.pinned ? '取消置顶' : '置顶') : null),
      h('details', { className: 'dsh-persona-memory-delete' }, h('summary', { style: hintStyle }, '彻底删除'),
        h('p', { style: hintStyle }, '删除这条记录、相关核对单和待整理来源。只想停用时可选择撤销。'),
        h('button', { type: 'button', style: toggleStyle, disabled: busy,
          onClick: () => write({ action: 'delete', id: entry.id, version: entry.version }) }, '确认删除这条记录'))));
      const scopeFields = (value) => ({ scope: value, personaId: value === 'persona' ? data?.activePersonaId : null,
        sessionId: value === 'session' ? data?.sessionId : null });
      const manualEditor = h('div', null,
        h('textarea', { style: inputStyle, value: manual.content, maxLength: 240, disabled: busy,
          'aria-label': '新增记忆内容', placeholder: '例如：称呼我为阿晴；汇报先说结果，再补充条件。',
          onChange: (e) => editManual({ content: e.target.value }) }),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('select', { style: inputStyle, value: manual.kind, disabled: busy, 'aria-label': '记忆类型',
            onChange: (e) => editManual({ kind: e.target.value }) },
          ...['preference', 'agreement', 'context', 'episode'].map((value) => h('option', { key: value, value }, labels[value]))),
          h('select', { style: inputStyle, value: manual.scope, disabled: busy || scopePending, 'aria-label': '记忆适用范围',
            onChange: (e) => editManual({ scope: e.target.value }) },
          h('option', { value: 'persona' }, '当前人格'), h('option', { value: 'shared', disabled: ['agreement', 'episode'].includes(manual.kind) }, '所有人格'),
          h('option', { value: 'session', disabled: !data?.sessionId }, '当前会话（角色共享）')),
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || scopePending || !manual.content.trim()
            || (manual.scope === 'session' && !data?.sessionId) || (manual.scope === 'shared' && ['agreement', 'episode'].includes(manual.kind)),
            onClick: async () => {
              if (await write({ action: 'propose-add', entry: { kind: manual.kind, content: manual.content, ...scopeFields(manual.scope) } })) {
                const next = { ...manual, content: '' }; setManual(next); keepDraft(memoryAddDrafts, draftKey, next); setView('pending');
              }
            } }, '预览新记忆')),
        h('p', { style: hintStyle }, manual.scope === 'shared' ? '这条内容会供所有人格使用，请只记录确实通用的偏好。'
          : manual.scope === 'session' ? '供当前会话中的角色共享，默认一天后失效。' : '只交给当前人格，新建或另存人格不会继承。'));
      const clearControl = h('div', null, h('p', { style: hintStyle }, '清空所有人格的记忆、原话依据、待确认项目和交接记录。'),
        clearConfirm ? h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: async () => {
            if (busyRef.current) return;
            busyRef.current = true; setBusy(true); const token = ++revision.current;
            try {
              const result = await save({ clearMemory: true });
              if (revision.current !== token) return;
              if (result?.settings) {
                setEditing(undefined); memoryEditDrafts.clear(); setClearConfirm(false);
                setData((previous) => previous ? { ...previous, entries: [], operations: [], usage: { version: 1, records: [] },
                  extraction: { status: 'idle', pending: 0 } } : previous);
                busyRef.current = false; await refresh(); setNotice('已清空记忆、原话依据和待确认项目。');
              } else setNotice('清空未完成，请稍后重试。');
            } catch { if (revision.current === token) setNotice('清空未完成，请稍后重试。');
            } finally { busyRef.current = false; setBusy(false); }
          } }, '确认清空全部记忆'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setClearConfirm(false) }, '取消清空'))
          : h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setClearConfirm(true) }, '清空记忆'));
      return h('div', { className: 'dsh-persona-memory', style: { ...fieldStyle, marginBottom: 0 }, 'data-persona-shell': 'memory-panel' },
        h('style', null, SETTINGS_CSS),
        h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', checked: settings.memory !== false,
          onChange: (e) => save({ memory: e.target.checked }) }), h('span', { style: labelStyle }, '记住偏好与约定')),
        h('span', { style: hintStyle }, '记住你希望怎样被回应。关闭后停止采集和使用，已有记录会保留。'),
        settingsFold('memory-extraction', '后台整理', '可选，额外调用转述模型',
          h('div', null, h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', checked: settings.memoryExtraction === true,
            disabled: settings.memory === false, onChange: (e) => save({ memoryExtraction: e.target.checked }) }),
          h('span', { style: labelStyle }, '后台整理记忆候选（默认关闭）')),
          h('p', { style: hintStyle }, '开启后把有限的用户短消息片段交给转述模型整理。约每5分钟或积累8条同会话消息处理一次。候选、更正和撤销都在这里核对，不打扰对话。'),
          h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle }, data?.extraction?.status === 'running' ? '正在整理…'
            : data?.extraction?.status === 'failed' ? '上次整理未完成，可稍后重试。' : '待整理 ' + (data?.extraction?.pending ?? 0) + ' 条'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy || !settings.memory || !settings.memoryExtraction,
            onClick: () => write({ action: 'consolidate' }) }, '整理一次'))), { badge: settings.memoryExtraction ? '已开启' : '已关闭' }),
        h('div', { className: 'dsh-persona-memory-toolbar' }, h('span', { style: labelStyle }, '记忆管理'),
          h('select', { style: inputStyle, value: filter, 'aria-label': '筛选记忆', onChange: (e) => { setFilter(e.target.value); setEditing(undefined); } },
          h('option', { value: 'current' }, '当前人格与共享'), h('option', { value: 'all' }, '全部人格')),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: refresh }, '刷新记忆')),
        h(MemoryUsagePanel, { data, presets, settings, filter, refresh, busy, scopePending }),
        h('div', { className: 'dsh-persona-memory-tabs', role: 'group', 'aria-label': '记忆状态' },
          ...[['active', '使用中', all.filter(live).length], ['pending', '待确认', pending.length + candidates.length],
            ['history', '历史', all.filter((e) => !live(e) && e.status !== 'candidate').length]].map(([id, name, count]) =>
            h('button', { key: id, type: 'button', 'aria-pressed': view === id,
              onClick: () => { setView(id); setEditing(undefined); if (memoryList.current) memoryList.current.scrollTop = 0; } }, name + ' ' + count))),
        h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, notice)),
        h('div', { className: 'dsh-persona-memory-list', ref: memoryList }, ...(view === 'pending' ? pendingRows : []), ...memoryRows),
        scopePending ? h('p', { style: hintStyle }, '正在读取当前人格的记忆…') : entries.length + (view === 'pending' ? pending.length : 0) === 0
          ? h('p', { style: hintStyle }, view === 'pending' ? '暂时没有需要确认的内容。' : view === 'history' ? '还没有历史记录。'
            : '还没有正在使用的记忆，可以手动记一条。') : null,
        settingsFold('memory-add', '手动记一条', '选择内容与适用范围', manualEditor, { badge: manual.content.trim() ? '有草稿' : undefined }),
        settingsFold('memory-clear', '清理记忆', '清空所有人格的记忆与待确认内容', clearControl));
    }

    function PersonaAvatarEditor({ preset, busy, onSave, onClose, user = false }) {
      const [picture, setPicture] = React.useState(undefined), [reading, setReading] = React.useState(false);
      const [crop, setCrop] = React.useState({ x: 50, y: 50, zoom: 1 });
      const [notice, setNotice] = React.useState('');
      const canvas = React.useRef(null), live = React.useRef(true), request = React.useRef(0), operation = React.useRef(chatNonce());
      React.useEffect(() => { live.current = true; return () => { live.current = false; request.current += 1; }; }, []);
      const draw = () => {
        if (!picture || !canvas.current) return;
        const el = canvas.current, context = el.getContext('2d');
        const scale = Math.max(256 / picture.naturalWidth, 256 / picture.naturalHeight) * crop.zoom;
        const width = picture.naturalWidth * scale, height = picture.naturalHeight * scale;
        context.clearRect(0, 0, 256, 256);
        context.drawImage(picture, -(width - 256) * crop.x / 100, -(height - 256) * crop.y / 100, width, height);
      };
      React.useEffect(draw, [picture, crop]);
      const pick = async (file) => {
        if (!file || busy) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
          setNotice('请选择 8MB 以内的 PNG、JPG 或 WebP 图片。'); return;
        }
        const token = ++request.current; setReading(true); setNotice('');
        const url = URL.createObjectURL(file);
        try {
          const img = new Image();
          await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
          if (!live.current || token !== request.current) return;
          if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw Error('size');
          setPicture(img); setCrop({ x: 50, y: 50, zoom: 1 }); operation.current = chatNonce();
        } catch { if (live.current && token === request.current) setNotice('这张图片无法读取，或尺寸过大。请选择另一张。'); }
        finally { URL.revokeObjectURL(url); if (live.current && token === request.current) setReading(false); }
      };
      const save = async (remove = false) => {
        if (busy || reading || (!picture && !remove)) return;
        draw();
        const avatar = remove ? null : canvas.current.toDataURL('image/png');
        const result = await onSave({ action: 'avatar', id: preset.id, avatar, expectedAvatar: preset.avatar ?? null,
          requestId: (remove ? 'remove-' : '') + operation.current });
        if (live.current && result?.ok !== true) setNotice(result?.reason === 'avatar-conflict'
          ? '头像已在别处更新，请取消后重新打开。已选图片仍保留。' : '保存未完成，已选图片与取景仍保留，可以重试。');
      };
      return h('section', { className: 'dsh-persona-avatar-editor', role: 'group', 'aria-label': user ? '编辑我的头像' : '编辑人格头像' },
        h('div', { className: 'dsh-persona-memory-footer' }, h('strong', null, preset.name + ' · 头像'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: onClose }, '取消头像修改')),
        h('p', { style: hintStyle }, user ? '这张头像用于所有角色聊天，只改变显示，不影响人格与记忆。' : preset.builtin ? '内置原版保留；保存头像会另存为全局默认的人格。新人格不会自动加入已有聊天室，私人记忆不继承；可在房间成员管理中加入。' : '只改变这位角色的头像，身份、聊天记录与记忆保持不变。'),
        h('div', { className: 'dsh-persona-avatar-workbench' },
          picture ? h('canvas', { ref: canvas, width: 256, height: 256, 'aria-label': '头像取景预览' })
            : h(PersonaAvatar, { src: preset.avatar, id: preset.id, name: preset.name, className: 'dsh-persona-avatar-preview' }),
          h('div', null, h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '选择头像图片'),
            h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', disabled: busy || reading,
              'aria-label': '选择头像图片', onClick: (event) => { event.target.value = ''; }, onChange: (event) => { void pick(event.target.files?.[0]); } })),
            picture ? h('div', { className: 'dsh-persona-avatar-crop' },
              ...[['x', '左右位置', 0, 100, 1], ['y', '上下位置', 0, 100, 1], ['zoom', '缩放', 1, 3, 0.05]].map(([key, title, min, max, step]) =>
                h('label', { key }, title, h('input', { type: 'range', min, max, step, value: crop[key], 'aria-label': '头像' + title,
                  disabled: busy, onChange: (event) => { setCrop({ ...crop, [key]: Number(event.target.value) }); operation.current = chatNonce(); } }))))
              : h('p', { style: hintStyle }, '支持 PNG、JPG、WebP，选好后可调整取景。图片仅保存在插件内，不发送给模型。'))),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || reading || !picture, onClick: () => save() },
            busy ? '正在保存…' : user ? '保存我的头像' : preset.builtin ? '另存新人格并使用' : '保存头像'),
          preset.avatar ? h('button', { type: 'button', style: toggleStyle, disabled: busy || reading, onClick: () => save(true) },
            user ? '使用账号头像' : preset.builtin ? '另存为无图片人格' : '移除头像') : null),
        h('p', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, reading ? '正在读取图片…' : notice));
    }

    function ChatUserSettings({ onClose, visible = true }) {
      const [value, setValue] = React.useState(undefined), [editing, setEditing] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
      const live = React.useRef(false), request = React.useRef(0), saving = React.useRef(false), state = React.useRef(undefined), retired = React.useRef(new Set());
      const accept = (next) => {
        if (!live.current || retiredInstances.has(next?.instanceId) || retired.current.has(next?.instanceId) || !Number.isSafeInteger(next?.revision)) return;
        if (state.current?.instanceId === next.instanceId && state.current.revision > next.revision) return;
        if (state.current?.instanceId && state.current.instanceId !== next.instanceId) retired.current.add(state.current.instanceId);
        state.current = next; setValue(next);
      };
      const refresh = async () => {
        const token = ++request.current;
        try {
          const response = await fetch(ROUTE + '/chat-profile'); const next = await response.json();
          if (live.current && token === request.current) {
            if (!response.ok || !next.instanceId) throw Error('unavailable');
            accept(next); for (const update of chatProfileUpdates) update(next); setNotice('');
          }
        } catch { if (live.current && token === request.current) setNotice('头像暂时无法读取，可以刷新重试。'); }
      };
      React.useEffect(() => {
        live.current = true; const update = (next) => accept(next); chatProfileUpdates.add(update);
        return () => { live.current = false; request.current += 1; chatProfileUpdates.delete(update); };
      }, []);
      React.useEffect(()=>{if(visible)void refresh();},[visible]);
      const persist = async (patch, revision) => {
        if (saving.current) return { ok: false };
        saving.current = true; setBusy(true); request.current += 1;
        try {
          const response = await fetch(ROUTE + '/chat-profile', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...patch, revision }) });
          const next = await response.json();
          if (next.state) { accept(next.state); for (const update of chatProfileUpdates) update(next.state); }
          if (!response.ok) return { ok: false, reason: next.error === 'profile-conflict' ? 'avatar-conflict' : next.error };
          accept(next); for (const update of chatProfileUpdates) update(next);
          if (live.current) { setEditing(undefined); setNotice('头像已保存。'); }
          return { ok: true };
        } catch { return { ok: false }; }
        finally { saving.current = false; if (live.current) setBusy(false); }
      };
      const save = ({ avatar }) => editing ? persist({ avatar }, editing.revision) : Promise.resolve({ ok: false });
      const mode = userAvatarMode(value);
      const accountUrl = useAccountAvatar(visible && !!value && mode === 'account');
      const changeMode = async (avatarMode) => {
        const result = await persist({ avatarMode }, state.current.revision);
        if (live.current && !result.ok) setNotice(result.reason === 'avatar-conflict'
          ? '外观已在别处更新，请核对当前选择后再试。' : '显示方式未保存，原设置仍保留，请重试。');
      };
      return h('div', { 'data-persona-shell': 'user-profile', style: {
        '--dsh-persona-accent': 'var(--dsw-alias-brand-primary,#3976c3)', '--dsh-persona-border': 'var(--dsw-alias-border-l1,#d8dfe7)',
        '--dsh-persona-bg': 'var(--dsw-alias-bg-layer-1,#fff)', '--dsh-persona-soft': 'var(--dsw-alias-bg-layer-2,#f5f7fa)',
        '--dsh-persona-text': 'var(--dsw-alias-label-primary,#203044)', '--dsh-persona-muted': 'var(--dsw-alias-label-secondary,#607080)',
      } }, h('style', null, SETTINGS_CSS),
        h('div', { className: 'dsh-persona-memory-footer' }, h('strong', null, '我的头像'),
          onClose ? h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: onClose }, '收起外观') : null),
        h('p', { style: hintStyle }, '默认跟随 DSH 账号头像。没有头像或加载失败时，只显示你的消息气泡。'),
        h('label', { style: { ...fieldStyle, marginTop: '14px' } }, h('span', { style: labelStyle }, '用户头像显示'),
          h('select', { style: inputStyle, 'aria-label': '用户头像显示', value: mode, disabled: !value || busy || !!editing,
            onChange: (event) => { void changeMode(event.target.value); } },
            h('option', { value: 'account' }, '跟随账号头像'), h('option', { value: 'custom', disabled: !value?.avatar }, '使用自定义头像'),
            h('option', { value: 'hidden' }, '不显示头像'))),
        editing ? h(PersonaAvatarEditor, { user: true, preset: { id: 'user', name: '你', avatar: editing.avatar }, busy, onSave: save,
          onClose: () => { setEditing(undefined); setNotice(''); } })
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h(UserChatAvatar, { profile: value, accountUrl, className: 'dsh-persona-preset-avatar' }),
            h('button', { type: 'button', style: toggleStyle, disabled: !value || busy, onClick: () => setEditing(value) }, '修改我的头像'),
            h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => { void refresh(); void accountAvatarSource.refresh(); } }, '刷新头像')),
        !editing ? h('p', { style: hintStyle }, mode === 'hidden' ? '用户侧只显示消息气泡；已上传的图片仍保留。'
          : mode === 'account' ? accountUrl ? '使用当前 DSH 账号头像，不保存账号资料。' : '未获取到账号头像时，用户侧只显示消息气泡。'
            : '使用已上传的自定义图片；只保存取景后的图片，不发送给模型。') : null,
        h('p', { style: hintStyle, role: 'status' }, notice));
    }

    let nextSettingsId = 0;
    function SettingsSection() {
      const [activeTab, setActiveTab] = React.useState('persona');
      const [appearanceVisited,setAppearanceVisited]=React.useState(false);
      React.useEffect(()=>{if(activeTab==='appearance')setAppearanceVisited(true);},[activeTab]);
      const tabsId = React.useRef(null);
      if (tabsId.current === null) tabsId.current = 'dsh-persona-settings-' + (++nextSettingsId);
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
      const [chatModels,setChatModels]=React.useState([]),[chatModelsFailed,setChatModelsFailed]=React.useState(false);
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
      const [editingAvatar, setEditingAvatar] = React.useState(undefined);

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
        const replacesCard = body.action === 'apply' || body.action === 'save' || body.action === 'avatar'
          || (body.action === 'delete' && body.id === activePresetId);
        return queueWrite(async () => {
          try {
            // A failed blur save must not disappear when another card is selected.
            const changes = draftChanges();
            let requestBody = body;
            if (replacesCard && changes.length > 0) {
              const saved = await persistPackChanges(changes);
              if (!saved?.settings) {
                setPresetStatus(body.action === 'avatar' ? '保存头像前，人格修改未能保存，请重试。' : '切换前保存人格修改失败，请重试。');
                return { ok: false, reason: 'unsaved-persona-edits' };
              }
              if (body.action === 'avatar' && body.id === activePresetId) {
                const current = saved.presets?.find((p) => p.name === saved.settings.presetName);
                if (current && current.id !== body.id) requestBody = { ...body, id: current.id, expectedAvatar: current.avatar ?? null };
              }
            }
            const result = await postPreset(requestBody);
            if (result?.ok === true) {
              await refreshPresets({ presets: result.presets, active: result.active });
              if (result.settings !== undefined) acceptSettings(result.settings);
              setPresetStatus('');
              if (body.action === 'avatar') for (const update of chatUpdates) update(body.id);
            } else {
              setPresetStatus(body.action === 'avatar'
                ? result?.reason === 'avatar-conflict' ? '头像已在别处更新，请取消后重新打开。已选图片仍保留。' : '头像保存未完成，已选图片与取景仍保留，可以重试。'
                : `失败：${result?.reason ?? '未知原因'}`);
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
      React.useEffect(()=>{
        if(activeTab!=='chat'||!settings?.chatProvider)return;
        let cancelled=false;setChatModels([]);setChatModelsFailed(false);
        void (async()=>{try{const response=await fetch(ROUTE+'/models?provider='+encodeURIComponent(settings.chatProvider));
          if(!response.ok)throw Error('unavailable');const value=await response.json();if(!cancelled)setChatModels(value.models??[]);
        }catch{if(!cancelled)setChatModelsFailed(true);}})();return()=>{cancelled=true;};
      },[activeTab,settings?.chatProvider]);

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
          else if (field === 'narrationMode') nextPack.narration = { ...nextPack.narration, mode: value };
          else if (field === 'narrationAssistant') nextPack.narration = { ...nextPack.narration, assistant: value };
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
            ? h('div', { className: 'dsh-persona-preset-grid', 'data-many': presets.length > 5 },
              ...presets.map((preset) => h('div', {
                key: preset.id,
                className: 'dsh-persona-preset', 'data-preset-id': preset.id, 'data-active': preset.id === activePresetId,
              },
              preset.avatar ? h(PersonaAvatar, { src: preset.avatar, name: preset.name, id: preset.id, fallback: false,
                className: 'dsh-persona-preset-avatar' }) : null,
              h('span', {
                className: 'dsh-persona-preset-name',
                style: presetNameStyle,
              }, preset.name, h('small', { className: 'dsh-persona-preset-description' }, personaSummary(preset))),
              preset.builtin === true
                ? h('span', { className: 'dsh-persona-preset-tag' }, '内置')
                : null,
              h('div', { className: 'dsh-persona-preset-actions' },
                h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
                  'aria-label': '修改' + preset.name + '头像', onClick: () => setEditingAvatar(preset) }, '头像'),
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

          editingAvatar ? h(PersonaAvatarEditor, { key: editingAvatar.id, preset: editingAvatar, busy: presetBusy,
            onClose: () => setEditingAvatar(undefined), onSave: async (body) => {
              const result = await presetAction(body); if (result?.ok === true && mounted.current) setEditingAvatar(undefined); return result;
            } }) : null,

          presets.some(p=>p.builtin&&p.character)?h('details',{className:'dsh-persona-character-guide',style:{marginTop:12}},
            h('summary',{style:{cursor:'pointer',fontSize:12,color:'var(--dsw-alias-label-secondary)'}},'内置人物关系'),
            h('p',{style:hintStyle},'大肥鱼和小肥鱼是姐妹。大家叫大肥龙「GPT」，叫 Gemini「猫猫」。这些是本插件的二创设定，自定义人格有自己的关系。'),
            h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,320px),1fr))',gap:10}},
              ...presets.filter(p=>p.builtin&&p.character).map(p=>h('article',{key:p.id,style:{border:'1px solid var(--dsw-alias-border-l1)',borderRadius:9,padding:'10px 12px'}},
                h('strong',{style:{fontSize:12}},p.name+' · '+p.character.genderLabel),
                h('p',{style:{...hintStyle,margin:'5px 0 8px'}},'称呼：'+p.character.preferredAddress.join('、')),
                ...p.character.relations.map(r=>h('p',{key:r.to,style:{...hintStyle,margin:'5px 0'}},
                  h('span',{style:{color:'var(--dsw-alias-label-primary)'}},'对'+r.address+'：'),r.dynamic)))))):null,

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
              h('div', { style: { ...memoryLineStyle, marginTop: '4px' } }, generated.narration?.mode === 'relay'
                ? `发言关系：转达${generated.narration.assistant || '原助手'}的工作` : '发言关系：用角色口吻重述'),
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
        ),
        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '发言关系'),
          h('select', { style: inputStyle, disabled: presetBusy, 'aria-label': '发言关系',
            value: draftValue('narrationMode', pack?.narration?.mode ?? 'voice'),
            onChange: (e) => savePackField('narrationMode', e.target.value) },
            h('option', { value: 'voice' }, '用角色口吻重述'), h('option', { value: 'relay' }, '转达另一位助手的工作')),
          h('span', { style: hintStyle }, '小肥鱼（实验性）使用转达模式；切换角色不会改变实际工作的助手。')),
        (draftValue('narrationMode', pack?.narration?.mode ?? 'voice') === 'relay')
          ? h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
            h('span', { style: labelStyle }, '称呼原助手为'),
            h('input', { style: inputStyle, disabled: presetBusy, maxLength: 20, 'aria-label': '原助手称呼',
              value: draftValue('narrationAssistant', pack?.narration?.assistant ?? '原助手'),
              onChange: (e) => setDraft('narrationAssistant', e.target.value),
              onBlur: (e) => savePackField('narrationAssistant', e.target.value) })) : null);
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
          h('span', { style: hintStyle }, settings?.reasoningEffort
            ? `推理强度已指定为 ${settings.reasoningEffort}；模型不支持时回到默认兼容策略。`
            : '改写默认优先关闭思考；模型无法关闭时使用其最低档，能力未知时按提供方默认兼容。失败仍保留原文。'),
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
      const settingsTabs = [['persona', '人格'], ['rewrite', '转述'], ['chat','聊天室'], ['memory', '记忆'], ['appearance', '外观'], ['usage', '用量'], ['advanced', '高级']];
      const panel = (id, content) => h('div', { key: id, role: 'tabpanel', id: tabsId.current + '-' + id,
        'aria-labelledby': tabsId.current + '-tab-' + id, hidden: activeTab !== id, 'data-settings-panel': id }, content);
      return h('div', { 'data-persona-shell': 'settings', className: 'dsh-persona-settings' },
        h('style', null, SETTINGS_CSS, SETTINGS_REDESIGN_CSS),
        h('header', { className: 'dsh-persona-settings-hero' },
          h('div', null,
            h('h2', null, '人格套壳'),
            h('p', null, '只换表达，原文随时可查。')),
          h('span', { className: 'dsh-persona-save-state', role: 'status', 'aria-live': 'polite',
            'data-state': /失败/.test(status) ? 'error' : /正在/.test(status) ? 'pending' : 'saved' }, status || '自动保存')),
        h('div', { className: 'dsh-persona-settings-tabs', role: 'tablist', 'aria-label': '设置分类',
          onKeyDown: (event) => {
            if (event.nativeEvent?.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = settingsTabs.findIndex(([id]) => id === activeTab);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
            setActiveTab(settingsTabs[index][0]); event.currentTarget.querySelectorAll('[role=tab]')[index]?.focus();
          } }, ...settingsTabs.map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab',
            id: tabsId.current + '-tab-' + id, 'aria-controls': tabsId.current + '-' + id,
            'aria-selected': activeTab === id, tabIndex: activeTab === id ? 0 : -1, onClick: () => setActiveTab(id) }, label))),
        shippedRendererOk ? null : h('div', { style: warningStyle },
          '独立原文预览暂以纯文本显示，聊天正文仍由官方组件渲染。'),
        rendererState.status === 'incompatible' || rendererState.status === 'error'
          ? h('div', { style: warningStyle, role: 'status' }, '人格显示已暂停，当前保留官方原文。',
            h('details', null, h('summary', null, '查看原因'), rendererState.reason)) : null,
        panel('persona', h('section', { className: 'dsh-persona-section', 'aria-label': '选择人格' },
          settingsHeading('', '默认人格', '用于没有单独指定角色的会话。' + (presets.length > 5 ? ' 共 ' + presets.length + ' 个，可滚动选择。' : '')),
          personaControls,
          h('div', { className: 'dsh-persona-persona-tools' },
            settingsFold('create-persona', '创建新人格', '从你的人设提示词开始', generatorControls,
              { open: generated !== undefined ? true : undefined }),
            settingsFold('edit-persona', '调整当前人格', Object.keys(packDrafts).length
              ? '有尚未保存的输入' : '身份、语气、示例与称呼',
              h('div', null, h('p', { className: 'dsh-persona-section-note' },
                '编辑后自动保存；调整内置人格会另存一份，原版始终保留。'), editorControls))))),
        panel('rewrite', h('section', { className: 'dsh-persona-section', 'aria-label': '日常转述' },
          settingsHeading('', '日常转述', '决定哪些汇报换一种口吻。'),
          h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '默认转述范围'),
            h('select', { style: inputStyle, 'aria-label': '默认转述范围', value: settings.trigger ?? 'step',
              onChange: (e) => save({ trigger: e.target.value }) },
              h('option', { value: 'step' }, '全部汇报'), h('option', { value: 'report' }, '仅最终汇报')),
            h('span', { style: hintStyle }, '聊天顶部可以单独选择人格、范围或安排接力；独立选择的会话不随全局切换。')),
          h('div', { className: 'dsh-persona-process-options' }, processControls),
          h('div', { className: 'dsh-persona-common-grid' }, reviewControls, quietControls),
          settingsFold('rewrite-help', '这些选项如何工作', '调用用量与原文边界',
            h('div', { className: 'dsh-persona-help-copy' },
              h('p', null, '阶段性输出关闭后跳过带工具调用的步骤。要严格只改最终汇报，请将转述范围设为仅最终汇报。'),
              h('p', null, '过程运行信息仅提供分类统计与轻量会话节奏；可选补充最多40字、每轮最多3条，不进入最终汇报。查询会增加一次模型续接。'),
              h('p', null, '静默播报仅为前台正在查看的主会话生成，标记为 ◈；每轮最多3次，无新事实不重复调用，也不代表任务完成。'),
              h('p', null, '※ 只衡量措辞变化，不保证语义一致。重要事实、条件和风险仍应对照原文。')), { compact: true }))),
        panel('chat',h('section',{className:'dsh-persona-section','aria-label':'聊天室模型设置'},
          settingsHeading('','聊天室','默认跟随转述模型，可以单独选择。修改只影响之后的请求。'),
          h('label',{style:fieldStyle},h('span',{style:labelStyle},'聊天室模型'),
            h('select',{style:inputStyle,'aria-label':'聊天室模型',value:settings.chatProvider??'',onChange:e=>save({chatProvider:e.target.value,chatModel:''})},
              h('option',{value:''},'跟随转述模型（默认）'),
              settings.chatProvider&&!providers.some(p=>p.provider===settings.chatProvider)?h('option',{value:settings.chatProvider},settings.chatProvider+'（暂不可用）'):null,
              ...providers.map(p=>h('option',{key:p.provider,value:p.provider},p.name??p.provider)))),
          settings.chatProvider?h('label',{style:fieldStyle},h('span',{style:labelStyle},'模型名称'),
            h('select',{style:inputStyle,'aria-label':'聊天室模型名称',value:settings.chatModel??'',onChange:e=>save({chatModel:e.target.value})},
              h('option',{value:''},'该提供方的默认模型'),
              settings.chatModel&&!chatModels.some(m=>m.id===settings.chatModel)?h('option',{value:settings.chatModel},settings.chatModel):null,
              ...chatModels.map(m=>h('option',{key:m.id,value:m.id},m.name??m.id)))):null,
          chatModelsFailed&&settings.chatProvider?h('p',{style:hintStyle,role:'status'},'模型列表暂时无法读取，已保存的选择仍保留。'):null,
          h('div',{className:'dsh-persona-process-options',style:{borderBottom:0,paddingBottom:0}},h('label',{style:{display:'flex',alignItems:'center',gap:'8px'}},
            h('input',{type:'checkbox',checked:settings.chatThinking===true,onChange:e=>save({chatThinking:e.target.checked})}),h('span',null,'开启聊天室思考')),
            h('p',{style:hintStyle},'默认关闭，独立于转述设置。开启后优先使用模型支持的最低思考档；模型不支持或能力未知时采用兼容策略。聊天与快捷回复共用此设置。')))),
        panel('memory', h('section', { className: 'dsh-persona-section', 'aria-label': '记忆与约定' },
          settingsHeading('', '记忆与约定', '查看原话依据，确认哪些偏好继续使用。'), h(MemoryPanel, { settings, save, presets }))),
        panel('appearance', h('section', { className: 'dsh-persona-section', 'aria-label': '聊天室外观' },
          settingsHeading('', '聊天室外观', '用户头像只用于展示，不会发送给模型。'),
          (activeTab==='appearance'||appearanceVisited)?h(ChatUserSettings,{visible:activeTab==='appearance'}):null)),
        panel('usage', h(ModelUsagePanel, { visible: activeTab === 'usage' })),
        panel('advanced', h('section', { className: 'dsh-persona-section', 'aria-label': '高级设置' },
          settingsHeading('', '高级设置', '模型与较少使用的选项。'),
          h('div', { className: 'dsh-persona-advanced-grid' },
            h('div', null, h('h3', { className: 'dsh-persona-subheading' }, '转述模型'), modelControls),
            h('div', null, subagentControls),
            h('div', { className: 'dsh-persona-wide' }, thresholdControls)))),
        h('p', { className: 'dsh-persona-footer-note' }, '转述失败时显示原文。聊天室保留独立记录。'));
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
        createAccountAvatarSource,
        accountAvatarSource,
        ConversationPanel,
        ReportFeedback,
        SessionPersonaSwitch,
        PersonaChatWindow,
        RoomChatWorkspace,
        RoomAvatar,
        RoomRecipient,
        ChatReplyBubbles,
        PersonaChatLauncher,
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
          chatRuntime.dispose();
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

        // Optional: hosts without the account API simply show user bubbles.
        if (typeof ctx.inject === 'function') ctx.inject(['remote', 'remote.account'], (owner) => {
          const remote = owner.get('remote');
          if (typeof remote?.account?.getProfile !== 'function' || typeof remote?.account?.getState !== 'function') return;
          const release = accountAvatarSource.bind(remote, () => ({ version: 'dsh-persona-shell/0.5.0',
            locale: typeof navigator !== 'undefined' ? navigator.language : 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }));
          owner.effect(() => release);
          if (typeof owner.on === 'function') owner.on('connection/reset', () => { void accountAvatarSource.refresh(); });
        });

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
