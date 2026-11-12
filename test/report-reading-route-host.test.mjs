import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';
import { domain } from './helpers/persona-chat-host.mjs';

// Actual Host handlers and the production expression policy; a controlled SDK
// prepareCall/stream face supplies structural output, never a native provider.
const flush = async () => { for (let i=0;i<24;i++) await new Promise(setImmediate); };
const deferred = () => { let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}; };
const validResult = source => ({schemaVersion:1,template:'overview',title:'报告',
  conclusion:{text:source.blocks[0].text,refs:[source.blocks[0].id]},
  sections:[{kind:'details',title:'原始说明',items:[{text:source.blocks[0].text,refs:[source.blocks[0].id]}]}]});
const resultStream = options => (async function*(){
  const source=JSON.parse(options.messages[0].content[0].text).source;
  yield{type:'text-delta',text:JSON.stringify(validResult(source))};
  yield{type:'usage',usage:{inputTokens:10,outputTokens:5}};
  yield{type:'finish',reason:{kind:'stop'}};
})();

function fixture(t,{storage=domain(),liveRoute,listModels=async()=>[{id:'provider-preferred'}],script=resultStream}={}){
  const bus=new EventEmitter(),routes=[],disposers=[],calls=[];
  const queries={stat:0,cache:0,catalog:0,prepared:0,global:0};
  const services=new Map([
    ['storageDomain',storage],['webServer',{register(route){routes.push(route);return()=>{};}}],
    ['connection',{requestRejection:({headers})=>headers.authorization==='owner'?undefined:403}],
    ['agentDefaultModel',{currentSelection(){queries.global++;return{provider:'global-provider',model:'global-default'};}}],
    ['agents',{get:id=>id==='route-work'&&liveRoute?.()?{model:{current:()=>liveRoute()}}:undefined}],
    ['sessionPersistence',{async stat(id,{signal}){queries.stat++;assert.equal(id,'route-work');assert.equal(signal.aborted,false);return{header:{id}};}}],
    ['sessionProjectionCache',{cachedSnapshot(header,keys){queries.cache++;assert.equal(header.id,'route-work');assert.deepEqual(keys,['modelSelection']);
      return{values:{modelSelection:{next:{provider:'persisted-provider',model:'persisted-selection'}}}};}}],
    ['llm',{
      async listModels(provider){queries.catalog++;return listModels(provider);},
      async prepareCall(controls,signal,configure){
        queries.prepared++;assert.equal(signal.aborted,false);
        const config=configure({...controls},{reasoning:{efforts:[{id:'off',name:'Off'}]}});
        return{config,stream(options){calls.push(options);return script(options);}};
      },
    }],
  ]);
  const ctx={get:key=>services.get(key),logger:{warn(){}},on(name,fn){bus.on(name,fn);return()=>bus.off(name,fn);},
    inject(keys,fn){if(keys.every(key=>services.has(key)))fn(ctx);},effect(fn){const stop=fn();if(typeof stop==='function')disposers.push(stop);}};
  apply(ctx,{provider:'',model:'',memory:false,timeoutMs:1000});
  let closing;
  const dispose=()=>closing??=(async()=>{for(const stop of [...disposers].reverse())await stop();})();t.after(dispose);
  const request=async(path,body)=>{let status,value;await routes[0].handler({url:'/persona-shell/'+path,method:body===undefined?'GET':'POST',
    headers:{authorization:'owner'},async *[Symbol.asyncIterator](){if(body!==undefined)yield JSON.stringify(body);}},
    {writeHead(code){status=code;},end(text){value=JSON.parse(text);}});return{status,value};};
  const ready=async()=>{await flush();assert.equal((await request('settings',{enabled:false})).status,200);await flush();};
  const report=()=>{
    const session={id:'route-work',header:{},append(){assert.fail('reading cannot append to the work log');}};
    for(const event of [
      {type:'turn/start',seq:9,data:{turn:1}},
      {type:'assistant/message',seq:10,data:{turn:1,message:{role:'assistant',source:{kind:'model',provider:'captured-provider',model:'captured-original'},
        content:[{type:'text',text:'仅完成本地入口核对，设备效果尚未验证。'}]}}},
      {type:'turn/end',seq:11,data:{turn:1,reason:{kind:'completed'}}},
    ])bus.emit('session/event',session,event);
  };
  const read=()=>request('report-visualization?session=route-work&seq=10');
  const generate=(source,requestId,extra={})=>request('report-visualization',{action:'generate',sessionId:source.sessionId,seq:source.seq,
    sourceHash:source.hash,requestId,...extra});
  const cancel=requestId=>request('report-visualization',{action:'cancel',sessionId:'route-work',seq:10,requestId});
  return{storage,calls,queries,ready,report,read,generate,cancel,request,dispose};
}

