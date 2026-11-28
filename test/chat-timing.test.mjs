import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatTiming} from '../lib/chat-timing.js';

test('timing retains only bounded anonymous stages and excludes unsuccessful rounds from percentiles',()=>{
  const t=createChatTiming({limit:6});
  const sample={at:1,path:'direct',saved:0,roomId:'private',message:'secret',contextDone:null,directorDone:null,
    calls:{director:0,actor:1,context:0,support:0}};
  for(let n=0;n<=5;n++)t.record({...sample,firstText:n,done:n+10});
  t.record({...sample,firstText:999,done:null,calls:{director:0,actor:0,context:0,support:0}});t.record({...sample,firstText:-1,done:10});
  assert.equal(t.snapshot().length,6);assert.doesNotMatch(JSON.stringify(t.snapshot()),/secret|private|roomId/);
  assert.deepEqual(t.summary().paths.direct.firstText,{p50:3,p90:5});assert.equal(t.summary().failed,1);
  assert.equal(t.summary().paths.direct.count,6);assert.equal(t.summary().paths.direct.avgCalls,1);
  const short=createChatTiming();short.restore(t.snapshot().slice(-4));assert.equal(short.summary().paths.direct.firstText.p50,null);
  const failed=createChatTiming();failed.restore(t.snapshot().slice(-1));assert.equal(failed.summary().paths.direct.avgCalls,null);
});

test('late storage restore keeps local rounds and merges retained history only once', () => {
  const timing=createChatTiming({limit:3});
  const sample={path:'direct',contextDone:null,directorDone:null,firstText:2,done:3,calls:{director:0,context:0,actor:1,support:0}};
  const saved=[1,2,3].map(at=>({...sample,at}));
  timing.record({...sample,at:4});timing.restore(saved);timing.restore(saved);
  assert.deepEqual(timing.snapshot().map(s=>s.at),[2,3,4]);
});
