import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,domain,newRoom,roomState,settledRoom,reply,whale,dragon} from './helpers/persona-chat-host.mjs';
import {imageStore,upload,png} from './helpers/chat-images.mjs';
async function send(f,binding,requestId,content='请看看图片。',extra={}){
 const state=await roomState(f,binding);
 return f.request('chat',{...binding,personaId:whale,action:'send',requestId,content,revision:state.room.revision,epoch:state.epoch,...extra});
}
test('native images reach actual actors, not the director; references, thumbnails, restart and room clear stay isolated',async t=>{
 const storage=domain(),attachments=imageStore(),f=fixture(t,{storage,extraServices:[['attachments',attachments]],modelInfo:async()=>({inputModalities:['text','image']}),script:()=>reply(['我收到这张图片了。'])});
 await f.ready();const room=await newRoom(f,[whale,dragon]);
 const initial=await roomState(f,room);
 assert.equal((await f.request('chat-rooms',{action:'update',roomId:room.roomId,epoch:initial.epoch,revision:initial.room.revision,targetPersonaIds:[whale,dragon]})).status,200);
 assert.equal((await send(f,room,'photo','请看看图片。',{images:[upload]})).status,200);
 const state=await settledRoom(f,room),part=state.room.turns.find(t=>t.phase==='anchor').userParts[0];
 assert.equal(part.images.length,1);assert.equal(attachments.saved.length,1);
 assert.equal(f.calls.length,2);for(const call of f.calls)assert.deepEqual(call.messages.flatMap(m=>m.content).filter(b=>b.type==='image').map(b=>b.attachment),part.images);
 assert.ok(f.directors.length);assert.ok(f.directors.every(call=>call.messages.every(m=>m.content.every(b=>b.type==='text'))));
 assert.match(f.directors[0].messages[0].content[0].text,/userImages/);assert.doesNotMatch(JSON.stringify(state),new RegExp(upload.data));
 const url=(room,gen=0)=>'chat-image?room='+encodeURIComponent(room.roomId)+'&generation='+gen+'&id='+part.images[0].attachmentId;
 const image=await f.request(url(room));assert.equal(image.status,200);assert.deepEqual(image.value,png);
 assert.equal((await f.request(url(room),undefined,false)).status,403);
 const other=await newRoom(f,[whale],'另一个房间','another');assert.equal((await f.request(url(other))).status,404);
 assert.equal((await f.request(url(room,1))).status,404);
 const repeated=await send(f,room,'photo','请看看图片。',{images:[upload]});assert.equal(repeated.status,200);assert.equal(f.calls.length,2);
 assert.equal((await send(f,room,'photo','请看看图片。',{images:[{...upload,name:'different.png'}]})).status,409);
 await f.dispose();const g=fixture(t,{storage,extraServices:[['attachments',attachments]]});await g.ready();
 const restored=await roomState(g,room);assert.deepEqual(restored.room.turns[0].userParts[0].images,part.images);assert.deepEqual((await g.request(url(room))).value,png);assert.equal(g.calls.length,0);
 assert.equal((await g.request('chat',{action:'clear',...room,personaId:whale,epoch:restored.epoch,revision:restored.room.revision})).status,200);
 assert.equal((await g.request(url(room))).status,404);
});
test('known text-only capability rejects the upload without a model or message; explicit text-only send and missing service preserve usable text',async t=>{
 const attachments=imageStore(),f=fixture(t,{extraServices:[['attachments',attachments]],modelInfo:async()=>({inputModalities:['text']})});
 await f.ready();const room=await newRoom(f,[whale]);
 const result=await send(f,room,'no-vision','保留这句话',{images:[upload]});
 assert.equal(result.value.error,'chat-vision-unavailable');assert.equal(attachments.saved.length,0);assert.equal(f.calls.length,0);
 assert.equal((await roomState(f,room)).room.turns.length,0);
 assert.equal((await send(f,room,'text','保留这句话',{withoutImages:true})).status,200);await settledRoom(f,room);assert.equal(f.calls.length,1);
 const g=fixture(t);await g.ready();const noService=await newRoom(g,[whale]);
 assert.equal((await send(g,noService,'unavailable','仍然保留',{images:[upload]})).value.error,'chat-images-unavailable');assert.equal(g.calls.length,0);
 assert.equal((await send(g,noService,'plain','纯文字继续')).status,200);
});
test('unknown capability attempts once, records an image-specific failure, and can retry with a supported model',async t=>{
 const attachments=imageStore();let supported=false;
 const f=fixture(t,{extraServices:[['attachments',attachments]],modelInfo:async()=>supported?{inputModalities:['text','image']}:{},script:()=>supported?reply(['现在收到图片了。']):(async function*(){yield{type:'error',error:{code:'UNSUPPORTED_IMAGE_INPUT',message:'SECRET_PROVIDER_DETAIL'}};})()});
 await f.ready();const room=await newRoom(f,[whale,dragon]);
 assert.equal((await send(f,room,'unknown','这张呢',{images:[upload]})).status,200);
 const failed=await settledRoom(f,room),turn=failed.room.turns.find(t=>t.failure==='vision');
 assert.ok(turn);assert.equal(f.calls.length,1);assert.equal(failed.room.turns[0].userParts[0].images.length,1);assert.doesNotMatch(JSON.stringify(failed),/SECRET_PROVIDER_DETAIL/);
 supported=true;
 const retried=await f.request('chat',{action:'retry',...room,personaId:turn.recipientId,id:turn.id,attemptId:'try-again',epoch:failed.epoch,revision:failed.room.revision});
 assert.equal(retried.status,200);const done=await settledRoom(f,room);assert.ok(done.room.turns.some(t=>t.status==='ready'&&t.phase!=='anchor'));
});
test('changed capability at prepared dispatch refuses new images, but a subsequent text-only message is not forced to resend them',async t=>{
 const attachments=imageStore();let lookups=0;
 const f=fixture(t,{extraServices:[['attachments',attachments]],modelInfo:async()=>({inputModalities:++lookups===1?['image','text']:['text']})});
 await f.ready();const room=await newRoom(f,[whale]);
 assert.equal((await send(f,room,'changed','看看这个',{images:[upload]})).status,200);
 const failed=await settledRoom(f,room);assert.ok(failed.room.turns.some(t=>t.failure==='vision'));assert.equal(f.calls.length,0);
 assert.equal((await send(f,room,'without','接着谈文字',{withoutImages:true})).status,200);await settledRoom(f,room);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].messages.flatMap(m=>m.content).filter(b=>b.type==='image').length,0);
});

test('image-only input persists its native reference; upload and missing-byte failures do not dispatch invented image content',async t=>{
 const attachments=imageStore(),f=fixture(t,{extraServices:[['attachments',attachments]],modelInfo:async()=>({inputModalities:['text','image']})});
 await f.ready();const room=await newRoom(f,[whale]);
 const invalid=await send(f,room,'invalid','原输入',{images:[{...upload,data:'YWJj'}]});
 assert.equal(invalid.value.error,'chat-image-upload-failed');assert.equal((await roomState(f,room)).room.turns.length,0);assert.equal(f.calls.length,0);
 assert.equal((await send(f,room,'image-only','',{images:[upload]})).status,200);
 const ready=await settledRoom(f,room);assert.equal(ready.room.turns[0].user,'（发送了 1 张图片）');assert.equal(f.calls.length,1);
 attachments.files.clear();
 assert.equal((await send(f,room,'follow','图片里还有什么？')).status,200);
 const failed=await settledRoom(f,room);assert.ok(failed.room.turns.some(t=>t.messageId==='follow'&&t.failure==='image-unavailable'));assert.equal(f.calls.length,1);
 assert.equal(failed.room.turns[0].userParts[0].images.length,1);
});
