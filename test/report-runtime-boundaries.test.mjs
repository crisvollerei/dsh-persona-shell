import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,domain} from './helpers/persona-chat-host.mjs';
const report=(f,id,text,seq=1)=>f.bus.emit('session/event',{id,header:{}},{type:'assistant/message',seq,
 data:{message:{role:'assistant',content:[{type:'text',text}]}}});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

test('stream frames notify without repeating durable rows and final report still restores', {timeout:6000}, async t=>{
 const gates=[deferred(),deferred(),deferred()];t.after(()=>gates.forEach(g=>g.resolve()));
 const writes=[],storage=domain(Promise.resolve(),{beforePut(key,value){if(key==='io-work')writes.push(structuredClone(value));}});
 const original='本地配置已经调整，客户端尚未验证。';
 const f=fixture(t,{storage,script:()=> (async function*(){
  yield{type:'text-delta',text:'本地配置'};await gates[0].promise;
  yield{type:'text-delta',text:'已经调整，'};await gates[1].promise;
  yield{type:'text-delta',text:'客户端尚未验证。'};await gates[2].promise;
  yield{type:'finish',reason:{kind:'stop'}};
 })()});await f.ready();report(f,'io-work',original);await flush();await wait(450);
 assert.equal(writes.length,1);assert.equal(writes[0][0].status,'pending');
 let rev=(await f.request('state?session=io-work')).value.rev;
 for(let i=0;i<2;i++){
  gates[i].resolve();await flush();await wait(450);
  const state=(await f.request('state?session=io-work')).value;
  assert.ok(state.rev>rev);rev=state.rev;assert.ok(state.rows[0].partial.length>0);
  assert.equal(writes.length,1,'partial-only changes do not schedule durable report writes');
 }
 gates[2].resolve();await flush();await f.dispose();
 assert.equal(writes.at(-1)[0].status,'ready');assert.equal(writes.at(-1)[0].text,original);
 assert.equal(Object.hasOwn(writes.at(-1)[0],'partial'),false);
 const restart=fixture(t,{storage});await restart.ready();
 assert.equal((await restart.request('state?session=io-work')).value.rows[0].text,original);
});

test('unbound preset generation follows recent main activity and ignores replay and child activity',async t=>{
 const f=fixture(t,{config:{provider:'',model:''},script:()=> (async function*(){
  yield{type:'text-delta',text:JSON.stringify({name:'示例',identity:'只用于隔离测试',report:['保留事实'],voice:['自然']})};
  yield{type:'finish',reason:{kind:'stop'}};
 })()});await f.ready();
 const header=(id,model,seq,child=false)=>f.bus.emit('session/event',{id,header:child?{origin:'subagent'}:{}},
  {type:'request/header',seq,data:{header:{config:{provider:'local',model}}}});
 const user=(id,seq)=>f.bus.emit('session/event',{id,header:{}},{type:'user/message',seq,data:{content:[{type:'text',text:'当前问题'}]}});
 const generate=async()=>{await f.request('presets',{action:'generate',prompt:'这是用于验证最新工作会话选择的虚构人格材料。'});return f.calls.at(-1).model;};
 header('A','model-A',1);header('B','model-B',1);
 assert.equal(await generate(),'model-B');
 user('A',2);assert.equal(await generate(),'model-A');
 header('B','model-B',1);header('child','model-child',20,true);
 assert.equal(await generate(),'model-A','old events and helper work do not steal the recent main hint');
 user('B',3);assert.equal(await generate(),'model-B');
 header('B','model-B-new',4);assert.equal(await generate(),'model-B-new');
 header('B','stale-model',1);user('B',5);
 assert.equal(await generate(),'model-B-new','replayed headers cannot replace a newer actual route');
 f.bus.emit('session/event',{id:'A',header:{}},{type:'user-message',seq:6,data:{content:[{type:'text',text:'旧版宿主用户消息'}]}});
 assert.equal(await generate(),'model-A','the supported legacy user event also updates main activity');
});
