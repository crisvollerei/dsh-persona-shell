/** Session choices and manual relay live in one durable record. No working-agent writes. */
import { randomUUID } from 'node:crypto';
const LIMIT = 500;
const validId = (id) => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 200;
const clone = (value) => JSON.parse(JSON.stringify(value));
const fresh = () => ({ version: 1, sessions: {} });

export function createConversations({ persist = async () => {}, changed = () => {}, now = Date.now, id = randomUUID } = {}) {
  let state = fresh();
  let writes = Promise.resolve();
  const read = (sessionId) => clone(Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId]
    : { revision: 0, personaId: null, trigger: 'inherit', relay: null });
  function serial(task) {
    const result = writes.catch(() => {}).then(task);
    writes = result.catch(() => {});
    return result;
  }
  async function commit(sessionId, next) {
    if (!Object.hasOwn(state.sessions, sessionId) && Object.keys(state.sessions).length >= LIMIT) throw new Error('session-capacity');
    const snapshot = clone(state);
    Object.defineProperty(snapshot.sessions, sessionId, { value: clone(next), enumerable: true, writable: true, configurable: true });
    await persist(snapshot);
    const previous = read(sessionId);
    state = snapshot;
    changed(sessionId, previous);
    return read(sessionId);
  }
  return {
    read,
    snapshot: () => clone(state),
    drain: () => writes,
    restore(raw) {
      state = fresh();
      if (raw?.version !== 1 || !raw.sessions || typeof raw.sessions !== 'object') return;
      for (const [key, value] of Object.entries(raw.sessions).slice(0, LIMIT)) {
        if (!validId(key) || !value || !Number.isSafeInteger(value.revision) || value.revision < 0) continue;
        const relay = value.relay;
        Object.defineProperty(state.sessions, key, { enumerable: true, writable: true, configurable: true, value: {
          revision: value.revision,
          personaId: validId(value.personaId) ? value.personaId : null,
          trigger: ['step', 'report'].includes(value.trigger) ? value.trigger : 'inherit',
          relay: relay && validId(relay.id) && validId(relay.toPersonaId)
            && Number.isSafeInteger(relay.afterSeq) && relay.afterSeq >= -1
            && ['pending', 'active', 'cancelled'].includes(relay.status) ? {
              id: relay.id, toPersonaId: relay.toPersonaId,
              fromPersonaId: validId(relay.fromPersonaId) ? relay.fromPersonaId : null,
              status: relay.status, afterSeq: Number.isSafeInteger(relay.afterSeq) ? relay.afterSeq : -1,
              consumedSeq: Number.isSafeInteger(relay.consumedSeq) ? relay.consumedSeq : null,
              at: Number.isFinite(relay.at) ? relay.at : 0,
            } : null,
        } });
      }
    },
    update(sessionId, body, { knownPersona, currentPersonaId, latestSeq = -1 }) {
      return serial(async () => {
        if (!validId(sessionId)) throw new Error('invalid-session');
        const next = read(sessionId);
        if (body.revision !== next.revision) throw new Error('conversation-conflict');
        if (body.action === 'select') {
          if (body.personaId !== null && !knownPersona(body.personaId)) throw new Error('persona-not-found');
          if (!['inherit', 'step', 'report'].includes(body.trigger)) throw new Error('invalid-trigger');
          next.personaId = body.personaId;
          next.trigger = body.trigger;
          if (next.relay?.status === 'pending') next.relay.status = 'cancelled';
        } else if (body.action === 'relay') {
          if (!knownPersona(body.toPersonaId)) throw new Error('persona-not-found');
          if (body.toPersonaId === currentPersonaId()) throw new Error('relay-same-persona');
          if (next.relay?.status === 'pending') throw new Error('relay-already-pending');
          next.relay = { id: id(), fromPersonaId: currentPersonaId(), toPersonaId: body.toPersonaId,
            status: 'pending', afterSeq: latestSeq, consumedSeq: null, at: now() };
        } else if (body.action === 'cancel') {
          if (next.relay?.status !== 'pending' || body.relayId !== next.relay.id) throw new Error('relay-conflict');
          next.relay.status = 'cancelled';
        } else throw new Error('invalid-conversation-action');
        next.revision += 1;
        return commit(sessionId, next);
      });
    },
    take(sessionId, seq, knownPersona) {
      return serial(async () => {
        if (!validId(sessionId) || !Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid-source');
        const next = read(sessionId);
        const previousPersona = next.personaId;
        const relay = next.relay;
        if (relay?.status !== 'pending' || seq <= relay.afterSeq) return false;
        if (!knownPersona(relay.toPersonaId)) {
          relay.status = 'cancelled';
          next.revision += 1;
          await commit(sessionId, next);
          throw new Error('relay-persona-deleted');
        }
        next.personaId = relay.toPersonaId;
        relay.status = 'active';
        relay.consumedSeq = seq;
        next.revision += 1;
        await commit(sessionId, next);
        // Preset management is independent; it may remove a target while storage is busy.
        if (!knownPersona(relay.toPersonaId)) {
          next.personaId = previousPersona;
          relay.status = 'cancelled';
          next.revision += 1;
          await commit(sessionId, next);
          throw new Error('relay-persona-deleted');
        }
        return true;
      });
    },
  };
}
