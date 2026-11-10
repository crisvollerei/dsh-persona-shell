import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {apply} from '../index.js';
import {domain,flush} from './helpers/persona-chat-host.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function catalogHost(t,{listModels,listProviders,withLlm=true}={}){
  const disposers=[],bus=new EventEmitter(),routes=[],calls=[];
  const services=new Map([['storageDomain',domain()],['webServer',{register(route){routes.push(route);return()=>{};}}],
    ['connection',{requestRejection:({headers})=>headers.authorization==='owner'?undefined:403}]]);
  if(withLlm)services.set('llm',{listProviders:listProviders??(()=>[{id:'p',name:'Public provider',credential:'PROVIDER_PRIVATE'}]),
    listModels:async provider=>{calls.push(provider);return listModels?.(provider)??[{id:'m',name:'Public model',apiKey:'MODEL_PRIVATE'}];},
    stream(){assert.fail('catalog inspection must not generate');}});
  const ctx={get:key=>services.get(key),logger:{warn(){}},on(type,fn){bus.on(type,fn);return()=>bus.off(type,fn);},
    inject(keys,fn){if(keys.every(key=>services.has(key)))fn(ctx);},effect(fn){const dispose=fn();if(typeof dispose==='function')disposers.push(dispose);}};
  apply(ctx,{provider:'p',model:'m',timeoutMs:1000});
  let disposed=false;
  const dispose=async()=>{if(!disposed){disposed=true;for(const stop of [...disposers].reverse())await stop();}};t.after(dispose);
  const start=(url='models?provider=p',{method='GET',auth=true}={})=>{
    const res=new EventEmitter(),req={url:'/persona-shell/'+url,method,headers:{authorization:auth?'owner':''},async *[Symbol.asyncIterator](){yield '{}';}};
    const receipt={status:null,value:null,ends:0};res.destroyed=false;res.writableEnded=false;
    res.writeHead=status=>{receipt.status=status;};res.end=body=>{receipt.ends++;receipt.value=JSON.parse(body);res.writableEnded=true;};
    const task=routes[0].handler(req,res).then(()=>receipt);
    return{task,res,receipt,close(){res.destroyed=true;res.emit('close');}};
  };
  return{calls,start,dispose,ready:flush};
}

test('catalog lookup preserves public provider/model options and never exposes raw metadata',async t=>{
  const f=catalogHost(t);await f.ready();
  const result=await f.start().task;assert.equal(result.status,200);
  assert.deepEqual(result.value,{providers:[{provider:'p',name:'Public provider'}],models:[{id:'m',name:'Public model'}]});
  assert.deepEqual(f.calls,['p']);assert.doesNotMatch(JSON.stringify(result.value),/PRIVATE|credential|apiKey/);
});

test('listing providers alone and missing metadata services do not interrogate an adapter',async t=>{
  const f=catalogHost(t);await f.ready();const providers=await f.start('models').task;
  assert.equal(providers.status,200);assert.deepEqual(providers.value.models,[]);assert.equal(f.calls.length,0);
  const missing=catalogHost(t,{withLlm:false});await missing.ready();assert.deepEqual((await missing.start().task).value,{providers:[],models:[]});
});

test('catalog reads remain authenticated and reject mutation-shaped requests before adapter access',async t=>{
  const f=catalogHost(t);await f.ready();assert.equal((await f.start(undefined,{auth:false}).task).status,403);
  assert.equal((await f.start(undefined,{method:'POST'}).task).status,405);assert.equal(f.calls.length,0);
});

test('adapter failures are stable public categories rather than raw provider errors',async t=>{
  const f=catalogHost(t,{listModels:async()=>{throw Error('PRIVATE_CREDENTIAL_ENDPOINT_AND_STACK');}});await f.ready();
  const result=await f.start().task;assert.equal(result.status,200);assert.deepEqual(result.value.providers,[]);assert.deepEqual(result.value.models,[]);
  assert.equal(typeof result.value.error,'string');assert.doesNotMatch(JSON.stringify(result.value),/PRIVATE_CREDENTIAL_ENDPOINT_AND_STACK/);
});

test('stalled catalog lookup has a deadline even if the adapter does not observe cancellation',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});const gate=deferred();t.after(()=>gate.resolve([{id:'late'}]));
  const f=catalogHost(t,{listModels:()=>gate.promise});await f.ready();const request=f.start();let settled=false;
  void request.task.then(()=>{settled=true;});await flush();t.mock.timers.tick(8000);await flush();
  assert.equal(settled,true,'the public metadata request cannot wait indefinitely on its adapter');
  const result=await request.task;assert.equal(result.status,200);assert.deepEqual(result.value.models,[]);assert.equal(typeof result.value.error,'string');
  gate.resolve([{id:'late'}]);await flush();assert.equal(request.receipt.ends,1);assert.deepEqual(request.receipt.value.models,[]);
});

test('disconnect retires only its own catalog request and late completion cannot write a response',async t=>{
  const gate=deferred();t.after(()=>gate.resolve([{id:'late'}]));const f=catalogHost(t,{listModels:()=>gate.promise});await f.ready();
  const request=f.start();let settled=false;void request.task.then(()=>{settled=true;});await flush();request.close();await flush();
  assert.equal(settled,true,'closed clients do not leave a catalog handler waiting');assert.equal(request.receipt.ends,0);
  gate.resolve([{id:'late'}]);await request.task;await flush();assert.equal(request.receipt.ends,0);
});

test('unload settles an accepted catalog request before it completes and ignores a late adapter result',async t=>{
  const gate=deferred();t.after(()=>gate.resolve([{id:'late'}]));const f=catalogHost(t,{listModels:()=>gate.promise});await f.ready();
  const request=f.start();let settled=false;void request.task.then(()=>{settled=true;});await flush();await f.dispose();await flush();
  assert.equal(settled,true,'unload must retire its accepted catalog task');assert.equal((await request.task).status,503);
  assert.deepEqual(request.receipt.value.models,[]);gate.resolve([{id:'late'}]);await flush();assert.equal(request.receipt.ends,1);
});
