import { readRequestBody } from './http-body.js';
import { isMemoryRoom } from './chat-memory.js';

function mutationRoom(body, memories) {
  const roomOf = entry => entry?.scope === 'session' && isMemoryRoom(entry.sessionId) ? entry.sessionId : null;
  if (['add','propose-add'].includes(body.action)) return roomOf(body.entry);
  if (body.action === 'confirm') {
    const op = memories.snapshot().operations.find(o => o.id === body.id && o.status === 'pending');
    return op && op.kind !== 'retract' ? roomOf(op.target) : null;
  }
  if (!['update','accept','merge','propose'].includes(body.action) || body.action === 'propose' && body.operation === 'retract') return null;
  const entry = memories.snapshot().entries.find(e => e.id === (body.action === 'merge' ? body.keep : body.id));
  return roomOf(entry) ?? (body.action === 'update' ? roomOf({...entry,...body}) : null);
}

export function createHostMemoryRoutes({
  memories, memoryConsolidator, memoryState, getPresets, ROUTE, saveMemoryMutation, sendJson,
  settings, getSettingsRestored, getStore, getStoreClosing, withMemoryRoom,
}) {
  return async function handleMemoryRoutes(req, res, url, path) {
    if (path === ROUTE + '/memory' && req.method === 'GET') {
      sendJson(res, 200, memoryState()); return;
    }

    if (path === ROUTE + '/memory/handoffs' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session');
      const personaId = url.searchParams.get('persona');
      if (!sessionId || !personaId) { sendJson(res, 400, { error: 'session-and-persona-required' }); return; }
      const snapshot=memories.snapshot();
      sendJson(res, 200, { enabled:settings.memory, choices:settings.memory?memories.handoffChoices(sessionId):[], handoffs: snapshot.handoffs.filter((h) =>
        h.sessionId === sessionId && h.toPersonaId === personaId).map((h) => ({
          ...h, ...memories.handoffContext(h.id, { sessionId, personaId }),
        })) });
      return;
    }

    if ([ROUTE + '/memory', ROUTE + '/memory/handoffs'].includes(path) && req.method === 'POST') {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) {
        sendJson(res, 503, { error: 'storage-not-ready' }); return;
      }
      const raw = await readRequestBody(req, 32768);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'invalid-memory-action' }); return;
      }
      if (body.action === 'consolidate' && path === ROUTE + '/memory') {
        if (!settings.memory || !settings.memoryExtraction || !settings.enabled) {
          sendJson(res, 400, { error: 'memory-extraction-disabled' }); return;
        }
        void memoryConsolidator.start();
        sendJson(res, 200, memoryState()); return;
      }
      let result;
      try {
        const personaIds = [body.entry?.personaId, body.personaId, body.fromPersonaId, body.toPersonaId].filter(Boolean);
        if (personaIds.some((id) => !getPresets().some((preset) => preset.id === id))) throw new Error('persona-not-found');
        memoryConsolidator.cancel();
        const save=()=>saveMemoryMutation(body, { handoff: path === ROUTE + '/memory/handoffs' });
        const roomId = path === ROUTE + '/memory' && mutationRoom(body,memories);
        result = roomId ? await withMemoryRoom(roomId,save) : await save();
      } catch (error) {
        memoryConsolidator.notify();
        const reason = error instanceof Error ? error.message : 'invalid-memory-action';
        const known = /^(?:invalid-|memory-|handoff-|private-|persona-|session-|unproven-)/.test(reason);
        sendJson(res, reason==='handoff-not-found' ? 404 : reason.endsWith('-conflict') ? 409 : known ? 400 : 503,
          { error: known ? reason : 'memory-save-failed', ...(error.capacity ? {capacity:error.capacity} : {}) }); return;
      }
      memoryConsolidator.notify();
      sendJson(res, 200, { ...memoryState(), result });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
