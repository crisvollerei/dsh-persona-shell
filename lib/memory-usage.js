import { randomUUID } from 'node:crypto';

export const MEMORY_USAGE_LIMIT = 24;
const CHANNELS = ['report', 'process', 'retry', 'progress', 'chat'];
const OUTCOMES = ['pending', 'generated', 'rejected', 'failed', 'cancelled', 'interrupted'];
const REASONS = ['candidate', 'superseded', 'rejected', 'retracted', 'expired', 'not-expression', 'overridden', 'budget', 'limit'];
const idValid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const refValid = (ref) => idValid(ref?.id) && Number.isSafeInteger(ref.version) && ref.version > 0;
const refsOnly = (refs) => (refs ?? []).map(({ id, version }) => ({ id, version }));

/** A bounded request ledger: references and delivery state only, never text, prompts or model output. */
export function createMemoryUsage({ now = Date.now, changed = () => {} } = {}) {
  let records = [];
  const update = (id, apply) => {
    const record = records.find((item) => item.id === id);
    if (!record) return;
    if (apply(record)) changed();
  };
  return {
    begin({ personaId, sessionId, channel, selection }) {
      if (!idValid(personaId) || !idValid(sessionId) || !CHANNELS.includes(channel)
        || !Array.isArray(selection?.entries) || selection.entries.length > 5 || !selection.entries.every(refValid)
        || !Array.isArray(selection.omitted) || selection.omitted.length > 200
        || !selection.omitted.every((r) => refValid(r) && REASONS.includes(r.reason))) return;
      const record = { id: randomUUID(), personaId, sessionId, channel, at: now(), sentAt: null,
        endedAt: null, outcome: 'pending', selected: refsOnly(selection.entries),
        omitted: selection.omitted.map(({ id, version, reason }) => ({ id, version, reason })) };
      records.push(record); records = records.slice(-MEMORY_USAGE_LIMIT); changed();
      return {
        sent() { update(record.id, (item) => {
          if (item.sentAt !== null || item.outcome !== 'pending') return false;
          item.sentAt = Math.max(item.at, now()); return true;
        }); },
        finish(outcome) { update(record.id, (item) => {
          if (item.outcome !== 'pending' || !OUTCOMES.includes(outcome) || outcome === 'pending') return false;
          item.outcome = outcome; item.endedAt = Math.max(item.sentAt ?? item.at, now()); return true;
        }); },
      };
    },
    snapshot: () => ({ version: 1, records: structuredClone(records) }),
    restore(raw, { clear = false } = {}) {
      records = [];
      if (clear || raw?.version !== 1 || !Array.isArray(raw.records)) return;
      for (const value of raw.records.slice(-MEMORY_USAGE_LIMIT)) {
        if (!idValid(value?.id) || records.some((r) => r.id === value.id) || !idValid(value.personaId)
          || !idValid(value.sessionId) || !CHANNELS.includes(value.channel) || !OUTCOMES.includes(value.outcome)
          || !Number.isSafeInteger(value.at) || value.at < 0
          || !(value.sentAt === null || (Number.isSafeInteger(value.sentAt) && value.sentAt >= value.at))
          || !(value.endedAt === null || (Number.isSafeInteger(value.endedAt) && value.endedAt >= (value.sentAt ?? value.at)))
          || (value.outcome === 'generated' && value.sentAt === null)
          || (value.outcome === 'pending' && value.endedAt !== null)
          || (!['pending', 'interrupted'].includes(value.outcome) && value.endedAt === null)
          || !Array.isArray(value.selected) || value.selected.length > 5 || !value.selected.every(refValid)
          || !Array.isArray(value.omitted) || value.omitted.length > 200
          || !value.omitted.every((r) => refValid(r) && REASONS.includes(r.reason))
          || new Set([...value.selected, ...value.omitted].map((r) => r.id)).size !== value.selected.length + value.omitted.length) continue;
        records.push({ id: value.id, personaId: value.personaId, sessionId: value.sessionId,
          channel: value.channel, at: value.at, sentAt: value.sentAt,
          endedAt: value.endedAt, outcome: value.outcome === 'pending' ? 'interrupted' : value.outcome,
          selected: refsOnly(value.selected), omitted: value.omitted.map(({ id, version, reason }) => ({ id, version, reason })) });
      }
    },
    clear() { records = []; changed(); },
  };
}
