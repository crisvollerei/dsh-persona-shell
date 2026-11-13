/** Images use the Host attachment store; room state contains references, never encoded uploads. */
export const CHAT_IMAGE_LIMITS = Object.freeze({ count: 3, contextCount: 6, bytes: 4 * 1024 * 1024, total: 8 * 1024 * 1024, request: 12 * 1024 * 1024 });
const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw Error('invalid-chat-images'); };
const nameOf = name => typeof name === 'string' ? name.split(/[\\/]/u).at(-1).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 100) : undefined;
export function imageInputStatus(model) {
  return Array.isArray(model?.inputModalities) ? model.inputModalities.includes('image') ? 'supported' : 'unsupported' : 'unknown';
}
export function normalizeChatImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CHAT_IMAGE_LIMITS.count) fail();
  return value.map(ref => {
    if (!plain(ref) || Object.keys(ref).some(k => !['attachmentId','mediaType','bytes','width','height','name','originalDimensions'].includes(k))
      || typeof ref.attachmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(ref.attachmentId) || !types.has(ref.mediaType)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 20 * 1024 * 1024
      || ![ref.width,ref.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384)
      || ref.width * ref.height > 50 * 1024 * 1024) fail();
    return { attachmentId:ref.attachmentId,mediaType:ref.mediaType,bytes:ref.bytes,width:ref.width,height:ref.height,
      ...(nameOf(ref.name)?{name:nameOf(ref.name)}:{}) };
  });
}
export function decodeChatImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > CHAT_IMAGE_LIMITS.count) fail();
  let total = 0;
  return value.map(image => {
    if (!plain(image) || Object.keys(image).some(k => !['mediaType','data','name'].includes(k)) || !types.has(image.mediaType)
      || typeof image.data !== 'string' || image.data.length > Math.ceil(CHAT_IMAGE_LIMITS.bytes / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)) fail();
    const data = Buffer.from(image.data,'base64');
    if (!data.length || data.length > CHAT_IMAGE_LIMITS.bytes || data.toString('base64') !== image.data
      || (total += data.length) > CHAT_IMAGE_LIMITS.total) fail();
    return {data,mediaType:image.mediaType,...(nameOf(image.name)?{name:nameOf(image.name)}:{})};
  });
}
export const sameChatImages = (left,right) => JSON.stringify(normalizeChatImages(left)) === JSON.stringify(normalizeChatImages(right));
/** Only a current message, or the two nearest prior user messages in the same source scope. */
export function selectChatImages(room, messageId, scopeKey) {
  const groups = [];
  for (const turn of room?.turns ?? []) {
    if ((turn.scopeKey ?? turn.contextKey ?? null) !== scopeKey || groups.some(g => g.messageId === turn.messageId)) continue;
    groups.push(turn);
  }
  const current = groups.findIndex(t => t.messageId === messageId);
  if (current < 0) return [];
  if(groups[current].userParts?.some(p=>p.withoutImages===true))return [];
  const selected = [];
  const add = (part) => {
    for(const [index,attachment] of normalizeChatImages(part.images).entries()){
      if(selected.length>=CHAT_IMAGE_LIMITS.contextCount)return;
      if(!selected.some(i=>i.messageId===part.id&&i.index===index))selected.push({messageId:part.id,index,attachment});
    }
  };
  for(const part of groups[current].userParts??[])add(part);
  const quoted=groups[current].quote?.ref;
  if(quoted?.kind==='user'&&quoted.roomId===room.id&&quoted.generation===(room.generation??0)){
    const part=groups.flatMap(t=>t.userParts??[]).find(p=>p.id===quoted.messageId);
    if(part)add(part);
  }
  if(selected.length)return selected;
  for (const turn of groups.slice(Math.max(0,current-2),current+1).reverse()) {
    if(turn.messageId!==messageId&&room.turns.some(t=>t.messageId===turn.messageId&&['vision','image-unavailable'].includes(t.failure)))continue;
    for (const part of turn.userParts ?? [])add(part);
    if (selected.length) break;
  }
  return selected;
}
export function appendChatImages(messages, images) {
  if (!images.length) return messages;
  const result = messages.map(m => ({...m,content:[...m.content]})), target = result.findLast(m => m.role === 'user');
  if (!target) throw Error('chat-images-unavailable');
  for (const image of images) target.content.push(
    {type:'text',text:JSON.stringify({userImage:{messageId:image.messageId,index:image.index+1}})},
    {type:'image',attachment:image.attachment});
  target.content.push({type:'text',text:'以上图片属于标注的用户消息。仅根据实际可见的图像作答；若没有收到可读图像，请说明，不能把文件名或同伴描述当成自己看见的内容。'});
  return result;
}
