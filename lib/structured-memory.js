import { randomUUID, createHash } from 'node:crypto';
import { emptyProfile, observeFeedback, stripTechnicalSpans } from './memory.js';

export const MEMORY_LIMITS = Object.freeze({ entries: 200, sources: 48, queue: 32, sessions: 500,
  handoffs: 50, content: 240, sourceText: 1000, selected: 5, promptChars: 600 });
const KINDS = ['preference', 'agreement', 'context', 'episode'];
const SCOPES = ['shared', 'persona', 'session'];
const STATUSES = ['active', 'candidate', 'superseded', 'rejected'];
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const plain = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const copy = (value) => structuredClone(value);
const fail = (message) => { throw new Error(message); };

export function emptyMemory() {
  return { version: 1, revision: 0, epoch: 0, entries: [], sources: [], queue: [], cursors: {},
    handoffs: [], migrated: false };
}

function scopeOf(input) {
  if (!SCOPES.includes(input.scope)) fail('invalid-memory-scope');
  const scope = { scope: input.scope, personaId: null, sessionId: null };
  if (input.scope === 'persona') {
    if (!plain(input.personaId, 160)) fail('persona-required');
    scope.personaId = input.personaId;
  }
  if (input.scope === 'session') {
    if (!plain(input.sessionId, 160)) fail('session-required');
    scope.sessionId = input.sessionId;
    if (input.personaId !== null && input.personaId !== undefined) {
      if (!plain(input.personaId, 160)) fail('invalid-persona');
      scope.personaId = input.personaId;
    }
  }
  return scope;
}

function sameScope(a, b) {
  return a.scope === b.scope && a.personaId === b.personaId && a.sessionId === b.sessionId;
}

export function preferenceKey(text) {
  if (/中文|英文|英语|汉语/.test(text)) return 'language';
  if (/称呼|叫我|别叫我/.test(text)) return 'address';
  if (/啰嗦|冗长|简短|简洁|精简|篇幅|详细|具体|展开|回答太长|回复太长|汇报太长/.test(text)) return 'verbosity';
  if (/催|休息|熬夜|提醒/.test(text)) return 'reminders';
  if (/语气|口吻|正式|随意|严肃|轻松|自然|克制/.test(text)) return 'tone';
  return 'custom:' + hash(text);
}

function explicitPreferences(text, personaId, sessionId) {
  const legacy = observeFeedback(emptyProfile(), text, personaId).stated[personaId] ?? [];
  const extra = text.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length <= 160 &&
    /(?:请|以后|始终|记住|默认|这次|本次|这轮|今天).*(?:用中文|用英文|用英语|叫我|称呼|别催|不要催|别.*提醒.*休息)/.test(s));
  return [...new Set([...legacy, ...extra])]
    .filter((content) => !/例如|比如|示例|引用|他说|她说|假如|如果|原文|人设/.test(content)).map((content) => {
    const temporary = /这次|本次|这轮|今天|暂时/.test(content) && !/以后|始终|长期/.test(content);
    const shared = /所有人格|所有角色|全局/.test(content);
    return { kind: 'preference', content, key: preferenceKey(content),
      scope: temporary ? 'session' : shared ? 'shared' : 'persona',
      personaId: temporary || !shared ? personaId : null, sessionId: temporary ? sessionId : null };
  });
}

