import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpressionLlm, reasoningOptions } from '../lib/expression-llm.js';

const unsupported = () => Object.assign(new Error('unsupported effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
const options = () => ({ provider: 'p', model: 'm', signal: new AbortController().signal,
  system: 'expression only', messages: [{ role: 'user', content: [{ type: 'text', text: 'source report' }] }] });
const answer = async function* () { yield { type: 'text-delta', text: 'rewritten' }; yield { type: 'finish', reason: { kind: 'stop' } }; };
const collect = async (llm, opts = options()) => { const out = []; for await (const chunk of llm.stream(opts)) out.push(chunk); return out; };
const model = (ids = ['off', 'low', 'high'], defaultEffort = 'high') => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })), defaultEffort } });

test('required thinking selects a real non-off effort when the provider default is absent or off',async()=>{
 for(const defaultEffort of [undefined,'off','high']){const info=model(['off','low','high'],defaultEffort);if(defaultEffort===undefined)delete info.reasoning.defaultEffort;const f=preparedHost(info);const policy=createExpressionLlm(f.llm,{thinking:true,thinkingRequired:true});await collect(policy);assert.equal(f.calls[0].reasoningEffort,defaultEffort==='high'?'high':'low');}
});
test('required thinking refuses unknown or off-only capabilities and never retries with thinking disabled',async()=>{
 for(const info of [{},model(['off'],'off')]){const f=preparedHost(info);await assert.rejects(collect(createExpressionLlm(f.llm,{thinking:true,thinkingRequired:true})),/expression-thinking-unavailable/);assert.equal(f.calls.length,0);}
 const f=preparedHost(model(),async function*(){yield{type:'finish',reason:{kind:'error',failure:unsupported()}};});
 await assert.rejects(collect(createExpressionLlm(f.llm,{thinking:true,thinkingRequired:true})),/expression-thinking-unavailable/);assert.equal(f.calls.length,1);
});
function preparedHost(info, script = answer) {
  const calls = [], prepares = [];
  const llm = { async prepareCall(config, signal, configure) {
    prepares.push({ config, signal });
    const selected = configure(Object.freeze({ ...config }), info);
    const effective = { ...selected };
    if (effective.reasoningEffort === undefined && info.reasoning?.defaultEffort !== undefined) effective.reasoningEffort = info.reasoning.defaultEffort;
    return { config: effective, stream(next) {
      const configOf=value=>Object.fromEntries(['provider','model','temperature','maxTokens','stop','reasoningEffort'].map(key=>[key,value[key]]));
      assert.deepEqual(configOf(next),configOf(effective),'prepared dispatch must preserve the exact SDK-resolved controls');
      calls.push(next); return script(next);
    } };
  }, stream() { assert.fail('prepared dispatch must retain its adapter binding'); } };
  return { llm, calls, prepares };
}

