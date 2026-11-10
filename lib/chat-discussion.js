import { quoteRef, quoteKey, resolveChatQuote } from './chat-quote.js';

export const DISCUSSION_STATES = ['discussing', 'proposal', 'confirmed', 'deferred', 'rejected'];
const decided = status => ['confirmed', 'deferred', 'rejected'].includes(status);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = reason => { throw Error(reason); };
const empty = () => ({ revision: 0, entries: [], operations: [] });
const quotePosition=(room,ref)=>{
  const index=room.turns.findIndex(turn=>ref.kind==='user'?
    turn.messageId===ref.messageId||turn.userParts?.some(part=>part.id===ref.messageId):turn.id===ref.turnId&&turn.attemptId===ref.attemptId);
  if(index<0)return null;
  const turn=room.turns[index],part=ref.kind==='user'&&Array.isArray(turn.userParts)?turn.userParts.findIndex(value=>value.id===ref.messageId):0;
  return part<0?null:{index,part,messageId:turn.messageId};
};
const evidenceFollows = (room, source, evidence) => {
  if (!source || !evidence || evidence.author.role !== 'user') return false;
  const from=quotePosition(room,source.ref),to=quotePosition(room,evidence.ref);
  if(!from||!to)return false;
  if(source.ref.kind==='user')return from.messageId===to.messageId?to.part>=from.part:to.index>from.index;
  // Every user part of this input batch predates its assistant responses.
  // An assistant proposal needs a later user round, not another part of its own.
  return to.index>from.index&&to.messageId!==from.messageId;
};
const entry = (value, roomId) => {
  const source = quoteRef(value?.source), evidence = quoteRef(value?.evidence);
  if (!id(value?.id) || !integer(value.version) || value.version < 1 || !id(value.scopeKey)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100
    || !DISCUSSION_STATES.includes(value.status) || !source || source.roomId !== roomId
    || !integer(value.updatedAt) || (decided(value.status) && (!evidence || evidence.roomId !== roomId || evidence.kind !== 'user'))) return null;
  return { id: value.id, version: value.version, title: value.title, status: value.status, scopeKey: value.scopeKey,
    source, evidence: decided(value.status) ? evidence : null, updatedAt: value.updatedAt };
};

/** Room-owned annotations: evidence pointers and owner-entered labels, never copied dialogue or private memory. */
export function restoreDiscussion(raw, roomId) {
  if (!integer(raw?.revision)) return empty();
  const entries = [], operations = [];
  for (const value of (Array.isArray(raw.entries) ? raw.entries : []).slice(-16)) {
    const normalized = entry(value, roomId);
    if (normalized && normalized.version <= raw.revision && !entries.some(e => e.id === normalized.id)) entries.push(normalized);
  }
  for (const op of (Array.isArray(raw.operations) ? raw.operations : []).slice(-10)) {
    const previous = op?.previous === null ? null : entry(op?.previous, roomId);
    if (id(op?.entryId) && integer(op.revision) && op.revision > 0 && op.revision <= raw.revision
      && (op.previous === null || previous?.id === op.entryId)) operations.push({ entryId: op.entryId, revision: op.revision, previous });
  }
  return { revision: raw.revision, entries, operations };
}

export function discussionView(room, scopeKey) {
  const board = restoreDiscussion(room?.discussion, room?.id);
  return { revision: board.revision, canUndo: board.operations.length > 0, entries: board.entries.map(item => {
    const inScope = item.scopeKey === scopeKey, source = inScope ? resolveChatQuote(room, item.source, scopeKey) : null;
    const evidence = inScope && item.evidence ? resolveChatQuote(room, item.evidence, scopeKey) : null;
    const available = !!source && (!decided(item.status) || evidenceFollows(room, source, evidence));
    return { id: item.id, version: item.version, status: item.status, updatedAt: item.updatedAt, inScope, available,
      ...(inScope ? { title: item.title } : {}), source: source ?? { ref: item.source, available: false },
      evidence: evidence ?? (item.evidence ? { ref: item.evidence, available: false } : null) };
  }) };
}

