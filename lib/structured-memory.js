import { randomUUID, createHash } from 'node:crypto';
import { emptyProfile, observeFeedback, stripTechnicalSpans } from './memory.js';

export const MEMORY_LIMITS = Object.freeze({ entries: 200, sources: 48, queue: 32, sessions: 500,
  handoffs: 50, operations: 80, content: 240, sourceText: 1000, selected: 5, promptChars: 600 });
const KINDS = ['preference', 'agreement', 'context', 'episode'];
const SCOPES = ['shared', 'persona', 'session'];
const STATUSES = ['active', 'candidate', 'superseded', 'rejected', 'retracted'];
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const plain = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const copy = (value) => structuredClone(value);
const fail = (message) => { throw new Error(message); };

export function emptyMemory() {
  return { version: 1, revision: 0, epoch: 0, entries: [], sources: [], queue: [], cursors: {},
    handoffs: [], operations: [], migrated: false };
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

// Scope expands access. Recognize a complete affirmative instruction, never
// infer permission from the word "全局" somewhere in a quote or another clause.
const audience = '(?:所有|全部|每个|每位)(?:的)?(?:人格|角色)';
const manner = '(?:先说结论|简洁一点|简短一点|详细一点|语气(?:要)?(?:轻松|正式|自然)|(?:用|使用)(?:中文|英文|英语)(?:回复|回答)?|(?:叫我|称呼我(?:为)?)[\\p{Script=Han}A-Za-z0-9·_-]{1,16})';
const preamble = '(?:(?:以后|今后|默认|始终|我希望|希望|请|让)\\s*)*';
const directGrant = new RegExp('^' + preamble + audience + '(?:以后|今后|都|统一|默认|可以)*' + manner + '$', 'u');
const sharedSuffix = new RegExp('^' + preamble + manner + '[，,；;。]\\s*(?:请)?(?:设为全局(?:偏好)?|(?:把)?(?:这个称呼|这条偏好|此偏好)?(?:设为|用于)全局|(?:把)?(?:这个称呼|这条偏好|此偏好)?共享给' + audience + '|对' + audience + '生效)$', 'u');
function authorizesSharing(quote) {
  const sentence = quote.trim().replace(/[。！!]$/, '');
  if (/只限|仅限|只有|仅你|只准|不要|不许|不能|别让|才怪|保密|私下|除外|[吗么呢]$/.test(sentence)) return false;
  return directGrant.test(sentence) || sharedSuffix.test(sentence);
}

function explicitPreferences(text, personaId, sessionId, shared) {
  // Splitting lines would detach an example from the heading that identifies
  // its speaker. Questions and quoted instructions can go through review.
  if (/[?？][”」』"]?$/.test(text) || /(?:^|\n)\s*(?:剧本台词|示例|例如|比如|引用|原文)\s*[:：]/u.test(text)) return [];
  const legacy = observeFeedback(emptyProfile(), text, personaId).stated[personaId] ?? [];
  const extra = text.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length <= 160 &&
    /(?:请|以后|始终|记住|默认|这次|本次|这轮|今天).*(?:用中文|用英文|用英语|叫我|称呼|别催|不要催|别.*提醒.*休息)/.test(s));
  // A direct shared instruction such as “所有人格都用中文” needs no “请/以后”.
  return [...new Set(shared ? [text.replace(/[。！!]$/, '')] : [...legacy, ...extra])]
    .filter((content) => !/例如|比如|示例|引用|他说|她说|假如|如果|原文|人设/.test(content)).map((content) => {
    const temporary = /这次|本次|这轮|今天|暂时/.test(content) && !/以后|始终|长期/.test(content);
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
    const narrowed = new Set();
    const oldOperations = (Array.isArray(raw.operations) ? raw.operations : []).slice(-MEMORY_LIMITS.operations);
    for (const rawEntry of (Array.isArray(raw.entries) ? raw.entries : []).slice(-MEMORY_LIMITS.entries)) {
      try {
        if (!plain(rawEntry.id, 160) || !STATUSES.includes(rawEntry.status) || !KINDS.includes(rawEntry.kind)
          || !plain(rawEntry.content, MEMORY_LIMITS.content) || !plain(rawEntry.key, 100)
          || !Number.isSafeInteger(rawEntry.version) || rawEntry.version < 1
          || (rawEntry.expiresAt !== null && !Number.isSafeInteger(rawEntry.expiresAt))) continue;
        const scope = scopeOf(rawEntry);
        if (['agreement', 'episode'].includes(rawEntry.kind) && scope.scope === 'shared') continue;
        if (state.entries.some((e) => e.id === rawEntry.id)) continue;
        const entry = { ...copy(rawEntry), ...scope, ownerId: 'owner', pinned: rawEntry.pinned === true,
          tags: (Array.isArray(rawEntry.tags) ? rawEntry.tags : []).filter((t) => plain(t, 32)).slice(0, 6),
          createdAt: Number.isFinite(rawEntry.createdAt) ? rawEntry.createdAt : 0,
          updatedAt: Number.isFinite(rawEntry.updatedAt) ? rawEntry.updatedAt : 0,
          evidence: validEvidence(rawEntry.evidence) };
        // Older automatic entries used a substring as authorization. Keep the
        // words for owner review, but stop using that grant even on first load.
        // Owner-set entries and model candidates already confirmed in settings
        // retain the scope the owner chose.
        if (entry.scope === 'shared' && (entry.origin === 'explicit' || entry.origin === 'model')
          && ['active', 'candidate'].includes(entry.status)
          && !(entry.status === 'active' && (entry.sharingConfirmed === true || entry.origin === 'model'))) {
          // Builds before sharingConfirmed recorded the owner's explicit
          // acceptance in the operation ledger. Match the actual record and
          // its scope; another entry's review cannot grant access to this one.
          const approved = entry.status === 'active' && plain(entry.operationId, 160) && oldOperations.some(o =>
            o?.id === entry.operationId && o.kind === 'accept' && o.status === 'applied' && o.version >= 2
            && o.targetId === entry.id && Number.isSafeInteger(o.targetVersion) && o.targetVersion > 0
            && o.targetVersion < entry.version && o.target?.scope === 'shared'
            && o.target.kind === entry.kind && o.target.content === entry.content);
          const authorized = entry.evidence.length && entry.evidence.every(e => e.source === 'message' && e.complete && authorizesSharing(e.quote));
          if (approved) entry.sharingConfirmed = true;
          else if (!authorized) {
            const owners = new Set(entry.evidence.map(e => e.personaId));
            if (owners.size === 1 && entry.evidence[0].personaId) {
              entry.scope = 'persona'; entry.personaId = entry.evidence[0].personaId; entry.status = 'candidate';
            } else entry.status = 'rejected';
          } else if (entry.status === 'active') entry.status = 'candidate';
          if (entry.status !== rawEntry.status || entry.scope !== rawEntry.scope) {
            entry.version++; narrowed.add(entry.id);
          }
        }
        state.entries.push(entry);
      } catch { /* Ignore malformed optional memory without blocking reports. */ }
    }
    state.sources = (Array.isArray(raw.sources) ? raw.sources : []).filter((s) => s && plain(s.id, 330)
      && plain(s.text, MEMORY_LIMITS.sourceText) && plain(s.sessionId, 160) && plain(s.personaId, 160))
      .slice(-MEMORY_LIMITS.sources).map((s) => ({ id: s.id, sessionId: s.sessionId,
        personaId: s.personaId, text: s.text, complete: s.complete === true,
        at: Number.isFinite(s.at) ? s.at : 0 }));
    state.queue = (Array.isArray(raw.queue) ? raw.queue : []).filter((id) => state.sources.some((s) => s.id === id)).slice(-MEMORY_LIMITS.queue);
    state.handoffs = (Array.isArray(raw.handoffs) ? raw.handoffs : []).filter((h) => h && plain(h.id, 160)
      && plain(h.sessionId, 160) && plain(h.fromPersonaId, 160) && plain(h.toPersonaId, 160)
      && plain(h.summary, MEMORY_LIMITS.content) && ['pending', 'accepted', 'closed'].includes(h.status)
      && Number.isSafeInteger(h.version) && h.version >= 1 && Array.isArray(h.memoryIds)
      && h.memoryIds.length <= 10 && h.memoryIds.every((id) => plain(id, 160))).slice(-MEMORY_LIMITS.handoffs).map(copy);
    for (const o of oldOperations) {
      try {
        if (!o || !plain(o.id, 160) || state.operations.some((previous) => previous.id === o.id)
          || !['revise', 'retract', 'accept'].includes(o.kind) || !['pending', 'applied', 'rejected'].includes(o.status)
          || !plain(o.targetId, 160) || !Number.isSafeInteger(o.targetVersion) || o.targetVersion < 1
          || !Number.isSafeInteger(o.version) || o.version < 1 || !plain(o.target?.content, MEMORY_LIMITS.content)
          || !KINDS.includes(o.target.kind) || (o.kind === 'revise' && !plain(o.content, MEMORY_LIMITS.content))
          || !Array.isArray(o.conflicts) || o.conflicts.length > MEMORY_LIMITS.entries
          || o.conflicts.some((ref) => !plain(ref?.id, 160) || !Number.isSafeInteger(ref.version) || ref.version < 1)) continue;
        if (narrowed.has(o.targetId) && o.status === 'pending') continue;
        const evidence = validEvidence(o.evidence);
        if (o.kind !== 'accept' && !evidence.some((e) => e.complete && ['settings', 'message'].includes(e.source))) continue;
        state.operations.push({ id: o.id, kind: o.kind, status: o.status, version: o.version,
          targetId: o.targetId, targetVersion: o.targetVersion,
          target: { content: o.target.content, kind: o.target.kind, ...scopeOf(o.target) },
          content: o.kind === 'revise' ? o.content : null, evidence,
          origin: ['settings', 'local', 'model'].includes(o.origin) ? o.origin : 'settings',
          conflicts: o.conflicts.map((ref) => ({ id: ref.id, version: ref.version })),
          createdAt: Number.isFinite(o.createdAt) ? o.createdAt : 0, updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
          ...(plain(o.resultId, 160) ? { resultId: o.resultId } : {}) });
      } catch { /* A malformed optional review must not prevent settings or reports from opening. */ }
    }
    if (narrowed.size) bump(true);
  }
  function validEvidence(value) {
    return (Array.isArray(value) ? value : []).filter((e) => e && plain(e.eventId, 330)
      && plain(e.quote, MEMORY_LIMITS.sourceText)).slice(0, 4).map((e) => ({
      eventId: e.eventId, quote: e.quote, source: ['message', 'settings'].includes(e.source) ? e.source : 'legacy',
      complete: e.complete === true, ...(plain(e.sessionId, 160) ? { sessionId: e.sessionId } : {}),
      ...(plain(e.personaId, 160) ? { personaId: e.personaId } : {}),
    }));
  }
  function sourceEvidence(source) {
    return { eventId: source.id, quote: source.text, source: 'message', complete: source.complete === true,
      sessionId: source.sessionId, personaId: source.personaId };
  }
  function conflictsFor(entry) {
    return state.entries.filter((e) => e.id !== entry.id && live(e) && e.kind === entry.kind
      && e.key === entry.key && sameScope(e, entry)).map((e) => ({ id: e.id, version: e.version }));
  }
  function propose(action, { evidence, origin = 'settings' } = {}) {
    const target = state.entries.find((e) => e.id === action.id);
    if (!target) fail('memory-not-found');
    if (target.version !== action.version) fail('memory-conflict');
    const kind = action.operation;
    if (!['revise', 'retract', 'accept'].includes(kind)) fail('invalid-memory-operation');
    if (kind === 'accept' ? target.status !== 'candidate' : !live(target)) fail('memory-target-inactive');
    if (kind === 'revise' && (!plain(action.content, MEMORY_LIMITS.content)
      || action.content.trim() === target.content)) fail('invalid-memory-replacement');
    if (!evidence) {
      if (kind === 'accept') evidence = copy(target.evidence);
      else {
        if (!plain(action.statement, MEMORY_LIMITS.sourceText)) fail('memory-statement-required');
        evidence = [{ eventId: 'settings:' + randomUUID(), quote: action.statement,
          source: 'settings', complete: true }];
      }
    }
    const duplicate = state.operations.find((o) => o.status === 'pending' && o.targetId === target.id
      && o.targetVersion === target.version && o.kind === kind && o.content === (kind === 'revise' ? action.content.trim() : null)
      && o.evidence.map((e) => e.quote).join('\n') === evidence.map((e) => e.quote).join('\n'));
    if (duplicate) return copy(duplicate);
    if (state.operations.length >= MEMORY_LIMITS.operations) {
      const index = state.operations.findIndex((o) => o.status !== 'pending');
      if (index < 0) fail('memory-operation-capacity');
      state.operations.splice(index, 1);
    }
    const op = { id: randomUUID(), kind, targetId: target.id, targetVersion: target.version,
      target: { content: target.content, kind: target.kind, ...scopeOf(target) },
      content: kind === 'revise' ? action.content.trim() : null, evidence: copy(evidence), origin,
      conflicts: kind === 'accept' ? conflictsFor(target) : [], status: 'pending', version: 1,
      createdAt: now(), updatedAt: now() };
    state.operations.push(op); bump(); return copy(op);
  }
  function resolveOperation(action) {
    const op = state.operations.find((o) => o.id === action.id);
    if (!op) fail('memory-operation-not-found');
    // Retrying an acknowledged confirmation is safe; it cannot apply a second correction.
    if (action.action === 'confirm' && op.status === 'applied') return copy(op);
    if (action.version !== op.version || op.status !== 'pending') fail('memory-conflict');
    if (action.action === 'dismiss') {
      op.status = 'rejected'; op.version += 1; op.updatedAt = now(); bump(); return copy(op);
    }
    const target = state.entries.find((e) => e.id === op.targetId);
    if (!target || target.version !== op.targetVersion || !sameScope(target, op.target)) fail('memory-conflict');
    if (op.kind === 'accept') {
      if (target.status !== 'candidate' || (target.expiresAt !== null && target.expiresAt <= now())
        || JSON.stringify(conflictsFor(target)) !== JSON.stringify(op.conflicts)) fail('memory-conflict');
      target.status = 'active'; target.version += 1; target.updatedAt = now();
      if (target.scope === 'shared') target.sharingConfirmed = true;
      supersede(target);
    } else {
      if (!live(target) || !validEvidence(op.evidence).some((e) => e.complete && ['settings', 'message'].includes(e.source))) {
        fail('memory-conflict');
      }
      if (op.kind === 'revise') {
        // A correction replaces exactly the selected record. It cannot silently replace another topic
        // or widen a private record, even when the new wording would get a different heuristic key.
        const replacement = { ...copy(target), id: randomUUID(), content: op.content, version: 1,
          evidence: copy(op.evidence), origin: 'correction', status: 'active', createdAt: now(), updatedAt: now(),
          replaces: target.id, operationId: op.id };
        delete replacement.supersededBy;
        compact(); state.entries.push(replacement);
        target.status = 'superseded'; target.supersededBy = replacement.id; op.resultId = replacement.id;
      } else target.status = 'retracted';
      target.version += 1; target.updatedAt = now();
      forgetQueuedEvidence({ ...target, evidence: [...target.evidence, ...op.evidence] });
    }
    target.operationId = op.id;
    op.status = 'applied'; op.version += 1; op.updatedAt = now(); bump(true); return copy(op);
  }
  function forgetQueuedEvidence(entry) {
    const ids = new Set(entry.evidence.map((e) => e.eventId));
    // Do not remove another persona's matching words merely because the spelling is identical.
    for (const source of state.sources) if (source.personaId === entry.personaId
      && (entry.scope !== 'session' || source.sessionId === entry.sessionId)
      && entry.evidence.some((e) => source.text === e.quote)) ids.add(source.id);
    state.queue = state.queue.filter((id) => !ids.has(id));
    state.sources = state.sources.filter((s) => !ids.has(s.id));
    for (const candidate of state.entries) if (candidate.status === 'candidate' && sameScope(candidate, entry)
      && candidate.evidence.some((ref) => ids.has(ref.eventId))) {
      candidate.status = 'rejected'; candidate.version += 1; candidate.updatedAt = now();
    }
  }
  function observe({ sessionId, personaId, seq, text, queue = true }) {
    if (!plain(sessionId, 160) || !plain(personaId, 160) || !Number.isSafeInteger(seq) || seq < 0
      || !plain(text, MEMORY_LIMITS.sourceText)) return false;
    const previous = Object.hasOwn(state.cursors, sessionId) ? state.cursors[sessionId] : -1;
    if (seq <= previous || (previous === -1 && Object.keys(state.cursors).length >= MEMORY_LIMITS.sessions)) return false;
    Object.defineProperty(state.cursors, sessionId, { value: seq, enumerable: true, writable: true, configurable: true });
    const clean = stripTechnicalSpans(text).split('\n').filter((line) => !/^\s*>/.test(line)).join('\n').trim();
    if (!clean) { bump(); return true; }
    const complete = clean === text.trim();
    const preferences = explicitPreferences(clean, personaId, sessionId, complete && authorizesSharing(text));
    if (!queue && !preferences.length) { bump(); return true; }
    // Filtering must never turn a partial sentence into apparently complete evidence.
    const source = { id: sessionId + ':' + seq, sessionId, personaId, text: clean,
      complete, at: now() };
    state.sources.push(source);
    state.sources = state.sources.slice(-MEMORY_LIMITS.sources);
    state.queue = state.queue.filter((id) => state.sources.some((s) => s.id === id));
    if (queue) state.queue.push(source.id);
    state.queue = state.queue.slice(-MEMORY_LIMITS.queue);
    for (const item of preferences) {
      try {
        if (item.scope === 'shared' && state.entries.some(e => live(e) && sameScope(e,item) && e.content === item.content)) continue;
        const previous = state.entries.find((e) => live(e) && e.kind === item.kind && e.key === item.key
          && sameScope(e, item) && e.content !== item.content);
        if (previous && source.complete) propose({ id: previous.id, version: previous.version,
          operation: 'revise', content: item.content }, { evidence: [sourceEvidence(source)], origin: 'local' });
        else put(item, { origin: 'explicit', status: source.complete && item.scope !== 'shared' ? 'active' : 'candidate', evidence: [sourceEvidence(source)] });
      } catch (error) { if (!['memory-capacity', 'memory-operation-capacity'].includes(error.message)) throw error; }
    }
    bump(); return true;
  }
  function mutate(action) {
    if (!action || typeof action !== 'object') fail('invalid-memory-action');
    if (action.action === 'propose-add') {
      const before = copy(state);
      try {
        const entry = put(action.entry, { status: 'candidate', evidence: [{ eventId: 'settings:' + randomUUID(),
          quote: action.entry?.content, source: 'settings', complete: true }] });
        return propose({ id: entry.id, version: entry.version, operation: 'accept' });
      } catch (error) { state = before; throw error; }
    }
    if (action.action === 'propose') return propose(action);
    if (action.action === 'confirm' || action.action === 'dismiss') return resolveOperation(action);
    if (action.action === 'add') {
      const entry = put(action.entry, { evidence: [{ eventId: 'settings:' + randomUUID(),
        quote: action.entry?.content, source: 'settings', complete: true }] });
      bump(true); return entry;
    }
    const entry = state.entries.find((e) => e.id === action.id);
    if (!entry) fail('memory-not-found');
    if (action.version !== entry.version) fail('memory-conflict');
    if (action.action === 'delete') {
      const sourceIds = new Set(entry.evidence.map((e) => e.eventId));
      const quotes = [...entry.evidence.map((e) => e.quote), entry.content];
      for (const source of state.sources) if ((entry.scope === 'shared' || source.personaId === entry.personaId)
        && (entry.scope !== 'session' || source.sessionId === entry.sessionId)
        && quotes.some((quote) => source.text.includes(quote))) sourceIds.add(source.id);
      state.sources = state.sources.filter((s) => !sourceIds.has(s.id));
      state.queue = state.queue.filter((id) => !sourceIds.has(id));
      state.entries = state.entries.filter((e) => e.id !== entry.id);
      state.operations = state.operations.filter((o) => o.targetId !== entry.id && o.resultId !== entry.id);
      for (const handoff of state.handoffs) handoff.memoryIds = handoff.memoryIds.filter((id) => id !== entry.id);
    } else if (action.action === 'accept' || action.action === 'reject') {
      if (entry.status !== 'candidate') fail('memory-not-candidate');
      entry.status = action.action === 'accept' ? 'active' : 'rejected';
      if (entry.status === 'active') {
        if (entry.scope === 'shared') entry.sharingConfirmed = true;
        supersede(entry);
      }
      entry.version += 1; entry.updatedAt = now();
    } else if (action.action === 'pin') {
      if (!live(entry) || typeof action.pinned !== 'boolean') fail('invalid-memory-entry');
      entry.pinned = action.pinned; entry.version += 1; entry.updatedAt = now();
    } else if (action.action === 'update') {
      if (!plain(action.content, MEMORY_LIMITS.content) || typeof action.pinned !== 'boolean') fail('invalid-memory-entry');
      const scope = scopeOf({ ...entry, ...action });
      if (['agreement', 'episode'].includes(entry.kind) && scope.scope === 'shared') fail('private-memory-needs-scope');
      const expiresAt = scope.scope === 'session'
        ? (entry.scope === 'session' ? entry.expiresAt : now() + 86400000) : null;
      Object.assign(entry, scope, { content: action.content.trim(), pinned: action.pinned, origin: 'manual',
        status: 'active', expiresAt, version: entry.version + 1, updatedAt: now() });
      // An edited summary is a new owner-authored statement, not the old message's words.
      entry.evidence = [{ eventId: 'settings:' + randomUUID(), quote: action.content,
        source: 'settings', complete: true }];
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
      s.personaId === first.personaId && s.sessionId === first.sessionId).slice(0, 12) : [],
      targets: first ? state.entries.filter((e) => live(e) && ['preference', 'agreement'].includes(e.kind)
        && ((e.scope === 'persona' && e.personaId === first.personaId)
          || (e.scope === 'session' && e.personaId === first.personaId && e.sessionId === first.sessionId)))
        .slice(-20).map((e) => ({ id: e.id, version: e.version, kind: e.kind, content: e.content,
          scope: e.scope, personaId: e.personaId, sessionId: e.sessionId })) : [] };
  }
  function commit(batchValue, proposals) {
    if (batchValue.epoch !== state.epoch || !Array.isArray(proposals) || proposals.length > 5) return false;
    const sources = batchValue.sources;
    if (!sources.length || sources.some((s) => !state.queue.includes(s.id)
      || !state.sources.some((liveSource) => JSON.stringify(liveSource) === JSON.stringify(s)))) return false;
    const validated = proposals.map((item) => {
      const operation = item?.operation ?? 'add';
      if (!item || !['add', 'revise', 'retract'].includes(operation)
        || (operation === 'add' && !KINDS.includes(item.kind))
        || (operation !== 'retract' && !plain(item.content, MEMORY_LIMITS.content))
        || !Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 4) fail('invalid-memory-proposal');
      const evidence = item.evidence.map((ref) => {
        const source = sources.find((s) => s.id === ref.eventId);
        if (!source || !plain(ref.quote, MEMORY_LIMITS.sourceText) || !source.text.includes(ref.quote)
          || (operation !== 'add' && (!source.complete
            || source.text.indexOf(ref.quote) !== source.text.lastIndexOf(ref.quote)))) fail('invalid-memory-evidence');
        // A locator is never displayed as the entire user statement. Retain all negation and context.
        return sourceEvidence(source);
      }).filter((ref, index, all) => all.findIndex((e) => e.eventId === ref.eventId) === index);
      if (operation !== 'add') {
        const target = state.entries.find((e) => e.id === item.target?.id && e.version === item.target?.version
          && live(e) && ['preference', 'agreement'].includes(e.kind)
          && e.personaId === sources[0].personaId
          && (e.scope === 'persona' || (e.scope === 'session' && e.sessionId === sources[0].sessionId)));
        if (!target || !batchValue.targets?.some((e) => e.id === target.id && e.version === target.version)) fail('invalid-memory-target');
        return { operation, target, content: item.content, evidence };
      }
      if (!SCOPES.includes(item.scope)) fail('invalid-memory-scope');
      if (item.scope === 'shared' && (item.kind !== 'preference'
        || evidence.some(e => !e.complete || !authorizesSharing(e.quote)))) fail('unproven-shared-memory');
      return { kind: item.kind, scope: item.scope, content: item.content, tags: item.tags,
        personaId: item.scope === 'shared' ? null : sources[0].personaId,
        sessionId: item.scope === 'session' ? sources[0].sessionId : null, evidence };
    });
    const before = copy(state);
    try {
      for (const item of validated) {
        if (item.operation) propose({ id: item.target.id, version: item.target.version,
          operation: item.operation, content: item.content }, { evidence: item.evidence, origin: 'model' });
        else put(item, { origin: 'model', status: 'candidate', evidence: item.evidence });
      }
    } catch (error) { state = before; throw error; }
    state.queue = state.queue.filter((id) => !sources.some((s) => s.id === id));
    bump(); return true;
  }
  function readable(e, { personaId, sessionId, purpose = 'rewrite' }) {
    return live(e) && (e.scope === 'shared'
      || (e.scope === 'persona' && e.personaId === personaId)
      || (e.scope === 'session' && e.sessionId === sessionId && (!e.personaId || e.personaId === personaId)))
      && (purpose !== 'rewrite' || ['preference', 'agreement'].includes(e.kind));
  }
  function references(refs, context = {}) {
    if (!Array.isArray(refs)) return [];
    return refs.slice(0, MEMORY_LIMITS.selected).map((ref) => state.entries.find((e) =>
      e.id === ref?.id && e.version === ref.version && readable(e, context))).filter(Boolean).map(copy);
  }
  function selection({ personaId, sessionId, text = '', purpose = 'rewrite' } = {}) {
    const omitted = [];
    const omit = (entry, reason) => omitted.push({ id: entry.id, version: entry.version, reason });
    const eligible = [];
    for (const entry of state.entries) {
      const inScope = entry.scope === 'shared' || (entry.scope === 'persona' && entry.personaId === personaId)
        || (entry.scope === 'session' && entry.sessionId === sessionId && (!entry.personaId || entry.personaId === personaId));
      if (!inScope) continue;
      if (entry.status !== 'active') omit(entry, entry.status);
      else if (entry.expiresAt !== null && entry.expiresAt <= now()) omit(entry, 'expired');
      else if (purpose === 'rewrite' && !['preference', 'agreement'].includes(entry.kind)) omit(entry, 'not-expression');
      else eligible.push(entry);
    }
    const score = (e) => (e.scope === 'session' ? 100 : e.scope === 'persona' ? 60 : 30)
      + (e.pinned ? 20 : 0) + e.tags.filter((tag) => text.includes(tag)).length * 5;
    eligible.sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt);
    const chosen = []; const keys = new Set(); let chars = 0;
    for (const entry of eligible) {
      const key = entry.kind + ':' + entry.key;
      if (keys.has(key)) { omit(entry, 'overridden'); continue; }
      if (chosen.length >= MEMORY_LIMITS.selected) { omit(entry, 'limit'); continue; }
      if (chars + entry.content.length > MEMORY_LIMITS.promptChars) { omit(entry, 'budget'); continue; }
      chosen.push(copy(entry)); keys.add(key); chars += entry.content.length;
    }
    return { entries: chosen, omitted };
  }
  const select = (context) => selection(context).entries;
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
    restore, observe, mutate, batch, commit, select, selection, references, handoff, handoffContext,
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
