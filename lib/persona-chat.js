import { randomUUID, createHash } from 'node:crypto';
import { quoteRef,quoteKey,resolveChatQuote,restoredChatQuote } from './chat-quote.js';
import { restoreDiscussion, changeDiscussion } from './chat-discussion.js';
import { normalizeDialoguePlan, normalizeContinuationPlan } from './chat-turn-plan.js';
import {buildChatSceneCatalog,acknowledgeChatScene,restoreChatScenes} from './chat-scene.js';
import {normalizeChatContribution} from './chat-contribution.js';

export const CHAT_LIMITS = Object.freeze({ rooms: 32, members: 8, primary: 8, reactions: 2, turns: 40, history: 8, contextChars: 12000, input: 4000,
  bubbles: 6, bubbleChars: 2000, replyChars: 6000, optionalBubbles: 5,
  roundReplies: 32, continuationBatches: 2, continuations: 4, speakerTurns: 3 });
export const primaryChatTurn = turn => !['anchor','reaction','followup'].includes(turn.phase);
const statuses = ['pending', 'ready', 'failed', 'cancelled', 'interrupted'];
const validId = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const clone = (value) => structuredClone(value);
const fail = (reason) => { throw new Error(reason); };
const failures = new Set(['format', 'too-long', 'length', 'timeout', 'unavailable', 'auth', 'rate-limit',
  'network', 'model', 'incomplete', 'source-changed', 'persona-changed', 'memory-changed', 'member-removed', 'save']);
const failureCode = value => failures.has(value) ? value : null;
const scopeOfTurn=turn=>turn.scopeKey??turn.contextKey??null;
const forgetScenes=room=>{for(const turn of room.turns){delete turn.scene;delete turn.sceneReferenceRevision;delete turn.sceneSourceVersion;}};
function chatUserParts(value, content, messageId) {
  if(!Array.isArray(value)||!value.length||value.length>8||value[0]?.id!==messageId
    ||value.some(part=>!validId(part?.id)||!text(part.text,CHAT_LIMITS.input)||!Number.isSafeInteger(part.at)||part.at<0)
    ||new Set(value.map(part=>part.id)).size!==value.length||value.map(part=>part.text).join('\n')!==content||content.length>CHAT_LIMITS.input)return null;
  return value.map(({id,text,at})=>({id,text,at}));
}

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

export function plainChatMessages(body,budget) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) return;
  const value=body.trim(),messages=[];
  const limit=Number.isInteger(budget?.bubbles)&&budget.bubbles>0&&budget.bubbles<=CHAT_LIMITS.bubbles?budget.bubbles:Infinity;
  // Blank lines in natural text are paragraphs, not explicit bubble IDs.
  // After the last available slot starts, keep appending its literal text.
  // Using the same boundary for every prefix keeps already displayed slots stable.
  let start=0;
  for(const boundary of value.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)){
    if(messages.length===limit-1)break;
    const paragraph=value.slice(start,boundary.index).trim();
    if(paragraph)messages.push(paragraph);
    start=boundary.index+boundary[0].length;
  }
  const rest=value.slice(start).trim();
  if(rest)messages.push(rest);
  return parseChatReply(JSON.stringify({ messages }));
}

export function parseChatResponse(wire,budget) {
  const value = chatResponseBody(wire);
  return value?.kind === 'json' ? parseChatReply(value.body) : value ? plainChatMessages(value.body,budget) : undefined;
}

