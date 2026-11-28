import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture as hostFixture,newRoom,roomSend,roomState,settledRoom,reply,whale,dragon,readChatInput,flush,domain,preference} from './helpers/persona-chat-host.mjs';
const fixture=(t,options)=>hostFixture(t,{modelInfo:async(provider,id)=>({provider,id,reasoning:{efforts:[{id:'off',name:'关闭'},{id:'high',name:'思考'}],defaultEffort:'off'}}),...options});
const wire=text=>(async function*(){yield{type:'text-delta',text};yield{type:'finish',reason:{kind:'stop'}};})();
function choose(options,template='research'){
 const input=readChatInput(options);if(input.events.some(e=>e.author.role==='assistant'))return wire('WAIT');
 const choice=input.supportChoices.find(c=>c.id===whale&&c.template===template);assert.ok(choice);
 return wire(`${choice.choiceId} N ${input.sceneCatalog?.options?.[0]?.key??'-'} | 核对当前公开条件`);
}
const web={search:async()=>({sources:[{url:'https://example.com/official',title:'一手资料'}]})};
const originalReport='上轮只验证旧配置。仅供对照，尚未验证客户端。';
const currentReport='本轮切换到新配置，完成本地检查。';
function workReferenceEvents(){
 const events=[];let seq=1;
 for(const [turn,goal,report] of [[1,'核对旧配置',originalReport],[2,'继续验证这项设置',currentReport]]){
  events.push({seq:seq++,type:'turn/start',data:{turn}},
    {seq:seq++,type:'user/message',data:{turn,content:[{type:'text',text:goal}]}},
    {seq:seq++,type:'assistant/message',data:{turn,message:{content:[{type:'text',text:report}]}}},
    {seq:seq++,type:'turn/end',data:{turn,reason:{kind:'completed'}}});
 }
 return events;
}

