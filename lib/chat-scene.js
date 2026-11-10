import {quoteRef,quoteKey,resolveChatQuote} from './chat-quote.js';

export const CHAT_SCENE_LIMITS=Object.freeze({topics:4,chars:6000,responses:6,relatedReplies:12,activeUserGroups:40});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200;
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const scopeOf=turn=>turn.scopeKey??turn.contextKey??null;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const keys=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const strictRef=value=>{const ref=quoteRef(value);return ref&&keys(value,Object.keys(ref))&&Object.keys(ref).every(key=>value[key]===ref[key])?ref:null;};
const userRef=(room,anchor)=>({roomId:room.id,generation:room.generation??0,kind:'user',messageId:anchor.messageId});
const replyRef=(room,turn)=>({roomId:room.id,generation:room.generation??0,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index:0});
const ready=turn=>turn?.phase!=='anchor'&&turn?.status==='ready'&&id(turn.recipientId)&&text(turn.speakerName,80)
  &&Array.isArray(turn.assistant)&&turn.assistant.length>0&&turn.assistant.length<=6&&turn.assistant.every(value=>text(value,2000))
  &&turn.assistant.reduce((sum,value)=>sum+value.length,0)<=6000;
const exclusions=room=>new Set((Array.isArray(room?.excludedReferences)?room.excludedReferences:[]).map(quoteKey).filter(Boolean));
const publicRef=(room,ref,scope,excluded)=>{const normalized=strictRef(ref);return normalized&&!excluded.has(quoteKey(normalized))
  &&resolveChatQuote(room,normalized,scope)?normalized:null;};
function normalScene(value){
  if(!keys(value,['version','trigger','relation','focus','parked','transition'])||value.version!==1
    ||!['fresh','continue','pause','resume'].includes(value.relation))return null;
  const trigger=strictRef(value.trigger),focus=strictRef(value.focus),parked=value.parked===null?null:strictRef(value.parked);
  if(trigger?.kind!=='user'||focus?.kind!=='user'||value.parked!==null&&parked?.kind!=='user')return null;
  let transition=null;
  if(value.transition!==null){
    if(!keys(value.transition,['trigger','reply']))return null;
    const source=strictRef(value.transition.trigger),reply=value.transition.reply===null?null:strictRef(value.transition.reply);
    if(source?.kind!=='user'||value.transition.reply!==null&&(reply?.kind!=='assistant'||reply.index!==0))return null;
    transition={trigger:source,reply};
  }
  return{version:1,trigger,relation:value.relation,focus,parked,transition};
}
function partsFor(room,anchor,scope,excluded){
  const parts=Array.isArray(anchor.userParts)&&anchor.userParts.length?anchor.userParts:[{id:anchor.messageId,text:anchor.user}];
  if(parts.length>8||parts[0]?.id!==anchor.messageId||parts.map(part=>part?.text).join('\n')!==anchor.user)return[];
  const result=[];
  for(const part of parts){const ref={...userRef(room,anchor),messageId:part.id};
    if(!id(part.id)||!text(part.text,4000)||!publicRef(room,ref,scope,excluded))return[];
    result.push({ref,text:part.text});}
  return result;
}
function context(room,{messageId,scopeKey,referenceRevision=room?.referenceRevision??0}={}){
  if(!room||!id(room.id)||!Array.isArray(room.turns)||(scopeKey!==null&&!id(scopeKey))
    ||!Number.isSafeInteger(referenceRevision)||referenceRevision!==(room.referenceRevision??0))return null;
  const excluded=exclusions(room),anchors=room.turns.filter(turn=>turn.phase==='anchor'&&turn.recipientId==='user'
    &&id(turn.messageId)&&scopeOf(turn)===scopeKey&&partsFor(room,turn,scopeKey,excluded).length);
  const current=anchors.find(anchor=>anchor.messageId===messageId);
  if(!current||room.turns.at(-1)?.messageId!==messageId)return null;
  return{room,messageId,scopeKey,referenceRevision,excluded,anchors,current};
}
const fresh=(room,anchor)=>({version:1,trigger:userRef(room,anchor),relation:'fresh',focus:userRef(room,anchor),parked:null,transition:null});
const groupReplies=(ctx,anchor)=>ctx.room.turns.filter(turn=>turn.messageId===anchor.messageId&&scopeOf(turn)===ctx.scopeKey&&ready(turn)
  &&turn.assistant.every((_,index)=>!ctx.excluded.has(quoteKey({...replyRef(ctx.room,turn),index}))));
