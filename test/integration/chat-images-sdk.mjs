// Published SDK + actual prepared-call binding; no remote provider or user credentials.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createExpressionLlm} from '../../lib/expression-llm.js';
const {values}=parseArgs({options:{deps:{type:'string'}}}),require=createRequire(path.resolve(values.deps));
const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const ctx=new Context(),calls=[],attachment={attachmentId:'a'.repeat(64),mediaType:'image/png',bytes:67,width:1,height:1,name:'example.png'};
class Adapter extends sdk.LlmAdapter {
 async resolveModel(provider,id){return{provider,id,name:id,...(id==='unknown'?{}:{inputModalities:id==='vision'?['text','image']:['text']})};}
 async *stream(options){calls.push(options);yield{type:'text-delta',text:'已接到消息。',index:0};yield{type:'finish',reason:{kind:'stop'}};}
}
try{
 await ctx.plugin(sdk.LlmRuntime);const llm=ctx.get('llm');llm.registerAdapter(['local'],new Adapter());
 const run=async(model,required=true)=>{for await(const chunk of createExpressionLlm(llm).stream({provider:'local',model,imageInputRequired:required,signal:new AbortController().signal,messages:[{role:'user',content:[{type:'text',text:'合成图片输入'},{type:'image',attachment}]}]})){if(chunk.type==='error')throw chunk.error??chunk.failure;}};
 await run('vision');assert.deepEqual(calls.at(-1).messages[0].content[1],{type:'image',attachment});
 await assert.rejects(run('text'),/chat-vision-unavailable/);assert.equal(calls.length,1);
 await run('text',false);assert.ok(calls.at(-1).messages[0].content.every(b=>b.type==='text'));assert.match(calls.at(-1).messages[0].content.at(-1).text,/不支持视觉/);
 await run('unknown');assert.equal(calls.at(-1).messages[0].content[1].type,'image');
 console.log(JSON.stringify({result:'passed',sdk:require('@deepseek-ai/dsh-llm/package.json').version,checks:['native image reference at exact prepared adapter','text-only rejection before dispatch','historical placeholder projection','unknown modality attempts image'],physicalProviderRequests:0}));
}finally{await ctx.fiber.dispose();}
