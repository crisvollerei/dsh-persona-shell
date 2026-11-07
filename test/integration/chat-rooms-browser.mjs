// Real React and the actual plugin Host, with a local deterministic LLM and storage.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { apply } from '../../index.js';
const { values } = parseArgs({ options: { deps: { type: 'string' }, 'browser-deps': { type: 'string' },
  executable: { type: 'string' }, output: { type: 'string' } } });
const deps = createRequire(path.resolve(values.deps));
const browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const tables = new Map(), calls = [], judgements = [], reactionSelections = new Map(), routes = [], disposers = [], gates = [], counts = new Map();
const bus = new EventEmitter(); let reads = 0;
const sourceReads=[],projectExpansions=[],routeReads=[];
const sourceHeaders={work:{id:'work',cwd:'D:/work/FocusProject',title:'当前任务'},other:{id:'other',cwd:'D:/work/FocusProject',title:'后台任务'},
  remote:{id:'remote',cwd:'D:/work/AnotherProject',title:'另一项目会话'},child:{id:'child',cwd:'D:/work/FocusProject',parentSession:'other'}};
const workspaceList=[{id:'project-a',path:'D:/work/FocusProject',get sessionIds(){projectExpansions.push('a');return['work','other'];}},
  {id:'project-b',path:'D:/work/AnotherProject',get sessionIds(){projectExpansions.push('b');return['remote'];}}];
