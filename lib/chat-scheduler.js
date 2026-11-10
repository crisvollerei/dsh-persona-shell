const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
const instant = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const pair = (roomId, personaId) => JSON.stringify([roomId, personaId]);
const scopeValue = value => record(value) && Number.isSafeInteger(value.generation) && value.generation >= 0
  && (value.sourceScope === null || (typeof value.sourceScope === 'string' && value.sourceScope.length <= 4000))
  ? { generation: value.generation, sourceScope: value.sourceScope } : null;
const sameScope = (a, b) => a.generation === b.generation && a.sourceScope === b.sourceScope;

/** Canonical public-timeline reference. A key contains no message body or memory. */
export function chatSchedulerEventKey({ roomId, generation, sourceScope, turnId, attemptId = null, index = null } = {}) {
  const scope = scopeValue({ generation, sourceScope });
  if (!id(roomId) || !scope || !id(turnId) || (attemptId !== null && !id(attemptId))
    || (index !== null && (!Number.isSafeInteger(index) || index < 0 || index > 7))) return null;
  return JSON.stringify({ roomId, ...scope, turnId, attemptId, index });
}

function eventScope(key, roomId) {
  try {
    if (typeof key !== 'string' || key.length > 8192) return null;
    const value = JSON.parse(key);
    if (!record(value) || value.roomId !== roomId || chatSchedulerEventKey(value) !== key) return null;
    return scopeValue(value);
  } catch { return null; }
}

/** A directed reply is a reference to an earlier real public message, not just a name. */
export function chatReplyTarget(event, precedingEvents = []) {
  const author = value => value?.author?.role === 'user' ? 'user' : value?.author?.role === 'assistant' ? value.author.id : value?.authorId;
  const value = event?.replyTo, from = author(event);
  if (typeof event?.id !== 'string' || !event.id || event.id.length > 8192 || !id(from) || from === 'user' || !record(value) || Object.keys(value).length !== 3
    || !['to','eventId','index'].every(key => Object.hasOwn(value,key)) || !id(value.to) || value.to === from
    || typeof value.eventId !== 'string' || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 7) return null;
  const supplied = Array.isArray(precedingEvents) ? precedingEvents : [], ownIndex=supplied.findIndex(item=>item?.id===event.id);
  const previous=ownIndex<0?supplied:supplied.slice(0,ownIndex);
  const source = previous.find(item => item?.id === value.eventId);
  const count = Array.isArray(source?.messages) ? source.messages.length : source?.messageCount;
  if (!source || source.id === event.id || author(source) !== value.to || !Number.isInteger(count) || count < 1 || count > 8 || value.index >= count) return null;
  // Canonical production refs also carry room/generation/source authority. Opaque
  // local fixture IDs may be used together, but never mixed with canonical refs.
  const namespace = key => {
    try { const parsed=JSON.parse(key);return record(parsed)&&chatSchedulerEventKey(parsed)===key?{roomId:parsed.roomId,...scopeValue(parsed)}:null; }
    catch { return null; }
  };
  const ownScope=namespace(event.id),sourceScope=namespace(source.id);
  if (!!ownScope !== !!sourceScope || ownScope && (ownScope.roomId !== sourceScope.roomId || !sameScope(ownScope,sourceScope))) return null;
  return value.to;
}

