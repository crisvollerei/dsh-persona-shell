import { randomUUID, createHash } from 'node:crypto';

export const CHAT_LIMITS = Object.freeze({ rooms: 32, members: 8, primary: 2, reactions: 2, turns: 40, history: 8, contextChars: 12000, input: 4000,
  bubbles: 6, bubbleChars: 2000, replyChars: 6000 });
const statuses = ['pending', 'ready', 'failed', 'cancelled', 'interrupted'];
const validId = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const clone = (value) => structuredClone(value);
const fail = (reason) => { throw new Error(reason); };
const failures = new Set(['format', 'too-long', 'length', 'timeout', 'unavailable', 'auth', 'rate-limit',
  'network', 'model', 'incomplete', 'source-changed', 'persona-changed', 'memory-changed', 'member-removed', 'save']);
const failureCode = value => failures.has(value) ? value : null;

// Provider text is separate from the canonical persisted messages protocol.
// A structured-looking reply must parse completely; it never falls back to text.
export function chatResponseBody(wire, partial = false) {
  if (typeof wire !== 'string' || wire.length > 24000 || /<\/?(?:think|thinking|analysis|reasoning)(?:\s|>)/i.test(wire)) return;
  let body = wire.trimStart();
  if (body.startsWith('```')) {
    const opening = /^```(?:json)?[\t ]*\r?\n/i.exec(body);
    if (!opening) return;
    body = body.slice(opening[0].length);
    const closing = /\r?\n```\s*$/.exec(body);
    if (closing) body = body.slice(0, closing.index);
    else if (!partial) return;
    if (!body.trimStart().startsWith('{')) return;
    return { kind: 'json', body };
  }
  if (!body || /^[\["`<]/.test(body)) return;
  if (!body.startsWith('{') && /\{\s*"messages"\s*:/.test(body)) return;
  return { kind: body.startsWith('{') ? 'json' : 'text', body };
}

export function plainChatMessages(body) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) return;
  const messages = body.trim().split(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/).map(line => line.trim()).filter(Boolean);
  return parseChatReply(JSON.stringify({ messages }));
}

export function parseChatResponse(wire) {
  const value = chatResponseBody(wire);
  return value?.kind === 'json' ? parseChatReply(value.body) : value ? plainChatMessages(value.body) : undefined;
}

/** Only stable categories cross into storage/UI; provider messages may contain private data. */
export function chatFailure(error, signal) {
  const reason = signal?.aborted ? signal.reason : error;
  const own = { 'chat-format': 'format', 'chat-too-long': 'too-long', 'chat-length': 'length',
    'chat-timeout': 'timeout', 'chat-unavailable': 'unavailable', 'chat-incomplete': 'incomplete',
    'chat-context-changed': 'source-changed', 'persona-changed': 'persona-changed', 'memory-changed': 'memory-changed',
    'chat-member-removed':'member-removed',
    'chat-save-failed': 'save' }[reason?.message];
  if (own) return own;
  if ([401, 403].includes(reason?.status)) return 'auth';
  if (reason?.status === 429) return 'rate-limit';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'NETWORK_ERROR', 'FETCH_ERROR'].includes(reason?.code)) return 'network';
  return 'model';
}
export function parseChatReply(wire) {
  try {
    const value = JSON.parse(wire);
    if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.messages)
      || value.messages.length < 1 || value.messages.length > CHAT_LIMITS.bubbles
      || !value.messages.every((item) => text(item, CHAT_LIMITS.bubbleChars))
      || value.messages.reduce((sum, item) => sum + item.length, 0) > CHAT_LIMITS.replyChars) return;
    return value.messages;
  } catch { return; }
}

