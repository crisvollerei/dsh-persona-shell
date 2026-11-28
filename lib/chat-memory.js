import { quoteKey, resolveChatQuote } from './chat-quote.js';

export const isMemoryRoom = id => typeof id === 'string' && (id.startsWith('room:') || /^chat:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id));
export const memoryChannel = e => e.origin === 'chat' ? 'chat-message'
  : e.chatOnly === true || isMemoryRoom(e.sessionId) ? 'chat-settings' : 'general';
export function matchesChatEvidence(entry, evidence) {
  const quotes = evidence.filter(ref => ref?.source === 'message');
  return entry.scope !== 'shared' && quotes.length > 0 && quotes.every(ref => isMemoryRoom(ref.sessionId)
    && (entry.scope !== 'session' || ref.sessionId === entry.sessionId));
}
export const personalChatMemory = entry => ['context', 'episode'].includes(entry.kind)
  || (entry.kind === 'agreement' && memoryChannel(entry) !== 'general');

export function candidateSources(room, scopeKey, entries, availableMembers = room.memberIds) {
  const seen = new Set(entries.flatMap(e=>e.evidence.filter(r=>r.sessionId===room.id).map(r=>r.eventId)));
  const paused=new Set((room.excludedReferences??[]).map(quoteKey));
  const result=[];
  for(const head of room.turns.filter(t=>t.phase==='anchor' && (t.scopeKey??t.contextKey??null)===scopeKey).slice(-12)) {
    if (head.quote || (head.scene && head.scene.relation!=='fresh')) continue;
    const recipients = head.recipients.map(p => p.id);
    if (recipients.some(id => !room.memberIds.includes(id) || !availableMembers.includes(id))) continue;
    if (recipients.length > 1 && room.memberIds.some(id => !recipients.includes(id))) continue;
    for(const [part,p] of (head.userParts??[{text:head.user}]).entries()) {
      const id=head.messageId+'#'+part;
      if(paused.has(quoteKey({roomId:room.id,generation:room.generation??0,kind:'user',messageId:p.id??head.messageId})))continue;
      if (seen.has(id) || !p.text?.trim() || p.text.length>1000 || /[？?]|假如|假设|如果|(?:吗|么|呢)[。！!]?$/u.test(p.text)) continue;
      result.push({id,text:p.text,messageId:head.messageId,part,personaId:recipients.length===1 ? recipients[0] : null});
    }
  }
  return result.slice(-12);
}

export function verifiedCandidates(proposals,sources,room,scopeKey) {
  if (!Array.isArray(proposals) || proposals.length>3) throw Error('chat-memory-source');
  const used=new Set();
  return proposals.map(p=>{
    const source=sources.find(s=>s.id===p?.eventId);
    if(!source || used.has(source.id) || source.text!==p.quote || !['agreement','episode'].includes(p.kind)
      || typeof p.content!=='string' || !p.content.trim() || p.content.length>240 || !['room','persona'].includes(p.scope)
      || p.scope !== (source.personaId ? 'persona' : 'room'))throw Error('chat-memory-source');
    used.add(source.id);
    return chatMemorySource(room,scopeKey,{room:room.id,generation:room.generation,scopeKey,messageId:source.messageId,part:source.part,
      personaId:source.personaId,kind:p.kind,scope:p.scope,content:p.content});
  });
}

export function chatMemorySource(room, scopeKey, body) {
  if (!room || room.id !== body.room || !Number.isSafeInteger(body.part) || body.part < 0
    || (body.scopeKey !== undefined && body.scopeKey !== scopeKey)) throw Error('chat-memory-source');
  const head = room.turns.find(t => t.messageId === body.messageId);
  const part = head?.userParts?.[body.part] ?? (!head?.userParts && body.part === 0 && head ? { id: head.messageId } : null);
  const source = part && resolveChatQuote(room, { kind: 'user', roomId: room.id,
    messageId: part.id, generation: body.generation ?? room.generation }, scopeKey);
  if (!source || room.excludedReferences?.some(ref=>quoteKey(ref)===quoteKey(source.ref))) throw Error('chat-memory-source');
  if (!['agreement', 'episode'].includes(body.kind) || !['persona', 'room'].includes(body.scope)) throw Error('invalid-memory-entry');
  if (body.scope === 'persona' && !room.memberIds.includes(body.personaId)) throw Error('chat-memory-member');
  const { start = 0, end = source.text.length } = body;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > source.text.length || end <= start)
    throw Error('chat-memory-source');
  const quote = source.text.slice(start, end);
  if (!quote.trim()) throw Error('chat-memory-source');
  let contextRef;
  if(body.includeReply===true){
    const adjacent=room.turns.find(t=>t.messageId===head.messageId && t.phase!=='anchor' && t.status==='ready' && t.assistant?.length);
    const ref=adjacent && {kind:'assistant',roomId:room.id,generation:room.generation??0,turnId:adjacent.id,attemptId:adjacent.attemptId,index:0};
    if(!ref || !resolveChatQuote(room,ref,scopeKey) || room.excludedReferences?.some(r=>quoteKey(r)===quoteKey(ref))) throw Error('chat-memory-source');
    contextRef=ref;
  }
  return {contextRef, entry: { kind: body.kind, content: body.content ?? quote, tags:body.tags, occurredAt:body.occurredAt, expiresAt:body.expiresAt,
    ...(body.scope === 'room' ? { scope: 'session', sessionId: room.id } : { scope: 'persona', personaId: body.personaId }) },
    evidence: { eventId: `${head.messageId}#${body.part}`, quote, source: 'message',
      complete: start === 0 && end === source.text.length, sessionId: room.id } };
}