function frameReferencesValid(ctx,frame,anchor){
  if(!same(frame.trigger,userRef(ctx.room,anchor)))return false;
  for(const ref of [frame.trigger,frame.focus,frame.parked,frame.transition?.trigger,frame.transition?.reply].filter(Boolean)){
    if(!publicRef(ctx.room,ref,ctx.scopeKey,ctx.excluded))return false;
    const owner=ref.kind==='user'?ctx.anchors.find(item=>partsFor(ctx.room,item,ctx.scopeKey,ctx.excluded).some(part=>same(part.ref,ref))):null;
    if(ref.kind==='user'&&(!owner||ctx.anchors.indexOf(owner)>ctx.anchors.indexOf(anchor)))return false;
  }
  return true;
}
function rootsBefore(ctx,anchor,frames){
  const roots=[],seen=new Set();
  for(const item of ctx.anchors.slice(0,ctx.anchors.indexOf(anchor)).reverse()){
    const frame=frames.get(item.messageId)??fresh(ctx.room,item),key=quoteKey(frame.focus);
    if(seen.has(key))continue;
    const root=ctx.anchors.find(value=>same(userRef(ctx.room,value),frame.focus));
    if(!root||!partsFor(ctx.room,root,ctx.scopeKey,ctx.excluded).length)continue;
    seen.add(key);roots.push({anchor:root,frame,last:item});
  }
  return roots;
}
function optionsFor(ctx,anchor,frames){
  const options=[{key:'F',relation:'fresh',frame:fresh(ctx.room,anchor)}],roots=rootsBefore(ctx,anchor,frames).slice(0,CHAT_SCENE_LIMITS.topics);
  const active=roots[0]?.frame??null;
  for(let i=0;i<roots.length;i++){
    const {frame}=roots[i],target='t'+(i+1),trigger=userRef(ctx.room,anchor);
    options.push({key:'C'+(i+1),relation:'continue',target,frame:{...frame,trigger,relation:'continue'}});
    options.push({key:'P'+(i+1),relation:'pause',target,frame:{version:1,trigger,relation:'pause',focus:trigger,parked:frame.focus,transition:{trigger,reply:null}}});
    options.push({key:'R'+(i+1),relation:'resume',target,frame:{version:1,trigger,relation:'resume',focus:frame.focus,
      parked:active&&!same(active.focus,frame.focus)?active.focus:frame.parked,transition:{trigger,reply:null}}});
  }
  return{options,roots};
}
function acceptsSaved(ctx,anchor,scene,options){
  const normalized=normalScene(scene);if(!normalized||!frameReferencesValid(ctx,normalized,anchor))return null;
  for(const option of options){
    const expected=option.frame;if(same(normalized,expected))return normalized;
    if(expected.transition?.reply===null&&normalized.transition?.reply){
      const withoutAck={...normalized,transition:{...normalized.transition,reply:null}};
      if(!same(withoutAck,expected))continue;
      if(groupReplies(ctx,anchor).some(turn=>same(replyRef(ctx.room,turn),normalized.transition.reply)))return normalized;
    }
  }
  return null;
}
function savedFrames(ctx){
  const frames=new Map();
  for(const anchor of ctx.anchors){
    if(anchor.sceneReferenceRevision!==ctx.referenceRevision||anchor.sceneSourceVersion!==(ctx.room.sourceVersion??0))continue;
    const frame=acceptsSaved(ctx,anchor,anchor.scene,optionsFor(ctx,anchor,frames).options);
    if(frame)frames.set(anchor.messageId,frame);
  }
  return frames;
}
function repliesFor(ctx,frame,frames){
  const focus=quoteKey(frame.focus),ids=new Set([ctx.messageId]);
  for(const anchor of ctx.anchors){
    const own=frames.get(anchor.messageId)??fresh(ctx.room,anchor);
    if(quoteKey(own.focus)===focus)ids.add(anchor.messageId);
    if(anchor.messageId===ctx.messageId)break;
  }
  return ctx.room.turns.filter(turn=>ids.has(turn.messageId)&&scopeOf(turn)===ctx.scopeKey&&ready(turn)
    &&turn.assistant.every((_,index)=>!ctx.excluded.has(quoteKey({...replyRef(ctx.room,turn),index}))));
}

