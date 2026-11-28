import { readRequestBody } from './http-body.js';
import { reportViewIssue } from './report-views.js';

export function createHostReportRoutes({
  conversationErrors, conversations, conversationState, hydrate, latestSourceSeq, manualReportRow,
  memoryConsolidator, memories, personaFor, getPresets, reportRetryUnavailable, reportViewJobs, reportViews,
  revisionFor, rewrite, ROUTE, rows, samples, saveMemoryMutation, sendJson, sessionRows,
  setReportRow, settings, getSettingsRestored, getStore, getStoreClosing, getStoreState, touch,
  trackModelTask,
}) {
  return async function handleReportRoutes(req, res, url, path) {
    if (path === ROUTE + '/report-visualization' && (req.method === 'GET' || req.method === 'POST')) {
      let body;
      try {
        if (req.method === 'GET') body = { sessionId: url.searchParams.get('session'), seq: Number(url.searchParams.get('seq') ?? NaN),
          presentation: url.searchParams.get('presentation') ?? undefined };
        else {
          const raw = await readRequestBody(req, 4096);
          if (raw === undefined) throw Error('invalid-report-request');
          body = JSON.parse(raw);
        }
        const id = body?.sessionId, seq = body?.seq;
        if (typeof id !== 'string' || !id.trim() || id.length > 200 || !Number.isSafeInteger(seq) || seq < 0) throw Error('invalid-report-request');
        if (body.presentation !== undefined && !['summary', 'emphasis', 'readable'].includes(body.presentation)) throw Error('invalid-report-request');
        if (req.method === 'GET') { sendJson(res, 200, reportViewJobs.state(id, seq, body.presentation)); return; }
        if (!['generate', 'cancel'].includes(body.action) || typeof body.requestId !== 'string'
          || !body.requestId.trim() || body.requestId.length > 200) throw Error('invalid-report-request');
        if (body.action === 'cancel') {
          if (body.sourceHash !== undefined && (typeof body.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.sourceHash))) throw Error('invalid-report-request');
          const outcome = reportViewJobs.cancel(body);
          sendJson(res, 200, { ok: true, outcome }); return;
        }
        if (getStoreClosing()) throw Error('report-cancelled');
        if (getStoreState() === 'opening') { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
        if (typeof body.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.sourceHash)
          || (body.regenerate !== undefined && typeof body.regenerate !== 'boolean')) throw Error('invalid-report-request');
        sendJson(res, 200, await reportViewJobs.generate(body));
      } catch (error) {
        const known = /^(report-|invalid-report-)/.test(error?.message ?? ''), code = known ? error.message : 'report-unavailable';
        const status = code === 'invalid-report-request' ? 400
          : ['report-source-changed', 'report-request-conflict', 'report-busy', 'report-cancelled'].includes(code) ? 409
            : ['report-too-long', 'report-invalid-output', 'report-incomplete'].includes(code) ? 422 : 503;
        sendJson(res, status, { error: code, ...(code === 'report-invalid-output' && reportViewIssue(error?.issue)
          ? { issue: reportViewIssue(error.issue) } : {}) });
      }
      return;
    }

    if (path === ROUTE + '/conversation' && req.method === 'GET') {
      const id = url.searchParams.get('session');
      if (!id || id.length > 200) { sendJson(res, 400, { error: 'invalid-session' }); return; }
      sendJson(res, 200, conversationState(id)); return;
    }

    if ([ROUTE + '/conversation', ROUTE + '/feedback'].includes(path) && req.method === 'POST') {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      const raw = await readRequestBody(req, 8192);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const sessionId = body?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) {
        sendJson(res, 400, { error: 'invalid-session' }); return;
      }
      if (path === ROUTE + '/conversation') {
        hydrate(sessionId);
        const latest = Math.max(latestSourceSeq.get(sessionId) ?? -1,
          ...[...sessionRows(sessionId)].map((r) => r.seq));
        try {
          const update = handoffId => conversations.update(sessionId, {...body,handoffId}, { knownPersona: (id) => getPresets().some((p) => p.id === id),
            currentPersonaId: () => personaFor(sessionId).id, latestSeq: latest,
            validHandoff:(id,from,to)=>settings.memory && memories.snapshot().handoffs.some(h=>h.id===id && h.status==='pending' && h.fromPersonaId===from && h.toPersonaId===to && h.sessionId===sessionId)
              && Object.values(conversations.snapshot().sessions).every(s=>s.relay?.handoffId!==id) });
          if (body.action === 'relay' && body.handoff) {
            let card;
            await saveMemoryMutation({action:'create'},{handoff:true, requireEnabled:true,
              applyChange:staged=>card=staged.handoff({action:'create',summary:body.handoff.summary,memoryIds:body.handoff.memoryIds,
                sessionId,fromPersonaId:personaFor(sessionId).id,toPersonaId:body.toPersonaId}), finish:()=>update(card.id)});
          } else await update(body.handoffId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'conversation-save-failed';
          sendJson(res, reason.includes('conflict') || reason === 'relay-already-pending' ? 409
            : ['invalid-session', 'invalid-trigger', 'persona-not-found', 'relay-same-persona', 'invalid-conversation-action','invalid-handoff','private-handoff-memory','memory-disabled'].includes(reason) ? 400 : 503,
          { error: reason, conversation: conversationState(sessionId) }); return;
        }
        conversationErrors.delete(sessionId);
        touch(sessionId);
        sendJson(res, 200, conversationState(sessionId)); return;
      }
      hydrate(sessionId);
      const existing=rows.get(`${sessionId}:${body.seq}`);
      let row=existing??manualReportRow(sessionId,body.seq);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!row || (!existing&&body.sourceHash!==row.sourceHash) || row.version !== body.version || row.speaker?.id !== body.personaId
        || (body.scope!=='once'&&row.status!=='ready')) {
        sendJson(res, 409, { error: 'report-conflict' }); return;
      }
      if (!content || content.length > 240 || !['once', 'persona', 'session', 'shared'].includes(body.scope)||body.thinking!==undefined&&typeof body.thinking!=='boolean') {
        sendJson(res, 400, { error: 'invalid-feedback' }); return;
      }
      const speaker = getPresets().find((p) => p.id === row.speaker.id);
      if (!speaker) { sendJson(res, 400, { error: 'persona-not-found' }); return; }
      if (body.scope !== 'once') {
        if (!settings.memory) { sendJson(res, 400, { error: 'memory-disabled' }); return; }
        let entry;
        try {
          memoryConsolidator.cancel();
          entry = await saveMemoryMutation({ action: 'add', entry: { kind: 'preference', content, scope: body.scope,
            personaId: body.scope === 'persona' ? speaker.id : null, sessionId: body.scope === 'session' ? sessionId : null } },
          { requireEnabled: true });
        } catch (error) {
          memoryConsolidator.notify();
          sendJson(res, error?.message === 'memory-conflict' ? 409 : 503,
            { error: ['memory-capacity', 'memory-conflict'].includes(error?.message) ? error.message : 'memory-save-failed' }); return;
        }
        memoryConsolidator.notify(); touch(sessionId);
        sendJson(res, 200, { ok: true, entry }); return;
      }
      const unavailable=reportRetryUnavailable(row,sessionId);
      if(unavailable){sendJson(res,['feedback-in-progress','report-incomplete'].includes(unavailable)?409:400,{error:unavailable});return;}
      if(!existing)row=setReportRow(`${sessionId}:${body.seq}`,row);
      row.retrying = true; row.feedbackError = undefined; touch(sessionId);
      const draft = { ...row, status: 'pending', partial: '', processNote: undefined, processUsage: undefined };
      const retryRevision = revisionFor(sessionId);
      await trackModelTask(rewrite({ sessionId, seq: body.seq, text: row.original, rowOverride: draft, packOverride: speaker, feedback: content, manual:true,thinking:body.thinking!==false }));
      row.retrying = false;
      if (getStoreClosing()) { sendJson(res, 503, { error: 'disposed' }); return; }
      if (rows.get(`${sessionId}:${body.seq}`) !== row || row.version !== body.version
        || (!existing&&reportViews.read(sessionId,body.seq)?.source?.hash!==body.sourceHash)) {
        sendJson(res, 409, { error: 'report-conflict' }); return;
      }
      if (draft.status !== 'ready' || retryRevision !== revisionFor(sessionId)
        || getPresets().find((p) => p.id === speaker.id)?.pack !== speaker.pack) {
        if(draft.reason==='expression-thinking-unavailable'){row.feedbackError='当前模型无法启用思考，原汇报与输入已保留；可更换模型，或关闭本次思考后重试。';touch(sessionId);sendJson(res,422,{error:'feedback-thinking-unavailable'});return;}
        row.feedbackError = '这次调整没有完成，已保留原来的汇报。'; touch(sessionId);
        sendJson(res, 422, { error: 'feedback-rewrite-failed' }); return;
      }
      Object.assign(row, draft, { final: row.final, version: row.version + 1, retrying: false, feedbackError: undefined });
      samples.delete(sessionId); touch(sessionId);
      sendJson(res, 200, { ok: true,version:row.version,personaId:row.speaker.id }); return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
