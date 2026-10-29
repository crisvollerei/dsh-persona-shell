/** Official Remote supervision; no socket, auth token or connection loop of our own. */
export function createClientTransport({ remote, SnapshotStream, CarrierError, contribution, onState, onStatus,
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
