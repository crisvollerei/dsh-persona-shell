// Actual Client, Host and native modal surfaces; no provider calls or real profile.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fixture,newRoom,whale,dragon} from '../helpers/persona-chat-host.mjs';
import {makeReportSource} from '../../lib/report-visualization.js';
const {values}=parseArgs({options:{deps:{type:'string'},'browser-deps':{type:'string'},executable:{type:'string'},output:{type:'string'}}});
const deps=createRequire(path.resolve(values.deps)),bd=createRequire(path.resolve(values['browser-deps']??values.deps));
const {buildSync}=deps('esbuild'),{chromium}=bd('playwright'),cleanup=[],errors=[],checks=[];
const f=fixture({after:fn=>cleanup.push(fn)});await f.ready();await newRoom(f,[whale,dragon],'自由窗口','floating-room');
const report=makeReportSource({sessionId:'work',seq:10,text:Array.from({length:40},(_,i)=>'## 段落 '+i+'\n\n完整原文与条件保持不变。这里用于验证本地窗口调整和阅读位置。').join('\n\n')});
const source=readFileSync(new URL('../../client.js',import.meta.url),'utf8');
const entry=[
 'import * as React from '+JSON.stringify(deps.resolve('react'))+';',
 'import * as ReactDOM from '+JSON.stringify(deps.resolve('react-dom'))+';',
 'import {createRoot} from '+JSON.stringify(deps.resolve('react-dom/client'))+';',
 'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;if(id==="react-dom")return ReactDOM;if(id==="react-dom/client")return{createRoot};throw Error(id)})}};',
 source,
 'window.reader=plugin.__testing.reportReadingRuntime;',
 'function App(){const [panel,setPanel]=React.useState(null);return h(React.Fragment,null,h(plugin.__testing.PersonaChatLauncher,{sessionId:"work",conversation:{effectivePersonaId:"大肥鱼（默认）"}}),h("button",{onClick:()=>window.reader.open("work",10)},"打开阅读页"),h("button",{onClick:()=>setPanel("action")},"打开操作弹窗"),h("button",{onClick:()=>setPanel("comparison")},"打开对照"),panel==="action"?h(plugin.__testing.ActionDialog,{title:"操作窗口验证",onClose:()=>setPanel(null)},h("label",null,"草稿",h("textarea",{"aria-label":"操作草稿",defaultValue:"保持输入"})),h("p",null,"本地调整窗口，不执行工作。")):panel==="comparison"?h(plugin.__testing.ComparisonDialog,{original:"原始报告。\\n\\n条件与风险都在原文。",persona:"人格转述。",onClose:()=>setPanel(null)}):null);}',
 'createRoot(document.getElementById("app")).render(h(App));',
].join('\n');
const bundle=buildSync({stdin:{contents:entry,resolveDir:path.dirname(deps.resolve('react'))},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'}).outputFiles[0].text;
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{})});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#687788;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f7fa;--dsw-alias-border-l1:#dce3eb}body{margin:0;font:14px system-ui}</style></head><body><div id="app"></div></body></html>'});
   if(url.pathname==='/persona-shell/chat/live'||!url.pathname.startsWith('/persona-shell/'))return route.abort();
   if(url.pathname==='/persona-shell/report-visualization')return route.fulfill({contentType:'application/json',body:JSON.stringify({available:true,source:report,result:{schemaVersion:2,annotations:[]},cached:true})});
   const body=route.request().method()==='POST'?route.request().postDataJSON():undefined;
   try{const response=await f.request(url.pathname.slice('/persona-shell/'.length)+url.search,body);await route.fulfill({status:response.status,contentType:Buffer.isBuffer(response.value)?'image/webp':'application/json',body:Buffer.isBuffer(response.value)?response.value:JSON.stringify(response.value)});}catch{await route.abort();}
 });
 await page.goto('https://floating.test/');await page.addScriptTag({content:bundle});
 const motion=async()=>{await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dsh-chat-motion'));await page.evaluate(async()=>{await Promise.all([...document.querySelectorAll('.dsh-persona-chat,.dsh-report-reading,[data-floating-window]')].flatMap(node=>node.getAnimations().filter(a=>a.effect?.target===node&&a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});};
 const box=async node=>{const b=await node.boundingBox();return{x:b.x,y:b.y,width:b.width,height:b.height};};
 const equal=(a,b)=>{for(const key of ['x','y','width','height'])assert.ok(Math.abs(a[key]-b[key])<1.1,key+': '+JSON.stringify({a,b}));};
 const pointer=async(node,dx,dy)=>{const b=await node.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:6});await page.mouse.up();await motion();};
 const resize=async(node,dx,dy)=>pointer(node.locator('.dsh-floating-resize[data-edge=se]'),dx,dy);
 const capture=async name=>{if(values.output){mkdirSync(values.output,{recursive:true});await page.screenshot({path:path.join(values.output,name+'.png')});}};
 const inView=async(node,top=52)=>{const b=await box(node),v=page.viewportSize();assert.ok(b.x>=7&&b.y>=top-1&&b.x+b.width<=v.width-7&&b.y+b.height<=v.height-7,JSON.stringify({b,v}));};
 const launch=page.getByRole('button',{name:'聊天室',exact:true});await launch.click();
 const chat=page.getByRole('dialog',{name:'聊天室',exact:true}),input=chat.getByRole('textbox',{name:'发送给角色的消息'});await input.waitFor();await page.waitForFunction(()=>!document.querySelector('#dsh-persona-chat-input')?.disabled);await motion();
 await input.fill('拖动与最小化后保留这句。');
 const start=await box(chat);await pointer(chat.locator('.dsh-persona-room-avatar-display'),-400,-120);const moved=await box(chat);assert.ok(moved.x<start.x-300);checks.push('chat title drag');
 await resize(chat,100,-100);let savedChat=await box(chat);assert.ok(savedChat.width>moved.width+90&&savedChat.height<moved.height-90,JSON.stringify({moved,savedChat}));checks.push('chat corner resize');
 await resize(chat,-1000,-1000);await inView(chat);assert.equal((await box(chat)).width,280);
 assert.equal(await chat.evaluate(el=>{const b=el.getBoundingClientRect(),close=el.querySelector('[aria-label="关闭聊天室"]').getBoundingClientRect();return el.scrollWidth<=el.clientWidth&&close.right<=b.right&&close.bottom<=b.bottom;}),true);await capture('chat-small-desktop');
 const compact=await box(chat);await resize(chat,savedChat.width-compact.width,savedChat.height-compact.height);equal(await box(chat),savedChat);checks.push('manual narrow width adapts on a wide desktop');
 const grip=chat.getByRole('button',{name:'调整聊天室窗口大小',exact:true});await grip.focus();await grip.press('Control+ArrowRight');await grip.press('ArrowDown');savedChat=await box(chat);checks.push('keyboard move and resize');
 await chat.getByRole('button',{name:'放大',exact:true}).click();await motion();assert.ok((await box(chat)).width>savedChat.width);await chat.getByRole('button',{name:'还原',exact:true}).click();await motion();equal(await box(chat),savedChat);checks.push('maximize restores custom bounds');
 await chat.getByRole('button',{name:'放大',exact:true}).click();await motion();await pointer(chat.locator('.dsh-persona-room-avatar-display'),-50,80);
 const restoredDrag=await box(chat);assert.equal(await chat.getAttribute('data-wide'),'false');assert.ok(Math.abs(restoredDrag.width-savedChat.width)<1&&Math.abs(restoredDrag.height-savedChat.height)<1);
 await pointer(chat.locator('.dsh-persona-room-avatar-display'),savedChat.x-restoredDrag.x,savedChat.y-restoredDrag.y);equal(await box(chat),savedChat);checks.push('dragging enlarged window restores custom size');
 await chat.getByRole('button',{name:'最小化聊天室',exact:true}).click();await page.getByLabel('已最小化的聊天室',{exact:true}).waitFor();await motion();
 await page.getByRole('button',{name:'还原聊天室',exact:true}).click();await input.waitFor();await motion();equal(await box(chat),savedChat);assert.equal(await input.inputValue(),'拖动与最小化后保留这句。');checks.push('minimize restores position size and draft');
 const beforeButton=await box(chat);await chat.getByRole('button',{name:'管理聊天室成员',exact:true}).click();await motion();equal(await box(chat),beforeButton);await chat.getByRole('button',{name:'收起面板',exact:true}).click();checks.push('interactive header controls do not drag');
 for(const width of [390,280]){await page.setViewportSize({width,height:650});await motion();await inView(chat);assert.equal(await chat.evaluate(el=>el.scrollWidth<=el.clientWidth),true);}
 await page.setViewportSize({width:1280,height:900});await motion();equal(await box(chat),savedChat);checks.push('viewport clamp preserves desired bounds');
 const handleBox=await chat.locator('.dsh-persona-room-avatar-display').boundingBox();await page.mouse.move(handleBox.x+10,handleBox.y+10);await page.mouse.down();await page.mouse.move(handleBox.x-50,handleBox.y+30);await page.keyboard.press('Escape');await page.mouse.up();await motion();equal(await box(chat),savedChat);assert.equal(await chat.count(),1);checks.push('Escape cancels drag without closing');
 await chat.getByRole('button',{name:'关闭聊天室',exact:true}).click();await motion();await launch.click();await input.waitFor();await motion();equal(await box(chat),savedChat);checks.push('close and reopen retain chat bounds');
 await page.getByRole('button',{name:'打开阅读页',exact:true}).click();const reader=page.getByRole('dialog',{name:'报告阅读页',exact:true});await reader.waitFor();await page.waitForFunction(()=>document.querySelector('.rr-content')?.textContent.includes('段落 0'));await motion();
 await resize(reader,-210,-250);await pointer(reader.locator('.rr-head-title'),-200,50);const savedReader=await box(reader);await inView(reader);
 await resize(reader,-1000,-1000);assert.equal((await box(reader)).width,320);assert.equal(await reader.evaluate(el=>{const b=el.getBoundingClientRect(),close=el.querySelector('[aria-label="关闭报告阅读页"]').getBoundingClientRect();return el.scrollWidth<=el.clientWidth&&close.right<=b.right&&close.bottom<=b.bottom;}),true);await capture('reader-small-desktop');
 const smallReader=await box(reader);await resize(reader,savedReader.width-smallReader.width,savedReader.height-smallReader.height);equal(await box(reader),savedReader);checks.push('reader compact controls stay reachable');
 const content=reader.getByLabel('报告阅读内容',{exact:true});await content.evaluate(el=>el.scrollTop=160);const scroll=await content.evaluate(el=>el.scrollTop);
 await reader.getByRole('button',{name:'最小化报告阅读页',exact:true}).click();await motion();await page.getByRole('button',{name:'恢复报告阅读页',exact:true}).click();await motion();equal(await box(reader),savedReader);assert.equal(await content.evaluate(el=>el.scrollTop),scroll);checks.push('reader drag resize and minimize retain reading position');
 await launch.click();await input.waitFor();await motion();equal(await box(chat),savedChat);await page.getByRole('button',{name:'恢复报告阅读页',exact:true}).click();await motion();equal(await box(reader),savedReader);checks.push('chat and reader keep independent bounds');
 await page.setViewportSize({width:390,height:650});await motion();await inView(reader);await capture('reader-narrow');await page.setViewportSize({width:1280,height:900});await motion();equal(await box(reader),savedReader);
 await reader.getByText('阅读外观',{exact:true}).click();await reader.getByLabel('阅读主题',{exact:true}).selectOption('nord');equal(await box(reader),savedReader);checks.push('theme rerender preserves bounds');await capture('reader-custom');
 await reader.getByRole('button',{name:'关闭报告阅读页',exact:true}).click();await page.getByRole('button',{name:'打开阅读页',exact:true}).click();await reader.waitFor();await motion();equal(await box(reader),savedReader);await reader.getByRole('button',{name:'关闭报告阅读页',exact:true}).click();checks.push('reader close and reopen retain bounds');
 await page.getByLabel('已最小化的聊天室',{exact:true}).getByRole('button',{name:'关闭聊天室',exact:true}).click();await motion();
 await page.getByRole('button',{name:'打开操作弹窗',exact:true}).click();const action=page.getByRole('dialog',{name:'操作窗口验证',exact:true});await action.waitFor();await action.getByRole('textbox',{name:'操作草稿'}).fill('保留输入');
 await pointer(action.locator('h2'),-180,-90);await resize(action,100,80);const savedAction=await box(action);await inView(action,16);assert.equal(await action.getByRole('textbox').inputValue(),'保留输入');
 await action.getByRole('button',{name:'关闭操作窗口验证',exact:true}).click();await page.getByRole('button',{name:'打开操作弹窗',exact:true}).click();await action.waitFor();equal(await box(action),savedAction);checks.push('native action dialog drag resize and reopen');
 await action.getByRole('button',{name:'调整操作窗口验证窗口大小',exact:true}).focus();await page.keyboard.press('Home');assert.equal(await action.getAttribute('data-floating-custom'),null);await action.getByRole('button',{name:'关闭操作窗口验证',exact:true}).click();checks.push('keyboard reset restores default dialog');
 await page.getByRole('button',{name:'打开对照',exact:true}).click();const compare=page.getByRole('dialog',{name:'原文对照',exact:true});await compare.waitFor();await resize(compare,-500,-230);await pointer(compare.locator('h2'),-40,-20);await inView(compare,16);assert.equal(await compare.getByRole('tablist').isVisible(),true);await capture('comparison-custom');await compare.getByRole('button',{name:'关闭原文对照',exact:true}).click();checks.push('comparison resizes into narrow tabs');
 assert.deepEqual(await page.evaluate(()=>['user-select','cursor'].map(key=>document.body.style.getPropertyValue(key))),['','']);assert.deepEqual(errors,[]);assert.equal(f.requests.length,0);checks.push('no stuck drag styles or model calls');
 console.log(JSON.stringify({result:'passed',checks,pageErrors:errors,physicalProviderRequests:0}));
}catch(error){console.error(JSON.stringify({pageErrors:errors}));throw error;}finally{await browser.close();for(const fn of cleanup.reverse())await fn();}
