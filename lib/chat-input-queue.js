import { createHash } from 'node:crypto';
import { publicCoordinationQuote } from './chat-coordinator.js';
import { quoteRef } from './chat-quote.js';

const LIMITS = { rooms: 32, parts: 16, chars: 16000, batchParts: 8, message: 4000, receipts: 512 };
const FAILURES = new Set(['interrupted', 'cancelled', 'source-changed', 'context-changed', 'persona-changed', 'memory-changed',
  'member-removed', 'unavailable', 'timeout', 'network', 'auth', 'rate-limit', 'format', 'incomplete', 'too-long', 'length', 'model', 'save', 'unknown']);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const keys = (value, allowed, required = allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key))
  && required.every(key => Object.hasOwn(value, key));
const clone = value => structuredClone(value);
const fail = code => { throw new Error(code); };
const empty = () => ({ version: 1, revision: 0, rooms: [], receipts: [] });
const keyOf = (roomId, requestId) => JSON.stringify([roomId, requestId]);
const failureCode = code => FAILURES.has(code) ? code : 'unknown';
const nullableKey = value => value == null ? null : text(value, 4000) ? value : fail('invalid-chat-input');

function publicRecipients(value) {
  if (!Array.isArray(value) || value.length > 8
    || value.some(person => !keys(person, ['id', 'name']) || !id(person.id) || !text(person.name, 80))
    || new Set(value.map(person => person.id)).size !== value.length) fail('invalid-chat-input');
  return value.map(({ id, name }) => ({ id, name }));
}
function publicQuote(value) {
  if (value == null) return null;
  const quote = publicCoordinationQuote(value); if (!quote) fail('invalid-chat-input');
  if (!Object.hasOwn(value, 'ref')) return quote;
  const ref = quoteRef(value.ref); if (!ref || ref.kind !== quote.author.role) fail('invalid-chat-input');
  return { ...quote, ref };
}
function publicClientTime(value) {
  if (!record(value)) return null;
  const result = {};
  if (typeof value.timeZone === 'string' && value.timeZone.length <= 80 && /^[A-Za-z0-9_+./-]+$/u.test(value.timeZone)) result.timeZone = value.timeZone;
  if (Number.isInteger(value.utcOffsetMinutes) && Math.abs(value.utcOffsetMinutes) <= 840) result.utcOffsetMinutes = value.utcOffsetMinutes;
  return Object.keys(result).length ? result : null;
}
function envelope(value) {
  const recipients = publicRecipients(value.recipients), memberIds = value.memberIds ?? recipients.map(person => person.id);
  if (!Array.isArray(memberIds) || memberIds.length < 1 || memberIds.length > 8 || !memberIds.every(id)
    || new Set(memberIds).size !== memberIds.length || recipients.some(person => !memberIds.includes(person.id))
    || !revision(value.referenceRevision ?? 0)) fail('invalid-chat-input');
  return { recipients, memberIds: [...memberIds], referenceRevision: value.referenceRevision ?? 0,
    scopeKey: nullableKey(value.scopeKey), contextKey: nullableKey(value.contextKey), quote: publicQuote(value.quote) };
}
const fingerprint = (value, content) => createHash('sha256').update(JSON.stringify({ ...envelope(value), content })).digest('hex');
const compatible = (batch, value) => JSON.stringify(envelope(batch)) === JSON.stringify(envelope(value));
const makeRoom = roomId => ({ roomId, lastComplete: null, lastUserAt: null, batches: [] });
const firstPending = room => room && !room.batches.some(batch => batch.status === 'sending')
  ? room.batches.find(batch => batch.status === 'pending') ?? null : null;
function capacity(room) {
  if (room.batches.reduce((sum, batch) => sum + batch.parts.length, 0) > LIMITS.parts
    || room.batches.reduce((sum, batch) => sum + batch.message.length, 0) > LIMITS.chars) fail('chat-input-capacity');
}
function trimReceipts(state) {
  while (state.receipts.length > LIMITS.receipts) {
    const index = state.receipts.findIndex(receipt => receipt.completed); if (index < 0) fail('chat-input-capacity');
    state.receipts.splice(index, 1);
  }
}
function retire(state, roomId, batchId, cancelled) {
  for (const receipt of state.receipts) if (receipt.roomId === roomId && receipt.batchId === batchId) {
    receipt.completed = true; receipt.cancelled = cancelled;
  }
}

