// Actual React components and local avatar assets; no model, profile or work calls.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {parseArgs} from 'node:util';
import path from 'node:path';
const {values}=parseArgs({options:{deps:{type:'string'},'browser-deps':{type:'string'},executable:{type:'string'},output:{type:'string'}}});
const deps=createRequire(path.resolve(values.deps)),browserDeps=createRequire(path.resolve(values['browser-deps']??values.deps));
const {buildSync}=deps('esbuild'),{chromium}=browserDeps('playwright');
const portraits={'fish':'dafeiyu','little':'jingjing','dragon':'dafeilong','claude':'claude','cat':'gemini','blue-copy':'dafeiyu','orange-copy':'claude'};
const contacts=[['大肥鱼（默认）','大肥鱼','fish'],['鲸鲸（实验性）','小肥鱼','little'],['大肥龙','GPT','dragon'],
  ['Claude小姐','Claude小姐','claude'],['Gemini','猫猫','cat'],['custom-blue','自定义头像','blue-copy']].map(([id,name,key])=>({id,name,avatar:'/persona-shell/avatar/'+key}));
const source=readFileSync(new URL('../../client.js',import.meta.url),'utf8');
const entry=`
import * as React from ${JSON.stringify(deps.resolve('react'))};import * as ReactDOM from ${JSON.stringify(deps.resolve('react-dom'))};import {createRoot} from ${JSON.stringify(deps.resolve('react-dom/client'))};
let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(id==='react-dom/client')return{createRoot};throw Error(id)})}};
${source}
const h=React.createElement,api=plugin.__testing;let current=${JSON.stringify(contacts)};
const room={memberIds:current.map(person=>person.id),turns:[]};let setPeople,setTyping;
function Probe(){const[people,update]=React.useState(current),[typing,updateTyping]=React.useState(false);setPeople=update;setTyping=updateTyping;
 const tones=api.useChatBubbleColors(people,room);
 return h(React.Fragment,null,h('style',null,api.CHAT_CSS),h('section',{className:'dsh-persona-chat',style:{position:'relative',right:'auto',bottom:'auto',width:'100%',height:'auto',maxHeight:'none',padding:16}},
 h('strong',{style:{marginBottom:14}},'聊天室 · 人格气泡'),
 h('div',{className:'dsh-persona-chat-message','data-user':'true'},h('div',{className:'dsh-persona-chat-bubble'},'大家各自说一句吧。')),
 ...people.map(person=>h(api.ChatReplyBubbles,{key:person.id,turn:{id:person.id,attemptId:person.id,recipientId:person.id,speakerName:person.name,status:typing&&person.id==='大肥鱼（默认）'?'pending':'ready',assistant:['颜色跟着头像走，正文保持清楚。']},
 latest:false,running:typing&&person.id==='大肥鱼（默认）',showSpeaker:true,colorStyle:api.chatPalette.style(tones.get(person.id)),
 avatar:()=>h(api.PersonaAvatar,{src:person.avatar,id:person.id,name:person.name,className:'dsh-persona-chat-avatar'}),onQuote:()=>{}}))));}
createRoot(document.getElementById('app')).render(h(Probe));
window.changePortrait=()=>setPeople(old=>old.map(person=>person.id==='custom-blue'?{...person,avatar:'/persona-shell/avatar/orange-copy'}:person));
window.showTyping=()=>setTyping(true);window.clearTyping=()=>setTyping(false);
`;
const bundle=buildSync({stdin:{contents:entry,resolveDir:path.dirname(deps.resolve('react'))},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'}).outputFiles[0].text;
const requests=[],html=`<!doctype html><html><head><meta charset="utf-8"><style>
:root{--dsw-alias-label-primary:#203044;--dsw-alias-label-secondary:#607086;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f3f5f8;--dsw-alias-border-l1:#d2dce8}
:root[data-theme=dark]{--dsw-alias-label-primary:#e8eff8;--dsw-alias-label-secondary:#adbed2;--dsw-alias-bg-layer-1:#182433;--dsw-alias-bg-layer-2:#111b28;--dsw-alias-border-l1:#43566c}
body{margin:0;background:var(--dsw-alias-bg-layer-2);padding:16px;font:14px system-ui}#app{max-width:430px;margin:auto}button{font:inherit}
</style></head><body><main id="app"></main></body></html>`;
const server=createServer((req,res)=>{const pathname=new URL(req.url,'http://local').pathname;requests.push(pathname);
 if(pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
 const key=pathname.split('/').at(-1),file=Object.hasOwn(portraits,key)?portraits[key]:null;
 if(pathname.startsWith('/persona-shell/avatar/')&&file){res.writeHead(200,{'content-type':'image/webp'});res.end(readFileSync(new URL('../../assets/avatars/'+file+'.webp',import.meta.url)));return;}
 res.writeHead(404);res.end();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{})});
const page=await browser.newPage({viewport:{width:520,height:980}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
 await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:bundle});
 await page.waitForFunction(()=>document.querySelectorAll('[data-chat-persona]').length===6&&[...document.images].every(image=>image.complete&&image.naturalWidth));
 await page.waitForTimeout(80);
 const read=()=>page.evaluate(()=>{
  const rgb=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);};
  const lum=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,index)=>sum+v*[.2126,.7152,.0722][index],0);
  const contrast=(a,b)=>{const x=lum(rgb(a)),y=lum(rgb(b));return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  return[...document.querySelectorAll('[data-chat-persona]')].map(node=>{const bubble=node.querySelector('.dsh-persona-chat-bubble'),speaker=node.querySelector('.dsh-persona-chat-speaker'),body=node.querySelector('.dsh-persona-chat-body'),background=getComputedStyle(bubble).backgroundColor;
   return{id:node.dataset.chatPersona,tone:node.style.getPropertyValue('--chat-persona-color'),background,rgb:rgb(background),bodyContrast:body?contrast(getComputedStyle(body).color,background):null,speakerContrast:speaker?contrast(getComputedStyle(speaker).color,background):null};});
 });
 const light=await read();assert.equal(new Set(light.map(row=>row.background)).size,6);assert.ok(light.every(row=>row.bodyContrast>=4.5&&row.speakerContrast>=4.5));
 const userBackground=await page.locator('[data-user=true]>.dsh-persona-chat-bubble').evaluate(node=>getComputedStyle(node).backgroundColor);
 if(values.output){mkdirSync(values.output,{recursive:true});await page.locator('.dsh-persona-chat').screenshot({path:path.join(values.output,'light.png')});}
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');const dark=await read();assert.ok(dark.every(row=>row.bodyContrast>=4.5&&row.speakerContrast>=4.5));
 assert.equal(await page.locator('[data-user=true]>.dsh-persona-chat-bubble').evaluate(node=>getComputedStyle(node).backgroundColor),userBackground);
 if(values.output)await page.locator('.dsh-persona-chat').screenshot({path:path.join(values.output,'dark.png')});
 const before=light.find(row=>row.id==='custom-blue').tone;await page.evaluate(()=>window.changePortrait());
 await page.waitForFunction(()=>document.querySelector('img[src$="orange-copy"]')?.complete);await page.waitForTimeout(50);
 const changed=await read();assert.notEqual(changed.find(row=>row.id==='custom-blue').tone,before);
 const expected=changed.find(row=>row.id==='大肥鱼（默认）').background;await page.evaluate(()=>window.showTyping());
 await page.locator('.dsh-persona-chat-typing').waitFor();assert.equal((await read()).find(row=>row.id==='大肥鱼（默认）').background,expected);
 await page.setViewportSize({width:320,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 if(values.output)await page.locator('.dsh-persona-chat').screenshot({path:path.join(values.output,'mobile-typing.png')});
 assert.deepEqual(errors,[]);assert.ok(requests.every(url=>url==='/'||url==='/favicon.ico'||url==='/persona-shell/diagnostics'||url.startsWith('/persona-shell/avatar/')),JSON.stringify(requests));
 const result={result:'passed',light,dark,avatarRefresh:true,typingColor:true,userColorPreserved:true,pageErrors:errors,modelCalls:0};
 if(values.output)writeFileSync(path.join(values.output,'checks.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
