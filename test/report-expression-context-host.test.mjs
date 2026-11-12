// Controlled real Host streams: delivery/author boundaries, not model semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush} from './helpers/persona-chat-host.mjs';
const stream=text=>(async function*(){yield{type:'text-delta',text:text.slice(0,3)};yield{type:'text-delta',text:text.slice(3)};yield{type:'finish',reason:{kind:'stop'}};})();
const report=(f,text,{id='expression-context',seq=1,child=false}={})=>f.bus.emit('session/event',{
  id,header:child?{delegationDepth:1,origin:'subagent'}:{},append(){assert.fail('report cannot write working history');}},
 {seq,type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text}]}}});
const state=async(f,id='expression-context')=>(await f.request('state?session='+encodeURIComponent(id))).value;
const select=async(f,id,personaId)=>{const before=(await f.request('conversation?session='+id)).value;
 assert.equal((await f.request('conversation',{action:'select',sessionId:id,revision:before.revision,personaId,trigger:'inherit'})).status,200);};

for(const colloquialReports of [true,false])test(`formal Host accepts its voice and Chinese counts with colloquial=${colloquialReports}`,async t=>{
 const f=fixture(t,{config:{colloquialReports},script:()=>stream('鲸鲸在本地改了两处配置，客户端还没验证。')});await f.ready();
 report(f,'工作助手在本地修改了2处配置，客户端尚未验证。');await flush();
 const row=(await state(f)).rows[0];assert.equal(row.status,'ready');assert.match(row.text,/两处/);
 assert.match(f.calls[0].system,/本次原报告由主工作助手提交/);
});

test('a conclusion may repeat a step ordinal without repeating a cardinal fact',async t=>{
 const f=fixture(t,{script:()=>stream('结论先说：第1步已经完成。工作助手只完成第1步，2项检查通过。')});await f.ready();
 report(f,'工作助手只完成第1步，2项检查通过。');await flush();assert.equal((await state(f)).rows[0].status,'ready');
});

test('an invented child identity does not replace the ordinary worker',async t=>{
 const f=fixture(t,{script:()=>stream('小鲸鲸尚未开始迁移，等待用户选定策略。')});await f.ready();
 report(f,'工作助手尚未开始迁移，等待用户选定策略。');await flush();
 const row=(await state(f)).rows[0];assert.equal(row.status,'skipped');assert.equal(row.reason,'source-worker-change');
});

test('actual child report metadata permits its own nickname in voice mode',async t=>{
 const f=fixture(t,{config:{subagentReports:true},script:()=>stream('小鲸鲸做完两项检查了，设备还没验证。')});await f.ready();
 report(f,'工作助手已完成2项检查，设备尚未验证。',{child:true});await flush();
 assert.equal((await state(f)).rows[0].status,'ready');assert.match(f.calls[0].system,/本次原报告由子代理提交/);
});

for(const child of [false,true])test(`relay author metadata and nickname stay matched for child=${child}`,async t=>{
 const id='relay-'+child,name=child?'小鲸鲸':'姐姐';
 const f=fixture(t,{config:{subagentReports:true},script:()=>stream(`${name}已经完成两项检查，设备还没验证。`)});await f.ready();
 await select(f,id,'鲸鲸（实验性）');report(f,'工作助手已完成2项检查，设备尚未验证。',{id,child});await flush();
 assert.equal((await state(f,id)).rows[0].status,'ready');assert.ok(f.calls[0].system.includes('实际工作者称为 '+JSON.stringify(name)));
 assert.match(f.calls[0].system,child?/本次原报告由子代理提交/:/本次原报告由主工作助手提交/);
});

test('formal numeric normalization still rejects a changed failure count',async t=>{
 const f=fixture(t,{script:()=>stream('工作助手的检查通过两项，失败两项，另有一条提醒。')});await f.ready();
 report(f,'工作助手的检查通过2项，失败1项，另有1条提醒。');await flush();
 const row=(await state(f)).rows[0];assert.equal(row.status,'skipped');assert.equal(row.reason,'source-quantity-change');
});

test('a real child relay cannot newly attribute first-person source work to the main nickname',async t=>{
 const id='child-first-person';
 const f=fixture(t,{config:{subagentReports:true},script:()=>stream('姐姐只读了参数说明，尚未运行。')});await f.ready();
 await select(f,id,'鲸鲸（实验性）');report(f,'我只读了参数说明，尚未运行。',{id,child:true});await flush();
 const row=(await state(f,id)).rows[0];assert.equal(row.status,'skipped');assert.equal(row.reason,'source-worker-change');
 assert.match(f.calls[0].system,/表达：小鲸鲸/);
});

test('one-off feedback uses the original source and accepts legal voice/count wording',async t=>{
 const f=fixture(t,{script:(_,n)=>stream(n===1?'工作助手改了2处配置，设备尚未验证。':'鲸鲸改了两处配置，设备还没验证。')});await f.ready();
 const original='工作助手修改了2处配置，设备尚未验证。';report(f,original);await flush();const first=(await state(f)).rows[0];
 const reply=await f.request('feedback',{sessionId:'expression-context',seq:first.seq,version:first.version,personaId:first.speaker.id,scope:'once',content:'短一点。'});
 assert.equal(reply.status,200);const after=(await state(f)).rows[0];assert.equal(after.status,'ready');assert.match(after.text,/鲸鲸改了两处/);
 assert.equal(f.calls[0].messages[0].content[0].text,f.calls[1].messages[0].content[0].text);assert.equal(f.calls[1].messages[0].content[0].text,'待改写：\n'+original);
 assert.equal((await f.request('memory')).value.entries.length,0);
});
