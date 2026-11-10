import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatContext } from '../lib/chat-context.js';
import { createChatSourceAdapter } from '../lib/chat-source.js';

function fixture() {
  let clock=0;const calls=[];
  const adapter={projects:async()=>{calls.push('projects');return[{id:'p',name:'项目甲'},{id:'q',name:'项目乙'}];},
    projectForSession:id=>id==='a'?'p':'q',sessions:async id=>{calls.push('sessions:'+id);return[{sessionId:'b',name:'另一个会话'}];},
    source:async id=>{calls.push(id);return{name:id,projectId:id==='a'?'p':'q',cursor:4,goal:'目标',report:'保留限定条件的汇报。',toolBody:'NEVER_COPY'};}};
  const context=createChatContext({adapter,now:()=>clock,id:()=> 'one'});
  const open=async(id='a')=>{context.presence('viewer',true,1);return context.open({sessionId:id});};
  return{context,adapter,calls,open,advance:ms=>{clock+=ms;}};
}

test('context selection exposes metadata only and an empty capture preserves its range without source reads',async()=>{
  const f=fixture();await f.open();await f.context.attach('b');const key=f.context.key();f.calls.length=0;
  f.context.event({id:'a'},{type:'user/message',seq:5});f.context.event({id:'b'},{type:'user/message',seq:5});
  const catalog=f.context.selection(key);assert.deepEqual(catalog.sources.map(s=>s.id),['a','b']);
  assert.doesNotMatch(JSON.stringify(catalog),/目标|限定条件|NEVER_COPY/);
  await f.context.prepareCapture(key,{sourceIds:[]});assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.context.capture(key,{sourceIds:[]}),{key,primarySessionId:'a',sources:[],omitted:[]});
  await assert.rejects(f.context.prepareCapture(key,{sourceIds:['unattached']}),/invalid-context-source/);
  assert.throws(()=>f.context.capture(key,{sourceIds:['unattached']}),/invalid-context-source/);f.context.dispose();
});

test('selective freshness checks never spend an unrelated source budget or clear its stale cursor',async()=>{
  const f=fixture();await f.open();await f.context.attach('b');const key=f.context.key();f.calls.length=0;
  f.context.event({id:'a'},{type:'user/message',seq:5});f.context.event({id:'b'},{type:'user/message',seq:5});
  f.adapter.source=async id=>{f.calls.push(id);return{cursor:5,goal:id+'_current',report:id+'_report'};};
  await f.context.prepareCapture(key,{sourceIds:['b']});assert.deepEqual(f.calls,['b']);
  assert.deepEqual(f.context.capture(key,{sourceIds:['b']}).sources.map(s=>s.sessionId),['b']);
  assert.equal(f.context.capture(key).omitted.some(s=>s.name==='a'&&s.reason==='update-pending'),true);
  f.context.detach('b');assert.throws(()=>f.context.selection(key),/chat-context-changed/);f.context.dispose();
});

test('an explicitly selected unavailable source can recover immediately without waiting for the polling interval',async()=>{
  const f=fixture();f.adapter.source=async()=>{f.calls.push('unavailable');throw Error('offline');};
  await f.open();const key=f.context.key();assert.equal(f.context.selection(key).sources[0].available,false);
  f.adapter.source=async id=>{f.calls.push(id);return{cursor:6,goal:'恢复后的目标',report:'恢复后的原始汇报'};};
  await f.context.prepareCapture(key,{sourceIds:['a']});
  assert.deepEqual(f.calls.filter(id=>id!=='projects'),['unavailable','a']);
  assert.equal(f.context.capture(key,{sourceIds:['a']}).sources[0].report,'恢复后的原始汇报');f.context.dispose();
});

test('no reads before opening; concurrent opens share one initialization and retain the first source',async()=>{
  const f=fixture();f.context.event({id:'a'},{type:'turn/end',seq:1});assert.deepEqual(f.calls,[]);
  f.context.presence('viewer',true,1);
  await Promise.all([f.context.open({sessionId:'a'}),f.context.open({sessionId:'b'})]);
  assert.equal(f.context.snapshot().primarySessionId,'a');assert.equal(f.calls.filter(x=>x==='projects').length,1);assert.equal(f.calls.filter(x=>x==='a').length,1);
  await f.context.open({sessionId:'b'});assert.equal(f.context.snapshot().sources.length,1);
  assert.deepEqual(f.context.snapshot().projects,[{id:'p',name:'项目甲'},{id:'q',name:'项目乙'}]);f.context.dispose();
});

