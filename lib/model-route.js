const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512;
const route = (value, source) => text(value?.provider) && text(value?.model)
  ? { provider: value.provider, model: value.model, source } : undefined;

function configured(value, source) {
  const provider = value?.provider, model = value?.model;
  if ((provider === undefined || provider === '') && (model === undefined || model === '')) return { kind: 'none' };
  if (!text(provider) || (model !== undefined && model !== '' && !text(model))) return { kind: 'invalid' };
  return { kind: 'route', value: { provider, model: model ?? '', source } };
}

function withSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(signal.reason ?? Error('aborted')); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * Resolve routes from explicit choices and official Host metadata only.
 * No Session is activated and no event log, message, credential, or code is read.
 * A cache route is a lifecycle-validated checkpoint, not a real-time selection.
 */
export function createModelRouteResolver({ getService = () => undefined, getSettings = () => ({}),
  getTurnRoute = () => undefined, isClosing = () => false, now = Date.now, metadataTtlMs = 30000 } = {}) {
  if ([getService, getSettings, getTurnRoute, isClosing, now].some(value => typeof value !== 'function')
    || !Number.isSafeInteger(metadataTtlMs) || metadataTtlMs < 0) throw Error('invalid-model-route-resolver');
  let disposed = false, catalogs = new WeakMap();
  const lookups = new Set();
  const stopped = () => disposed || isClosing();
  const service = name => { try { return getService(name); } catch { return undefined; } };
  const globalRoute = () => {
    try { return route(service('agentDefaultModel')?.currentSelection?.(), 'global'); }
    catch { return undefined; }
  };
  const liveRoute = sessionId => {
    if (!text(sessionId)) return undefined;
    try {
      const selected = route(service('agents')?.get?.(sessionId)?.model?.current?.(), 'session-live');
      if (selected) return selected;
    } catch { /* An unavailable live Agent does not authorize activating it. */ }
    try {
      const session = service('sessions')?.get?.(sessionId), projections = service('sessionProjections');
      if (!session || typeof projections?.snapshot !== 'function') return undefined;
      const value = projections.snapshot(session, ['modelSelection'])?.values?.modelSelection;
      return route(value?.next ?? value?.lastUsed, 'session-live');
    } catch { return undefined; }
  };
  const preferred = (sessionId, override, overrideSource = 'chat') => {
    const explicit = configured(override, overrideSource); if (explicit.kind !== 'none') return explicit;
    let settings;
    try { settings = getSettings(); } catch { return { kind: 'invalid' }; }
    const rewrite = configured(settings, 'rewrite'); if (rewrite.kind !== 'none') return rewrite;
    let current;
    try { current = route(getTurnRoute(sessionId), 'turn'); } catch { /* No local request header. */ }
    current ??= liveRoute(sessionId);
    return current ? { kind: 'route', value: current } : { kind: 'none' };
  };
  const fillKnownDefault = selected => {
    if (selected.model) return selected;
    const defaults = globalRoute();
    return defaults?.provider === selected.provider ? { ...selected, model: defaults.model } : selected;
  };
  const catalogDefault = async provider => {
    const llm = service('llm');
    if (!llm || typeof llm.listModels !== 'function' || !['object', 'function'].includes(typeof llm)) return undefined;
    let entries = catalogs.get(llm); if (!entries) { entries = new Map(); catalogs.set(llm, entries); }
    const cached = entries.get(provider);
    if (cached?.promise) return cached.promise;
    if (cached?.model && cached.expires > now()) return cached.model;
    const entry = {};
    entry.promise = Promise.resolve().then(async () => {
      if (stopped()) return undefined;
      try {
        // Compatibility for an explicitly selected provider without a model:
        // SDK catalogs promise adapter-preferred order, not a global default.
        const listed = await llm.listModels(provider), first = Array.isArray(listed) ? listed[0] : undefined;
        return !stopped() && text(first?.id) ? first.id : undefined;
      } catch { return undefined; }
    }).then(model => {
      if (entries.get(provider) === entry) {
        if (model && !stopped()) entries.set(provider, { model, expires: now() + metadataTtlMs });
        else entries.delete(provider);
      }
      return model;
    });
    entries.set(provider, entry); return entry.promise;
  };
  const persistedRoute = async (sessionId, signal) => {
    if (!text(sessionId)) return undefined;
    const persistence = service('sessionPersistence'), cache = service('sessionProjectionCache');
    if (typeof persistence?.stat !== 'function' || typeof cache?.cachedSnapshot !== 'function') return undefined;
    const controller = new AbortController(), stop = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    lookups.add(controller);
    try {
      controller.signal.throwIfAborted();
      const snapshot = await withSignal(persistence.stat(sessionId, { signal: controller.signal }), controller.signal);
      if (stopped()) return undefined;
      const live = liveRoute(sessionId); if (live) return live;
      if (snapshot?.header?.id !== sessionId) return undefined;
      // cachedSnapshot is the official lifecycle/version-checking face. Do not
      // inspect raw checkpoint rows or fall back to observeSession/readSession.
      const value = cache.cachedSnapshot(snapshot.header, ['modelSelection'])?.values?.modelSelection;
      return route(value?.next ?? value?.lastUsed, 'session-cache');
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return undefined;
    } finally { lookups.delete(controller); signal?.removeEventListener('abort', stop); }
  };
  const api = {
    peek(sessionId, override) {
      if (stopped()) return undefined;
      const chosen = preferred(sessionId, override);
      if (chosen.kind === 'invalid') return undefined;
      return chosen.kind === 'route' ? fillKnownDefault(chosen.value) : globalRoute();
    },
    canResolve(sessionId, override) {
      if (stopped()) return false;
      const chosen = preferred(sessionId, override);
      if (chosen.kind === 'invalid') return false;
      if (chosen.kind === 'route') return !!fillKnownDefault(chosen.value).model || typeof service('llm')?.listModels === 'function';
      if (globalRoute()) return true;
      return text(sessionId) && typeof service('sessionPersistence')?.stat === 'function'
        && typeof service('sessionProjectionCache')?.cachedSnapshot === 'function';
    },
    // A report's captured route is local, immutable source metadata. It fills
    // only the gap after current choices and before a cold lookup/global default;
    // it never repairs or replaces an explicit selection that cannot resolve.
    async resolve(sessionId, override, { signal, reportRoute, overrideSource } = {}) {
      signal?.throwIfAborted(); if (stopped()) return undefined;
      const controller = new AbortController(), stop = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
      lookups.add(controller);
      try {
        const chosen = preferred(sessionId, override, overrideSource === 'reading' ? 'reading' : 'chat');
        if (chosen.kind === 'invalid') return undefined;
        if (chosen.kind === 'route') {
          const selected = fillKnownDefault(chosen.value);
          if (selected.model) return selected;
          const model = await withSignal(catalogDefault(selected.provider), controller.signal);
          controller.signal.throwIfAborted();
          return model && !stopped() ? { ...selected, model } : undefined;
        }
        const captured = route(reportRoute, 'report-captured');
        if (captured) return captured;
        const persisted = await persistedRoute(sessionId, controller.signal);
        controller.signal.throwIfAborted();
        return stopped() ? undefined : persisted ?? globalRoute();
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return undefined;
      } finally { lookups.delete(controller); signal?.removeEventListener('abort', stop); }
    },
    invalidate() { catalogs = new WeakMap(); },
    dispose() {
      disposed = true; catalogs = new WeakMap();
      for (const controller of lookups) controller.abort(Error('model-route-disposed'));
      lookups.clear();
    },
  };
  return api;
}
