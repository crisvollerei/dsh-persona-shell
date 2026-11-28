import { readRequestBody } from './http-body.js';

const clientDiagnosticFields = ['applied', 'clientBuild', 'heartbeat', 'shippedMarkdown', 'reason',
  'accepted', 'componentType', 'moduleType', 'keyCount', 'markdownKeys', 'hasDefault', 'shapeError',
  'sessionId', 'sessionIdUsable', 'chatRenderer', 'chatRendererReason', 'comparisonModal',
  'branchTrail', 'lastFetchError', 'stateTransport'];

export function createHostStatusRoutes({
  emitSwitched,
  activeRewrites, candidates, setDiagnostics, getDiagnostics, getEnabledRestored,
  MAX_SESSION_SWITCHES, memories, memoryConsolidator, modelUsage, chatTiming, getModelUsageWriteFailed,
  pendingSessionSwitchValues, getProfile, progress, readerMemoryLines, revisions, ROUTE, rows,
  saveSessionSwitches, sendJson, sessionSwitches, setSessionSwitchRev, getSessionSwitchRev,
  sessionSwitchState, settings, getSettingsRestored, stateFor, getStore, getStoreClosing,
  getStoreError, getStoreState, toolUsage, touch, turnState, waitForStateChange,
}) {
  return async function handleStatusRoutes(req, res, url, path) {
    if (path === ROUTE + '/model-usage') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
      if (getStoreClosing() || getStoreState() === 'opening') { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      const range = url.searchParams.get('days') ?? '7';
      if (!['1', '7', '30'].includes(range)) { sendJson(res, 400, { error: 'invalid-usage-range' }); return; }
      sendJson(res, 200, { ...modelUsage.report(Number(range)), chatTiming:chatTiming.summary(),
        persistence: getModelUsageWriteFailed() ? 'failed' : getStore() ? 'local' : 'memory-only' });
      return;
    }

    if (path === `${ROUTE}/progress-view` && req.method === 'POST') {
      const raw = await readRequestBody(req, 2048);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      if (!body || typeof body.viewer !== 'string' || !body.viewer || body.viewer.length > 100
        || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.visible !== 'boolean'
        || (body.visible && (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200))) {
        sendJson(res, 400, { error: 'invalid viewer' }); return;
      }
      progress.viewer(body.viewer, body.visible ? body.sessionId : undefined, body.revision);
      sendJson(res, 200, { ok: true }); return;
    }

    if (path === `${ROUTE}/state`) {
      const sessionId = url.searchParams.get('session') ?? '';
      if (sessionId === '') { sendJson(res, 400, { error: 'session required' }); return; }
      if (url.searchParams.get('viewing') === '1' && sessionId.length <= 200) {
        const viewer = url.searchParams.get('viewer');
        const rawViewRev = url.searchParams.get('viewRev');
        const viewRev = rawViewRev === null ? undefined : Number(rawViewRev);
        if (typeof viewer === 'string' && viewer !== '' && viewer.length <= 100
          && Number.isSafeInteger(viewRev) && viewRev >= 0) {
          progress.viewer(viewer, sessionId, viewRev);
        }
      }
      // Long-poll: the page asks with the revision it already has and a wait
      // budget. If nothing moved, hold the request until `touch()` wakes it or
      // the budget expires, then answer with the current state either way.
      // This preserves the existing route shape (a GET returning one JSON
      // document) and works through the Desktop IPC fetch carrier, where an
      // EventSource would not.
      const sinceParam = url.searchParams.get('rev');
      const waitParam = url.searchParams.get('wait');
      const since = sinceParam === null ? undefined : Number(sinceParam);
      const wait = waitParam === null ? 0 : Number(waitParam);
      if (Number.isInteger(since) && Number.isFinite(wait) && wait > 0) {
        const current = revisions.get(sessionId) ?? 0;
        if (since === current) await waitForStateChange(sessionId, Math.min(wait, 30000), req, res);
        if (res.writableEnded === true || res.destroyed === true) return;
        if (getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      }
      sendJson(res, 200, stateFor(sessionId));
      return;
    }

    // A session override cannot enable the persona while the global switch is off.
    if (path === `${ROUTE}/session-switch` && req.method === 'POST') {
      const raw = await readRequestBody(req, 4 * 1024);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      let body;
      try { body = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const rawSessionId = body !== null && typeof body === 'object' && typeof body.sessionId === 'string'
        ? body.sessionId.trim()
        : '';
      if (rawSessionId === '') { sendJson(res, 400, { error: 'session id required' }); return; }
      if (rawSessionId.length > 200) { sendJson(res, 400, { error: 'session id too long' }); return; }
      const sessionId = rawSessionId;
      if (body === null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be a boolean' });
        return;
      }
      const previous=!sessionSwitches.has(sessionId);
      if (body.enabled) sessionSwitches.delete(sessionId);
      else {
        if (!sessionSwitches.has(sessionId) && sessionSwitches.size >= MAX_SESSION_SWITCHES) {
          const oldest = sessionSwitches.keys().next().value;
          if (oldest !== undefined) {sessionSwitches.delete(oldest);emitSwitched(oldest);}
        }
        sessionSwitches.set(sessionId, false);
      }
      setSessionSwitchRev(getSessionSwitchRev() + (1));
      if(previous!==body.enabled)emitSwitched(sessionId);
      if (getStore() === undefined || !getSettingsRestored()) {
        // Storage may not have delivered the saved map yet; replay this toggle
        // on top of it when it does, instead of losing it to the older copy.
        pendingSessionSwitchValues.set(sessionId, body.enabled);
      }
      if (body.enabled === false) {
        memoryConsolidator.cancel();
        if (getSettingsRestored()) memories.discardSession(sessionId);
        // Stop spending tokens on a session the user just turned off. The
        // abort is observed by the stream loop and settles the row skipped.
        for (const [key, controller] of activeRewrites) {
          if (key.slice(0, key.lastIndexOf(':')) === sessionId) controller.abort(new Error('session-off'));
        }
        // In-flight turn facts belong to the disabled stretch; a later turn
        // starts them again. Rows already written stay, so re-enabling restores
        // the history the reader had.
        turnState.delete(sessionId);
        candidates.delete(sessionId);
        toolUsage.clear(sessionId);
      }
      progress.configure(sessionId);
      saveSessionSwitches();
      touch(sessionId);
      touch('');
      memoryConsolidator.notify();
      sendJson(res, 200, {
        ok: true,
        sessionId,
        sessionEnabled: body.enabled === true && settings.enabled === true && getEnabledRestored(),
        sessionSwitches: sessionSwitchState(),
      });
      return;
    }

    if (path === `${ROUTE}/diagnostics` && req.method === 'POST') {
      const raw = await readRequestBody(req, 8 * 1024);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      try {
        // Merge, never replace. Each report is a partial fact — the build id
        // arrives at apply time, the renderer verdict at first render, a probe
        // exactly once — so replacing meant the last report erased every earlier
        // one. That is why a perfectly good `applied: true` kept disappearing.
        const report = JSON.parse(raw === '' ? '{}' : raw);
        if (report !== null && typeof report === 'object' && !Array.isArray(report)) {
          const fields = clientDiagnosticFields.filter(key => Object.hasOwn(report, key));
          if (fields.length) setDiagnostics({ ...getDiagnostics(), ...Object.fromEntries(fields.map(key => [key, report[key]])), at: Date.now() });
        }
      } catch { /* A malformed report changes nothing. */ }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === `${ROUTE}/diagnostics`) {
      sendJson(res, 200, {
        ...getDiagnostics(),
        stored: getDiagnostics().at !== undefined,
        // Storage health rides along: a memory-only plugin otherwise looks
        // exactly like a persisting one until a restart loses the history.
        storage: getStoreState(),
        storageError: getStoreError(),
        rowCount: rows.size,
        // What memory has actually learned, so the numbers are inspectable
        // rather than taken on faith.
        memory: {
          messages: getProfile().messages,
          lines: readerMemoryLines(),
          enabled: settings.memory === true,
        },
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