test('focus frequency depends on explicit activity; polling itself does not raise focus',async()=>{
  const f=fixture();await f.open();await f.context.attach('b');f.context.touch('b','message');
  assert.equal(f.context.snapshot().focusProjectId,'q');f.calls.length=0;
  f.advance(14999);await f.context.refresh();assert.deepEqual(f.calls,[]);
  f.advance(1);await f.context.refresh();assert.deepEqual(f.calls,['b']);
  f.advance(45000);await f.context.refresh();assert.deepEqual(f.calls,['b','a','b']);
  f.context.presence('viewer',false,2);f.advance(60000);await assert.rejects(f.context.refresh(),/context-not-open/);
  f.context.presence('viewer',true,1);assert.equal(f.context.active(),false,'stale presence cannot reopen a closed view');f.context.dispose();
});

test('references are explicitly attached, bounded and retired on removal',async()=>{
  const f=fixture();await f.open();const first=f.context.key();
  assert.doesNotMatch(JSON.stringify(f.context.capture(first)),/NEVER_COPY/);
  await f.context.sessions('q');assert.equal(f.context.snapshot().sources.length,1,'listing titles does not attach');
  await f.context.attach('b',true);assert.equal(f.context.snapshot().primarySessionId,'b');
  assert.throws(()=>f.context.capture(first),/chat-context-changed/);
  f.context.detach('a');assert.equal(f.context.capture(f.context.key()).sources.some(s=>s.sessionId==='a'),false);f.context.dispose();
});

test('sending after a source event refreshes that source only, even before its normal poll', async () => {
  const f=fixture(); await f.open(); await f.context.attach('b'); const key=f.context.key();
  f.calls.length=0; f.adapter.source=async id=>{ f.calls.push(id); return {name:id,cursor:8,report:'第二轮的结果'}; };
  f.context.event({id:'a'}, {type:'turn/end',seq:8});
  f.context.event({id:'child',header:{parentSession:'a'}}, {type:'turn/end',seq:15});
  assert.deepEqual(f.calls,[], 'observing an event never reads the source');
  const polling=await f.context.refresh();
  assert.deepEqual(f.calls,[], 'ordinary polling still respects the focus interval');
  assert.equal(polling.sources.find(s=>s.sessionId==='a').report,undefined,'no stale report advertised');
  await f.context.prepareCapture(key);
  const captured=f.context.capture(key);
  assert.deepEqual(f.calls,['a']); assert.equal(captured.sources.find(s=>s.sessionId==='a').report,'第二轮的结果');
  f.context.event({id:'a'}, {type:'turn/end',seq:8}); f.context.event({id:'a'},{type:'tool/call',seq:9});
  await f.context.prepareCapture(key); assert.deepEqual(f.calls,['a'],'duplicates and raw tool activity do not force reads');
  f.context.dispose();
});

test('a snapshot read before a new event cannot overwrite the send-time source, even if the adapter lags or fails',async()=>{
  const f=fixture();await f.open();const key=f.context.key();
  let release,reads=0;
  f.adapter.source=async()=>{if(++reads===1) return new Promise(r=>{release=r;});return {cursor:9,report:'新轮目标'};};
  const poll=f.context.refresh(true); await new Promise(setImmediate);
  f.context.event({id:'a'},{seq:9,type:'user/message'});
  const sending=f.context.prepareCapture(key); release({cursor:4,report:'旧目标的结果'}); await Promise.all([poll,sending]);
  assert.equal(reads,2);assert.equal(f.context.capture(key).sources[0].report,'新轮目标');
  f.context.event({id:'a'},{seq:11,type:'assistant/message'});
  for(const [result,reason] of [[async()=>({cursor:10,report:'漏掉了最后条件'}),'update-pending'],[async()=>{throw Error('offline');},'read-failed']]){
    f.adapter.source=result;await f.context.prepareCapture(key);const out=f.context.capture(key);
    assert.deepEqual(out.sources,[]);assert.equal(out.omitted[0].reason,reason);
    assert.doesNotMatch(JSON.stringify(out),/新轮目标|最后条件/);
  }
  f.adapter.source=async()=>({cursor:11,report:'已补齐条件'});await f.context.prepareCapture(key);
  assert.equal(f.context.capture(key).sources[0].report,'已补齐条件');f.context.dispose();
});