test('report capture, opening and cached reading stay lazy; a restarted Host chooses report capture before persisted/global routes',async t=>{
  const storage=domain(),first=fixture(t,{storage});await first.ready();first.report();
  assert.deepEqual(first.queries,{stat:0,cache:0,catalog:0,prepared:0,global:0});assert.equal(first.calls.length,0);
  const source=(await first.read()).value.source;
  assert.deepEqual(first.queries,{stat:0,cache:0,catalog:0,prepared:0,global:0});
  const generated=await first.generate(source,'initial-route-cache');assert.equal(generated.status,200);assert.ok(generated.value.result);
  assert.deepEqual(first.calls.map(c=>[c.provider,c.model]),[['captured-provider','captured-original']]);
  const afterGeneration={...first.queries};assert.equal(afterGeneration.stat,0);assert.equal(afterGeneration.cache,0);assert.equal(afterGeneration.global,0);
  assert.equal((await first.read()).value.cached,true);
  assert.equal((await first.generate(source,'cached-route-request')).status,200);
  assert.deepEqual(first.queries,afterGeneration);assert.equal(first.calls.length,1);
  await first.dispose();
  const restarted=fixture(t,{storage});await restarted.ready();
  const opened=await restarted.read();assert.equal(opened.value.cached,true);
  assert.deepEqual(restarted.queries,{stat:0,cache:0,catalog:0,prepared:0,global:0});assert.equal(restarted.calls.length,0);
  assert.equal((await restarted.generate(opened.value.source,'restart-reading-route',{regenerate:true})).status,200);
  assert.deepEqual(restarted.calls.map(c=>[c.provider,c.model]),[['captured-provider','captured-original']]);
  assert.equal(restarted.queries.stat,0);assert.equal(restarted.queries.cache,0);assert.equal(restarted.queries.global,0);
});

test('live selection wins over captured reading route and an exact reading override wins over live',async t=>{
  const live={provider:'live-provider',model:'live-next'},f=fixture(t,{liveRoute:()=>live});await f.ready();f.report();
  const source=(await f.read()).value.source;assert.equal(f.calls.length,0);assert.equal(f.queries.prepared,0);
  assert.equal((await f.generate(source,'live-reading-route')).status,200);
  assert.deepEqual(f.calls.map(c=>[c.provider,c.model]),[['live-provider','live-next']]);
  await f.request('settings',{visualizationProvider:'reading-provider',visualizationModel:'exact-reading-model'});
  assert.equal((await f.generate(source,'explicit-reading-route',{regenerate:true})).status,200);
  assert.deepEqual(f.calls.map(c=>[c.provider,c.model]),[['live-provider','live-next'],['reading-provider','exact-reading-model']]);
  assert.equal(f.queries.stat,0);assert.equal(f.queries.cache,0);assert.equal(f.queries.catalog,0);
});

test('an explicit reading provider whose model cannot be filled does not borrow capture, persisted or global routes',async t=>{
  for(const failure of ['empty','error'])await t.test(failure,async t=>{
    const f=fixture(t,{listModels:async provider=>{assert.equal(provider,'unavailable-reading');if(failure==='error')throw Error('controlled catalog failure');return[];}});
    await f.ready();f.report();const source=(await f.read()).value.source;
    await f.request('settings',{visualizationProvider:'unavailable-reading',visualizationModel:''});
    const response=await f.generate(source,'unavailable-reading-route');assert.equal(response.status,503);
    assert.equal(response.value.error,'report-model-unavailable');assert.equal(f.calls.length,0);assert.equal(f.queries.prepared,0);
    assert.equal(f.queries.catalog,1);assert.equal(f.queries.stat,0);assert.equal(f.queries.cache,0);
    assert.equal((await f.read()).value.cached,false);
  });
});

test('an exact reading model failure is a failed generation, not a request to retry another route',async t=>{
  const f=fixture(t,{script:()=> (async function*(){yield{type:'error',error:Error('controlled model failure')};})()});
  await f.ready();f.report();const source=(await f.read()).value.source;
  await f.request('settings',{visualizationProvider:'explicit-reading',visualizationModel:'failing-exact-model'});
  assert.equal((await f.generate(source,'explicit-reading-failure')).status,503);
  assert.deepEqual(f.calls.map(c=>[c.provider,c.model]),[['explicit-reading','failing-exact-model']]);
  assert.equal(f.queries.prepared,1);assert.equal(f.queries.catalog,0);assert.equal(f.queries.stat,0);assert.equal(f.queries.cache,0);
  assert.equal((await f.read()).value.cached,false);
});

test('cancelling reading while provider metadata waits prevents late SDK preparation and stream dispatch',{timeout:5000},async t=>{
  const listing=deferred();t.after(()=>listing.resolve([]));
  const f=fixture(t,{listModels:()=>listing.promise});await f.ready();f.report();const source=(await f.read()).value.source;
  await f.request('settings',{visualizationProvider:'pending-reading',visualizationModel:''});
  const pending=f.generate(source,'cancel-reading-metadata');await flush();assert.equal(f.queries.catalog,1);assert.equal(f.calls.length,0);
  assert.equal((await f.cancel('cancel-reading-metadata')).status,200);assert.equal((await pending).status,409);
  listing.resolve([{id:'late-model'}]);await flush();
  assert.equal(f.calls.length,0);assert.equal(f.queries.prepared,0);assert.equal(f.queries.stat,0);assert.equal(f.queries.cache,0);
  assert.equal((await f.read()).value.cached,false);
});
