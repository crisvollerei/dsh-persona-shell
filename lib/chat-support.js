import {randomUUID} from 'node:crypto';
import {CHAT_SUPPORT_LIMITS as L,CHAT_SUPPORT_TEMPLATES as T,supportGoal,publicSupportUrl} from './chat-support-templates.js';
import {supportAbortable} from './chat-support-web.js';

const terminal=new Set(['completed','partial','failed','cancelled','interrupted']);
const key=v=>JSON.stringify([v.roomId,v.generation,v.scopeKey,v.referenceRevision,v.messageId]);
const counters=()=>({calls:0,searches:0,reads:0});
const boundedText=(v,n)=>typeof v==='string'?v.slice(0,n):'';
/** Bounded durable receipts. Pending jobs are interrupted on restart, never automatically resumed. */
export function createChatSupport({execute,save=async()=>{},changed=()=>{},now=Date.now,timeoutMs=L.timeoutMs}={}){
  const jobs=new Map(),active=new Map();let writes=Promise.resolve(),closed=false;
  function prune(protectedId){while(jobs.size>L.records||JSON.stringify([...jobs.values()]).length>L.storedChars){
    const old=[...jobs].find(([,j])=>terminal.has(j.status)&&j.id!==protectedId);if(!old)break;jobs.delete(old[0]);}}
  const notify=job=>changed(job.roomId);
  const persist=()=>{const data={version:1,jobs:[...jobs.values()].slice(-L.records).map(j=>structuredClone(j))};const task=writes.catch(()=>{}).then(()=>save(data));writes=task;return task;};
  function restore(value){
    if(value?.version!==1||!Array.isArray(value.jobs))return;
    for(const raw of value.jobs.slice(-L.records)){
      if(!raw||typeof raw.roomId!=='string'||typeof raw.messageId!=='string'||typeof raw.scopeKey!=='string'&&raw.scopeKey!==null
        ||!Number.isSafeInteger(raw.generation)||!Number.isSafeInteger(raw.referenceRevision)||!Object.hasOwn(T,raw.template)||typeof raw.id!=='string')continue;
      const job={id:raw.id.slice(0,100),roomId:raw.roomId.slice(0,200),messageId:raw.messageId.slice(0,200),scopeKey:raw.scopeKey===null?null:raw.scopeKey.slice(0,4000),generation:raw.generation,referenceRevision:raw.referenceRevision,template:raw.template,actorId:boundedText(raw.actorId,200),
        actorName:boundedText(raw.actorName,80),goal:boundedText(raw.goal,400),question:boundedText(raw.question,4000),context:'',
        text:boundedText(raw.text,L.outputChars),error:terminal.has(raw.status)?(['capacity','save-failed','timeout','budget','format','stale','cancelled','unavailable','thinking-unavailable'].includes(raw.error)?raw.error:undefined):'interrupted',status:terminal.has(raw.status)?raw.status:'interrupted',
        model:raw.model&&typeof raw.model==='object'?{provider:boundedText(raw.model.provider,180),model:boundedText(raw.model.model,180),thinking:boundedText(raw.model.thinking,128)}:undefined,
        stage:'done',countsIncomplete:!terminal.has(raw.status)||raw.countsIncomplete===true,startedAt:Number.isFinite(raw.startedAt)?raw.startedAt:now(),completedAt:Number.isFinite(raw.completedAt)?raw.completedAt:now(),
        counts:Object.fromEntries(Object.keys(counters()).map(k=>[k,Number.isSafeInteger(raw.counts?.[k])&&raw.counts[k]>=0&&raw.counts[k]<=L[k]?raw.counts[k]:0])),
        sources:(Array.isArray(raw.sources)?raw.sources:[]).filter(s=>s?.read===true&&publicSupportUrl(s.url)).slice(0,5)
          .map(s=>({id:boundedText(s.id,10),url:s.url,title:boundedText(s.title,200),excerpt:boundedText(s.excerpt,1600),read:true}))};
      jobs.set(key(job),job);
    }
    prune();
  }
  const find=scope=>jobs.get(key(scope));
  function view(scope){const values=[...jobs.values()].filter(j=>j.roomId===scope.roomId&&j.generation===scope.generation&&j.scopeKey===scope.scopeKey&&j.referenceRevision===scope.referenceRevision);
    return values.slice(-6).map(({question,context,text,...j})=>({...j,elapsedMs:Math.max(0,(j.completedAt??now())-j.startedAt),limits:{calls:T[j.template].calls,searches:j.template==='research'?L.searches:0,reads:j.template==='research'?L.reads:0,timeoutMs}}));}
  function cancel(roomId,id,reason='cancelled'){
    const own=[...active.values()].find(v=>v.job.roomId===roomId&&v.job.id===id);if(!own)return false;
    own.abort.abort(Error(reason));return true;
  }
  function cancelRoom(roomId,reason='cancelled',template){for(const value of active.values())if(value.job.roomId===roomId&&(!template||value.job.template===template))value.abort.abort(Error(reason));}
  async function start(input,{signal,valid=()=>true}={}){
    const previous=find(input);if(previous)return active.get(previous.id)?.done??previous;
    if(closed||!valid()||!Object.hasOwn(T,input.template)||!supportGoal(input.goal))throw Error('support-invalid');
    const job={...input,id:randomUUID(),goal:supportGoal(input.goal),question:boundedText(input.question,4000),context:boundedText(input.context,8000),
      status:'running',stage:'preparing',startedAt:now(),counts:counters(),sources:[],text:''};
    if(active.size>=L.global||[...active.values()].some(v=>v.job.roomId===input.roomId)){Object.assign(job,{status:'failed',stage:'done',error:'capacity',completedAt:now()});}
    let finish;const done=new Promise(resolve=>{finish=resolve;});
    const reservation={job,abort:new AbortController(),done};
    if(job.status==='running')active.set(job.id,reservation);
    jobs.set(key(job),job);
    prune(job.id);
    // Persist admission before spending anything; a recovered pending admission is never replayed.
    try{await persist();}catch{Object.assign(job,{status:'failed',stage:'done',error:'save-failed',completedAt:now()});active.delete(job.id);finish(job);notify(job);return job;}
    if(job.status!=='running'){finish(job);notify(job);return job;}
    const abort=reservation.abort,stop=()=>abort.abort(signal.reason??Error('cancelled'));
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const timeout=setTimeout(()=>abort.abort(Error('timeout')),timeoutMs);notify(job);
    const check=()=>{abort.signal.throwIfAborted();if(!valid())throw Error('support-stale');};
    const update=patch=>{check();Object.assign(job,patch);notify(job);};
    const admit=field=>{check();if(!Object.hasOwn(job.counts,field)||job.counts[field]>=(field==='calls'?T[job.template].calls:L[field]))throw Error('support-budget');
      job.counts[field]++;notify(job);};
    try{
      check();const result=await supportAbortable(execute({job,signal:abort.signal,update,admit}),abort.signal);check();
      Object.assign(job,{status:['completed','partial'].includes(result?.status)?result.status:'failed',text:boundedText(result?.text,L.outputChars),
        sources:(Array.isArray(result?.sources)?result.sources:[]).filter(s=>s.read===true&&publicSupportUrl(s.url)).slice(0,5).map(s=>({...s,excerpt:boundedText(s.excerpt,1600)}))});
    }catch(error){
      const reason=abort.signal.reason?.message??error.message;
      Object.assign(job,{status:abort.signal.aborted&&reason!=='timeout'?'cancelled':'failed',error:reason==='timeout'?'timeout':reason==='support-budget'?'budget':
        reason==='support-format'||reason==='support-evidence'?'format':reason==='expression-thinking-unavailable'?'thinking-unavailable':reason==='support-stale'?'stale':abort.signal.aborted?'cancelled':'unavailable'});
    }finally{
      clearTimeout(timeout);signal?.removeEventListener('abort',stop);active.delete(job.id);job.stage='done';job.completedAt=now();job.context='';notify(job);
      prune(job.id);try{await persist();}catch{job.error='save-failed';notify(job);}
      finish(job);
    }
    return job;
  }
  return {restore,find,view,start,cancel,cancelRoom,async dispose(){closed=true;const owned=[...active.values()];for(const v of owned)v.abort.abort(Error('disposed'));await Promise.allSettled(owned.map(v=>v.done));await writes.catch(()=>{});},drain:()=>writes.catch(()=>{})};
}
