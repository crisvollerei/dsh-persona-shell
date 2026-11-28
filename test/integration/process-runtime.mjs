import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {runProcessRewrite} from '../../lib/process-rewrite.js';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const {values}=parseArgs({options:{deps:{type:'string'},baseline:{type:'string'}}});
const require=createRequire(resolve(values.deps));
const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const usage={available:true,scope:'since_previous_process_report',categories:{read:{calls:1,returned:1,errors:0,earlier_returns:0}}};
const wire=JSON.stringify({rewrite:'继续看下一部分。',process_note:'刚读了1次。'});
for(const completed of [false,true]){
  let calls=0;
  const result=await runProcessRewrite({options:{provider:'fixture',model:'fixture',signal:new AbortController().signal,messages:[]},usage,
    allowed:()=>true,maxChars:2048,onPartial(){},llm:{async *stream(opts){
      calls++;assert.equal(opts.tools,undefined);assert.deepEqual(JSON.parse(opts.messages.at(-1).content.at(-1).text),{processUsage:usage});
      const assembler=new sdk.BlockAssembler();
      for(const chunk of [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:wire}]){
        assembler.push(chunk);yield chunk;
      }
      if(completed)yield {type:'block-end',index:0,block:assembler.blocks()[0]};
      yield {type:'finish',reason:{kind:'stop'}};
    }}});
  assert.deepEqual(result,{text:'继续看下一部分。',note:'刚读了1次。'});assert.equal(calls,1);
}
console.log(JSON.stringify({sdk:require('@deepseek-ai/dsh-llm/package.json').version,deltaOnlyCalls:1,completedBlockCalls:1}));

if(values.baseline){
  assert.match(values.baseline,/^[0-9a-f]{7,40}$/u);
  function baselineModule(name) {
    const source=execFileSync('git',['show',`${values.baseline}:lib/${name}`],{encoding:'utf8'});
    const resolved=source.replace(/from '(\.\/[\w-]+\.js)'/g,(_,path)=>'from '+JSON.stringify(baselineModule(path.slice(2))));
    return 'data:text/javascript;base64,'+Buffer.from(resolved).toString('base64');
  }
  const old=await import(baselineModule('process-rewrite.js'));
  for(const [label,run] of [['baseline',old.runProcessRewrite],['current',runProcessRewrite]]){
    const samples=[];let calls=0;
    for(let i=0;i<5;i++){
      const start=performance.now();let first;
      await run({options:{provider:'fixture',model:'fixture',messages:[{role:'user',content:[{type:'text',text:'测试'}]}],signal:new AbortController().signal},usage,
        allowed:()=>true,maxChars:2000,onPartial:text=>{if(text && first===undefined)first=performance.now()-start;},llm:{async *stream(options){
          calls++;await delay(100);if(options.tools){yield {type:'block-end',index:0,block:{type:'tool-call',id:'usage',name:'get_tool_usage',arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
          yield {type:'text-delta',index:0,text:wire};yield {type:'finish',reason:{kind:'stop'}};
        }}});samples.push(first);
    }samples.sort((a,b)=>a-b);console.log(`${label} n=5 firstTextP50=${Math.round(samples[2])}ms calls=${calls/5}`);
  }
}
