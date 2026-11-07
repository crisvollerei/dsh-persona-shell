import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../../index.js';
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
const whale = '大肥鱼（默认）', dragon = '大肥龙', claude = 'Claude小姐';
const reply = (messages = ['鲸鲸在呢。', '想聊什么？'], finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ messages }) };
  yield { type: 'finish', reason: { kind: finish } };
})();
const decisionReply = (participants = [], finish = 'stop') => (async function* () {
  yield { type:'text-delta',text:JSON.stringify({participants}) };
  yield { type:'finish',reason:{kind:finish} };
})();
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
function fixture(t, { storage = domain(), script, decisionScript, config = {}, listModels, modelInfo, extraServices = [] } = {}) {
  const bus = new EventEmitter(), routes = [], disposers = [], calls = [], judgements=[];
  const services = new Map([['storageDomain', storage], ['webServer', { register(route) { routes.push(route); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { listModels: listModels ?? (async () => [{ id: 'm' }]), resolveModelInfo: modelInfo,
      stream(options) {
        let input;try{input=JSON.parse(options.messages[0].content[0].text);}catch{/* Other expression requests retain the original fixture. */}
        if(Array.isArray(input?.candidates)&&Number.isInteger(input.limit)){
          judgements.push(options);return decisionScript?.(options,judgements.length)??decisionReply();
        }
        calls.push(options); return script?.(options, calls.length) ?? reply();
      } }],...extraServices]);
  const ctx = { get: (key) => services.get(key), logger: { warn() {} },
    on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); },
    inject(keys, fn) { if (keys.every((key) => services.has(key))) fn(ctx); },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); } };
  apply(ctx, { provider: 'p', model: 'm', ...config }); let disposed = false;
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
  return { calls,judgements, storage, request, state, send, dispose, ready: flush, bus,
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
  for(let i=0;i<20;i++){await flush();const state=await roomState(f,binding);if(!state.running)return state;}
  assert.fail('the finite chat round did not settle');
}

export { flush, whale, dragon, claude, reply, decisionReply, domain, fixture, preference, newRoom, roomSend, roomState, settledRoom };
