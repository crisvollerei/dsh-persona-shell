import { randomUUID } from 'node:crypto';

export const CONTEXT_LIMITS = Object.freeze({ sources: 6, projects: 300, sessions: 80, notices: 30, chars: 8000,
  focusMs: 15000, normalMs: 60000, leaseMs: 90000 });
const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
const copy = value => structuredClone(value);
const fail = code => { throw Error(code); };
const seq = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const turnStates = new Set(['running','completed','blocked','aborted','error','max-tokens','ended']);
const projectionEvents = new Set(['turn/start', 'user/message', 'user-message', 'assistant/message', 'turn/end']);
const MAX_VISIBLE_VIEWERS = 16;
const MAX_RECENT_VIEWERS = 1024;

/** One lazy, read-only workspace for the chat feature. No timers or model calls. */
export function createChatContext({ adapter, now = Date.now, id = randomUUID } = {}) {
  let initialized = false, opening, disposed = false, rootId, primarySessionId = null, revision = 0;
  let catalog = [], catalogAt = -Infinity, catalogRead;
  const sources = new Map(), reads = new Map(), leases = new Map(), scores = new Map(), touches = new Map();
  const closedViewers = new Map();
  // Attached sources only. An observed event sets a cursor floor; it never starts a read.
  const requiredCursor = new WeakMap();
  const notices = [], seen = new Map(), controllers = new Set(), sourceControllers = new Map();
  const active = () => !disposed && [...leases.values()].some(v => v.expires > now());
  const score = key => { const v = scores.get(key); return v ? v.score * 2 ** (-(now() - v.at) / 600000) : 0; };
  const focus = () => [...scores.keys()].sort((a,b) => score(b) - score(a))[0] ?? null;
  const touch = (sessionId, kind = 'view', viewer = '') => {
    if (!active() || !validId(sessionId)) return;
    const key = sources.get(sessionId)?.projectId ?? adapter.projectForSession?.(sessionId);
    if (!key) return;
    const stamp = viewer + ':' + sessionId + ':' + kind;
    if (now() - (touches.get(stamp) ?? -Infinity) < (kind === 'view' ? 5000 : 1000)) return;
    touches.set(stamp, now()); if (touches.size > 500) touches.delete(touches.keys().next().value);
    scores.set(key, { score: Math.min(30, score(key) + (kind === 'attach' ? 4 : kind === 'message' ? 3 : 1)), at: now() });
    if (scores.size > 300) scores.delete(scores.keys().next().value);
  };
  const cancelReads = () => { for (const ctrl of controllers) ctrl.abort(); controllers.clear(); };
  const read = async (task, sourceId) => {
    const ctrl = new AbortController(); controllers.add(ctrl);
    if(sourceId)sourceControllers.set(sourceId,ctrl);
    const timer = setTimeout(() => ctrl.abort(Error('context-timeout')), 5000); timer.unref?.();
    let abort;
    try {
      return await Promise.race([Promise.resolve().then(() => { ctrl.signal.throwIfAborted(); return task(ctrl.signal); }), new Promise((_, reject) => {
        abort = () => reject(Error('context-cancelled')); ctrl.signal.addEventListener('abort', abort, { once: true });
        if (ctrl.signal.aborted) abort();
      })]);
    } finally { clearTimeout(timer); ctrl.signal.removeEventListener('abort', abort); controllers.delete(ctrl);if(sourceControllers.get(sourceId)===ctrl)sourceControllers.delete(sourceId); }
  };
  const listProjects = async () => {
    if (!active() || now() - catalogAt < 120000) return;
    if(catalogRead)return catalogRead;
    catalogRead=(async()=>{const result = await read(signal => adapter.projects(signal));
      if (!active()) return;
      catalog = (Array.isArray(result) ? result : []).filter(p => validId(p?.id) && typeof p.name === 'string')
        .slice(0, CONTEXT_LIMITS.projects).map(p => ({ id: p.id, name: p.name.slice(0,120) })); catalogAt = now();
    })().finally(()=>{catalogRead=undefined;});return catalogRead;
  };
  const refreshSource = (sessionId, force = false) => {
    const current = sources.get(sessionId);
    if (!current || !active()) return Promise.resolve();
    if (reads.has(sessionId)) return reads.get(sessionId);
    const frequency = current.projectId && current.projectId === focus() ? CONTEXT_LIMITS.focusMs : CONTEXT_LIMITS.normalMs;
    if (!force && now() - (current.checkedAt ?? -Infinity) < frequency) return Promise.resolve();
    const task = (async () => {
      try {
        const value = await read(signal => adapter.source(sessionId, signal),sessionId);
        if (!active() || sources.get(sessionId) !== current) return;
        const cursor = seq(value?.cursor) ?? -1;
        if (cursor < (requiredCursor.get(current) ?? -1)
            || (value && cursor < (current.cursor ?? -1))) {
          current.error = '工作参考待更新'; current.checkedAt = now(); return;
        }
        requiredCursor.delete(current);
        // Copy only the approved projection; adapters cannot smuggle tool bodies.
        const previous = value?.previousReport;
        Object.assign(current, { available: !!value, name: String(value?.name || '会话 ' + sessionId.slice(0,8)).slice(0,120),
          projectId: value?.projectId ?? null, cursor,
          turn: seq(value?.turn), turnStartSeq: seq(value?.turnStartSeq), goalSeq: seq(value?.goalSeq), reportSeq: seq(value?.reportSeq),
          turnStatus: turnStates.has(value?.turnStatus) ? value.turnStatus : 'unknown',
          reportStatus: value?.report ? value.reportStatus === 'final' && value.turnStatus === 'completed' ? 'final' : 'progress' : 'none',
          goal: typeof value?.goal === 'string' && value.goal.length<=2000 ? value.goal : '',
          goalOmitted: typeof value?.goal === 'string' && value.goal.length>2000,
          goalHasAttachments: value?.goalHasAttachments === true,
          report: typeof value?.report === 'string' && value.report.length <= 5000 ? value.report : '',
          reportOmitted: typeof value?.report === 'string' && value.report.length > 5000,
          previousReport: typeof previous?.text === 'string' && previous.text.length > 0 && previous.text.length <= 5000
            ? { turn: seq(previous.turn), seq: seq(previous.seq), text: previous.text } : null,
          previousReportOmitted: typeof previous?.text === 'string' && previous.text.length > 5000,
          running: value?.running === true, checkedAt: now(), error: '' });
      } catch { if (active() && sources.get(sessionId) === current) Object.assign(current, { error: '读取暂未完成', checkedAt: now() }); }
    })().finally(() => { if (reads.get(sessionId) === task) reads.delete(sessionId); });
    reads.set(sessionId, task); return task;
  };
  const snapshot = () => ({ initialized, id: rootId ?? null, revision, primarySessionId, active: active(),
    projects: copy(catalog), sources: [...sources.values()].map(s => ({ ...(requiredCursor.has(s)
      ? {sessionId:s.sessionId,projectId:s.projectId,name:s.name,available:false,error:s.error || '工作参考待更新'}
      : copy(s)), focused: s.projectId === focus() })),
    focusProjectId: focus(), notices: notices.map(n => sources.has(n.sessionId)
      ? { ...n, relatedTo:n.sessionId, attached:true, name:sources.get(n.sessionId).name } : { ...n }), nextPollMs: CONTEXT_LIMITS.focusMs });
  const requireOpen = () => { if (!initialized || !active()) fail('context-not-open'); };
  const requireKey = key => { requireOpen(); if (key !== rootId + ':' + revision) fail('chat-context-changed'); };
  const select = async (sessionId, primary = false) => {
    if (!validId(sessionId)) fail('invalid-context-source');
    if (!sources.has(sessionId)) {
      if (sources.size >= CONTEXT_LIMITS.sources) fail('context-capacity');
      let projectId=null;try{projectId=adapter.projectForSession?.(sessionId)??null;}catch{/* Registry may still be opening. */}
      const source = { sessionId, projectId, name: '正在读取…', available: false };
      sources.set(sessionId, source); revision++;
    }
    if (primary || !primarySessionId) { if (primarySessionId !== sessionId) revision++; primarySessionId = sessionId; }
    touch(sessionId, 'attach'); await refreshSource(sessionId, true);
  };
  return {
    snapshot, active, touch,
    key: () => initialized ? rootId + ':' + revision : null,
    presence(viewer, visible, sequence = 0) {
      if (!validId(viewer) || !Number.isSafeInteger(sequence) || sequence < 0) fail('invalid-context-viewer');
      const stamp = now();
      for (const map of [leases, closedViewers])
        for (const [key, value] of map) if (value.expires <= stamp) map.delete(key);
      const previous = leases.get(viewer) ?? closedViewers.get(viewer);
      if (previous && (sequence < previous.sequence || (sequence === previous.sequence && leases.has(viewer) !== visible))) return false;
      const wasActive = leases.size > 0;
      // Keep closed sequence numbers through the lease window so an earlier
      // open or poll cannot resurrect that viewer. Only visible viewers occupy
      // the concurrent slots; bound the separate replay history under heavy churn.
      if ((!previous && leases.size + closedViewers.size >= MAX_RECENT_VIEWERS)
        || (visible && !leases.has(viewer) && leases.size >= MAX_VISIBLE_VIEWERS)) fail('context-viewer-capacity');
      const lease = { sequence, expires: stamp + CONTEXT_LIMITS.leaseMs };
      if (visible) { closedViewers.delete(viewer); leases.set(viewer, lease); }
      else { leases.delete(viewer); closedViewers.set(viewer, lease); }
      // Events while hidden are deliberately ignored. On resume, don't reuse a still-young
      // snapshot until a visible read has checked what happened in the meantime.
      if (initialized && !wasActive && active()) for (const s of sources.values()) {
        requiredCursor.set(s, Math.max(s.cursor ?? -1, requiredCursor.get(s) ?? -1));
        s.checkedAt = undefined;
      }
      if (!active()) cancelReads();
      return true;
    },
    async open({ sessionId, selection }) {
      if (disposed) fail('context-closed');
      if(sessionId!==undefined && sessionId!==null && !validId(sessionId))fail('invalid-context-source');
      if(selection && (!Array.isArray(selection.sessionIds)||selection.sessionIds.length>CONTEXT_LIMITS.sources
        ||!selection.sessionIds.every(validId)||(selection.primarySessionId!==null&&!selection.sessionIds.includes(selection.primarySessionId))))fail('invalid-context-source');
      if (opening) { await opening; return snapshot(); }
      if (!initialized) {
        rootId = 'context:' + id(); initialized = true;
        opening = (async () => {
          await Promise.allSettled([listProjects(),...(selection?selection.sessionIds:validId(sessionId)?[sessionId]:[])
            .map(id=>select(id,selection?selection.primarySessionId===id:true))]);
        })().finally(() => { opening = undefined; }); await opening;
      } else await this.refresh();
      return snapshot();
    },
    async refresh(force = false) {
      requireOpen(); await Promise.allSettled([listProjects(), ...[...sources.keys()].map(key => refreshSource(key,force))]); return snapshot();
    },
    async prepareCapture(key) {
      requireKey(key);
      await Promise.all([...sources].map(async ([sessionId, source]) => {
        const initialFloor = requiredCursor.get(source), alreadyReading = reads.has(sessionId);
        await refreshSource(sessionId, initialFloor !== undefined);
        requireKey(key);
        // A poll already in flight, or an event during our read, may have left the source
        // behind. Allow one follow-up; an adapter that still lags is omitted by capture.
        if (requiredCursor.has(source) && (alreadyReading || requiredCursor.get(source) !== initialFloor))
          await refreshSource(sessionId, true);
      }));
      requireKey(key);
    },
    async sessions(projectId) {
      requireOpen(); if (!catalog.some(p => p.id === projectId)) fail('invalid-context-project');
      const values = await read(signal => adapter.sessions(projectId, signal));
      if (!active()) fail('context-not-open');
      return (values ?? []).filter(v => validId(v?.sessionId)).slice(0,CONTEXT_LIMITS.sessions)
        .map(v => ({ sessionId: v.sessionId, name: String(v.name || '会话 ' + v.sessionId.slice(0,8)).slice(0,120) }));
    },
    async attach(sessionId, primary = false) { requireOpen(); await select(sessionId, primary); return snapshot(); },
    detach(sessionId) {
      requireOpen(); if (sources.delete(sessionId)) { revision++; if (primarySessionId === sessionId) primarySessionId = sources.keys().next().value ?? null; }
      sourceControllers.get(sessionId)?.abort();reads.delete(sessionId);
      for (let i=notices.length-1;i>=0;i--) {
        const n=notices[i];
        if (n.sessionId === sessionId || (n.relatedTo === sessionId && !sources.has(n.sessionId))) notices.splice(i,1);
      }
      return snapshot();
    },
    dismiss(noticeId) { requireOpen(); const entry = notices.find(n => n.id === noticeId); if (entry) entry.read = true; return snapshot(); },
    event(session, event) {
      if (!initialized || !active() || !Number.isSafeInteger(event?.seq)) return;
      const direct = sources.has(session?.id), parent = session?.header?.parentSession;
      if (!direct && !sources.has(parent)) return;
      const attached = sources.get(session.id);
      if (attached && projectionEvents.has(event.type) && event.seq > (attached.cursor ?? -1))
        requiredCursor.set(attached, Math.max(event.seq, requiredCursor.get(attached) ?? -1));
      // DSH also dispatches agent/error outside the session log. Use only the
      // committed turn ending for a notice, even if both events are forwarded.
      // Never read an error's message or stack.
      if (event.type !== 'turn/end') return;
      const key = session.id; if (event.seq <= (seen.get(key) ?? -1)) return;
      seen.set(key,event.seq); if (seen.size > 500) seen.delete(seen.keys().next().value);
      notices.push({ id: key + ':' + event.seq, sessionId: key, relatedTo: direct ? key : parent,
        kind: event.data?.reason?.kind === 'error' ? 'error' : 'report', at: now(), read: false,
        name: sources.get(key)?.name || '关联会话', attached: direct });
      if (notices.length > CONTEXT_LIMITS.notices) notices.shift();
    },
    capture(key) {
      requireKey(key);
      let remaining = CONTEXT_LIMITS.chars;
      const values = [...sources.values()].sort((a,b) => Number(b.sessionId===primarySessionId) - Number(a.sessionId===primarySessionId));
      const selected = [], omitted=[], historical=[];
      for (const source of values) {
        if (requiredCursor.has(source)) {omitted.push({name:source.name,reason:'update-pending'});continue;}
        if (!source.available || source.error) {omitted.push({name:source.name,reason:source.error?'read-failed':'unavailable'});continue;}
        const size = (source.goal?.length ?? 0) + (source.report?.length ?? 0);
        if (size > remaining) {omitted.push({name:source.name,reason:'budget'});continue;}
        remaining -= size;
        const entry = { sessionId: source.sessionId, name: source.name, cursor: source.cursor,
          turn: source.turn, turnStartSeq: source.turnStartSeq, turnStatus: source.turnStatus,
          goal: source.goal, goalSeq: source.goalSeq, goalHasAttachments: source.goalHasAttachments,
          report: source.report, reportSeq: source.reportSeq, reportStatus: source.reportStatus,
          goalOmitted:!!source.goalOmitted, reportOmitted:!!source.reportOmitted, previousReportOmitted:!!source.previousReportOmitted,
          running: source.running, readAt: source.checkedAt };
        selected.push(entry);
        if (source.previousReport) historical.push([entry, source.previousReport]);
      }
      // Historical reference must not crowd a current goal/report off the wire.
      for (const [entry, history] of historical) {
        if (history.text.length > remaining) entry.previousReportOmitted = true;
        else { entry.previousReport = { ...history }; remaining -= history.text.length; }
      }
      return { key, primarySessionId, sources: selected, omitted };
    },
    dispose() { disposed = true; cancelReads(); leases.clear(); closedViewers.clear(); sources.clear(); notices.length=0; },
  };
}