/** Host-only finite catalogue. All text is original public text; frames contain refs only. */
export function buildChatSceneCatalog(room,params={}){
  const ctx=context(room,params);if(!ctx)return{options:[],topics:[],current:null,omittedTopics:0};
  const frames=savedFrames(ctx),existing=frames.get(ctx.messageId),available=optionsFor(ctx,ctx.current,frames),roots=rootsBefore(ctx,ctx.current,frames);
  const topics=[];let chars=0,responseCount=0;
  for(let index=0;index<Math.min(roots.length,CHAT_SCENE_LIMITS.topics);index++){
    const root=roots[index],parts=partsFor(room,root.anchor,ctx.scopeKey,ctx.excluded),size=parts.reduce((sum,part)=>sum+part.text.length,0);
    if(chars+size>CHAT_SCENE_LIMITS.chars)continue;
    chars+=size;topics.push({id:'t'+(index+1),ref:root.frame.focus,text:parts[0].text,parts,responses:[],omittedResponses:0,_frame:root.frame});
  }
  for(const topic of topics){
    const replies=repliesFor({...ctx,messageId:ctx.current.messageId},topic._frame,frames).filter(turn=>turn.messageId!==ctx.messageId);
    for(const turn of replies.slice().reverse()){
      const size=turn.assistant.reduce((sum,line)=>sum+line.length,0);
      if(responseCount>=CHAT_SCENE_LIMITS.responses||chars+size>CHAT_SCENE_LIMITS.chars){topic.omittedResponses++;continue;}
      topic.responses.unshift({ref:replyRef(room,turn),author:{role:'assistant',id:turn.recipientId,name:turn.speakerName},messages:[...turn.assistant]});chars+=size;responseCount++;
    }
    delete topic._frame;
  }
  const topicIds=new Set(topics.map(topic=>topic.id)),options=existing?[{key:'K',relation:existing.relation,frame:existing}]
    :available.options.filter(option=>!option.target||topicIds.has(option.target));
  return{options,topics,current:existing?projectChatScene(room,params):null,omittedTopics:Math.max(0,roots.length-topics.length)};
}

/** A model chooses a key; authority is rebuilt against the current room. */
export function selectChatScene(room,{key,...params}={}){
  if(typeof key!=='string')return null;
  return buildChatSceneCatalog(room,params).options.find(option=>option.key===key)?.frame??null;
}

/** Revalidate stored refs every time. No private memory or source body is copied. */
export function projectChatScene(room,params={}){
  const ctx=context(room,params);if(!ctx)return null;
  const frames=savedFrames(ctx),frame=frames.get(ctx.messageId);if(!frame)return null;
  const replies=repliesFor(ctx,frame,frames),selected=replies.slice(-CHAT_SCENE_LIMITS.relatedReplies),root=ctx.anchors.find(anchor=>same(userRef(room,anchor),frame.focus));
  const active=ctx.anchors.slice(0,ctx.anchors.indexOf(ctx.current)+1).filter(anchor=>anchor===root||anchor===ctx.current
    ||same(frames.get(anchor.messageId)?.focus,frame.focus));
  let activeAnchors=active.slice(-CHAT_SCENE_LIMITS.activeUserGroups);
  // The selected focus is an explicit authorized root even if its original
  // frame predates this feature. Unknown intermediate anchors never join it.
  if(root&&!activeAnchors.includes(root))activeAnchors=[root,...activeAnchors.slice(1)];
  const activeUserGroups=activeAnchors.map(anchor=>partsFor(room,anchor,ctx.scopeKey,ctx.excluded).map(part=>part.ref));
  const transitionRoot=frame.transition?ctx.anchors.find(anchor=>same(userRef(room,anchor),frame.transition.trigger)):null;
  return{...frame,focusParts:partsFor(room,root,ctx.scopeKey,ctx.excluded).map(part=>part.ref),
    triggerParts:partsFor(room,ctx.current,ctx.scopeKey,ctx.excluded).map(part=>part.ref),
    transitionTriggerParts:transitionRoot?partsFor(room,transitionRoot,ctx.scopeKey,ctx.excluded).map(part=>part.ref):[],relatedReplies:selected.map(turn=>replyRef(room,turn)),
    activeUserGroups,omittedActiveUserGroups:Math.max(0,active.length-activeAnchors.length),
    omittedRelatedReplies:Math.max(0,replies.length-selected.length)};
}

/** Used inside the reply's existing durable commit, never by a stream preview. */
export function acknowledgeChatScene(room,{messageId,scopeKey,referenceRevision,reply}={}){
  const scene=projectChatScene(room,{messageId,scopeKey,referenceRevision});
  if(!scene?.transition||scene.transition.reply!==null)return false;
  const ctx=context(room,{messageId,scopeKey,referenceRevision}),normalized=strictRef(reply);
  if(!ctx||normalized?.kind!=='assistant'||normalized.index!==0||!groupReplies(ctx,ctx.current).some(turn=>same(replyRef(room,turn),normalized)))return false;
  ctx.current.scene={...ctx.current.scene,transition:{...scene.transition,reply:normalized}};return true;
}

