// Test-only semantic view. Production sends the actual actor-relative messages.
// Assertions that need transport identity should inspect options.messages itself.
export function readChatInput(options){
  if(!options?.messages&&typeof options?.user==='string')return JSON.parse(options.user);
  const messages=options?.messages??[];let control;
  for(const message of messages.toReversed()){
    try{const value=JSON.parse(message.content.find(block=>block.type==='text').text);if(value.task==='chat-control'){control=value;break;}}catch{}
  }
  if(!control)return JSON.parse(messages[0]?.content?.find(block=>block.type==='text')?.text??'null');
  const events=new Map();
  for(const item of control.timeline){
    const packet=JSON.parse(messages[item.messageIndex].content.find(block=>block.type==='text').text);
    const bubbles=item.bubbles.map((bubble,index)=>({...bubble,text:typeof packet.messages[index]==='string'?packet.messages[index]:packet.messages.find(value=>value.index===bubble.index)?.text}));
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