/** One owner per plugin storage domain. Persona scope never grants another persona access. */
export function createStructuredMemory({ now = Date.now, changed = () => {} } = {}) {
  let state = emptyMemory();
  const bump = (invalidate = false) => {
    state.revision += 1;
    if (invalidate) state.epoch += 1;
    changed();
  };
  const live = (entry) => entry.status === 'active' && (entry.expiresAt === null || entry.expiresAt > now());
  const compact = () => {
    if (state.entries.length < MEMORY_LIMITS.entries) return;
    const index = state.entries.findIndex((e) => !live(e) && !e.pinned);
    if (index < 0) fail('memory-capacity');
    state.entries.splice(index, 1);
  };
  function put(input, { origin = 'manual', status = 'active', evidence = [] } = {}) {
    if (!KINDS.includes(input.kind) || !plain(input.content, MEMORY_LIMITS.content)) fail('invalid-memory-entry');
    const scope = scopeOf(input);
    if (['agreement', 'episode'].includes(input.kind) && scope.scope === 'shared') fail('private-memory-needs-scope');
    const content = input.content.trim();
    const key = plain(input.key, 100) ? input.key : input.kind === 'preference' ? preferenceKey(content) : 'custom:' + hash(content);
    const duplicate = state.entries.find((e) => sameScope(e, scope) && e.kind === input.kind && e.content === content
      && e.status === status);
    if (duplicate) {
      duplicate.evidence = [...duplicate.evidence, ...copy(evidence)]
        .filter((ref, index, all) => all.findIndex((e) => e.eventId === ref.eventId && e.quote === ref.quote) === index).slice(-4);
      return copy(duplicate);
    }
    const entry = { id: randomUUID(), ownerId: 'owner', ...scope, kind: input.kind, key, content,
      status, origin, evidence: copy(evidence).slice(0, 4), tags: Array.isArray(input.tags)
        ? input.tags.filter((t) => plain(t, 32)).slice(0, 6) : [],
      pinned: false, version: 1, createdAt: now(), updatedAt: now(),
      expiresAt: input.expiresAt === undefined ? (scope.scope === 'session' ? now() + 86400000 : null) : input.expiresAt };
    if (entry.expiresAt !== null && (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= now())) fail('invalid-memory-expiry');
    compact();
    if (status === 'active') supersede(entry);
    state.entries.push(entry);
    return copy(entry);
  }
  function supersede(entry) {
    for (const previous of state.entries) if (previous.id !== entry.id && live(previous)
      && previous.kind === entry.kind && previous.key === entry.key && sameScope(previous, entry)) {
      previous.status = 'superseded'; previous.updatedAt = now(); previous.version += 1;
      previous.supersededBy = entry.id;
    }
  }
  function restore(raw, { clear = false } = {}) {
    state = emptyMemory();
    if (raw?.version !== 1) return;
    state.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    state.epoch = Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0;
    for (const [id, seq] of Object.entries(raw.cursors ?? {}).slice(0, MEMORY_LIMITS.sessions)) {
      if (plain(id, 160) && Number.isSafeInteger(seq) && seq >= 0) {
        Object.defineProperty(state.cursors, id, { value: seq, enumerable: true, writable: true, configurable: true });
      }
    }
    if (clear) { state.migrated = true; bump(true); return; }
    state.migrated = raw.migrated === true;
    for (const rawEntry of (Array.isArray(raw.entries) ? raw.entries : []).slice(-MEMORY_LIMITS.entries)) {
      try {
        if (!plain(rawEntry.id, 160) || !STATUSES.includes(rawEntry.status) || !KINDS.includes(rawEntry.kind)
          || !plain(rawEntry.content, MEMORY_LIMITS.content) || !plain(rawEntry.key, 100)
          || !Number.isSafeInteger(rawEntry.version) || rawEntry.version < 1
          || (rawEntry.expiresAt !== null && !Number.isSafeInteger(rawEntry.expiresAt))) continue;
        const scope = scopeOf(rawEntry);
        if (['agreement', 'episode'].includes(rawEntry.kind) && scope.scope === 'shared') continue;
        if (state.entries.some((e) => e.id === rawEntry.id)) continue;
        state.entries.push({ ...copy(rawEntry), ...scope, ownerId: 'owner', pinned: rawEntry.pinned === true,
          tags: (Array.isArray(rawEntry.tags) ? rawEntry.tags : []).filter((t) => plain(t, 32)).slice(0, 6),
          createdAt: Number.isFinite(rawEntry.createdAt) ? rawEntry.createdAt : 0,
          updatedAt: Number.isFinite(rawEntry.updatedAt) ? rawEntry.updatedAt : 0,
          evidence: (Array.isArray(rawEntry.evidence) ? rawEntry.evidence : []).filter((e) =>
            plain(e.eventId, 330) && plain(e.quote, MEMORY_LIMITS.content)).slice(0, 4) });
      } catch { /* Ignore malformed optional memory without blocking reports. */ }
    }
    state.sources = (Array.isArray(raw.sources) ? raw.sources : []).filter((s) => s && plain(s.id, 330)
      && plain(s.text, MEMORY_LIMITS.sourceText) && plain(s.sessionId, 160) && plain(s.personaId, 160))
      .slice(-MEMORY_LIMITS.sources).map((s) => ({ id: s.id, sessionId: s.sessionId,
        personaId: s.personaId, text: s.text, at: Number.isFinite(s.at) ? s.at : 0 }));
    state.queue = (Array.isArray(raw.queue) ? raw.queue : []).filter((id) => state.sources.some((s) => s.id === id)).slice(-MEMORY_LIMITS.queue);
    state.handoffs = (Array.isArray(raw.handoffs) ? raw.handoffs : []).filter((h) => h && plain(h.id, 160)
      && plain(h.sessionId, 160) && plain(h.fromPersonaId, 160) && plain(h.toPersonaId, 160)
      && plain(h.summary, MEMORY_LIMITS.content) && ['pending', 'accepted', 'closed'].includes(h.status)
      && Number.isSafeInteger(h.version) && h.version >= 1 && Array.isArray(h.memoryIds)
      && h.memoryIds.length <= 10 && h.memoryIds.every((id) => plain(id, 160))).slice(-MEMORY_LIMITS.handoffs).map(copy);
  }
  function observe({ sessionId, personaId, seq, text, queue = true }) {
    if (!plain(sessionId, 160) || !plain(personaId, 160) || !Number.isSafeInteger(seq) || seq < 0
      || !plain(text, MEMORY_LIMITS.sourceText)) return false;
    const previous = Object.hasOwn(state.cursors, sessionId) ? state.cursors[sessionId] : -1;
    if (seq <= previous || (previous === -1 && Object.keys(state.cursors).length >= MEMORY_LIMITS.sessions)) return false;
    Object.defineProperty(state.cursors, sessionId, { value: seq, enumerable: true, writable: true, configurable: true });
    const clean = stripTechnicalSpans(text).split('\n').filter((line) => !/^\s*>/.test(line)).join('\n').trim();
    if (!clean) { bump(); return true; }
    const preferences = explicitPreferences(clean, personaId, sessionId);
    if (!queue && !preferences.length) { bump(); return true; }
    const source = { id: sessionId + ':' + seq, sessionId, personaId, text: clean, at: now() };
    state.sources.push(source);
    state.sources = state.sources.slice(-MEMORY_LIMITS.sources);
    state.queue = state.queue.filter((id) => state.sources.some((s) => s.id === id));
    if (queue) state.queue.push(source.id);
    state.queue = state.queue.slice(-MEMORY_LIMITS.queue);
    for (const item of preferences) {
      try { put(item, { origin: 'explicit', evidence: [{ eventId: source.id, quote: item.content }] }); }
      catch (error) { if (error.message !== 'memory-capacity') throw error; }
    }
    bump(); return true;
  }
  function mutate(action) {
    if (!action || typeof action !== 'object') fail('invalid-memory-action');
    if (action.action === 'add') {
      const entry = put(action.entry);
      bump(true); return entry;
    }
    const entry = state.entries.find((e) => e.id === action.id);
    if (!entry) fail('memory-not-found');
    if (action.version !== entry.version) fail('memory-conflict');
    if (action.action === 'delete') {
      const sourceIds = new Set(entry.evidence.map((e) => e.eventId));
      const quotes = [...entry.evidence.map((e) => e.quote), entry.content];
      for (const source of state.sources) if (quotes.some((quote) => source.text.includes(quote))) sourceIds.add(source.id);
      state.sources = state.sources.filter((s) => !sourceIds.has(s.id));
      state.queue = state.queue.filter((id) => !sourceIds.has(id));
      state.entries = state.entries.filter((e) => e.id !== entry.id);
      for (const handoff of state.handoffs) handoff.memoryIds = handoff.memoryIds.filter((id) => id !== entry.id);
    } else if (action.action === 'accept' || action.action === 'reject') {
      if (entry.status !== 'candidate') fail('memory-not-candidate');
      entry.status = action.action === 'accept' ? 'active' : 'rejected';
      if (entry.status === 'active') supersede(entry);
      entry.version += 1; entry.updatedAt = now();
    } else if (action.action === 'update') {
      if (!plain(action.content, MEMORY_LIMITS.content) || typeof action.pinned !== 'boolean') fail('invalid-memory-entry');
      const scope = scopeOf({ ...entry, ...action });
      if (['agreement', 'episode'].includes(entry.kind) && scope.scope === 'shared') fail('private-memory-needs-scope');
      const expiresAt = scope.scope === 'session'
        ? (entry.scope === 'session' ? entry.expiresAt : now() + 86400000) : null;
      Object.assign(entry, scope, { content: action.content.trim(), pinned: action.pinned, origin: 'manual',
        status: 'active', expiresAt, version: entry.version + 1, updatedAt: now() });
      entry.key = entry.kind === 'preference' ? preferenceKey(entry.content) : entry.key;
      supersede(entry);
    } else fail('invalid-memory-action');
    bump(true); return copy(entry);
  }
  function batch() {
    const sources = state.queue.map((id) => state.sources.find((s) => s.id === id)).filter(Boolean);
    // Each extraction is scoped to a single persona/session, even when several are active.
    const first = sources[0];
    return { epoch: state.epoch, sources: first ? sources.filter((s) =>
      s.personaId === first.personaId && s.sessionId === first.sessionId).slice(0, 12) : [] };
  }
  function commit(batchValue, proposals) {
    if (batchValue.epoch !== state.epoch || !Array.isArray(proposals) || proposals.length > 5) return false;
    const sources = batchValue.sources;
    if (!sources.length || sources.some((s) => !state.queue.includes(s.id))) return false;
    const validated = proposals.map((item) => {
      if (!item || !KINDS.includes(item.kind) || !plain(item.content, MEMORY_LIMITS.content)
        || !Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 4) fail('invalid-memory-proposal');
      const evidence = item.evidence.map((ref) => {
        const source = sources.find((s) => s.id === ref.eventId);
        if (!source || !plain(ref.quote, MEMORY_LIMITS.content) || !source.text.includes(ref.quote)) fail('invalid-memory-evidence');
        return { eventId: source.id, quote: ref.quote };
      });
      if (!SCOPES.includes(item.scope)) fail('invalid-memory-scope');
      if (item.scope === 'shared' && (item.kind !== 'preference'
        || evidence.some((e) => !/所有人格|所有角色|全局/.test(e.quote)))) fail('unproven-shared-memory');
      return { kind: item.kind, scope: item.scope, content: item.content, tags: item.tags,
        personaId: item.scope === 'shared' ? null : sources[0].personaId,
        sessionId: item.scope === 'session' ? sources[0].sessionId : null, evidence };
    });
    const before = copy(state);
    try {
      for (const item of validated) put(item, { origin: 'model', status: 'candidate', evidence: item.evidence });
    } catch (error) { state = before; throw error; }
    state.queue = state.queue.filter((id) => !sources.some((s) => s.id === id));
    bump(); return true;
  }
  function select({ personaId, sessionId, text = '', purpose = 'rewrite' } = {}) {
    const eligible = state.entries.filter((e) => live(e) && (e.scope === 'shared'
      || (e.scope === 'persona' && e.personaId === personaId)
      || (e.scope === 'session' && e.sessionId === sessionId && (!e.personaId || e.personaId === personaId)))
      && (purpose !== 'rewrite' || ['preference', 'agreement'].includes(e.kind)));
    const score = (e) => (e.scope === 'session' ? 100 : e.scope === 'persona' ? 60 : 30)
      + (e.pinned ? 20 : 0) + e.tags.filter((tag) => text.includes(tag)).length * 5;
    eligible.sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt);
    const chosen = []; const keys = new Set(); let chars = 0;
    for (const entry of eligible) {
      const key = entry.kind + ':' + entry.key;
      if (keys.has(key) || chars + entry.content.length > MEMORY_LIMITS.promptChars) continue;
      chosen.push(copy(entry)); keys.add(key); chars += entry.content.length;
      if (chosen.length >= MEMORY_LIMITS.selected) break;
    }
    return chosen;
  }
  function handoff(action) {
    if (action.action === 'create') {
      if (!plain(action.summary, MEMORY_LIMITS.content) || !plain(action.sessionId, 160)
        || !plain(action.fromPersonaId, 160) || !plain(action.toPersonaId, 160)
        || action.fromPersonaId === action.toPersonaId || !Array.isArray(action.memoryIds)
        || action.memoryIds.length > 10) fail('invalid-handoff');
      const ids = [...new Set(action.memoryIds)];
      for (const id of ids) {
        const entry = state.entries.find((e) => e.id === id);
        if (!entry || !live(entry) || entry.scope === 'persona'
          || (entry.scope === 'session' && (entry.sessionId !== action.sessionId || entry.personaId))) fail('private-handoff-memory');
      }
      if (state.handoffs.length >= MEMORY_LIMITS.handoffs) {
        const index = state.handoffs.findIndex((h) => h.status === 'closed');
        if (index < 0) fail('handoff-capacity');
        state.handoffs.splice(index, 1);
      }
      const record = { id: randomUUID(), ownerId: 'owner', sessionId: action.sessionId,
        fromPersonaId: action.fromPersonaId, toPersonaId: action.toPersonaId,
        summary: action.summary.trim(), memoryIds: ids, source: 'owner-authored',
        status: 'pending', version: 1, createdAt: now(), updatedAt: now() };
      state.handoffs.push(record); bump(true); return copy(record);
    }
    const record = state.handoffs.find((h) => h.id === action.id);
    if (!record || record.sessionId !== action.sessionId || record.toPersonaId !== action.personaId) fail('handoff-not-found');
    if (action.action === 'accept' && record.status === 'accepted') return copy(record);
    if (action.version !== record.version) fail('handoff-conflict');
    if (action.action === 'accept' && record.status === 'pending') record.status = 'accepted';
    else if (action.action === 'close' && record.status === 'accepted') record.status = 'closed';
    else fail('invalid-handoff-transition');
    record.version += 1; record.updatedAt = now(); bump(true); return copy(record);
  }
  function handoffContext(id, { personaId, sessionId }) {
    const record = state.handoffs.find((h) => h.id === id && h.toPersonaId === personaId
      && h.sessionId === sessionId);
    if (!record) fail('handoff-not-found');
    return { summary: record.summary, source: record.source, status: record.status,
      memories: record.memoryIds.map((key) => state.entries.find((e) => e.id === key)).filter((e) =>
        e && live(e) && (e.scope === 'shared' || (e.scope === 'session' && e.sessionId === sessionId && !e.personaId)))
        .map(copy) };
  }
  return {
    restore, observe, mutate, batch, commit, select, handoff, handoffContext,
    snapshot: () => copy(state),
    clear() {
      const cursors = copy(state.cursors); const revision = state.revision; const epoch = state.epoch;
      state = { ...emptyMemory(), cursors, revision, epoch, migrated: true }; bump(true);
    },
    discardQueue() { state.queue = []; state.sources = []; bump(true); },
    discardSession(sessionId) {
      state.queue = state.queue.filter((id) => !state.sources.some((s) => s.id === id && s.sessionId === sessionId));
      state.sources = state.sources.filter((s) => s.sessionId !== sessionId);
      bump(true);
    },
    migrate(profile) {
      if (state.migrated) return;
      for (const [personaId, lines] of Object.entries(profile?.stated ?? {})) {
        if (!Array.isArray(lines)) continue;
        for (const content of lines.slice(-6)) {
          try { put({ kind: 'preference', scope: 'persona', personaId, content },
            { origin: 'legacy', status: 'candidate' }); } catch { /* Keep valid legacy items only. */ }
        }
      }
      state.migrated = true; bump();
    },
  };
}