for(const mode of ['checked','checked-wait','automatic','bad-quote','partly-invalid','source-updated','compatibility-retry'])test(`work summary ${mode} uses grounded work excerpts and releases ordinary chat`,async t=>{
 const events=workReferenceEvents(),auto=mode==='automatic';let calls=0,actors=0,release,startCall;
 const started=new Promise(resolve=>startCall=resolve);
 const services=[['sessions',{get:id=>({header:{id,title:'项目工作'}})}],
   ['sessionQuery',{observeSession:async id=>({events:id==='work'?events:[{seq:1,type:'user/message',data:{content:[{type:'text',text:'UNATTACHED_CANARY'}]}}]})}],
   ['web',{search(){assert.fail('summary has no network access');}}]];
 const fallback = mode === 'compatibility-retry';
 const f=fixture(t,{...(fallback?{modelInfo:undefined}:{}),config:{chatSummarizeEnabled:auto},extraServices:services,directorScript:options=>{
   const input=readChatInput(options),last=input.events.findLastIndex(e=>e.author.role==='user');
   if(input.events.slice(last+1).some(e=>e.author.role==='assistant'))return wire('WAIT');
   if(!input.message.includes('对照')){
     assert.equal(input.summaryRequested,undefined);
     return wire(input.choices.find(c=>c.id===whale).choiceId+' N');
   }
   if(auto){const choice=input.supportChoices.find(c=>c.template==='summarize');
     return wire(`${choice.choiceId} s1 ${input.sceneCatalog?.options?.[0]?.key??'-'} | 对照两轮原始汇报`);}
   assert.equal(input.summaryRequested,true);
   return wire(mode==='checked-wait'?'WAIT':input.choices.find(c=>c.id===whale).choiceId+' N');
 },script:options=>{
   const input=readChatInput(options);
   if(input.task==='chat-support'){
     calls++;assert.equal(input.template,'summarize');assert.equal(options.tools,undefined);
     if(fallback && calls===1) {
       assert.equal(options.reasoningEffort,'off');
       throw Object.assign(Error('unsupported effort'),{code:'UNSUPPORTED_REASONING_EFFORT'});
     }
     if(fallback)assert.equal(options.reasoningEffort,undefined);
     assert.equal(input.question,'能对照一下前后两次吗？');
     assert.doesNotMatch(JSON.stringify(input),/PRIVATE_SUMMARY_SENTINEL|UNATTACHED_CANARY/);
     assert.ok(input.references.some(item=>item.passages.some(p=>p.text===currentReport)&&item.seq===7));
     const ref=input.references.find(item=>item.seq===3);
     const passage=ref.passages.find(p=>p.text==='仅供对照，尚未验证客户端。').id;
     const invalid={ref:ref.ref,passage:999,note:'已经验证客户端。'};
     const output=JSON.stringify({points:mode==='bad-quote'?[invalid]:[{ref:ref.ref,passage},...(mode==='partly-invalid'?[invalid]:[])],unknowns:''});
     if(mode==='source-updated')return(async function*(){await new Promise(resolve=>{release=resolve;startCall();});yield{type:'text-delta',text:output};yield{type:'finish',reason:{kind:'stop'}};})();
     return wire(output);
   }
   actors++;
   if(actors>1||mode==='source-updated')assert.equal(input.supportReference,undefined);
   else if(mode==='bad-quote')assert.equal(input.supportReference.error,'format');
   else{
     const [note]=JSON.parse(input.supportReference.text).notes;
     assert.deepEqual([note.kind,note.turn,note.event,note.quote],['上轮结束的汇报',1,3,'仅供对照，尚未验证客户端。']);
     assert.doesNotMatch(input.supportReference.text,/已经验证客户端/);
     assert.equal(input.workContext.sources[0].previousReport,undefined,'the broader history belongs to the helper');
   }
   return reply(['前后两次的验证范围要分开看。']);
 }});
 await f.ready();await preference(f,'私有哨兵 PRIVATE_SUMMARY_SENTINEL');
 const room=await newRoom(f,[whale]);
 assert.equal((await roomSend(f,auto?room:{...room,summarize:true},whale,'能对照一下前后两次吗？','summary-work')).status,200);
 if(mode==='source-updated'){
   await started;
   const event={seq:9,type:'user/message',data:{content:[{type:'text',text:'工作来源的新要求'}]}};
   events.push(event);f.bus.emit('session/event',{id:'work',header:{}},event);release();
 }
 const done=await settledRoom(f,room);
 assert.equal(done.directorFailure,null);
 assert.equal(done.room.turns.find(t=>t.phase==='anchor').user,'能对照一下前后两次吗？');
 assert.equal(done.supportTasks[0].template,'summarize');
 assert.equal(done.supportTasks[0].status,['bad-quote','source-updated'].includes(mode)?'failed':mode==='partly-invalid'?'partial':'completed');
 assert.deepEqual(done.supportTasks[0].counts,{calls:1,searches:0,reads:0});
 if(fallback) {
   const usage=(await f.request('model-usage')).value;
   const totals=usage.purposes.find(p=>p.purpose==='chat-support-summarize');
   assert.equal(totals.calls,2);assert.equal(totals.failedCalls,1);
   assert.equal(done.supportTasks[0].model.thinking,'provider-default');
 }
 assert.equal((await f.request('settings')).value.settings.chatSummarizeEnabled,auto);
 assert.doesNotMatch(JSON.stringify(f.directors),/尚未验证客户端|PRIVATE_SUMMARY_SENTINEL/);
 await roomSend(f,room,whale,'今天只闲聊。','summary-casual');await settledRoom(f,room);
 assert.equal(calls,fallback?2:1);assert.equal(actors,2);
 await f.dispose();
 if(fallback)assert.equal(f.storage.tables.get('profile').get('modelUsage').chatTiming.find(s=>s.path==='support').calls.support,1);
 const saved=f.storage.tables.get('profile').get('chatSupport');
 assert.doesNotMatch(JSON.stringify(saved),/尚未验证客户端|新配置|前后两次|PRIVATE_SUMMARY_SENTINEL/);
});

