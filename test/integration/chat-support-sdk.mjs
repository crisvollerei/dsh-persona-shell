// Published prepared-call SDK; synthetic provider, no credentials or live model/network.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createExpressionLlm} from '../../lib/expression-llm.js';
import {createChatSupport} from '../../lib/chat-support.js';
import {runChatSupport} from '../../lib/chat-support-runner.js';
const {values}=parseArgs({options:{deps:{type:'string'}}}),require=createRequire(path.resolve(values.deps));
const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm'))),{Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const ctx=new Context(),physical=[],decisions=[];let retry=true,actions=[];
class Adapter extends sdk.LlmAdapter{
 async resolveModel(provider,id){return{provider,id,name:id,reasoning:{efforts:[{id:'off',name:'关闭'},{id:'high',name:'高'}]}};}
 async *stream(options){physical.push(options);assert.equal(options.tools,undefined);
  if(retry){retry=false;yield{type:'finish',reason:{kind:'error',failure:{code:'UNSUPPORTED_REASONING_EFFORT'}}};return;}
  yield{type:'text-delta',index:0,text:JSON.stringify(actions.shift())};yield{type:'finish',reason:{kind:'stop'}};
 }
}
try{
 await ctx.plugin(sdk.LlmRuntime);ctx.get('llm').registerAdapter(['local'],new Adapter());
 const manager=createChatSupport({execute:options=>runChatSupport({...options,call:async(request,onDispatch)=>{
  const llm=createExpressionLlm(ctx.get('llm'),{thinking:options.job.template==='reason',thinkingRequired:options.job.template==='reason',onDispatch,onDecision:v=>decisions.push(v)});let text='';
  for await(const chunk of llm.stream({...request,provider:'local',model:options.job.template==='reason'?'strong':'flash'})){if(chunk.type==='text-delta')text+=chunk.text;}return text;
 },search:async()=>({sources:[{url:'https://example.com/page'}]}),readPage:async url=>({url,text:'真实读取的受控网页正文'})})});
 const scope={roomId:'room',generation:0,scopeKey:null,referenceRevision:0,messageId:'one',actorId:'fish',template:'research',goal:'核对公开资料',question:'当前条件？'};
 actions=[{action:'search',query:'official'},{action:'read',sourceId:'w1'},{action:'finish',answer:'条件在这里。',sources:['w1']}];
 const research=await manager.start(scope);assert.equal(research.status,'completed');assert.equal(research.counts.calls,4);assert.equal(physical.length,4);assert.ok(physical.every(p=>p.model==='flash'));
 retry=true;const reason=await manager.start({...scope,messageId:'two',template:'reason'});assert.equal(reason.error,'thinking-unavailable');assert.equal(reason.counts.calls,1);assert.equal(physical.length,5);assert.equal(physical.at(-1).model,'strong');assert.equal(physical.at(-1).reasoningEffort,'high');
 await manager.dispose();console.log(JSON.stringify({result:'passed',sdk:require('@deepseek-ai/dsh-llm/package.json').version,checks:['native prepared route','research compatibility retry costs physical budget','no native tools','separate reasoning route and thinking','reason retry stopped before second physical dispatch'],physicalProviderRequests:0,controlledPhysicalRequests:physical.length}));
}finally{await ctx.fiber.dispose();}
