import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../../index.js';
import {readChatInput} from './chat-input.mjs';
const realSetTimeout=setTimeout,realSetImmediate=setImmediate,realNow=Date.now;
const flush = async () => { for (let i = 0; i < 3; i++) { await new Promise(resolve=>realSetTimeout(resolve,0)); for(let turn=0;turn<12;turn++)await new Promise(realSetImmediate); } };
const whale = '大肥鱼（默认）', dragon = '大肥龙', claude = 'Claude小姐';
const reply = (messages = ['鲸鲸在呢。', '想聊什么？'], finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ messages }) };
  yield { type: 'finish', reason: { kind: finish } };
})();
const decisionReply = (participants = [], finish = 'stop') => (async function* () {
  yield { type:'text-delta',text:JSON.stringify({participants}) };
  yield { type:'finish',reason:{kind:finish} };
})();
const jsonReply=(value,finish='stop')=>(async function*(){yield{type:'text-delta',text:JSON.stringify(value)};yield{type:'finish',reason:{kind:finish}};})();
const planReply=(dialogue={addressed:[],voluntary:[]},context={work:'not-needed',sourceIds:[],request:'answer',evidence:''})=>jsonReply({context,dialogue});
const continuationReply=(responses=[])=>jsonReply({responses});
const directorReply=(context,next=null,finish='stop')=>jsonReply({context,next},finish);
const projectedOptions=(options,input)=>({...options,messages:[{...options.messages[0],content:[{type:'text',text:JSON.stringify(input)}]}]});
async function legacyValue(stream){let wire='',finish=null;const other=[];for await(const chunk of stream){if(chunk.type==='text-delta')wire+=chunk.text;else if(chunk.type==='finish')finish=chunk.reason.kind;else other.push(chunk);}
  let value;try{value=JSON.parse(wire);}catch{value={invalidLegacyResponse:wire};}return{value,finish,other};}
const legacyIds=(value,candidates,limit)=>value&&Object.keys(value).length===1&&Array.isArray(value.participants)&&value.participants.length<=limit
  &&new Set(value.participants).size===value.participants.length&&value.participants.every(id=>candidates.some(p=>p.id===id))?value.participants:null;
