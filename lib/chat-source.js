import { userInput } from './user-text.js';
import { sourceOutputUsable } from './source-report.js';

const folderName = value => String(value ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '未命名项目';
const plain = content => (Array.isArray(content) ? content : []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b=>b.text).join('\n');
const sequence = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const endings = new Set(['completed', 'blocked', 'aborted', 'error', 'max-tokens']);

/** Latest turn/goal and, when useful, the preceding turn's settled report. */
function workProjection(events, cachedName) {
  let current, previous = null, lastClosedTurn = null, cursor = -1, name = cachedName, start = 0;
  // Repeated reads of long-running sessions need only the last two turn spans.
  // Session titles may predate both when there is no cached title.
  let starts = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (cursor < 0 && sequence(event.seq) !== null) cursor = event.seq;
    if (!name && event.type === 'session/title' && typeof event.data?.title === 'string') name = event.data.title;
    if (starts < 2 && event.type === 'turn/start' && ++starts === 2) start = i;
    if (starts === 2 && name && cursor >= 0) break;
  }
  const begin = (turn, marker) => {
    if (current?.ended) lastClosedTurn = current.turn;
    previous = current?.status === 'completed' && current.report && current.lastWasReport
      ? { turn: current.turn, seq: sequence(current.report.seq), text: plain(current.report.data.message.content) } : null;
    current = { turn, startSeq: sequence(marker?.seq), status: marker ? 'running' : 'unknown', ended: false, goal:'', goalSeq:null, report:null, lastWasReport:false };
  };
  for (let i = start; i < events.length; i++) {
    const event = events[i], data = event.data, turn = sequence(data?.turn ?? data?.message?.turn);
    if (event.type === 'turn/start') {
      // Some adapters deliver a numbered user message just before its start.
      if (turn !== null && current?.turn === turn && current.status === 'unknown' && !current.report) {
        current.startSeq = sequence(event.seq); current.status = 'running';
      } else begin(turn, event);
      continue;
    }
    if (current?.status === 'unknown' && current.turn === null && lastClosedTurn !== null && turn !== null && turn <= lastClosedTurn) continue;
    if (event.type === 'user/message' || event.type === 'user-message') {
      const input = userInput(data);
      if (input === null) continue;
      // Committed steering normally has no turn field (the surrounding DSH
      // span owns it). If an adapter supplies one, never attach a late command
      // to a different active span, or reopen its explicitly finished turn.
      if (turn !== null && current?.turn != null) {
        if (current.ended && turn <= current.turn) continue;
        if (!current.ended && turn !== current.turn) {
          if (current.status !== 'unknown' || turn < current.turn) continue;
          begin(turn);
        }
      }
      if (!current || current.ended) begin(turn);
      else if (current.turn === null) current.turn = turn;
      // Steering can add a *new* goal within the same DSH turn. A report that
      // predates this input cannot answer it, even when the turn number matches.
      current.goal = input.text ?? ''; current.goalSeq = sequence(event.seq);
      current.goalHasAttachments = input.hasAttachments; current.report = null; current.lastWasReport = false;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') continue;
    if (!current) begin(turn);
    if (turn !== null && current.turn !== null && turn !== current.turn) continue;
    if (current.turn === null) current.turn = turn;
    if (event.type === 'turn/end') {
      current.status = endings.has(data?.reason?.kind) ? data.reason.kind : 'ended'; current.ended = true;
      // A length stop can leave an apparently valid text block cut mid-condition.
      if (current.status === 'max-tokens') current.report = null;
      continue;
    }
    if (current.ended) continue;
    const content = data?.message?.content;
    current.lastWasReport = sourceOutputUsable(data) && Array.isArray(content)
      && !content.some(b => b?.type === 'tool-call') && content.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
    if (current.lastWasReport) current.report = event;
  }
  const report = current?.report;
  return { name, cursor, turn: current?.turn ?? null, turnStartSeq: current?.startSeq ?? null,
    turnStatus: current?.status ?? 'unknown', goal: current?.goal ?? '', goalSeq: current?.goalSeq ?? null,
    goalHasAttachments: current?.goalHasAttachments === true,
    report: report ? plain(report.data.message.content) : '', reportSeq: sequence(report?.seq),
    reportStatus: !report ? 'none' : current.status === 'completed' && current.lastWasReport ? 'final' : 'progress',
    previousReport: !report ? previous : null };
}
function cachedTitle(ctx, header) {
  if (typeof header?.title === 'string') return header.title;
  const values = ctx.get('sessionProjectionCache')?.cachedSnapshot?.(header)?.values ?? {};
  for (const [key,value] of Object.entries(values)) if (/title/i.test(key)) {
    const title = typeof value === 'string' ? value : value?.title ?? value?.text ?? value?.value?.title;
    if (typeof title === 'string') return title;
  }
}

/** Adapter over registered Workspaces and passive SessionQuery reads, never Agent acquisition or file scanning. */
export function createChatSourceAdapter(ctx) {
  const projects = () => ctx.get('workspaceRegistry')?.list?.() ?? [];
  const projectForPath = cwd => cwd ? projects().find(p => p.path === cwd)?.id ?? null : null;
  const metadata = async (sessionId, signal) => {
    signal?.throwIfAborted();
    const live = ctx.get('sessions')?.get(sessionId);
    const stored = live ? undefined : await ctx.get('sessionPersistence')?.stat?.(sessionId, { signal });
    signal?.throwIfAborted(); const header = live?.header ?? stored?.header;
    const liveTitle=live?ctx.get('sessionTitle')?.get?.(live)?.title:undefined;
    return { live, header, name: liveTitle ?? (header ? cachedTitle(ctx,header) : undefined) };
  };
  return {
    async projects(signal) {
      signal?.throwIfAborted();
      // Deliberately do not touch title, sessionIds or persistence for unused projects.
      return projects().map(p=>({ id:p.id, name:folderName(p.path) }));
    },
    projectForSession(sessionId) { return projectForPath(ctx.get('sessions')?.get(sessionId)?.header?.cwd); },
    async sessions(projectId, signal) {
      const project = projects().find(p=>p.id===projectId); if (!project) throw Error('context-project-missing');
      const result=[];
      for (const sessionId of project.sessionIds.slice(0,80)) {
        const { header, name } = await metadata(sessionId,signal);
        if (header?.origin === 'subagent' || header?.parentSession) continue;
        result.push({ sessionId, name: name || '会话 ' + sessionId.slice(0,8) });
      }
      return result;
    },
    async source(sessionId, signal) {
      const { live, header, name } = await metadata(sessionId,signal);
      const query = ctx.get('sessionQuery'); let observation;
      try {
        if (typeof query?.observeSession === 'function') observation = await query.observeSession(sessionId, { signal, projectionMode:'none' });
        signal?.throwIfAborted();
        const events = observation?.events ?? live?.snapshotEvents?.();
        if (!Array.isArray(events)) return null;
        const projection = workProjection(events, name);
        return { ...projection, name:projection.name || '会话 '+sessionId.slice(0,8), projectId:projectForPath(header?.cwd ?? observation?.header?.cwd),
          running:ctx.get('agents')?.get(sessionId)?.status==='running' };
      } finally { observation?.[Symbol.dispose]?.(); }
    },
  };
}