test('default expression calls explicitly choose off over a thinking provider default', async () => {
  const f = preparedHost(model(['low', 'off', 'high']));
  const original = Object.freeze({ ...options(), reasoningEffort: 'high', maxTokens: 512, tools: [{ name: 'read_stats' }] });
  const policy = createExpressionLlm(f.llm);
  await collect(policy, original);
  assert.equal(f.calls[0].reasoningEffort, 'off');
  assert.equal(f.calls[0].maxTokens, 512); assert.equal(f.calls[0].tools, original.tools);
  assert.equal(f.calls[0].messages, original.messages); assert.equal(original.reasoningEffort, 'high');
});
test('thinking-only routes use the lowest advertised effort, not an invented universal level', async () => {
  const f = preparedHost(model(['tiny', 'deep'], 'deep'));
  await collect(createExpressionLlm(f.llm));
  assert.equal(f.calls[0].reasoningEffort, 'tiny');
});
test('models with no selectable reasoning controls do not receive a bogus off parameter', async () => {
  const f = preparedHost({}); await collect(createExpressionLlm(f.llm));
  assert.equal(Object.hasOwn(f.calls[0], 'reasoningEffort'), false);
});
test('a supported custom effort wins; an unsupported custom effort returns to automatic selection', async () => {
  const f = preparedHost(model(['off', 'custom-fast', 'high']));
  await collect(createExpressionLlm(f.llm, { reasoningEffort: ' custom-fast ' }));
  assert.equal(f.calls[0].reasoningEffort, 'custom-fast');
  const decisions = [];
  await collect(createExpressionLlm(f.llm, { reasoningEffort: 'missing', onDecision: (d) => decisions.push(d) }));
  assert.equal(f.calls[1].reasoningEffort, 'off'); assert.equal(decisions[0].reason, 'unsupported-custom');
});
test('older hosts can select exact-model efforts without a prepared-call API', async () => {
  const calls = [], queried = [];
  const llm = { async resolveModelInfo(...args) { queried.push(args); return model(); },
    stream(next) { calls.push(next); return answer(); } };
  const opts = options(); await collect(createExpressionLlm(llm), opts);
  assert.equal(calls[0].reasoningEffort, 'off'); assert.deepEqual(queried[0], ['p', 'm', opts.signal]);
});
for (const format of ['throw', 'finish']) {
  test(`a typed ${format} parameter rejection retries only once without the rejected control`, async () => {
    const calls = [];
    const llm = { stream(next) { calls.push(next); if (calls.length === 1) {
      if (format === 'throw') throw unsupported();
      return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: unsupported() } }; })();
    } return answer(); } };
    const result = await collect(createExpressionLlm(llm));
    assert.equal(calls.length, 2); assert.equal(calls[0].reasoningEffort, 'off');
    assert.equal(Object.hasOwn(calls[1], 'reasoningEffort'), false); assert.equal(result[0].text, 'rewritten');
  });
}
test('failed compatibility fallback cannot loop', async () => {
  let calls = 0;
  const llm = { stream() { calls++; throw unsupported(); } };
  await assert.rejects(collect(createExpressionLlm(llm)), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  assert.equal(calls, 2);
});
for (const code of ['AUTH_FAILED', 'RATE_LIMITED', 'NETWORK_ERROR', 'BAD_REQUEST']) {
  test(`${code} cannot trigger an extra expression request`, async () => {
    let calls = 0;
    const llm = { stream() { calls++; throw Object.assign(new Error('thinking parameter mentioned by an unrelated error'), { code }); } };
    await assert.rejects(collect(createExpressionLlm(llm)), { code }); assert.equal(calls, 1);
  });
}
for (const type of ['text-delta', 'reasoning-delta', 'tool-call-delta']) {
  test(`an effort rejection after ${type} cannot replay already started output`, async () => {
    let calls = 0;
    const llm = { stream() { calls++; return (async function* () {
      yield { type, text: 'already emitted' };
      yield { type: 'finish', reason: { kind: 'error', failure: unsupported() } };
    })(); } };
    const result = await collect(createExpressionLlm(llm));
    assert.equal(calls, 1); assert.equal(result.at(-1).reason.kind, 'error');
  });
}
test('a compatibility choice persists across a tool continuation and has one logical retry budget', async () => {
  const calls = [];
  const llm = { stream(next) { calls.push(next); if (calls.length === 1) throw unsupported(); return answer(); } };
  const policy = createExpressionLlm(llm, { reasoningEffort: '' });
  await collect(policy); await collect(policy, { ...options(), messages: [{ role: 'tool', content: [] }] });
  assert.deepEqual(calls.map((o) => o.reasoningEffort), ['off', undefined, undefined]);
});
test('a new continuation cannot retry after earlier logical output was exposed', async () => {
  let calls = 0;
  const llm = { stream() { calls++; if (calls === 1) return answer(); throw unsupported(); } };
  const policy = createExpressionLlm(llm);
  await collect(policy);
  await assert.rejects(collect(policy), { code: 'UNSUPPORTED_REASONING_EFFORT' }); assert.equal(calls, 2);
});
test('abort drains locally during ignored asynchronous metadata and never dispatches its late result', async () => {
  let release, calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const llm = { prepareCall: () => pending };
  const abort = new AbortController();
  const task = collect(createExpressionLlm(llm), { ...options(), signal: abort.signal });
  abort.abort(new Error('disposed'));
  await assert.rejects(task, /disposed/);
  release({ config: {}, stream() { calls++; return answer(); } });
  await new Promise(setImmediate); assert.equal(calls, 0);
});
test('capability discovery failure does not silently dispatch with an unknown thinking default', async () => {
  let calls = 0;
  const llm = { resolveModelInfo: async () => { throw Object.assign(new Error('offline metadata'), { code: 'NETWORK_ERROR' }); },
    stream() { calls++; return answer(); } };
  await assert.rejects(collect(createExpressionLlm(llm)), { code: 'NETWORK_ERROR' }); assert.equal(calls, 0);
});

test('dispatch observation happens after capability preparation and never on metadata failure or abort', async () => {
  let release, dispatches = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const llm = { resolveModelInfo: () => gate, stream: answer };
  const abort = new AbortController();
  const task = collect(createExpressionLlm(llm, { onDispatch: () => dispatches++ }), { ...options(), signal: abort.signal });
  await Promise.resolve(); assert.equal(dispatches, 0); abort.abort(new Error('cancelled'));
  await assert.rejects(task, /cancelled/); release({}); await new Promise(setImmediate); assert.equal(dispatches, 0);
  const failed = createExpressionLlm({ resolveModelInfo: async () => { throw Error('metadata'); } }, { onDispatch: () => dispatches++ });
  await assert.rejects(collect(failed), /metadata/); assert.equal(dispatches, 0);
});

test('dispatch observations cover actual compatibility attempts and continuations without creating new logical policies', async () => {
  let calls = 0, observations = 0;
  const policy = createExpressionLlm({ stream() { calls++; if (calls === 1) throw unsupported(); return answer(); } },
    { onDispatch: () => observations++ });
  await collect(policy); await collect(policy, { ...options(), messages: [{ role: 'tool', content: [] }] });
  assert.equal(observations, 3); assert.equal(observations, calls);
});

test('chat thinking uses the published model default while disabling it does not inherit rewrite effort',async()=>{
  const enabled=preparedHost(model());await collect(createExpressionLlm(enabled.llm,{thinking:true}));assert.equal(enabled.calls[0].reasoningEffort,'high');
  const disabled=preparedHost(model());await collect(createExpressionLlm(disabled.llm,{thinking:false,reasoningEffort:'high'}));assert.equal(disabled.calls[0].reasoningEffort,'off');
});

test('public reasoning options retain only bounded declared controls, valid defaults and safe display fields',()=>{
  const original={reasoning:{efforts:[{id:'off',name:'关闭',secret:'PRIVATE'},{id:'standard',name:'标准'},
    {id:'standard',name:'DUPLICATE'},{id:'',name:'empty'},{id:' padded ',name:'bad'},
    {id:'x'.repeat(129),name:'long'},{id:'unsafe\ncontrol',name:'bad'},{id:'deep',name:'x'.repeat(161)}],
    defaultEffort:'standard',privateProvider:'PRIVATE'},apiKey:'PRIVATE'};
  const before=structuredClone(original),result=reasoningOptions(original);
  assert.deepEqual(result,{status:'available',efforts:[{id:'off',name:'关闭'},{id:'standard',name:'标准'},{id:'deep',name:'deep'}],defaultEffort:'standard'});
  assert.deepEqual(original,before);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|DUPLICATE/);
  result.efforts[0].name='changed';assert.equal(reasoningOptions(original).efforts[0].name,'关闭');
  const many={reasoning:{efforts:Array.from({length:40},(_,index)=>({id:'level-'+index,name:'强度'+index})),defaultEffort:'level-39'}};
  assert.equal(reasoningOptions(many).efforts.length,32);assert.equal(reasoningOptions(many).defaultEffort,null);
  assert.deepEqual(reasoningOptions({reasoning:{efforts:[{id:'off'}],defaultEffort:'off'}}),
    {status:'unavailable',efforts:[{id:'off',name:'off'}],defaultEffort:'off'});
  for(const value of [undefined,null,{}, {reasoning:{defaultEffort:'high'}}, {reasoning:{efforts:[null,{id:7}]}}])
    assert.deepEqual(reasoningOptions(value),{status:'unknown',efforts:[],defaultEffort:null});
});