test('the same-round summary follows the selected work sources even when its original requester speaks again',async t=>{
 const actors=[];
 const f=fixture(t,{config:{chatSummarizeEnabled:true},extraServices:[
   ['sessions',{get:id=>({header:{id,title:'项目工作'}})}],
   ['sessionQuery',{observeSession:async()=>({events:workReferenceEvents()})}]
 ],directorScript:options=>{
   const input=readChatInput(options);
   if(!actors.length){
     const helper=input.supportChoices.find(c=>c.id===whale && c.template==='summarize');
     return wire(`${helper.choiceId} s1 ${input.sceneCatalog.options[0].key} | 整理原始报告`);
   }
   if(actors.length===3)return wire('WAIT');
   const [id,to,work]=actors.length===1?[dragon,whale,'s1']:[whale,dragon,'N'];
   const choice=input.choices.find(c=>c.kind==='normal' && c.id===id && c.to===to);
   return wire(`${choice.choiceId} ${work}`);
 },script:options=>{
   const input=readChatInput(options);
   if(input.task==='chat-support'){
     const target=input.references.find(item=>item.seq===3);
     return wire(JSON.stringify({points:[{ref:target.ref,passage:target.passages[0].id}],unknowns:''}));
   }
   actors.push(input);
   return reply([`${input.speaker.name}公开回应。`]);
 }});
 await f.ready();const room=await newRoom(f,[whale,dragon]);
 assert.equal((await roomSend(f,room,whale,'请帮我看看之前的报告。','review')).status,200);
 const done=await settledRoom(f,room);
 assert.equal(done.directorFailure,null);
 assert.deepEqual(actors.map(a=>a.speaker.id),[whale,dragon,whale]);
 assert.equal(actors[0].supportReference.kind,'summarize');
 assert.equal(actors[1].supportReference.notes.length,1);
 assert.deepEqual(actors[2].workContext.sources,[]);
 assert.equal(actors[2].supportReference,undefined);
});

test('research really searches and reads, returns only to its actor, and spends no extra speech quota',async t=>{
 const actions=[{action:'search',query:'current official'},{action:'read',sourceId:'w1'},{action:'finish',answer:'官方页面列出了当前条件。',sources:['w1']}];let read=0,support=0,actor=0;
 const f=fixture(t,{config:{chatResearchEnabled:true},extraServices:[['web',web]],runtime:{chatIntervalMs:0,supportPageReader:async url=>{read++;return{url,text:'官方当前条件和未验证部分。'};}},
  directorScript:options=>choose(options),script:options=>{
   const input=readChatInput(options);if(input.task==='chat-support'){support++;assert.equal(input.context,undefined);assert.doesNotMatch(JSON.stringify(input),/PRIVATE_SUPPORT_SENTINEL|WORK_SESSION_SECRET/);assert.doesNotMatch(options.system,/妹妹|姐姐|私有偏好/);return wire(JSON.stringify(actions.shift()));}
   actor++;assert.equal(input.supportReference.kind,'research');assert.equal(input.supportReference.sources[0].excerpt,'官方当前条件和未验证部分。');return reply(['查到的条件是这样；我更倾向先按小范围试。']);
  }});
 await f.ready();await preference(f,'私有哨兵 PRIVATE_SUPPORT_SENTINEL');f.work();const room=await newRoom(f,[whale,dragon],'研究房间','support-research');await roomSend(f,room,whale,'帮我核对现在的公开条件。');
 const done=await settledRoom(f,room);assert.equal(done.directorFailure,null);assert.equal(support,3);assert.equal(actor,1);assert.equal(read,1);
 assert.equal(done.room.turns.filter(t=>t.phase!=='anchor'&&t.status==='ready').length,1);
 assert.equal(done.supportTasks[0].status,'completed');assert.deepEqual(done.supportTasks[0].counts,{calls:3,searches:1,reads:1});
 assert.equal(done.supportTasks[0].sources[0].read,true);
});
test('deep reasoning uses its separate route with no network and real cancellation status',async t=>{
 let release,started;const start=new Promise(r=>started=r);
 const f=fixture(t,{config:{chatDeepReasoningEnabled:true,chatThinking:false,chatDeepReasoningProvider:'strong',chatDeepReasoningModel:'reasoner'},
  directorScript:options=>choose(options,'reason'),script:options=>{
   const input=readChatInput(options);if(input.task==='chat-support'){
    assert.equal(options.provider,'strong');assert.equal(options.model,'reasoner');assert.equal(options.reasoningEffort,'high');assert.equal(options.tools,undefined);started();
    return(async function*(){await new Promise(r=>release=r);yield{type:'text-delta',text:'较复杂的取舍。'};yield{type:'finish',reason:{kind:'stop'}};})();
   }
   assert.equal(input.supportReference.status,'cancelled');return reply(['好，那先按现有条件聊。']);
  }});
 await f.ready();const room=await newRoom(f,[whale],'推演房间','support-reason');await roomSend(f,room,whale,'已有两种方案，帮我推演取舍。');await start;
 let state=await roomState(f,room);const job=state.supportTasks[0];assert.equal(job.status,'running');assert.equal(state.memberActivity.some(m=>m.state==='typing'),false);
 assert.equal((await f.request('chat',{action:'cancel-support',roomId:room.roomId,personaId:whale,jobId:job.id,epoch:state.epoch})).status,200);
 const done=await settledRoom(f,room);assert.equal(done.supportTasks[0].status,'cancelled');release();await flush();
 assert.equal((await roomState(f,room)).supportTasks[0].status,'cancelled');
});
test('off by default, invalid helper choices cannot dispatch, and enabling settings survives restoration',async t=>{
 const storage=domain(),f=fixture(t,{storage,directorScript:options=>{const input=readChatInput(options);assert.equal(input.supportTemplates,undefined);return wire('WAIT');}});
 await f.ready();const room=await newRoom(f,[whale],'普通房间','support-off');await roomSend(f,room);const done=await settledRoom(f,room);assert.deepEqual(done.supportTasks,[]);
 assert.equal((await f.request('settings',{chatDeepReasoningEnabled:true,chatDeepReasoningProvider:'other',chatDeepReasoningModel:'deep'})).status,200);
 await f.dispose();const restored=fixture(t,{storage});await restored.ready();const settings=(await restored.request('settings')).value.settings;
 assert.equal(settings.chatDeepReasoningEnabled,true);assert.equal(settings.chatDeepReasoningModel,'deep');
});

