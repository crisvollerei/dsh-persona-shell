const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const scopeOf = turn => turn.scopeKey ?? turn.contextKey ?? null;

export function quoteRef(value) {
  if (!value || !id(value.roomId)) return null;
  const generation=value.generation??0;if(!Number.isSafeInteger(generation)||generation<0)return null;
  if (value.kind === 'user' && id(value.messageId)) return { roomId:value.roomId,generation, kind:'user', messageId:value.messageId };
  if (value.kind === 'assistant' && id(value.turnId) && id(value.attemptId) && Number.isSafeInteger(value.index) && value.index >= 0 && value.index < 6)
    return { roomId:value.roomId,generation, kind:'assistant', turnId:value.turnId, attemptId:value.attemptId, index:value.index };
  return null;
}
export const quoteKey = value => { const ref=quoteRef(value);return ref?JSON.stringify(ref):null; };

/** Resolve only public, committed room messages. Client-provided authors and text are never evidence. */
export function resolveChatQuote(room, input, scope) {
  const ref=quoteRef(input);if(!room||!ref||ref.roomId!==room.id||ref.generation!==(room.generation??0))return null;
  const turn=ref.kind==='user'?room.turns.find(t=>t.messageId===ref.messageId||t.userParts?.some(p=>p.id===ref.messageId)):room.turns.find(t=>t.id===ref.turnId&&t.attemptId===ref.attemptId);
  if(!turn||scopeOf(turn)!==scope)return null;
  const text=ref.kind==='user'?(turn.userParts?.find(p=>p.id===ref.messageId)?.text??turn.user):turn.status==='ready'?turn.assistant[ref.index]:undefined;
  if(typeof text!=='string'||!text.trim()||text.length>4000)return null;
  return {ref, author:ref.kind==='user'?{role:'user',name:'我'}:{role:'assistant',id:turn.recipientId,name:turn.speakerName},text};
}

export function restoredChatQuote(value, roomId) {
  const ref=quoteRef(value?.ref),author=value?.author;
  if(!ref||ref.roomId!==roomId||typeof value.text!=='string'||!value.text.trim()||value.text.length>4000
    ||!author||!['user','assistant'].includes(author.role)||typeof author.name!=='string'||author.name.length>80
    ||(author.role==='assistant'&&!id(author.id))||author.role!==ref.kind)return null;
  return {ref,author:author.role==='user'?{role:'user',name:'我'}:{role:'assistant',id:author.id,name:author.name},text:value.text};
}