/** Silence is an explicit decision, never an inference from an incomplete reply. */
export function parseChatDecision(wire,budget) {
  const value=chatResponseBody(wire);
  if(value?.kind==='json'){
    try{
      const parsed=JSON.parse(value.body),single=/^\s*\{\s*("(?:\\.|[^"\\])*")\s*:\s*\[\s*\]\s*\}\s*$/.exec(value.body);
      if(single&&JSON.parse(single[1])==='messages'&&Array.isArray(parsed.messages)&&parsed.messages.length===0)return{kind:'silent'};
    }catch{return;}
  }
  const messages=parseChatResponse(wire,budget);
  return messages?{kind:'reply',messages}:undefined;
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
  const targetsValid = (values, members) => Array.isArray(values) && values.length <= CHAT_LIMITS.members
    && values.every(validId) && new Set(values).size===values.length && values.every(id=>members.includes(id));
  const checkPrimaryLimit = values => {
    if (Array.isArray(values) && values.length > CHAT_LIMITS.primary) fail('chat-primary-limit');
  };
  const recipientsValid = values => Array.isArray(values) && values.length<=CHAT_LIMITS.members
    && values.every(p=>validId(p?.id)&&text(p.name,80)) && new Set(values.map(p=>p.id)).size===values.length;
  const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
  const attemptPrefix = (group, attempts) => Array.isArray(attempts) && attempts.length > 0 && attempts.length <= group.length
    && same(group.slice(0, attempts.length).map(t=>({id:t.id,attemptId:t.attemptId})),attempts);
  const speakerCounts = turns => {const counts=new Map();for(const turn of turns)counts.set(turn.recipientId,(counts.get(turn.recipientId)??0)+1);return counts;};
  const exchangeFor = turns => turns.filter(t=>t.status==='ready'&&t.phase!=='anchor'&&t.assistant.length).map(t=>({speaker:{id:t.recipientId,name:t.speakerName},messages:[...t.assistant]}));
  const directedPlan = (plan,actorId,group,scopeKey,roster,room) => {
    if(!plan||Array.isArray(plan)||!['normal','peer'].includes(plan.kind)||Object.keys(plan).some(key=>!['kind','to','evidence','sourceRef','contribution'].includes(key)))return null;
    const contribution=normalizeChatContribution(plan.contribution);
    if(plan.contribution!==undefined&&!contribution)return null;
    let sourceRef;
    if(plan.sourceRef!==undefined){
      const ref=quoteRef(plan.sourceRef);
      if(!ref||Object.keys(plan.sourceRef).length!==Object.keys(ref).length||!Object.keys(ref).every(key=>Object.hasOwn(plan.sourceRef,key)&&plan.sourceRef[key]===ref[key]))return null;
      const head=group[0],originalUser=plan.kind==='normal'&&plan.to==='user'&&ref.kind==='user';
      if(originalUser&&(head?.phase!=='anchor'||!(head.messageId===ref.messageId||head.userParts?.some(part=>part.id===ref.messageId))))return null;
      // A confirmed retry may use a new work-reference scope while answering the
      // same original user input. Only this group's immutable user anchor is
      // independent of that work scope; peer messages keep their exact scope.
      const proofTurns=originalUser?[{...head,scopeKey}]:group;
      const source=resolveChatQuote({id:room?.id,generation:room?.generation??0,turns:proofTurns},ref,scopeKey);
      if(!source||!text(plan.evidence,1600)||!source.text.includes(plan.evidence)
        ||(plan.to==='user'?source.author.role!=='user':source.author.role!=='assistant'||source.author.id!==plan.to))return null;
      sourceRef=source.ref;
    }
    if(plan.kind==='normal'&&plan.to==='user'){
      if(plan.evidence!==undefined&&(!text(plan.evidence,1600)||!group[0]?.user.includes(plan.evidence)))return null;
      return{kind:'normal',to:'user',...(plan.evidence!==undefined?{evidence:plan.evidence}:{}),...(sourceRef?{sourceRef}:{}),...(contribution?{contribution}:{})};
    }
    if(!validId(plan.to)||plan.to===actorId||!roster.includes(plan.to)||!text(plan.evidence,CHAT_LIMITS.bubbleChars)
      ||!group.some(turn=>turn.phase!=='anchor'&&turn.recipientId===plan.to&&turn.status==='ready'
        &&(turn.scopeKey??turn.contextKey??null)===scopeKey&&turn.assistant.some(message=>message.includes(plan.evidence))))return null;
    return{kind:plan.kind,to:plan.to,evidence:plan.evidence,...(sourceRef?{sourceRef}:{}),...(contribution?{contribution}:{})};
  };
  const memberName = (id,members,group) => {
    const name=(Array.isArray(members)?members:[]).find(p=>p.id===id)?.name
      ??group.find(t=>t.recipientId===id)?.speakerName??group[0]?.recipients.find(p=>p.id===id)?.name;
    return text(name,80)?name:id;
  };
  const plannedExtras = (room,head,dialogue,members,group,contextKey,scopeKey) => {
    const extras=[...dialogue.addressed.map(p=>({...p,kind:'invited',to:'user'})),...dialogue.voluntary.map(p=>({...p,kind:'contribute'}))]
      .filter(person=>room.memberIds.includes(person.id));
    const at=now();return extras.map(person=>{const id='reaction:'+randomUUID();return{id,messageId:head.messageId,
      recipients:clone(head.recipients),memberIdsAtSend:[...head.memberIdsAtSend],attemptId:id,
      recipientId:person.id,speakerName:memberName(person.id,members,group),phase:'reaction',reactionPlanId:null,
      user:head.user,at,assistant:[],status:'pending',completedAt:null,contextKey,scopeKey,failure:null,
      responsePlan:{kind:person.kind,to:person.to,...(person.evidence?{evidence:person.evidence}:{})}};});
  };
  const trimTurns = turns => { const ids=[...new Set(turns.map(t=>t.messageId))].slice(-CHAT_LIMITS.turns);return turns.filter(t=>ids.includes(t.messageId)); };
  const checked = ({ roomId, revision, epoch = 0 }) => {
    const room = read(roomId);
    if (!room) fail('chat-room-not-found');
    if (!acceptsEpoch(room, epoch) || revision !== room.revision) fail('chat-conflict');
    return room;
  };
  const replace = room => { const next = clone(state); next.rooms = next.rooms.map(r => r.id === room.id ? room : r); return next; };
  const silenceThrough = (room,personaId,messageId,scopeKey,through) => {
    if(!through||Array.isArray(through)||Object.keys(through).length!==2||!validId(through.turnId)||!validId(through.attemptId))return null;
    const group=room.turns.filter(turn=>turn.messageId===messageId),head=group[0];
    if(head?.phase!=='anchor'||room.turns.at(-1)?.messageId!==messageId||!head.memberIdsAtSend.includes(personaId)||!room.memberIds.includes(personaId))return null;
    if(through.turnId===head.id&&through.attemptId==='user')return head;
    return group.find(turn=>turn.phase!=='anchor'&&turn.id===through.turnId&&turn.attemptId===through.attemptId
      &&turn.recipientId!==personaId&&turn.status==='ready'&&turn.assistant.length>0&&(turn.scopeKey??turn.contextKey??null)===scopeKey)??null;
  };
  const restoredSilences = (room,raw) => {
    if(!Array.isArray(raw))return[];
    const receipts=new Map();
    for(const receipt of raw.slice(-CHAT_LIMITS.members)){
      if(!receipt||Array.isArray(receipt)||Object.keys(receipt).length!==6
        ||Object.keys(receipt).some(key=>!['personaId','messageId','scopeKey','referenceRevision','through','at'].includes(key)))continue;
      if(!validId(receipt.personaId)||!validId(receipt.messageId)||(receipt.scopeKey!==null&&!validId(receipt.scopeKey))
        ||!Number.isSafeInteger(receipt.referenceRevision)||receipt.referenceRevision!==(room.referenceRevision??0)
        ||!Number.isSafeInteger(receipt.at)||receipt.at<0)continue;
      const source=silenceThrough(room,receipt.personaId,receipt.messageId,receipt.scopeKey,receipt.through);
      if(!source||receipt.at<source.at||room.turns.some(turn=>turn.messageId===receipt.messageId&&turn.recipientId===receipt.personaId
        &&turn.status==='ready'&&turn.phase!=='anchor'&&turn.completedAt>receipt.at))continue;
      const previous=receipts.get(receipt.personaId);
      if(!previous||previous.at<=receipt.at)receipts.set(receipt.personaId,{personaId:receipt.personaId,messageId:receipt.messageId,
        scopeKey:receipt.scopeKey,referenceRevision:receipt.referenceRevision,through:{turnId:receipt.through.turnId,attemptId:receipt.through.attemptId},at:receipt.at});
    }
    return[...receipts.values()];
  };
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
      ?room.turns.filter(t=>t.messageId===messageId&&t.phase!=='anchor').map(t=>({id:t.id,attemptId:t.attemptId})):null;},
    hasMember: (roomId,personaId) => state.rooms.some(r=>r.id===roomId&&r.memberIds.includes(personaId)),
    list: () => state.rooms.map(r => ({ id:r.id,name:r.name,memberIds:[...r.memberIds],targetPersonaId:r.targetPersonaId,targetPersonaIds:[...r.targetPersonaIds],
      revision:r.revision,generation:r.generation??0,at:r.turns.at(-1)?.at ?? r.createdAt,turnCount:new Set(r.turns.map(t=>t.messageId)).size })).sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)),
    contacts: () => [...new Map(state.rooms.flatMap(r => r.turns.filter(t=>t.phase!=='anchor').map(t => [t.recipientId,
      { personaId:t.recipientId,name:t.speakerName }]))).values()],
    restore(raw) {
      state = empty();
      // Unreleased development formats intentionally have no migration path.
      if (raw?.version !== 3 || !Array.isArray(raw.rooms)) return;
      if (Number.isSafeInteger(raw.epoch) && raw.epoch >= 0) state.epoch = raw.epoch;
      for (const room of raw.rooms.slice(-CHAT_LIMITS.rooms)) {
        if (!validId(room?.id) || !membersValid(room.memberIds) || !targetsValid(room.targetPersonaIds,room.memberIds)
          || room.targetPersonaId!==(room.targetPersonaIds[0]??null)
          || !text(room.name, 60) || state.rooms.some(r => r.id === room.id)
          || !Number.isSafeInteger(room.revision) || room.revision < 0 || !Array.isArray(room.turns)) continue;
        const turns = [], witnessed = new Map();
        for (const turn of room.turns.slice(-CHAT_LIMITS.turns*(CHAT_LIMITS.roundReplies+1))) {
          const anchor=turn?.phase==='anchor'&&turn.recipientId==='user';
          if(turn?.phase==='anchor'&&!anchor)continue;
          if (!validId(turn?.id) || !validId(turn.attemptId) || !validId(turn.recipientId) || turns.some((t) => t.id === turn.id)
            || !validId(turn.messageId) || turns.filter(t=>t.messageId===turn.messageId&&t.phase!=='anchor').length>=CHAT_LIMITS.roundReplies
            || !recipientsValid(turn.recipients) || (!anchor&&!['reaction','followup'].includes(turn.phase)&&!turn.recipients.some(p=>p.id===turn.recipientId))
            || !text(turn.user, CHAT_LIMITS.input) || !statuses.includes(turn.status)
            || !Number.isSafeInteger(turn.at) || turn.at < 0 || !text(turn.speakerName, 80)
            || !Array.isArray(turn.assistant) || (anchor?(turn.id!==turn.messageId||turn.status!=='ready'||turn.assistant.length>0)
              :(turn.status === 'ready' && !parseChatReply(JSON.stringify({ messages: turn.assistant }))))) continue;
          const ids = turn.recipients.map(p => p.id);
          if (turn.memberIdsAtSend !== undefined && (!membersValid(turn.memberIdsAtSend)
            || ![...ids,...(anchor?[]:[turn.recipientId])].every(id => turn.memberIdsAtSend.includes(id)))) continue;
          if(anchor&&!turn.memberIdsAtSend)continue;
          if (!turn.memberIdsAtSend) {
            const known = witnessed.get(turn.messageId) ?? new Set();
            for (const id of [...ids, turn.recipientId]) known.add(id);
            witnessed.set(turn.messageId, known);
          }
          turns.push({ id: turn.id, messageId:turn.messageId,recipients:clone(turn.recipients),memberIdsAtSend:turn.memberIdsAtSend?.slice(),attemptId: turn.attemptId, recipientId:turn.recipientId, user: turn.user, at: turn.at,
            ...(Number.isSafeInteger(turn.emittedOrder)&&turn.emittedOrder>=0&&turn.emittedOrder<CHAT_LIMITS.roundReplies?{emittedOrder:turn.emittedOrder}:{}),
            phase:anchor?'anchor':turn.phase==='reaction'?'reaction':turn.phase==='followup'?'followup':'primary',reactionPlanId:validId(turn.reactionPlanId)?turn.reactionPlanId:null,
            ...(validId(turn.directedPlanId)?{directedPlanId:turn.directedPlanId}:{}),
            ...(validId(turn.followupPlanId)?{followupPlanId:turn.followupPlanId}:{}),
            ...(restoredChatQuote(turn.quote,room.id)?{quote:restoredChatQuote(turn.quote,room.id)}:{}),
            ...(anchor&&turn.scene?{scene:turn.scene,sceneReferenceRevision:turn.sceneReferenceRevision,sceneSourceVersion:turn.sceneSourceVersion}:{}),
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
        const rejected=new Set(),restoredPartIds=new Set();
        for (const head of turns.filter((turn,index)=>turns.findIndex(t=>t.messageId===turn.messageId)===index)) {
          const group=turns.filter(t=>t.messageId===head.messageId);
          const rawHead=room.turns.find(t=>t.id===head.id);
          const parts=chatUserParts(rawHead?.userParts,head.user,head.messageId);
          if(parts&&parts.every(part=>!restoredPartIds.has(part.id)&&!turns.some(t=>t.messageId!==head.messageId&&t.messageId===part.id))){
            head.userParts=parts;for(const part of parts)restoredPartIds.add(part.id);
          }
          if(head.phase==='anchor'){
            if(!head.userParts){for(const turn of group)rejected.add(turn.id);continue;}
            const accepted=[],plans=new Set(),orders=new Set();
            for(const turn of group){
              if(turn===head)continue;
              const rawTurn=room.turns.find(item=>item.id===turn.id),plan=directedPlan(rawTurn?.responsePlan,turn.recipientId,[head,...accepted],turn.scopeKey??turn.contextKey??null,head.memberIdsAtSend,room);
              if(!validId(turn.directedPlanId)||plans.has(turn.directedPlanId)||!head.memberIdsAtSend.includes(turn.recipientId)
                ||turn.user!==head.user||!same(turn.recipients,head.recipients)||!same(turn.memberIdsAtSend,head.memberIdsAtSend)||!plan){rejected.add(turn.id);continue;}
              turn.responsePlan=plan;turn.phase=plan.kind==='peer'?'followup':'reaction';plans.add(turn.directedPlanId);
              if(Number.isSafeInteger(turn.emittedOrder)){if(orders.has(turn.emittedOrder))delete turn.emittedOrder;else orders.add(turn.emittedOrder);}
              accepted.push(turn);
            }
            delete head.emittedOrder;
            continue;
          }
          const dialogue=normalizeDialoguePlan(rawHead?.dialoguePlan,{message:head.user,
            members:head.memberIdsAtSend.map(id=>({id,name:id})),recipients:head.recipients});
          if(dialogue)head.dialoguePlan=dialogue;
          const ids=Array.isArray(rawHead?.continuationPlanIds)&&rawHead.continuationPlanIds.length<=CHAT_LIMITS.continuationBatches
            &&rawHead.continuationPlanIds.every(validId)&&new Set(rawHead.continuationPlanIds).size===rawHead.continuationPlanIds.length
            ?rawHead.continuationPlanIds:[];
          const accepted=[],batches=new Map(),batchSpeakers=new Map(),counts=new Map(),initial=new Set(),emitted=new Set();
          for (const turn of group) {
            if(turn.directedPlanId){rejected.add(turn.id);continue;}
            if(Number.isSafeInteger(turn.emittedOrder)){if(emitted.has(turn.emittedOrder))delete turn.emittedOrder;else emitted.add(turn.emittedOrder);}
            const rawTurn=room.turns.find(t=>t.id===turn.id),followup=turn.phase==='followup';
            if(dialogue&&!followup){
              const addressed=dialogue.addressed.find(p=>p.id===turn.recipientId),voluntary=dialogue.voluntary.find(p=>p.id===turn.recipientId);
              if(initial.has(turn.recipientId)||(!primaryChatTurn(turn)&&!addressed&&!voluntary)){rejected.add(turn.id);continue;}
              initial.add(turn.recipientId);
              turn.responsePlan=primaryChatTurn(turn)?{kind:'primary',to:'user'}:addressed?{kind:'invited',to:'user',evidence:addressed.evidence}:{kind:'contribute',to:voluntary.to};
            }
            if(followup&&rawTurn.continuationPlanId!==undefined){
              const planId=rawTurn.continuationPlanId,peer=rawTurn.responsePlan,previous=accepted.filter(t=>t.recipientId===peer?.to
                &&(t.scopeKey??t.contextKey??null)===(turn.scopeKey??turn.contextKey??null));
              const batchSize=batches.get(planId)??0;
              if(!ids.includes(planId)||batchSize>=2||batchSpeakers.get(planId)?.has(turn.recipientId)||[...batches.values()].reduce((sum,n)=>sum+n,0)>=CHAT_LIMITS.continuations
                ||(counts.get(turn.recipientId)??0)>=CHAT_LIMITS.speakerTurns||peer?.kind!=='peer'||!validId(peer.to)||peer.to===turn.recipientId
                ||!head.memberIdsAtSend.includes(peer.to)||!head.memberIdsAtSend.includes(turn.recipientId)||!text(peer.evidence,CHAT_LIMITS.bubbleChars)
                ||!previous.length||[...batches.keys()].some(id=>ids.indexOf(id)>ids.indexOf(planId))){rejected.add(turn.id);continue;}
              const members=head.memberIdsAtSend.map(id=>({id,name:memberName(id,[],group)}));
              const checked=normalizeContinuationPlan({responses:[{id:turn.recipientId,to:peer.to,evidence:peer.evidence}]},
                {members,exchange:exchangeFor(accepted.filter(t=>(t.scopeKey??t.contextKey??null)===(turn.scopeKey??turn.contextKey??null))),counts,limit:1});
              // An interrupted retry may have retired the quoted reply. Keep its
              // bounded queue relationship; the Host rechecks evidence before use.
              if(!checked&&previous.at(-1)?.status==='ready'){rejected.add(turn.id);continue;}
              turn.continuationPlanId=planId;turn.responsePlan={kind:'peer',to:peer.to,evidence:peer.evidence};batches.set(planId,batchSize+1);
              if(!batchSpeakers.has(planId))batchSpeakers.set(planId,new Set());batchSpeakers.get(planId).add(turn.recipientId);
            }else if(followup&&(!head.followupPlanId||!head.recipients.some(p=>p.id===turn.recipientId))){rejected.add(turn.id);continue;}
            accepted.push(turn);counts.set(turn.recipientId,(counts.get(turn.recipientId)??0)+1);
          }
          if(ids.length)head.continuationPlanIds=ids.filter(id=>batches.has(id));
        }
        const sources = Array.isArray(room.sources) && room.sources.length <= 6 && room.sources.every(validId)
          && new Set(room.sources).size === room.sources.length ? [...room.sources] : null;
        // Only the next send's selection is capped. Keep historical addressees and authors intact.
        const restoredRoom={ id:room.id,name:room.name,memberIds:[...room.memberIds],targetPersonaId:room.targetPersonaId,targetPersonaIds:room.targetPersonaIds.slice(0,CHAT_LIMITS.primary),
          revision:room.revision,configRevision:Number.isSafeInteger(room.configRevision)?room.configRevision:0,createdAt:Number.isSafeInteger(room.createdAt)?room.createdAt:0,turns:trimTurns(turns.filter(t=>!rejected.has(t.id))),sources,
          primarySessionId:sources?.includes(room.primarySessionId)?room.primarySessionId:null,
          generation:Number.isSafeInteger(room.generation)&&room.generation>=0&&room.generation<=state.epoch?room.generation:state.epoch,
          sourceVersion:Number.isSafeInteger(room.sourceVersion)&&room.sourceVersion>=0?room.sourceVersion:0,
          ...(Number.isSafeInteger(room.referenceRevision)&&room.referenceRevision>0?{referenceRevision:room.referenceRevision}:{}),
          ...(Array.isArray(room.excludedReferences)?{excludedReferences:room.excludedReferences.map(quoteRef).filter(r=>r?.roomId===room.id).slice(0,128)}:{}),
          ...(room.discussion?{discussion:restoreDiscussion(room.discussion,room.id)}:{}),
          createRequestId:validId(room.createRequestId)?room.createRequestId:null,
          createFingerprint:typeof room.createFingerprint==='string'?room.createFingerprint:null,
          ...(validId(room.legacyPersonaId)?{legacyPersonaId:room.legacyPersonaId,personaId:room.legacyPersonaId}:{}) };
        restoreChatScenes(restoredRoom);
        restoredRoom.silences=restoredSilences(restoredRoom,room.silences);state.rooms.push(restoredRoom);
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
        const room={id:'room:'+randomUUID(),name,memberIds:[...memberIds],targetPersonaIds:[...targetPersonaIds],targetPersonaId:targetPersonaIds[0]??null,revision:0,configRevision:0,createdAt:now(),turns:[],silences:[],
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
      room.silences=(room.silences??[]).filter(receipt=>room.memberIds.includes(receipt.personaId));
      const targets=body.targetPersonaIds??(body.targetPersonaId!==undefined?(body.targetPersonaId===null?[]:[body.targetPersonaId]):undefined);
      checkPrimaryLimit(targets);
      if(targets!==undefined){if(!targetsValid(targets,room.memberIds))fail('chat-recipient-not-member');room.targetPersonaIds=[...targets];}
      else room.targetPersonaIds=room.targetPersonaIds.filter(id=>room.memberIds.includes(id));
      room.targetPersonaId=room.targetPersonaIds[0]??null;
      room.revision++;room.configRevision=(room.configRevision??0)+1;await commit(replace(room));return clone(room);
    }); },
    sources({roomId,sessionIds,primarySessionId}) { return serial(async()=>{
      const room=read(roomId);if(!room)fail('chat-room-not-found');
      if(!Array.isArray(sessionIds)||sessionIds.length>6||!sessionIds.every(validId)||new Set(sessionIds).size!==sessionIds.length
        ||(primarySessionId!==null&&!sessionIds.includes(primarySessionId)))fail('invalid-chat-sources');
      // Source selection is protected by its own context revision, independently of message acknowledgements.
      if(JSON.stringify(room.sources)===JSON.stringify(sessionIds)&&room.primarySessionId===primarySessionId)return;
      room.sources=[...sessionIds];room.primarySessionId=primarySessionId;room.sourceVersion=(room.sourceVersion??0)+1;forgetScenes(room);await commit(replace(room));
    }); },
    remove(body) { return serial(async()=>{
      const room=checked(body),next=clone(state);next.rooms=next.rooms.filter(r=>r.id!==room.id);next.epoch++;
      if(next.activeRoomId===room.id)next.activeRoomId=next.rooms[0]?.id??null;
      await commit(next);return true;
    }); },
    send({ roomId, personaId, name, recipients=[{id:personaId,name}],requestId, content, userParts, revision, epoch = 0, allowOrphan = false, contextKey = null, scopeKey=contextKey, afterMessageId, configRevision, quote:quoteInput, frozenRecipients=false, frozenMemberIds, directed=false }) {
      return serial(async () => {
        checkPrimaryLimit(recipients);
        if(!directed&&recipients.length>2)fail('chat-primary-limit');
        if ((!directed&&(!validId(personaId)||!text(name,80))) || (directed&&!validId(roomId)&&(!validId(personaId)||!text(name,80))) || !validId(requestId) || !text(content, CHAT_LIMITS.input)) fail('invalid-chat-message');
        const parts=userParts===undefined?undefined:chatUserParts(userParts,content,requestId);
        if(userParts!==undefined&&!parts)fail('invalid-chat-message');
        if(frozenMemberIds!==undefined&&!membersValid(frozenMemberIds))fail('invalid-chat-members');
        if(!recipientsValid(recipients)||(!directed&&recipients[0]?.id!==personaId))fail('invalid-chat-message');
        if (contextKey !== null && !validId(contextKey)) fail('invalid-chat-message');
        if (scopeKey !== null && !validId(scopeKey)) fail('invalid-chat-message');
        const current = read(roomId??personaId);
        if(roomId&&!current)fail('chat-room-not-found');
        if (!acceptsEpoch(current,epoch)) fail('chat-conflict');
        const existing = current?.turns.find((t) => t.id === requestId);
        if (existing) {
          if (existing.user !== content || !same(existing.recipients.map(p=>p.id),recipients.map(p=>p.id)) || (existing.scopeKey??existing.contextKey??null)!==scopeKey
            ||quoteKey(quoteInput)!==quoteKey(existing.quote?.ref)||((!directed||userParts!==undefined)&&!same(existing.userParts,parts))
            ||(existing.phase==='anchor')!==directed
            ||(frozenMemberIds!==undefined&&!same(existing.memberIdsAtSend,frozenMemberIds))) fail('chat-id-conflict');
          return { room: current, turn: existing, turns:current.turns.filter(t=>t.messageId===requestId),created: false };
        }
        if(current?.turns.some(turn=>turn.userParts?.some(part=>part.id===requestId))
          ||parts?.some(part=>current?.turns.some(turn=>turn.messageId===part.id||turn.userParts?.some(previous=>previous.id===part.id))))fail('chat-id-conflict');
        const quote=quoteInput==null?null:resolveChatQuote(current,quoteInput,scopeKey);
        if(quoteInput!=null&&!quote)fail('chat-quote-unavailable');
        const memberIdsAtSend = frozenMemberIds ?? current?.memberIds ?? [personaId];
        if(recipients.some(p=>!memberIdsAtSend.includes(p.id)||(current&&!current.memberIds.includes(p.id))))fail('chat-recipient-not-member');
        if(roomId&&frozenRecipients!==true&&!same(current.targetPersonaIds,recipients.map(p=>p.id)))fail('chat-conflict');
        const tail=current?.turns.filter(t=>t.messageId===afterMessageId);
        const yieldOptional=validId(afterMessageId)&&current?.turns.at(-1)?.messageId===afterMessageId
          &&Number.isSafeInteger(configRevision)&&current.configRevision===configRevision&&tail.some(primaryChatTurn)
          &&tail.every(t=>(t.scopeKey??t.contextKey??null)===scopeKey&&(!primaryChatTurn(t)||t.status!=='pending'));
        if (revision !== (current?.revision ?? 0) && !yieldOptional) fail('chat-conflict');
        if (current?.turns.some((t) => t.status === 'pending') && !allowOrphan && !yieldOptional) fail('chat-busy');
        if (!current && state.rooms.length >= CHAT_LIMITS.rooms) fail('chat-capacity');
        const next = clone(state);
        // Persona-only direct requests share the same room engine; explicit room IDs are authoritative.
        const room = current ?? { id:'chat:'+randomUUID(),legacyPersonaId:personaId,personaId,name:'与'+name+'的聊天',
          memberIds:[personaId],targetPersonaIds:[personaId],targetPersonaId:personaId,revision:0,configRevision:0,createdAt:now(),turns:[],sources:null,primarySessionId:null,sourceVersion:0,generation:state.epoch };
        for (const turn of room.turns) if (turn.status === 'pending') turn.status = 'interrupted';
        const at=now(),turns=directed?[{id:requestId,messageId:requestId,attemptId:requestId,recipientId:'user',speakerName:'我',
          user:content,userParts:parts??[{id:requestId,text:content,at}],recipients:clone(recipients),memberIdsAtSend:[...memberIdsAtSend],
          assistant:[],status:'ready',phase:'anchor',reactionPlanId:null,at,completedAt:at,contextKey,scopeKey,failure:null,...(quote?{quote}:{})}]
          :recipients.map((person,index)=>{const id=index?'reply:'+randomUUID():requestId;return {
          id,messageId:requestId,recipients:clone(recipients),memberIdsAtSend:[...memberIdsAtSend],attemptId:id,recipientId:person.id,user:content,assistant:[],status:'pending',
          phase:'primary',reactionPlanId:null,
          ...(!index&&quote?{quote}:{}),
          ...(!index&&parts?{userParts:parts}:{}),
          at,completedAt:null,speakerName:person.name,contextKey,scopeKey,failure:null};});
        room.turns.push(...turns); room.turns = trimTurns(room.turns);room.silences=[]; room.revision += 1;
        next.rooms = next.rooms.filter((r) => r.id !== room.id); next.rooms.push(room);next.activeRoomId??=room.id;
        await commit(next); return { room: clone(room), turn: clone(turns[0]),turns:clone(turns),created: true };
      });
    },
    referencePolicy({roomId,referenceRevision,ref,excluded,scopeKey,epoch=0}) {return serial(async()=>{
      const room=read(roomId),normalized=quoteRef(ref);
      if(!room||!acceptsEpoch(room,epoch)||(room.referenceRevision??0)!==referenceRevision)fail('chat-conflict');
      if(!normalized||normalized.roomId!==roomId||typeof excluded!=='boolean')fail('invalid-chat-reference');
      const key=quoteKey(normalized),refs=room.excludedReferences??[],exists=refs.some(r=>quoteKey(r)===key);
      if(exists===excluded)return false;
      if(excluded&&!resolveChatQuote(room,normalized,scopeKey))fail('chat-quote-unavailable');
      if(excluded&&refs.length>=128)fail('chat-reference-capacity');
      room.excludedReferences=excluded?[...refs,normalized]:refs.filter(r=>quoteKey(r)!==key);
      room.referenceRevision=(room.referenceRevision??0)+1;
      forgetScenes(room);
      await commit(replace(room));return true;
    });},
    setScene({roomId,messageId,scene,scopeKey,referenceRevision,epoch=0,valid}) {return serial(async()=>{
      const room=read(roomId),anchor=room?.turns.find(turn=>turn.messageId===messageId&&turn.phase==='anchor');
      if(!room||!anchor||room.turns.at(-1)?.messageId!==messageId||!acceptsEpoch(room,epoch)
        ||(anchor.scopeKey??anchor.contextKey??null)!==scopeKey||!Number.isSafeInteger(referenceRevision)
        ||(room.referenceRevision??0)!==referenceRevision||typeof valid==='function'&&!valid())return false;
      const catalog=buildChatSceneCatalog(room,{messageId,scopeKey,referenceRevision}),selected=catalog.options.find(option=>same(option.frame,scene));
      if(!selected)fail('invalid-chat-scene');
      if(same(anchor.scene,selected.frame)&&anchor.sceneReferenceRevision===referenceRevision&&anchor.sceneSourceVersion===(room.sourceVersion??0))return true;
      anchor.scene=clone(selected.frame);anchor.sceneReferenceRevision=referenceRevision;anchor.sceneSourceVersion=room.sourceVersion??0;
      room.revision++;return await commit(replace(room),valid);
    });},
    discussionChange(body,scopeKey) {return serial(async()=>{
      const room=read(body.roomId);
      if(!room)fail('chat-room-not-found');
      if(!acceptsEpoch(room,body.epoch))fail('chat-conflict');
      room.discussion=changeDiscussion(room,body,typeof scopeKey==='function'?scopeKey(room):scopeKey,now());
      room.referenceRevision=(room.referenceRevision??0)+1;
      forgetScenes(room);
      await commit(replace(room));return true;
    });},
    appendDirectedReply({roomId,messageId,planId,actor,responsePlan,attempts,members=[],epoch=0,contextKey=null,scopeKey=contextKey,valid}) {return serial(async()=>{
      const room=read(roomId),group=room?.turns.filter(turn=>turn.messageId===messageId),head=group?.[0];
      if(!room||room.turns.at(-1)?.messageId!==messageId||head?.phase!=='anchor'||!acceptsEpoch(room,epoch)||!validId(planId)
        ||!validId(actor?.id)||!text(actor.name,80)||!membersValid(members.map(person=>person?.id))||members.some(person=>!text(person.name,80))
        ||!members.some(person=>person.id===actor.id&&person.name===actor.name)||!head.memberIdsAtSend.includes(actor.id)||!room.memberIds.includes(actor.id)
        ||(contextKey!==null&&!validId(contextKey))||(scopeKey!==null&&!validId(scopeKey))
        ||(head.scopeKey??head.contextKey??null)!==scopeKey)fail('chat-conflict');
      const existing=group.find(turn=>turn.directedPlanId===planId),preceding=existing?group.slice(0,group.indexOf(existing)):group;
      const plan=directedPlan(responsePlan,actor.id,preceding,scopeKey,head.memberIdsAtSend.filter(id=>room.memberIds.includes(id)),room);
      if(!plan)fail('invalid-chat-plan');
      if(existing){if(existing.recipientId!==actor.id||existing.speakerName!==actor.name||!same(existing.responsePlan,plan)
          ||(existing.contextKey??null)!==contextKey||(existing.scopeKey??existing.contextKey??null)!==scopeKey)fail('chat-conflict');
        return{room,turn:existing,turns:[existing],created:false};}
      if(group.some(turn=>turn.status==='pending')||group.filter(turn=>turn.phase!=='anchor').length>=CHAT_LIMITS.roundReplies
        ||(attempts!==undefined&&!same(group.map(turn=>({id:turn.id,attemptId:turn.attemptId})),attempts)
          &&!same(group.filter(turn=>turn.phase!=='anchor').map(turn=>({id:turn.id,attemptId:turn.attemptId})),attempts)))fail('chat-conflict');
      const id='directed:'+randomUUID(),turn={id,messageId,attemptId:id,directedPlanId:planId,recipients:clone(head.recipients),memberIdsAtSend:[...head.memberIdsAtSend],
        recipientId:actor.id,speakerName:actor.name,user:head.user,phase:plan.kind==='peer'?'followup':'reaction',responsePlan:plan,
        reactionPlanId:null,at:now(),assistant:[],status:'pending',completedAt:null,contextKey,scopeKey,failure:null};
      room.turns.push(turn);room.revision++;const applied=await commit(replace(room),valid);
      return{room:read(roomId),turn:applied?clone(turn):null,turns:applied?[clone(turn)]:[],created:applied};
    });},
    planRound({roomId,messageId,planId,attempts,dialogue,members=[],epoch=0,contextKey=null,scopeKey=contextKey,valid}) {return serial(async()=>{
      const room=read(roomId),group=room?.turns.filter(t=>t.messageId===messageId),head=group?.[0];
      if(!room||room.turns.at(-1)?.messageId!==messageId||!head||!acceptsEpoch(room,epoch)||!validId(planId)
        ||!attemptPrefix(group,attempts)
        ||group.some(t=>t.status==='pending'&&(t.scopeKey??t.contextKey??null)!==scopeKey))fail('chat-conflict');
      const normalized=normalizeDialoguePlan(head.dialoguePlan??dialogue,{message:head.user,
        members:head.memberIdsAtSend.map(id=>({id,name:id})),recipients:head.recipients});
      if(!normalized)fail('invalid-chat-plan');
      // Retain already answered independent seats after an out-of-order retry.
      // Only missing initial seats are constructed from the frozen dialogue plan.
      const presentExtras=new Set(group.filter(t=>t.phase==='reaction').map(t=>t.recipientId));
      const turns=plannedExtras(room,head,normalized,members,group,contextKey,scopeKey).filter(t=>!presentExtras.has(t.recipientId));
      if(head.dialoguePlan&&head.reactionPlanId&&!turns.length)return{room,turns:group.filter(t=>t.status==='pending'),created:false};
      if(attempts.length!==group.length)fail('chat-conflict');
      if(group.length+turns.length>CHAT_LIMITS.roundReplies)fail('chat-conflict');
      head.dialoguePlan=normalized;
      for(const turn of group.filter(primaryChatTurn))turn.responsePlan={kind:'primary',to:'user'};
      head.reactionPlanId??=planId;room.turns.push(...turns);room.revision++;
      if(!await commit(replace(room),valid))return{room:read(roomId),turns:[],created:false};
      return{room:clone(room),turns:clone([...group.filter(t=>t.status==='pending'),...turns]),created:true};
    });},
    appendContinuations({roomId,messageId,planId,attempts,responses,members=[],epoch=0,contextKey=null,scopeKey=contextKey,valid}) {return serial(async()=>{
      const room=read(roomId),group=room?.turns.filter(t=>t.messageId===messageId),head=group?.[0];
      if(!room||room.turns.at(-1)?.messageId!==messageId||!head||!acceptsEpoch(room,epoch)||!validId(planId)
        ||!attemptPrefix(group,attempts)||group.some(t=>t.status==='pending'&&(t.scopeKey??t.contextKey??null)!==scopeKey))fail('chat-conflict');
      const ids=head.continuationPlanIds??[];
      if(ids.includes(planId)){
        const existing=group.filter(t=>t.continuationPlanId===planId);
        if(existing.some(t=>(t.scopeKey??t.contextKey??null)!==scopeKey)||!Array.isArray(responses)||responses.length!==existing.length||responses.some((p,index)=>!p||Object.keys(p).length!==3
          ||p.id!==existing[index].recipientId||p.to!==existing[index].responsePlan?.to||p.evidence!==existing[index].responsePlan?.evidence))fail('chat-conflict');
        return{room,turns:existing,created:false};
      }
      if(attempts.length!==group.length||group.some(t=>t.status==='pending')||ids.length>=CHAT_LIMITS.continuationBatches)fail('chat-conflict');
      const remaining=Math.min(2,CHAT_LIMITS.continuations-group.filter(t=>t.phase==='followup').length,CHAT_LIMITS.roundReplies-group.length);
      const people=room.memberIds.filter(id=>head.memberIdsAtSend.includes(id)).map(id=>({id,name:memberName(id,members,group)}));
      const plan=normalizeContinuationPlan({responses},{members:people,exchange:exchangeFor(group.filter(t=>(t.scopeKey??t.contextKey??null)===scopeKey)),counts:speakerCounts(group),limit:Math.max(0,remaining)});
      if(!plan)fail('invalid-chat-plan');
      if(!plan.responses.length)return{room,turns:[],created:false};
      const at=now(),turns=plan.responses.map(person=>{const id='followup:'+randomUUID();return{id,messageId,attemptId:id,
        recipients:clone(head.recipients),memberIdsAtSend:[...head.memberIdsAtSend],recipientId:person.id,
        speakerName:memberName(person.id,members,group),user:head.user,phase:'followup',reactionPlanId:null,continuationPlanId:planId,
        responsePlan:{kind:'peer',to:person.to,evidence:person.evidence},at,assistant:[],status:'pending',completedAt:null,contextKey,scopeKey,failure:null};});
      head.continuationPlanIds=[...ids,planId];room.turns.push(...turns);room.revision++;
      const applied=await commit(replace(room),valid);return{room:read(roomId),turns:applied?clone(turns):[],created:applied};
    });},
    appendReactions({roomId,messageId,planId,primaryAttempts,recipients,epoch=0,contextKey=null,scopeKey=contextKey,valid}) {return serial(async()=>{
      const room=read(roomId),group=room?.turns.filter(t=>t.messageId===messageId),primary=group?.filter(primaryChatTurn);
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
    appendFollowup({roomId,messageId,planId,attempts,recipient,epoch=0,contextKey=null,scopeKey=contextKey,valid}) {return serial(async()=>{
      const room=read(roomId),group=room?.turns.filter(t=>t.messageId===messageId),head=group?.find(primaryChatTurn);
      if(!room||room.turns.at(-1)?.messageId!==messageId||!head||!acceptsEpoch(room,epoch)||!validId(planId))fail('chat-conflict');
      if(head.followupPlanId){
        if(head.followupPlanId!==planId)fail('chat-conflict');
        return {room,turns:group.filter(t=>t.phase==='followup'),created:false};
      }
      if(!same(group.map(t=>({id:t.id,attemptId:t.attemptId})),attempts)||group.some(t=>t.status==='pending')
        ||group.some(t=>(t.scopeKey??t.contextKey??null)!==scopeKey)||group.some(t=>t.phase==='followup'))fail('chat-conflict');
      const ready=group.filter(t=>t.status==='ready');
      if(!recipient||!recipientsValid([recipient])||!room.memberIds.includes(recipient.id)
        ||!head.recipients.some(p=>p.id===recipient.id)||!ready.some(t=>t.recipientId===recipient.id)
        ||ready.at(-1)?.recipientId===recipient.id||new Set(ready.map(t=>t.recipientId)).size<2
        ||group.filter(t=>!primaryChatTurn(t)).reduce((n,t)=>n+t.assistant.length,0)>=CHAT_LIMITS.optionalBubbles)fail('chat-recipient-not-member');
      const id='followup:'+randomUUID(),turn={id,messageId,attemptId:id,recipients:clone(head.recipients),
        memberIdsAtSend:[...head.memberIdsAtSend],recipientId:recipient.id,speakerName:recipient.name,user:head.user,
        phase:'followup',reactionPlanId:null,at:now(),assistant:[],status:'pending',completedAt:null,contextKey,scopeKey,failure:null};
      head.followupPlanId=planId;room.turns.push(turn);room.revision++;
      const applied=await commit(replace(room),valid);return{room:read(roomId),turns:applied?[clone(turn)]:[],created:applied};
    });},
    retry({ roomId, personaId, id, attemptId, revision, name, members=[], epoch = 0, allowOrphan = false, contextKey = null, scopeKey=contextKey, previousContextKey }) {
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
        const quoteHead=room.turns.find(t=>t.messageId===turn.messageId&&t.quote),headQuote=quoteHead?.quote;
        if(headQuote){const canonical=resolveChatQuote(room,headQuote.ref,scopeKey);if(!canonical)fail('chat-quote-unavailable');quoteHead.quote=canonical;}
        const previousGroup=room.turns.filter(t=>t.messageId===turn.messageId),head=previousGroup[0];
        if(head.phase==='anchor'){
          if(turn.phase==='anchor'||!directedPlan(turn.responsePlan,turn.recipientId,previousGroup.slice(0,previousGroup.indexOf(turn)),scopeKey,head.memberIdsAtSend.filter(member=>room.memberIds.includes(member)),room))fail('chat-retry-unavailable');
          // A brief written against a replaced reference cannot guide the retry.
          if((turn.scopeKey??turn.contextKey??null)!==scopeKey||(turn.contextKey??null)!==contextKey)delete turn.responsePlan.contribution;
          Object.assign(turn,{attemptId,status:'pending',assistant:[],completedAt:null,speakerName:name,contextKey,scopeKey,failure:null});
          room.revision++;await commit(replace(room));return{room:clone(room),turn:clone(turn),turns:[clone(turn)],created:true};
        }
        const failedIndex=previousGroup.indexOf(turn),failedOrder=turn.emittedOrder;
        const before=new Set(previousGroup.filter((item,index)=>item.id!==turn.id&&(Number.isSafeInteger(failedOrder)&&Number.isSafeInteger(item.emittedOrder)
          ?item.emittedOrder<failedOrder:index<failedIndex)).map(item=>item.id));
        if(primaryChatTurn(turn)){
          room.turns=room.turns.filter(t=>t.messageId!==turn.messageId||primaryChatTurn(t)||before.has(t.id));
          const dialogue=normalizeDialoguePlan(head.dialoguePlan,{message:head.user,members:head.memberIdsAtSend.map(id=>({id})),recipients:head.recipients});
          if(dialogue){
            head.dialoguePlan=dialogue;head.reactionPlanId??='retry-plan:'+randomUUID();
            const retained=new Set(room.turns.filter(t=>t.messageId===turn.messageId&&t.phase==='reaction').map(t=>t.recipientId));
            room.turns.push(...plannedExtras(room,head,dialogue,members,previousGroup,contextKey,scopeKey).filter(t=>!retained.has(t.recipientId)));
          }else head.reactionPlanId=null;
          delete head.followupPlanId;delete head.continuationPlanIds;
        }
        const preserved=room.turns.filter(t=>t.messageId===turn.messageId&&before.has(t.id)&&Number.isSafeInteger(t.emittedOrder)).sort((a,b)=>a.emittedOrder-b.emittedOrder);
        preserved.forEach((item,index)=>{item.emittedOrder=index;});
        const retryTurns=room.turns.filter(t=>t.messageId===turn.messageId&&!before.has(t.id));
        for(const item of retryTurns){Object.assign(item,{attemptId:item.id===id?attemptId:'retry:'+randomUUID(),status:'pending',assistant:[],completedAt:null,
          ...(item.id===id?{speakerName:name}:{}),contextKey,scopeKey,failure:null});delete item.emittedOrder;}
        room.revision += 1;
        const next = replace(room);
        await commit(next); return { room: clone(room), turn: clone(turn),turns:clone(retryTurns), created: true };
      });
    },
    startReply({roomId,id,attemptId,valid}) {return serial(async()=>{
      const room=read(roomId),turn=room?.turns.find(t=>t.id===id&&t.attemptId===attemptId);
      if(!turn||turn.status!=='pending'||room.turns.at(-1)?.messageId!==turn.messageId)return false;
      if(Number.isSafeInteger(turn.emittedOrder))return true;
      const used=room.turns.filter(t=>t.messageId===turn.messageId&&Number.isSafeInteger(t.emittedOrder)).map(t=>t.emittedOrder);
      const order=used.length?Math.max(...used)+1:0;if(order>=CHAT_LIMITS.roundReplies)return false;
      turn.emittedOrder=order;room.revision++;
      return await commit(replace(room),valid);
    });},
    declineReply({roomId,id,attemptId,epoch=0,scopeKey,referenceRevision,through,valid}) {return serial(async()=>{
      const room=read(roomId),turn=room?.turns.find(item=>item.id===id&&item.attemptId===attemptId);
      if(!room||!turn||turn.phase==='anchor'||turn.status!=='pending'||!acceptsEpoch(room,epoch)
        ||room.turns.at(-1)?.messageId!==turn.messageId||(turn.scopeKey??turn.contextKey??null)!==scopeKey
        ||(scopeKey!==null&&!validId(scopeKey))||!Number.isSafeInteger(referenceRevision)||(room.referenceRevision??0)!==referenceRevision)return false;
      const source=silenceThrough(room,turn.recipientId,turn.messageId,scopeKey,through);if(!source)return false;
      const receipt={personaId:turn.recipientId,messageId:turn.messageId,scopeKey,referenceRevision,
        through:{turnId:through.turnId,attemptId:through.attemptId},at:Math.max(turn.at,source.at,now())};
      room.turns=room.turns.filter(item=>item.id!==id);
      room.silences=[...(room.silences??[]).filter(item=>item.personaId!==turn.recipientId&&item.messageId===turn.messageId),receipt].slice(-CHAT_LIMITS.members);
      room.revision++;return await commit(replace(room),valid);
    });},
    finish({ personaId, roomId, id, attemptId, status, messages = [], failure = null, valid }) {
      return serial(async () => {
        const room = read(roomId??personaId), turn = room?.turns.find((t) => t.id === id);
        if (!room || room.id !== roomId || !turn || turn.attemptId !== attemptId || turn.status !== 'pending') return false;
        if (!['ready', 'failed', 'cancelled'].includes(status)
          || (status === 'ready' && !parseChatReply(JSON.stringify({ messages })))) fail('invalid-chat-reply');
        Object.assign(turn, { status, assistant: status === 'ready' ? [...messages] : [],
          failure: status === 'ready' ? null : failureCode(failure), completedAt: Math.max(turn.at, now()) });
        if(status==='ready'){
          room.silences=(room.silences??[]).filter(receipt=>receipt.personaId!==turn.recipientId);
          acknowledgeChatScene(room,{messageId:turn.messageId,scopeKey:scopeOfTurn(turn),referenceRevision:room.referenceRevision??0,
            reply:{roomId:room.id,generation:room.generation??0,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index:0}});
        }
        room.revision += 1;
        const next = replace(room);
        return await commit(next, valid);
      });
    },
    cancel({ roomId, personaId, id, attemptId,messageId,attempts, epoch = 0 }) {
      return serial(async () => {
        const room = read(roomId??personaId), turn = room?.turns.find((t) => t.id === id);
        if (!acceptsEpoch(room,epoch)) fail('chat-conflict');
        if(attempts!==undefined&&(!validId(messageId)||!Array.isArray(attempts)||!attempts.length||attempts.length>CHAT_LIMITS.roundReplies
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
        if(roomId){room.turns=[];room.silences=[];room.excludedReferences=[];delete room.discussion;room.referenceRevision=(room.referenceRevision??0)+1;room.revision++;room.generation=state.epoch+1;next.rooms=next.rooms.map(r=>r.id===room.id?room:r);}
        else next.rooms = next.rooms.filter(r=>r.id!==room.id);
        if(!next.rooms.some(r=>r.id===next.activeRoomId))next.activeRoomId=next.rooms[0]?.id??null;
        next.epoch += 1;
        await commit(next); return true;
      });
    },
  };
}
