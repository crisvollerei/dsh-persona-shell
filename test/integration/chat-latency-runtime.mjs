import assert from 'node:assert/strict';
import {openLiveModel} from '../helpers/live-model.mjs';
import {parseArgs} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {fixture,domain,newRoom,roomSend,roomState,whale,dragon,readChatInput,reply,directorReply} from '../helpers/persona-chat-host.mjs';

const {values}=parseArgs({options:{live:{type:'boolean'},rounds:{type:'string'},deps:{type:'string'}}});
const rounds=Number(values.rounds??(values.live?10:1));
assert.ok(Number.isInteger(rounds)&&rounds>=1&&rounds<=100);
const live=values.live?await openLiveModel(values.deps):null,llm=live?.llm;
try {
  for(const path of ['direct','directed','director']){
    const samples=[];
    for(let i=0;i<rounds;i++){
      const storage=domain(),cleanup=[];
      const f=fixture({after:fn=>cleanup.push(fn)},{storage,config:{chatThinking:false,timeoutMs:60000,
        ...(llm?{provider:'deepseek',model:process.env.DSH_TEST_MODEL??'deepseek-flash'}:{})},extraServices:llm?[['llm',llm]]:[],
        script:()=> (async function*(){await sleep(500);yield*reply(['在呢。']);})(),
        directorScript:opts=>(async function*(){await sleep(300);const input=readChatInput(opts),e=input.events.findLast(x=>x.author.role==='user');
          yield*directorReply({work:'not-needed',sourceIds:[],request:'answer',evidence:input.message},input.events.some(x=>x.author.role==='assistant')?null:
            {id:whale,kind:'normal',to:'user',evidence:{eventId:e.id,index:0,text:e.messages[0]},goal:'回应问候'});})()});
      try{await f.ready();const b=await newRoom(f,path==='direct'?[whale]:[whale,dragon]);
        const detached=await f.request('chat-context',{action:'detach',...b,sessionId:'work',revision:Number(b.contextKey.split(':').at(-1))});
        assert.equal(detached.status,200);b.contextKey=detached.value.id+':'+detached.value.revision;
        if(path==='director'){
          const view=await roomState(f,b);
          assert.equal((await f.request('chat-rooms',{action:'update',roomId:b.roomId,configRevision:view.room.configRevision,epoch:view.epoch,targetPersonaIds:[]})).status,200);
        }
        assert.equal((await roomSend(f,b,whale,'午后好，今天想聊聊散步。')).status,200);
        const deadline=Date.now()+120000;
        while((await roomState(f,b)).running&&Date.now()<deadline)await sleep(25);
      }finally{await f.dispose();}
      const s=storage.tables.get('profile')?.get('modelUsage')?.chatTiming?.at(-1);
      if(s)samples.push(s);
      if(!values.live){assert.equal(s.path,path);assert.ok(s.done>=s.firstText);assert.equal(s.calls.actor,1);
        if(path==='direct'){assert.equal(s.directorDone,null);assert.ok(s.firstText>=480&&s.firstText<1200);}
        else if(path==='directed'){assert.ok(s.directorDone===null || s.directorDone>=s.firstText);assert.ok(s.firstText>=480&&s.firstText<1200);}
        else {assert.ok(s.calls.director>=1);assert.ok(s.directorDone<s.firstText);}}
    }
    const successful=samples.filter(s=>s.path===path&&s.done!==null);
    const times=successful.map(s=>s.firstText).filter(n=>n!==null).sort((a,b)=>a-b);
    const quantile=p=>times.length?times[Math.ceil(times.length*p)-1]+'ms':'—';
    const calls=successful.reduce((n,s)=>n+Object.values(s.calls).reduce((a,b)=>a+b,0),0);
    console.log(`path=${path} n=${successful.length} failed=${rounds-successful.length} firstText p50=${quantile(.5)} p90=${quantile(.9)} calls=${successful.length?(calls/successful.length).toFixed(1):'—'}`);
  }
} finally {await live?.close();}
