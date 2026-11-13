import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeChatImages,normalizeChatImages,imageInputStatus,selectChatImages,appendChatImages } from '../lib/chat-images.js';
import {createChatInputQueue} from '../lib/chat-input-queue.js';
import {createExpressionLlm} from '../lib/expression-llm.js';
const ref=(id='photo')=>({attachmentId:id,mediaType:'image/png',bytes:3,width:1,height:1,name:'photo.png'});
test('images are bounded uploads and inert native references, never remote URLs or caller-supplied attachment handles',()=>{
 assert.deepEqual(decodeChatImages([{data:'YWJj',mediaType:'image/png',name:'C:\\private\\photo.png'}])[0],{data:Buffer.from('abc'),mediaType:'image/png',name:'photo.png'});
 for(const images of [[{attachment:ref()}],[{data:'data:image/png;base64,YWJj',mediaType:'image/png'}],[{data:'https://example.invalid/x',mediaType:'image/png'}],
  [{data:'YWJj',mediaType:'image/svg+xml'}],Array.from({length:4},()=>({data:'YWJj',mediaType:'image/png'}))])
  assert.throws(()=>decodeChatImages(images),/invalid-chat-images/);
 assert.throws(()=>normalizeChatImages([{...ref(),data:'PRIVATE_BYTES'}]));
 assert.throws(()=>normalizeChatImages([{...ref(),attachmentId:'../another-room'}]));
 assert.equal(imageInputStatus({inputModalities:['text']}),'unsupported');assert.equal(imageInputStatus({inputModalities:['image','text']}),'supported');assert.equal(imageInputStatus({}),'unknown');
});
test('queued images survive restore, are part of idempotency, and cannot merge beyond one image batch',async()=>{
 const q=createChatInputQueue({now:()=>1000,intervalMs:0}),base={roomId:'r',recipients:[{id:'p',name:'P'}],memberIds:['p'],scopeKey:'s',imageGeneration:0};
 await q.enqueue({...base,requestId:'one',content:'看图',images:[ref()]});
 assert.equal((await q.enqueue({...base,requestId:'one',content:'看图',images:[ref()]})).created,false);
 await assert.rejects(q.enqueue({...base,requestId:'one',content:'看图',images:[ref('changed')]}),/chat-input-conflict/);
 await q.enqueue({...base,requestId:'two',content:'还有两张',images:[ref('a'),ref('b')]});
 await q.enqueue({...base,requestId:'three',content:'第四张另批',images:[ref('c')]});
 await q.enqueue({...base,requestId:'text',content:'仅文字',withoutImages:true});
 assert.equal(q.list('r').length,3);
 const restored=createChatInputQueue({now:()=>1000,intervalMs:0});await restored.restore(q.snapshot());
 assert.deepEqual(restored.list('r')[0].parts.flatMap(p=>p.images??[]),[ref(),ref('a'),ref('b')]);
 assert.equal(restored.list('r')[2].parts[0].withoutImages,true);
});
test('selection binds images to a real nearby user message and source; text-only choice suppresses retained images',()=>{
 const room={turns:[{id:'one',messageId:'one',scopeKey:'s',userParts:[{id:'one',text:'图',images:[ref()]}]},
  {id:'two',messageId:'two',scopeKey:'s',userParts:[{id:'two',text:'接着'}]}]};
 const found=selectChatImages(room,'two','s');assert.equal(found[0].messageId,'one');assert.equal(selectChatImages(room,'two','other').length,0);
 const messages=[{role:'user',content:[{type:'text',text:'current input'}]}],out=appendChatImages(messages,found);
 assert.equal(messages[0].content.length,1);assert.equal(out[0].content.filter(b=>b.type==='image').length,1);
 room.turns[1].userParts[0].withoutImages=true;assert.deepEqual(selectChatImages(room,'two','s'),[]);
 room.id='r';room.generation=2;room.turns[1].userParts[0].withoutImages=false;room.turns[1].quote={ref:{kind:'user',roomId:'r',generation:2,messageId:'one'}};
 assert.equal(selectChatImages(room,'two','s')[0].messageId,'one');
 room.turns.push({id:'bad',messageId:'one',scopeKey:'s',failure:'vision'});
 delete room.turns[1].quote;assert.deepEqual(selectChatImages(room,'two','s'),[],'failed image attempts do not silently attach themselves to later text');
});
test('the exact prepared adapter rejects new images on a text-only route; historical images get an explicit unavailable placeholder',async()=>{
 const calls=[],llm={async prepareCall(config,signal,configure){const final=configure(config,{inputModalities:['text']});return {config:final,stream:async function*(options){calls.push(options);yield{type:'finish',reason:{kind:'stop'}};}}}};
 const options={provider:'p',model:'m',messages:[{role:'user',content:[{type:'image',attachment:ref()}]}]};
 const run=async options=>{for await(const c of createExpressionLlm(llm).stream(options)){}};
 await assert.rejects(run(options),/chat-vision-unavailable/);assert.equal(calls.length,0);
 await run({...options,imageInputRequired:false});assert.equal(calls.length,1);assert.equal(calls[0].messages[0].content[0].type,'text');
 assert.match(calls[0].messages[0].content[0].text,/不支持视觉/);assert.equal(Object.hasOwn(calls[0],'imageInputRequired'),false);
});
