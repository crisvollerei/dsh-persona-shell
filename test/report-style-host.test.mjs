import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,domain,flush } from './helpers/persona-chat-host.mjs';

const report=(f,seq)=>f.bus.emit('session/event',{id:'formal-style',header:{}},{seq,type:'assistant/message',
  data:{message:{content:[{type:'text',text:'本次修改仅保存在本地，尚未推送。真实环境中仍需验证。'}]}}});
const plain=()=>(async function*(){yield{type:'text-delta',text:'这次只在本地改了，还没推送。真实环境里还得验证。'};yield{type:'finish',reason:{kind:'stop'}};})();

test('an early explicit false survives restore, persistence and restart, and reaches formal rewrite calls',async t=>{
  let release;const storage=domain(new Promise(resolve=>{release=resolve;}));
  const first=fixture(t,{storage});
  assert.equal((await first.request('settings',{colloquialReports:false})).status,200);
  release();await first.ready();
  assert.equal((await first.request('settings')).value.settings.colloquialReports,false);
  await first.dispose();assert.equal(storage.tables.get('profile').get('settings').colloquialReports,false);
  const next=fixture(t,{storage,script:plain});await next.ready();report(next,1);await flush();
  assert.equal(next.calls.length,1);assert.match(next.calls[0].system,/本次关闭口语化/);
  assert.doesNotMatch(next.calls[0].system,/本次开启口语化/);
  assert.match(next.calls[0].system,/不得删除原文中的风险提示、适用条件或不确定性说明/);
});

test('default colloquial reporting can be switched without changing the persona, chat route or original report',async t=>{
  const f=fixture(t,{script:plain});await f.ready();
  const before=(await f.request('settings')).value.settings;
  assert.equal(before.colloquialReports,true);report(f,1);await flush();
  assert.match(f.calls[0].system,/本次开启口语化/);
  const response=await f.request('settings',{colloquialReports:false});assert.equal(response.status,200);
  assert.deepEqual(response.value.settings.pack,before.pack);
  assert.equal(response.value.settings.chatModel,before.chatModel);
  assert.equal(response.value.settings.chatThinking,before.chatThinking);
  report(f,2);await flush();assert.match(f.calls[1].system,/本次关闭口语化/);
  assert.equal(f.calls[0].messages[0].content[0].text.split('待改写：')[1],f.calls[1].messages[0].content[0].text.split('待改写：')[1]);
});