/** Durable public user-input batches. The Host owns all wakeups and source checks. */
export function createChatInputQueue({ persist = async () => {}, now = Date.now, intervalMs = 0 } = {}) {
  if (typeof persist !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 0) fail('invalid-chat-input-queue');
  let state = empty(), writes = Promise.resolve();
  const serial = fn => { const task = writes.catch(() => {}).then(fn); writes = task.catch(() => {}); return task; };
  const clock = () => { const value = now(); if (!time(value)) fail('invalid-chat-input-time'); return value; };
  const roomOf = roomId => state.rooms.find(room => room.roomId === roomId);
  const notBefore = roomId => {
    const room = roomOf(roomId); if (!room) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(room.lastComplete == null ? 0 : room.lastComplete + intervalMs,
      room.lastUserAt == null ? 0 : room.lastUserAt + intervalMs));
  };
  const commit = async draft => {
    if (!revision(Math.max(state.revision, draft.revision))) fail('chat-input-capacity');
    draft.revision = Math.max(state.revision, draft.revision) + 1;
    try { await persist(clone(draft)); } catch { fail('chat-input-save-failed'); }
    state = draft;
  };
  const requireRoomId = roomId => { if (!id(roomId)) fail('invalid-chat-input'); };
  const ensureRoom = (draft, roomId) => {
    let room = draft.rooms.find(room => room.roomId === roomId);
    if (!room) { if (draft.rooms.length >= LIMITS.rooms) fail('chat-input-capacity'); room = makeRoom(roomId); draft.rooms.push(room); }
    return room;
  };
  const api = {
    snapshot: () => clone(state),
    list(roomId) { return clone(roomOf(roomId)?.batches ?? []); },
    peek(roomId) { return clone(firstPending(roomOf(roomId))); },
    notBefore,
    drain: () => writes,
    enqueue(input) {
      let value, receivedAt;
      try { value = clone(input); receivedAt = value?.at ?? clock(); }
      catch (error) { return Promise.reject(new Error(error.message === 'invalid-chat-input-time' ? error.message : 'invalid-chat-input')); }
      return serial(async () => {
      if (!keys(value, ['roomId', 'requestId', 'content', 'recipients', 'memberIds', 'referenceRevision', 'scopeKey', 'contextKey', 'quote', 'clientTime', 'at'],
        ['roomId', 'requestId', 'content', 'recipients']) || !id(value.roomId) || !id(value.requestId) || !text(value.content, LIMITS.message)) fail('invalid-chat-input');
      const frozen = envelope(value), hash = fingerprint(frozen, value.content), receiptKey = keyOf(value.roomId, value.requestId);
      const old = state.receipts.find(receipt => keyOf(receipt.roomId, receipt.requestId) === receiptKey);
      if (old) {
        if (old.fingerprint !== hash) fail('chat-input-conflict');
        const batch = roomOf(value.roomId)?.batches.find(batch => batch.id === old.batchId) ?? null;
        return { created: false, merged: false, completed: old.completed, cancelled: old.cancelled, batchId: old.batchId, batch: clone(batch) };
      }
      const at = receivedAt; if (!time(at)) fail('invalid-chat-input');
      const draft = clone(state), room = ensureRoom(draft, value.roomId), tail = room.batches.at(-1);
      const merged = tail?.status === 'pending' && compatible(tail, frozen) && tail.parts.length < LIMITS.batchParts
        && tail.message.length + 1 + value.content.length <= LIMITS.message;
      let batch;
      if (merged) {
        batch = tail; batch.parts.push({ id: value.requestId, text: value.content, at });
        batch.message = batch.parts.map(part => part.text).join('\n'); batch.clientTime = publicClientTime(value.clientTime);
      } else {
        batch = { id: value.requestId, roomId: value.roomId, status: 'pending', message: value.content,
          parts: [{ id: value.requestId, text: value.content, at }], ...frozen, clientTime: publicClientTime(value.clientTime), at, failure: null };
        room.batches.push(batch);
      }
      room.lastUserAt = Math.max(room.lastUserAt ?? 0, at); capacity(room);
      draft.receipts.push({ roomId: value.roomId, requestId: value.requestId, batchId: batch.id, fingerprint: hash, completed: false, cancelled: false });
      trimReceipts(draft); await commit(draft);
      return { created: true, merged, completed: false, cancelled: false, batchId: batch.id, batch: clone(batch) };
    }); },
    claim(roomId, batchId) { return serial(async () => {
      requireRoomId(roomId); const pending = firstPending(roomOf(roomId));
      if (!pending || pending.id !== batchId || clock() < notBefore(roomId)) return null;
      const draft = clone(state), batch = draft.rooms.find(room => room.roomId === roomId).batches.find(batch => batch.id === batchId);
      batch.status = 'sending'; batch.failure = null; await commit(draft); return clone(batch);
    }); },
    complete(roomId, batchId) { return serial(async () => {
      requireRoomId(roomId); const draft = clone(state), room = draft.rooms.find(room => room.roomId === roomId);
      const index = room?.batches.findIndex(batch => batch.id === batchId) ?? -1; if (index < 0) return false;
      room.batches.splice(index, 1); retire(draft, roomId, batchId, false); await commit(draft); return true;
    }); },
    fail(roomId, batchId, code) { return serial(async () => {
      requireRoomId(roomId); const draft = clone(state), batch = draft.rooms.find(room => room.roomId === roomId)?.batches.find(batch => batch.id === batchId);
      if (!batch) return null; batch.status = 'failed'; batch.failure = failureCode(code); await commit(draft); return clone(batch);
    }); },
    retry(roomId, batchId) { return serial(async () => {
      requireRoomId(roomId); const draft = clone(state), batch = draft.rooms.find(room => room.roomId === roomId)?.batches.find(batch => batch.id === batchId);
      if (!batch || batch.status !== 'failed') return null; batch.status = 'pending'; batch.failure = null; await commit(draft); return clone(batch);
    }); },
    cancel(roomId, batchId) { return serial(async () => {
      requireRoomId(roomId); const draft = clone(state), room = draft.rooms.find(room => room.roomId === roomId);
      const index = room?.batches.findIndex(batch => batch.id === batchId) ?? -1; if (index < 0) return false;
      if (room.batches[index].status === 'sending') fail('chat-input-busy');
      room.batches.splice(index, 1); retire(draft, roomId, batchId, true); await commit(draft); return true;
    }); },
    clear(roomId, options = {}) { return serial(async () => {
      requireRoomId(roomId);
      if (!keys(options, ['forgetReceipts'], []) || (Object.hasOwn(options, 'forgetReceipts') && typeof options.forgetReceipts !== 'boolean')) fail('invalid-chat-input');
      const draft = clone(state), index = draft.rooms.findIndex(room => room.roomId === roomId);
      const forget = options.forgetReceipts === true;
      if (index < 0 && (!forget || !draft.receipts.some(receipt => receipt.roomId === roomId))) return false;
      if (index >= 0) {
        for (const batch of draft.rooms[index].batches) retire(draft, roomId, batch.id, true);
        draft.rooms.splice(index, 1);
      }
      // Only the Host may forget receipts after it has durably retired this
      // room generation and rejects requests carrying the former epoch.
      if (forget) draft.receipts = draft.receipts.filter(receipt => receipt.roomId !== roomId);
      await commit(draft); return true;
    }); },
    finishRound(roomId) { return serial(async () => {
      requireRoomId(roomId); const draft = clone(state), room = ensureRoom(draft, roomId);
      room.lastComplete = Math.max(room.lastComplete ?? 0, clock()); await commit(draft); return notBefore(roomId);
    }); },
    restore(input) {
      let value; try { value = clone(input); } catch { return Promise.reject(new Error('invalid-chat-input-queue')); }
      return serial(async () => {
      if (value == null) return clone(state);
      try {
        if (!keys(value, ['version', 'revision', 'rooms', 'receipts']) || value.version !== 1 || !revision(value.revision)
          || !Array.isArray(value.rooms) || value.rooms.length > LIMITS.rooms || !Array.isArray(value.receipts) || value.receipts.length > LIMITS.receipts) fail('invalid');
        const restored = { version: 1, revision: value.revision, rooms: [], receipts: [] }, roomIds = new Set(), active = new Map();
        for (const source of value.rooms) {
          if (!keys(source, ['roomId', 'lastComplete', 'lastUserAt', 'batches']) || !id(source.roomId) || roomIds.has(source.roomId)
            || (source.lastComplete !== null && !time(source.lastComplete)) || (source.lastUserAt !== null && !time(source.lastUserAt)) || !Array.isArray(source.batches)) fail('invalid');
          roomIds.add(source.roomId); const room = makeRoom(source.roomId); room.lastComplete = source.lastComplete; room.lastUserAt = source.lastUserAt;
          for (const sourceBatch of source.batches) {
            if (!keys(sourceBatch, ['id', 'roomId', 'status', 'message', 'parts', 'recipients', 'memberIds', 'referenceRevision', 'scopeKey', 'contextKey', 'quote', 'clientTime', 'at', 'failure'])
              || !id(sourceBatch.id) || sourceBatch.roomId !== room.roomId || !['pending', 'sending', 'failed'].includes(sourceBatch.status)
              || !Array.isArray(sourceBatch.parts) || sourceBatch.parts.length < 1 || sourceBatch.parts.length > LIMITS.batchParts || !time(sourceBatch.at)
              || !text(sourceBatch.message, LIMITS.message) || (sourceBatch.status === 'failed' ? !FAILURES.has(sourceBatch.failure) : sourceBatch.failure !== null)) fail('invalid');
            const frozen = envelope(sourceBatch), parts = [];
            for (const part of sourceBatch.parts) {
              if (!keys(part, ['id', 'text', 'at']) || !id(part.id) || !text(part.text, LIMITS.message) || !time(part.at)) fail('invalid');
              const key = keyOf(room.roomId, part.id); if (active.has(key)) fail('invalid');
              active.set(key, { batchId: sourceBatch.id, fingerprint: fingerprint(frozen, part.text) }); parts.push({ id: part.id, text: part.text, at: part.at });
            }
            if (sourceBatch.id !== parts[0].id || sourceBatch.at !== parts[0].at || sourceBatch.message !== parts.map(part => part.text).join('\n')
              || source.lastUserAt === null || parts.some(part => part.at > source.lastUserAt)) fail('invalid');
            room.batches.push({ id: sourceBatch.id, roomId: room.roomId, status: 'failed', message: sourceBatch.message, parts, ...frozen,
              clientTime: publicClientTime(sourceBatch.clientTime), at: sourceBatch.at, failure: sourceBatch.status === 'failed' ? sourceBatch.failure : 'interrupted' });
          }
          capacity(room); restored.rooms.push(room);
        }
        const receiptIds = new Set();
        for (const receipt of value.receipts) {
          if (!keys(receipt, ['roomId', 'requestId', 'batchId', 'fingerprint', 'completed', 'cancelled']) || !id(receipt.roomId) || !id(receipt.requestId) || !id(receipt.batchId)
            || !/^[a-f0-9]{64}$/u.test(receipt.fingerprint) || typeof receipt.completed !== 'boolean' || typeof receipt.cancelled !== 'boolean'
            || (receipt.cancelled && !receipt.completed)) fail('invalid');
          const key = keyOf(receipt.roomId, receipt.requestId), pending = active.get(key);
          if (receiptIds.has(key) || (receipt.completed ? pending : !pending || receipt.batchId !== pending.batchId || receipt.fingerprint !== pending.fingerprint)) fail('invalid');
          receiptIds.add(key); restored.receipts.push({ ...receipt });
        }
        if ([...active.keys()].some(key => !receiptIds.has(key))) fail('invalid');
        await commit(restored); return clone(state);
      } catch (error) { if (error.message === 'chat-input-save-failed') throw error; fail('invalid-chat-input-queue'); }
    }); },
  };
  return api;
}
