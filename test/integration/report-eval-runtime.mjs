import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {normalizePack} from '../../lib/pack.js';
import {reportTrial} from '../../lib/persona-preview.js';
import {mask} from '../../lib/mask.js';
import {openLiveModel} from '../helpers/live-model.mjs';

const cases=[
 ['Windows 完成两项，Linux 完成七项','Windows 完成七项，Linux 完成两项','source-quantity-attribution'],
 ['Windows 完成 2 项，Linux 完成 7 项','Linux 完成 7 项，Windows 完成 2 项'],
 ['前端修复 3 处，后端修复 5 处','前端修复 5 处，后端修复 3 处','source-quantity-attribution'],
 ['先读取 `a.yml`，确认后再次读取 `a.yml`。','先读取 [[0]]。','dropped-marker'],
 ['先检查 `a.yml`。','先检查 [[0]] 和 [[0]]。','duplicate-marker'],
 ['先检查 `a.yml`。','先检查 [[2]]。','unknown-marker'],
 ['先在 `src/a.ts` 改默认值，再运行 `npm test`。'],
 ['子代理负责检查，主助手还在等待。'],
 ['主助手提交了草稿，子代理尚未审核。'],
 ['只有你确认之后，才会部署。'],
 ['证书尚未核验，失败原因可能是网络。'],
 ['只有在权限和环境都满足时才能重跑。'],
 ['原报告写道“用户说「我只要 Linux」”。',null,null,true],
 ['姐姐检查了报告。','姐姐检查了报告，我觉得可以。',null,true,'self-reference'],
 ['姐姐看过测试结果。','姐姐看过测试结果，本海星觉得可以。',null,true,'self-reference'],
 ['请保留 `/tmp/a.log` 与 `/tmp/b.log` 直到核对完毕。'],
 ['一共修改 12 行，另外 3 行尚未审核。','一共修改 13 行，另外 3 行尚未审核。','source-quantity-change'],
 ['请先运行 `node --version`，确认后再运行 `npm run check`。']
];
const {values}=parseArgs({options:{live:{type:'boolean'},deps:{type:'string'}}});
const live=values.live?await openLiveModel(values.deps):null;
const metrics={mode:live?'live':'fixture',samples:cases.length,accepted:0,softReviews:0,selfReference:0,fallbacks:{},usageSamples:0,inputTokens:null,outputTokens:null,firstTextP50Ms:null,firstTextP90Ms:null};
const timings=[];
try {
  for(const [original,candidate,fallback,strict,self] of cases){
    const pack=normalizePack({identity:'鲸鲸自称『本海星』',narration:{mode:strict?'relay':'voice',assistant:'姐姐',selfReference:strict?'none':'natural'}});
    const trial=reportTrial({original,pack,name:'鲸鲸'});let wire=candidate??mask(original).masked;
    if(live){wire='';let first=null,finish,usage;const start=performance.now();try{
      for await(const chunk of live.llm.stream({...live.route,signal:AbortSignal.timeout(60000),system:trial.system,messages:[{role:'user',content:[{type:'text',text:trial.user}]}]})){
        if(chunk.type==='text-delta'){if(chunk.text && first===null)first=Math.round(performance.now()-start);wire+=chunk.text;}
        if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason?.kind;
      }if(finish!=='stop')throw Error('incomplete');
    }catch{metrics.fallbacks['model-failure']=(metrics.fallbacks['model-failure']??0)+1;continue;}
      if(first!==null)timings.push(first);
      if(Number.isFinite(usage?.inputTokens)&&Number.isFinite(usage.outputTokens)){metrics.usageSamples++;metrics.inputTokens+=usage.inputTokens;metrics.outputTokens+=usage.outputTokens;}
    }
    const result=trial.check(wire);
    if(!live){assert.equal(result.fallback,fallback??null,original);if(self)assert.ok(result.reasons.includes(self));}
    if(result.fallback)metrics.fallbacks[result.fallback]=(metrics.fallbacks[result.fallback]??0)+1;else metrics.accepted++;
    if(result.reasons.length)metrics.softReviews++;if(result.reasons.includes('self-reference'))metrics.selfReference++;
  }
}finally{await live?.close();}
timings.sort((a,b)=>a-b);for(const p of [50,90])metrics['firstTextP'+p+'Ms']=timings[Math.ceil(timings.length*p/100)-1]??null;
console.log(JSON.stringify({...metrics,acceptRate:metrics.accepted/cases.length,softReviewRate:metrics.softReviews/cases.length,selfReferenceRate:metrics.selfReference/cases.length},null,2));
