// Counts only this plugin's model streams. Neither prompts nor conversation identifiers enter this ledger.
const PURPOSES = new Set(['rewrite', 'progress', 'report-visualization', 'chat', 'chat-context-selection', 'chat-participation', 'reply-suggestions', 'chat-draft', 'preset', 'memory']);
const RETENTION = 30;
const SERIES_PER_DAY = 32;
const OVERFLOW = '(other)';
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const FIELDS = ['calls', 'failedCalls', 'usageCalls', ...TOKEN_FIELDS];
const zero = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
const count = n => Number.isSafeInteger(n) && n >= 0;
const plus = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const cleanId = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\x00-\x1f\x7f]/u.test(value) ? value : '(unknown)';
const combine = (dest, src) => { for (const k of FIELDS) if (count(src[k])) dest[k] = plus(dest[k], src[k]); };
const key = (...parts) => JSON.stringify(parts);
const dayStamp = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
function daysEnding(date, length) {
  // Local calendar arithmetic also covers DST transitions (which needn't be 24h apart).
  return Array.from({ length }, (_, i) => dayStamp(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1 - length + i, 12)));
}

function reported(raw) {
  // DSH inputTokens is uncached input. Cache reads and writes are disjoint input;
  // reasoning is a detail of output, never an extra charge. Prefer the adapter's exact total.
  if (!count(raw?.inputTokens) || !count(raw.outputTokens)) return;
  const out = Object.fromEntries(TOKEN_FIELDS.map(k => [k, count(raw[k]) ? raw[k] : 0]));
  if (!count(raw.totalTokens)) out.totalTokens = [out.inputTokens, out.cacheReadTokens, out.cacheWriteTokens, out.outputTokens].reduce(plus, 0);
  return out;
}

export function createModelUsage({ now = () => new Date(), changed = () => {} } = {}) {
  const buckets = new Map();
  let restored = false, today, allowed;
  function prune() {
    const current = now(), day = dayStamp(current);
    if (today !== day) {
      today = day;
      allowed = new Set(daysEnding(current, RETENTION));
      let expired = false;
      for (const d of buckets.keys()) if (!allowed.has(d)) { buckets.delete(d); expired = true; }
      if (expired) changed();
    }
    return day;
  }
  function bucket(date, purpose, provider, model) {
    if (!allowed.has(date) || !PURPOSES.has(purpose)) return;
    let b = buckets.get(date);
    if (!b) buckets.set(date, b = { rows: new Map(), routes: new Set() });
    const route = key(purpose, provider, model);
    if (provider === OVERFLOW || (!b.routes.has(route) && b.routes.size >= SERIES_PER_DAY)) provider = model = OVERFLOW;
    if (provider !== OVERFLOW) b.routes.add(route);
    const id = key(purpose, provider, model);
    if (!b.rows.has(id)) b.rows.set(id, { date, purpose, provider, model, ...zero() });
    return b.rows.get(id);
  }
  const rows = () => Array.from(buckets.values()).flatMap(b => [...b.rows.values()]);
  return {
    begin({ purpose, provider, model }) {
      const date = prune();
      provider = cleanId(provider); model = cleanId(model);
      const start = bucket(date, purpose, provider, model);
      if (!start) return;
      start.calls = plus(start.calls, 1); changed();
      let done = false, tokens;
      return {
        usage(raw) {
          // Usage chunks are snapshots for this stream. Several snapshots are still just one receipt.
          if (!done) tokens = reported(raw) ?? tokens;
        },
        finish(ok) {
          if (done) return;
          done = true; prune();
          const row = bucket(date, purpose, provider, model);
          if (!row) return;
          combine(row, { failedCalls: ok ? 0 : 1, usageCalls: tokens ? 1 : 0, ...tokens });
          changed();
        },
      };
    },
    restore(saved) {
      // Calls started before storage opened already live in buckets. Add saved history once,
      // including if the host reinjects the storage service while this instance is still alive.
      prune();
      if (restored) return;
      restored = true;
      if (saved?.version !== 1 || !Array.isArray(saved.rows)) return;
      const maxRows = RETENTION * (SERIES_PER_DAY + PURPOSES.size);
      let expired = saved.rows.length > maxRows;
      for (const r of saved.rows.slice(0, maxRows)) {
        if (!r || !count(r.calls) || !r.calls) continue;
        if (!allowed.has(r.date)) { expired = true; continue; }
        const row = bucket(r.date, r.purpose, cleanId(r.provider), cleanId(r.model));
        if (!row) continue;
        combine(row, { ...r, usageCalls: count(r.usageCalls) ? Math.min(r.calls, r.usageCalls) : 0,
          failedCalls: count(r.failedCalls) ? Math.min(r.calls, r.failedCalls) : 0 });
      }
      if (expired) changed();
    },
    snapshot() { prune(); return { version: 1, rows: rows().map(r => ({ ...r })) }; },
    report(days = 7) {
      prune();
      const dates = daysEnding(now(), [1, 7, 30].includes(days) ? days : 7);
      const daily = new Map(dates.map(date => [date, { date, ...zero() }]));
      const totals = zero(), purposes = new Map(), models = new Map(), breakdown = new Map();
      const sum = (m, id, fields, r) => {
        if (!m.has(id)) m.set(id, { ...fields, ...zero() });
        combine(m.get(id), r);
      };
      for (const r of rows()) {
        if (!daily.has(r.date)) continue;
        const { purpose, provider, model } = r;
        combine(totals, r); combine(daily.get(r.date), r);
        sum(purposes, purpose, { purpose }, r);
        sum(models, key(provider, model), { provider, model }, r);
        sum(breakdown, key(purpose, provider, model), { purpose, provider, model }, r);
      }
      const ranked = m => [...m.values()].sort((a,b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
      return { days: dates.length, totals, daily: [...daily.values()], purposes: ranked(purposes), models: ranked(models), breakdown: ranked(breakdown) };
    },
  };
}