function routeHost(path,info,script=answer){
  if(path==='prepared')return preparedHost(info,script);
  const calls=[],queried=[];
  return{calls,queried,llm:{resolveModelInfo:async(...args)=>{queried.push(args);return info;},stream(next){calls.push(next);return script(next);}}};
}

for(const path of ['prepared','resolve']){
  test(`${path} chat requests prefer a supported explicit non-off effort, then the published default rather than the first grade`,async()=>{
    const f=routeHost(path,model(['off','tiny','standard','deep'],'standard')),decisions=[];
    await collect(createExpressionLlm(f.llm,{thinking:true,onDecision:value=>decisions.push(value)}));
    assert.equal(f.calls.at(-1).reasoningEffort,'standard');assert.equal(decisions.at(-1).mode,'thinking');assert.equal(decisions.at(-1).reason,'chat-model-default');
    await collect(createExpressionLlm(f.llm,{thinking:true,reasoningEffort:' deep ',onDecision:value=>decisions.push(value)}));
    assert.equal(f.calls.at(-1).reasoningEffort,'deep');assert.equal(decisions.at(-1).reason,'explicit');
    for(const reasoningEffort of ['off',' off ','not-advertised']){
      await collect(createExpressionLlm(f.llm,{thinking:true,reasoningEffort,onDecision:value=>decisions.push(value)}));
      assert.equal(f.calls.at(-1).reasoningEffort,'standard');assert.equal(decisions.at(-1).mode,'thinking');
    }
    assert.equal(f.calls.length,5,'each logical selection dispatches exactly once');
  });

  test(`${path} chat uses the lowest declared non-off grade only when the published default is off`,async()=>{
    const f=routeHost(path,model(['off','tiny','deep'],'off')),decisions=[];
    await collect(createExpressionLlm(f.llm,{thinking:true,onDecision:value=>decisions.push(value)}));
    assert.equal(f.calls[0].reasoningEffort,'tiny');assert.equal(decisions[0].mode,'thinking');assert.equal(decisions[0].reason,'chat-default-off');
    const unavailable=routeHost(path,model(['off'],'off')),known=[];
    await collect(createExpressionLlm(unavailable.llm,{thinking:true,reasoningEffort:'deep',onDecision:value=>known.push(value)}));
    assert.equal(unavailable.calls[0].reasoningEffort,'off');assert.equal(known[0].reason,'thinking-unavailable');assert.notEqual(known[0].mode,'thinking');
  });

  test(`${path} missing or invalid thinking defaults remain provider-controlled and diagnostically unknown`,async()=>{
    for(const defaultEffort of [undefined,'not-advertised']){
      const info={reasoning:{efforts:[{id:'off'},{id:'low'},{id:'high'}],...(defaultEffort===undefined?{}:{defaultEffort})}},
        f=routeHost(path,info),decisions=[];
      await collect(createExpressionLlm(f.llm,{thinking:true,reasoningEffort:'off',onDecision:value=>decisions.push(value)}));
      const sdkDefault=path==='prepared'?defaultEffort:undefined;
      assert.equal(f.calls[0].reasoningEffort,sdkDefault,'the plugin does not guess a grade or override the SDK-resolved default');
      assert.equal(decisions[0].mode,'provider-default');assert.equal(decisions[0].effective,sdkDefault??null);assert.equal(decisions[0].reason,'thinking-default-unknown');
      await collect(createExpressionLlm(f.llm,{thinking:true,reasoningEffort:'high'}));
      assert.equal(f.calls[1].reasoningEffort,'high','a genuinely published explicit choice needs no default');
    }
  });

  test(`${path} absent thinking controls do not manufacture a level or promise that thinking is enabled`,async()=>{
    for(const info of [{},{reasoning:{defaultEffort:'high'}},{reasoning:{efforts:[]}}]){
      const f=routeHost(path,info),decisions=[];
      await collect(createExpressionLlm(f.llm,{thinking:true,reasoningEffort:'high',onDecision:value=>decisions.push(value)}));
      const sdkDefault=path==='prepared'?info.reasoning?.defaultEffort:undefined;
      assert.equal(f.calls[0].reasoningEffort,sdkDefault);assert.equal(decisions[0].mode,'provider-default');
      assert.equal(decisions[0].reason,'thinking-capability-unknown');assert.equal(decisions[0].effective,sdkDefault??null);
    }
  });

  test(`${path} report selection remains off by default, lowest when required, and preserves supported custom grades`,async()=>{
    const f=routeHost(path,model(['tiny','off','deep'],'deep'));
    await collect(createExpressionLlm(f.llm));assert.equal(f.calls[0].reasoningEffort,'off');
    await collect(createExpressionLlm(f.llm,{reasoningEffort:'deep'}));assert.equal(f.calls[1].reasoningEffort,'deep');
    await collect(createExpressionLlm(f.llm,{reasoningEffort:'not-advertised'}));assert.equal(f.calls[2].reasoningEffort,'off');
    const required=routeHost(path,model(['tiny','deep'],'deep'));
    await collect(createExpressionLlm(required.llm));assert.equal(required.calls[0].reasoningEffort,'tiny');
  });
}