/** Restore only scenes whose relation can still be reconstructed from real refs. */
export function restoreChatScenes(room){
  const scopes=[...new Set(room.turns.filter(turn=>turn.phase==='anchor').map(scopeOf))];
  for(const scopeKey of scopes){
    const last=room.turns.filter(turn=>scopeOf(turn)===scopeKey).at(-1);if(!last)continue;
    const ctx=context({...room,turns:room.turns.filter(turn=>scopeOf(turn)===scopeKey)},{messageId:last.messageId,scopeKey,referenceRevision:room.referenceRevision??0});
    const frames=ctx?savedFrames(ctx):new Map();
    for(const anchor of room.turns.filter(turn=>turn.phase==='anchor'&&scopeOf(turn)===scopeKey)){
      const frame=frames.get(anchor.messageId);
      if(frame){anchor.scene=frame;continue;}
      delete anchor.scene;delete anchor.sceneReferenceRevision;delete anchor.sceneSourceVersion;
    }
  }
}

/** Idempotent public whitelist: no option frames, arbitrary fields or generated summaries. */
export function publicChatSceneCatalog(catalog){
  const topics=[];let chars=0,responses=0;
  for(const item of Array.isArray(catalog?.topics)?catalog.topics.slice(0,CHAT_SCENE_LIMITS.topics):[]){
    const ref=strictRef(item?.ref);if(!id(item?.id)||ref?.kind!=='user'||!text(item.text,4000)||topics.some(topic=>topic.id===item.id))continue;
    const parts=[];
    for(const part of Array.isArray(item.parts)?item.parts.slice(0,8):[{ref,text:item.text}]){const proof=strictRef(part?.ref);
      if(proof?.kind!=='user'||proof.roomId!==ref.roomId||proof.generation!==ref.generation||!text(part.text,4000)||parts.some(value=>same(value.ref,proof)))continue;
      parts.push({ref:proof,text:part.text});}
    if(!parts.length||!same(parts[0].ref,ref)||parts[0].text!==item.text)continue;
    const size=parts.reduce((sum,part)=>sum+part.text.length,0);if(chars+size>CHAT_SCENE_LIMITS.chars)continue;chars+=size;
    const replyValues=[];let omitted=Number.isSafeInteger(item.omittedResponses)&&item.omittedResponses>=0?item.omittedResponses:0;
    for(const response of Array.isArray(item.responses)?item.responses:[]){const proof=strictRef(response?.ref),author=response?.author,lines=response?.messages;
      if(proof?.kind!=='assistant'||proof.index!==0||proof.roomId!==ref.roomId||proof.generation!==ref.generation
        ||author?.role!=='assistant'||!id(author.id)||!text(author.name,80)||!Array.isArray(lines)||!lines.length||lines.length>6||!lines.every(line=>text(line,2000)))continue;
      const replySize=lines.reduce((sum,line)=>sum+line.length,0);
      if(replySize>6000||chars+replySize>CHAT_SCENE_LIMITS.chars||responses>=CHAT_SCENE_LIMITS.responses){omitted++;continue;}
      replyValues.push({ref:proof,author:{role:'assistant',id:author.id,name:author.name},messages:[...lines]});chars+=replySize;responses++;
    }
    topics.push({id:item.id,ref,text:item.text,parts,responses:replyValues,omittedResponses:omitted});
  }
  const options=[];
  for(const option of Array.isArray(catalog?.options)?catalog.options:[]){
    if(!/^(?:F|K|[CPR][1-4])$/u.test(option?.key??'')||!['fresh','continue','pause','resume'].includes(option.relation)||options.some(value=>value.key===option.key))continue;
    if(option.target!==undefined&&!topics.some(topic=>topic.id===option.target))continue;
    options.push({key:option.key,relation:option.relation,...(option.target!==undefined?{target:option.target}:{})});
  }
  const current=object(catalog?.current)?normalScene(Object.fromEntries(['version','trigger','relation','focus','parked','transition'].map(key=>[key,catalog.current[key]]))):null,
    result={options,topics,current,omittedTopics:Number.isSafeInteger(catalog?.omittedTopics)&&catalog.omittedTopics>=0?catalog.omittedTopics:0};
  return result;
}
