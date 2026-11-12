import { makeReportSource, validateReportVisualization, REPORT_VISUAL_ISSUE_CODES, REPORT_VISUAL_WARNING_CODES } from './report-visualization.js';
import { sourceOutputUsable } from './source-report.js';
import { userInput } from './user-text.js';
import { validateReportEmphasis } from './report-emphasis.js';
import { validateReportReadable } from './report-readable.js';

const validateView = (value, source) => value?.schemaVersion === 3 ? validateReportReadable(value, source)
  : value?.schemaVersion === 2 ? validateReportEmphasis(value, source) : validateReportVisualization(value, source);

const validId = value => typeof value === 'string' && value.trim() && value.length <= 200;
const seqOf = value => Number.isSafeInteger(value) && value >= 0;
const routeOf = value => validId(value?.provider) && validId(value?.model)
  ? { provider: value.provider, model: value.model } : undefined;
const issueCodes = new Set(REPORT_VISUAL_ISSUE_CODES), warningCodes = new Set([...REPORT_VISUAL_WARNING_CODES,
  'readable-block-original', 'readable-wording-review', 'readable-format-normalized']);
const issuePath = value => typeof value === 'string' && value.length <= 180
  && /^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\])*$/u.test(value) ? value : '$';
/** Only enum metadata leaves validation; rejected model text never enters errors or stored notes. */
export function reportViewIssue(value) {
  return value && issueCodes.has(value.code) ? { code: value.code, path: issuePath(value.path) } : undefined;
}
function reportWarnings(...groups) {
  const unique = new Map();
  for (const group of groups) for (const value of Array.isArray(group) ? group.slice(0, 128) : []) {
    if (!warningCodes.has(value?.code)) continue;
    const note = { code: value.code, path: issuePath(value.path) };
    unique.set(JSON.stringify(note), note);
    if (unique.size >= 128) return [...unique.values()];
  }
  return [...unique.values()];
}
function uncoveredSource(source, ...groups) {
  const ids = new Set(groups.flatMap(group => Array.isArray(group) ? group : []));
  return source.blocks.filter(block => ids.has(block.id)).map(block => block.id);
}
const keep = reports => {
  let chars = 0;
  return [...reports].sort((a, b) => b.seq - a.seq).filter(record => {
    chars += (record.text?.length ?? 0) + JSON.stringify(record.result ?? '').length + JSON.stringify(record.warnings ?? []).length
      + JSON.stringify(record.readable ?? '').length;
    return chars <= 192000;
  }).slice(0, 16).reverse();
};

