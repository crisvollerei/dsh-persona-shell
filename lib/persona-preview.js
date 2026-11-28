import {mask,unmask} from './mask.js';
import {normalizePack} from './pack.js';
import {prepareReportRequest} from './report-request.js';
import {buildPreparedRewritePrompt,validateRewrite} from './prompt.js';
import {checkReportFidelity,strictSelfReference} from './report-fidelity.js';
import {assessRewrite} from './review.js';
import {buildChatPrompt} from './chat-prompt.js';
import {parseChatDecision} from './persona-chat.js';

export function reportTrial({original,pack,name,persona}) {
  const {masked,literals}=mask(original);
  const prepared=prepareReportRequest({pack,persona,masked,literalCount:literals.length});
  return {...buildPreparedRewritePrompt(prepared),check(wire){
    const verdict=validateRewrite({...prepared.validationOptions,original:masked,candidate:wire});
    if(!verdict.ok)return {text:original,fallback:verdict.reason,reasons:[]};
    const text=unmask(verdict.text,literals), fidelity=checkReportFidelity({...prepared.fidelityOptions,original,candidate:text,maskedOriginal:masked,maskedCandidate:verdict.text});
    if(!fidelity.ok)return {text:original,fallback:'source-'+fidelity.reasons[0],reasons:[]};
    const {reasons}=assessRewrite({original,candidate:text,maskedOriginal:masked,maskedCandidate:verdict.text});
    if(pack.narration?.selfReference==='none' && strictSelfReference(verdict.text,name,pack))reasons.push('self-reference');
    return {text,fallback:null,reasons};
  }};
}

export function personaTrial({mode,pack:raw,name='当前人格',persona}) {
  if(!['report','strict','chat'].includes(mode) || !raw || typeof raw.identity!=='string' || raw.identity.length>24000 || typeof name!=='string' || name.length>80)throw Error('invalid-preview');
  const pack=normalizePack(mode==='strict'?{...raw,narration:{...raw.narration,mode:'relay',selfReference:'none'}}:raw);
  if(mode==='chat'){
    const original='今天终于忙完了，陪我聊两句吧。',speaker={id:'preview',name};
    const prompt=buildChatPrompt({pack,persona,speaker,participants:[speaker],recipients:[speaker],history:[],message:original});
    return {...prompt,original,check(wire){const parsed=parseChatDecision(wire);
      if(!parsed)throw Error('preview-format');return {text:parsed.messages?.join('\n')||'（保持沉默）',reasons:[],fallback:null};}};
  }
  const original=mode==='strict'?'用户说“我只要 Linux 的结果”。我运行了 `npm test`，有 2 项失败，原因尚未确认。':'Windows 通过 7 项，Linux 通过 2 项。已更新 `config.yml`，还没有部署。';
  return {original,...reportTrial({original,pack,name,persona})};
}
