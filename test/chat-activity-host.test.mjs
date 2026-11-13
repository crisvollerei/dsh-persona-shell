import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,domain,newRoom,roomSend,roomState,flush,reply,directorReply,readChatInput,whale,dragon} from './helpers/persona-chat-host.mjs';

async function until(check){
 const end=Date.now()+2500;
 while(Date.now()<end){if(await check())return;await flush();}
 assert.fail('controlled call did not reach its gate');
}

test('member activity follows actual director/actor calls, remains room-local, and clears on stop and restart',async t=>{
 const storage=domain();let releaseDirector,releaseActor;
 t.after(()=>{releaseDirector?.();releaseActor?.();});
 const f=fixture(t,{storage,directorScript:options=>(async function*(){
   const input=readChatInput(options);await new Promise(resolve=>releaseDirector=resolve);
   const event=input.events.find(e=>e.author.role==='user');
   yield*directorReply({work:'not-needed',sourceIds:[],request:'answer',evidence:input.message},
     {id:whale,kind:'normal',to:'user',evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'回应用户。'});
 })(),script:()=>(async function*(){await new Promise(resolve=>releaseActor=resolve);yield*reply(['收到。']);})()});
 await f.ready();const room=await newRoom(f,[whale,dragon]);const other=await newRoom(f,[dragon],'另一间','activity-other');
 assert.deepEqual((await roomState(f,room)).memberActivity,[]);
 await roomSend(f,room);await until(()=>!!releaseDirector);
 const listening=await roomState(f,room);
 assert.ok(listening.memberActivity.some(a=>a.id===whale&&a.state==='listening'));
 assert.equal(listening.memberActivity.some(a=>a.state==='typing'),false);assert.deepEqual((await roomState(f,other)).memberActivity,[]);
 releaseDirector();await until(()=>!!releaseActor);
 const speaking=await roomState(f,room);assert.deepEqual(speaking.memberActivity,[{id:whale,state:'typing'}]);
 const turn=speaking.room.turns.find(t=>t.status==='pending'&&t.phase!=='anchor');
 await f.request('chat',{action:'cancel',...room,personaId:whale,id:turn.id,attemptId:turn.attemptId,messageId:turn.messageId,roundId:speaking.roundId,epoch:speaking.epoch});
 assert.deepEqual((await roomState(f,room)).memberActivity,[]);
 releaseActor();await flush();assert.deepEqual((await roomState(f,room)).memberActivity,[]);
 await f.dispose();const g=fixture(t,{storage});await g.ready();assert.deepEqual((await roomState(g,room)).memberActivity,[]);assert.equal(g.requests.length,0);
});

test('model metadata preparation and cooldown waiting are not reported as listening or typing',async t=>{
 const releases=[];t.after(()=>releases.forEach(release=>release()));
 const f=fixture(t,{modelInfo:()=>new Promise(resolve=>releases.push(()=>resolve({}))),runtime:{chatIntervalMs:200}});
 await f.ready();const room=await newRoom(f,[whale]);await roomSend(f,room);
 await until(()=>releases.length===1);assert.deepEqual((await roomState(f,room)).memberActivity,[]);assert.equal(f.requests.length,0);
 releases[0]();await until(()=>releases.length===2);
 const preparing=await roomState(f,room);assert.ok(preparing.activeAttemptIds.length);assert.deepEqual(preparing.memberActivity,[]);assert.equal(f.calls.length,0);
 releases[1]();await until(()=>f.calls.length===1);await flush();
 const waiting=await roomState(f,room);assert.deepEqual(waiting.memberActivity,[]);assert.equal(f.directors.length,1);
});
