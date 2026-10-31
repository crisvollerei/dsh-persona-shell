/** Volatile boundary observations only; no transcript, reader profile or background timer. */
export function createSessionPacing({ maxSessions = 64, now = Date.now, monotonic = () => performance.now() } = {}) {
  const sessions = new Map();
  return {
    clear(id) { if (id === undefined) sessions.clear(); else sessions.delete(id); },
    event(session, event) {
      if (typeof session?.id !== 'string' || !Number.isSafeInteger(event?.seq) || event.seq < 0) return;
      const old = sessions.get(session.id);
      if (old?.session === session && event.seq <= old.seq) return;
      const turn = event.data?.turn;
      if (event.type === 'turn/start') {
        if (!Number.isSafeInteger(turn) || turn < 1 || (old?.session === session && turn <= old.turn)) return;
        const clock = monotonic();
        const gap = old?.session === session && old.phase === 'ended' && turn === old.turn + 1
          ? clock - old.endedAt : NaN;
        const idle = Number.isFinite(gap) && gap >= 0 && gap <= 365 * 86400000 ? Math.floor(gap / 6000) / 10 : null;
        if (!sessions.has(session.id) && sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
        sessions.set(session.id, { session, seq: event.seq, turn, phase: 'active', idle, reports: 0 });
      } else if (old?.session === session && (turn === undefined || turn === old.turn)) {
        old.seq = event.seq;
        if (event.type === 'turn/end' && old.phase === 'active') {
          old.phase = 'ended';
          old.endedAt = monotonic();
        }
      }
    },
    /** Called once at an accepted source report boundary, never by a model query. */
    snapshot(session) {
      const state = sessions.get(session.id);
      const active = state?.session === session && state.phase === 'active';
      const hour = new Date(now()).getHours();
      return Object.freeze({
        session_turn_count: active ? state.turn : null,
        local_hour: Number.isInteger(hour) ? hour : null,
        idle_minutes: active ? state.idle : null,
        is_first_report: active ? state.reports++ === 0 : false,
      });
    },
  };
}

export function restoreSessionPacing(value) {
  const fields = ['session_turn_count', 'local_hour', 'idle_minutes', 'is_first_report'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || !(value.session_turn_count === null || (Number.isSafeInteger(value.session_turn_count) && value.session_turn_count > 0))
    || !(value.local_hour === null || (Number.isInteger(value.local_hour) && value.local_hour >= 0 && value.local_hour <= 23))
    || !(value.idle_minutes === null || (Number.isFinite(value.idle_minutes) && value.idle_minutes >= 0 && value.idle_minutes <= 525600))
    || typeof value.is_first_report !== 'boolean'
    || (value.session_turn_count === null && (value.idle_minutes !== null || value.is_first_report))) return;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}