test('a hidden room stays idle and revalidates on reopen; a changed selection cannot complete an old send',async()=>{
  const f=fixture();await f.open();const key=f.context.key();f.calls.length=0;f.context.presence('viewer',false,2);
  f.context.event({id:'a'},{seq:5,type:'turn/end'});await assert.rejects(f.context.prepareCapture(key),/context-not-open/);
  assert.deepEqual(f.calls,[]);f.adapter.source=async id=>{f.calls.push(id);return {cursor:5,report:'关闭期间积累的新结果'};};
  f.context.presence('viewer',true,3); await f.context.open({sessionId:'b'});
  assert.equal(f.context.capture(key).sources[0].report,'关闭期间积累的新结果'); assert.deepEqual(f.calls,['a']);
  let release;f.adapter.source=()=>new Promise(r=>{release=r;});f.context.event({id:'a'},{seq:6,type:'turn/start'});
  const sending=f.context.prepareCapture(key);await new Promise(setImmediate);f.context.detach('a');release({cursor:6,report:'旧范围'});
  await assert.rejects(sending,/chat-context-changed/);assert.deepEqual(f.context.capture(f.context.key()).sources,[]);f.context.dispose();
});

test('related notices use event metadata, deduplicate and disappear when inactive',async()=>{
  const f=fixture();await f.open();
  f.context.event({id:'unrelated',header:{}},{type:'turn/end',seq:1});
  const child={id:'child',header:{parentSession:'a'}};
  f.context.event(child,{type:'turn/end',seq:9,data:{secret:'NEVER_READ'}});
  f.context.event(child,{type:'turn/end',seq:9});assert.equal(f.context.snapshot().notices.length,1);
  assert.doesNotMatch(JSON.stringify(f.context.snapshot()),/NEVER_READ/);assert.equal(f.context.snapshot().sources.length,1);
  f.context.dismiss('child:9');assert.equal(f.context.snapshot().notices[0].read,true);
  f.context.presence('viewer',false,2);f.context.event(child,{type:'turn/end',seq:10});assert.equal(f.context.snapshot().notices.length,1);f.context.dispose();
});

test('DSH committed error endings create one metadata-only alert regardless of the separate agent notification',async()=>{
  const f=fixture();await f.open();
  const child={id:'child',header:{parentSession:'a'}}, terminal={type:'turn/end',seq:12,data:{turn:2,reason:{kind:'error',message:'PRIVATE_STACK'}}};
  f.context.event(child,{type:'agent/error',seq:11,data:{turn:2,message:'PRIVATE_STACK'}});
  f.context.event(child,terminal);f.context.event(child,terminal);
  f.context.event(child,{type:'agent/error',seq:13});
  f.context.event(child,{type:'turn/end',seq:19,data:{turn:3,reason:{kind:'completed'}}});
  const notices=f.context.snapshot().notices;
  assert.deepEqual(notices.map(n=>[n.id,n.kind,n.attached]),[['child:12','error',false],['child:19','report',false]]);
  assert.doesNotMatch(JSON.stringify(notices),/PRIVATE_STACK/);assert.ok(!f.calls.includes('child'));f.context.dispose();
});

test('closed windows free slots immediately but delayed presence cannot reopen them or evict a live viewer',async()=>{
  const f=fixture();await f.open(); f.context.presence('viewer',false,2);
  for(let i=0;i<32;i++){
    assert.equal(f.context.presence('mount'+i,true,1),true);
    assert.equal(f.context.presence('mount'+i,false,3),true);
  }
  assert.equal(f.context.presence('mount0',true,2),false);assert.equal(f.context.active(),false);
  for(let i=0;i<16;i++)assert.equal(f.context.presence('live'+i,true,1),true);
  assert.throws(()=>f.context.presence('extra',true,1),/viewer-capacity/);
  assert.equal(f.context.presence('live0',true,1),true,'same-state receipt retries are harmless');
  assert.equal(f.context.presence('live0',false,0),false);
  for(let i=0;i<15;i++)f.context.presence('live'+i,false,2);
  assert.equal(f.context.active(),true,'closing other windows preserves the last live lease');
  f.context.presence('live15',false,2);assert.equal(f.context.active(),false);
  f.context.dispose();
});

