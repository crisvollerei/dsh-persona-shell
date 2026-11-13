// Actual plugin Host + Client, real Chromium; controlled research and model outputs.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fixture,newRoom,roomState,reply,whale,dragon,readChatInput,flush} from '../helpers/persona-chat-host.mjs';
const {values}=parseArgs({options:{deps:{type:'string'},'browser-deps':{type:'string'},executable:{type:'string'},output:{type:'string'}}});
const deps=createRequire(path.resolve(values.deps)),bd=createRequire(path.resolve(values['browser-deps']??values.deps));
const {buildSync}=deps('esbuild'),{chromium}=bd('playwright'),cleanup=[],checks=[],errors=[],requests=[];
let releasePage,releaseReason,mode='research',actions=[],supportCalls=0,thinkingAvailable=true,failSupportSave=false,holdSupportSave=false,releaseSupportSave;
const text=value=>(async function*(){yield{type:'text-delta',text:value};yield{type:'finish',reason:{kind:'stop'}};})();
const f=fixture({after:fn=>cleanup.push(fn)},{config:{chatResearchEnabled:false,chatDeepReasoningEnabled:false},
 modelInfo:async(provider,id)=>({provider,id,...(thinkingAvailable?{reasoning:{efforts:[{id:'off',name:'关闭'},{id:'high',name:'思考'}]}}:{})}),
 extraServices:[['web',{search:async()=>({sources:[{url:'https://example.com/official',title:'公开官方资料'}]})}]],
 runtime:{chatIntervalMs:0,supportPageReader:async url=>{await new Promise(r=>releasePage=r);return{url,text:'真实读取的公开条件。'};}},
 directorScript:options=>{const input=readChatInput(options),latest=input.events.findLastIndex(e=>e.author.role==='user');if(input.events.slice(latest+1).some(e=>e.author.role==='assistant'))return text('WAIT');
  const choice=input.supportChoices.find(c=>c.id===whale&&c.template===mode);return text(`${choice.choiceId} N ${input.sceneCatalog.options[0].key} | 核对问题或推演取舍`);},
 script:options=>{const input=readChatInput(options);if(input.task==='chat-support'){supportCalls++;
   if(input.template==='reason')return(async function*(){await new Promise(r=>releaseReason=r);yield{type:'text-delta',text:'一次未联网的取舍。'};yield{type:'finish',reason:{kind:'stop'}};})();
   return text(JSON.stringify(actions.shift()));}
  return reply([input.supportReference?.error==='thinking-unavailable'?'这次没有启用思考，先按已有内容聊。':input.supportReference?.status==='cancelled'?'好，先按现有条件接着聊。':'查到的公开条件在这里；我会先按小范围试。']);}});
