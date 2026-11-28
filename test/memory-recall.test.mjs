import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryTerms, memoryRelevance, recallQuery } from '../lib/memory-recall.js';
import { relativeDay, createChatTimeContext } from '../lib/chat-time.js';
import {createStructuredMemory} from '../lib/structured-memory.js';

test('topic terms keep mixed-language words, remove technical spans and ignore stop words',()=>{
  for (const [input,expected] of [['团子喜欢 Rust 22',['团子','子喜','rust','22']],['今天 the `secret`',[]],['',[]]])
    assert.deepEqual([...memoryTerms(input)],expected);
  assert.ok(memoryRelevance({content:'之前在学 Rust',tags:[],evidence:[]},recallQuery('Rust 学得怎么样')).score>0);
});
test('chat recalls specific topics and ignores incidental two-character words',()=>{
  const memory=createStructuredMemory();
  const contents=['用户养了一只叫团子的猫','用户在准备驾照考试','用户不喜欢吃香菜','用户周末常去爬山','用户上个月和朋友一起去了海边','用户的工作是前端开发'];
  const tags=[['团子','猫'],['驾照']];
  contents.forEach((content,i)=>memory.mutate({action:'add',entry:{kind:'episode',scope:'persona',personaId:'a',content,tags:tags[i]}}));
  for(const [text,expected] of [
    ['团子今天把杯子打翻了',[contents[0]]],['周末去哪玩',[contents[3]]],['这个菜里有香菜吗',[contents[2]]],
    ['我喜欢这首歌',[]],['我们一起看电影吧',[]],['这个工作好难',[]],['今天好累',[]],
    ['开发者大会',[contents[5]]], // Weak but intentional: 开发 is a meaningful topic in both texts.
  ])assert.deepEqual(memory.selection({purpose:'chat',personaId:'a',text}).entries.map(e=>e.content),expected,text);
});

test('chat agreements leave room for a matching experience; pinned experiences still need a topic',()=>{
  const m=createStructuredMemory(), common={kind:'agreement',scope:'session',sessionId:'room:x'};
  for(const content of ['进门打招呼','结尾用短句']) m.rememberChat({entry:{...common,content},
    evidence:{eventId:content,quote:content,complete:true,source:'message',sessionId:common.sessionId}});
  const both=['咖啡拿铁','咖啡摩卡'].map(content=>m.mutate({action:'add',entry:{...common,kind:'episode',content}}));
  m.mutate({action:'pin',id:both[0].id,version:both[0].version,pinned:true});
  const select=text=>m.selection({purpose:'chat',sessionId:common.sessionId,personaId:'a',text});
  const related=select('咖啡');assert.equal(related.entries.length,2);
  assert.ok(related.entries.some(e=>e.id===both[0].id && e.basis==='pinned'));
  assert.ok(related.entries.some(e=>e.kind==='agreement'));
  const other=select('今天好累');assert.deepEqual(other.entries.map(e=>e.kind),['agreement','agreement']);
  assert.ok(other.omitted.some(ref=>ref.id===both[0].id && ref.reason==='irrelevant'));
});
test('old relevant experience beats recent records and cannot cross persona or report boundaries',()=>{
  let at=100;const memory=createStructuredMemory({now:()=>at++});
  for(const content of ['团子打翻杯子','驾照考试','周末爬山','海边烟花','野外徒步','冬季滑雪'])memory.mutate({action:'add',entry:{kind:'episode',scope:'persona',personaId:'a',content}});
  const options={personaId:'a',text:'团子今天怎么样',purpose:'chat'};
  assert.deepEqual(memory.select(options).map(e=>e.content),['团子打翻杯子']);
  for(const patch of [{text:'书架'}, {personaId:'b'}, {purpose:'rewrite'}])assert.deepEqual(memory.select({...options,...patch}),[]);
});
test('coarse time follows local civil dates across midnight, month and year',()=>{
  const time=createChatTimeContext({timeZone:'Asia/Hong_Kong'},Date.parse('2026-01-01T00:01:00+08:00'));
  for(const [date,label] of [['2025-12-31T23:59:00+08:00','昨天'],['2026-01-01T00:00:00+08:00','今天'],['2025-12-20','12 天前'],['2025-12-01','上个月'],['2025-09-01','2025 年 9 月'],['2026-01-02','最近']])assert.equal(relativeDay(Date.parse(date),time),label);
});

test('short English tags require whole tokens even next to Chinese words',()=>{
  const entry={content:'一次课外活动',tags:['AI','go','ui'],evidence:[]};
  assert.deepEqual(memoryRelevance(entry,recallQuery('again good build')),{score:0,tag:false});
  for(const text of ['我学AI','Go!','(UI)']) assert.equal(memoryRelevance(entry,recallQuery(text)).tag,true);
});

test('room agreements outrank identical-key persona agreements and keep their place in the total budget',()=>{
  const m=createStructuredMemory();
  const room=m.rememberChat({entry:{kind:'agreement',scope:'session',sessionId:'room:x',content:'约定先说结果',key:'rule'},
    evidence:{source:'message',complete:true,eventId:'q',sessionId:'room:x',quote:'先说结果'}});
  const other=m.mutate({action:'add',entry:{kind:'agreement',scope:'persona',personaId:'p',content:'另一个约定',key:'rule'}});
  for(let i=0;i<6;i++)m.mutate({action:'add',entry:{kind:'preference',scope:'shared',key:'key'+i,content:'偏好'+i}});
  const {entries,omitted}=m.selection({purpose:'chat',sessionId:'room:x',personaId:'p',text:'继续'});
  assert.equal(entries.length,5);assert.equal(entries[0].id,room.id);assert.ok(omitted.some(e=>e.id===other.id&&e.reason==='overridden'));
});