test('detaching the only parent drops its child notices, while independently attached children stay current', async () => {
  const f=fixture(); await f.open('parent');
  const finish = (id,seq) => f.context.event({id,header:{parentSession:'parent'}},{type:'turn/end',seq});
  finish('related',1); finish('selected',2); await f.context.attach('selected'); finish('selected',3);
  assert.ok(f.context.snapshot().notices.filter(n=>n.sessionId==='selected').every(n=>n.attached),'no redundant attach button');
  f.context.detach('parent');
  let notices=f.context.snapshot().notices;
  assert.deepEqual(notices.map(n=>n.id),['selected:2','selected:3']);
  assert.ok(notices.every(n=>n.attached&&n.relatedTo==='selected'&&n.name==='selected'));
  finish('related',4); finish('selected',5); notices=f.context.snapshot().notices;
  assert.deepEqual(notices.map(n=>n.id),['selected:2','selected:3','selected:5']);
  assert.ok(!f.calls.includes('related'),'a related-only child never had its body read'); f.context.dispose();
});

test('closing retires a pending initialization read without late publication',async()=>{
  const f=fixture();let release;
  f.adapter.source=()=>new Promise(r=>{release=r;});
  const opening=f.open();await new Promise(setImmediate);f.context.presence('viewer',false,2);await opening;
  release({name:'LATE',report:'LATE',projectId:'p'});await new Promise(setImmediate);
  assert.equal(f.context.snapshot().sources[0].available,false);f.context.dispose();
});

test('unused projects expose folder names without reading session indexes, headers or project titles',async()=>{
  let indexes=0,stats=0;
  const project={id:'p',path:'D:\\work\\文件夹名',get title(){throw Error('title must not be read');},get sessionIds(){indexes++;return['s'];}};
  const services=new Map([['workspaceRegistry',{list:()=>[project]}],['sessionPersistence',{stat:async()=>{stats++;return{header:{id:'s',cwd:project.path,title:'会话标题'}};}}]]);
  const adapter=createChatSourceAdapter({get:key=>services.get(key)});
  assert.deepEqual(await adapter.projects(),[{id:'p',name:'文件夹名'}]);assert.equal(indexes,0);assert.equal(stats,0);
  assert.deepEqual(await adapter.sessions('p'),[{sessionId:'s',name:'会话标题'}]);assert.equal(indexes,1);assert.equal(stats,1);
});

test('passive source read excludes thought/tool bodies and releases its query observation',async()=>{
  let released=0;const events=[{type:'user/message',seq:1,data:{content:[{type:'text',text:'任务目标'}]}},
    {type:'assistant/message',seq:2,data:{message:{content:[{type:'thinking',text:'SECRET_THOUGHT'},{type:'tool-call',text:'SECRET_TOOL'}]}}},
    {type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'已完成一步，仍需验证。'}]}}}];
  const adapter=createChatSourceAdapter({get:key=>key==='sessionQuery'?{observeSession:async()=>({events,[Symbol.dispose](){released++;}})}:undefined});
  const value=await adapter.source('s',new AbortController().signal);assert.equal(released,1);assert.equal(value.report,'已完成一步，仍需验证。');assert.doesNotMatch(JSON.stringify(value),/SECRET/);
});