await f.ready();const room=await newRoom(f,[whale,dragon],'辅助讨论室','support-browser'),initial=await roomState(f,room);
const source=readFileSync(new URL('../../client.js',import.meta.url),'utf8');
const entry=`import * as React from ${JSON.stringify(deps.resolve('react'))};import * as ReactDOM from ${JSON.stringify(deps.resolve('react-dom'))};import {createRoot} from ${JSON.stringify(deps.resolve('react-dom/client'))};
const h=React.createElement;let plugin;window.__ModuleLoader__={load:d=>plugin=d.factory(id=>id==='react'?React:id==='react-dom'?ReactDOM:id==='react-dom/client'?{createRoot}:undefined)};
${source}
const root=createRoot(document.getElementById('app'));window.mountChat=state=>root.render(h(plugin.__testing.PersonaChatWindow,{roomId:state.room.id,initialState:state,sessionId:'work',onClose:()=>{}}));window.mountChat(${JSON.stringify(initial)});`;
const bundle=buildSync({stdin:{contents:entry,resolveDir:path.dirname(deps.resolve('react'))},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'}).outputFiles[0].text;
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const html='<html><head><meta charset="utf-8"><style>:root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#687788;--dsw-alias-brand-primary:#436cba;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f7fa;--dsw-alias-border-l1:#dce3eb}body{margin:0;font:14px/1.7 system-ui}</style></head><body><div id="app"></div></body></html>';
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!=='https://support.test')return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});if(url.pathname==='/persona-shell/chat/live')return route.abort();
  const body=req.method()==='POST'?JSON.parse(req.postData()):undefined;requests.push({path:url.pathname,method:req.method(),body});
  if(url.pathname==='/persona-shell/settings'&&req.method()==='POST'){
   if(failSupportSave){failSupportSave=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'settings-save-failed'})});}
   if(holdSupportSave){holdSupportSave=false;await new Promise(r=>releaseSupportSave=r);}
  }
  const result=await f.request(url.pathname.replace('/persona-shell/','')+url.search,body);
  await route.fulfill({status:result.status,contentType:'application/json',body:JSON.stringify(result.value)});});
 await page.goto('https://support.test');await page.addScriptTag({content:bundle});
 const dialog=page.getByRole('dialog',{name:'聊天室',exact:true}),input=dialog.getByRole('textbox',{name:'发送给角色的消息'});await input.waitFor();
 assert.equal(supportCalls,0);assert.equal(await page.getByLabel('聊天室辅助任务',{exact:true}).count(),0);checks.push('opening the room creates no auxiliary task or model call');
 const entry=dialog.getByRole('button',{name:'聊天室子代理',exact:true});await entry.waitFor();await entry.click();
 const menu=dialog.getByRole('region',{name:'聊天室子代理能力',exact:true});await menu.waitFor();assert.equal(await menu.getByRole('checkbox',{name:'允许按需调查资料',exact:true}).isChecked(),false);
 assert.equal(await menu.getByRole('checkbox',{name:'允许按需深入推演',exact:true}).isChecked(),false);assert.equal(f.directors.length,0);checks.push('always-visible subagent entry explains both capabilities with defaults off and no model dispatch');
 for(const [width,height] of [[1100,850],[390,520],[280,480]]){await page.setViewportSize({width,height});assert.equal(await menu.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await menu.getByRole('button',{name:'启用并填入推演请求',exact:true}).scrollIntoViewIfNeeded();assert.equal(await menu.getByRole('button',{name:'启用并填入推演请求',exact:true}).isVisible(),true);if(values.output){mkdirSync(values.output,{recursive:true});await page.screenshot({path:path.join(values.output,'entry-'+width+'.png'),fullPage:true,animations:'disabled'});}}
 checks.push('entry remains scrollable and usable at wide and narrow short window sizes');await page.setViewportSize({width:1100,height:850});
 await input.fill('保留这份草稿');failSupportSave=true;await menu.getByRole('button',{name:'启用并填入推演请求',exact:true}).click();await menu.getByText('辅助设置暂未保存，草稿保持原样；请重试。',{exact:true}).waitFor();assert.equal(await input.inputValue(),'保留这份草稿');assert.equal(await menu.getByRole('checkbox',{name:'允许按需深入推演',exact:true}).isChecked(),false);assert.equal(supportCalls,0);checks.push('failed enable preserves the draft and never claims the capability is enabled');
 await input.fill('帮我调查当前的公开条件。');await menu.getByRole('button',{name:'启用并填入调查请求',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#dsh-persona-chat-input')?.value.startsWith('请先调查公开资料'));
 assert.equal(await input.inputValue(),'请先调查公开资料，附上来源，再回答下面的问题：\n帮我调查当前的公开条件。');assert.equal(await menu.count(),0);assert.equal(f.directors.length,0);assert.equal(supportCalls,0);checks.push('enable-and-insert uses the existing setting and fills an editable unsent research request');
 actions=[{action:'search',query:'official condition'},{action:'read',sourceId:'w1'},{action:'finish',answer:'公开条件已列出，未知部分保留。',sources:['w1']}];
 await dialog.getByRole('button',{name:'发送',exact:true}).click();
 const status=dialog.getByLabel('聊天室辅助任务',{exact:true});await status.getByText(/正在阅读网页/).waitFor();
 assert.equal(await status.getByRole('button',{name:'停止调查资料',exact:true}).isVisible(),true);assert.equal(await dialog.locator('.dsh-persona-chat-message').filter({hasText:'正在调查'}).count(),0);
 await status.locator('summary').click();await status.getByText('模型请求 2 / 4 · 搜索 1 / 3 · 阅读 1 / 5',{exact:true}).waitFor();checks.push('real Host progress shows actor, stage and exact counts before any persona reply');
 const elapsed=await status.innerText();await page.waitForTimeout(1100);assert.notEqual(await status.innerText(),elapsed);checks.push('elapsed time advances while waiting without another model call');
 await input.fill('还没发送的补充');for(const width of [1100,390,280]){await page.setViewportSize({width,height:850});assert.equal(await status.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
  assert.equal(await status.getByRole('button',{name:'停止调查资料',exact:true}).isVisible(),true);assert.equal(await input.inputValue(),'还没发送的补充');}
 checks.push('1100/390/280 widths keep stop/details usable and preserve the draft');
 const bounds=await status.boundingBox(),compose=await dialog.locator('.dsh-persona-chat-compose').boundingBox();assert.ok(bounds.y+bounds.height<=compose.y+1);checks.push('task status occupies its own layout row above the composer without covering bubbles');
 if(values.output){mkdirSync(values.output,{recursive:true});await page.screenshot({path:path.join(values.output,'research-running-narrow.png'),fullPage:true,animations:'disabled'});}
 releasePage();await dialog.getByText('查到的公开条件在这里；我会先按小范围试。',{exact:true}).waitFor();await status.getByText(/调查资料 · 已完成/).waitFor();
 await status.getByRole('link',{name:'公开官方资料',exact:true}).waitFor();assert.equal(supportCalls,3);checks.push('finished research has actual source links and a single normal persona response');
 await page.setViewportSize({width:1100,height:850});mode='reason';await dialog.locator('[data-user=true]').first().hover();await dialog.getByRole('button',{name:'引用我的消息',exact:true}).first().click();await entry.click();holdSupportSave=true;await menu.getByRole('button',{name:'启用并填入推演请求',exact:true}).click();
 for(let i=0;i<100&&!releaseSupportSave;i++)await page.waitForTimeout(10);assert.ok(releaseSupportSave);await input.fill('后来补充的两个方案');releaseSupportSave();
 await page.waitForFunction(()=>document.querySelector('#dsh-persona-chat-input')?.value.startsWith('请使用深入推演'));
 assert.equal(await input.inputValue(),'请使用深入推演，分析下面的问题与关键条件：\n后来补充的两个方案');assert.equal(await dialog.getByLabel('正在引用的消息',{exact:true}).count(),1);checks.push('delayed enabling retains newer draft edits and the existing quote');
 await entry.click();await menu.getByRole('button',{name:'填入推演请求',exact:true}).click();assert.equal((await input.inputValue()).split('请使用深入推演').length-1,1);
 await entry.click();await menu.getByRole('button',{name:'填入调查请求',exact:true}).click();assert.equal(await input.inputValue(),'请先调查公开资料，附上来源，再回答下面的问题：\n后来补充的两个方案');
 await entry.click();await menu.getByRole('button',{name:'填入推演请求',exact:true}).click();assert.equal(await dialog.getByLabel('正在引用的消息',{exact:true}).count(),1);checks.push('switching request templates replaces only the inserted prefix and preserves the question and quote');
 await dialog.getByRole('button',{name:'发送',exact:true}).click();
 await status.getByText(/正在深入推演/).waitFor();if(!await status.locator('details').evaluate(e=>e.open))await status.locator('summary').click();await status.getByText(/思考：high/).waitFor();checks.push('reasoning explicitly enables a declared non-off effort even without a provider default');await status.getByRole('button',{name:'停止深入推演',exact:true}).click();
 await status.getByText(/深入推演 · 已停止/).waitFor();await dialog.getByText('好，先按现有条件接着聊。',{exact:true}).waitFor();releaseReason();await flush();
 assert.equal(supportCalls,4);assert.equal(await status.getByRole('link').count(),0);checks.push('stop cancels the pending reasoner and late output never becomes evidence or another reply');
 if(!await status.locator('details').evaluate(e=>e.open))await status.locator('summary').click();await status.getByText(/未联网/).waitFor();checks.push('reasoning is explicitly distinguished from sourced research');
 thinkingAvailable=false;await input.fill('再推演这个条件。');await dialog.getByRole('button',{name:'发送',exact:true}).click();
 await status.getByText('当前模型无法启用已声明的思考模式，请在设置中选择支持思考的推演模型。',{exact:true}).waitFor();await dialog.getByText('这次没有启用思考，先按已有内容聊。',{exact:true}).waitFor();assert.equal(supportCalls,4);checks.push('unknown thinking capability displays an actionable error without dispatching a thinking-off helper');
 const wrong=await f.request('chat',{action:'cancel-support',roomId:'other',personaId:whale,jobId:(await roomState(f,room)).supportTasks.at(-1).id,epoch:(await roomState(f,room)).epoch});assert.equal(wrong.status,404);checks.push('stop requests cannot address another room');
 await entry.click();await menu.getByRole('checkbox',{name:'允许按需深入推演',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="允许按需深入推演"]')?.checked===false);assert.equal((await f.request('settings')).value.settings.chatDeepReasoningEnabled,false);
 await menu.getByRole('checkbox',{name:'允许按需调查资料',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="允许按需调查资料"]')?.checked===false);assert.equal(supportCalls,4);checks.push('entry can disable both global capabilities without starting another model call');
 await input.fill('字'.repeat(4000));const posts=requests.filter(r=>r.path==='/persona-shell/settings'&&r.method==='POST').length;await menu.getByRole('button',{name:'启用并填入调查请求',exact:true}).click();await menu.getByText('当前草稿较长，请先缩短后再填入辅助请求。',{exact:true}).waitFor();assert.equal((await input.inputValue()).length,4000);assert.equal(requests.filter(r=>r.path==='/persona-shell/settings'&&r.method==='POST').length,posts);checks.push('an oversized draft is preserved without enabling the capability or silently clipping text');
 await page.keyboard.press('Escape');assert.equal(await entry.getAttribute('aria-expanded'),'false');assert.equal(await entry.evaluate(e=>document.activeElement===e),true);checks.push('Escape closes only the entry and returns focus to its toolbar button');
 await input.fill('清空之前的草稿');await entry.click();releaseSupportSave=undefined;holdSupportSave=true;await menu.getByRole('button',{name:'启用并填入调查请求',exact:true}).click();
 for(let i=0;i<100&&!releaseSupportSave;i++)await page.waitForTimeout(10);assert.ok(releaseSupportSave);
 await dialog.getByRole('button',{name:'清空',exact:true}).click();await dialog.getByRole('button',{name:'确认清空聊天',exact:true}).click();await menu.waitFor({state:'hidden'});await input.fill('清空之后的新草稿');releaseSupportSave();await flush();
 assert.equal(await input.inputValue(),'清空之后的新草稿');await entry.click();assert.equal(await menu.getByRole('checkbox',{name:'允许按需调查资料',exact:true}).isEnabled(),true);assert.equal(supportCalls,4);checks.push('clearing the room cancels a pending insertion and retires its busy state without altering the new draft');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks,pageErrors:errors,physicalProviderRequests:0,supportCalls}));
}finally{releaseSupportSave?.();releasePage?.();releaseReason?.();await browser.close();for(const fn of cleanup.reverse())await fn();}
