// Actual Client + Host; deterministic replies, isolated rooms, no external provider.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fixture,newRoom,roomState,roomSend,settledRoom,reply,jsonReply,whale,dragon,claude,readChatInput} from '../helpers/persona-chat-host.mjs';
const {values}=parseArgs({options:{deps:{type:'string'},'browser-deps':{type:'string'},executable:{type:'string'},output:{type:'string'}}});
const deps=createRequire(path.resolve(values.deps)),bd=createRequire(path.resolve(values['browser-deps']??values.deps));
const {buildSync}=deps('esbuild'),{chromium}=bd('playwright'),cleanup=[],errors=[],requests=[];
let staleNext=false;
const f=fixture({after:fn=>cleanup.push(fn)},{script:options=>options.system.startsWith('你为用户准备消息区')
 ?jsonReply({suggestions:['接着聊聊这个吧。','我也想听听大家的看法。']}):reply(['这条公开讨论已经接到了。'])});
await f.ready();const room=await newRoom(f,[dragon,claude],'广播快捷回复','suggestion-browser');
let s=await roomState(f,room);
await f.request('chat-rooms',{action:'update',roomId:room.roomId,epoch:s.epoch,configRevision:s.room.configRevision,targetPersonaIds:[]});
await roomSend(f,room,dragon,'公开聊聊长裙。');s=await settledRoom(f,room);
assert.equal(s.personaId,whale);assert.equal(s.room.memberIds.includes(whale),false);
const source=readFileSync(new URL('../../client.js',import.meta.url),'utf8');
const entry=[
 'import * as React from '+JSON.stringify(deps.resolve('react'))+';',
 'import * as ReactDOM from '+JSON.stringify(deps.resolve('react-dom'))+';',
 'import {createRoot} from '+JSON.stringify(deps.resolve('react-dom/client'))+';',
 'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;if(id==="react-dom")return ReactDOM;if(id==="react-dom/client")return{createRoot};throw Error(id)})}};',
 source,
 'createRoot(document.getElementById("app")).render(h(plugin.__testing.PersonaChatWindow,{roomId:'+JSON.stringify(room.roomId)+',initialState:'+JSON.stringify(s)+',sessionId:"work",onClose:()=>{}}));',
].join('\n');
const bundle=buildSync({stdin:{contents:entry,resolveDir:path.dirname(deps.resolve('react'))},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'}).outputFiles[0].text;
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px system-ui}</style></head><body><div id="app"></div></body></html>'});
   if(url.pathname==='/persona-shell/chat/live'||!url.pathname.startsWith('/persona-shell/'))return route.abort();
   const body=route.request().method()==='POST'?route.request().postDataJSON():undefined;
   if(url.pathname==='/persona-shell/chat/suggestions'){
     requests.push(body);
     if(staleNext){staleNext=false;const state=await roomState(f,room);await f.request('chat-rooms',{action:'update',roomId:room.roomId,epoch:state.epoch,configRevision:state.room.configRevision,targetPersonaIds:[dragon]});}
   }
   try{const response=await f.request(url.pathname.slice('/persona-shell/'.length)+url.search,body);await route.fulfill({status:response.status,contentType:Buffer.isBuffer(response.value)?'image/webp':'application/json',body:Buffer.isBuffer(response.value)?response.value:JSON.stringify(response.value)});}catch{await route.abort();}
 });
 await page.goto('https://suggestions.test/');await page.addScriptTag({content:bundle});
 const dialog=page.getByRole('dialog',{name:'聊天室',exact:true}),input=dialog.getByRole('textbox',{name:'发送给角色的消息'}),generate=dialog.getByRole('button',{name:'生成参考',exact:true});
 await input.waitFor();await page.waitForFunction(()=>!document.querySelector('#dsh-persona-chat-input')?.disabled);
 const before=f.calls.length,turns=(await roomState(f,room)).room.turns.length;
 await dialog.getByRole('checkbox',{name:'快捷回复参考',exact:true}).check();assert.equal(f.calls.length,before);
 await generate.click();const candidate=dialog.getByRole('button',{name:'接着聊聊这个吧。',exact:true});await candidate.waitFor();
 assert.equal(requests.at(-1).personaId,dragon);assert.equal(f.calls.length,before+1);
 assert.equal(readChatInput(f.calls.at(-1)).recipient,'大肥龙、Claude小姐');assert.equal(await input.inputValue(),'');
 assert.equal((await roomState(f,room)).room.turns.length,turns);
 for(const width of [1100,390,280]){await page.setViewportSize({width,height:850});assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);if(values.output){mkdirSync(values.output,{recursive:true});await dialog.screenshot({path:path.join(values.output,'broadcast-candidates-'+width+'.png')});}}
 await candidate.click();assert.equal(await input.inputValue(),'接着聊聊这个吧。');assert.equal(f.calls.length,before+1);assert.equal((await roomState(f,room)).room.turns.length,turns);
 await dialog.getByRole('checkbox',{name:'Claude小姐',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role=checkbox][aria-label="Claude小姐"]')?.getAttribute('aria-checked')==='true');
 await generate.click();await candidate.waitFor();assert.equal(requests.at(-1).personaId,claude);assert.equal(readChatInput(f.calls.at(-1)).recipient,'Claude小姐');
 await dialog.getByRole('checkbox',{name:'大肥龙',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role=checkbox][aria-label="大肥龙"]')?.getAttribute('aria-checked')==='true');
 await generate.click();await candidate.waitFor();assert.equal(readChatInput(f.calls.at(-1)).recipient,'Claude小姐、大肥龙');
 const count=f.calls.length,draft=await input.inputValue();staleNext=true;await generate.click();
 await dialog.getByText('讨论或参考来源已经更新，请重新生成参考。',{exact:true}).waitFor();
 assert.equal(f.calls.length,count);assert.equal(await input.inputValue(),draft);assert.equal(await candidate.count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',checks:['broadcast without a primary target','global fallback outside room does not block generation','empty draft can use public history','generation stays explicit','candidate only fills draft','single selected recipient','ordered multiple selected recipients','real context changes still reject before model call','failure preserves draft','desktop and 390/280 layout'],pageErrors:errors,physicalProviderRequests:0}));
}finally{await browser.close();for(const fn of cleanup.reverse())await fn();}