const event = (seq,type,data) => ({ seq,type,data });
const textBlocks = text => [{ type:'text',text }];
const ask = (seq,text,source={kind:'user'}) => event(seq,'user/message',{source,content:textBlocks(text)});
const answer = (seq,turn,text,extra={}) => event(seq,'assistant/message',{turn,message:{content:textBlocks(text)},...extra});
const opened = (seq,turn) => event(seq,'turn/start',{turn});
const ended = (seq,turn,kind='completed') => event(seq,'turn/end',{turn,reason:{kind}});
async function captured(events) {
  const adapter = createChatSourceAdapter({get: key => key === 'sessionQuery' ? {observeSession:async()=>({events})} : undefined});
  const context = createChatContext({adapter});
  try {
    context.presence('viewer',true);
    await context.open({sessionId:'s'});
    return context.capture(context.key()).sources[0];
  } finally { context.dispose(); }
}
test('new work never inherits an earlier successful result, including during startup and steering',async()=>{
  const a=[opened(1,7),ask(2,'验证 A'),answer(3,7,'A 的检查通过'),ended(4,7)];
  const b=[...a,opened(5,8),ask(6,'部署 B'),ask(7,'SYSTEM SECRETS',{kind:'runtime-context',form:'snapshot'})];
  let source=await captured(b);
  assert.deepEqual([source.turn,source.turnStartSeq,source.goalSeq,source.goal,source.reportSeq,source.report,source.reportStatus],[8,5,6,'部署 B',null,'','none']);
  assert.deepEqual(source.previousReport,{turn:7,seq:3,text:'A 的检查通过'});assert.doesNotMatch(JSON.stringify(source),/SYSTEM SECRETS/);
  const interim=[...b,answer(8,8,'已开始准备 B')];
  source=await captured(interim);
  assert.deepEqual([source.report,source.reportSeq,source.reportStatus,source.turnStatus],['已开始准备 B',8,'progress','running']);
  assert.deepEqual(source.previousReport,{turn:7,seq:3,text:'A 的检查通过'},'new progress does not erase the preceding final or claim it as this turn');
  const steering=[...interim,ask(9,'先检查 B 的回滚条件')];
  source=await captured(steering);
  assert.equal(source.goalSeq,9);assert.equal(source.report,'');assert.equal(source.reportStatus,'none');assert.doesNotMatch(JSON.stringify(source),/已开始准备 B/);
  source=await captured([...steering,answer(10,8,'回滚条件未满足'),ended(11,8)]);
  assert.deepEqual([source.goalSeq,source.reportSeq,source.report,source.reportStatus,source.turnStatus],[9,10,'回滚条件未满足','final','completed']);
});
test('interrupted and token-truncated messages are not evidence of completion',async()=>{
  const start=[opened(1,3),ask(2,'可以发布吗？')];
  for (const [extra,end] of [[{interrupted:true},'aborted'],[{},'max-tokens']]) {
    const source=await captured([...start,answer(3,3,'可以发布，但是如果',extra),ended(4,3,end)]);
    assert.equal(source.report,'');assert.equal(source.reportSeq,null);assert.equal(source.reportStatus,'none');assert.equal(source.turnStatus,end);
  }
  const source=await captured([...start,answer(3,3,'正在准备'),event(4,'assistant/message',{turn:3,message:{content:[{type:'tool-call',name:'test'}]}}),ended(5,3)]);
  assert.equal(source.report,'正在准备');assert.equal(source.reportStatus,'progress','a later tool step, not the text, ended the turn');
});
test('steering with only a human attachment advances the goal without reading or inventing its contents',async()=>{
  const before=[opened(1,9),ask(2,'审核上一项'),answer(3,9,'上一项完成')];
  for(const type of ['image','file']){
    const block={type,get attachment(){throw Error('do not inspect attachment payload');}};
    const src=await captured([...before,event(4,'user/message',{role:'user',source:{kind:'user'},content:[block]}),
      event(5,'user/message',{source:{kind:'runtime-context'},content:[block]})]);
    assert.deepEqual([src.goalSeq,src.goal,src.goalHasAttachments,src.reportSeq,src.report,src.reportStatus],[4,'',true,null,'','none']);
    const withCaption=await captured([...before,event(4,'user-message',{message:{role:'user',source:{kind:'user'},content:[block,...textBlocks('查这份')]}})]);
    assert.deepEqual([withCaption.goalSeq,withCaption.goal,withCaption.goalHasAttachments],[4,'查这份',true]);
  }
  const truncated=await captured([opened(1,9),ask(2,'准备好了吗？'),answer(3,9,'还须先确认',
    {stream:[{type:'chunk',time:123,chunk:{type:'finish',reason:{kind:'max-tokens'}}}]})]);
  assert.deepEqual([truncated.report,truncated.reportStatus],['','none'],'do not quote a known cutoff before turn/end');
});