/** Separate, bounded chat history. Every owner action commits durably before becoming visible. */
export function createPersonaChat({ persist = async () => {}, now = Date.now } = {}) {
  const empty = () => ({ version: 3, epoch: 0, activeRoomId: null, rooms: [] });
  let state = empty();
  let writes = Promise.resolve();
  const serial = (fn) => { const task = writes.catch(() => {}).then(fn); writes = task.catch(() => {}); return task; };
  const roomFor = key => typeof key === 'string' ? state.rooms.find(r => r.id === key || r.legacyPersonaId === key) : undefined;
  const read = key => clone(roomFor(key) ?? null);
  // The directory epoch protects requests without a room. An existing room accepts
  // snapshots issued since its own last clear, regardless of unrelated room changes.
  const acceptsEpoch = (room, epoch) => Number.isSafeInteger(epoch) && epoch <= state.epoch
    && epoch >= (room?.generation ?? state.epoch);
  const membersValid = values => Array.isArray(values) && values.length > 0 && values.length <= CHAT_LIMITS.members
    && values.every(validId) && new Set(values).size === values.length;
  const targetsValid = (values, members) => membersValid(values) && values.every(id=>members.includes(id));
  const checkPrimaryLimit = values => {
    if (Array.isArray(values) && values.length > CHAT_LIMITS.primary) fail('chat-primary-limit');
  };
  const recipientsValid = values => Array.isArray(values) && membersValid(values.map(p=>p?.id)) && values.every(p=>text(p.name,80));
  const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
  const trimTurns = turns => { const ids=[...new Set(turns.map(t=>t.messageId))].slice(-CHAT_LIMITS.turns);return turns.filter(t=>ids.includes(t.messageId)); };
  const checked = ({ roomId, revision, epoch = 0 }) => {
    const room = read(roomId);
    if (!room) fail('chat-room-not-found');
    if (!acceptsEpoch(room, epoch) || revision !== room.revision) fail('chat-conflict');
    return room;
  };
  const replace = room => { const next = clone(state); next.rooms = next.rooms.map(r => r.id === room.id ? room : r); return next; };
  const commit = async (next, valid = () => true) => {
    if (!valid()) return false;
    await persist(clone(next));
    if (!valid()) { await persist(clone(state)); return false; }
    state = next; return true;
  };
  return {
    read, snapshot: () => clone(state), drain: () => writes,
    epoch: () => state.epoch,
    acceptsEpoch: (roomId, epoch) => acceptsEpoch(roomFor(roomId), epoch),
    active: () => state.activeRoomId,
    liveGroup: (roomId,messageId) => {const room=state.rooms.find(r=>r.id===roomId);return room?.turns.at(-1)?.messageId===messageId
      ?room.turns.filter(t=>t.messageId===messageId).map(t=>({id:t.id,attemptId:t.attemptId})):null;},
    hasMember: (roomId,personaId) => state.rooms.some(r=>r.id===roomId&&r.memberIds.includes(personaId)),
    list: () => state.rooms.map(r => ({ id:r.id,name:r.name,memberIds:[...r.memberIds],targetPersonaId:r.targetPersonaId,targetPersonaIds:[...r.targetPersonaIds],
      revision:r.revision,at:r.turns.at(-1)?.at ?? r.createdAt,turnCount:new Set(r.turns.map(t=>t.messageId)).size })).sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)),
    contacts: () => [...new Map(state.rooms.flatMap(r => r.turns.map(t => [t.recipientId,
      { personaId:t.recipientId,name:t.speakerName }]))).values()],
    restore(raw) {
      state = empty();
      // Unreleased development formats intentionally have no migration path.
      if (raw?.version !== 3 || !Array.isArray(raw.rooms)) return;
      if (Number.isSafeInteger(raw.epoch) && raw.epoch >= 0) state.epoch = raw.epoch;
      for (const room of raw.rooms.slice(-CHAT_LIMITS.rooms)) {
        if (!validId(room?.id) || !membersValid(room.memberIds) || !targetsValid(room.targetPersonaIds,room.memberIds)
          || room.targetPersonaId!==room.targetPersonaIds[0]
          || !text(room.name, 60) || state.rooms.some(r => r.id === room.id)
          || !Number.isSafeInteger(room.revision) || room.revision < 0 || !Array.isArray(room.turns)) continue;
        const turns = [], witnessed = new Map();
        for (const turn of room.turns.slice(-CHAT_LIMITS.turns*CHAT_LIMITS.members)) {
          if (!validId(turn?.id) || !validId(turn.attemptId) || !validId(turn.recipientId) || turns.some((t) => t.id === turn.id)
            || !validId(turn.messageId) || !recipientsValid(turn.recipients) || (turn.phase!=='reaction'&&!turn.recipients.some(p=>p.id===turn.recipientId))
            || !text(turn.user, CHAT_LIMITS.input) || !statuses.includes(turn.status)
            || !Number.isSafeInteger(turn.at) || turn.at < 0 || !text(turn.speakerName, 80)
            || !Array.isArray(turn.assistant) || (turn.status === 'ready' && !parseChatReply(JSON.stringify({ messages: turn.assistant })))) continue;
          const ids = turn.recipients.map(p => p.id);
          if (turn.memberIdsAtSend !== undefined && (!membersValid(turn.memberIdsAtSend)
            || ![...ids, turn.recipientId].every(id => turn.memberIdsAtSend.includes(id)))) continue;
          if (!turn.memberIdsAtSend) {
            const known = witnessed.get(turn.messageId) ?? new Set();
            for (const id of [...ids, turn.recipientId]) known.add(id);
            witnessed.set(turn.messageId, known);
          }
          turns.push({ id: turn.id, messageId:turn.messageId,recipients:clone(turn.recipients),memberIdsAtSend:turn.memberIdsAtSend?.slice(),attemptId: turn.attemptId, recipientId:turn.recipientId, user: turn.user, at: turn.at,
            phase:turn.phase==='reaction'?'reaction':'primary',reactionPlanId:validId(turn.reactionPlanId)?turn.reactionPlanId:null,
            speakerName: turn.speakerName, assistant: turn.status === 'ready' ? [...turn.assistant] : [],
            status: turn.status === 'pending' ? 'interrupted' : turn.status,
            completedAt: Number.isSafeInteger(turn.completedAt) && turn.completedAt >= turn.at ? turn.completedAt : null,
            contextKey: validId(turn.contextKey) ? turn.contextKey : null,
            scopeKey:validId(turn.scopeKey)?turn.scopeKey:validId(turn.contextKey)?turn.contextKey:null,
            failure: turn.status === 'ready' ? null : failureCode(turn.failure) });
        }
        // Without a saved roster only the original addressees and actual speakers
        // are known. Today's room members are never evidence about an old message.
        for (const turn of turns) turn.memberIdsAtSend ??= [...witnessed.get(turn.messageId)].slice(0, CHAT_LIMITS.members);
        const sources = Array.isArray(room.sources) && room.sources.length <= 6 && room.sources.every(validId)
          && new Set(room.sources).size === room.sources.length ? [...room.sources] : null;
        // Only the next send's selection is capped. Keep historical addressees and authors intact.
        state.rooms.push({ id:room.id,name:room.name,memberIds:[...room.memberIds],targetPersonaId:room.targetPersonaId,targetPersonaIds:room.targetPersonaIds.slice(0,CHAT_LIMITS.primary),
          revision:room.revision,configRevision:Number.isSafeInteger(room.configRevision)?room.configRevision:0,createdAt:Number.isSafeInteger(room.createdAt)?room.createdAt:0,turns:trimTurns(turns),sources,
          primarySessionId:sources?.includes(room.primarySessionId)?room.primarySessionId:null,
          generation:Number.isSafeInteger(room.generation)&&room.generation>=0&&room.generation<=state.epoch?room.generation:state.epoch,
          sourceVersion:Number.isSafeInteger(room.sourceVersion)&&room.sourceVersion>=0?room.sourceVersion:0,
          createRequestId:validId(room.createRequestId)?room.createRequestId:null,
          createFingerprint:typeof room.createFingerprint==='string'?room.createFingerprint:null,
          ...(validId(room.legacyPersonaId)?{legacyPersonaId:room.legacyPersonaId,personaId:room.legacyPersonaId}:{}) });
      }
      state.activeRoomId=state.rooms.some(r=>r.id===raw.activeRoomId)?raw.activeRoomId:state.rooms[0]?.id??null;
    },
    create({requestId,name,memberIds,targetPersonaId,targetPersonaIds=targetPersonaId?[targetPersonaId]:[],epoch=state.epoch}, { onlyIfEmpty = false } = {}) {
      return serial(async()=>{
        // Recheck inside the write queue: a delete may have been saving when this request arrived.
        if(epoch!==state.epoch)fail('chat-conflict');
        // The empty GET that a viewer saw may predate another viewer's first
        // creation. Resolve against the committed directory inside the same queue.
        if(onlyIfEmpty && state.rooms.length) return read(state.activeRoomId) ?? clone(state.rooms[0]);
        checkPrimaryLimit(targetPersonaIds);
        if(!validId(requestId)||!text(name,60)||!membersValid(memberIds)||!targetsValid(targetPersonaIds,memberIds))fail('invalid-chat-room');
        const fingerprint=createHash('sha256').update(JSON.stringify({name,memberIds,targetPersonaIds})).digest('hex');
        const existing=state.rooms.find(r=>r.createRequestId===requestId);
        if(existing){if(existing.createFingerprint!==fingerprint)fail('chat-id-conflict');return clone(existing);}
        if(state.rooms.length>=CHAT_LIMITS.rooms)fail('chat-capacity');
        const room={id:'room:'+randomUUID(),name,memberIds:[...memberIds],targetPersonaIds:[...targetPersonaIds],targetPersonaId:targetPersonaIds[0],revision:0,configRevision:0,createdAt:now(),turns:[],
          sources:null,primarySessionId:null,sourceVersion:0,generation:state.epoch,createRequestId:requestId,createFingerprint:fingerprint};
        const next=clone(state);next.rooms.push(room);next.activeRoomId=room.id;await commit(next);return clone(room);
      });
    },
    select({roomId}) { return serial(async()=>{if(!read(roomId))fail('chat-room-not-found');if(state.activeRoomId===roomId)return;
      const next=clone(state);next.activeRoomId=roomId;await commit(next);}); },
    update(body) { return serial(async()=>{
      const room=body.configRevision===undefined?checked(body):read(body.roomId);
      if(!room)fail('chat-room-not-found');
      if(body.configRevision!==undefined&&(!acceptsEpoch(room,body.epoch)||body.configRevision!==room.configRevision))fail('chat-conflict');
      if(body.name!==undefined){if(!text(body.name,60))fail('invalid-chat-room');room.name=body.name;}
      if(body.memberIds!==undefined){if(!membersValid(body.memberIds))fail('invalid-chat-members');room.memberIds=[...body.memberIds];}
      const targets=body.targetPersonaIds??(body.targetPersonaId!==undefined?[body.targetPersonaId]:undefined);
      checkPrimaryLimit(targets);
      if(targets!==undefined){if(!targetsValid(targets,room.memberIds))fail('chat-recipient-not-member');room.targetPersonaIds=[...targets];}
      else room.targetPersonaIds=room.targetPersonaIds.filter(id=>room.memberIds.includes(id));
      if(!room.targetPersonaIds.length)room.targetPersonaIds=[room.memberIds[0]];
      room.targetPersonaId=room.targetPersonaIds[0];
      room.revision++;room.configRevision=(room.configRevision??0)+1;await commit(replace(room));return clone(room);
    }); },
    sources({roomId,sessionIds,primarySessionId}) { return serial(async()=>{
      const room=read(roomId);if(!room)fail('chat-room-not-found');
      if(!Array.isArray(sessionIds)||sessionIds.length>6||!sessionIds.every(validId)||new Set(sessionIds).size!==sessionIds.length
        ||(primarySessionId!==null&&!sessionIds.includes(primarySessionId)))fail('invalid-chat-sources');
      // Source selection is protected by its own context revision, independently of message acknowledgements.
      if(JSON.stringify(room.sources)===JSON.stringify(sessionIds)&&room.primarySessionId===primarySessionId)return;
      room.sources=[...sessionIds];room.primarySessionId=primarySessionId;room.sourceVersion=(room.sourceVersion??0)+1;await commit(replace(room));
    }); },
    remove(body) { return serial(async()=>{
      const room=checked(body),next=clone(state);next.rooms=next.rooms.filter(r=>r.id!==room.id);next.epoch++;
      if(next.activeRoomId===room.id)next.activeRoomId=next.rooms[0]?.id??null;
      await commit(next);return true;
    }); },
    send({ roomId, personaId, name, recipients=[{id:personaId,name}],requestId, content, revision, epoch = 0, allowOrphan = false, contextKey = null, scopeKey=contextKey }) {
      return serial(async () => {
        checkPrimaryLimit(recipients);
        if (!validId(personaId) || !validId(requestId) || !text(name, 80) || !text(content, CHAT_LIMITS.input)) fail('invalid-chat-message');
        if(!recipientsValid(recipients)||recipients[0].id!==personaId)fail('invalid-chat-message');
        if (contextKey !== null && !validId(contextKey)) fail('invalid-chat-message');
        if (scopeKey !== null && !validId(scopeKey)) fail('invalid-chat-message');
        const current = read(roomId??personaId);
        if(roomId&&!current)fail('chat-room-not-found');
        if (!acceptsEpoch(current,epoch)) fail('chat-conflict');
        const existing = current?.turns.find((t) => t.id === requestId);
        if (existing) {
          if (existing.user !== content || !same(existing.recipients.map(p=>p.id),recipients.map(p=>p.id)) || (existing.scopeKey??existing.contextKey??null)!==scopeKey) fail('chat-id-conflict');
          return { room: current, turn: existing, turns:current.turns.filter(t=>t.messageId===requestId),created: false };
        }
        const memberIdsAtSend = current?.memberIds ?? [personaId];
        if(recipients.some(p=>!memberIdsAtSend.includes(p.id)))fail('chat-recipient-not-member');
        if(roomId&&!same(current.targetPersonaIds,recipients.map(p=>p.id)))fail('chat-conflict');
        if (revision !== (current?.revision ?? 0)) fail('chat-conflict');
        if (current?.turns.some((t) => t.status === 'pending') && !allowOrphan) fail('chat-busy');
        if (!current && state.rooms.length >= CHAT_LIMITS.rooms) fail('chat-capacity');
        const next = clone(state);
        // Persona-only direct requests share the same room engine; explicit room IDs are authoritative.
        const room = current ?? { id:'chat:'+randomUUID(),legacyPersonaId:personaId,personaId,name:'与'+name+'的聊天',
          memberIds:[personaId],targetPersonaIds:[personaId],targetPersonaId:personaId,revision:0,configRevision:0,createdAt:now(),turns:[],sources:null,primarySessionId:null,sourceVersion:0,generation:state.epoch };
        for (const turn of room.turns) if (turn.status === 'pending') turn.status = 'interrupted';
        const at=now(),turns=recipients.map((person,index)=>{const id=index?'reply:'+randomUUID():requestId;return {
          id,messageId:requestId,recipients:clone(recipients),memberIdsAtSend:[...memberIdsAtSend],attemptId:id,recipientId:person.id,user:content,assistant:[],status:'pending',
          phase:'primary',reactionPlanId:null,
          at,completedAt:null,speakerName:person.name,contextKey,scopeKey,failure:null};});
        room.turns.push(...turns); room.turns = trimTurns(room.turns); room.revision += 1;
        next.rooms = next.rooms.filter((r) => r.id !== room.id); next.rooms.push(room);next.activeRoomId??=room.id;
        await commit(next); return { room: clone(room), turn: clone(turns[0]),turns:clone(turns),created: true };
      });
    },
    appendReactions({roomId,messageId,planId,primaryAttempts,recipients,epoch=0,contextKey=null,scopeKey=contextKey,valid}) {return serial(async()=>{
      const room=read(roomId),group=room?.turns.filter(t=>t.messageId===messageId),primary=group?.filter(t=>t.phase!=='reaction');
      if(!room||room.turns.at(-1)?.messageId!==messageId)fail('chat-conflict');
      if(!acceptsEpoch(room,epoch)||!validId(planId)||!Array.isArray(primaryAttempts)||!primary?.length)fail('chat-conflict');
      if(!same(primary.map(t=>({id:t.id,attemptId:t.attemptId})),primaryAttempts)||primary.some(t=>t.status==='pending')
        ||!primary.some(t=>t.status==='ready')||primary.some(t=>(t.scopeKey??t.contextKey??null)!==scopeKey))fail('chat-conflict');
      if(primary[0].reactionPlanId){if(primary[0].reactionPlanId!==planId)fail('chat-conflict');return{room,turns:group.filter(t=>t.phase==='reaction'),created:false};}
      if(!Array.isArray(recipients)||recipients.length>CHAT_LIMITS.reactions
        ||(recipients.length&&!recipientsValid(recipients))||recipients.some(p=>!room.memberIds.includes(p.id)
          ||!primary[0].memberIdsAtSend.includes(p.id)||primary[0].recipients.some(v=>v.id===p.id)))fail('chat-recipient-not-member');
      const at=now(),turns=recipients.map(person=>{const id='reaction:'+randomUUID();return{id,messageId,recipients:clone(primary[0].recipients),memberIdsAtSend:[...primary[0].memberIdsAtSend],attemptId:id,
        recipientId:person.id,speakerName:person.name,phase:'reaction',reactionPlanId:null,user:primary[0].user,at,assistant:[],status:'pending',
        completedAt:null,contextKey,scopeKey,failure:null};});
      primary[0].reactionPlanId=planId;room.turns.push(...turns);room.revision++;
      if(!await commit(replace(room),valid))return{room:read(roomId),turns:[],created:false};
      return{room:clone(room),turns:clone(turns),created:true};
    });},
    retry({ roomId, personaId, id, attemptId, revision, name, epoch = 0, allowOrphan = false, contextKey = null, scopeKey=contextKey, previousContextKey }) {
      return serial(async () => {
        if (!validId(attemptId) || !text(name, 80)) fail('invalid-chat-message');
        const room = read(roomId??personaId), turn = room?.turns.find(t=>t.id===id);
        if (!turn || turn.messageId !== room.turns.at(-1)?.messageId) fail('chat-retry-unavailable');
        if (turn.recipients.length > CHAT_LIMITS.primary) fail('chat-legacy-mentions');
        if(turn.recipientId!==personaId||!room.memberIds.includes(personaId))fail('chat-recipient-not-member');
        if (contextKey !== null && !validId(contextKey)) fail('invalid-chat-message');
        if(scopeKey!==null&&!validId(scopeKey))fail('invalid-chat-message');
        if ((turn.contextKey??null)!==contextKey && !(scopeKey&&turn.scopeKey===scopeKey) && previousContextKey !== (turn.contextKey??null)) fail('chat-context-changed');
        if (!acceptsEpoch(room,epoch)) fail('chat-conflict');
        if (turn.attemptId === attemptId) return { room, turn, created: false };
        if (room.revision !== revision) fail('chat-conflict');
        if(!allowOrphan&&room.turns.some(t=>t.status==='pending'))fail('chat-busy');
        if (turn.status === 'ready' || (turn.status === 'pending' && !allowOrphan)) fail('chat-busy');
        if(turn.phase!=='reaction')room.turns=room.turns.filter(t=>t.messageId!==turn.messageId||t.phase!=='reaction');
        const retryTurns=room.turns.slice(room.turns.indexOf(turn)).filter(t=>t.messageId===turn.messageId);
        for(const item of retryTurns)Object.assign(item,{attemptId:item.id===id?attemptId:'retry:'+randomUUID(),status:'pending',assistant:[],completedAt:null,
          ...(item.id===id?{speakerName:name}:{}),contextKey,scopeKey,failure:null,reactionPlanId:null});
        if(turn.phase!=='reaction')room.turns.find(t=>t.messageId===turn.messageId).reactionPlanId=null;
        room.revision += 1;
        const next = replace(room);
        await commit(next); return { room: clone(room), turn: clone(turn),turns:clone(retryTurns), created: true };
      });
    },
    finish({ personaId, roomId, id, attemptId, status, messages = [], failure = null, valid }) {
      return serial(async () => {
        const room = read(roomId??personaId), turn = room?.turns.find((t) => t.id === id);
        if (!room || room.id !== roomId || !turn || turn.attemptId !== attemptId || turn.status !== 'pending') return false;
        if (!['ready', 'failed', 'cancelled'].includes(status)
          || (status === 'ready' && !parseChatReply(JSON.stringify({ messages })))) fail('invalid-chat-reply');
        Object.assign(turn, { status, assistant: status === 'ready' ? [...messages] : [],
          failure: status === 'ready' ? null : failureCode(failure), completedAt: Math.max(turn.at, now()) });
        room.revision += 1;
        const next = replace(room);
        return await commit(next, valid);
      });
    },
    cancel({ roomId, personaId, id, attemptId,messageId,attempts, epoch = 0 }) {
      return serial(async () => {
        const room = read(roomId??personaId), turn = room?.turns.find((t) => t.id === id);
        if (!acceptsEpoch(room,epoch)) fail('chat-conflict');
        if(attempts!==undefined&&(!validId(messageId)||!Array.isArray(attempts)||!attempts.length||attempts.length>CHAT_LIMITS.members
          ||attempts.some(p=>!validId(p?.id)||!validId(p?.attemptId))||new Set(attempts.map(p=>p.id)).size!==attempts.length))fail('invalid-chat-message');
        if (!turn || turn.attemptId !== attemptId || (!attempts&&turn.status !== 'pending')) return false;
        if(messageId!==undefined&&turn.messageId!==messageId)fail('chat-conflict');
        let changed=false;
        for(const item of room.turns)if(item.status==='pending'&&(messageId?item.messageId===messageId:item.id===id)){
          if(attempts&&!attempts.some(p=>p.id===item.id&&p.attemptId===item.attemptId))continue;
          item.status='cancelled';item.completedAt=Math.max(item.at,now());changed=true;}
        if(!changed)return false;
        room.revision += 1;
        const next = replace(room);
        await commit(next); return true;
      });
    },
    clear({ roomId, personaId, revision, epoch = 0 }) {
      return serial(async () => {
        const room = read(roomId??personaId);
        if (!acceptsEpoch(room,epoch)) fail('chat-conflict');
        if (!room) return false;
        if (revision !== room.revision) fail('chat-conflict');
        const next = clone(state);
        if(roomId){room.turns=[];room.revision++;room.generation=state.epoch+1;next.rooms=next.rooms.map(r=>r.id===room.id?room:r);}
        else next.rooms = next.rooms.filter(r=>r.id!==room.id);
        if(!next.rooms.some(r=>r.id===next.activeRoomId))next.activeRoomId=next.rooms[0]?.id??null;
        next.epoch += 1;
        await commit(next); return true;
      });
    },
  };
}
