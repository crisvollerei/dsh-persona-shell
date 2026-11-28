import { userInput } from './user-text.js';

export function createHostSessionEvents({
  activeRewrites, candidates, chatContext, getDiagnostics, getEnabledRestored, enqueue,
  hasToolCall, isSubagent, isUserMessage, latestSourceSeq, looksLikePastedPersona,
  noteSessionActivity, observeUserText, personaFor, progress, reportFits, reportText, reportViews,
  rewriteAllowedFor, roomContexts, rows, samples, sessionEnabledFor, settings, getSettingsRestored,
  skip, getStoreClosing, toolUsage, getToolUsageRestored, touch, triggerFor, turnState,
}) {
  function onSessionEvent(session, event) {
    if (getStoreClosing() || typeof session?.id !== 'string' || !event) return;
    noteSessionActivity(session, event);
    reportViews.event(session, event);
    chatContext.event(session, event);
    for (const context of roomContexts.values()) context.event(session,event);
    if (typeof session?.id === 'string' && Number.isSafeInteger(event.seq)) {
      latestSourceSeq.set(session.id, Math.max(event.seq, latestSourceSeq.get(session.id) ?? -1));
    }
    const observeUsage = triggerFor(session?.id) === 'step' && getToolUsageRestored() && settings.processToolUsage === true
      && settings.includeToolSteps === true && !getStoreClosing() && rewriteAllowedFor(session?.id)
      && !isSubagent(session) && session?.header?.origin !== 'subagent';
    let usage;
    if (observeUsage) usage = toolUsage.event(session, event);
    else toolUsage.clear(session?.id);
    progress.event(session, event);
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !settings.enabled || !getEnabledRestored()) return;
    // A per-session switch turns off rewriting *and* memory observation for that
    // conversation. Returning here is what keeps a disabled session from
    // spending a model call or silently feeding the shared reader profile.
    if (!sessionEnabledFor(sessionId)) return;

    // Diagnostic: record the event types actually seen, so the memory feature can
    // be built on observed shapes instead of an assumed one.
    if (getDiagnostics().seenTypes === undefined) getDiagnostics().seenTypes = {};
    if (typeof event.type === 'string') {
      getDiagnostics().seenTypes[event.type] = (getDiagnostics().seenTypes[event.type] ?? 0) + 1;
    }

    // Shape probe for the subagent switch. `delegationDepth` lives on the
    // session header: 0 (or absent) for a session the user opened, >0 for a
    // subagent's. Collected across distinct sessions so both kinds are seen.
    // (Verified on this build: main = 0, spawned teammate = 1.)

    // Memory: learn from what the user writes. Only user-authored text is
    // evidence about the reader; assistant output and tool traffic say nothing
    // about how someone wants to be spoken to.
    //
    // The switch is checked here, not only where the memory is consumed. Turning
    // it off must stop collection as well as use — otherwise the profile keeps
    // growing while the UI says the feature is off, which is a privacy promise
    // broken silently.
    //
    // `settingsRestored` guards the startup window. The stored switches arrive
    // asynchronously, so between `apply` and the storage opening, `settings.memory`
    // still holds its default `true` — a user who had switched memory off would
    // have their first messages collected and persisted before the saved value
    // came back. Collection waits until the real value is known.
    if (isUserMessage(event)) {
      const input = userInput(event.data), text = input?.text;
      if (text != null && settings.memory === true && getSettingsRestored() && !isSubagent(session)
        && session?.header?.origin !== 'subagent' && !looksLikePastedPersona(text)) {
        observeUserText(text, { sessionId, seq: event.seq, personaId: personaFor(sessionId).id });
      }
      // A real steering message starts a new question, even within the same
      // turn. A report that predates it cannot be its final answer.
      const state = turnState.get(sessionId);
      const turn = event.data?.turn ?? event.data?.message?.turn;
      if (input && state && event.seq > (state.reportCursor ?? -1)
        && !(Number.isSafeInteger(turn) && Number.isSafeInteger(state.turn) && turn < state.turn)) {
        candidates.delete(sessionId);
        state.lastSeq = undefined;
        state.reportCursor = event.seq;
      }
      return;
    }

    if (event.type === 'request/header') {
      const state = turnState.get(sessionId) ?? {};
      if (Number.isSafeInteger(event.seq)) {
        if (event.seq <= (state.routeSeq ?? -1)) return;
        state.routeSeq = event.seq;
      }
      const header = event.data?.header;
      state.provider = header?.config?.provider;
      state.model = header?.config?.model;
      turnState.set(sessionId, state);
      return;
    }

    if (!['turn/start', 'assistant/message', 'turn/end'].includes(event.type)) return;
    const state = turnState.get(sessionId) ?? {};
    if (!Number.isSafeInteger(event.seq) || event.seq <= (state.reportCursor ?? -1)) return;
    if (state.turn != null && event.data?.turn != null && event.data.turn < state.turn) return;
    state.reportCursor = event.seq;
    turnState.set(sessionId, state);

    if (event.type === 'turn/start') {
      state.turn = event.data?.turn;
      state.lastSeq = undefined;
      candidates.delete(sessionId);
      return;
    }

    if (event.type === 'turn/end') {
      // Mark the step that closed this turn. The page shows the persona badge
      // and the 「原文」 toggle on that one only: a control on every mid-turn
      // narration turns the transcript into a wall of chrome, while the closing
      // report is the one a reader actually wants to compare.
      const matchesTurn = state.turn == null || event.data?.turn == null || state.turn === event.data.turn;
      const reason = event.data?.reason?.kind;
      const closing = matchesTurn && reason === 'completed' ? state.lastSeq : undefined;
      // Legacy streams can omit the finish chunk. If the first evidence of
      // truncation is the turn end, withdraw only this turn's last source.
      if (matchesTurn && reason === 'max-tokens' && state.lastSeq !== undefined) {
        const key = `${sessionId}:${state.lastSeq}`;
        if (rows.get(key)?.original !== undefined) {
          activeRewrites.get(key)?.abort(Error('source-max-tokens'));
          samples.delete(sessionId);
          skip(sessionId, state.lastSeq, 'source-max-tokens');
        }
      }
      state.lastSeq = undefined;
      if (typeof closing === 'number') {
        const row = rows.get(`${sessionId}:${closing}`);
        if (row !== undefined) {
          row.final = true;
          row.finalInferred = false;
          row.processNote = undefined;
          row.processUsage = undefined;
          touch(sessionId);
        }
      }

      // `report` mode only rewrites the last report of a finished turn.
      if (triggerFor(sessionId) === 'report') {
        const candidate = candidates.get(sessionId);
        candidates.delete(sessionId);
        if (candidate !== undefined && candidate.seq === closing) {
          enqueue(sessionId, candidate.seq, candidate.text);
          // `enqueue` is what creates the row, so the `final` marking above runs
          // before the row exists and silently does nothing in this mode. Mark it
          // here instead, after creation.
          const created = rows.get(`${sessionId}:${candidate.seq}`);
          if (created !== undefined) {
            created.final = true;
            created.finalInferred = false;
            touch(sessionId);
          }
        }
      }
      return;
    }

    state.sourceIsSubagent = isSubagent(session);
    // A later committed assistant message supersedes the earlier candidate,
    // even when it is interrupted, tool-only, too long or otherwise ineligible.
    candidates.delete(sessionId);
    state.lastSeq = undefined;
    if (event.data?.turn != null) state.turn = event.data.turn;

    // Every settled message carries the route that produced it, so the rewrite
    // follows the conversation's own model without waiting for a request
    // header (those are emitted only on a new series or a config change).
    const source = event.data?.message?.source;
    if (typeof source?.provider === 'string' && typeof source?.model === 'string') {
      state.provider = source.provider;
      state.model = source.model;
    }
    const text = reportText(event, settings.includeToolSteps);
    if (text === undefined) return;

    const process = hasToolCall(event);
    if (!process) state.lastSeq = event.seq;
    if (!reportFits(text)) { skip(sessionId, event.seq, 'too-long'); return; }

    // Subagent sessions: a spawned helper's own conversation. Two independent
    // switches, because its mid-task chatter and its final answer are different
    // propositions — the chatter is usually never read, the conclusion often is.
    if (isSubagent(session)) {
      const allowed = process ? settings.subagentSteps === true : settings.subagentReports === true;
      if (!allowed) {
        skip(sessionId, event.seq, process ? 'subagent-step-off' : 'subagent-report-off');
        return;
      }
    }

    if (triggerFor(sessionId) === 'report') {
      if (!process) candidates.set(sessionId, { seq: event.seq, text });
      return;
    }

    enqueue(sessionId, event.seq, text, usage, process);
  }

  return {
    onSessionEvent,
  };
}