let nextChatWrite, releaseChatWrite;
function pauseChatWrite() {
  return new Promise(resolve => { nextChatWrite=async()=>{ nextChatWrite=undefined; resolve(); await new Promise(done=>{releaseChatWrite=done;}); }; });
}
let finishOpening;
const storageOpening = new Promise(resolve => { finishOpening = resolve; });
let failChatSave = false;
let failAvatarSave = false, failUserProfileSave = false, lateAckRelease, lateAckBegin;
let streamRelease,finishStream;
const lateAckStarted = new Promise((r) => { lateAckBegin = r; });
const output = (messages, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ messages }) };
  yield { type: 'finish', reason: { kind: finish } };
})();
const candidateOutput = () => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ suggestions: ['先比较一下两种方案吧。', '实现起来会有多复杂？', '能举个具体例子吗？'] }) };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const services = new Map([
  ['workspaceRegistry',{list:()=>workspaceList}],['sessions',{get:id=>sourceHeaders[id]?{header:sourceHeaders[id]}:undefined}],
  ['sessionQuery',{observeSession:async id=>{sourceReads.push(id);return{events:[{type:'user/message',seq:1,data:{content:[{type:'text',text:id+'_GOAL'}]}},
    {type:'assistant/message',seq:2,data:{message:{content:[{type:'text',text:id+'_REPORT'}]}}}],[Symbol.dispose](){}};}}],
  ['storageDomain', { async open() { await storageOpening; return { table(name) {
    if (!tables.has(name)) tables.set(name, new Map()); const own = tables.get(name);
    return { get: (id) => structuredClone(own.get(id)), entries: () => own.entries(), delete: async (id) => own.delete(id),
      async put(id, value) {
        if (failChatSave && id === 'personaChats') { failChatSave=false; throw Error('disk'); }
        if (failUserProfileSave && id === 'chatUserProfile') { failUserProfileSave = false; throw Error('disk'); }
        if (failAvatarSave && id.startsWith('preset-avatar-')) { failAvatarSave = false; throw Error('disk'); }
        if (nextChatWrite && id === 'personaChats') await nextChatWrite();
        own.set(id, structuredClone(value));
      } };
  }, close: async () => {} }; } }],
  ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
  ['webServer', { register(route) { routes.push(route); return () => {}; } }],
  ['llm', { stream(options) {
    const user = JSON.parse(options.messages[0].content[0].text); const content = user.message;
    if(Array.isArray(user.candidates)){
      judgements.push(options);return(async function*(){yield{type:'text-delta',text:JSON.stringify({participants:reactionSelections.get(content)??[]})};
        yield{type:'finish',reason:{kind:'stop'}};})();
    }
    calls.push(options);
    if (user.instruction !== undefined) return user.instruction === '慢候选请求' ? (async function* () {
      await new Promise((r) => gates.push(r)); yield* candidateOutput();
    })() : candidateOutput();
    counts.set(content, (counts.get(content) ?? 0) + 1);
    if(content==='气泡顺序')return output(user.speaker.id==='大肥龙'?['龙接最后一句。']:['鱼先说第一句。','鱼接着说第二句。','鱼说完第三句。']);
    if(content==='轮询恢复')return(async function*(){await new Promise(r=>gates.push(r));yield*output(['中断后接上了。']);})();
    if(content==='多人回复重试'&&user.speaker?.id==='大肥龙'&&counts.get(content)<4)return output(['不能采用的截断回复'],'max-tokens');
    if(content==='多人流式')return(async function*(){const name=user.speaker.name,wire=JSON.stringify({messages:[name+' 流式开头',name+' 流式完成']}),split=wire.indexOf('开头')+2;
      yield{type:'text-delta',text:wire.slice(0,split)};await new Promise(r=>gates.push(r));yield{type:'text-delta',text:wire.slice(split)};yield{type:'finish',reason:{kind:'stop'}};})();
    if(content==='流式验证')return(async function*(){yield{type:'thinking-delta',text:'SECRET_THINKING'};
      yield{type:'text-delta',text:'{"messages":["第一段正在'};await new Promise(r=>{streamRelease=r;});
      yield{type:'text-delta',text:'输入。","第二段接着说。","第三段收尾。"]}'};await new Promise(r=>{finishStream=r;});yield{type:'finish',reason:{kind:'stop'}};})();
    if (content === '等一下再回') return (async function* () {
      await new Promise((r) => gates.push(r)); yield* output(['OLD_LATE_REPLY']);
    })();
    if (content === '模拟失败' && counts.get(content) <= 2) return output(['这段不能提交'], 'max-tokens');
    if (content === '格式兼容') return (async function* () {
      yield { type: 'text-delta', text: counts.get(content) === 1 ? '{"messages":["坏 JSON"'
        : '```json\n{"messages":["已经按新来源重试。","这次格式正常。"]}\n```' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
    if (content === '普通文本回复') return (async function* () {
      yield { type: 'thinking-delta', text: 'NEVER_SHOW_REASONING' };
      yield { type: 'text-delta', text: '普通短句也能收到。\n\n第二个气泡。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
    if (content === '我想做个帮助整理项目想法的小工具。') return output(['可以呀，先聊清楚它最想帮你省哪一步。', '你更在意把需求说清楚，还是把零散想法整理起来？']);
    if(content==='旁听成员参与一下'&&user.speaker?.id==='Claude小姐')return output(['我补一个不同角度。','先保留原文依据，再决定怎么整理。']);
    if(user.speaker?.id==='大肥龙')return output(['前面的想法我看到了。','接下来想从哪儿聊起？']);
    return output(['鲸鲸在呢。', '先把小鱼干放下……你说，鲸鲸听着。']);
  } }],
]);
apply({ get: (id) => services.get(id), logger: { warn() {} },
  on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); },
  inject(keys, fn) { if (keys.every((id) => services.has(id))) fn({ get: (id) => services.get(id) }); },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
}, { provider: 'local', model: 'chat-model' });
for (let i = 0; i < 15; i++) await new Promise(setImmediate);
const streamServer=createServer((req,res)=>{req.headers.authorization='owner';void routes[0].handler(req,res).catch(()=>{if(!res.writableEnded)res.end();});});
await new Promise(r=>streamServer.listen(0,'127.0.0.1',r));const testOrigin='http://127.0.0.1:'+streamServer.address().port;
const owner = async (pathname, body) => {
  let status, value;
  await routes[0].handler({ url: '/persona-shell/' + pathname, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'owner' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
  { writeHead(code) { status = code; }, end(bytes) { value = Buffer.isBuffer(bytes) ? bytes : JSON.parse(bytes); } });
  assert.equal(status, 200); return value;
};
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import * as ReactDOM from ' + JSON.stringify(deps.resolve('react-dom')) + ';',
  'import { createRoot } from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;if(id==="react-dom")return ReactDOM;if(id==="react-dom/client")return{createRoot};throw Error(id)})}};',
  source,
  'window.accountReads=0;window.accountAvatar=null;window.accountSignedIn=true;plugin.__testing.accountAvatarSource.bind({account:{getState:async()=>({ok:true,value:{status:window.accountSignedIn?"credential-stored":"signed-out"}}),getProfile:async()=>{window.accountReads++;return{ok:true,value:{status:"ready",value:{avatarUrl:window.accountAvatar}}}}}},()=>({version:"test",locale:"zh-CN",timezoneOffsetSeconds:0}));window.refreshAccountAvatar=()=>plugin.__testing.accountAvatarSource.refresh();',
  'function Demo(){const[settings,setSettings]=React.useState(false);const[report,setReport]=React.useState("大肥鱼（默认）");const[workSession,setWorkSession]=React.useState("work");window.switchWorkSession=setWorkSession;window.setReportPersona=setReport;return h(React.Fragment,null,h("header",{key:workSession},h(plugin.__testing.PersonaChatLauncher,{sessionId:workSession,conversation:{effectivePersonaId:report}})),',
  'h("main",null,h("h1",null,"原始工作会话"),h("textarea",{"aria-label":"工作会话输入",defaultValue:"WORK_ONLY_DO_NOT_READ"}),',
  'h("p",null,"这部分始终由原始工作界面显示。")),h("aside",null,h(plugin.__testing.PersonaChatLauncher),h("button",{onClick:()=>setSettings(!settings)},"插件设置")),settings?h(plugin.__testing.SettingsSection):null)}',
  'createRoot(document.getElementById("app")).render(h(Demo));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.setDefaultTimeout(7000);
  const errors = [], external = [],liveConnections=[];let legacyChatHost=false,failStreams=0,failSnapshot=false;
  page.on('pageerror', (e) => errors.push(e.message));
  const html = '<html><head><meta charset="utf-8"><style>'
    + ':root{--dsw-alias-label-primary:#203044;--dsw-alias-label-secondary:#607086;--dsw-alias-brand-primary:#3d6dcc;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f3f5f8;--dsw-alias-border-l1:#d2dce8}'
    + ':root[data-theme="dark"]{--dsw-alias-label-primary:#e8eff8;--dsw-alias-label-secondary:#adbed2;--dsw-alias-bg-layer-1:#182433;--dsw-alias-bg-layer-2:#111b28;--dsw-alias-border-l1:#43566c}'
    + 'body{margin:0;padding:24px;font:14px/1.7 system-ui;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}#app>header,#app>aside{display:flex;gap:12px;margin-bottom:24px}#app>header{transform:translateZ(0);overflow:hidden;height:40px}#app>main{max-width:500px}#app>main textarea{width:90%;height:90px;background:var(--dsw-alias-bg-layer-2);color:inherit}#app>aside{margin-top:24px}'
    + '</style></head><body><div id="app"></div></body></html>';
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://account-avatar.test') return route.fulfill({ contentType: 'image/webp', body: readFileSync(new URL('../../assets/avatars/claude.webp', import.meta.url)) });
    if (url.origin !== testOrigin) { external.push(url.href); return route.abort(); }
    if(url.pathname==='/persona-shell/chat/live'){liveConnections.push(url.href);if(failStreams>0){failStreams--;return route.abort();}return route.continue();}
    if(failSnapshot&&url.pathname==='/persona-shell/chat'&&route.request().method()==='GET'){failSnapshot=false;return route.abort();}
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (route.request().method() === 'GET') reads++;
    routeReads.push({path:url.pathname,method:route.request().method(),
      context:url.pathname.endsWith('/chat-context')&&route.request().method()==='POST'?route.request().postDataJSON():null});
    let status, value, headers;
    await routes[0].handler({ url: url.pathname + url.search, method: route.request().method(), headers: { authorization: 'owner' },
      async *[Symbol.asyncIterator]() { yield route.request().postData() ?? ''; } },
      { writeHead(code, next) { status = code; headers = next; }, end(body) { value = body; } });
    if(legacyChatHost&&url.pathname==='/persona-shell/chat'&&route.request().method()==='GET'){
      const old=JSON.parse(value);delete old.discussionVersion;value=JSON.stringify(old);
    }
    if (url.pathname === '/persona-shell/chat' && route.request().method() === 'POST'
      && JSON.parse(route.request().postData() ?? '{}').content === '旧头像快照') {
      lateAckBegin(); await new Promise((r) => { lateAckRelease = r; });
    }
    try { await route.fulfill({ status, contentType: headers?.['content-type'] ?? 'application/json', body: value }); } catch { /* A closed window may abort its read. */ }
  });
  await page.goto(testOrigin+'/'); await page.addScriptTag({ content: bundle });

  const dialog=()=>page.getByRole('dialog',{name:'聊天室',exact:true});
  const input=()=>page.getByLabel('发送给角色的消息');
  const state=()=>owner('chat');
  const open=async()=>{await page.getByRole('button',{name:'聊天室',exact:true}).first().click();await input().waitFor();await page.getByText('来源 · 1',{exact:true}).waitFor();};
  const recipients=page.getByRole('group',{name:'回复对象',exact:true});
  const toggleTarget=async name=>{const option=recipients.getByRole('checkbox',{name,exact:true}),next=await option.getAttribute('aria-checked')!=='true';await option.click();
    await page.waitForFunction(({name,next})=>{const option=document.querySelector('.dsh-persona-chat-recipient-option[aria-label="'+name+'"]');
      return option?.getAttribute('aria-checked')===String(next)&&!option.disabled;},{name,next});};
  const target=async name=>{const option=recipients.getByRole('checkbox',{name,exact:true});
    if(await option.getAttribute('aria-disabled')==='true'){
      const first=recipients.getByRole('checkbox',{checked:true}).first();await toggleTarget(await first.getAttribute('aria-label'));
    }
    if(await option.getAttribute('aria-checked')!=='true')await toggleTarget(name);
    const names=await recipients.getByRole('checkbox',{checked:true}).evaluateAll(items=>items.map(e=>e.getAttribute('aria-label')));
    for(const selected of names)if(selected!==name)await toggleTarget(selected);
  };
  const send=async text=>{await input().fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();};
  const settled=async()=>{await page.waitForFunction(()=>!document.querySelector('.dsh-persona-chat-typing')&&!Array.from(document.querySelectorAll('.dsh-persona-chat-compose-row button')).some(e=>['停止回复','停止接话'].includes(e.textContent)));};
  const capture=async(name,width=1100,dark=false)=>{await page.setViewportSize({width,height:850});await page.evaluate(d=>document.documentElement.dataset.theme=d?'dark':'light',dark);
    const box=await dialog().boundingBox();assert.ok(box.y>=51&&box.x>=0&&box.x+box.width<=width+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(values.output){mkdirSync(values.output,{recursive:true});await dialog().screenshot({path:path.join(values.output,name+'.png')});}};
  const members=async()=>{await page.getByRole('button',{name:'管理聊天室成员',exact:true}).click();await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor();};
  const chooseRoom=async name=>{await page.getByRole('button',{name:'切换聊天室',exact:true}).click();await page.getByRole('button',{name:'打开聊天室 '+name,exact:true}).click();await input().waitFor();};
  assert.equal(calls.length,0);assert.deepEqual(sourceReads,[]);
  await page.getByRole('button',{name:'插件设置',exact:true}).click();await page.locator('.dsh-persona-preset[data-active=true]').waitFor();
  assert.equal(routeReads.some(r=>r.path.includes('/chat-context')||r.path.endsWith('/chat')),false);
  await page.getByRole('button',{name:'插件设置',exact:true}).click();
  await page.getByRole('button',{name:'聊天室',exact:true}).first().click();
  await page.getByText('聊天存储正在准备，稍后可重新读取。',{exact:true}).waitFor();
  assert.deepEqual(sourceReads,[]);assert.equal((await state()).rooms.length,0);
  finishOpening();await new Promise(setImmediate);assert.equal((await state()).ready,true);
  const creating=pauseChatWrite();
  await page.getByRole('button',{name:'重新读取',exact:true}).click();await creating;
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/chat-rooms')&&r.method()==='POST'),
    page.getByRole('button',{name:'聊天室',exact:true}).first().click()]);
  releaseChatWrite();await input().waitFor();await page.getByText('来源 · 1',{exact:true}).waitFor();
  assert.equal((await state()).rooms.length,1,'reopening during the initial save joins the first creation');
  assert.deepEqual(sourceReads,['work']);assert.equal(calls.length,0);assert.equal(judgements.length,0,'opening never judges whether listeners should join');
  const initial=await state(),roomA=initial.room.id;assert.deepEqual(initial.room.memberIds,['大肥鱼（默认）']);
  assert.ok((await page.locator('.dsh-persona-chat-top').boundingBox()).height<65);
  assert.ok((await page.locator('.dsh-persona-chat-compose').boundingBox()).height<145);
  assert.equal(await recipients.count(),0,'single-person rooms do not show a target picker');
  assert.equal(await page.getByText('从一个想法，或今天的小事开始。',{exact:true}).count(),1);
  assert.equal(await page.getByRole('combobox',{name:'回复对象',exact:true}).count(),0);
  assert.equal(await page.locator('.dsh-persona-chat-top').getByRole('button',{name:'参考来源',exact:true}).count(),1,'source control stays in the header');
  assert.equal(await page.locator('.dsh-persona-chat-compose').getByRole('button',{name:'参考来源',exact:true}).count(),0);
  assert.equal(await page.locator('.dsh-persona-chat-compose').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px','no divider above the composer');
  assert.equal(await page.locator('.dsh-persona-chat-participants').count(),0,'single-person composer has no empty toolbar');
  assert.equal(await page.getByRole('button',{name:'管理聊天室成员',exact:true}).textContent(),'成员','member management has an explicit text entry');
  assert.equal(await page.locator('button .dsh-persona-room-avatar').count(),0,'room avatar is display-only');
  await capture('room-single-person-light');
  await input().fill('保留这段草稿。');await input().evaluate(e=>e.setSelectionRange(2,4));
  await page.getByRole('button',{name:'展开输入框',exact:true}).click();
  assert.equal(await input().evaluate(e=>document.activeElement===e&&e.selectionStart===2&&e.selectionEnd===4),true);
  await capture('room-composer-expanded-mobile',390);await page.getByRole('button',{name:'收起输入框',exact:true}).click();
  assert.equal(await input().inputValue(),'保留这段草稿。');await input().fill('');
  await members();await page.getByLabel('聊天室名称').fill('灵感讨论室');
  await page.getByRole('checkbox',{name:'成员 大肥龙',exact:true}).check();await page.getByRole('checkbox',{name:'成员 Claude小姐',exact:true}).check();
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor({state:'hidden'});
  assert.equal((await state()).room.id,roomA);assert.equal((await state()).room.memberIds.length,3);
  await page.waitForFunction(()=>document.querySelector('.dsh-persona-room-avatar-display [data-count="3"]'));
  assert.equal(await recipients.getByRole('checkbox').count(),3);
  for(const option of await recipients.getByRole('checkbox').all()){
    assert.equal(await option.locator('[role=img]').count(),1);
    assert.equal(await option.evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
  }
  assert.ok((await recipients.boundingBox()).y<(await input().boundingBox()).y,'members appear directly above the composer');
  assert.equal(await page.locator('.dsh-persona-chat-top .dsh-persona-chat-recipient-option').count(),0);
  const assertMembersFit=async()=>assert.ok(await recipients.evaluate(el=>{
    const bounds=el.getBoundingClientRect();
    return el.scrollWidth<=el.clientWidth && [...el.querySelectorAll('button')].every(b=>{
      const rect=b.getBoundingClientRect();
      return rect.width>=24 && rect.height>=24 && rect.left>=bounds.left-1 && rect.right<=bounds.right+1;
    });
  }),'every member is visible and reachable without horizontal scrolling');
  await capture('room-recipients-mobile',390);
  await assertMembersFit();
  await members();await page.getByRole('checkbox',{name:'成员 小肥鱼（实验性）',exact:true}).check();
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();
  const little=recipients.getByRole('checkbox',{name:'小肥鱼（实验性）',exact:true});
  await little.waitFor();assert.equal(await little.locator(':scope > span:last-child').textContent(),'小肥鱼');
  await little.click();await page.waitForFunction(()=>document.querySelector('[aria-label="小肥鱼（实验性）"][role=checkbox]')?.getAttribute('aria-checked')==='true');
  await capture('room-four-speakers',430);await assertMembersFit();
  await little.click();await page.waitForFunction(()=>document.querySelector('[aria-label="小肥鱼（实验性）"][role=checkbox]')?.getAttribute('aria-checked')==='false');
  await members();await page.getByRole('checkbox',{name:'成员 小肥鱼（实验性）',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();await little.waitFor({state:'hidden'});
  await recipients.getByRole('checkbox',{name:'大肥鱼（默认）',exact:true}).press('ArrowRight');
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('.dsh-persona-chat-recipient-option[aria-label="大肥龙"]')?.getAttribute('aria-checked')==='true');
  assert.deepEqual((await state()).room.targetPersonaIds,['大肥鱼（默认）','大肥龙']);
  await target('大肥鱼（默认）');assert.equal(calls.length,0);
  await send('房间内接力');await settled();assert.equal(calls.length,1);
  const beforeTarget=calls.length;await input().fill('换人时保留的草稿');await target('大肥龙');assert.equal(calls.length,beforeTarget);assert.equal(await input().inputValue(),'换人时保留的草稿');
  assert.equal((await state()).room.turns.length,1);

  await send('房间内接力');await settled();
  const shared=JSON.parse(calls.at(-1).messages[0].content[0].text);
  assert.equal(shared.history[0].recipient.id,'大肥鱼（默认）');assert.equal(shared.speaker.id,'大肥龙');assert.equal(shared.participants.length,3);
  assert.deepEqual((await state()).room.turns.map(t=>t.recipientId),['大肥鱼（默认）','大肥龙']);
  assert.equal(await page.locator('[data-chat-turn]').first().locator('[data-user=false] [aria-label="大肥鱼（默认）头像"]').count(),2);
  await capture('room-shared-history-light');await capture('room-shared-history-mobile',390);await capture('room-shared-history-dark',1100,true);

  await toggleTarget('大肥鱼（默认）');assert.equal(await recipients.getByRole('checkbox',{checked:true}).count(),2);
  assert.equal(await recipients.getByRole('checkbox',{name:'大肥龙',exact:true}).locator('[data-order]').getAttribute('data-order'),'1');
  await send('反序点名');await settled();
  const reverse=calls.slice(-2).map(c=>JSON.parse(c.messages[0].content[0].text));
  assert.deepEqual(reverse.map(p=>p.speaker.id),['大肥龙','大肥鱼（默认）']);
  assert.deepEqual(reverse[1].exchange.map(entry=>entry.speaker.id),['大肥龙']);
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'反序点名'}).locator('.dsh-persona-chat-mentions').textContent(),'@大肥龙 @大肥鱼（默认）');
  // Select GPT again, now as the second primary, for the retry and streaming cases below.
  await toggleTarget('大肥龙');await toggleTarget('大肥龙');
  const beforeMulti=calls.length;await send('多人回复重试');
  await page.getByRole('button',{name:'重试回复',exact:true}).waitFor();await settled();
  assert.equal(calls.length,beforeMulti+2);assert.equal(await page.locator('[data-user=true]').filter({hasText:'多人回复重试'}).count(),1);
  const mention=page.locator('[data-user=true]').filter({hasText:'多人回复重试'}).locator('.dsh-persona-chat-mentions');
  assert.equal(await mention.textContent(),'@大肥鱼（默认） @大肥龙');assert.ok(await mention.evaluate(e=>parseFloat(getComputedStyle(e).fontSize))<=10);
  await page.getByRole('button',{name:'重试回复',exact:true}).click();await page.getByRole('button',{name:'重试回复',exact:true}).waitFor();
  await page.getByRole('button',{name:'重试回复',exact:true}).click();await settled();
  assert.equal(calls.length,beforeMulti+4);assert.ok(calls.slice(beforeMulti+2).every(c=>JSON.parse(c.messages[0].content[0].text).speaker.id==='大肥龙'));
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'多人回复重试'}).count(),1);
  await capture('room-multi-mentions-light');await capture('room-multi-mentions-mobile',390);
  const beforeCooperation=calls.length;
  failStreams=1;const beforeReconnect=liveConnections.length;
  await send('多人流式');await page.getByText('大肥鱼（默认） 流式开头',{exact:true}).waitFor();
  assert.ok(liveConnections.length>=beforeReconnect+2,'the partial text resumes on a reopened room stream before the model finishes');
  const bothPending=(await state()).room.turns.slice(-2);assert.ok(bothPending.every(t=>t.status==='pending'&&!t.assistant.length));
  assert.equal(calls.length,beforeCooperation+1,'only the first primary starts while later speakers wait');
  assert.equal(await page.locator('.dsh-persona-chat-typing [aria-label="大肥龙头像"]').count(),0,'a queued primary does not pretend to type');
  assert.equal(await page.getByText('大肥龙 流式开头',{exact:true}).count(),0);
  const firstPrimaryRelease=gates.shift();assert.equal(typeof firstPrimaryRelease,'function');firstPrimaryRelease();
  await page.getByText('大肥龙 流式开头',{exact:true}).waitFor();assert.equal(calls.length,beforeCooperation+2);
  const secondPrimary=JSON.parse(calls.at(-1).messages[0].content[0].text);
  assert.deepEqual(secondPrimary.exchange.map(entry=>entry.speaker.id),['大肥鱼（默认）']);
  assert.ok(secondPrimary.exchange[0].messages.includes('大肥鱼（默认） 流式完成'));
  await capture('room-multi-streaming-mobile',390);for(const release of gates.splice(0))release();
  await settled();assert.ok((await state()).room.turns.slice(-2).every(t=>t.status==='ready'));

  // Observe every rendered prefix: a later speaker cannot appear and then have earlier bubbles inserted above it.
  const expectedOrder=['鱼先说第一句。','鱼接着说第二句。','鱼说完第三句。','龙接最后一句。'];
  await page.evaluate(expected=>{
    const thread=document.querySelector('.dsh-persona-chat-thread');window.badOrder=[];
    window.orderObserver=new MutationObserver(()=>{const list=[...thread.querySelectorAll('.dsh-persona-chat-body')].map(el=>el.textContent).filter(t=>expected.includes(t));
      if(list.some((t,i)=>t!==expected[i])||thread.querySelectorAll('[aria-label="角色输入中"]').length>1)window.badOrder.push(list);
    });window.orderObserver.observe(thread,{subtree:true,childList:true,characterData:true});
  },expectedOrder);
  await send('气泡顺序');await page.getByText(expectedOrder.at(-1),{exact:true}).waitFor();await settled();
  assert.deepEqual(await page.evaluate(()=>{window.orderObserver.disconnect();return window.badOrder;}),[]);

  reactionSelections.set('旁听成员参与一下',['Claude小姐']);
  const beforeReaction=calls.length,beforeJudgement=judgements.length;
  await send('旁听成员参与一下');await page.getByText('先保留原文依据，再决定怎么整理。',{exact:true}).waitFor();await settled();
  const reactionState=await state(),reactionGroup=reactionState.room.turns.slice(-3);
  assert.equal(calls.length,beforeReaction+3);assert.equal(judgements.length,beforeJudgement+1,'one unified listener judgement follows the primaries');
  assert.deepEqual(reactionGroup.map(turn=>turn.phase),['primary','primary','reaction']);
  assert.deepEqual(reactionGroup.map(turn=>turn.recipientId),['大肥鱼（默认）','大肥龙','Claude小姐']);
  assert.equal(new Set(reactionGroup.map(turn=>turn.messageId)).size,1);
  assert.ok(reactionGroup.every(turn=>turn.recipients.map(person=>person.id).join('|')==='大肥鱼（默认）|大肥龙'));
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'旁听成员参与一下'}).count(),1);
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'旁听成员参与一下'}).locator('.dsh-persona-chat-mentions').textContent(),'@大肥鱼（默认） @大肥龙');
  assert.deepEqual(reactionState.room.targetPersonaIds,['大肥鱼（默认）','大肥龙']);
  assert.equal(await recipients.getByRole('checkbox',{checked:true}).count(),2);
  const reactionPrompt=JSON.parse(calls.at(-1).messages[0].content[0].text);
  assert.equal(reactionPrompt.phase,'reaction');assert.deepEqual(reactionPrompt.exchange.map(entry=>entry.speaker.id),['大肥鱼（默认）','大肥龙']);
  await capture('room-listener-reaction-light');await capture('room-listener-reaction-mobile',390);

  await target('大肥鱼（默认）');await send('等一下再回');
  const typing=page.getByRole('status',{name:'角色输入中',exact:true});await typing.waitFor();
  assert.equal(await typing.locator('[aria-label="大肥鱼（默认）头像"]').count(),1);
  const originalCall=calls.at(-1);await target('Claude小姐');assert.equal(originalCall.signal.aborted,false);
  assert.equal(await typing.locator('[aria-label="大肥鱼（默认）头像"]').count(),1,'choosing another target does not relabel the original speaker');
  await members();await page.getByRole('checkbox',{name:'成员 大肥鱼（默认）',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();
  await page.getByText('原回复对象已移出聊天室，回复已停止。',{exact:true}).waitFor();
  assert.equal(originalCall.signal.aborted,true);for(const release of gates.splice(0))release();
  assert.equal(await page.getByRole('button',{name:'重试回复',exact:true}).count(),0);
  await page.waitForFunction(()=>document.querySelector('.dsh-persona-room-avatar-display [data-count="2"]'));
  await members();await page.getByRole('checkbox',{name:'成员 大肥龙',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();await recipients.waitFor({state:'hidden'});
  const groupRequest=page.locator('[data-user=true]').filter({hasText:'房间内接力'}).last();
  assert.equal(await groupRequest.locator('.dsh-persona-chat-mentions').textContent(),'@大肥龙','a group mention survives removal of the addressee');
  await input().fill('A 房间还没发送的草稿');
  const beforeRooms=calls.length;
  await owner('conversation',{sessionId:'remote',revision:0,action:'select',personaId:'Gemini',trigger:'inherit'});
  await page.evaluate(()=>window.switchWorkSession('remote'));
  await page.getByRole('button',{name:'切换聊天室',exact:true}).click();await page.getByRole('button',{name:'新建聊天室',exact:true}).click();
  await page.getByRole('checkbox',{name:'成员 Gemini',exact:true,checked:true}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'成员 Claude小姐',exact:true}).isChecked(),false);
  assert.deepEqual((await state()).room.sources,['work'],'preselecting the foreground persona does not rebind the current room');
  await page.getByRole('button',{name:'收起面板',exact:true}).click();await page.evaluate(()=>window.switchWorkSession('work'));
  await page.getByRole('button',{name:'切换聊天室',exact:true}).click();await page.getByRole('button',{name:'新建聊天室',exact:true}).click();
  await page.getByLabel('聊天室名称').fill('另一段讨论');
  await page.getByRole('checkbox',{name:'成员 大肥鱼（默认）',exact:true,checked:true}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'成员 Claude小姐',exact:true}).isChecked(),false);
  await page.getByRole('button',{name:'创建聊天室',exact:true}).click();await input().waitFor();await page.getByText('来源 · 1',{exact:true}).waitFor();
  const roomB=(await state()).room.id;assert.notEqual(roomB,roomA);assert.equal(await input().inputValue(),'');assert.equal(calls.length,beforeRooms);
  assert.equal(await recipients.count(),0,'returning to a single-person room hides the member controls');
  await page.getByRole('button',{name:'放大',exact:true}).click();
  await chooseRoom('灵感讨论室');assert.equal(await input().inputValue(),'A 房间还没发送的草稿');assert.equal(await dialog().getAttribute('data-wide'),'true');
  await chooseRoom('另一段讨论');assert.equal(await input().inputValue(),'');assert.equal(await dialog().getAttribute('data-wide'),'true');
  await page.getByRole('button',{name:'还原',exact:true}).click();
  await page.evaluate(()=>window.switchWorkSession('other'));
  assert.equal(await dialog().count(),1,'global window survives working-header unmount');
  await page.getByRole('button',{name:'参考来源',exact:true}).click();await page.getByRole('button',{name:'接入当前会话',exact:true}).click();
  await page.getByText('来源 · 2',{exact:true}).waitFor();
  assert.deepEqual((await state()).room.sources,['work','other']);
  assert.deepEqual((await owner('chat?room='+encodeURIComponent(roomA))).room.sources,['work']);
  await page.getByRole('button',{name:'收起来源',exact:true}).click();
  const sending=pauseChatWrite();
  await send('普通文本回复');await sending;
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  await page.getByRole('button',{name:'聊天室',exact:true}).first().click();
  const preparing=page.getByRole('button',{name:'正在确认…',exact:true});await preparing.waitFor();
  assert.equal(await preparing.isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'停止回复',exact:true}).count(),0,'the pending write has no reply to stop');
  assert.equal((await state()).room.turns.length,0);
  releaseChatWrite();await page.getByText('第二个气泡。',{exact:true}).waitFor();await settled();
  assert.equal(counts.get('普通文本回复'),1,'reopening a pending send does not submit it again');
  assert.equal(await page.getByText('NEVER_SHOW_REASONING',{exact:true}).count(),0);
  assert.equal((await state()).room.turns.length,1);
  assert.equal(await page.locator('[data-user=false] .dsh-persona-chat-speaker').count(),0,'ordinary private replies do not repeat the sole speaker name');

  await page.setViewportSize({width:1100,height:850});
  const beforeAvatar=calls.length;
  const custom=(await owner('presets',{action:'save',name:'新同伴',pack:{identity:'一起讨论想法的同伴'}})).presets.find(p=>p.name==='新同伴');
  await page.getByRole('button',{name:'切换聊天室',exact:true}).click();await page.getByRole('button',{name:'收起面板',exact:true}).click();
  await members();await page.getByRole('checkbox',{name:'成员 新同伴',exact:true}).check();await page.getByRole('button',{name:'保存聊天室',exact:true}).click();
  await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'普通文本回复'}).locator('.dsh-persona-chat-mentions').count(),0,'a private message cannot acquire a mention after someone joins');
  await page.getByRole('button',{name:'插件设置',exact:true}).click();await page.getByRole('button',{name:'修改新同伴头像',exact:true}).click();
  const editor=page.getByRole('group',{name:'编辑人格头像',exact:true});
  await editor.getByLabel('选择头像图片').setInputFiles(fileURLToPath(new URL('../../assets/avatars/claude.webp',import.meta.url)));
  await editor.getByRole('button',{name:'保存头像',exact:true}).click();await editor.waitFor({state:'hidden'});
  await page.waitForFunction(id=>!!document.querySelector('.dsh-persona-room-avatar-display img[src*="'+encodeURIComponent(id)+'"]'),custom.id);
  assert.equal((await state()).room.targetPersonaId,'大肥鱼（默认）','changing global defaults and avatar data never replaces the room target');
  await page.getByRole('button',{name:'插件设置',exact:true}).click();assert.equal(calls.length,beforeAvatar,'avatar changes do not call a model');

  await send('流式验证');await page.getByText('第一段正在',{exact:true}).waitFor();
  assert.equal((await state()).room.turns.at(-1).assistant.length,0);
  assert.equal(await page.getByText('SECRET_THINKING',{exact:true}).count(),0);
  streamRelease();await page.getByText('第一段正在输入。',{exact:true}).waitFor();await typing.waitFor();
  assert.equal(await page.getByText('第二段接着说。',{exact:true}).count(),0);
  finishStream();await page.getByText('第三段收尾。',{exact:true}).waitFor();await settled();

  // All room streams are unavailable and the first canonical read also fails. Never resend the user's message.
  failStreams=100;await send('轮询恢复');await page.getByRole('button',{name:'停止回复',exact:true}).waitFor();failSnapshot=true;
  await page.getByText('连接暂时中断，正在重新读取回复…',{exact:true}).waitFor();
  for(const release of gates.splice(0))release();
  await page.getByText('中断后接上了。',{exact:true}).waitFor();await settled();failStreams=0;
  assert.equal(await page.getByText('连接暂时中断，正在重新读取回复…',{exact:true}).count(),0);
  assert.equal(counts.get('轮询恢复'),1,'recovery reads canonical state without duplicating model calls');

  const beforeSuggestions=calls.length;
  await page.getByRole('checkbox',{name:'快捷回复参考',exact:true}).check();await input().fill('帮我追问实现成本');
  assert.equal(calls.length,beforeSuggestions);
  await page.getByRole('button',{name:'生成参考',exact:true}).click();
  const candidate=page.getByRole('button',{name:'实现起来会有多复杂？',exact:true});await candidate.waitFor();
  await candidate.click();assert.equal(await input().inputValue(),'实现起来会有多复杂？');assert.equal(calls.length,beforeSuggestions+1);
  await page.getByRole('checkbox',{name:'快捷回复参考',exact:true}).uncheck();
  await capture('room-selected-draft-light');await capture('room-selected-draft-dark',1100,true);
  await page.getByRole('button',{name:'放大',exact:true}).click();await page.getByRole('button',{name:'展开输入框',exact:true}).click();
  for(const viewport of [{width:1100,height:600},{width:850,height:450},{width:320,height:480}]){
    await page.setViewportSize(viewport);const box=await dialog().boundingBox(),messages=await page.locator('.dsh-persona-chat-thread').boundingBox();
    assert.ok(box.y>=51&&box.y+box.height<=viewport.height-7);assert.ok(messages.height>=Math.min(80,viewport.height*.17));
  }
  await page.getByRole('button',{name:'收起输入框',exact:true}).click();await page.getByRole('button',{name:'还原',exact:true}).click();
  await page.setViewportSize({width:1100,height:850});
  const beforeProfile=calls.length;
  await page.evaluate(()=>{window.accountAvatar='https://account-avatar.test/me.webp';return window.refreshAccountAvatar();});
  await page.locator('[data-user=true] img').first().waitFor();
  await page.getByRole('button',{name:'外观',exact:true}).click();await dialog().getByLabel('用户头像显示').selectOption('hidden');
  await page.waitForFunction(()=>!document.querySelector('[data-user=true] img'));
  await page.getByRole('button',{name:'收起外观',exact:true}).click();assert.equal(calls.length,beforeProfile);

  await send('模拟失败');await page.getByRole('button',{name:'重试回复',exact:true}).waitFor();
  await page.getByRole('button',{name:'重试回复',exact:true}).click();
  await page.getByRole('status').filter({hasText:'模型回复达到长度限制'}).waitFor();
  await page.getByRole('button',{name:'重试回复',exact:true}).click();await settled();
  assert.equal(counts.get('模拟失败'),3);assert.equal(await page.locator('[data-user=true]').filter({hasText:'模拟失败'}).count(),1);
  await members();await page.getByLabel('聊天室名称').fill('保存失败后仍保留的标题');failChatSave=true;
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();
  await page.getByRole('status').filter({hasText:'保存没有完成'}).waitFor();
  assert.equal(await page.getByLabel('聊天室名称').inputValue(),'保存失败后仍保留的标题');
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();
  await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor({state:'hidden'});
  assert.equal((await state()).room.name,'保存失败后仍保留的标题');

  const beforeClear=calls.length,existingMembers=(await state()).room.memberIds;
  await page.getByRole('button',{name:'清空',exact:true}).click();await page.getByRole('button',{name:'确认清空聊天',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-chat-turn]').length===0);
  assert.deepEqual((await state()).room.memberIds,existingMembers);assert.deepEqual((await state()).room.sources,['work','other']);
  await members();await page.getByRole('button',{name:'删除聊天室',exact:true}).click();await page.getByRole('button',{name:'确认删除聊天室',exact:true}).click();
  await page.getByRole('button',{name:'切换聊天室',exact:true}).waitFor();await page.getByText('来源 · 1',{exact:true}).waitFor();
  assert.equal((await state()).room.id,roomA);assert.equal((await state()).rooms.length,1);assert.equal(await input().inputValue(),'A 房间还没发送的草稿');
  assert.equal(calls.length,beforeClear);
  await members();await page.getByRole('button',{name:'删除聊天室',exact:true}).click();await page.getByRole('button',{name:'确认删除聊天室',exact:true}).click();
  await page.getByRole('region',{name:'聊天室列表',exact:true}).waitFor();assert.equal((await state()).rooms.length,0);
  await page.getByRole('button',{name:'收起面板',exact:true}).click();
  await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/persona-shell/chat'&&r.request().method()==='GET'),page.getByRole('button',{name:'重新读取',exact:true}).click()]);
  await page.getByText('选择一个聊天室，或新建一段讨论。',{exact:true}).waitFor();assert.equal((await state()).rooms.length,0,'a refresh after deleting the last room must not recreate it');
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();await open();
  assert.equal((await state()).room.targetPersonaId,custom.id,'fresh opening without rooms uses the current work persona');
  assert.equal((await state()).room.primarySessionId,'other','fresh opening uses the current foreground reference');
  assert.equal(calls.length,beforeClear,'creating a default empty room after opening never generates a greeting');
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  const readsAtClose=reads;await page.waitForTimeout(1100);assert.equal(reads,readsAtClose);
  legacyChatHost=true;await page.getByRole('button',{name:'聊天室',exact:true}).first().click();
  await page.getByText('聊天室后台需要重新加载，请完整退出并重新打开 DSH。',{exact:true}).waitFor();
  assert.equal(await input().count(),0);assert.equal(calls.length,beforeClear,'an old Host cannot accidentally dispatch a single-recipient fallback');
  legacyChatHost=false;await page.getByRole('button',{name:'重新读取',exact:true}).click();await input().waitFor();
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  const beforeEight=calls.length,names=[];
  for(let i=1;i<=7;i++){const name='并行成员'+i;names.push(name);await owner('presets',{action:'save',name,pack:{identity:'独立的讨论成员 '+i}});}
  await open();await members();for(const name of names)await page.getByRole('checkbox',{name:'成员 '+name,exact:true}).check();
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor({state:'hidden'});
  await toggleTarget(names[0]);
  assert.equal(await recipients.getByRole('checkbox',{checked:true}).count(),2);
  assert.equal(await recipients.getByRole('checkbox',{disabled:true}).count(),6);
  assert.equal(calls.length,beforeEight);
  assert.equal(await page.locator('.dsh-persona-room-avatar-display .dsh-persona-room-avatar-tile:not(.dsh-persona-room-avatar-more)').count(),3);
  assert.equal(await page.locator('.dsh-persona-room-avatar-display .dsh-persona-room-avatar-more').textContent(),'+5');
  assert.equal(await page.locator('.dsh-persona-room-avatar-display .dsh-persona-room-avatar').getAttribute('data-count'),'8');
  assert.equal(await page.locator('.dsh-persona-room-avatar-display .dsh-persona-room-avatar').getAttribute('data-visible-count'),'3');
  const beforeStreams=liveConnections.length;await send('多人流式');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-provisional=true] .dsh-persona-chat-body')).filter(e=>e.textContent.includes('流式开头')).length===1);
  assert.equal(calls.length,beforeEight+1,'only the first of the two primaries started; six listeners have not called models');
  assert.equal((await state()).activeAttemptIds.length,1);
  assert.equal(liveConnections.length-beforeStreams,1,'the eight-member room uses a single live stream');
  assert.ok(liveConnections.every(url=>new URL(url).searchParams.get('batch')==='1'));
  await capture('room-eight-participants-mobile',320);await assertMembersFit();
  await page.getByRole('button',{name:'停止回复',exact:true}).click();
  await settled();const stopped=(await state()).room.turns;const group=stopped.filter(t=>t.messageId===stopped.at(-1).messageId);
  assert.deepEqual(group.map(t=>t.status),['cancelled','cancelled']);assert.equal(calls.length,beforeEight+1);
  for(const release of gates.splice(0))release();
  // Tucking away a room releases its work-source lease, not the two replies already in flight.
  await send('多人流式');
  await page.waitForFunction(()=>document.querySelector('[data-provisional=true] .dsh-persona-chat-body')?.textContent.includes('流式开头'));
  await input().fill('还原时应保留的草稿');await input().evaluate(e=>e.setSelectionRange(2,4));
  const readsBeforeDock=sourceReads.length,postBeforeDock=routeReads.length,dockRoom=(await state()).room.id;
  const minimizeButton=page.getByRole('button',{name:'最小化聊天室',exact:true});
  const dock=page.getByRole('complementary',{name:'已最小化的聊天室'}),restore=dock.getByRole('button',{name:/还原聊天室/});
  await minimizeButton.click();await dock.waitFor();assert.equal(await dialog().count(),0);
  assert.equal(await restore.getAttribute('aria-label'),'还原聊天室');assert.equal(await restore.evaluate(e=>e===document.activeElement),true);
  const small=await dock.boundingBox(),screen=page.viewportSize();
  assert.ok(small.width<180&&small.height<52&&screen.width-small.x-small.width<=24&&screen.height-small.y-small.height<=24);
  gates.shift()();await dock.getByRole('button',{name:'还原聊天室，1 条新回复',exact:true}).waitFor();
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await dock.locator('.dsh-persona-chat-dock-count').evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  gates.shift()();await dock.getByRole('button',{name:'还原聊天室，2 条新回复',exact:true}).waitFor();
  assert.notEqual(await dock.locator('.dsh-persona-chat-dock-count').evaluate(e=>getComputedStyle(e).animationName),'none');
  if(values.output)await dock.screenshot({path:path.join(values.output,'room-minimized-replies.png')});
  const atRest=routeReads.filter(row=>row.path.endsWith('/chat')&&row.method==='GET').length;
  await page.waitForTimeout(1200);assert.equal(routeReads.filter(row=>row.path.endsWith('/chat')&&row.method==='GET').length,atRest,'no idle room polling');
  assert.equal((await state()).running,false);
  assert.equal(sourceReads.length,readsBeforeDock,'no work-source reads while minimized');
  assert.deepEqual(routeReads.slice(postBeforeDock).filter(row=>row.path.endsWith('/chat-context')).map(row=>[row.context?.action,row.context?.visible]),[['presence',false]]);
  assert.equal(calls.length,beforeEight+3,'only the two requested speakers ran');
  await restore.click();await input().waitFor();assert.equal(await input().inputValue(),'还原时应保留的草稿');
  assert.deepEqual(await input().evaluate(e=>[e===document.activeElement,e.selectionStart,e.selectionEnd]),[true,2,4]);
  assert.equal((await state()).room.id,dockRoom);
  await minimizeButton.click();await dock.waitFor();assert.equal(await restore.getAttribute('aria-label'),'还原聊天室','restoring cleared unread');
  await open();assert.equal(await input().inputValue(),'还原时应保留的草稿','workspace launcher restores the same draft');
  await minimizeButton.click();await dock.getByRole('button',{name:'关闭聊天室',exact:true}).click();assert.equal(await dock.count(),0);
  await open();await send('多人流式');
  await page.waitForFunction(()=>document.querySelector('[data-provisional=true] .dsh-persona-chat-body')?.textContent.includes('流式开头'));
  await minimizeButton.click();await dock.waitFor();
  const missing=page.waitForResponse(r=>new URL(r.url()).pathname==='/persona-shell/chat'&&r.status()===404);
  const removing=await state();await owner('chat-rooms',{action:'delete',roomId:dockRoom,epoch:removing.epoch,revision:removing.room.revision});
  await missing;assert.equal(await dialog().count(),0,'removing a room elsewhere must not reopen a minimized window');
  await restore.click();await page.getByRole('region',{name:'聊天室列表',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  for(const release of gates.splice(0))release();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({result:'passed',calls:calls.length,judgements:judgements.length,checks:['lazy global launch','slow storage first-room retry and overlapping opens','pending first send has no premature stop action','foreground work persona for a new room','reverse primary selection order','historical mentions survive member changes','room creation and selected room persistence','shared timeline and historical speaker identity',
    'borderless member strip and single-person simplification','header sources and visible member management','avatar options and composite updates','target changes during streaming','removed speaker cancellation','room-isolated drafts and sources','stream pacing and format retry',
    'sequential primary cooperation and repeated per-speaker retry','one unified judgement and an unmentioned listener reaction','eight members with two primary seats share one stream and stop before later calls','explicit quick replies','owner avatar display','custom member avatar refresh','expanded composer and safe viewport','failed room save retains draft','clear versus delete','old Host reload guard','closed window stops polling',
    'minimize releases source presence and counts distinct completed replies','dock respects reduced motion and stops polling after the round','restore from dock or launcher preserves room, draft and caret'],pageErrors:errors}));
} finally {
  finishOpening();for(const release of gates)release();releaseChatWrite?.();lateAckRelease?.();streamRelease?.();finishStream?.();
  await browser.close();for(const stop of [...disposers].reverse())await stop();
  streamServer.closeAllConnections();await new Promise(resolve=>streamServer.close(resolve));
}
