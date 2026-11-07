import test from 'node:test';
import assert from 'node:assert/strict';
import { partialChatReply,createChatLive } from '../lib/chat-live.js';

test('incremental chat JSON exposes only message strings and waits for unfinished escapes',()=>{
  assert.deepEqual(partialChatReply('{"messages":["鲸鲸'),[{text:'鲸鲸',complete:false}]);
  assert.deepEqual(partialChatReply('{"messages":["a\\'),[{text:'a',complete:false}]);
  assert.deepEqual(partialChatReply('{"messages":["a\\uD83D\\u'),[{text:'a',complete:false}]);
  assert.deepEqual(partialChatReply('{"messages":["a\\uD83D\\uDE00","b\\n第二句"]}'),[{text:'a😀',complete:true},{text:'b\n第二句',complete:true}]);
});
test('every split of escaped text remains bounded and the final strings match canonical JSON',()=>{
  const messages=['第一句："你好"，C:\\work\n下一行。','鲸鲸😀','第三句'];const wire=JSON.stringify({messages});
  for(let i=0;i<=wire.length;i++){const parsed=partialChatReply(wire.slice(0,i));assert.ok(parsed.length<=3);assert.ok(parsed.every(m=>typeof m.text==='string'));}
  assert.deepEqual(partialChatReply(wire).map(m=>m.text),messages);
});
test('malformed prefixes and over-budget message drafts are not shown',()=>{
  for(const value of ['thinking SECRET {"messages":["x"]}','{"reasoning":"SECRET"}','{"messages":["bad\\x'])assert.deepEqual(partialChatReply(value),[]);
  assert.deepEqual(partialChatReply('{"messages":["'+ 'a'.repeat(2001)),[]);
  assert.deepEqual(partialChatReply(JSON.stringify({messages:['x'.repeat(2000),'y'.repeat(2000),'z'.repeat(2000),'extra']})),[]);
});

test('JSON fences and plain paragraphs stream text without displaying their wrapper or tagged reasoning', () => {
  const wire = '```json\n{"messages":["第一句😀","下一句"]}\n```';
  for (let i = 0; i <= wire.length; i++) {
    const parts = partialChatReply(wire.slice(0, i));
    assert.ok(parts.every(part => !part.text.includes('```') && !part.text.includes('messages')));
  }
  assert.deepEqual(partialChatReply(wire).map(m => m.text), ['第一句😀', '下一句']);
  assert.deepEqual(partialChatReply('第一句。\n\n第二句正在'), [{ text: '第一句。', complete: true }, { text: '第二句正在', complete: false }]);
  assert.deepEqual(partialChatReply('<think>PRIVATE</think>正文'), []);
});
test('live snapshots coalesce, clear and release subscribers on abort',async()=>{
  const live=createChatLive(),abort=new AbortController();const observer=live.observe('p',abort.signal);
  assert.equal((await observer.next()).value,null);
  live.publish('p',{revision:1,text:'old'});live.publish('p',{revision:2,text:'latest'});
  assert.equal((await observer.next()).value.text,'latest');live.clear('p');assert.equal((await observer.next()).value,null);
  const waiting=observer.next();abort.abort();assert.equal((await waiting).done,true);live.close();
});
test('live subscribers and retained snapshots have hard bounds',async()=>{
  const live=createChatLive({limit:1}),abort=new AbortController();const first=live.observe('p',abort.signal);await first.next();
  await assert.rejects(live.observe('p',new AbortController().signal).next(),/capacity/);
  for(let i=0;i<65;i++)live.publish(String(i),{revision:i});assert.equal(live.read('0'),undefined);assert.equal(live.read('64').revision,64);
  abort.abort();await first.next();live.close();
});

test('each recipient stream stays independent and room cleanup releases only its own frames',()=>{
  const live=createChatLive();live.publish('a-1',{roomId:'a',personaId:'whale',messages:['鲸']});
  live.publish('a-2',{roomId:'a',personaId:'dragon',messages:['龙']});live.publish('b-1',{roomId:'b',messages:['其他房间']});
  live.publish('a-1',{roomId:'a',personaId:'whale',messages:['更新']});
  assert.deepEqual(live.read('a-2').messages,['龙']);live.clearRoom('a');
  assert.equal(live.read('a-1'),undefined);assert.equal(live.read('a-2'),undefined);assert.deepEqual(live.read('b-1').messages,['其他房间']);
});