test('a new user interruption cancels the old task and cannot insert its late answer into the new request',async t=>{
 let release,started;const start=new Promise(r=>started=r);let helper=0;
 const f=fixture(t,{config:{chatDeepReasoningEnabled:true},directorScript:options=>{
   const input=readChatInput(options),answered=input.events.slice(input.events.findLastIndex(e=>e.author.role==='user')+1).some(e=>e.author.role==='assistant');if(answered)return wire('WAIT');
   const choice=input.choices.find(c=>c.id===whale&&c.to==='user');return wire(`${choice.choiceId} N ${input.sceneCatalog.options[0].key} react | 接住当前原话${input.message==='先停下，聊点别的。'?'':'\nHELP reason | 推演现有条件'}`);
  },script:options=>{const input=readChatInput(options);if(input.task==='chat-support'){helper++;started();return(async function*(){await new Promise(r=>release=r);yield{type:'text-delta',text:'过时的结果'};yield{type:'finish',reason:{kind:'stop'}};})();}
   assert.equal(input.supportReference,undefined);return reply(['好，聊点别的。']);}});
 await f.ready();const room=await newRoom(f,[whale],'可打断','support-interrupt');await roomSend(f,room,whale,'推演一下。','first');await start;
 await roomSend(f,room,whale,'先停下，聊点别的。','second');const done=await settledRoom(f,room);release();await flush();
 assert.equal(helper,1);assert.equal(done.room.turns.filter(t=>t.status==='ready'&&t.phase!=='anchor').length,1);
 assert.equal((await roomState(f,room)).supportTasks[0].status,'cancelled');
});

test('research receives no persona memory or work bodies, and unavailable search spends no model request',async t=>{
 let helper=0;
 const f=fixture(t,{config:{chatResearchEnabled:true},extraServices:[['web',{search:()=>assert.fail(),searchReady:async()=>false}]],
  directorScript:options=>choose(options),script:options=>{const input=readChatInput(options);assert.notEqual(input.task,'chat-support');assert.equal(input.supportReference.status,'failed');helper++;return reply(['这次没有查到有效资料，先保留未知。']);}});
 await f.ready();await preference(f,'私有哨兵 PRIVATE_SUPPORT_SENTINEL');const room=await newRoom(f,[whale],'资料不可用','support-unavailable');
 await roomSend(f,room,whale,'查公开价格。');const done=await settledRoom(f,room);
 assert.equal(helper,1);assert.equal(done.supportTasks[0].counts.calls,0);assert.equal(done.supportTasks[0].error,'unavailable');
 const researchJob=done.supportTasks[0];assert.equal(researchJob.text,undefined);assert.equal(researchJob.context,undefined);
});