function domain(gate = Promise.resolve(), hooks = {}) {
  const tables = new Map();
  return { tables, async open() { await gate; return { table(name) {
    if (!tables.has(name)) tables.set(name, new Map()); const own = tables.get(name);
    return { get: (id) => { hooks.onGet?.(id); return structuredClone(own.get(id)); }, entries: () => own.entries(), delete: async (id) => {
      if (hooks.fail?.(id)) throw Error('disk'); return own.delete(id);
    },
      async put(id, value) { await hooks.beforePut?.(id, value); if (hooks.fail?.(id)) throw Error('disk'); own.set(id, structuredClone(value)); } };
  }, close: async () => {} }; } };
}
function fixture(t, { storage = domain(), script, directorScript, planScript, continuationScript, decisionScript, selectionScript, config = {}, runtime = {chatIntervalMs:0}, listModels, modelInfo, extraServices = [] } = {}) {
  const bus = new EventEmitter(), routes = [], disposers = [], calls = [], directors=[], plans=[], continuations=[],requests=[];
  // Compatibility arrays contain the actual shared requests, never synthetic
  // post-primary invocations or extra model calls.
  const judgements=continuations,selections=plans;let legacyDecisions=0;
  const services = new Map([['storageDomain', storage], ['webServer', { register(route) { routes.push(route); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { listModels: listModels ?? (async () => [{ id: 'm' }]), resolveModelInfo: modelInfo,
      stream(options) {
        requests.push(options);
        let input;try{input=readChatInput(options);}catch{/* Other expression requests retain the original fixture. */}
        if(input?.task==='chat-room-director'){
          directors.push(options);if(directorScript)return directorScript(options,directors.length);
          // The default is deliberately a small, deterministic substitute:
          // answer each currently selected recipient once after the latest user
          // event, then stop. Behavioral tests supply a native directorScript;
          // old plan/decision scripts are never given invented director inputs.
          const events=input.events??[],lastUser=events.findLastIndex(event=>event.author?.role==='user'),event=events[lastUser];
          const answered=new Set(events.slice(lastUser+1).filter(event=>event.author?.role==='assistant').map(event=>event.author.id));
          const choices=input.recipients?.length?input.recipients:input.members??[];
          const person=choices.find(person=>!answered.has(person.id)&&input.states?.some(state=>state.id===person.id&&state.normalReady&&state.normalRemaining>0));
          const ids=(input.sources??[]).map(source=>source.id).filter(id=>typeof id==='string');
          const context={work:ids.length?'required':'not-needed',sourceIds:ids,request:'answer',evidence:input.message?.slice(0,120)??''};
          const next=event&&person&&(input.recipients?.length||answered.size===0)?{id:person.id,kind:'normal',to:'user',
            evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'回应这条公开用户原话。'}:null;
          return directorReply(context,next);
        }
        if(input?.task==='chat-turn-plan'){
          plans.push(options);if(planScript)return planScript(options,plans.length);
          return(async function*(){
            const ids=(input.sources??[]).map(s=>s.id).filter(id=>typeof id==='string');
            let context={work:ids.length?'required':'not-needed',sourceIds:ids,request:'answer',evidence:input.message.slice(0,120)},dialogue={addressed:[],voluntary:[]},finish='stop';
            if(selectionScript){const selected=await legacyValue(selectionScript(projectedOptions(options,{...input,task:'chat-context-selection'}),plans.length));context=selected.value;finish=selected.finish;for(const chunk of selected.other)yield chunk;}
            const candidates=input.members.filter(person=>!input.recipients.some(p=>p.id===person.id));
            if(decisionScript&&candidates.length){
              const decided=await legacyValue(decisionScript(projectedOptions(options,{...input,candidates,exchange:[],limit:2,followup:false}),++legacyDecisions));
              const selected=legacyIds(decided.value,candidates,2);dialogue=selected?{addressed:[],voluntary:selected.map(id=>({id,to:'user'}))}:decided.value;
              finish=decided.finish==='stop'?finish:decided.finish;for(const chunk of decided.other)yield chunk;
            }
            yield*jsonReply({context,dialogue},finish);
          })();
        }
        if(input?.task==='chat-turn-continuation'){
          continuations.push(options);if(continuationScript)return continuationScript(options,continuations.length);
          if(!decisionScript)return continuationReply();
          return(async function*(){
            const candidates=input.members.filter(person=>(input.counts[person.id]??0)<3&&input.exchange.some(item=>item.speaker.id!==person.id));
            const decided=await legacyValue(decisionScript(projectedOptions(options,{...input,candidates,followup:true}),++legacyDecisions));
            const ids=legacyIds(decided.value,candidates,input.limit),responses=ids?.map(id=>{const target=input.exchange.findLast(item=>item.speaker.id!==id);return{id,to:target.speaker.id,evidence:target.messages.at(-1)};});
            for(const chunk of decided.other)yield chunk;yield*jsonReply(ids?{responses}:decided.value,decided.finish);
          })();
        }
        if(input?.task==='chat-context-selection'){
          selections.push(options);
          const sourceIds=(input.sources??[]).map(s=>s.id).filter(id=>typeof id==='string');
          return selectionScript?.(options,selections.length)??(async function*(){
            yield{type:'text-delta',text:JSON.stringify({work:sourceIds.length?'required':'not-needed',sourceIds,request:'answer',evidence:input.message.slice(0,120)})};
            yield{type:'finish',reason:{kind:'stop'}};
          })();
        }
        if(Array.isArray(input?.candidates)&&Number.isInteger(input.limit)){
          judgements.push(options);return decisionScript?.(options,judgements.length)??decisionReply();
        }
        calls.push(options); return script?.(options, calls.length) ?? reply();
      } }],...extraServices]);
  const ctx = { get: (key) => services.get(key), logger: { warn() {} },
    on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); },
    inject(keys, fn) { if (keys.every((key) => services.has(key))) fn(ctx); },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); } };
  apply(ctx, { provider: 'p', model: 'm', ...config },runtime); let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; for (const stop of [...disposers].reverse()) await stop(); } }; t.after(dispose);
  const request = async (path, body, auth = true) => {
    let status, value;
    await routes[0].handler({ url: '/persona-shell/' + path, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth ? 'owner' : '' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(text) { value = Buffer.isBuffer(text) ? text : JSON.parse(text); } }); return { status, value };
  };
  const state = async (id = whale) => (await request('chat?persona=' + encodeURIComponent(id))).value;
  const send = async (content, id = whale, requestId = 'client-one') => {
    const value = await state(id); return request('chat', { action: 'send', personaId: id,
      requestId, content, revision: value.room?.revision ?? 0, epoch: value.epoch });
  };
  return { calls,directors,plans,continuations,requests,judgements,selections, storage, request, state, send, dispose, ready: flush, bus,
    work(text = 'WORK_SESSION_SECRET') { bus.emit('session/event', { id: 'work', header: {}, append() { assert.fail('chat cannot write to working sessions'); } },
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text }] } }); } };
}
async function preference(f, content, personaId = whale) {
  assert.equal((await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'persona', personaId, content } })).status, 200);
}
async function newRoom(f,memberIds=[whale,dragon],name='讨论室',requestId='room-create'){
  const created=await f.request('chat-rooms',{action:'create',requestId,name,memberIds,targetPersonaId:memberIds[0],epoch:(await f.state()).epoch});
  assert.equal(created.status,200);const room=created.value.room;
  const context=(await f.request('chat-context',{action:'open',roomId:room.id,viewer:'viewer-'+requestId,sequence:1,sessionId:'work'})).value;
  return{roomId:room.id,contextKey:context.id+':'+context.revision};
}
async function roomSend(f,binding,personaId=whale,content='公开讨论',requestId='room-message'){
  const state=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
  return f.request('chat',{action:'send',...binding,personaId,content,requestId,revision:state.room.revision,epoch:state.epoch});
}
const roomState = async (f,binding) => (await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
async function settledRoom(f,binding) {
  const deadline=realNow()+3000;
  while(realNow()<deadline){await flush();const state=await roomState(f,binding);if(!state.running&&!state.queuedInputs?.some(batch=>['pending','sending'].includes(batch.status)))return state;}
  assert.fail('the finite chat round did not settle');
}

export { flush, whale, dragon, claude, reply, decisionReply, jsonReply, planReply, continuationReply, directorReply, domain, fixture, preference, newRoom, roomSend, roomState, settledRoom,readChatInput };