export function changeDiscussion(room, body, scopeKey, now) {
  const board = restoreDiscussion(room.discussion, room.id);
  if (body.discussionRevision !== board.revision) fail('chat-discussion-conflict');
  const next = structuredClone(board), index = next.entries.findIndex(e => e.id === body.id);
  if (body.action === 'undo') {
    const op = next.operations.pop(); if (!op) fail('chat-discussion-undo-unavailable');
    next.entries = next.entries.filter(e => e.id !== op.entryId);
    if (op.previous && next.entries.length >= 16) fail('chat-discussion-capacity');
    if (op.previous) next.entries.push({ ...op.previous, version: next.revision + 1, updatedAt: now });
  } else {
    if (!['add', 'update', 'remove'].includes(body.action)) fail('invalid-chat-discussion');
    const previous = index >= 0 ? next.entries[index] : null;
    if (body.action === 'add') {
      if (!id(body.requestId) || next.entries.some(e => e.id === 'topic:' + body.requestId)) fail('chat-discussion-conflict');
      if (next.entries.length >= 16) fail('chat-discussion-capacity');
    } else if (!previous || body.version !== previous.version) fail('chat-discussion-conflict');
    if (body.action === 'remove') next.entries.splice(index, 1);
    else {
      const sourceRef = previous?.source ?? quoteRef(body.source), source = resolveChatQuote(room, sourceRef, scopeKey);
      if (!source || (previous && previous.scopeKey !== scopeKey)) fail('chat-quote-unavailable');
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100 || !DISCUSSION_STATES.includes(body.status)) fail('invalid-chat-discussion');
      if (body.action === 'add' && next.entries.some(e => e.scopeKey === scopeKey && quoteKey(e.source) === quoteKey(sourceRef))) fail('chat-discussion-duplicate');
      const evidenceRef = decided(body.status) ? quoteRef(body.evidence) : null;
      const evidence = evidenceRef ? resolveChatQuote(room, evidenceRef, scopeKey) : null;
      if (decided(body.status)) {
        if (!evidenceFollows(room, source, evidence)) fail('chat-discussion-evidence-required');
      }
      const value = { id: previous?.id ?? 'topic:' + body.requestId, version: next.revision + 1, title: body.title.trim(), status: body.status,
        source: source.ref, evidence: evidence?.ref ?? null, scopeKey, updatedAt: now };
      if (!entry(value, room.id)) fail('invalid-chat-discussion');
      if (previous) next.entries[index] = value; else next.entries.push(value);
    }
    next.operations.push({ entryId: previous?.id ?? 'topic:' + body.requestId, revision: next.revision + 1, previous });
    next.operations = next.operations.slice(-10);
  }
  next.revision++; return next;
}

export function discussionContext(room, scopeKey) {
  let chars = 0;
  return discussionView(room, scopeKey).entries.filter(e => e.available).sort((a, b) => b.updatedAt - a.updatedAt || b.version - a.version)
    .filter(e => { const size = e.title.length + e.source.text.length + (e.evidence?.text.length ?? 0);
      if (chars + size > 3000) return false; chars += size; return true; }).slice(0, 8)
    .map(({ id, version, title, status, source, evidence }) => ({ id, version, title, status, source, evidence, reviewedBy: 'user-in-settings' }));
}

/** Temporary speaking duties follow frozen mentions and actual completed public replies, not a character's identity. */
export function chatAssignment(turn, exchange = []) {
  const order = turn.recipients.findIndex(p => p.id === turn.recipientId) + 1;
  const completed = exchange.some(item => (Array.isArray(item.messages) && (!item.status || item.status === 'ready') ? item.messages : item.status === 'ready' ? item.assistant : [])
    ?.some(text => typeof text === 'string' && text.trim()));
  const kind = turn.directedPlanId ? (turn.responsePlan?.to==='user'?'respond':'answer-peer')
    :turn.responsePlan?.kind === 'invited' ? 'invited' : turn.phase === 'followup' ? 'answer-peer' : turn.phase === 'reaction' ? 'contribute'
    : order > 1 && completed ? 'complement' : 'respond';
  return { kind, ...(order > 0 ? { order } : {}), primaryCount: turn.recipients.length };
}
