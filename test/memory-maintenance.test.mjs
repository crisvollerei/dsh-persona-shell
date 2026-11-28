import test from 'node:test';
import assert from 'node:assert/strict';
import {createStructuredMemory} from '../lib/structured-memory.js';

test('capacity preserves active, pinned and recent audit records and clears an expired session first',()=>{
  let at=10;const m=createStructuredMemory({now:()=>at});
  const add=(n,extra={})=>m.mutate({action:'add',entry:{content:'记录'+n,kind:'context',scope:'session',sessionId:'work',expiresAt:null,...extra}});
  const pinned=add(0,{expiresAt:11});m.mutate({action:'pin',id:pinned.id,version:1,pinned:true});
  const expired=add(1,{expiresAt:11});for(let i=2;i<200;i++)add(i);
  at=12;add('新');assert.ok(m.snapshot().entries.some(e=>e.id===pinned.id));assert.equal(m.snapshot().entries.some(e=>e.id===expired.id),false);
  assert.throws(()=>add(201),e=>e.message==='memory-capacity' && e.capacity.cleanable===0);
});
const agreement = {kind:'agreement',scope:'persona',personaId:'p1',content:'用户希望汇报先说结论再说细节'};
const roomQuote = (id, quote, complete=true) => ({eventId:id,quote,complete,source:'message',sessionId:'room:x'});

test('mixed chat and manual agreements have separate merge groups and a direct merge leaves both untouched',()=>{
  const m=createStructuredMemory();
  const a=m.mutate({action:'add',entry:agreement});
  const b=m.rememberChat({entry:{...agreement,content:agreement.content+'吧'},evidence:roomQuote('chat:1#0','汇报先说结论再说细节吧')});
  assert.deepEqual(m.capacity().similar,[]);
  const before=m.snapshot();
  for (const keep of [a,b]) assert.throws(()=>m.mutate({action:'merge',keep:keep.id,refs:[a,b],content:agreement.content}),/invalid-memory-merge/);
  assert.deepEqual(m.snapshot(),before);
  assert.deepEqual(m.select({personaId:'p1',sessionId:'w',purpose:'rewrite'}).map(e=>e.id),[a.id]);
});

test('merging chat agreements keeps complete room evidence even when partial quotes fill the evidence budget',()=>{
  const m=createStructuredMemory();let a;
  for (let i=0;i<4;i++) a=m.rememberChat({entry:agreement,evidence:roomQuote('fragment'+i,'先说结论',false)});
  const full=roomQuote('chat:1#0','汇报先说结论再说细节吧');
  const b=m.rememberChat({entry:{...agreement,content:agreement.content+'吧'},evidence:full});
  const [refs]=m.capacity().similar;
  const merged=m.mutate({action:'merge',keep:a.id,refs,content:agreement.content});
  assert.equal(merged.origin,'chat');assert.equal(merged.evidence.length,4);assert.deepEqual(merged.evidence[0],full);
  assert.equal(m.versionStatus(b.id),'superseded');
  assert.deepEqual(m.select({purpose:'chat',personaId:'p1'}).map(e=>e.id),[a.id]);
  assert.deepEqual(m.select({purpose:'rewrite',personaId:'p1'}),[]);
});

test('manual merges preserve report access, require current versions and cannot cross persona scopes',()=>{
  const m=createStructuredMemory();
  const add=entry=>m.mutate({action:'add',entry});
  const a=add(agreement), b=add({...agreement,content:agreement.content+'吧'}), other=add({...agreement,personaId:'p2'});
  const merge=refs=>m.mutate({action:'merge',keep:a.id,refs,content:'用户希望汇报先说结论'});
  assert.throws(()=>merge([a,other]),/memory-conflict/);
  const merged=merge([a,b]);assert.equal(merged.origin,a.origin);
  assert.deepEqual(m.select({purpose:'rewrite',personaId:'p1'}),[merged]);
  assert.equal(m.versionStatus(b.id),'superseded');assert.throws(()=>merge([a,b]),/memory-conflict/);
});

test('a single extra modifier still permits a near-duplicate suggestion',()=>{
  const m=createStructuredMemory();
  const refs=['用户喜欢喝咖啡','用户很喜欢喝咖啡'].map(content=>{
    const {id,version}=m.mutate({action:'add',entry:{...agreement,kind:'episode',content}});return {id,version};
  });
  assert.deepEqual(m.capacity().similar,[refs]);
});
test('room quote evidence cannot be moved by edits or restored with a mismatched scope',()=>{
  const m=createStructuredMemory();
  const evidence={sessionId:'room:one',source:'message',complete:true,eventId:'original#0',quote:'先说重点'};
  const entry=m.rememberChat({entry:{scope:'session',sessionId:'room:one',kind:'agreement',content:evidence.quote},evidence});
  for (const scope of [{scope:'session',sessionId:'room:two'},{scope:'persona',personaId:'other'}]) {
    assert.throws(()=>m.mutate({action:'update',id:entry.id,version:entry.version,...scope,content:'新措辞',pinned:false}),/invalid-memory-scope/);
    assert.deepEqual(m.snapshot().entries,[entry]);
  }
  for (const refs of [[evidence],[{...evidence,sessionId:'room:two'},evidence]]) {
    const bad={...entry,sessionId:'room:two',evidence:refs};
    m.restore({version:1,entries:[bad]});
    assert.equal(m.snapshot().entries[0].status,'rejected');
    assert.deepEqual(m.select({purpose:'chat',sessionId:'room:two'}),[]);
    assert.deepEqual(m.references([bad],{purpose:'chat',sessionId:'room:two'}),[]);
  }
});

test('duplicate observations and manual merges keep complete evidence before filling four slots with fragments',()=>{
  const m=createStructuredMemory();
  const complete=roomQuote('full','真正完整的原话');
  m.rememberChat({entry:agreement,evidence:complete});
  for(let i=0;i<5;i++)m.rememberChat({entry:agreement,evidence:roomQuote('partial'+i,'片段',false)});
  assert.deepEqual(m.select({purpose:'chat',personaId:'p1'})[0].evidence[0],complete);
  const a=m.mutate({action:'add',entry:{...agreement,kind:'episode'}});
  const b=m.mutate({action:'add',entry:{...agreement,kind:'episode',content:agreement.content+'呢'}});
  const fragments=Array.from({length:4},(_,i)=>({eventId:'s'+i,quote:'部分',source:'settings',complete:false}));
  m.restore({version:1,entries:[{...a,evidence:fragments},b]});
  const merged=m.mutate({action:'merge',refs:[a,b],keep:a.id,content:a.content});
  assert.equal(merged.evidence.length,4);assert.deepEqual(merged.evidence[0],b.evidence[0]);
  assert.deepEqual(m.references([merged],{purpose:'chat',personaId:'p1'}),[merged]);
});
