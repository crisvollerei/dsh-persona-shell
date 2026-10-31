import { createSessionPacing, restoreSessionPacing } from './session-pacing.js';
import { changedFileKey, workNature, restoreWorkNature } from './work-nature.js';

/** Read-only, per-report windows. Call ids stay local and are retained until turn end for deduplication. */
const CATEGORIES = ['search', 'read', 'edit', 'execute', 'other'];
const TOOLS = {
  search: ['grep', 'rg', 'glob', 'search', 'search_files', 'web_search', 'find_files'],
  read: ['read', 'read_file', 'read_files', 'read_image', 'list_files', 'list_directory', 'web_fetch', 'fetch'],
  edit: ['edit', 'edit_file', 'write', 'write_file', 'apply_patch', 'replace_in_file'],
  execute: ['bash', 'shell', 'exec', 'exec_command', 'run_command', 'run_code', 'terminal'],
};
const classify = (name) => Object.entries(TOOLS).find(([, names]) => names.includes(name))?.[0] ?? 'other';
const empty = () => Object.fromEntries(CATEGORIES.map((key) => [key, { calls: 0, returned: 0, errors: 0, earlier_returns: 0 }]));

export function createToolUsage({ maxSessions = 64, maxCalls = 4096, now, monotonic } = {}) {
  const sessions = new Map();
  const pacing = createSessionPacing({ maxSessions, now, monotonic });
  const budgets = new Map();
  const snapshots = new WeakMap();
  const claimed = new WeakSet();
  return {
    clear(id) { if (id === undefined) sessions.clear(); else sessions.delete(id); pacing.clear(id); },
    dispose() { sessions.clear(); budgets.clear(); pacing.clear(); },
    claimNote(snapshot) {
      const state = snapshots.get(snapshot);
      if (!state || claimed.has(snapshot) || sessions.get(state.session.id) !== state || state.budget.notes >= 3) return false;
      claimed.add(snapshot);
      state.budget.notes++;
      return true;
    },
    event(session, event) {
      if (typeof session?.id !== 'string' || !Number.isSafeInteger(event?.seq) || event.seq < 0) return;
      pacing.event(session, event);
      const id = session.id;
      let state = sessions.get(id);
      if (state?.session === session && event.seq <= state.seq) return;
      const turn = event.data?.turn;
      if (event.type === 'turn/start' && state?.session === session && turn <= state.turn) return;
      if (event.type === 'turn/start' || state?.session !== session) {
        if (!Number.isSafeInteger(turn) || turn < 1) return;
        if (!sessions.has(id) && sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
        // Clearing observation on a toggle must not renew the same turn's three-note allowance.
        let budget = budgets.get(id);
        if (budget?.turn !== turn) {
          if (!budgets.has(id) && budgets.size >= maxSessions) budgets.delete(budgets.keys().next().value);
          budget = { turn, notes: 0 };
          budgets.set(id, budget);
        }
        state = { session, turn, seq: -1, window: 0, calls: new Map(), reports: new Set(), counts: empty(), budget,
          files: new Set(), unknownFiles: false,
          complete: event.type === 'turn/start', exhausted: false };
        sessions.set(id, state);
      }
      if (!state || (turn !== undefined && turn !== state.turn)) return;
      state.seq = event.seq;
      if (event.type === 'turn/end') { sessions.delete(id); return; }
      const data = event.data;
      if (event.type === 'tool/call' && typeof data?.callId === 'string') {
        if (state.calls.has(data.callId)) return;
        if (state.calls.size >= maxCalls) { state.complete = false; state.exhausted = true; return; }
        const category = classify(data.name);
        state.calls.set(data.callId, { category, name: category === 'edit' ? data.name : undefined, window: state.window, returned: false });
        state.counts[category].calls++;
      } else if (event.type === 'tool/result') {
        const call = state.calls.get(data?.message?.toolCallId);
        if (!call) { state.complete = false; return; }
        if (call.returned) return;
        call.returned = true;
        const count = state.counts[call.category];
        count.returned++;
        if (data.message.isError === true) count.errors++;
        if (call.window < state.window) count.earlier_returns++;
        if (call.category === 'edit') {
          const key = changedFileKey(call.name, data);
          if (key === undefined || state.files.size >= maxCalls) state.unknownFiles = true;
          else if (key !== null) state.files.add(key);
        }
      } else if (event.type === 'assistant/message' && data?.interrupted !== true) {
        const content = data?.message?.content;
        if (!Array.isArray(content) || !content.some((block) => block?.type === 'tool-call')) return;
        const text = content.filter((block) => block?.type === 'text');
        if (text.length !== 1 || typeof text[0].text !== 'string' || !text[0].text.trim()) return;
        const reportId = data.message.id;
        if (typeof reportId === 'string') {
          if (state.reports.has(reportId)) return;
          if (state.reports.size >= maxCalls) { state.complete = false; state.exhausted = true; }
          else state.reports.add(reportId);
        }
        const categories = {};
        for (const category of CATEGORIES) {
          const count = state.counts[category];
          if (count.calls || count.returned) categories[category] = Object.freeze({ ...count });
        }
        const available = state.complete && !state.exhausted;
        const snapshot = Object.freeze({ available,
          scope: 'since_previous_process_report', categories: Object.freeze(available ? categories : {}),
          work_nature: workNature({ available, categories, calls: state.calls, files: state.files, unknownFiles: state.unknownFiles }),
          session_pacing: pacing.snapshot(session) });
        snapshots.set(snapshot, state);
        // The boundary advances on the source report, never on model queries, success or retries.
        state.window++;
        state.counts = empty();
        state.files = new Set();
        state.unknownFiles = false;
        state.complete = !state.exhausted;
        return snapshot;
      }
    },
  };
}

export const TOOL_USAGE_SCHEMA = Object.freeze({
  name: 'get_tool_usage',
  description: 'Read the frozen counts since the previous process report in this same turn. '
    + 'Also returns coarse work_nature and volatile session_pacing, never raw tool content. null means unknown. '
    + 'idle_minutes is the gap between the preceding turn end and this turn start, not work duration or user activity. '
    + 'local_hour is the host local clock; turn count is the runtime turn ordinal. '
    + 'earlier_returns counts results of calls '
    + 'started before this window; errors is a subset of returned. Returns do not prove task success. '
    + 'available=false means incomplete tool observation; independently known pacing remains usable. No arguments; read at most once.',
  parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
});

/** Strict restoration also keeps saved provider/model text out of the observation payload. */
export function restoreToolUsage(value) {
  if (value?.scope !== 'since_previous_process_report' || typeof value.available !== 'boolean'
    || !value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories)) return;
  const categories = {};
  for (const [key, count] of Object.entries(value.categories)) {
    if (!value.available) return;
    if (!CATEGORIES.includes(key) || !count || typeof count !== 'object') return;
    const fields = ['calls', 'returned', 'errors', 'earlier_returns'];
    if (Object.keys(count).length !== fields.length
      || fields.some((field) => !Number.isSafeInteger(count[field]) || count[field] < 0 || count[field] > 4096)
      || count.errors > count.returned || count.earlier_returns > count.returned
      || count.returned - count.earlier_returns > count.calls) return;
    categories[key] = Object.fromEntries(fields.map((field) => [field, count[field]]));
  }
  const result = { available: value.available, scope: value.scope, categories };
  if (value.work_nature !== undefined) {
    const nature = restoreWorkNature(value.work_nature);
    if (!nature || (!value.available && Object.values(nature).some((field) => field !== null))) return;
    const activity = (key) => (categories[key]?.calls ?? 0) + (categories[key]?.returned ?? 0) > 0;
    if (nature.is_read_only === true && (activity('edit') || activity('execute') || activity('other')
      || !(activity('read') || activity('search')))) return;
    if (nature.files_touched !== null && nature.files_touched > (categories.edit?.returned ?? 0)) return;
    result.work_nature = nature;
  }
  if (value.session_pacing !== undefined) {
    const pace = restoreSessionPacing(value.session_pacing);
    if (!pace) return;
    result.session_pacing = pace;
  }
  return result;
}