test('legacy chat without exact metadata leaves the provider default unforced even for an unverified custom grade',async()=>{
  const calls=[],decisions=[],llm={stream(next){calls.push(next);return answer();}};
  for(const reasoningEffort of ['','high','off'])await collect(createExpressionLlm(llm,{thinking:true,reasoningEffort,onDecision:value=>decisions.push(value)}));
  assert.ok(calls.every(call=>!Object.hasOwn(call,'reasoningEffort')));assert.ok(decisions.every(value=>value.mode==='provider-default'&&value.reason==='thinking-capability-unknown'));
  await collect(createExpressionLlm(llm,{thinking:false,reasoningEffort:'high'}));assert.equal(calls.at(-1).reasoningEffort,'off');
  await collect(createExpressionLlm(llm,{reasoningEffort:'custom-grade'}));assert.equal(calls.at(-1).reasoningEffort,'custom-grade','legacy reports keep their established explicit-control probe');
});

for(const format of ['throw','finish'])test(`a prepared chat ${format} effort rejection retries once using the SDK default without changing prepared controls`,async()=>{
  let attempts=0;const f=preparedHost(model(['off','low','high'],'high'),()=>{
    attempts++;if(attempts===1){if(format==='throw')throw unsupported();return(async function*(){yield{type:'finish',reason:{kind:'error',failure:unsupported()}};})();}
    return answer();
  }),decisions=[],policy=createExpressionLlm(f.llm,{thinking:true,reasoningEffort:'low',onDecision:value=>decisions.push(value)});
  await collect(policy);assert.deepEqual(f.calls.map(call=>call.reasoningEffort),['low','high']);
  assert.equal(decisions[1].reason,'compatibility-retry');assert.equal(decisions[1].mode,'provider-default');assert.equal(decisions[1].effective,'high');
  await collect(policy,{...options(),messages:[{role:'tool',content:[]}]});assert.equal(f.calls.length,3);assert.equal(f.calls[2].reasoningEffort,'high');
});

for(const path of ['prepared','resolve'])test(`${path} chat thinking preparation can be cancelled without dispatch or a late retry`,async()=>{
  let release,calls=0;const pending=new Promise(resolve=>{release=resolve;}),abort=new AbortController();
  const llm=path==='prepared'?{prepareCall:()=>pending}:{resolveModelInfo:()=>pending,stream(){calls++;return answer();}};
  const task=collect(createExpressionLlm(llm,{thinking:true}),{...options(),signal:abort.signal});
  abort.abort(Error('chat-cancelled'));await assert.rejects(task,/chat-cancelled/);
  release(path==='prepared'?{config:{reasoningEffort:'high'},stream(){calls++;return answer();}}:model());
  await new Promise(setImmediate);assert.equal(calls,0);
});

test('cancelling at the chat policy decision still closes the final dispatch gate',async()=>{
  const f=preparedHost(model()),abort=new AbortController();
  const policy=createExpressionLlm(f.llm,{thinking:true,onDecision:()=>abort.abort(Error('source-changed'))});
  await assert.rejects(collect(policy,{...options(),signal:abort.signal}),/source-changed/);assert.equal(f.calls.length,0);
});
