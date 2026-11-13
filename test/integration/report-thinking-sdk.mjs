// Production Host + published prepared-call SDK. Deterministic adapter; no credentials or external requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fixture} from '../helpers/persona-chat-host.mjs';
const {values}=parseArgs({options:{deps:{type:'string'}}}),require=createRequire(path.resolve(values.deps));
const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm'))),{Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis'))),ctx=new Context(),calls=[],cleanup=[];
class Adapter extends sdk.LlmAdapter{
 async resolveModel(provider,id){return{provider,id,name:id,...(id==='unknown'?{}:{reasoning:{efforts:[{id:'off',name:'off'},{id:'low',name:'low'}]}})};}
 async *stream(options){assert.equal(options.tools,undefined);calls.push(options);let body;try{body=JSON.parse(options.messages[0].content[0].text);}catch{}
  const text=body?.task==='report-readable'?JSON.stringify({schemaVersion:3,blocks:body.source.blocks.map(({ref,text})=>({ref,text}))}):options.messages[0].content[0].text.split('待改写：\n').at(-1);
  yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}};
 }
}
try{
 await ctx.plugin(sdk.LlmRuntime);ctx.get('llm').registerAdapter(['local'],new Adapter());
 const f=fixture({after:fn=>cleanup.push(fn)},{config:{provider:'local',model:'m'},extraServices:[['llm',ctx.get('llm')]]});await f.ready();await f.request('settings',{enabled:false});
 const publish=(id,seq)=>{const session={id,header:{}};for(const [type,n,data]of [['turn/start',seq-1,{}],['assistant/message',seq,{message:{content:[{type:'text',text:'本地检查通过，设备尚未验证。'}]}}],['turn/end',seq+1,{reason:{kind:'completed'}}]])f.bus.emit('session/event',session,{type,seq:n,data});};
 publish('work',10);const source=(await f.request('report-visualization?session=work&seq=10&presentation=readable')).value.source;
 const generate=id=>f.request('report-visualization',{action:'generate',sessionId:'work',seq:10,sourceHash:source.hash,presentation:'readable',requestId:id,regenerate:true});
 assert.equal((await generate('readable')).status,200);assert.equal(calls.at(-1).reasoningEffort,'low');
 async function adjust(thinking){const row=(await f.request('state?session=work')).value.rows.find(r=>r.seq===10);return f.request('feedback',{sessionId:'work',seq:10,version:row.version,personaId:row.speaker.id,sourceHash:row.sourceHash,scope:'once',content:'保留条件，表达自然些。',...(thinking===undefined?{}:{thinking})});}
 assert.equal((await adjust()).status,200);assert.equal(calls.at(-1).reasoningEffort,'low');assert.equal((await adjust(false)).status,200);assert.equal(calls.at(-1).reasoningEffort,'off');
 await f.request('settings',{enabled:true});publish('automatic',20);await f.ready();assert.equal(calls.at(-1).reasoningEffort,'off');
 const before=calls.length;await f.request('settings',{visualizationProvider:'local',visualizationModel:'unknown'});const unavailable=await generate('unknown');assert.equal(unavailable.value.error,'report-thinking-unavailable');assert.equal(calls.length,before);assert.equal((await f.request('report-visualization?session=work&seq=10&presentation=readable')).value.cached,true);
 console.log(JSON.stringify({result:'passed',sdk:require('@deepseek-ai/dsh-llm/package.json').version,physicalProviderRequests:0,controlledPhysicalRequests:calls.length,checks:['readable default explicitly enables thinking','manual adjustment default explicitly enables thinking','manual one-off opt-out','automatic rewrite unchanged','unknown thinking rejected before dispatch with cache retained']}));
}finally{for(const fn of cleanup.reverse())await fn();await ctx.fiber.dispose();}