test('late numbered commands and endings cannot reopen an old goal or erase a newer report',async()=>{
  const events=[opened(1,3),ask(2,'任务 A'),answer(3,3,'A 完成'),ended(4,3),opened(5,4),ask(6,'任务 B'),answer(7,4,'B 的进展')];
  const stale=event(8,'user-message',{message:{turn:3,source:{kind:'user'},content:textBlocks('A 的迟到要求')}});
  let src=await captured([...events,stale,ended(9,3)]);
  assert.deepEqual([src.goal,src.report,src.reportStatus,src.turnStatus,src.turn],['任务 B','B 的进展','progress','running',4]);
  src=await captured([...events,ended(8,4),event(9,'user/message',{...ask(9,'旧轮已结束').data,turn:4})]);
  assert.deepEqual([src.goalSeq,src.report,src.reportStatus,src.turnStatus],[6,'B 的进展','final','completed']);
});
test('empty, goal-only and report-only logs do not fabricate mates for the missing events',async()=>{
  const none=await captured([]);
  assert.deepEqual([none.goal,none.report,none.turn,none.goalSeq,none.reportSeq,none.reportStatus],['','',null,null,null,'none']);
  const goal=await captured([event(1,'user-message',{message:{source:{kind:'user'},content:textBlocks('目标 B')}}),
    event(2,'user-message',{source:{kind:'runtime-context'},message:{content:textBlocks('SECRET_WRAPPED_HEADER')}})]);
  assert.equal(goal.goal,'目标 B');assert.equal(goal.report,'');assert.doesNotMatch(JSON.stringify(goal),/SECRET/);
  const report=await captured([answer(3,4,'只从原文看到这句。')]);
  assert.deepEqual([report.goal,report.goalSeq,report.turn,report.reportSeq,report.reportStatus],['',null,4,3,'progress']);
});
test('sparse numbered logs can advance without a start marker but never recover a closed turn as the new report',async()=>{
  const numberedAsk=(seq,turn,text)=>event(seq,'user/message',{...ask(seq,text).data,turn});
  const noStarts=[numberedAsk(1,6,'旧目标'),answer(2,6,'旧进展'),numberedAsk(3,7,'新目标')];
  let source=await captured(noStarts);
  assert.deepEqual([source.turn,source.goal,source.report],[7,'新目标','']);
  source=await captured([...noStarts,opened(4,7),answer(5,7,'对应的新进展')]);
  assert.deepEqual([source.turnStartSeq,source.goalSeq,source.reportSeq],[4,3,5]);
  source=await captured([numberedAsk(1,6,'旧目标'),answer(2,6,'旧结果'),ended(3,6),ask(4,'新目标'),
    answer(5,6,'迟到旧报告'),ended(6,6)]);
  assert.deepEqual([source.goal,source.report,source.turnStatus],['新目标','','unknown']);
});
test('untagged logs do not lend a prior report to a new input or expose a harness preamble',async()=>{
  const a=[ask(1,'目标 A',null),answer(2,null,'A 完成')];
  const words='Read list_agents({}) exactly.\nCurrent working directory: 用户自己写的路径';
  const header='Current runtime context.\nCurrent working directory: D:/private\n';
  const source=await captured([...a,ask(3,header+words,null),ask(4,'PRIVATE_NOTICE',{kind:'tool-registry'})]);
  assert.equal(source.goal,words);assert.equal(source.goalSeq,3);assert.equal(source.report,'');assert.equal(source.reportStatus,'none');
  assert.doesNotMatch(JSON.stringify(source),/A 完成|PRIVATE_NOTICE|D:\/private/);
  assert.equal((await captured([ask(1,header+words)])).goal,header+words,'a user quoting a harness header stays literal');
});
test('a previous report cannot crowd out another explicitly attached current source or bypass its character budget',async()=>{
  const f=fixture();f.adapter.source=async id=>id==='a'?{name:'a',goal:'a'.repeat(1800),previousReport:{turn:3,seq:12,text:'h'.repeat(4500),tool:'SECRET'}}
    :{name:'b',goal:'B',report:'r'.repeat(4000)};
  await f.open();await f.context.attach('b');
  const {sources}=f.context.capture(f.context.key());
  assert.deepEqual(sources.map(s=>s.name),['a','b']);assert.equal(sources[0].previousReport.text,'');assert.equal(sources[0].previousReport.excerpt.coverage,'partial-unknown');assert.equal(sources[0].previousReportOmitted,true);
  f.context.detach('b');const capturedOne=f.context.capture(f.context.key()).sources[0];assert.equal(capturedOne.previousReport.text.length,4500);
  assert.doesNotMatch(JSON.stringify(capturedOne),/SECRET/);f.context.dispose();
});

test('detaching a source aborts its pending read and rejects late publication',async()=>{
  const f=fixture();await f.open();let release,aborted=false;
  f.adapter.source=(_id,signal)=>new Promise(r=>{release=r;signal.addEventListener('abort',()=>{aborted=true;});});
  const pending=f.context.refresh(true);await new Promise(setImmediate);f.context.detach('a');await pending;
  assert.equal(aborted,true);release({name:'LATE',report:'LATE'});await new Promise(setImmediate);
  assert.equal(f.context.snapshot().sources.length,0);f.context.dispose();
});

test('long reference messages are omitted as whole pieces instead of losing their tail conditions',async()=>{
  const f=fixture();f.adapter.source=async()=>({name:'a',projectId:'p',goal:'g'.repeat(2001),report:'r'.repeat(5001)});await f.open();
  const source=f.context.capture(f.context.key()).sources[0];assert.equal(source.goal,'');assert.equal(source.report,'');
  assert.equal(source.goalOmitted,true);assert.equal(source.reportOmitted,true);f.context.dispose();
});
