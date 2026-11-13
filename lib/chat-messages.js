import {createHash} from 'node:crypto';
import {quoteRef,quoteKey} from './chat-quote.js';
import {orderedChatResponses} from './chat-coordinator.js';

const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&value.trim()===value;
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const scopeOf=turn=>turn.scopeKey??turn.contextKey??null;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const cleanAuthor=turn=>id(turn.recipientId)&&text(turn.speakerName,80)?{role:'assistant',id:turn.recipientId,name:turn.speakerName}:null;
const selectedRecipients=values=>(Array.isArray(values)?values:[]).filter(p=>id(p?.id)&&text(p.name,80)).slice(0,8).map(({id,name})=>({id,name}));

/** One canonical public timeline. Control data and recalled references never pose as a speaker. */
export function buildActorTimeline({history=[],exchange=[],currentTurn,message,speaker,roomId,generation=0,scopeKey=null,
  recipients=[],replyTarget,quotedMessage,notes=[],discussion=[],inbox=[],excluded=[],scene,chars=18000}={}){
  const room=id(roomId)?roomId:'request-chat',actor=id(speaker?.id)?speaker.id:'request-actor';
  const current=currentTurn&&id(currentTurn.messageId)?currentTurn:{id:'current-user',messageId:'current-user',attemptId:'current-user',
    user:message,userParts:[{id:'current-user',text:message,at:0}],recipients,phase:'anchor',scopeKey};
  const currentId=current.messageId,groups=[],groupMap=new Map(),seenTurns=new Set();
  const addTurn=(turn,isCurrent=false)=>{
    if(!turn||!id(turn.messageId)||!id(turn.id)||!id(turn.attemptId)||!text(turn.user,4000)
      ||(turn.roomId!==undefined&&turn.roomId!==roomId)||(!isCurrent&&scopeOf(turn)!==scopeKey))return;
    const key=JSON.stringify([turn.id,turn.attemptId]);if(seenTurns.has(key))return;seenTurns.add(key);
    let group=groupMap.get(turn.messageId);if(!group){group={id:turn.messageId,head:turn,turns:[]};groupMap.set(group.id,group);groups.push(group);}
    group.turns.push(turn);if(isCurrent)group.head=turn;
  };
  for(const turn of Array.isArray(history)?history:[])addTurn(turn);
  addTurn(current,true);
  for(const turn of Array.isArray(exchange)?exchange:[])if(turn?.messageId===currentId)addTurn(turn);
  const events=[],refMap=new Map(),eventMap=new Map();
  const addEvent=event=>{if(!event.bubbles.length)return;event.eventId='e-'+hash([room,generation,event.key]);if(eventMap.has(event.eventId))return;eventMap.set(event.eventId,event);events.push(event);
    for(const bubble of event.bubbles){const key=quoteKey(bubble.ref);if(key&&!refMap.has(key))refMap.set(key,{event,bubble});}};
  for(const group of groups){
    const head=group.head,parts=Array.isArray(head.userParts)?head.userParts:null;
    const validParts=parts&&parts.length<=8&&new Set(parts.map(part=>part?.id)).size===parts.length
      &&parts.every(part=>id(part?.id)&&text(part.text,4000))&&parts.map(part=>part.text).join('\n')===head.user;
    const userParts=validParts?parts:parts?.length===0?[]:[{id:group.id,text:head.user}];
    for(let index=0;index<userParts.length;index++){
      const part=userParts[index],ref={roomId:room,generation,kind:'user',messageId:part.id};
      addEvent({key:['user',part.id],messageId:group.id,author:{role:'user',name:'我'},recipients:selectedRecipients(head.recipients),
        bubbles:[{index:0,text:part.text,ref}],at:part.at??head.at,current:group.id===currentId});
    }
    for(const turn of orderedChatResponses(group.turns)){
      const author=cleanAuthor(turn);
      if(turn.phase==='anchor'||turn.status!=='ready'||!author||!Array.isArray(turn.assistant)||!turn.assistant.length||turn.assistant.length>6
        ||turn.assistant.some(line=>!text(line,2000))||turn.assistant.reduce((sum,line)=>sum+line.length,0)>6000)continue;
      addEvent({key:['assistant',turn.id,turn.attemptId],messageId:group.id,author,turnId:turn.id,attemptId:turn.attemptId,
        bubbles:turn.assistant.map((text,index)=>({index,text,ref:{roomId:room,generation,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index}})),
        at:turn.completedAt??turn.at,current:group.id===currentId});
    }
  }
  const lookup=(ref,literal,author)=>{
    const normalized=quoteRef(ref),found=normalized&&refMap.get(quoteKey(normalized));if(!found)return null;
    if(author&&(author.role!==found.event.author.role||author.role==='assistant'&&author.id!==found.event.author.id))return null;
    const start=typeof literal==='string'?found.bubble.text.indexOf(literal):0;
    if(start<0||literal!==undefined&&!text(literal,4000))return null;
    return{...found,...(typeof literal==='string'&&literal!==found.bubble.text?{range:{start,end:start+literal.length}}:{})};
  };
  const excludedKeys=new Set((Array.isArray(excluded)?excluded:[]).map(quoteKey).filter(Boolean));
  const sceneLookup=(input,kind)=>{
    const ref=quoteRef(input);
    if(!ref||ref.kind!==kind||kind==='assistant'&&ref.index!==0)return null;
    const found=lookup(ref);if(!found)return null;
    const group=groupMap.get(found.event.messageId),owner=kind==='user'?group?.head:group?.turns.find(turn=>turn.id===ref.turnId&&turn.attemptId===ref.attemptId);
    if(!owner||scopeOf(owner)!==scopeKey||found.event.bubbles.some(bubble=>excludedKeys.has(quoteKey(bubble.ref))))return null;
    return found;
  };
  // Host binds the scene to a room/source revision. Resolve its public evidence
  // again here; a scene pointer cannot import missing or excluded history.
  const sceneSources=(()=>{
    if(!scene||scene.version!==1||!['fresh','continue','pause','resume'].includes(scene.relation)
      ||!Array.isArray(scene.relatedReplies)||scene.relatedReplies.length>32)return null;
    const trigger=sceneLookup(scene.trigger,'user'),focus=sceneLookup(scene.focus,'user'),parked=scene.parked===null?null:sceneLookup(scene.parked,'user');
    if(!trigger?.event.current||!focus||scene.parked!==null&&!parked)return null;
    const partsFor=(raw,root)=>{
      const originals=events.filter(event=>event.author.role==='user'&&event.messageId===root.event.messageId);
      const values=raw===undefined?originals.map(event=>event.bubbles[0].ref):raw;
      if(!Array.isArray(values)||!values.length||values.length>8)return null;
      const found=values.map(ref=>sceneLookup(ref,'user'));
      if(found.some(item=>!item||item.event.messageId!==root.event.messageId)
        ||new Set(found.map(item=>item.event.eventId)).size!==found.length||found.length!==originals.length
        ||!originals.every(event=>found.some(item=>item.event.eventId===event.eventId)))return null;
      return originals.map(event=>found.find(item=>item.event.eventId===event.eventId));
    };
    const triggerParts=partsFor(scene.triggerParts,trigger),focusParts=partsFor(scene.focusParts,focus);
    if(!triggerParts||!focusParts)return null;
    const activeUserGroups=[],activeGroupOmissions=[];
    if(scene.activeUserGroups!==undefined){
      if(!Array.isArray(scene.activeUserGroups)||scene.activeUserGroups.length>40)return null;
      for(const refs of scene.activeUserGroups){
        if(!Array.isArray(refs)||!refs.length)return null;
        const root=sceneLookup(refs[0],'user'),parts=root?partsFor(refs,root):null,owner=root?groupMap.get(root.event.messageId)?.head:null;
        if(!parts||events.indexOf(root.event)>events.findLastIndex(event=>event.current)
          ||Number.isSafeInteger(current.at)&&Number.isSafeInteger(owner?.at)&&owner.at>current.at)return null;
        const requiredRoot=[trigger.event.messageId,focus.event.messageId,sceneLookup(scene.transition?.trigger,'user')?.event.messageId].includes(root.event.messageId);
        const ownerTrigger=sceneLookup(owner?.scene?.trigger,'user');
        if(!requiredRoot&&(quoteKey(owner?.scene?.focus)!==quoteKey(scene.focus)||ownerTrigger?.event.messageId!==root.event.messageId)){
          activeGroupOmissions.push({part:'active-user-group',reason:'unavailable'});continue;
        }
        if(!activeUserGroups.some(group=>group[0].event.messageId===root.event.messageId))activeUserGroups.push(parts);
      }
    }
    let transition=null;
    if(scene.transition!==null){
      if(!scene.transition||typeof scene.transition!=='object')return null;
      const start=sceneLookup(scene.transition.trigger,'user'),reply=scene.transition.reply===null?null:sceneLookup(scene.transition.reply,'assistant');
      const replyGroup=reply?groupMap.get(reply.event.messageId)?.head:null;
      if(!start||scene.transition.reply!==null&&(!reply||events.indexOf(reply.event)<=events.indexOf(start.event)
        ||events.indexOf(reply.event)>events.findLastIndex(event=>event.current)
        ||Number.isSafeInteger(current.at)&&Number.isSafeInteger(replyGroup?.at)&&replyGroup.at>current.at))return null;
      const parts=partsFor(scene.transitionTriggerParts,start);if(!parts)return null;
      transition={trigger:start,triggerParts:parts,reply};
    }
    const related=[],omitted=[...activeGroupOmissions];
    if(Number.isSafeInteger(scene.omittedRelatedReplies)&&scene.omittedRelatedReplies>0)
      omitted.push({part:'related-reply',reason:'history-limit',count:Math.min(1024,scene.omittedRelatedReplies)});
    if(Number.isSafeInteger(scene.omittedActiveUserGroups)&&scene.omittedActiveUserGroups>0)
      omitted.push({part:'active-user-group',reason:'history-limit',count:Math.min(1024,scene.omittedActiveUserGroups)});
    for(const ref of scene.relatedReplies){
      const found=sceneLookup(ref,'assistant');
      if(!found){omitted.push({part:'related-reply',reason:'unavailable'});continue;}
      if(!related.some(value=>value.event.eventId===found.event.eventId))related.push(found);
    }
    return{relation:scene.relation,trigger,triggerParts,focus,focusParts,parked,transition,activeUserGroups,related,omitted};
  })();
  const target=(()=>{
    if(!replyTarget)return null;
    if(replyTarget.ref)return lookup(replyTarget.ref,replyTarget.text,replyTarget.author);
    // Old callers may supply a literal instead of a pointer. Accept only one
    // unambiguous real external source, never a made-up author or goal.
    if(!text(replyTarget.text,1600))return null;
    const matches=events.filter(event=>event.current&&event.author.role===replyTarget.author?.role
      &&(event.author.role==='user'||event.author.id===replyTarget.author.id&&event.author.id!==actor))
      .flatMap(event=>event.bubbles.filter(bubble=>bubble.text.includes(replyTarget.text)).map(bubble=>lookup(bubble.ref,replyTarget.text,replyTarget.author)));
    return matches.length===1?matches[0]:null;
  })();
  const externalTarget=target&&target.event.current&&(target.event.author.role==='user'||target.event.author.id!==actor)?target:null;
  const quoted=quotedMessage?lookup(quotedMessage.ref,quotedMessage.text,quotedMessage.author):null;
  const activeSceneGroups=sceneSources?.transition&&sceneSources.relation!=='fresh'?new Set([
    sceneSources.focus.event.messageId,sceneSources.trigger.event.messageId,sceneSources.transition.trigger.event.messageId,
    ...(sceneSources.transition.reply?[sceneSources.transition.reply.event.messageId]:[]),...sceneSources.related.map(found=>found.event.messageId),
    ...sceneSources.activeUserGroups.map(group=>group[0].event.messageId),
  ]):null;
  const activeSceneEvent=event=>!activeSceneGroups||activeSceneGroups.has(event.messageId);
  const inboxSources=(Array.isArray(inbox)?inbox:[]).flatMap(item=>(Array.isArray(item?.refs)?item.refs:[])
    .map(ref=>lookup(ref,undefined,item.author)).filter(found=>found&&found.event.author.id!==actor));
  const inactiveInboxEvents=new Set(inboxSources.filter(found=>!activeSceneEvent(found.event)).map(found=>found.event.eventId));
  const noteSources=(Array.isArray(notes)?notes:[]).map(note=>({note,source:lookup(note.ref,note.quote,note.author)})).filter(item=>item.source&&activeSceneEvent(item.source.event));
  const discussionSources=(Array.isArray(discussion)?discussion:[]).map(item=>({item,source:lookup(item.source?.ref,item.source?.text,item.source?.author),
    evidence:item.evidence?lookup(item.evidence.ref,item.evidence.text,item.evidence.author):null})).filter(value=>value.source&&activeSceneEvent(value.source.event)
      &&(!value.item.evidence||value.evidence&&activeSceneEvent(value.evidence.event)));
  const selected=new Set(),selectedEventIds=new Set();
  let remaining=Number.isSafeInteger(chars)&&chars>=0?Math.min(chars,24000):18000;
  const include=found=>{if(!found)return false;const key=quoteKey(found.bubble.ref);if(selected.has(key))return true;
    if(excludedKeys.has(key)||found.bubble.text.length>remaining||!selectedEventIds.has(found.event.eventId)&&selectedEventIds.size>=64)return false;
    selected.add(key);selectedEventIds.add(found.event.eventId);remaining-=found.bubble.text.length;return true;};
  // Current user originals and the exact current target outrank broad history.
  for(const event of events.filter(event=>event.current&&event.author.role==='user'))for(const bubble of event.bubbles)include({event,bubble});
  include(externalTarget);include(quoted);
  const sceneWholeEvents=new Set(),sceneWholeUsers=new Set();
  const includeSceneReply=found=>{
    if(!found)return;
    const event=found.event;sceneWholeEvents.add(event.eventId);
    const needed=event.bubbles.filter(bubble=>!selected.has(quoteKey(bubble.ref)));
    if(needed.some(bubble=>excludedKeys.has(quoteKey(bubble.ref)))||needed.reduce((sum,bubble)=>sum+bubble.text.length,0)>remaining
      ||!selectedEventIds.has(event.eventId)&&selectedEventIds.size>=64)return;
    for(const bubble of needed)include({event,bubble});
  };
  const includeSceneUsers=parts=>{
    for(const found of parts)sceneWholeUsers.add(found.event.eventId);
    const needed=parts.filter(found=>!selected.has(quoteKey(found.bubble.ref))),newEvents=new Set(needed.filter(found=>!selectedEventIds.has(found.event.eventId)).map(found=>found.event.eventId));
    if(needed.reduce((sum,found)=>sum+found.bubble.text.length,0)<=remaining&&selectedEventIds.size+newEvents.size<=64)for(const found of needed)include(found);
  };
  if(sceneSources){
    includeSceneUsers(sceneSources.triggerParts);includeSceneUsers(sceneSources.focusParts);
    if(sceneSources.transition)includeSceneUsers(sceneSources.transition.triggerParts);
    for(const parts of sceneSources.activeUserGroups.toReversed())includeSceneUsers(parts);
    includeSceneReply(sceneSources.transition?.reply);
    for(const found of sceneSources.related.toReversed())includeSceneReply(found);
  }
  // Implicit recall must not split a group which the scene admitted or omitted
  // atomically. Explicit targets and quotes kept their independent priority above.
  const includeRecall=found=>{if(found&&!sceneWholeUsers.has(found.event.eventId)&&!sceneWholeEvents.has(found.event.eventId))include(found);};
  for(const found of inboxSources)if(activeSceneEvent(found.event))includeRecall(found);
  for(const value of discussionSources){includeRecall(value.source);includeRecall(value.evidence);}
  for(const value of noteSources)includeRecall(value.source);
  const recentIds=new Set(groups.filter(group=>group.id!==currentId).slice(-8).map(group=>group.id));
  const recent=events.filter(event=>(event.current||recentIds.has(event.messageId))&&activeSceneEvent(event));
  // Whole bubbles only; equal text at different original pointers remains distinct.
  for(const event of recent.toReversed())if(!sceneWholeEvents.has(event.eventId)&&!sceneWholeUsers.has(event.eventId))for(const bubble of event.bubbles.toReversed())include({event,bubble});
  const messages=[],timeline=[];
  for(const event of events){
    const bubbles=event.bubbles.filter(bubble=>selected.has(quoteKey(bubble.ref)));if(!bubbles.length)continue;
    const own=event.author.role==='assistant'&&event.author.id===actor,messageIndex=messages.length;
    const body=own?{messages:bubbles.map(bubble=>bubble.text)}:{task:'chat-event',eventId:event.eventId,author:event.author,
      ...(event.author.role==='user'?{recipients:event.recipients}:{}),messages:bubbles.map(({index,text})=>({index,text}))};
    messages.push({id:'chat-'+hash([room,generation,actor,own?'assistant':'user',event.key,bubbles.map(bubble=>bubble.index)]),
      role:own?'assistant':'user',source:event.author.role==='assistant'?{kind:'model',provider:'persona-chat-history',model:'unknown'}:{kind:'user'},
      content:[{type:'text',text:JSON.stringify(body)}]});
    const metadata={eventId:event.eventId,messageIndex,messageId:event.messageId,author:event.author,
      // The event identifies an assistant turn and attempt once; repeating a
      // whole quoteRef for every short bubble would outweigh the actual chat.
      bubbles:bubbles.map(({index,ref})=>({index,...(event.author.role==='user'?{ref}:{})})),...(event.bubbles.length>bubbles.length?{omittedBubbles:event.bubbles.length-bubbles.length}:{}),
      ...(event.author.role==='user'?{recipients:event.recipients}:{turnId:event.turnId,attemptId:event.attemptId})};
    timeline.push(metadata);
  }
  const pointer=found=>found&&selected.has(quoteKey(found.bubble.ref))?{eventId:found.event.eventId,index:found.bubble.index,author:found.event.author,...(found.range?{range:found.range}:{})}:undefined;
  const reference=found=>{const selected=pointer(found);return selected?{ref:found.bubble.ref,author:found.event.author,pointer:selected}:undefined;};
  const conversationScene=(()=>{
    if(!sceneSources)return undefined;
    const omitted=[...sceneSources.omitted];
    if(inactiveInboxEvents.size)omitted.push({part:'inbox',reason:'inactive-scene',count:inactiveInboxEvents.size});
    const scenePointer=(found,part,whole=false)=>{
      if(!found)return null;
      const visible=pointer(found),complete=!whole||found.event.bubbles.every(bubble=>selected.has(quoteKey(bubble.ref)));
      if(!visible||!complete){omitted.push({part,reason:part==='parked'&&!activeSceneEvent(found.event)?'inactive-scene':'budget'});return null;}
      return visible;
    };
    const projectedParts=(values,part)=>{
      if(values.every(found=>!!pointer(found)))return values.map(found=>pointer(found));
      omitted.push({part,reason:'budget'});return[];
    };
    return{relation:sceneSources.relation,...(activeSceneGroups?{historySelection:'active-focus'}:{}),trigger:scenePointer(sceneSources.trigger,'trigger'),focus:scenePointer(sceneSources.focus,'focus'),
      triggerParts:projectedParts(sceneSources.triggerParts,'trigger-parts'),focusParts:projectedParts(sceneSources.focusParts,'focus-parts'),parked:scenePointer(sceneSources.parked,'parked'),
      transitionTriggerParts:sceneSources.transition?projectedParts(sceneSources.transition.triggerParts,'transition-trigger-parts'):[],
      activeUserGroups:sceneSources.activeUserGroups.map(parts=>projectedParts(parts,'active-user-group')).filter(parts=>parts.length),
      transition:sceneSources.transition?{trigger:scenePointer(sceneSources.transition.trigger,'transition-trigger'),
        reply:scenePointer(sceneSources.transition.reply,'transition-reply',true),acknowledged:!!sceneSources.transition.reply}:null,
      relatedReplies:sceneSources.related.map(found=>scenePointer(found,'related-reply',true)).filter(Boolean),omitted};
  })();
  const historyGroups=groups.filter(group=>group.id!==currentId&&(recentIds.has(group.id)||group.id===sceneSources?.parked?.event.messageId)).map(group=>{
    const responses=[];
    for(const turn of orderedChatResponses(group.turns).filter(turn=>turn.phase!=='anchor'&&cleanAuthor(turn)&&['pending','ready','failed','cancelled','interrupted'].includes(turn.status))){
      const event=timeline.find(event=>event.turnId===turn.id&&event.attemptId===turn.attemptId),omittedBubbles=turn.status==='ready'?(Array.isArray(turn.assistant)?turn.assistant.length:0)-(event?.bubbles.length??0):0;
      const previous=!event&&turn.status==='ready'&&responses.find(response=>response.eventId===null&&response.speaker.id===turn.recipientId&&response.status===turn.status);
      if(previous){previous.omittedBubbles+=omittedBubbles;previous.omittedReplies++;}
      else responses.push({speaker:{id:turn.recipientId,name:turn.speakerName},status:turn.status,eventId:event?.eventId??null,omittedBubbles,...(!event&&turn.status==='ready'?{omittedReplies:1}:{})});
    }
    const userEvents=timeline.filter(event=>event.messageId===group.id&&event.author.role==='user').map(event=>event.eventId),omittedUserParts=
      events.filter(event=>event.messageId===group.id&&event.author.role==='user').length-userEvents.length;
    return{messageId:group.id,userEvents,responses,...(activeSceneGroups&&!activeSceneGroups.has(group.id)?{bodyOmission:'inactive-scene',omittedUserParts}:{})};
  });
  const currentEvents=timeline.filter(event=>event.messageId===currentId&&event.author.role==='user').map(event=>event.eventId);
  const incoming=new Set();
  for(const item of Array.isArray(inbox)?inbox:[]){
    for(const ref of Array.isArray(item?.refs)?item.refs:[]){const found=lookup(ref,undefined,item.author);if(pointer(found)&&activeSceneEvent(found.event)&&found.event.author.id!==actor)incoming.add(found.event.eventId);}
  }
  return{messages,timeline,currentMessage:{messageId:currentId,eventIds:currentEvents,recipients:selectedRecipients(current.recipients??recipients)},
    history:historyGroups,historyCount:historyGroups.length,exchange:timeline.filter(event=>event.messageId===currentId&&event.author.role==='assistant').map(event=>event.eventId),
    inbox:[...incoming],...(pointer(externalTarget)?{replyTarget:pointer(externalTarget)}:{}),...(conversationScene?{conversationScene}:{}),
    ...(reference(quoted)?{quotedMessage:reference(quoted)}:{}),
    roomNotes:noteSources.map(({note,source})=>({...reference(source),messageId:note.messageId,recipients:selectedRecipients(note.recipients)})).filter(note=>note.pointer),
    discussionState:discussionSources.filter(({item,source,evidence})=>pointer(source)&&(!item.evidence||pointer(evidence)))
      .map(({item,source,evidence})=>({id:item.id,version:item.version,title:item.title,status:item.status,
        source:reference(source),evidence:reference(evidence)??null,reviewedBy:'user-in-settings'}))};
}

/** Append control separately. It is never persisted or represented as a character. */
export function appendChatControl(timeline,control){
  const value={task:'chat-control',schemaVersion:1,...control,timeline:timeline.timeline,currentMessage:timeline.currentMessage,
    history:timeline.history,historyCount:timeline.historyCount,exchange:timeline.exchange,inbox:timeline.inbox,
    ...(timeline.readingFocus?{readingFocus:timeline.readingFocus}:{}),
    roomNotes:timeline.roomNotes,discussionState:timeline.discussionState,...(timeline.replyTarget?{replyTarget:timeline.replyTarget}:{}),
    ...(timeline.quotedMessage?{quotedMessage:timeline.quotedMessage}:{}),...(timeline.conversationScene?{conversationScene:timeline.conversationScene}:{})};
  return{messages:[...timeline.messages,{role:'user',content:[{type:'text',text:JSON.stringify(value)}]}],control:value};
}
