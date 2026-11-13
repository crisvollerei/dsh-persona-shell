// Actual plugin Client + Host; memory attachments and model replies are controlled.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fixture,newRoom,roomState,reply,whale} from '../helpers/persona-chat-host.mjs';
import {imageStore,png} from '../helpers/chat-images.mjs';
const {values}=parseArgs({options:{deps:{type:'string'},'browser-deps':{type:'string'},executable:{type:'string'},output:{type:'string'}}});
const deps=createRequire(path.resolve(values.deps)),bd=createRequire(path.resolve(values['browser-deps']??values.deps));
const {buildSync}=deps('esbuild'),{chromium}=bd('playwright');
const cleanup=[],t={after:f=>cleanup.push(f)},attachments=imageStore(),errors=[],requests=[];
let vision='supported';
const f=fixture(t,{extraServices:[['attachments',attachments]],modelInfo:async()=>vision==='unknown'?{}:{inputModalities:vision==='supported'?['text','image']:['text']},script:()=>reply(['这条消息已经接到了。'])});
await f.ready();const room=await newRoom(f,[whale],'图片讨论室','images-browser-room');
const initial=await roomState(f,room);
const source=readFileSync(new URL('../../client.js',import.meta.url),'utf8');
const entry=[
 'import * as React from '+JSON.stringify(deps.resolve('react'))+';',
 'import * as ReactDOM from '+JSON.stringify(deps.resolve('react-dom'))+';',
 'import {createRoot} from '+JSON.stringify(deps.resolve('react-dom/client'))+';',
 'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;if(id==="react-dom")return ReactDOM;if(id==="react-dom/client")return{createRoot};throw Error(id)})}};',
 source,
 'const root=createRoot(document.getElementById("app"));window.mountChat=state=>root.render(h(plugin.__testing.PersonaChatWindow,{key:state.room.id,roomId:state.room.id,initialState:state,sessionId:"work",onClose:()=>root.render(h("button",{onClick:()=>window.mountChat(state)},"重新打开"))}));window.mountChat('+JSON.stringify(initial)+');',
].join('\n');
const bundle=buildSync({stdin:{contents:entry,resolveDir:path.dirname(deps.resolve('react'))},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'}).outputFiles[0].text;
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 const html='<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#687788;--dsw-alias-brand-primary:#436cba;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f7fa;--dsw-alias-border-l1:#dce3eb}body{margin:0;font:14px/1.7 system-ui}</style></head><body><div id="app"></div></body></html>';
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
  if(url.pathname==='/persona-shell/chat/live')return route.abort();
  if(!url.pathname.startsWith('/persona-shell/'))return route.abort();
  const body=route.request().method()==='POST'?route.request().postDataJSON():undefined;
  requests.push({path:url.pathname,action:body?.action,images:body?.images?.length,withoutImages:body?.withoutImages});
  try{const response=await f.request(url.pathname.slice('/persona-shell/'.length)+url.search,body);
   await route.fulfill({status:response.status,contentType:Buffer.isBuffer(response.value)?'image/png':'application/json',body:Buffer.isBuffer(response.value)?response.value:JSON.stringify(response.value)});
  }catch{await route.abort();}
 });
 await page.goto('https://chat-images.test/');await page.addScriptTag({content:bundle});
 const dialog=page.getByRole('dialog',{name:'聊天室',exact:true}),input=dialog.getByRole('textbox',{name:'发送给角色的消息'}),picker=dialog.getByLabel('选择聊天图片',{exact:true});
 await dialog.getByRole('button',{name:'添加图片',exact:true}).waitFor();await input.waitFor({state:'visible'});
 await picker.setInputFiles({name:'oversize.png',mimeType:'image/png',buffer:Buffer.alloc(4*1024*1024+1)});
 await dialog.getByRole('status').filter({hasText:/3 张|4 MiB/}).waitFor();
 assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).count(),0);
 await picker.setInputFiles({name:'screenshot.png',mimeType:'image/png',buffer:png});
 await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').waitFor();
 await dialog.locator('.dsh-persona-chat-compose').evaluate((el,data)=>{const file=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'dropped.png',{type:'image/png'});const dt=new DataTransfer();dt.items.add(file);el.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));},png.toString('base64'));
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="待发送图片"] img').length===2);
 await input.fill('请看附图。');await dialog.getByRole('button',{name:'发送',exact:true}).click();
 await dialog.getByLabel('用户附图',{exact:true}).getByRole('img').first().waitFor();await dialog.getByText('这条消息已经接到了。',{exact:true}).waitFor();
 assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).count(),0);assert.ok(f.calls.some(c=>c.messages.some(m=>m.content.some(b=>b.type==='image'))));
 assert.equal(await dialog.getByLabel('用户附图',{exact:true}).getByRole('img').first().evaluate(el=>el.complete&&el.naturalWidth===1),true);
 vision='unsupported';
 await picker.setInputFiles({name:'second.png',mimeType:'image/png',buffer:png});await input.fill('这句可以单独发送。');
 await dialog.getByText(/当前模型只支持文字/).waitFor();const before=f.calls.length;
 await dialog.getByRole('button',{name:'发送',exact:true}).click();assert.equal(f.calls.length,before);assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').count(),1);
 await dialog.getByRole('button',{name:'仅发送文字',exact:true}).click();
 await dialog.locator('[data-user=true]').getByText('这句可以单独发送。',{exact:true}).waitFor();assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').count(),1);
 assert.ok(requests.some(r=>r.action==='send'&&r.withoutImages===true&&!r.images));
 await dialog.getByRole('button',{name:'移除图片 1',exact:true}).click();assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).count(),0);
 vision='supported';await input.evaluate((el,data)=>{const file=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'});const dt=new DataTransfer();dt.items.add(file);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},png.toString('base64'));
 await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').waitFor();
 await dialog.getByRole('button',{name:'移除图片 1',exact:true}).click();
 await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://chat-images.test'});
 await page.evaluate(async data=>{const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);},png.toString('base64'));
 await input.focus();await input.press('Control+V');await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').waitFor();
 assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').count(),1,'native clipboard paste attaches exactly one image');
 await dialog.getByRole('button',{name:'添加图片',exact:true}).evaluate((el,data)=>{
   const file=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'items-only.png',{type:'image/png'}),event=new Event('paste',{bubbles:true,cancelable:true});
   Object.defineProperty(event,'clipboardData',{value:{files:[],items:[{kind:'file',type:'image/png',getAsFile:()=>file}],getData:()=>''}});el.dispatchEvent(event);
 },png.toString('base64'));
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="待发送图片"] img').length===2);
 await dialog.locator('.dsh-persona-chat-top').evaluate((el,data)=>{const file=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'drop-no-type.PNG');const dt=new DataTransfer();dt.items.add(file);
   for(const type of ['dragenter','dragover'])el.dispatchEvent(new DragEvent(type,{dataTransfer:dt,bubbles:true,cancelable:true}));
   window.pendingImageDrop=dt;
 },png.toString('base64'));
 await dialog.getByText('松开以添加图片',{exact:true}).waitFor();
 await dialog.locator('.dsh-persona-chat-top').evaluate(el=>el.dispatchEvent(new DragEvent('drop',{dataTransfer:window.pendingImageDrop,bubbles:true,cancelable:true})));
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="待发送图片"] img').length===3);
 assert.equal(await dialog.getByText('松开以添加图片',{exact:true}).count(),0);
 await page.evaluate(()=>navigator.clipboard.writeText('普通粘贴仍然是文字'));await input.focus();await input.press('Control+V');
 assert.match(await input.inputValue(),/普通粘贴仍然是文字/);assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).getByRole('img').count(),3);
 for(const width of [1100,390,280]){
  await page.setViewportSize({width,height:850});assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if(values.output){mkdirSync(values.output,{recursive:true});await dialog.screenshot({path:path.join(values.output,'chat-images-'+width+'.png')});}
 }
 const other=await newRoom(f,[whale],'另一个房间','images-browser-other');
 await page.evaluate(state=>window.mountChat(state),await roomState(f,other));assert.equal(await dialog.getByLabel('待发送图片',{exact:true}).count(),0);assert.equal(await dialog.getByLabel('用户附图',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',checks:['invalid first selection shows error','file selection and thumbnail','native actor image blocks','host thumbnail bytes','unsupported model preserves image','explicit text-only fallback preserves selected image','image removal','clipboard paste','native clipboard Control+V','items-only clipboard on composer button','whole-window file drop and hover feedback','unknown file MIME with image extension','ordinary text paste retains text and pictures','drag and drop','desktop and 390/280 geometry','room isolation'],pageErrors:errors,requests}));
}finally{await browser.close();for(const fn of cleanup.reverse())await fn();}