test('source changes, clearing and disabling abort support before any late persona dispatch',async t=>{
 for(const change of ['source','clear','disable'])await t.test(change,async sub=>{
  let release,started;const begun=new Promise(r=>started=r);const f=fixture(sub,{config:{chatDeepReasoningEnabled:true},directorScript:o=>choose(o,'reason'),script:o=>{
   if(readChatInput(o).task!=='chat-support'){assert.equal(readChatInput(o).supportReference.status,'cancelled');return reply(['停止后按已有信息继续聊。']);}
   started();return(async function*(){await new Promise(r=>release=r);yield{type:'text-delta',text:'过期参考'};yield{type:'finish',reason:{kind:'stop'}};})();}});
  await f.ready();const room=await newRoom(f,[whale],'取消边界',change);await roomSend(f,room,whale,'推演一下。');await begun;const pending=await roomState(f,room);
  if(change==='source')assert.equal((await f.request('chat-context',{action:'detach',...room,sessionId:'work',revision:Number(room.contextKey.split(':').at(-1))})).status,200);
  if(change==='clear')assert.equal((await f.request('chat',{action:'clear',...room,personaId:whale,revision:pending.room.revision,epoch:pending.epoch})).status,200);
  if(change==='disable'){
   // Closing research cannot accidentally cancel an independent reasoning task.
   await f.request('settings',{chatResearchEnabled:false});assert.equal((await roomState(f,room)).supportTasks[0].status,'running');
   await f.request('settings',{chatDeepReasoningEnabled:false});
  }
  release();await settledRoom(f,room);await flush();assert.equal((await roomState(f,room)).room.turns.some(v=>v.status==='ready'&&v.phase!=='anchor'),change==='disable');
 });
});

test('enabled helpers preserve ordinary room reactions without extra calls',async t=>{
 const f=fixture(t,{config:{chatResearchEnabled:true,chatDeepReasoningEnabled:true},extraServices:[['web',web]],directorScript:o=>{
  const input=readChatInput(o);assert.equal(input.supportTemplates.length,2);if(input.events.some(e=>e.author.role==='assistant'))return wire('WAIT');
  const c=input.choices.find(c=>c.id===whale&&c.to==='user');return wire(`${c.choiceId} N ${input.sceneCatalog.options[0].key} react | 顺着用户的玩笑接一句`);
 },script:o=>{assert.notEqual(readChatInput(o).task,'chat-support');assert.equal(readChatInput(o).supportReference,undefined);return reply(['这个比喻我也喜欢。']);}});
 await f.ready();const room=await newRoom(f,[whale,dragon]);await roomSend(f,room,whale,'裙摆像水波，接着聊呀。');const done=await settledRoom(f,room);assert.deepEqual(done.supportTasks,[]);assert.equal(done.room.turns.filter(t=>t.status==='ready'&&t.phase!=='anchor').length,1);
});

test('unsupported thinking fails visibly before a helper call rather than using the provider default',async t=>{
 const f=fixture(t,{modelInfo:async(provider,id)=>({provider,id}),config:{chatDeepReasoningEnabled:true},directorScript:o=>choose(o,'reason'),script:o=>{
  const input=readChatInput(o);assert.notEqual(input.task,'chat-support');assert.equal(input.supportReference.error,'thinking-unavailable');return reply(['这次没能启用推演思考，先按已有内容聊。']);}});
 await f.ready();const room=await newRoom(f,[whale]);await roomSend(f,room,whale,'帮我深入推演。');const done=await settledRoom(f,room);assert.equal(done.supportTasks[0].error,'thinking-unavailable');assert.equal(done.supportTasks[0].counts.calls,0);
});
