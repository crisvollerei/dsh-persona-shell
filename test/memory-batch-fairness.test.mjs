import test from 'node:test';
import assert from 'node:assert/strict';
import {createStructuredMemory} from '../lib/structured-memory.js';
import {createMemoryConsolidator,MEMORY_INTERVAL_MS} from '../lib/memory-consolidation.js';

const flush=async()=>{for(let i=0;i<16;i++)await new Promise(setImmediate);};
const group=batch=>JSON.stringify([batch.sources[0]?.personaId,batch.sources[0]?.sessionId]);
function seed(memory,sessionId,personaId,count,start=1){for(let i=start;i<start+count;i++)assert.equal(memory.observe({sessionId,personaId,seq:i,text:'这段原话属于'+sessionId+'里的第'+i+'次交流。'}),true);}
function setup(run){
 let clock=0,next=0;const timers=new Map(),memory=createStructuredMemory({now:()=>clock});
 const worker=createMemoryConsolidator({memory,enabled:()=>true,run,
  setTimer(fn,ms){assert.equal(ms,MEMORY_INTERVAL_MS);const id=++next;timers.set(id,{fn,at:clock+ms});return id;},clearTimer(id){timers.delete(id);}});
 return{memory,worker,timers,get clock(){return clock;},async at(value){
  while(true){const nextTimer=[...timers].filter(([,timer])=>timer.at<=value).sort((a,b)=>a[1].at-b[1].at)[0];if(!nextTimer)break;
   clock=nextTimer[1].at;timers.delete(nextTimer[0]);nextTimer[1].fn();await flush();}
  clock=value;await flush();}};
}

test('ready batches are selected across persona/session groups without a sparse queue head blocking them',()=>{
 const memory=createStructuredMemory();seed(memory,'old','p',2);seed(memory,'busy','p',20);
 const before=memory.snapshot(),batch=memory.batch({minSources:8});
 assert.equal(group(batch),JSON.stringify(['p','busy']));assert.equal(batch.sources.length,12);
 assert.deepEqual(memory.snapshot(),before,'peeking for readiness cannot reorder or consume originals');
 assert.ok(batch.sources.every(source=>source.sessionId==='busy'&&source.personaId==='p'));
});

test('batch rotation and exclusions are scoped by both persona and session, never by a display-like shared name',()=>{
 const memory=createStructuredMemory();seed(memory,'old','a',2);seed(memory,'busy','a',8);seed(memory,'other','b',8);
 const first=memory.batch({minSources:8}),second=memory.batch({minSources:8,afterGroup:group(first)});
 assert.deepEqual([group(first),group(second)],[JSON.stringify(['a','busy']),JSON.stringify(['b','other'])]);
 assert.deepEqual(memory.batch({minSources:8,skipGroups:[group(first),group(second)]}).sources,[]);
 assert.equal(group(memory.batch({afterGroup:group(second)})),JSON.stringify(['a','old']));
});

test('different personas in the same session remain separate extraction groups',()=>{
 const memory=createStructuredMemory();seed(memory,'same-session','a',8);seed(memory,'same-session','b',8,9);
 const first=memory.batch({minSources:8}),next=memory.batch({minSources:8,afterGroup:group(first)});
 assert.equal(group(first),JSON.stringify(['a','same-session']));assert.equal(group(next),JSON.stringify(['b','same-session']));
 assert.equal(first.sources.length,8);assert.equal(next.sources.length,8);
 assert.equal(memory.commit({...first,sources:[first.sources[0],next.sources[0]]},[]),false);
});

test('a ready group receives only its own persona/session correction targets rather than the sparse head owner\'s',()=>{
 const memory=createStructuredMemory();seed(memory,'old','a',2);seed(memory,'busy','b',8);
 for(const entry of [
  {kind:'preference',scope:'persona',personaId:'a',content:'PRIVATE_HEAD_OWNER'},
  {kind:'agreement',scope:'session',personaId:'b',sessionId:'elsewhere',content:'PRIVATE_OTHER_SESSION'},
  {kind:'preference',scope:'persona',personaId:'b',content:'CURRENT_PERSONA_TARGET'},
  {kind:'agreement',scope:'session',personaId:'b',sessionId:'busy',content:'CURRENT_SESSION_TARGET'},
 ])memory.mutate({action:'add',entry});
 const batch=memory.batch({minSources:8});assert.equal(group(batch),JSON.stringify(['b','busy']));
 assert.deepEqual(batch.targets.map(target=>target.content),['CURRENT_PERSONA_TARGET','CURRENT_SESSION_TARGET']);
 assert.doesNotMatch(JSON.stringify(batch),/PRIVATE_HEAD_OWNER|PRIVATE_OTHER_SESSION/);
});

