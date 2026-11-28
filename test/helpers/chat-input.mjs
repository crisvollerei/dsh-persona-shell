// Test-only semantic view. Production sends the actual actor-relative messages.
// Assertions that need transport identity should inspect options.messages itself.
export function readChatPacket(message) {
  if(message.role==='assistant')return {messages:message.content.map(block=>block.text)};
  const first=message.content[0].text;
  if(!first.startsWith('【'))return JSON.parse(first);
  let author,eventId;
  const messages=message.content.map(block=>{
    const [,label,id,index,body]=/^【(.+) (e\d+)\.(\d+)】\n  ([\s\S]*)$/u.exec(block.text);
    author=label==='用户'?{role:'user',name:'我'}:{role:'assistant',name:label.slice(3)};
    eventId=id;
    const text=body.replace(/(\r\n|[\r\n\u0085\u2028\u2029])  /gu,'$1');
    return {index:Number(index),text};
  });
  return {eventId,author,messages};
}

export function readChatInput(options){
  if(!options?.messages&&typeof options?.user==='string')return JSON.parse(options.user);
  const messages=options?.messages??[];let control;
  for(const message of messages.toReversed()){
    try{const value=JSON.parse(message.content.find(block=>block.type==='text').text);if(value.task==='chat-control'){control=value;break;}}catch{}
  }
  if(!control)return JSON.parse(messages[0]?.content?.find(block=>block.type==='text')?.text??'null');
  const events=new Map(), selfHistory=(control.selfHistory??[]).values();
  const packets=messages.slice(0,-1).map(message=>{
    const packet=readChatPacket(message);
    if(message.role!=='assistant')return packet;
    const location=selfHistory.next().value,eventId=typeof location==='string'?location:location.eventId;
    return {...packet,eventId,indices:location.indices??packet.messages.map((_,index)=>index),
      author:{role:'assistant',...(control.authors?.[eventId]??control.speaker)}};
  });
  const authorOf=packet=>control.authors?.[packet.eventId]??(packet.author.id ? {id:packet.author.id,name:packet.author.name}
    : control.participants?.find(p=>p.name===packet.author.name));
  const byId=new Map(packets.map(packet=>[packet.eventId,packet]));
  const groups=(control.history??[]).map(group=>({...group,responses:group.responses.map(value=>typeof value==='string'
    ? {eventId:value,speaker:authorOf(byId.get(value)),status:'ready',omittedBubbles:0}:value)}));
  const timeline=packets.map((packet,messageIndex)=>{
    const historical=groups.find(group=>group.userEvents.includes(packet.eventId)||group.responses.some(s=>s.eventId===packet.eventId));
    const response=historical?.responses.find(s=>s.eventId===packet.eventId),messageId=historical?.messageId??control.currentMessage.messageId;
    const member=response?.speaker??authorOf(packet);
    const author=packet.author.role==='assistant'?{...packet.author,...member}:packet.author;
    return {eventId:packet.eventId,author,messageId,messageIndex,recipients:historical?(historical.recipients??[]):control.currentMessage.recipients,
      bubbles:packet.messages.map((bubble,i)=>({index:packet.indices?.[i]??bubble.index})),
      ...(response?.omittedBubbles?{omittedBubbles:response.omittedBubbles}:{})};
  });
  control={sharedResponse:{priorReplyEvents:[]},...control,timeline,history:groups,historyCount:groups.length,exchange:timeline.filter(e=>e.messageId===control.currentMessage.messageId&&e.author.role==='assistant').map(e=>e.eventId),
    inbox:control.inbox??[],roomNotes:control.roomNotes??[],discussionState:control.discussionState??[]};
  for(const item of timeline){
    const packet=packets[item.messageIndex];
    const bubbles=item.bubbles.map((bubble,index)=>({...bubble,text:typeof packet.messages[index]==='string'?packet.messages[index]:packet.messages[index].text}));
    events.set(item.eventId,{...item,bubbles,messages:bubbles.map(bubble=>bubble.text)});
  }
  const resolve=pointer=>{const event=events.get(pointer?.eventId),bubble=event?.bubbles.find(bubble=>bubble.index===pointer.index);
    if(!bubble)return undefined;return pointer.range?bubble.text.slice(pointer.range.start,pointer.range.end):bubble.text;};
  const ref=value=>value?{...value,text:resolve(value.pointer)}:value;
  const history=control.history.map(group=>{
    const user=group.userEvents.map(eventId=>events.get(eventId)?.messages.join('\n')??'').join('\n'),responses=group.responses.map(response=>({speaker:response.speaker,
      assistant:events.get(response.eventId)?.messages??[],status:response.status,...(response.omittedBubbles?{omittedBubbles:response.omittedBubbles}:{})}));
    const value={user,recipients:events.get(group.userEvents[0])?.recipients??[]};
    if(responses.length===1){const response=responses[0];Object.assign(value,{assistant:response.assistant,status:response.status,recipient:response.speaker,...(response.omittedBubbles?{omittedBubbles:response.omittedBubbles}:{})});}
    else value.responses=responses;
    if(responses.some(response=>response.omittedBubbles))value.partiallyOmitted=true;return value;
  });
  const target=control.replyTarget?{author:control.replyTarget.author,text:resolve(control.replyTarget)}:undefined;
  return{...control,message:control.currentMessage.eventIds.map(eventId=>events.get(eventId)?.messages.join('\n')??'').join('\n'),history,
    exchange:control.exchange.map(eventId=>events.get(eventId)).filter(Boolean).map(event=>({speaker:{id:event.author.id,name:event.author.name},messages:event.messages,...(event.omittedBubbles?{earlierBubblesOmitted:true}:{})})),
    inbox:control.inbox.map(eventId=>events.get(eventId)).filter(Boolean).map(event=>({author:event.author,messages:event.messages})),
    ...(target?{replyTarget:target}:{}),responsePlan:control.responsePlan?{...control.responsePlan,...(target?{evidence:target.text}:{})}:undefined,
    roomNotes:control.roomNotes.map(note=>({...note,quote:resolve(note.pointer)})),
    ...(control.quotedMessage?{quotedMessage:ref(control.quotedMessage)}:{}),
    discussionState:control.discussionState.map(item=>({...item,source:ref(item.source),evidence:ref(item.evidence)})),
    __control:control,__events:events};
}