/** Per-persona user-cycle opportunities and inboxes. No timers or models run here. */
export function createChatScheduler({ now = Date.now, intervalMs = 5000 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error('invalid-chat-scheduler');
  const rooms = new Map(), cooldowns = new Map(), holds = new Map(); let nextToken = 0;
  const clock = () => { const value = now(); if (!instant(value)) throw new Error('invalid-chat-scheduler-time'); return value; };
  const stateOf = (roomId, personaId) => rooms.get(roomId)?.members.get(personaId);
  const fresh = (roomId, personaId) => ({ nextEligibleAt: cooldowns.get(pair(roomId, personaId)) ?? 0,
    userTurnId:null, cycle:0, level:3, peerUsed:false, peerGrant:null, failureCount:0, usedAttempts:new Set(),requiresExternal:false,responded:false,
    cursor: null, seen: new Map(), pending: [] });
  const active = (room,state) => !!room&&!!state&&state.userTurnId!==null&&state.userTurnId===room.userTurnId&&state.cycle===room.cycle;
  const kindValid = kind => kind==='normal'||kind==='peer';
  const normalPending = (room,state,personaId) => {
    if(!active(room,state))return[];
    const timeline=[...room.events.values()];
    return state.pending.filter(event=>room.eventCycles.get(event.id)===room.cycle
      &&(event.authorId==='user'?!state.responded&&!state.requiresExternal:
        room.eventCycles.get(event.replyTo?.eventId)===room.cycle&&chatReplyTarget(event,timeline)===personaId)).map(event=>event.id);
  };
  const available = (room,state,kind,personaId) => active(room,state)&&kindValid(kind)&&(!state.requiresExternal
    ||(kind==='normal'?normalPending(room,state,personaId).length>0:state.pending.some(event=>event.id===state.peerGrant?.sourceEventId)))
    &&(kind==='normal'?state.level<3:!state.peerUsed&&!!state.peerGrant);
  const due = (at,steps) => Math.min(Number.MAX_SAFE_INTEGER,at+intervalMs*steps);
  const synchronize = (roomId,personaId,state) => cooldowns.set(pair(roomId,personaId),state.nextEligibleAt);
  const initialLevel = (recipients,personaId) => recipients.length?recipients.indexOf(personaId)===0?0:recipients.includes(personaId)?1:2:0;
  const recipientsValid = recipients => Array.isArray(recipients)&&recipients.length<=8&&recipients.every(id)&&new Set(recipients).size===recipients.length;
  const initialize = (roomId,room,userTurnId,recipients,at) => {
    room.userTurnId=userTurnId;room.recipients=[...recipients];room.userTurns.add(userTurnId);room.cycle++;room.completions.clear();
    for(const [eventId,owner]of room.eventUserTurns)if(owner===userTurnId)room.eventCycles.set(eventId,room.cycle);
    for(const [personaId,state]of room.members){
      state.userTurnId=userTurnId;state.cycle=room.cycle;state.level=initialLevel(recipients,personaId);
      state.nextEligibleAt=due(at,state.level);state.peerUsed=false;state.peerGrant=null;state.failureCount=0;state.usedAttempts.clear();state.requiresExternal=false;state.responded=false;synchronize(roomId,personaId,state);
      // Input can be durably published before the old in-flight package ends.
      // Re-admit only this new anchor's refs if that older claim saw/drained them.
      const pendingIds=new Set(state.pending.map(event=>event.id));
      for(const [eventId,owner]of room.eventUserTurns){
        const event=room.events.get(eventId);
        if(owner!==userTurnId||!event||event.authorId===personaId)continue;
        state.seen.set(eventId,event);if(!pendingIds.has(eventId)){state.pending.push(event);pendingIds.add(eventId);}
      }
    }
  };
  const success = (roomId,personaId,state,kind,at) => {
    state.responded=true;
    if(kind==='normal'){state.level=Math.min(3,state.level+1);state.nextEligibleAt=Math.max(state.nextEligibleAt,due(at,state.level===2?2:1));}
    else{state.peerUsed=true;state.nextEligibleAt=Math.max(state.nextEligibleAt,due(at,state.level===2?2:1));}
    state.failureCount=0;synchronize(roomId,personaId,state);
  };
  const release = (roomId, personaId, token, outcome, options={}) => {
    const key=pair(roomId,personaId),held=holds.get(key);if(!held||held.flight.token!==token)return false;
    if(!record(options)||Object.keys(options).some(key=>!['responseId','completedAt'].includes(key))
      ||(options.responseId!==undefined&&!id(options.responseId))||(options.completedAt!==undefined&&!instant(options.completedAt)))return false;
    const room=rooms.get(roomId),state=stateOf(roomId,personaId),flight=held.flight;
    if(!active(room,state)||held.owner!==state||flight.invalidated||flight.cycle!==state.cycle||flight.scopeVersion!==room.scopeVersion){holds.delete(key);return false;}
    if(outcome==='abstain'){
      holds.delete(key);state.usedAttempts.add(flight.attemptId);state.requiresExternal=true;
      const grant=state.peerGrant;
      if(grant&&(grant.sourceEventId===flight.peerGrantAtClaim?.sourceEventId||flight.events.some(event=>event.id===grant.sourceEventId)))state.peerGrant=null;
      return true;
    }
    const at=options.completedAt??clock();
    holds.delete(key);
    if(outcome==='success'){
      const responseId=options.responseId??flight.attemptId,prior=room.completions.get(responseId);
      if(prior)return false;
      room.completions.set(responseId,{personaId,kind:flight.kind,completedAt:at});state.usedAttempts.add(flight.attemptId);
      success(roomId,personaId,state,flight.kind,at);
    }else{
      // A failed peer response did not spend its independent opportunity. Retire
      // only the invitation captured by that claim; exact retry may re-authorize
      // it, while a newer reviewed invitation must not remain blocked by it.
      if(flight.kind==='peer'&&state.peerGrant?.sourceEventId===flight.peerGrantAtClaim?.sourceEventId
        &&state.peerGrant?.fromId===flight.peerGrantAtClaim?.fromId)state.peerGrant=null;
      const pending=[...flight.events,...state.pending],seen=new Set();state.pending=pending.filter(event=>state.seen.has(event.id)&&!seen.has(event.id)&&seen.add(event.id));
      state.cursor=flight.previousCursor&&state.seen.has(flight.previousCursor)?flight.previousCursor:null;
      state.failureCount=Math.min(2,state.failureCount+1);state.nextEligibleAt=Math.max(state.nextEligibleAt,due(at,state.failureCount));synchronize(roomId,personaId,state);
    }
    return true;
  };
  const retire = (roomId, personaId, state) => {
    const held=holds.get(pair(roomId,personaId));if(held)held.flight.invalidated=true;
    synchronize(roomId,personaId,state);
  };
  const read = (roomId, personaId) => {
    const room=rooms.get(roomId),state = stateOf(roomId, personaId); if (!state) return null;
    const held=holds.get(pair(roomId,personaId)),enabled=active(room,state),at=clock();
    return { userTurnId:state.userTurnId,level:state.level,normalRemaining:enabled?3-state.level:0,peerRemaining:enabled&&!state.peerUsed?1:0,
      eligibleKinds:held||at<state.nextEligibleAt?[]:['normal','peer'].filter(kind=>available(room,state,kind,personaId)),failureCount:state.failureCount,requiresExternal:state.requiresExternal,
      normalPendingEventIds:normalPending(room,state,personaId),
      peerGrant:clone(state.peerGrant),nextEligibleAt: state.nextEligibleAt, inFlight: held?clone(held.flight):null, cursor: state.cursor,
      seen: [...state.seen.values()].map(clone), pending: clone(state.pending) };
  };
  const api = {
    register(roomId, personaIds, scope) {
      if (!id(roomId) || !Array.isArray(personaIds) || personaIds.length > 8 || !personaIds.every(id)
        || new Set(personaIds).size !== personaIds.length || (scope !== undefined && !scopeValue(scope))) throw new Error('invalid-chat-scheduler');
      let room = rooms.get(roomId);
      if (!room) { room = { scope: scope === undefined ? null : scopeValue(scope),scopeVersion:0,userTurnId:null,recipients:[],cycle:0,userTurns:new Set(),completions:new Map(),
        members: new Map(), events: new Map(),eventCycles:new Map(),eventUserTurns:new Map() }; rooms.set(roomId, room); }
      else if (scope !== undefined && (!room.scope || !sameScope(room.scope, scope))) {
        for (const [personaId, state] of room.members) {retire(roomId, personaId, state);state.seen.clear();state.pending=[];state.cursor=null;state.peerGrant=null;}
        room.events.clear();room.eventCycles.clear();room.eventUserTurns.clear();room.scopeVersion++; room.scope = scopeValue(scope);
      }
      for (const [personaId, state] of room.members) if (!personaIds.includes(personaId)) { retire(roomId, personaId, state); room.members.delete(personaId); }
      for (const personaId of personaIds) if (!room.members.has(personaId)) room.members.set(personaId, fresh(roomId, personaId));
      return personaIds.map(personaId => ({ personaId, ...read(roomId, personaId) }));
    },
    reset(roomId,userTurnId,recipientIds=[]){
      if(!id(roomId)||!id(userTurnId)||!recipientsValid(recipientIds))throw Error('invalid-chat-scheduler');
      const room=rooms.get(roomId);if(!room||room.userTurns.has(userTurnId))return false;
      initialize(roomId,room,userTurnId,recipientIds,clock());return true;
    },
    restoreCycle(roomId,value){
      const room=rooms.get(roomId);
      if(!room||!record(value)||Object.keys(value).some(key=>!['userTurnId','recipients','at','responses'].includes(key))
        ||!id(value.userTurnId)||!recipientsValid(value.recipients)||!instant(value.at)||!Array.isArray(value.responses)||value.responses.length>64
        ||(room.userTurnId!==null&&room.userTurnId!==value.userTurnId))return false;
      const responses=new Map();
      for(const response of value.responses){
        if(!record(response)||Object.keys(response).some(key=>!['id','personaId','kind','completedAt'].includes(key))
          ||!id(response.id)||!id(response.personaId)||!kindValid(response.kind)||!instant(response.completedAt)||response.completedAt<value.at)return false;
        const prior=responses.get(response.id)??room.completions.get(response.id);
        if(prior&&(prior.personaId!==response.personaId||prior.kind!==response.kind))return false;
        responses.set(response.id,{id:response.id,personaId:response.personaId,kind:response.kind,completedAt:response.completedAt});
      }
      if(room.userTurnId===null)initialize(roomId,room,value.userTurnId,value.recipients,value.at);
      for(const response of [...responses.values()].sort((a,b)=>a.completedAt-b.completedAt)){
        if(room.completions.has(response.id))continue;
        room.completions.set(response.id,{personaId:response.personaId,kind:response.kind,completedAt:response.completedAt});
        const state=room.members.get(response.personaId);if(!active(room,state))continue;
        state.usedAttempts.add(response.id);success(roomId,response.personaId,state,response.kind,response.completedAt);
      }
      return true;
    },
    publish(roomId, event) {
      const room = rooms.get(roomId), scope = eventScope(event?.id, roomId);
      if (!room || !scope || !record(event) || Object.keys(event).some(key => !['id', 'authorId','userTurnId','messageCount','replyTo'].includes(key))
        ||(event.userTurnId!==undefined&&!id(event.userTurnId))
        ||(event.messageCount!==undefined&&(!Number.isSafeInteger(event.messageCount)||event.messageCount<1||event.messageCount>8))
        || (event.authorId !== 'user' && !room.members.has(event.authorId)) || (room.scope && !sameScope(room.scope, scope))) return false;
      const existing=room.events.get(event.id);
      if(existing){
        // A buffered first part can later become the same anchor's complete
        // multi-part user event. Enrich its count only, never replay its inbox or
        // change an author, cycle owner, source pointer or already captured call.
        if(existing.authorId==='user'&&event.authorId==='user'&&event.userTurnId!==undefined
          &&room.eventUserTurns.get(event.id)===event.userTurnId&&event.messageCount>(existing.messageCount??0))existing.messageCount=event.messageCount;
        return false;
      }
      if (!room.scope) room.scope = scope;
      const publicEvent = { id: event.id, authorId: event.authorId,
        ...(event.messageCount!==undefined?{messageCount:event.messageCount}:{}) };
      if(chatReplyTarget(event,[...room.events.values()])!==null)publicEvent.replyTo=clone(event.replyTo);
      room.events.set(event.id, publicEvent);
      const held=holds.get(pair(roomId,event.authorId));
      if(event.userTurnId!==undefined)room.eventUserTurns.set(event.id,event.userTurnId);
      room.eventCycles.set(event.id,event.userTurnId===undefined?(held?.flight.cycle??room.cycle):event.userTurnId===room.userTurnId?room.cycle:null);
      for (const [personaId, state] of room.members) if (personaId !== event.authorId) {
        state.seen.set(event.id, publicEvent); state.pending.push(publicEvent);
      }
      return true;
    },
    grantPeer(roomId,personaId,value){
      const room=rooms.get(roomId),state=stateOf(roomId,personaId);
      if(!active(room,state)||state.peerUsed||state.peerGrant||!record(value)||Object.keys(value).some(key=>!['sourceEventId','fromId','evidence'].includes(key))
        ||!id(value.fromId)||value.fromId===personaId||!active(room,stateOf(roomId,value.fromId))
        ||(value.evidence!==undefined&&(typeof value.evidence!=='string'||!value.evidence.trim()||value.evidence.length>2000)))return false;
      const source=room.events.get(value.sourceEventId);
      if(!source||source.authorId!==value.fromId||room.eventCycles.get(value.sourceEventId)!==room.cycle
        ||state.requiresExternal&&!state.pending.some(event=>event.id===value.sourceEventId))return false;
      state.peerGrant={sourceEventId:value.sourceEventId,fromId:value.fromId};return true;
    },
    revokePeer(roomId,personaId,value){
      const room=rooms.get(roomId),state=stateOf(roomId,personaId);
      if(!active(room,state)||holds.has(pair(roomId,personaId))||!record(value)||Object.keys(value).length!==2
        ||!['sourceEventId','fromId'].every(key=>Object.hasOwn(value,key))||!id(value.fromId))return false;
      const grant=state.peerGrant,scope=eventScope(value.sourceEventId,roomId);
      if(!grant||grant.sourceEventId!==value.sourceEventId||grant.fromId!==value.fromId
        ||!scope||!room.scope||!sameScope(scope,room.scope))return false;
      // Preparation can fail before claim creates a token. Cleanup still binds
      // exactly that authorization, never a newer grant or an in-flight owner.
      state.peerGrant=null;return true;
    },
    claim(roomId, personaId, attemptId, kind='normal') {
      const room=rooms.get(roomId),state = stateOf(roomId, personaId); if (!available(room,state,kind,personaId)||!id(attemptId)||state.usedAttempts.has(attemptId)||holds.has(pair(roomId,personaId))) return null;
      const at = clock(); if (at < state.nextEligibleAt) return null;
      const token = JSON.stringify([roomId, personaId, attemptId,room.cycle,++nextToken]), events = clone(state.pending),previousCursor=state.cursor;
      state.pending = []; if (events.length) state.cursor = events.at(-1).id;
      holds.set(pair(roomId,personaId),{owner:state,flight:{token,attemptId,kind,userTurnId:state.userTurnId,cycle:state.cycle,scopeVersion:room.scopeVersion,claimedAt:at,events:clone(events),previousCursor,peerGrantAtClaim:clone(state.peerGrant)}});
      const normalRemainingAfterThis=3-state.level-(kind==='normal'?1:0),peerRemainingAfterThis=kind==='peer'?0:state.peerUsed?0:1;
      return { token,kind,userTurnId:state.userTurnId,level:state.level,events,cursor:state.cursor,
        remainingAfterThis:kind==='normal'?normalRemainingAfterThis:0,normalRemainingAfterThis,peerRemainingAfterThis };
    },
    finish(roomId, personaId, token, options={}) {
      if(!record(options)||Object.keys(options).some(key=>!['success','responseId','completedAt'].includes(key))||(options.success!==undefined&&typeof options.success!=='boolean'))return false;
      const {success:applied=true,...metadata}=options;return release(roomId,personaId,token,applied?'success':'failure',metadata);
    },
    fail(roomId, personaId, token) { return release(roomId,personaId,token,'failure'); },
    cancel(roomId, personaId, token) { return release(roomId,personaId,token,'failure'); },
    abstain(roomId, personaId, token) { return release(roomId,personaId,token,'abstain'); },
    readyAt(roomId, personaId,kind='normal') { const room=rooms.get(roomId),state = stateOf(roomId, personaId); return !available(room,state,kind,personaId)||holds.has(pair(roomId,personaId)) ? null : state.nextEligibleAt; },
    pending(roomId, personaId) { return clone(stateOf(roomId, personaId)?.pending ?? []); },
    read,
    retain(roomId, eventIds) {
      const room = rooms.get(roomId); if (!room || (!Array.isArray(eventIds) && !(eventIds instanceof Set))) return false;
      const ids = [...eventIds]; if (ids.some(key => !eventScope(key, roomId))) return false;
      const allowed = new Set(ids);
      for (const key of room.events.keys()) if (!allowed.has(key)){room.events.delete(key);room.eventCycles.delete(key);room.eventUserTurns.delete(key);}
      for (const state of room.members.values()) {
        for (const key of state.seen.keys()) if (!allowed.has(key)) state.seen.delete(key);
        state.pending = state.pending.filter(event => allowed.has(event.id));
        if (state.cursor && !allowed.has(state.cursor)) state.cursor = null;
        if(state.peerGrant&&!allowed.has(state.peerGrant.sourceEventId))state.peerGrant=null;
      }
      return true;
    },
    removeMember(roomId, personaId) {
      const room = rooms.get(roomId), state = room?.members.get(personaId); if (!state) return false;
      retire(roomId, personaId, state); room.members.delete(personaId); return true;
    },
    clearRoom(roomId) {
      const room = rooms.get(roomId); if (!room) return false;
      rooms.delete(roomId);
      for (const key of cooldowns.keys()) if (JSON.parse(key)[0] === roomId) cooldowns.delete(key);
      for (const key of holds.keys()) if (JSON.parse(key)[0] === roomId) holds.delete(key);
      return true;
    },
    drain: () => Promise.resolve(),
  };
  return api;
}