test('forged mixed-group extraction snapshots cannot relabel another persona or session evidence',()=>{
 const memory=createStructuredMemory();seed(memory,'a','one',1);seed(memory,'b','two',1);
 const first=memory.batch(),before=memory.snapshot(),foreign=before.sources.find(source=>source.sessionId==='b');
 assert.equal(memory.commit({...first,sources:[...first.sources,foreign]},[]),false);
 assert.equal(memory.commit({...first,sources:[...first.sources,...first.sources]},[]),false);
 assert.deepEqual(memory.snapshot(),before);
});

test('a selected extraction snapshot cannot mutate stored original words or bypass exact-evidence matching',()=>{
 const memory=createStructuredMemory();seed(memory,'original','p',1);const before=memory.snapshot(),batch=memory.batch();
 batch.sources[0].text='This text was not spoken by the user.';
 assert.deepEqual(memory.snapshot(),before);assert.equal(memory.commit(batch,[]),false);
 assert.equal(memory.batch().sources[0].text,before.sources[0].text);
});

test('twenty new observations run immediately behind two old ones, while the old deadline is preserved',async t=>{
 const calls=[],f=setup(async batch=>{calls.push(batch);return[];});t.after(()=>f.worker.dispose());
 seed(f.memory,'old','p',2);f.worker.notify();assert.equal([...f.timers.values()][0].at,MEMORY_INTERVAL_MS);
 await f.at(1000);seed(f.memory,'busy','p',20);f.worker.notify();await flush();
 assert.deepEqual(calls.map(batch=>[batch.sources[0].sessionId,batch.sources.length]),[['busy',12],['busy',8]]);
 assert.deepEqual(f.memory.snapshot().queue,['old:1','old:2']);
 assert.equal([...f.timers.values()][0].at,MEMORY_INTERVAL_MS,'hot groups must not restart an old sparse group\'s waiting interval');
 await f.at(10000);seed(f.memory,'busy','p',8,21);f.worker.notify();await flush();
 assert.equal(calls.at(-1).sources[0].sessionId,'busy');assert.equal([...f.timers.values()][0].at,MEMORY_INTERVAL_MS);
 await f.at(MEMORY_INTERVAL_MS);assert.equal(calls.at(-1).sources[0].sessionId,'old');assert.equal(f.memory.snapshot().queue.length,0);
 for(const batch of calls)assert.equal(new Set(batch.sources.map(source=>JSON.stringify([source.personaId,source.sessionId]))).size,1);
});

test('a failing ready group yields to another ready group and retries only after the bounded interval',async t=>{
 const calls=[],f=setup(async batch=>{calls.push(batch.sources[0].sessionId);if(batch.sources[0].sessionId==='bad')throw Error('controlled failure');return[];});t.after(()=>f.worker.dispose());
 seed(f.memory,'bad','p',8);seed(f.memory,'healthy','q',8);f.worker.notify();await flush();
 assert.deepEqual(calls,['bad','healthy']);assert.equal(f.memory.snapshot().queue.length,8);
 f.worker.notify();await flush();assert.deepEqual(calls,['bad','healthy'],'notification cannot spin on the same failed group');
 await f.at(MEMORY_INTERVAL_MS-1);assert.deepEqual(calls,['bad','healthy']);
 await f.at(MEMORY_INTERVAL_MS);assert.deepEqual(calls,['bad','healthy','bad']);
});

test('the sparse fairness cursor is not overwritten by repeated immediate work from hot groups',async t=>{
 const calls=[],f=setup(async batch=>{const name=batch.sources[0].sessionId;calls.push(name);if(name==='bad')throw Error('controlled failure');return[];});t.after(()=>f.worker.dispose());
 seed(f.memory,'bad','p',8);seed(f.memory,'quiet','q',2);f.worker.notify();await flush();
 await f.at(MEMORY_INTERVAL_MS);assert.deepEqual(calls,['bad','bad']);
 seed(f.memory,'hot','r',8);f.worker.notify();await flush();assert.equal(calls.at(-1),'hot');
 await f.at(MEMORY_INTERVAL_MS*2);assert.ok(calls.includes('quiet'),'a new hot group cannot send the timer back to the failed queue head forever');
 assert.ok(!f.memory.snapshot().queue.some(id=>id.startsWith('quiet:')));
});