/** Own report snapshots. Capturing committed text never dispatches a model or writes the work log. */
export function createReportViews({ store: getStore, changed = () => {}, warn = () => {}, now = Date.now }) {
  const sessions = new Map(), loaded = new Set(), cursors = new Map(), timers = new Map(), dirty = new Set();
  let writes = Promise.resolve(), closed = false;
  const sourceOf = (id, record) => makeReportSource({ sessionId: id, seq: record.seq, text: record.text });
  const decode = (id, record) => {
    if (!seqOf(record?.seq)) return null;
    const entry = { seq: record.seq, at: Number.isFinite(record.at) ? record.at : 0, route: routeOf(record.route) };
    try {
      const source = sourceOf(id, record); entry.text = source.text;
      const parsed = validateView(record.result, source);
      if (parsed.ok) Object.assign(entry, { result: parsed.value, unreferenced: uncoveredSource(source, parsed.unreferenced, record.unreferenced),
        warnings: reportWarnings(parsed.warnings, record.warnings),
        model: routeOf(record.model), generatedAt: Number.isFinite(record.generatedAt) ? record.generatedAt : 0 });
      const readable = validateReportReadable(record.readable?.result, source);
      if (readable.ok) entry.readable = { result: readable.value, warnings: reportWarnings(readable.warnings, record.readable.warnings),
        model: routeOf(record.readable.model), generatedAt: Number.isFinite(record.readable.generatedAt) ? record.readable.generatedAt : 0 };
    } catch {
      if (record.reason !== 'report-too-long') return null;
      entry.reason = 'report-too-long';
    }
    return entry;
  };
  function ensure(id, opened = getStore()) {
    if (!validId(id)) return [];
    if (!sessions.has(id)) sessions.set(id, []);
    if (!loaded.has(id) && opened) {
      const saved = opened.getReportViews(id);
      const old = saved?.version === 1 && Array.isArray(saved.reports) ? saved.reports : [];
      const current = sessions.get(id), existing = new Set(current.map(r => r.seq));
      const restored = old.slice(-16).map(record => decode(id, record)).filter(Boolean);
      // Older plugin rows are usable only when their persisted final flag was explicit.
      // Do not infer a final report from the newest surviving rewrite row.
      const legacy = opened.get(id).filter(row => row?.final === true && typeof row.original === 'string'
        && !['source-max-tokens', 'source-incomplete'].includes(row.reason))
        .map(row => decode(id, { seq: row.seq, text: row.original, at: row.time } )).filter(Boolean);
      for (const entry of [...restored, ...legacy]) if (!existing.has(entry.seq)) { existing.add(entry.seq); current.push(entry); }
      sessions.set(id, keep(current)); loaded.add(id);
    }
    return sessions.get(id);
  }
  function schedule(id) {
    dirty.add(id);
    if (closed || !getStore() || timers.has(id)) return;
    const timer = setTimeout(() => { timers.delete(id); void flush(id).catch(error => warn(error)); }, 400);
    timer.unref?.(); timers.set(id, timer);
  }
  function flush(id, opened = getStore()) {
    if (!opened || !dirty.has(id)) return writes;
    const task = writes.catch(() => {}).then(async () => {
      // A transient read error must never turn a new in-memory report into a
      // replacement for an unread persisted history. Merge before every first write.
      ensure(id, opened);
      const snapshot = sessions.get(id);
      if (!snapshot) return;
      await opened.putReportViews(id, { version: 1, reports: structuredClone(snapshot) });
      if (sessions.get(id) === snapshot) dirty.delete(id);
    });
    writes = task; return task;
  }
  function publish(id, candidate) {
    let current;
    try { current = ensure(id); } catch { current = sessions.get(id) ?? []; }
    const entry = { seq: candidate.seq, at: now(), route: candidate.route };
    try { entry.text = makeReportSource({ sessionId: id, seq: candidate.seq, text: candidate.text }).text; }
    catch (error) { if (error.message !== 'report-too-long') return; entry.reason = 'report-too-long'; }
    const previous = current.find(r => r.seq === entry.seq);
    if (previous?.text === entry.text && previous?.reason === entry.reason) return;
    sessions.set(id, keep([...current.filter(r => r.seq !== entry.seq), entry])); schedule(id); changed(id);
  }
  return {
    event(session, event) {
      const id = session?.id;
      if (closed || !validId(id) || !seqOf(event?.seq)) return;
      let state = cursors.get(id);
      if (!state) { state = { cursor: -1, turn: null, ended: false }; cursors.set(id, state); }
      if (event.seq <= state.cursor) return;
      const type = event.type, turn = event.data?.turn ?? event.data?.message?.turn;
      if (!['request/header', 'user/message', 'user-message', 'turn/start', 'assistant/message', 'turn/end'].includes(type)) return;
      if (Number.isSafeInteger(turn) && Number.isSafeInteger(state.turn) && turn < state.turn) return;
      state.cursor = event.seq;
      if (type === 'request/header') { state.route = routeOf(event.data?.header?.config); return; }
      if (type === 'user/message' || type === 'user-message') {
        if (userInput(event.data) === null) return;
        state.candidate = undefined;
        if (state.ended) { state.turn = Number.isSafeInteger(turn) ? turn : null; state.ended = false; }
        return;
      }
      if (type === 'turn/start') { state.turn = Number.isSafeInteger(turn) ? turn : null; state.candidate = undefined; state.ended = false; return; }
      if (state.ended) return;
      if (type === 'assistant/message') {
        state.candidate = undefined;
        if (Number.isSafeInteger(turn)) state.turn = turn;
        state.route = routeOf(event.data?.message?.source) ?? state.route;
        const content = event.data?.message?.content;
        if (!sourceOutputUsable(event.data) || !Array.isArray(content) || content.some(b => b?.type === 'tool-call')) return;
        const text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n');
        if (text.trim()) state.candidate = { seq: event.seq, text, route: state.route };
        return;
      }
      if (type === 'turn/end') {
        const sameTurn = !Number.isSafeInteger(turn) || !Number.isSafeInteger(state.turn) || turn === state.turn;
        if (sameTurn && event.data?.reason?.kind === 'completed' && state.candidate) publish(id, state.candidate);
        state.candidate = undefined; state.ended = true;
      }
    },
    list(id) {
      let records; try { records = ensure(id); } catch { records = sessions.get(id) ?? []; }
      return records.map(record => ({ seq: record.seq, final: true, available: !!record.text, reason: record.reason,
        ...(record.text ? { hash: sourceOf(id, record).hash } : {}) }));
    },
    read(id, seq, presentation) {
      const record = ensure(id).find(r => r.seq === seq);
      if (!record) return { available: false, reason: 'report-unavailable', cached: false };
      if (!record.text) return { available: false, reason: record.reason ?? 'report-unavailable', cached: false };
      const selected = presentation === 'readable' ? record.readable : record;
      return { available: true, source: sourceOf(id, record), result: selected?.result, unreferenced: selected?.unreferenced,
        warnings: selected?.warnings,
        model: selected?.model, generatedAt: selected?.generatedAt, cached: !!selected?.result, persistence: getStore() ? 'local' : 'memory-only' };
    },
    route(id, seq) { return ensure(id).find(r => r.seq === seq)?.route; },
    async cache(id, seq, hash, result, model, notes = {}, beginCommit) {
      const task = writes.catch(() => {}).then(async () => {
        const old = ensure(id), record = old.find(r => r.seq === seq);
        if (closed || !record?.text || sourceOf(id, record).hash !== hash) throw Error('report-source-changed');
        const parsed = validateView(result, sourceOf(id, record));
        if (!parsed.ok) throw Error('report-invalid-output');
        const cached = { result: parsed.value,
          unreferenced: uncoveredSource(sourceOf(id, record), parsed.unreferenced, notes.unreferenced),
          warnings: reportWarnings(parsed.warnings, notes.warnings), model, generatedAt: now() };
        const nextRecord = result.schemaVersion === 3 ? { ...record, readable: cached } : { ...record, ...cached };
        const next = keep(old.map(r => r === record ? nextRecord : r)), opened = getStore();
        if (!next.some(r => r.seq === seq)) throw Error('report-cache-capacity');
        // A queued write can still be stopped. Once handed to the store, only its result is authoritative.
        beginCommit?.();
        if (opened) await opened.putReportViews(id, { version: 1, reports: structuredClone(next) });
        if (sessions.get(id) !== old) throw Error('report-source-changed');
        sessions.set(id, next); dirty.delete(id); changed(id);
      });
      writes = task; await task;
    },
    async drain(opened = getStore()) {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer); timers.clear();
      for (const id of dirty) void flush(id, opened).catch(error => warn(error));
      await writes.catch(() => {});
    },
  };
}
