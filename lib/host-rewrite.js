import { mask, unmask } from './mask.js';
import { buildPreparedRewritePrompt, rewriteDistance, validateRewrite } from './prompt.js';
import { prepareReportRequest } from './report-request.js';
import { assessRewrite } from './review.js';
import { restoreToolUsage } from './tool-usage.js';
import { runProcessRewrite } from './process-rewrite.js';
import { sourceOutputUsable } from './source-report.js';
import { checkReportFidelity, strictSelfReference } from './report-fidelity.js';

export function createHostRewrite({
  activeProcessRewrites, activeRewritePersonas, activeRewrites, cfg, conversationErrors,
  conversations, getEnabledRestored, expressionLlm, expressionMemory, inFlight, modelRoutes,
  notifySession, personaFor, getPresets, reportViews, resolveRouteAsync, revisionFor,
  rewriteAllowedFor, rewriteBlockReason, routePair, rows, samples, setReportRow, settings,
  getSettingsRestored, getStoreClosing, STREAM_INTERVAL_MS, streamWithSignal, toolUsage,
  getToolUsageRestored, getToolUsageRevision, touch, trackModelTask, trim, turnState,
  waitWithSignal, warn, getReportAddress, emitRewrite, memories, finishRelayCard,
}) {
  /**
   * Rewrite one text. Never throws: any failure settles the row without text,
   * which the page renders as the plain report.
   */
  async function rewrite({ sessionId, seq, text, usage, usageRevision, rowOverride, packOverride, feedback = '', manual = false,thinking=true, relayFrom, relayCard }) {
    const key = `${sessionId}:${seq}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    const row = rowOverride ?? rows.get(key);
    if (row === undefined) { inFlight.delete(key); return; }
    const revision = revisionFor(sessionId);
    const persona = packOverride ?? personaFor(sessionId);
    const allowed = () => manual ? !getStoreClosing() && getSettingsRestored() && getEnabledRestored() : rewriteAllowedFor(sessionId);
    const processAllowed = () => rewriteAllowedFor(sessionId) && revision === revisionFor(sessionId)
      && settings.includeToolSteps === true && settings.processToolUsage === true
      && getToolUsageRestored() && usageRevision === getToolUsageRevision();
    const processMode = usage !== undefined && processAllowed();
    const settle = (status, reason, value) => {
      if (getStoreClosing()) return;
      row.status = status;
      row.reason = reason;
      row.text = value ?? '';
      row.partial = '';
      row.partialLiterals = undefined;
      row.memoryRefs = [];
      touch(sessionId);
    };

    const { masked, literals } = mask(text);
    if (!allowed() || masked.replace(/\[\[\d+\]\]/g, '').trim().length < 2) {
      settle('skipped', !allowed()?rewriteBlockReason(sessionId):'no-prose');
      inFlight.delete(key);
      trim(sessionId);
      return;
    }

    // Route discovery belongs to the same cancellation and deadline as generation.
    const abort = new AbortController();
    activeRewrites.set(key, abort);
    activeRewritePersonas.set(key, persona.id);
    if (processMode) activeProcessRewrites.set(key, abort);
    const timer = setTimeout(() => abort.abort(new Error('rewrite-timeout')), Math.max(1000, cfg.timeoutMs));
    let memoryContext;
    let rejected = false;
    if (!manual) emitRewrite('rewrite:started', sessionId, seq, persona.id);
    try {
      const llm = expressionLlm('rewrite', () => {
        memoryContext?.usage?.sent();
        row.memoryRefs = (memoryContext?.entries ?? []).map((e) => ({ id: e.id, version: e.version }));
      },manual?{thinking,thinkingRequired:thinking,reasoningEffort:settings.reasoningEffort}:undefined);
      if (llm === undefined) { settle('skipped', 'no-llm'); return; }
      const route = await waitWithSignal(manual?modelRoutes.resolve(sessionId,undefined,{signal:abort.signal,reportRoute:reportViews.route(sessionId,seq)}).then(routePair):resolveRouteAsync(sessionId,abort.signal), abort.signal);
      abort.signal.throwIfAborted();
      if (!allowed()) { settle('skipped', rewriteBlockReason(sessionId)); return; }
      if (revision !== revisionFor(sessionId)) { settle('skipped', 'persona-changed'); return; }
      if (route === undefined) { settle('skipped', 'no-route'); return; }

      memoryContext = expressionMemory(persona.id, sessionId, text, feedback ? 'retry' : processMode ? 'process' : 'report');
      const maxRatio = feedback ? Math.max(cfg.maxRatio, 1.7) : cfg.maxRatio;
      let handoff;
      if (settings.memory && relayCard) {
        try {
          const context = memories.handoffContext(relayCard.handoffId, {personaId:persona.id, sessionId});
          if (context.status === 'pending') handoff = {summary:context.summary, memories:context.memories.map(e=>e.content)};
        } catch (error) {
          // Clearing memory can remove a scheduled card before the relay's first report.
          if (error.message !== 'handoff-not-found') throw error;
        }
      }
      const prepared = prepareReportRequest({
        pack: persona.pack,
        persona:{id:persona.id,builtin:persona.builtin===true},
        masked,
        literalCount: literals.length,
        history: feedback ? [] : samples.get(sessionId) ?? [],
        memory: memoryContext.entries.map((e) => e.content),
        processTools: processMode,
        colloquialReports: settings.colloquialReports,
        maxRatio,
        feedback,
        userAddress: getReportAddress(), relayFrom, handoff,
        sourceIsSubagent: row.sourceIsSubagent === true,
      });
      const { system, user } = buildPreparedRewritePrompt(prepared);
      const options = {
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        signal: abort.signal,
      };
      let collected = '';
      let processNote;
      let lastEmit = 0;
      const flush = (force) => {
        const now = Date.now();
        if (!force && now - lastEmit < STREAM_INTERVAL_MS) return;
        lastEmit = now;
        row.partial = collected;
        row.partialLiterals = literals;
        notifySession(sessionId);
      };
      if (processMode) {
        const result = await runProcessRewrite({ llm, options, usage, allowed: processAllowed,
          maxChars: Math.ceil(Math.max(masked.length * maxRatio, masked.length + 200) * 6 + 1024),
          onPartial(value) { collected = value; flush(false); } });
        collected = result.text;
        processNote = result.note;
      } else {
        let finish;
        for await (const chunk of streamWithSignal(llm, options)) {
          abort.signal.throwIfAborted();
          if (!allowed()) throw new Error(rewriteBlockReason(sessionId));
          if (chunk.type === 'text-delta') {
            collected += chunk.text;
            if (collected.length > Math.ceil(Math.max(masked.length * maxRatio, masked.length + 200) * 6 + 1024)) throw Error('output-too-long');
            flush(false);
          } else if (chunk.type === 'error' || chunk.type.startsWith('tool-call') || chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
            throw Error(chunk.type === 'error' ? 'model-error' : 'unexpected-tool-call');
          } else if (chunk.type === 'finish') {
            finish = chunk.reason?.kind;
            if (finish !== 'stop') throw new Error(`finish-${finish ?? 'unknown'}`);
          }
        }
        if (finish !== 'stop') throw new Error('finish-missing');
      }
      abort.signal.throwIfAborted();
      if (!allowed()) { settle('skipped', rewriteBlockReason(sessionId)); return; }
      if (revision !== revisionFor(sessionId)) { settle('skipped', 'persona-changed'); return; }
      const verdict = validateRewrite({
        ...prepared.validationOptions,
        candidate: collected,
        original: masked,
      });
      if (!verdict.ok) { rejected = true; settle('skipped', verdict.reason); return; }

      const candidate = unmask(collected.trim(), literals);
      const fidelity = checkReportFidelity({ ...prepared.fidelityOptions, original: text, candidate,
        maskedOriginal: masked, maskedCandidate: verdict.text });
      if (!fidelity.ok) { rejected = true; settle('skipped', 'source-' + fidelity.reasons[0]); return; }
      row.text = candidate;
      row.model = `${route.provider}/${route.model}`;
      row.status = 'ready';
      row.reason = '';
      if (processMode && processAllowed() && processNote && row.final !== true && toolUsage.claimNote(usage)) {
        row.processNote = processNote;
        row.processUsage = restoreToolUsage(usage);
      }
      row.partial = '';
      row.partialLiterals = undefined;
      row.distance = rewriteDistance(
        masked.replace(/\[\[\d+\]\]/g, ''),
        collected.replace(/\[\[\d+\]\]/g, ''),
      );
      const review = assessRewrite({
        original: text,
        candidate: row.text,
        maskedOriginal: masked,
        maskedCandidate: verdict.text,
      });
      if (prepared.expression.narration?.selfReference === 'none' && strictSelfReference(verdict.text, persona.name, persona.pack)) review.reasons.push('self-reference');
      row.review = review;
      touch(sessionId);

      // Keep only masked samples from the current persona, without runtime observations.
      if (processMode || feedback || persona.id !== personaFor(sessionId).id) return;
      const list = samples.get(sessionId) ?? [];
      list.push(verdict.text);
      while (list.length > Math.max(0, cfg.keepSamples)) list.shift();
      samples.set(sessionId, list);
    } catch (error) {
      const reason = abort.signal.reason ?? error;
      settle('skipped', reason instanceof Error ? reason.message.slice(0, 120) : 'error');
      if (!abort.signal.aborted) warn(`rewrite failed for ${key}`, error);
    } finally {
      memoryContext?.usage?.finish(row.status === 'ready' ? 'generated' : abort.signal.aborted ? 'cancelled' : rejected ? 'rejected' : 'failed');
      clearTimeout(timer);
      abort.abort();
      activeRewrites.delete(key);
      activeRewritePersonas.delete(key);
      activeProcessRewrites.delete(key);
      inFlight.delete(key);
      if (!manual) emitRewrite(row.status === 'ready' ? 'rewrite:ready' : 'rewrite:fallback', sessionId, seq, persona.id,
        row.status==='ready'?undefined:rejected?'rejected':['session-off','disabled','persona-changed','persona-deleted',
          'memory-changed','memory-cleared','process-disabled','source-max-tokens','source-incomplete'].includes(row.reason)?'skipped':'failed');
      trim(sessionId);
    }
  }

  /** Queue one text for rewriting. */
  function enqueue(sessionId, seq, text, usage, process = false) {
    if (rows.has(`${sessionId}:${seq}`)) return;
    setReportRow(`${sessionId}:${seq}`, {
      sessionId,
      seq,
      status: 'pending',
      text: '',
      reason: '',
      model: '',
      time: Date.now(),
      process,
      original: text,
      version: 1,
      speaker: { id: personaFor(sessionId).id, name: personaFor(sessionId).name,
        mode: personaFor(sessionId).pack.narration?.mode ?? 'voice' },
      sourceIsSubagent: turnState.get(sessionId)?.sourceIsSubagent === true,
    });
    touch(sessionId);
    const row = rows.get(`${sessionId}:${seq}`);
    const queuedRevision = revisionFor(sessionId);
    const queuedConversation = conversations.read(sessionId);
    const start = async () => {
      let relayFrom, relayCard;
      if (queuedConversation.relay?.status === 'pending') {
        try {
          if (await conversations.take(sessionId, seq, (id) => getPresets().some((p) => p.id === id),queuedConversation.relay.id)) {
            conversationErrors.delete(sessionId);
            relayFrom = getPresets().find(p => p.id === queuedConversation.relay.fromPersonaId)?.name;
            const current=conversations.read(sessionId).relay;
            if (current?.handoffId && current.id===queuedConversation.relay.id && current.consumedSeq===seq) relayCard=current;
          } else if (queuedRevision !== revisionFor(sessionId)) {
            const current = conversations.read(sessionId);
            const joinedRelay = current.revision === queuedConversation.revision + 1
              && current.relay?.id === queuedConversation.relay.id && current.relay.status === 'active'
              && seq >= current.relay.consumedSeq && personaFor(sessionId).id === current.relay.toPersonaId;
            if (!joinedRelay) { row.status = 'skipped'; row.reason = 'persona-changed'; touch(sessionId); return; }
          }
          const persona = personaFor(sessionId);
          row.speaker = { id: persona.id, name: persona.name, mode: persona.pack.narration?.mode ?? 'voice' };
        } catch (error) {
          conversationErrors.set(sessionId, error?.message === 'relay-persona-deleted'
            ? '接手人格已被删除，本次接力已取消。这份汇报保留原文。'
            : '这次接力没有保存成功，这份汇报保留原文；仍等待下一份汇报接手。');
          row.status = 'skipped'; row.reason = 'relay-save-failed'; touch(sessionId); return;
        }
      }
      try {
        if (getStoreClosing() || rows.get(`${sessionId}:${seq}`) !== row) return;
        await rewrite({ sessionId, seq, text, usage, usageRevision: getToolUsageRevision(), relayFrom, relayCard });
      } finally {
        if (relayCard) await finishRelayCard(sessionId,relayCard).catch(error=>warn('handoff close failed',error));
      }
    };
    void trackModelTask(start().finally(() => trim(sessionId)));
  }

  /** Skip a text without spending a call, but still tell the page why. */
  function skip(sessionId, seq, reason) {
    setReportRow(`${sessionId}:${seq}`, {
      sessionId, seq, status: 'skipped', text: '', reason, model: '', time: Date.now(),
    });
    // Trim here too. `trim()` used to run only in `rewrite()`'s finally, so every
    // skipped row — subagent output by default — accumulated without ever being
    // bounded by `maxRowsPerSession`.
    trim(sessionId);
    touch(sessionId);
  }

  /**
   * Whether this session belongs to a subagent rather than the user.
   *
   * `delegationDepth` on the session header is the marker: a session the user
   * opened has depth 0 (or none), a spawned helper's is at least 1. Read from the
   * header because the runtime object is the only place that carries it.
   * @param {any} session
   * @returns {boolean}
   */
  function isSubagent(session) {
    const depth = session?.header?.delegationDepth;
    return typeof depth === 'number' && depth > 0;
  }

  /** Whether this message asked for tools, i.e. it is mid-task rather than a report. */
  function hasToolCall(event) {
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => block?.type === 'tool-call');
  }

  /**
   * Whether this event carries a message the user wrote.
   *
   * The exact type is verified at runtime through the diagnostics route rather
   * than assumed: a wrong guess here is silent (memory would simply never learn
   * anything), which is exactly the failure mode this plugin has been bitten by
   * before.
   * @param {any} event
   */
  function isUserMessage(event) {
    const type = event?.type;
    if (typeof type !== 'string') return false;
    return type === 'user/message' || type === 'user-message';
  }

  /**
   * Pull the readable text of one assistant message, or `undefined` when there is
   * nothing a reader would see.
   *
   * A step that is about to call a tool still emits narration ("现在改常量：…"),
   * and in a long turn that narration is most of what the user reads. Whether it
   * gets the persona treatment is the user's call (`includeToolSteps`), not a
   * silent rule: the earlier version hardcoded it away and the middle of every
   * turn stayed plain.
   * @param {any} event - the committed `assistant/message` event.
   * @param {boolean} includeToolSteps - whether tool-calling steps count.
   */
  function reportText(event, includeToolSteps) {
    if (!sourceOutputUsable(event.data)) return undefined;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const hasToolCall = content.some((block) => block?.type === 'tool-call');
    if (hasToolCall && !includeToolSteps) return undefined;
    const textBlocks = content.filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim());
    // The client needs exactly one nonempty block to anchor the replacement.
    if (textBlocks.length !== 1) return undefined;
    const text = textBlocks[0].text.trim();
    return text === '' ? undefined : text;
  }

  return {
    isSubagent, isUserMessage, reportText, hasToolCall, enqueue, skip, rewrite,
  };
}
