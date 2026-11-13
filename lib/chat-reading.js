/** A request-local reading view. Public chronology and every admitted original stay intact. */
export function focusChatReading(timeline){
  const messages=timeline?.messages,events=timeline?.timeline,current=timeline?.currentMessage,target=timeline?.replyTarget;
  if(!Array.isArray(messages)||!Array.isArray(events)||messages.length!==events.length||!target
    ||!Array.isArray(current?.eventIds)||!current.eventIds.length)return timeline;
  const byId=new Map(),indices=new Set();
  try{
    for(const event of events){
      const index=event?.messageIndex,message=messages[index];
      if(typeof event?.eventId!=='string'||byId.has(event.eventId)||!['user','assistant'].includes(event.author?.role)||!Number.isInteger(index)||index<0||index>=messages.length||indices.has(index)
        ||!Array.isArray(event.bubbles)||!event.bubbles.length||message?.content?.length!==1||message.content[0].type!=='text')return timeline;
      const packet=JSON.parse(message.content[0].text);
      if(!Array.isArray(packet.messages)||packet.messages.length!==event.bubbles.length)return timeline;
      if(message.role==='user'){
        if(packet.task!=='chat-event'||packet.eventId!==event.eventId||packet.author?.role!==event.author?.role
          ||packet.author?.id!==event.author?.id||event.bubbles.some(bubble=>!packet.messages.some(value=>value.index===bubble.index&&typeof value.text==='string')))return timeline;
      }else if(message.role!=='assistant'||event.author?.role!=='assistant'||packet.messages.some(value=>typeof value!=='string'))return timeline;
      byId.set(event.eventId,event);indices.add(index);
    }
  }catch{return timeline;}
  const userEvents=current.eventIds.map(id=>byId.get(id)),targetEvent=byId.get(target.eventId);
  if(new Set(current.eventIds).size!==current.eventIds.length||userEvents.some(event=>!event||event.author.role!=='user'||event.messageId!==current.messageId)
    ||!targetEvent||!targetEvent.bubbles.some(bubble=>bubble.index===target.index)
    ||target.author?.role!==targetEvent.author.role||target.author?.id!==targetEvent.author.id)return timeline;
  const peers=events.filter(event=>event.author.role==='assistant'&&messages[event.messageIndex].role==='user');
  if(!peers.length||targetEvent.author.role==='user'&&!current.eventIds.includes(targetEvent.eventId)
    ||targetEvent.author.role==='assistant'&&!peers.includes(targetEvent))return timeline;
  // Keep a coalesced user's entire admitted group in its original part order.
  const userSet=new Set(current.eventIds),usersInOrder=events.filter(event=>userSet.has(event.eventId));
  const peerTarget=targetEvent.author.role==='assistant'?targetEvent:null;
  const focused=new Set([...usersInOrder.map(event=>event.messageIndex),...(peerTarget?[peerTarget.messageIndex]:[])]);
  const order=messages.map((_,index)=>index).filter(index=>!focused.has(index));
  order.push(...usersInOrder.map(event=>event.messageIndex),...(peerTarget?[peerTarget.messageIndex]:[]));
  if(order.length!==messages.length||new Set(order).size!==messages.length)return timeline;
  const positions=new Map(order.map((index,next)=>[index,next]));
  const explicitReferences=new Set([timeline.quotedMessage?.pointer?.eventId,
    ...(timeline.discussionState??[]).flatMap(item=>[item.source?.pointer?.eventId,item.evidence?.pointer?.eventId]),
    ...(timeline.roomNotes??[]).map(item=>item.pointer?.eventId)].filter(Boolean));
  return{...timeline,messages:order.map(index=>messages[index]),timeline:events.map(event=>({...event,messageIndex:positions.get(event.messageIndex),
    contextRole:userSet.has(event.eventId)?'current-user':event.eventId===peerTarget?.eventId?'reply-target':event.author.role==='user'?'earlier-user':
      messages[event.messageIndex].role==='assistant'?'self-history':explicitReferences.has(event.eventId)?'referenced-peer':'peer-background'})),
    readingFocus:{version:1,currentUserEventIds:usersInOrder.map(event=>event.eventId),targetEventId:targetEvent.eventId}};
}
