import {readChatInput} from '../helpers/chat-input.mjs';
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
  executable: { type: 'string' }, output: { type: 'string' }, 'ui-only': { type: 'boolean' }, 'settings-panel-only': { type: 'boolean' } } });
const deps = createRequire(path.resolve(values.deps));
const browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const tables = new Map(), calls = [], judgements = [], contextSelections = [], reactionSelections = new Map(), routes = [], disposers = [], gates = [], counts = new Map();
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
let streamRelease,finishStream,releaseWorkValidate,thinkingCapability='available',showSlowRound=false;
let presentationTimes;
let pauseContextSelection=false,contextSelectionEntered,releaseContextSelection;
const lateAckStarted = new Promise((r) => { lateAckBegin = r; });
const output = (messages, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ messages }) };
  yield { type: 'finish', reason: { kind: finish } };
})();
const candidateOutput = () => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ suggestions: ['先比较一下两种方案吧。', '实现起来会有多复杂？', '能举个具体例子吗？'] }) };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const workDraftOutput = () => (async function*(){yield{type:'text-delta',text:JSON.stringify({draft:'请先整理设置页的布局草图，保留原话依据。\n待确认：具体范围与验收标准。'})};yield{type:'finish',reason:{kind:'stop'}};})();
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
  ['llm', { resolveModelInfo:async()=>thinkingCapability==='unknown'?{}:({reasoning:{efforts:thinkingCapability==='unavailable'?[{id:'off'}]:[{id:'off'},{id:'low'},{id:'high'}],defaultEffort:thinkingCapability==='unavailable'?'off':'low'}}),stream(options) {
    const user = readChatInput(options); const content = user.message;
    if(user.task==='chat-room-director'){
      contextSelections.push(options);judgements.push(options);
      return(async function*(){
        if(pauseContextSelection){pauseContextSelection=false;contextSelectionEntered?.();await new Promise(resolve=>{releaseContextSelection=resolve;});}
        const sources=(user.sources??[]).map(source=>source.id),notNeeded=['今天就聊点轻松的吧。','先不谈工作，聊点轻松的。','先不聊工作了'].includes(content);
        const context=content==='筛选失败也别把所有工作都带进来。'?{work:'required',sourceIds:['not-authorized'],request:'answer',evidence:'筛选失败'}
          :{work:notNeeded||!sources.length?'not-needed':'required',sourceIds:notNeeded?[]:content==='只参考当前工作会话，帮我看进展。'?sources.filter(id=>id==='work'):sources,request:notNeeded?'open':'answer',evidence:content};
        const events=user.events??[],lastUser=events.findLast(event=>event.author.role==='user'),spoken=events.filter(event=>event.author.role==='assistant');
        const answered=new Set(spoken.map(event=>event.author.id));
        const pendingFor=id=>{const pending=user.states?.find(state=>state.id===id)?.pendingEventIds??[];return events.filter(event=>pending.includes(event.id)&&event.author.id!==id);};
        const selected=(user.recipients??[]).map(person=>person.id),order=[...(selected.length?selected:(user.members??[]).map(person=>person.id)),...(reactionSelections.get(content)??[])];
        let candidate=order.find(id=>!answered.has(id)&&(user.states??[]).some(state=>state.id===id&&state.normalReady)&&pendingFor(id).length);
        let to='user',kind='normal',basis=lastUser;
        if(!candidate&&['接一句试试','接话时我有新想法'].includes(content)&&spoken.length===2){candidate='大肥鱼（默认）';kind='peer';to='大肥龙';basis=pendingFor(candidate).findLast(event=>event.author.id===to);}
        if(content==='满员续聊三十二席'){
          const normal=(user.choices??[]).filter(option=>option.kind==='normal'),peer=(user.choices??[]).filter(option=>option.kind==='peer');
          const option=normal[0]??peer.toSorted((a,b)=>(user.states.find(state=>state.id===b.to)?.normalRemaining??0)-(user.states.find(state=>state.id===a.to)?.normalRemaining??0))[0];
          candidate=option?.id;kind=option?.kind;to=option?.to;basis=events.find(event=>event.id===option?.eventId);
        }
        if(candidate&&kind==='normal'&&!pendingFor(candidate).some(event=>event.id===basis?.id)){
          basis=pendingFor(candidate).at(-1);to=basis?.author.role==='user'?'user':basis?.author.id;
        }
        const next=candidate&&basis?{id:candidate,kind,to,evidence:{eventId:basis.id,index:0,text:Array.from(basis.messages[0]).slice(0,160).join('')},goal:'顺着这句新公开原话直接回应'}:null;
        if(next)assert.ok(pendingFor(candidate).some(event=>event.id===next.evidence.eventId),'fake director may only consume this actor\'s actual pending event');
        const wire={context,choiceId:null};
        if(next){const choices=user.choices??[],selected=choices.find(option=>option.id===next.id&&option.kind===next.kind&&option.to===next.to
            &&option.eventId===next.evidence.eventId&&option.index===next.evidence.index)
          ??choices.find(option=>option.id===next.id&&option.kind===next.kind&&option.to===next.to&&option.eventId===next.evidence.eventId);
          assert.ok(selected,'the fake intent must resolve to an actual prepared choice');wire.choiceId=selected.choiceId;wire.goal=next.goal;}
        assert.equal(user.protocol?.version,'D1','the actual Host director requests finite native control');
        const work=wire.context.work==='required'?wire.context.sourceIds.map(id=>user.sourceKeys.find(source=>source.id===id)?.key??'s99').join('+')
          :wire.context.work==='not-needed'?'N':'U';
        yield{type:'text-delta',text:`D1 ${user.protocol.ticket} ${wire.choiceId??'WAIT'} ${work} ${wire.context.request} q0`};yield{type:'finish',reason:{kind:'stop'}};
      })();
    }
    assert.ok(!['chat-context-selection','chat-turn-plan','chat-turn-continuation'].includes(user.task)&&!Array.isArray(user.candidates),'the real Host must use the one room director protocol');
    calls.push(options);
    if(user.task==='work-instruction-draft')return user.instruction==='慢指令整理'?(async function*(){await new Promise(r=>gates.push(r));yield*workDraftOutput();})():workDraftOutput();
    if (user.instruction !== undefined) return user.instruction === '慢候选请求' ? (async function* () {
      await new Promise((r) => gates.push(r)); yield* candidateOutput();
    })() : candidateOutput();
    counts.set(content, (counts.get(content) ?? 0) + 1);
    if(content==='这句可以先听着')return(async function*(){yield{type:'text-delta',text:'{"messages":['};await new Promise(resolve=>gates.push(resolve));yield{type:'text-delta',text:']}'};yield{type:'finish',reason:{kind:'stop'}};})();
    if(content==='满员续聊三十二席'){
      if(counts.get(content)===32)return(async function*(){yield{type:'text-delta',text:'{"messages":["第三十二席正在输入'};await new Promise(resolve=>gates.push(resolve));yield{type:'text-delta',text:'，把这句说完整。"]}'};yield{type:'finish',reason:{kind:'stop'}};})();
      return output(['第'+counts.get(content)+'席 '+user.speaker.name+' 的回应，'+user.participants.filter(person=>person.id!==user.speaker.id).map(person=>person.name).join('、')+'，你们怎么看？']);
    }
    if(['接一句试试','接话时我有新想法'].includes(content)){
      const peer=user.responsePlan?.to==='大肥龙';
      if(peer&&content==='接话时我有新想法')return(async function*(){await new Promise(r=>gates.push(r));yield*output(['先把这句接话说完整。']);})();
      return output([peer?'设置页，就先这一页。':user.speaker.id==='大肥龙'?'鲸鲸，那你先画哪一页？':'先用草图讨论布局。']);
    }
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
}, { provider: 'local', model: 'chat-model' }, { chatIntervalMs:0 });
for (let i = 0; i < 15; i++) await new Promise(setImmediate);
const streamServer=createServer((req,res)=>{req.headers.authorization='owner';void routes[0].handler(req,res).catch(()=>{if(!res.writableEnded)res.end();});});
await new Promise(r=>streamServer.listen(0,'127.0.0.1',r));const testOrigin='http://127.0.0.1:'+streamServer.address().port;
const owner = async (pathname, body) => {
  let status, value;
  await routes[0].handler({ url: '/persona-shell/' + pathname, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'owner' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
  { writeHead(code) { status = code; }, end(bytes) { value = Buffer.isBuffer(bytes) ? bytes : JSON.parse(bytes); } });
  assert.equal(status, 200, pathname+': '+(value?.error??'unexpected response')); return value;
};
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import * as ReactDOM from ' + JSON.stringify(deps.resolve('react-dom')) + ';',
  'import { createRoot } from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;if(id==="react-dom")return ReactDOM;if(id==="react-dom/client")return{createRoot};throw Error(id)})}};',
  source,
  'window.chatUiAPI=plugin.__testing;window.renderBubbleProbe=(turn,frame)=>{if(!window.bubbleProbe){const node=document.createElement("div");node.id="bubble-probe";document.body.append(node);window.bubbleProbe={node,root:createRoot(node)};}window.bubbleProbe.root.render(h(plugin.__testing.ChatReplyBubbles,{turn,frame,latest:false,running:turn.status==="pending",showSpeaker:true,avatar:()=>h("span",{"data-probe-avatar":""},"头像"),onQuote:(turn,index,text)=>{window.probeQuote={id:turn.id,index,text};}}));};window.clearBubbleProbe=()=>{window.bubbleProbe?.root.unmount();window.bubbleProbe?.node.remove();delete window.bubbleProbe;};',
  'window.reportReadingRuntime=plugin.__testing.reportReadingRuntime;window.accountReads=0;window.accountAvatar=null;window.accountSignedIn=true;plugin.__testing.accountAvatarSource.bind({account:{getState:async()=>({ok:true,value:{status:window.accountSignedIn?"credential-stored":"signed-out"}}),getProfile:async()=>{window.accountReads++;return{ok:true,value:{status:"ready",value:{avatarUrl:window.accountAvatar}}}}}},()=>({version:"test",locale:"zh-CN",timezoneOffsetSeconds:0}));window.refreshAccountAvatar=()=>plugin.__testing.accountAvatarSource.refresh();',
  'function Demo(){const[settings,setSettings]=React.useState(false);const[report,setReport]=React.useState("大肥鱼（默认）");const[workSession,setWorkSession]=React.useState("work");const[inputs,setInputs]=React.useState({});const current=inputs[workSession]??{draft:"WORK_ONLY_DO_NOT_READ",attachmentIds:[],occurrences:[],phase:"plain",draftRev:0};const native=React.useRef({});native.current={inputs,workSession,current};window.switchWorkSession=setWorkSession;window.setReportPersona=setReport;window.nativeFills??=0;window.nativePersists??=0;const put=(id,value)=>setInputs(old=>({...old,[id]:value}));window.setNativeWorkInput=(draft,extra={})=>{const n=native.current;put(n.workSession,{...n.current,...extra,draft,draftRev:n.current.draftRev+1});};window.setNativeWorkMeta=extra=>{const n=native.current;put(n.workSession,{...n.current,...extra});};const actions=React.useMemo(()=>({captureInsertion(){const n=native.current;return{start:n.current.draft.length,end:n.current.draft.length,draftRev:n.current.draftRev};},insertText(text,span){const n=native.current;if(n.workSession!==workSession||n.current.phase!=="plain"||n.current.draftRev!==span.draftRev)return false;window.nativeFills++;put(workSession,{...n.current,draft:n.current.draft.slice(0,span.start)+text+n.current.draft.slice(span.end),draftRev:n.current.draftRev+1});return true;},persistDraft(){window.nativePersists++;}}),[workSession]);return h(React.Fragment,null,h("header",{key:workSession},h(plugin.__testing.WorkInputBridge,{sessionId:workSession,useInput:selector=>selector(current),inputActions:actions,useSessions:selector=>selector({byId:{work:{displayTitle:"当前任务"},other:{displayTitle:"后台任务"}}})}),h(plugin.__testing.PersonaChatLauncher,{sessionId:workSession,conversation:{effectivePersonaId:report}})),',
  'h("main",null,h("h1",null,"原始工作会话"),h("textarea",{"aria-label":"工作会话输入",value:current.draft,onChange:e=>window.setNativeWorkInput(e.target.value)}),',
  'h("p",null,"这部分始终由原始工作界面显示。")),h("aside",null,h(plugin.__testing.PersonaChatLauncher),h("button",{onClick:()=>setSettings(!settings)},"插件设置")),settings?h(plugin.__testing.SettingsSection):null)}',
  'createRoot(document.getElementById("app")).render(h(Demo));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
let browserPage;
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.setDefaultTimeout(7000);
  browserPage=page;
  const errors = [], external = [],liveConnections=[];let legacyChatHost=false,failStreams=0,failSnapshot=false,failReferenceRead=false,failWorkRead=false,failWorkGenerate=false;
  let delayWorkValidate=false,enteredWorkValidate;
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
    if(failReferenceRead&&url.pathname==='/persona-shell/chat-references'&&route.request().method()==='GET'){failReferenceRead=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});}
    if(url.pathname==='/persona-shell/chat-work-draft'){
      if(route.request().method()==='GET'&&failWorkRead){failWorkRead=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});}
      const action=route.request().method()==='POST'?JSON.parse(route.request().postData()??'{}').action:null;
      if(action==='generate'&&failWorkGenerate){failWorkGenerate=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"chat-draft-unavailable"}'});}
      if(action==='validate'&&delayWorkValidate){delayWorkValidate=false;enteredWorkValidate?.();await new Promise(resolve=>{releaseWorkValidate=resolve;});}
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (route.request().method() === 'GET') reads++;
    routeReads.push({path:url.pathname,method:route.request().method(),
      context:url.pathname.endsWith('/chat-context')&&route.request().method()==='POST'?route.request().postDataJSON():null,
      chat:url.pathname.endsWith('/chat')&&route.request().method()==='POST'?route.request().postDataJSON():null});
    let status, value, headers;
    await routes[0].handler({ url: url.pathname + url.search, method: route.request().method(), headers: { authorization: 'owner' },
      async *[Symbol.asyncIterator]() { yield route.request().postData() ?? ''; } },
      { writeHead(code, next) { status = code; headers = next; }, end(body) { value = body; } });
    if(legacyChatHost&&url.pathname==='/persona-shell/chat'&&route.request().method()==='GET'){
      const old=JSON.parse(value);delete old.discussionVersion;value=JSON.stringify(old);
    }
    if(showSlowRound&&url.pathname==='/persona-shell/chat'){
      const snapshot=JSON.parse(value);if(snapshot.running)snapshot.roundElapsedMs=9500;value=JSON.stringify(snapshot);
    }
    if(presentationTimes&&url.pathname==='/persona-shell/chat'){
      const snapshot=JSON.parse(value);if(snapshot.room?.id===presentationTimes.roomId){
        for(const turn of snapshot.room.turns)if(presentationTimes.values[turn.id]!==undefined)turn.at=presentationTimes.values[turn.id];
        value=JSON.stringify(snapshot);
      }
    }
    if (url.pathname === '/persona-shell/chat' && route.request().method() === 'POST'
      && JSON.parse(route.request().postData() ?? '{}').content === '旧头像快照') {
      lateAckBegin(); await new Promise((r) => { lateAckRelease = r; });
    }
    try { await route.fulfill({ status, contentType: headers?.['content-type'] ?? 'application/json', body: value }); } catch { /* A closed window may abort its read. */ }
  });
  await page.goto(testOrigin+'/');
  await page.evaluate(()=>{
    const native=document.startViewTransition;
    window.__chatMotionProbe={native,available:typeof native==='function',operations:[]};
    if(typeof native==='function')document.startViewTransition=function(...args){
      const transition=native.apply(document,args),entry={ready:false,finished:false,startedAt:performance.now()};
      window.__chatMotionProbe.operations.push(entry);
      transition.ready.then(()=>{entry.ready=true;entry.readyAt=performance.now();},()=>{entry.skipped=true;});
      transition.finished.then(()=>{entry.finished=true;entry.finishedAt=performance.now();},()=>{entry.finished=true;entry.failed=true;});
      return transition;
    };
  });
  await page.addScriptTag({ content: bundle });

  const dialog=()=>page.getByRole('dialog',{name:'聊天室',exact:true});
  const input=()=>page.getByLabel('发送给角色的消息');
  const state=()=>owner('chat');
  const replies=room=>room.turns.filter(turn=>turn.phase!=='anchor');
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
  const roomSettled=async(roomId)=>{for(let tick=0;tick<1000;tick++){const snapshot=await owner('chat?room='+encodeURIComponent(roomId));
    if(!snapshot.running&&!(snapshot.queuedInputs??[]).some(batch=>batch.status!=='failed'))return snapshot;await new Promise(resolve=>setTimeout(resolve,5));}
    throw Error('room transport and models did not settle: '+roomId);};
  const settled=async()=>{await roomSettled((await state()).room.id);await page.waitForFunction(()=>!document.querySelector('.dsh-persona-chat-typing')&&!Array.from(document.querySelectorAll('.dsh-persona-chat-compose-row button')).some(e=>['停止回复','停止接话'].includes(e.textContent)),{},{timeout:15000});};
  const capture=async(name,width=1100,dark=false)=>{await page.setViewportSize({width,height:850});await page.evaluate(d=>document.documentElement.dataset.theme=d?'dark':'light',dark);
    await page.evaluate(async()=>{
      await new Promise(resolve=>requestAnimationFrame(resolve));
      await Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation=>animation.finished.catch(()=>{})));
    });
    const box=await dialog().boundingBox();assert.ok(box.y>=51&&box.x>=0&&box.x+box.width<=width+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(values.output){mkdirSync(values.output,{recursive:true});await dialog().screenshot({path:path.join(values.output,name+'.png')});}};
  const members=async()=>{await page.getByRole('button',{name:'管理聊天室成员',exact:true}).click();await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor();};
  const chooseRoom=async name=>{await page.getByRole('button',{name:'切换聊天室',exact:true}).click();await page.getByRole('button',{name:'打开聊天室 '+name,exact:true}).click();await input().waitFor();};
  const inspectSettingsPanel=async()=>{
    const result=await dialog().locator('.dsh-persona-chat-appearance').evaluate(panel=>{
      const header=panel.querySelector('.dsh-persona-chat-settings-heading'),body=panel.querySelector('.dsh-persona-chat-settings-body'),close=header.querySelector('button');
      const box=node=>{const rect=node.getBoundingClientRect();return{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,height:rect.height};};
      const outer=box(panel),heading=box(header),scroll=box(body),button=box(close),hits=[];
      for(let y=heading.top+2;y<heading.bottom-1;y+=4)for(const x of [heading.left+4,(heading.left+heading.right)/2,heading.right-5]){
        const node=document.elementFromPoint(x,y);hits.push(!!node?.closest('.dsh-persona-chat-settings-body'));
      }
      return{outer,heading,scroll,button,headerPosition:getComputedStyle(header).position,background:getComputedStyle(header).backgroundColor,
        bodyOverflow:getComputedStyle(body).overflowY,outerOverflow:getComputedStyle(panel).overflowY,outerScroll:panel.scrollTop,
        outerOverflowSize:panel.scrollHeight-panel.clientHeight,bodyScroll:body.scrollTop,bodyOverflowSize:body.scrollHeight-body.clientHeight,bodyHitsInHeader:hits.some(Boolean)};
    });
    assert.notEqual(result.headerPosition,'sticky','the title has its own fixed layout row rather than sticky compensation');
    assert.ok(Math.abs(result.heading.top-result.outer.top-1)<2,'the complete title row begins at the rounded outer frame');
    assert.ok(result.scroll.top>=result.heading.bottom-.5,'the scrolling body begins below the complete title row');
    assert.ok(result.scroll.bottom<=result.outer.bottom+1);
    assert.ok(result.button.top>=result.heading.top&&result.button.bottom<=result.heading.bottom);
    assert.equal(result.bodyOverflow,'auto');assert.equal(result.outerOverflow,'hidden');assert.equal(result.outerScroll,0);assert.ok(result.outerOverflowSize<=1);
    assert.equal(result.bodyHitsInHeader,false,'no checkbox or text from the scrolling body is hit-testable over the title');
    assert.notEqual(result.background,'rgba(0, 0, 0, 0)');
    return result;
  };
  const runBubbleGrouping=async()=>{
    const turn={id:'probe-turn',attemptId:'probe-attempt',speakerName:'历史署名',status:'pending',assistant:[]};
    await page.evaluate(turn=>window.renderBubbleProbe(turn,{attemptId:turn.attemptId,messages:[{text:'',complete:true},{text:'源索引为第二段',complete:false}]}),turn);
    const probe=page.locator('#bubble-probe');await probe.locator('[data-chat-bubble="1"]').waitFor();
    assert.equal(await probe.locator('[data-chat-bubble="0"]').count(),0,'an empty stream segment is not rendered as a bubble');
    assert.equal(await probe.locator('[data-probe-avatar]').count(),1);assert.equal(await probe.locator('.dsh-persona-chat-speaker').textContent(),'历史署名');
    assert.equal(await probe.locator('[data-chat-bubble="1"]').getAttribute('data-chat-continuation'),null,'the first visible segment owns the speaker identity');
    await page.evaluate(turn=>window.renderBubbleProbe({...turn,status:'ready',assistant:['','源索引为第二段','第三段继续']}),turn);
    await probe.getByRole('button',{name:'引用历史署名的第2条消息',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.probeQuote),{id:turn.id,index:1,text:'源索引为第二段'});
    assert.equal(await probe.locator('[data-probe-avatar]').count(),1);
    assert.equal(await probe.locator('[data-chat-bubble="2"][data-chat-continuation="true"] .dsh-persona-chat-avatar-spacer[aria-hidden="true"]').count(),1);
    await page.evaluate(()=>window.clearBubbleProbe());
  };
  await runBubbleGrouping();
  const runMessageTimes=async()=>{
    if(await input().count())await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
    const beforeCalls=calls.length;
    const made=await owner('chat-rooms',{action:'create',requestId:'presentation-times',name:'轻量时间与跨日',memberIds:['大肥鱼（默认）'],targetPersonaIds:['大肥鱼（默认）'],epoch:(await state()).epoch});
    const roomId=made.room.id,context=await owner('chat-context',{action:'open',roomId,viewer:'presentation-times',sequence:1,sessionId:'work'}),binding={roomId,contextKey:context.id+':'+context.revision};
    for(let index=0;index<5;index++){
      const current=await owner('chat?room='+encodeURIComponent(roomId));
      await owner('chat',{...binding,action:'send',personaId:'大肥鱼（默认）',recipientIds:['大肥鱼（默认）'],requestId:'presentation-time-'+index,content:'时间分隔原话 '+index,revision:current.room.revision,epoch:current.epoch});
      await roomSettled(roomId);
    }
    const original=(await owner('chat?room='+encodeURIComponent(roomId))).room,calendar=await page.evaluate(()=>{
      const local=(days,hour,minute)=>{const value=new Date();value.setDate(value.getDate()+days);value.setHours(hour,minute,7,0);return value.getTime();};
      const values=[local(-2,13,5),local(-1,23,58),local(0,0,1),local(0,0,6),local(0,0,12)];
      const pad=value=>String(value).padStart(2,'0');
      return{values,expected:[0,1,2,4].map(index=>{const value=new Date(values[index]),day=value.getFullYear()+'/'+(value.getMonth()+1)+'/'+value.getDate(),clock=pad(value.getHours())+':'+pad(value.getMinutes());
        return{label:index===0?day+' '+clock:index===1?'昨天 '+clock:clock,title:day+' '+clock+':07',dateTime:value.toISOString()};})};
    });
    const judgementsBeforeRender=judgements.length;
    const heads=original.turns.filter((turn,index)=>original.turns.findIndex(other=>other.messageId===turn.messageId)===index);
    presentationTimes={roomId,values:Object.fromEntries(original.turns.map(turn=>[turn.id,calendar.values[heads.findIndex(head=>head.messageId===turn.messageId)]]))};
    await open();
    const actual=await dialog().locator('.dsh-persona-chat-time time').evaluateAll(nodes=>nodes.map(node=>({label:node.textContent,title:node.title,dateTime:node.dateTime,aria:node.getAttribute('aria-label')})));
    assert.deepEqual(actual,calendar.expected.map(value=>({...value,aria:value.title})),'dates use local calendar boundaries and five-minute gaps, with exact timestamps available on demand');
    assert.equal(await dialog().locator('[data-chat-user-head="'+heads[3].id+'"] .dsh-persona-chat-time').count(),0,'an exact five-minute gap on the same date adds no repeated timestamp');
    assert.equal(calls.length,beforeCalls+5);assert.equal(judgements.length,judgementsBeforeRender,'rendering date and time adds no model calls');
    assert.deepEqual((await owner('chat?room='+encodeURIComponent(roomId))).room.turns.map(turn=>turn.at),original.turns.map(turn=>turn.at),'display fixtures do not change canonical message timestamps');
    if(values.output){
      await page.getByLabel('聊天消息',{exact:true}).evaluate(element=>{element.scrollTop=0;element.dispatchEvent(new Event('scroll'));});await capture('room-grouped-time-light',1100);
      await page.getByLabel('聊天消息',{exact:true}).evaluate(element=>{element.scrollTop=0;element.dispatchEvent(new Event('scroll'));});await capture('room-grouped-time-mobile',390,true);
    }
    await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();presentationTimes=undefined;
  };
  const runSilentReply=async()=>{
    if(await input().count())await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
    const made=await owner('chat-rooms',{action:'create',requestId:'silent-room',name:'不必每句都接',memberIds:['大肥鱼（默认）'],targetPersonaIds:['大肥鱼（默认）'],epoch:(await state()).epoch});
    await open();const beforeCalls=calls.length;await send('这句可以先听着');
    await dialog().locator('.dsh-persona-chat-typing').waitFor();assert.equal(await dialog().locator('[data-chat-bubble]').count(),0,'an empty structured prefix has no public bubble');
    assert.equal(typeof gates[0],'function');gates.shift()();await settled();const current=await state();
    assert.equal(current.room.id,made.room.id);assert.equal(current.room.turns.length,1);assert.equal(current.room.turns[0].phase,'anchor');
    assert.equal(current.directorFailure,null);assert.equal(calls.length,beforeCalls+1,'silence consumes the event without another immediate body call');
    assert.equal(await dialog().locator('[data-chat-turn]').count(),0);assert.equal(await dialog().locator('.dsh-persona-chat-typing').count(),0);
    assert.equal(await dialog().getByRole('button',{name:/重试回复|重试回应|继续接话/}).count(),0,'choosing not to speak is not a failed response');
    const refs=await owner('chat-references?room='+encodeURIComponent(made.room.id));assert.equal(refs.records[0].outcome,'silent');
    assert.equal(await dialog().locator('[data-user=true]').count(),1);await capture('room-explicit-silent-mobile',390);
    await send('下一句还是可以回答');await settled();assert.ok(replies((await state()).room).some(turn=>turn.user==='下一句还是可以回答'&&turn.status==='ready'));
    await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  };
  const runContinuity=async(peerName)=>{
    if(!peerName){const peer=await owner('chat-rooms',{action:'create',requestId:'continuity-peer',name:'切换阅读参照房间',memberIds:['大肥鱼（默认）'],targetPersonaIds:['大肥鱼（默认）'],epoch:(await state()).epoch});peerName=peer.room.name;}
  // UI continuity is local to this profile and room, including a fresh client document.
  const continuityRoom=await owner('chat-rooms',{action:'create',requestId:'ui-continuity-room',name:'阅读与草稿验证',memberIds:['大肥鱼（默认）','大肥龙','Claude小姐'],
    targetPersonaIds:['大肥鱼（默认）','大肥龙'],epoch:(await state()).epoch});
  const continuityContext=await owner('chat-context',{action:'open',roomId:continuityRoom.room.id,viewer:'continuity-seed',sequence:1,sessionId:'work'});
  const directContinuity=async(content,id)=>{
    const snapshot=await owner('chat?room='+continuityRoom.room.id);
    await owner('chat',{action:'send',roomId:continuityRoom.room.id,personaId:snapshot.room.targetPersonaId,recipientIds:snapshot.room.targetPersonaIds,
      requestId:id,content,revision:snapshot.room.revision,epoch:snapshot.epoch,contextKey:continuityContext.id+':'+continuityContext.revision});
    await roomSettled(continuityRoom.room.id);
  };
  for(let i=0;i<15;i++){const content='保留第'+i+'轮原话，讨论阅读位置。';reactionSelections.set(content,['Claude小姐']);await directContinuity(content,'continuity-'+i);}
  const seeded=await owner('chat?room='+continuityRoom.room.id);
  assert.ok(replies(seeded.room).filter(turn=>turn.status==='ready').length>40,'the reading baseline includes more than 40 completed persona replies');
  await owner('chat-context',{action:'presence',roomId:continuityRoom.room.id,viewer:'continuity-seed',sequence:2,visible:false});
  await open();await input().fill('重启后继续修改的本房间草稿');await input().evaluate(element=>element.setSelectionRange(2,8));
  const readThread=page.getByLabel('聊天消息',{exact:true});
  await readThread.evaluate(element=>{element.scrollTop=80;element.dispatchEvent(new Event('scroll'));});
  const readingAnchor=()=>readThread.evaluate(element=>{const top=element.getBoundingClientRect().top,node=[...element.querySelectorAll('.dsh-persona-chat-message')].find(item=>item.getBoundingClientRect().bottom>top+8);
    const owner=node.closest('[data-chat-turn],[data-chat-user-head]');return{turn:owner.dataset.chatTurn??owner.dataset.chatUserHead,kind:node.dataset.user,index:node.dataset.chatBubble,offset:node.getBoundingClientRect().top-top};});
  const beforeRoomLeave=await readingAnchor();
  await chooseRoom(peerName);
  const afterLeaveStored=await page.evaluate(id=>{const key=Object.keys(localStorage).find(key=>key.startsWith('dsh-persona-shell:room-ui:'));const r=JSON.parse(localStorage.getItem(key)).rooms[id];return{reading:r?.reading,selection:r?.selection};},continuityRoom.room.id);
  await chooseRoom(continuityRoom.room.name);
  const afterRoomReturn=await readingAnchor();assert.equal(afterRoomReturn.turn,beforeRoomLeave.turn);assert.ok(Math.abs(afterRoomReturn.offset-beforeRoomLeave.offset)<2,JSON.stringify({beforeRoomLeave,afterRoomReturn,afterLeaveStored}));
  assert.equal(await input().inputValue(),'重启后继续修改的本房间草稿');assert.deepEqual(await input().evaluate(element=>[element.selectionStart,element.selectionEnd]),[2,8]);
  assert.equal(await page.getByRole('button',{name:/条新回复.*回到最新消息/}).count(),0,'old completed replies are not manufactured into unread counts');
  await page.getByRole('button',{name:'切换聊天室',exact:true}).click();
  const roomDirectory=page.getByRole('region',{name:'聊天室列表',exact:true}),directoryModels=calls.length,selectionModels=contextSelections.length,readsBeforeSearch=sourceReads.length;
  assert.equal(await roomDirectory.locator('.dsh-persona-chat-room-list>button').first().getAttribute('aria-label'),'打开聊天室 '+continuityRoom.room.name);
  assert.match(await roomDirectory.getByRole('button',{name:'打开聊天室 '+continuityRoom.room.name,exact:true}).innerText(),/有草稿/);
  await page.getByRole('searchbox',{name:'搜索聊天室',exact:true}).fill('Claude');
  assert.ok((await roomDirectory.locator('.dsh-persona-chat-room-list>button').count())>0);
  if(values.output)await capture('room-directory-search-mobile',390,true);
  await page.getByRole('searchbox',{name:'搜索聊天室',exact:true}).fill('不存在的房间');await page.getByText('没有找到匹配的聊天室。',{exact:true}).waitFor();
  assert.equal(calls.length,directoryModels);assert.equal(contextSelections.length,selectionModels);assert.equal(sourceReads.length,readsBeforeSearch);
  await page.getByRole('searchbox',{name:'搜索聊天室',exact:true}).fill('');await page.getByRole('button',{name:'收起面板',exact:true}).click();
  await chooseRoom(peerName);
  await owner('chat-context',{action:'open',roomId:continuityRoom.room.id,viewer:'continuity-seed',sequence:3,sessionId:'work'});
  await directContinuity('外页新完成的一轮讨论。','continuity-new');
  await owner('chat-context',{action:'presence',roomId:continuityRoom.room.id,viewer:'continuity-seed',sequence:4,visible:false});
  await chooseRoom(continuityRoom.room.name);
  await page.getByRole('button',{name:/2 条新回复.*回到最新消息/}).waitFor();
  assert.equal((await readingAnchor()).turn,beforeRoomLeave.turn,'new replies do not move an older reading anchor');
  await page.getByRole('button',{name:/2 条新回复.*回到最新消息/}).click();
  await readThread.evaluate(element=>{element.scrollTop=80;element.dispatchEvent(new Event('scroll'));});
  await readThread.locator('[data-user=true]').first().hover();await readThread.locator('[data-user=true]').first().getByRole('button',{name:'引用我的消息',exact:true}).click();
  await input().evaluate(element=>element.setSelectionRange(2,8));const restartAnchor=await readingAnchor();
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();await dialog().waitFor({state:'hidden'});
  const namespace=(await state()).localStateKey,storageKey='dsh-persona-shell:room-ui:v1:'+namespace;
  const stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),storageKey),storedDraft=stored.rooms[continuityRoom.room.id].draft;
  assert.ok(storedDraft.quoteRef);assert.equal('quote' in storedDraft,false,'quote previews and authors are never serialized into the UI draft');
  const beforeReloadCalls=calls.length,beforeReloadSelections=contextSelections.length;
  await page.reload();await page.addScriptTag({content:bundle});assert.equal(await input().count(),0,'restoring a client document does not open the chat');
  await open();assert.equal(await input().inputValue(),'重启后继续修改的本房间草稿');await page.getByLabel('正在引用的消息',{exact:true}).waitFor();
  assert.deepEqual(await input().evaluate(element=>[element.selectionStart,element.selectionEnd]),[2,8]);
  assert.equal((await readingAnchor()).turn,restartAnchor.turn);assert.ok(Math.abs((await readingAnchor()).offset-restartAnchor.offset)<2);
  assert.equal(calls.length,beforeReloadCalls);assert.equal(contextSelections.length,beforeReloadSelections);
  await page.evaluate(()=>window.switchWorkSession('other'));await page.getByRole('button',{name:'参考来源',exact:true}).click();await page.getByRole('button',{name:'接入当前会话',exact:true}).click();
  await page.getByText('来源 · 2',{exact:true}).waitFor();await page.getByRole('button',{name:'收起来源',exact:true}).click();
  await page.getByLabel('正在引用的消息',{exact:true}).waitFor({state:'hidden'});assert.equal(await input().inputValue(),'重启后继续修改的本房间草稿');
  await page.getByRole('button',{name:'清空',exact:true}).click();await page.getByRole('button',{name:'确认清空聊天',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#dsh-persona-chat-input')?.value==='');
  assert.equal((await state()).room.generation,seeded.room.generation+1);
  const cleared=await page.evaluate(({key,id})=>JSON.parse(localStorage.getItem(key)).rooms[id],{key:storageKey,id:continuityRoom.room.id});
  assert.equal(cleared.draft.text,'');assert.equal(cleared.draft.quoteRef,null);
  // A slow real pending model remains cancellable and reveals timing/model only on request.
  await target('大肥鱼（默认）');showSlowRound=true;await send('等一下再回');
  const slowStatus=page.getByLabel('本轮等待情况',{exact:true});await slowStatus.waitFor();
  await slowStatus.locator('summary').click();await slowStatus.getByText(/本轮已用时.*当前调用模型：chat-model/).waitFor();
  if(values.output)await capture('room-waiting-details-mobile',390,true);
  assert.doesNotMatch(await slowStatus.innerText(),/%|思考内容|SECRET_THINKING/);
  const slowCalls=calls.length;await page.getByRole('button',{name:'切换聊天室',exact:true}).click();
  assert.match(await page.getByRole('button',{name:'打开聊天室 '+continuityRoom.room.name,exact:true}).innerText(),/正在回复/);
  assert.equal(calls.length,slowCalls);await page.getByRole('button',{name:'收起面板',exact:true}).click();
  await page.getByRole('button',{name:'停止回复',exact:true}).click();for(const release of gates.splice(0))release();showSlowRound=false;await settled();
  await members();await page.getByRole('button',{name:'删除聊天室',exact:true}).click();
  const deleted=page.waitForResponse(response=>new URL(response.url()).pathname==='/persona-shell/chat-rooms'&&response.request().method()==='POST'
    &&response.request().postDataJSON()?.action==='delete'&&response.request().postDataJSON()?.roomId===continuityRoom.room.id);
  const confirmDelete=page.getByRole('button',{name:'确认删除聊天室',exact:true});await confirmDelete.click();assert.equal((await deleted).status(),200);
  await confirmDelete.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(({key,id})=>!!JSON.parse(localStorage.getItem(key)).rooms[id],{key:storageKey,id:continuityRoom.room.id}),false,'deleting a room removes only that room UI state');
  };
  const runSettingsPanel=async()=>{
    finishOpening();for(let i=0;i<20;i++)await new Promise(setImmediate);await open();
    await input().fill('设置浮层滚动时保留这份聊天草稿');await input().evaluate(node=>{node.__settingsPanelInput=true;node.setSelectionRange(3,8);});
    await page.getByRole('button',{name:'聊天室设置',exact:true}).click();
    const panel=dialog().getByRole('region',{name:'聊天室设置',exact:true}),body=panel.locator('.dsh-persona-chat-settings-body');
    const address=panel.getByRole('textbox',{name:'角色怎么称呼你',exact:true}),effort=panel.getByRole('combobox',{name:'聊天室思考强度',exact:true});
    await page.waitForFunction(()=>!document.querySelector('[aria-label="角色怎么称呼你"]')?.disabled);
    await address.fill('阿晴👩‍💻');await panel.getByRole('button',{name:'保存称呼',exact:true}).click();await panel.getByText('称呼已保存。',{exact:true}).waitFor();
    await effort.selectOption('high');await page.waitForFunction(()=>!document.querySelector('[data-persona-shell="chat-thinking"]')?.textContent.includes('正在保存'));
    assert.equal((await owner('settings')).settings.chatReasoningEffort,'high');
    await panel.getByLabel('用户头像显示').selectOption('hidden');assert.equal((await owner('chat-profile')).userAddress,'阿晴👩‍💻');
    const geometry=[];
    for(const [width,dark]of[[1100,false],[1100,true],[390,false],[390,true]]){
      await page.setViewportSize({width,height:850});await page.evaluate(value=>document.documentElement.dataset.theme=value?'dark':'light',dark);
      await body.evaluate(node=>node.scrollTop=0);await body.hover();await page.mouse.wheel(0,600);await page.waitForFunction(()=>document.querySelector('.dsh-persona-chat-settings-body')?.scrollTop>0);
      for(const fraction of[.2,.6,1]){
        await body.evaluate((node,value)=>node.scrollTop=(node.scrollHeight-node.clientHeight)*value,fraction);await page.evaluate(()=>new Promise(requestAnimationFrame));
        const measured=await inspectSettingsPanel();assert.ok(measured.bodyOverflowSize>10,'this is a genuinely long settings body');geometry.push({width,dark,fraction,...measured});
      }
      await capture('room-settings-fixed-header-'+width+'-'+(dark?'dark':'light'),width,dark);
      assert.equal(await address.inputValue(),'阿晴👩‍💻');assert.equal(await effort.inputValue(),'high');assert.equal(calls.length,0);assert.equal(judgements.length,0);
    }
    await panel.getByRole('button',{name:'收起设置',exact:true}).click();
    assert.equal(await input().inputValue(),'设置浮层滚动时保留这份聊天草稿');
    assert.equal(await input().evaluate(node=>node.__settingsPanelInput),true,'the panel never replaces the chat composer');
    assert.deepEqual(await input().evaluate(node=>[node.selectionStart,node.selectionEnd]),[3,8]);
    await page.getByRole('button',{name:'聊天室设置',exact:true}).click();await address.waitFor();
    assert.equal(await address.inputValue(),'阿晴👩‍💻');assert.equal(await effort.inputValue(),'high');
    await panel.getByRole('button',{name:'收起设置',exact:true}).click();
    assert.equal(calls.length,0);assert.equal(contextSelections.length,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    const result={result:'passed-settings-panel',calls:0,judgements:0,pageErrors:errors,geometry};
    if(values.output){mkdirSync(values.output,{recursive:true});const {writeFileSync}=await import('node:fs');writeFileSync(path.join(values.output,'checks.json'),JSON.stringify(result,null,2));}
    console.log(JSON.stringify({result:result.result,calls:0,judgements:0,pageErrors:errors,geometryChecks:geometry.length}));
  };
  if(values['settings-panel-only'])await runSettingsPanel();
  else if(values['ui-only']){finishOpening();for(let i=0;i<20;i++)await new Promise(setImmediate);await runContinuity();await runMessageTimes();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(JSON.stringify({result:'passed-ui',calls:calls.length,judgements:judgements.length,contextSelections:contextSelections.length,pageErrors:errors}));}else{
  assert.equal(calls.length,0);assert.deepEqual(sourceReads,[]);assert.equal(contextSelections.length,0);
  await page.getByRole('button',{name:'插件设置',exact:true}).click();await page.locator('.dsh-persona-preset[data-active=true]').waitFor();
  assert.equal(routeReads.some(r=>r.path.includes('/chat-context')||r.path.endsWith('/chat')),false);
  await page.getByRole('tab',{name:'聊天室',exact:true}).click();
  assert.equal(routeReads.some(r=>r.path.endsWith('/chat-references')),false,'the collapsed settings panel is lazy');
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
  assert.deepEqual(sourceReads,['work']);assert.equal(calls.length,0);assert.equal(contextSelections.length,0,'opening does not select a work context');assert.equal(judgements.length,0,'opening never judges whether listeners should join');
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
  // Layout contract of a host Markdown code block. The leaf's own CSS and
  // sticky header must still work when painted inside a real room and panel.
  const body=page.locator('.dsh-persona-chat-body').first();
  await body.evaluate(el=>{
    const block=document.createElement('div');block.id='fixture-code-card';
    block.innerHTML='<style>.fixture-code-banner{position:sticky;top:0;z-index:6;display:flex;align-items:center;justify-content:space-between}.fixture-code-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;padding:0}</style>'
      +'<div class="fixture-code-banner">代码<button class="fixture-code-action" aria-label="复制代码样本"><svg width="14" height="14"></svg></button></div><pre><code>npm install</code></pre>';
    el.appendChild(block);
  });
  const codeAction=page.getByRole('button',{name:'复制代码样本'});
  assert.ok(await codeAction.locator('svg').evaluate(svg=>svg.getBoundingClientRect().width>=14),'room buttons must not squeeze the host icon');
  await codeAction.scrollIntoViewIfNeeded();await members();
  const panel=page.getByRole('region',{name:'管理聊天室',exact:true});
  assert.equal(await panel.evaluate(el=>{
    const p=el.getBoundingClientRect(), b=document.querySelector('.fixture-code-banner').getBoundingClientRect();
    const left=Math.max(p.left,b.left), right=Math.min(p.right,b.right), top=Math.max(p.top,b.top), bottom=Math.min(p.bottom,b.bottom);
    return left<right && top<bottom && el.contains(document.elementFromPoint((left+right)/2,(top+bottom)/2));
  }),true,'where the code banner and member panel overlap, the panel receives the click');
  await panel.getByRole('button',{name:'收起面板'}).click();
  await page.locator('#fixture-code-card').evaluate(el=>el.remove());
  const beforeTarget=calls.length;await input().fill('换人时保留的草稿');await target('大肥龙');assert.equal(calls.length,beforeTarget);assert.equal(await input().inputValue(),'换人时保留的草稿');
  assert.equal(replies((await state()).room).length,1);

  await send('房间内接力');await settled();
  const shared=readChatInput(calls.at(-1));
  assert.equal(shared.history[0].recipient?.id??shared.history[0].responses[0].speaker.id,'大肥鱼（默认）');assert.equal(shared.speaker.id,'大肥龙');assert.equal(shared.participants.length,3);
  assert.deepEqual(replies((await state()).room).map(t=>t.recipientId),['大肥鱼（默认）','大肥龙']);
  assert.equal(await page.locator('[data-chat-turn]').first().locator('[data-user=false] [aria-label="大肥鱼（默认）头像"]').count(),1,'the historical speaker portrait appears only on the first segment');
  assert.equal(await page.locator('[data-chat-turn]').first().locator('[data-chat-bubble="1"][data-chat-continuation="true"] .dsh-persona-chat-avatar-spacer[aria-hidden="true"]').count(),1);
  await capture('room-shared-history-light');await capture('room-shared-history-mobile',390);await capture('room-shared-history-dark',1100,true);

  await toggleTarget('大肥鱼（默认）');assert.equal(await recipients.getByRole('checkbox',{checked:true}).count(),2);
  assert.equal(await recipients.getByRole('checkbox',{name:'大肥龙',exact:true}).locator('[data-order]').getAttribute('data-order'),'1');
  await send('反序点名');await settled();
  const reverse=calls.slice(-2).map(c=>readChatInput(c));
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
  assert.equal(calls.length,beforeMulti+4);assert.ok(calls.slice(beforeMulti+2).every(c=>readChatInput(c).speaker.id==='大肥龙'));
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'多人回复重试'}).count(),1);
  await capture('room-multi-mentions-light');await capture('room-multi-mentions-mobile',390);
  const beforeCooperation=calls.length;
  failStreams=1;const beforeReconnect=liveConnections.length;
  await send('多人流式');await page.getByText('大肥鱼（默认） 流式开头',{exact:true}).waitFor();
  assert.ok(liveConnections.length>=beforeReconnect+2,'the partial text resumes on a reopened room stream before the model finishes');
  const streamingRoom=(await state()).room,currentStream=streamingRoom.turns.filter(turn=>turn.messageId===streamingRoom.turns.at(-1).messageId);
  assert.equal(currentStream.filter(turn=>turn.phase==='anchor').length,1);assert.equal(currentStream.filter(turn=>turn.status==='pending').length,1,'the director constructs only the next actual speaker seat');
  assert.equal(calls.length,beforeCooperation+1,'only the first primary starts while later speakers wait');
  assert.equal(await page.locator('.dsh-persona-chat-typing [aria-label="大肥龙头像"]').count(),0,'a queued primary does not pretend to type');
  assert.equal(await page.getByText('大肥龙 流式开头',{exact:true}).count(),0);
  const firstPrimaryRelease=gates.shift();assert.equal(typeof firstPrimaryRelease,'function');firstPrimaryRelease();
  await page.getByText('大肥龙 流式开头',{exact:true}).waitFor();assert.equal(calls.length,beforeCooperation+2);
  const secondPrimary=readChatInput(calls.at(-1));
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
  assert.deepEqual(await page.evaluate(()=>{window.orderObserver.disconnect();return window.badOrder;}),[],JSON.stringify({orderCalls:calls.map(call=>readChatInput(call)).filter(body=>body.message==='气泡顺序').map(body=>body.speaker.id),targets:(await state()).room.targetPersonaIds,turns:(await state()).room.turns.slice(-3).map(turn=>({id:turn.id,recipient:turn.recipientId,emitted:turn.emittedOrder,status:turn.status}))}));
  const orderedTurns=(await state()).room.turns.slice(-2);
  for(const turn of orderedTurns){
    const row=page.locator('[data-chat-turn="'+turn.id+'"]');
    assert.equal(await row.locator('[data-user=false] .dsh-persona-chat-avatar').count(),1,'each actual speaker starts a distinct identity group');
    assert.equal(await row.locator('.dsh-persona-chat-speaker').count(),1);
    assert.deepEqual(await row.locator('[data-chat-bubble]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.chatBubble))),turn.assistant.map((_,index)=>index));
    assert.equal(await row.locator('[data-chat-continuation="true"]').count(),Math.max(0,turn.assistant.length-1));
  }

  reactionSelections.set('旁听成员参与一下',['Claude小姐']);
  const beforeReaction=calls.length,beforeJudgement=judgements.length;
  await send('旁听成员参与一下');await page.getByText('先保留原文依据，再决定怎么整理。',{exact:true}).waitFor();await settled();
  const reactionState=await state(),reactionGroup=reactionState.room.turns.slice(-3);
  assert.equal(calls.length,beforeReaction+3);assert.equal(judgements.length,beforeJudgement+3,'each next speaker is directed once; an exhausted scene does not need an extra stop judgment');
  assert.deepEqual(reactionGroup.map(turn=>turn.phase),['reaction','reaction','reaction']);
  assert.deepEqual(reactionGroup.map(turn=>turn.recipientId),['大肥鱼（默认）','大肥龙','Claude小姐']);
  assert.equal(new Set(reactionGroup.map(turn=>turn.messageId)).size,1);
  assert.ok(reactionGroup.every(turn=>turn.recipients.map(person=>person.id).join('|')==='大肥鱼（默认）|大肥龙'));
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'旁听成员参与一下'}).count(),1);
  assert.equal(await page.locator('[data-user=true]').filter({hasText:'旁听成员参与一下'}).locator('.dsh-persona-chat-mentions').textContent(),'@大肥鱼（默认） @大肥龙');
  assert.deepEqual(reactionState.room.targetPersonaIds,['大肥鱼（默认）','大肥龙']);
  assert.equal(await recipients.getByRole('checkbox',{checked:true}).count(),2);
  const reactionPrompt=readChatInput(calls.at(-1));
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
  const preparing=page.getByRole('button',{name:'发送',exact:true});await preparing.waitFor();
  assert.equal(await preparing.isDisabled(),true,'a queued durable send cannot be submitted a second time after reopening');
  assert.equal(await input().inputValue(),'','the accepted input is already durable in its transport buffer');
  await dialog().locator('[data-queued-input]').filter({hasText:'普通文本回复'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'停止回复',exact:true}).count(),0,'the pending write has no reply to stop');
  assert.equal((await state()).room.turns.length,0);
  releaseChatWrite();await page.getByText('第二个气泡。',{exact:true}).waitFor();await settled();
  assert.equal(counts.get('普通文本回复'),1,'reopening a pending send does not submit it again');
  assert.equal(await page.getByText('NEVER_SHOW_REASONING',{exact:true}).count(),0);
  assert.equal(replies((await state()).room).length,1);
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
  assert.equal(await typing.locator('.dsh-persona-chat-avatar-spacer[aria-hidden="true"]').count(),1,'typing after a visible segment continues the same speaker group');
  assert.equal(await typing.locator('.dsh-persona-chat-avatar').count(),0);
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
  const beforeSettingsDraft=await input().inputValue();await input().fill('设置面板关闭后仍保留的草稿');
  await page.getByRole('button',{name:'聊天室设置',exact:true}).click();
  await dialog().getByRole('checkbox',{name:'开启聊天室思考',exact:true}).waitFor();
  await dialog().getByRole('textbox',{name:'角色怎么称呼你',exact:true}).fill('阿晴');
  await dialog().getByRole('button',{name:'保存称呼',exact:true}).click();
  await dialog().getByText('称呼已保存。',{exact:true}).waitFor();
  assert.equal((await owner('chat-profile')).userAddress,'阿晴');
  await dialog().getByLabel('用户头像显示').selectOption('hidden');
  await page.waitForFunction(()=>!document.querySelector('[data-user=true] img'));
  assert.equal((await owner('chat-profile')).userAddress,'阿晴','avatar display changes do not clear the shared chat address');
  await capture('room-chat-settings-light');await capture('room-chat-settings-mobile-dark',390,true);
  await inspectSettingsPanel();
  await page.setViewportSize({width:1100,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.getByRole('button',{name:'收起设置',exact:true}).click();assert.equal(calls.length,beforeProfile);
  assert.equal(await input().inputValue(),'设置面板关闭后仍保留的草稿');await input().fill(beforeSettingsDraft);

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
  assert.equal(await recipients.getByRole('checkbox',{disabled:true}).count(),0,'all eight participants remain selectable');
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
  assert.deepEqual(group.map(t=>t.status),['ready','cancelled']);assert.equal(group[0].phase,'anchor');assert.equal(calls.length,beforeEight+1);
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
  for(let tick=0;tick<200&&!gates.length;tick++)await new Promise(resolve=>setTimeout(resolve,5));
  {const waiting=await state(),director=readChatInput(contextSelections.at(-1));
    assert.equal(typeof gates[0],'function',JSON.stringify({reason:'the director starts the next actor after the first complete answer',running:waiting.running,phase:waiting.roundPhase,failure:waiting.directorFailure,targets:waiting.room.targetPersonaIds,turns:waiting.room.turns.map(turn=>({id:turn.id,status:turn.status,actor:turn.recipientId,failure:turn.failure})),director}));}
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
  // Broadcast gives all eight members a fresh ordinary budget; a real peer call
  // can use each independent one-shot opportunity, reaching the hard frame cap.
  const beforeThirtyTwo=calls.length,savedTargets=[...(await state()).room.targetPersonaIds];
  for(const name of await recipients.getByRole('checkbox',{checked:true}).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))))await toggleTarget(name);
  await recipients.getByText('发给房间',{exact:true}).waitFor();await send('满员续聊三十二席');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-provisional=true] .dsh-persona-chat-body')].some(node=>node.textContent==='第三十二席正在输入'),{},{timeout:20000});
  const cappedState=await state(),cappedMessage=cappedState.room.turns.at(-1).messageId,capped=cappedState.room.turns.filter(turn=>turn.messageId===cappedMessage),actualReplies=replies(cappedState.room).filter(turn=>turn.messageId===cappedMessage);
  assert.equal(capped.length,33);assert.equal(capped[0].phase,'anchor');assert.equal(actualReplies.length,32);assert.equal(calls.length,beforeThirtyTwo+32);
  assert.deepEqual(actualReplies.map(turn=>turn.emittedOrder),Array.from({length:32},(_,index)=>index));
  assert.equal(actualReplies.filter(turn=>turn.responsePlan.kind==='normal').length,24);assert.equal(actualReplies.filter(turn=>turn.responsePlan.kind==='peer').length,8);
  assert.equal(actualReplies.slice(0,31).every(turn=>turn.status==='ready'),true);
  const scheduled=actualReplies.reduce((counts,turn)=>({...counts,[turn.recipientId]:(counts[turn.recipientId]??0)+1}),{});assert.equal(Math.max(...Object.values(scheduled)),4);
  assert.deepEqual(cappedState.room.targetPersonaIds,[]);assert.ok(capped.every(turn=>turn.recipients.length===0));
  assert.equal(await page.locator('[data-chat-turn="'+actualReplies.at(-1).id+'"] [data-chat-bubble="0"] .dsh-persona-chat-body').textContent(),'第三十二席正在输入','the last allowed seat is received live before its model finishes');
  await capture('room-thirty-two-seat-live-mobile',320);await assertMembersFit();
  await send('第三十二席时我补一句');for(const release of gates.splice(0))release();await settled();
  assert.match(await page.getByLabel('聊天消息').innerText(),/第三十二席正在输入，把这句说完整。/,'new input does not cut off the active persona answer');
  assert.equal(counts.get('满员续聊三十二席'),32,'the previous user cycle cannot exceed its exact opportunity budget');
  assert.equal((await state()).room.turns.filter(turn=>turn.messageId===cappedMessage).at(-1).status,'ready');
  for(const id of savedTargets)await toggleTarget((await state()).contacts.find(person=>person.id===id).name);
  await input().fill('还原时应保留的草稿');await input().evaluate(e=>e.setSelectionRange(2,4));
  await minimizeButton.click();await dock.waitFor();assert.equal(await restore.getAttribute('aria-label'),'还原聊天室','restoring cleared unread');
  await open();assert.equal(await input().inputValue(),'还原时应保留的草稿','workspace launcher restores the same draft');
  await minimizeButton.click();await dock.getByRole('button',{name:'关闭聊天室',exact:true}).click();await dock.waitFor({state:'detached'});
  await open();await send('多人流式');
  await page.waitForFunction(()=>document.querySelector('[data-provisional=true] .dsh-persona-chat-body')?.textContent.includes('流式开头'));
  await minimizeButton.click();await dock.waitFor();
  const missing=page.waitForResponse(r=>new URL(r.url()).pathname==='/persona-shell/chat'&&r.status()===404);
  const removing=await state();await owner('chat-rooms',{action:'delete',roomId:dockRoom,epoch:removing.epoch,revision:removing.room.revision});
  await missing;assert.equal(await dialog().count(),0,'removing a room elsewhere must not reopen a minimized window');
  await restore.click();await page.getByRole('region',{name:'聊天室列表',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  for(const release of gates.splice(0))release();
  await open();await members();
  await page.getByRole('checkbox',{name:'成员 大肥鱼（默认）',exact:true}).check();
  await page.getByRole('checkbox',{name:'成员 大肥龙',exact:true}).check();
  for(const checkbox of await page.getByRole('region',{name:'管理聊天室',exact:true}).getByRole('checkbox',{checked:true}).all()){
    if(!['成员 大肥鱼（默认）','成员 大肥龙'].includes(await checkbox.getAttribute('aria-label')))await checkbox.uncheck();
  }
  await page.getByRole('button',{name:'保存聊天室',exact:true}).click();await page.getByRole('region',{name:'管理聊天室',exact:true}).waitFor({state:'hidden'});
  await target('大肥鱼（默认）');await toggleTarget('大肥龙');
  await send('接一句试试');await page.getByText('设置页，就先这一页。',{exact:true}).waitFor();await settled();
  assert.deepEqual(replies((await state()).room).slice(-3).map(t=>t.responsePlan.to),['user','user','大肥龙']);
  await send('接话时我有新想法');await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-chat-turn]')).at(-1)?.querySelector('.dsh-persona-chat-typing'));
  await input().fill('我先补一个新的想法');const sendNow=page.getByRole('button',{name:'发送',exact:true});await sendNow.waitFor();
  await sendNow.click();for(const release of gates.splice(0))release();await settled();
  assert.equal(await input().inputValue(),'');
  assert.match(await page.getByLabel('聊天消息').innerText(),/先把这句接话说完整。/,'the already active persona completes before the next input batch');
  assert.equal(replies((await state()).room).filter(t=>t.user==='我先补一个新的想法'&&t.responsePlan.to==='user').length,2);
  // Quote a specific committed bubble while preserving both the draft and @ choices.
  const quoteState=await state(),sourceTurn=quoteState.room.turns.filter(t=>t.recipientId==='大肥鱼（默认）'&&t.status==='ready').at(-1);
  assert.ok(sourceTurn.assistant.length>=2,'the quote exercise uses a continuation rather than the first segment');
  const sourceRow=page.locator('[data-chat-turn]').filter({has:page.locator('[data-chat-bubble]')}).filter({hasText:sourceTurn.assistant[0]}).last();
  await input().fill('这是尚未发送的文字');await sourceRow.locator('[data-chat-bubble="1"]').hover();
  await sourceRow.getByRole('button',{name:'引用大肥鱼（默认）的第2条消息',exact:true}).click();
  await page.getByLabel('正在引用的消息',{exact:true}).waitFor();assert.equal(await input().inputValue(),'这是尚未发送的文字');
  assert.deepEqual((await state()).room.targetPersonaIds,quoteState.room.targetPersonaIds);
  await page.getByRole('button',{name:'取消引用',exact:true}).click();assert.equal(await input().inputValue(),'这是尚未发送的文字');
  await sourceRow.locator('[data-chat-bubble="1"]').hover();await sourceRow.getByRole('button',{name:'引用大肥鱼（默认）的第2条消息',exact:true}).click();
  await input().press('Escape');assert.equal(await dialog().count(),1,'Esc cancels the quote before closing the room');
  assert.equal(await page.getByLabel('正在引用的消息',{exact:true}).count(),0);assert.equal(await input().inputValue(),'这是尚未发送的文字');
  await sourceRow.locator('[data-chat-bubble="1"]').hover();await sourceRow.getByRole('button',{name:'引用大肥鱼（默认）的第2条消息',exact:true}).click();
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();await open();
  assert.equal(await page.getByLabel('正在引用的消息',{exact:true}).count(),1,'quote draft survives reopening');
  await capture('room-quoted-draft-mobile',390,true);await capture('room-quoted-draft-desktop',1100,false);
  failChatSave=true;const failedQuotedSend=page.waitForResponse(r=>new URL(r.url()).pathname==='/persona-shell/chat'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const failedQuoteResponse=await failedQuotedSend;assert.equal(failedQuoteResponse.status(),200,await failedQuoteResponse.text());
  const failedQuotedInput=dialog().locator('[data-queued-input]').filter({hasText:'这是尚未发送的文字'});
  await failedQuotedInput.getByRole('button',{name:'重试这组消息',exact:true}).waitFor();
  assert.ok((await failedQuotedInput.innerText()).includes(sourceTurn.assistant[1]),'the durable failed input retains its exact quoted source');
  assert.equal(await page.getByLabel('正在引用的消息',{exact:true}).count(),0);
  await failedQuotedInput.getByRole('button',{name:'重试这组消息',exact:true}).click();await settled();
  assert.equal(await input().inputValue(),'');assert.equal(await page.getByLabel('正在引用的消息',{exact:true}).count(),0);
  const quotedCall=calls.find(c=>readChatInput(c).message==='这是尚未发送的文字');
  assert.equal(readChatInput(quotedCall).quotedMessage.text,sourceTurn.assistant[1]);
  assert.equal((await state()).room.turns.find(turn=>turn.user==='这是尚未发送的文字').quote.ref.index,1,'continuation grouping keeps the original persisted quote index');
  await page.getByRole('button',{name:'查看引用原消息',exact:true}).click();
  assert.equal(await page.locator('.dsh-persona-chat-quoted-highlight').count(),1);
  const longOriginal='这里要保留引用的完整原话。'.repeat(80)+'\n最后一行也应该能查看。';
  await send(longOriginal);await settled();
  const longUser=page.locator('[data-user=true]').filter({hasText:longOriginal});await longUser.hover();
  await longUser.getByRole('button',{name:'引用我的消息',exact:true}).click();await input().fill('继续编辑引用草稿');
  const longQuote=page.getByLabel('正在引用的消息',{exact:true}),beforeQuoteCalls=calls.length;
  await longQuote.getByRole('button',{name:'展开引用全文',exact:true}).click();
  assert.equal(await longQuote.getByRole('button',{name:'收起引用全文',exact:true}).getAttribute('aria-expanded'),'true');
  assert.equal(await longQuote.getByLabel('引用原话全文',{exact:true}).innerText(),longOriginal);
  await capture('room-quote-expanded-mobile',390,true);
  await page.setViewportSize({width:390,height:620});
  const sendBox=await page.getByRole('button',{name:'发送',exact:true}).boundingBox();assert.ok(sendBox.y+sendBox.height<=620);
  await longQuote.getByRole('button',{name:'查看引用原消息',exact:true}).click();
  assert.match(await page.locator('.dsh-persona-chat-quoted-highlight').innerText(),/最后一行也应该能查看/);
  await page.keyboard.press('Escape');assert.equal(await dialog().count(),1);
  assert.equal(await input().inputValue(),'继续编辑引用草稿');assert.equal(await longQuote.count(),0);assert.equal(calls.length,beforeQuoteCalls);
  await input().fill('');await page.setViewportSize({width:1100,height:850});
  // Draft preparation is explicit, room-scoped, editable and never sends a task itself.
  // This section deliberately exercises the opt-in dialog after the default-on chat checks above.
  await owner('settings',{chatThinking:false});
  assert.equal(routeReads.some(r=>r.path==='/persona-shell/chat-work-draft'),false,'the work draft endpoint stays untouched until the user opens it');
  const beforeWorkDraft=calls.length,beforeDraftSourceReads=sourceReads.length;
  failWorkRead=true;await page.getByRole('button',{name:'整理工作指令',exact:true}).click();
  const workDraft=page.getByRole('region',{name:'工作指令草稿',exact:true});
  const continueThinking=async(enabled=false)=>{const options=workDraft.getByRole('group',{name:'本次结论思考设置',exact:true});
    await options.waitFor();await options.getByRole('button',{name:enabled?'开启思考并继续':'保持关闭并继续',exact:true}).click();};
  await workDraft.getByText('暂时无法读取原话，草稿保留。请重试。',{exact:true}).waitFor();
  await workDraft.getByRole('button',{name:'刷新可选原话',exact:true}).click();
  await workDraft.getByRole('searchbox',{name:'筛选整理原话',exact:true}).waitFor();
  await workDraft.getByRole('searchbox',{name:'筛选整理原话',exact:true}).fill('这里要保留引用的完整原话');
  await workDraft.getByRole('checkbox').first().check();
  await workDraft.getByRole('textbox',{name:'工作指令整理要求',exact:true}).fill('整理成可以交给工作助手的指令，未确定的细节列为待确认。');
  assert.equal(calls.length,beforeWorkDraft);assert.equal(sourceReads.length,beforeDraftSourceReads);
  failWorkGenerate=true;await workDraft.getByRole('button',{name:'整理草稿',exact:true}).click();
  await continueThinking(false);
  await workDraft.getByText('这次未能整理完成，要求、选择和已有草稿都保留，可以重试。',{exact:true}).waitFor();
  assert.equal(await workDraft.getByRole('checkbox',{checked:true}).count(),1);
  await workDraft.getByRole('button',{name:'整理草稿',exact:true}).click();
  await continueThinking(false);
  const workOutput=workDraft.getByRole('textbox',{name:'可编辑的工作指令草稿',exact:true});
  await page.waitForFunction(()=>document.querySelector('[aria-label="可编辑的工作指令草稿"]')?.value.includes('待确认'));
  assert.equal(calls.length,beforeWorkDraft+1);assert.equal(sourceReads.length,beforeDraftSourceReads);
  const workCall=calls.at(-1),workPayload=readChatInput(workCall);
  assert.equal(workPayload.task,'work-instruction-draft');assert.doesNotMatch(JSON.stringify(workCall),/WORK_ONLY_DO_NOT_READ/);
  await workOutput.fill('这是我编辑后的工作指令，请先画草图。');
  await workDraft.getByRole('button',{name:'整理草稿',exact:true}).click();
  await workDraft.getByRole('button',{name:'保留当前草稿',exact:true}).click();assert.equal(calls.length,beforeWorkDraft+1);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.lastCopiedWorkDraft=text;}}}));
  await workDraft.getByRole('button',{name:'复制草稿',exact:true}).click();
  await workDraft.getByText('已复制工作指令草稿；尚未发送到工作会话。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.lastCopiedWorkDraft),'这是我编辑后的工作指令，请先画草图。');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('blocked');}}}));
  await workDraft.getByRole('button',{name:'复制草稿',exact:true}).click();
  await workDraft.getByText('复制未完成，已选中文本，请按 Ctrl+C 或长按复制。',{exact:true}).waitFor();
  assert.equal(await workOutput.evaluate(el=>el.selectionEnd-el.selectionStart),(await workOutput.inputValue()).length);
  const panelBox=await workDraft.boundingBox(),closeDraftBox=await workDraft.getByRole('button',{name:'收起指令草稿',exact:true}).boundingBox();
  assert.ok(closeDraftBox.y>=panelBox.y&&closeDraftBox.y+closeDraftBox.height<=panelBox.y+panelBox.height,'the work draft close action remains visible while editing a scrolled result');
  assert.equal(await workDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).isEnabled(),false,'an existing native draft is never overwritten');
  await capture('room-work-draft-mobile-dark',390,true);await capture('room-work-draft-desktop-light',1100,false);
  await workDraft.getByRole('button',{name:'收起指令草稿',exact:true}).click();await page.getByRole('button',{name:'整理工作指令',exact:true}).click();
  assert.equal(await workOutput.inputValue(),'这是我编辑后的工作指令，请先画草图。');
  await page.evaluate(()=>window.setNativeWorkInput(''));await workDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).waitFor({state:'visible'});
  delayWorkValidate=true;const validateEntered=new Promise(resolve=>{enteredWorkValidate=resolve;});
  await workDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).click();await validateEntered;
  await page.evaluate(()=>window.setNativeWorkInput('验证期间刚输入的内容'));releaseWorkValidate();
  await workDraft.getByText('工作会话或输入框已变化，没有填入。草稿保留，可重新核对或复制。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeFills),0);assert.equal(await page.getByLabel('工作会话输入',{exact:true}).inputValue(),'验证期间刚输入的内容');
  await page.evaluate(()=>window.setNativeWorkInput(''));await workDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).click();
  await workDraft.getByText('已填入工作会话输入框，请在工作区检查后发送。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeFills),1);assert.equal(await page.evaluate(()=>window.nativePersists),1);
  assert.equal(await page.getByLabel('工作会话输入',{exact:true}).inputValue(),'这是我编辑后的工作指令，请先画草图。');
  await page.evaluate(()=>window.setNativeWorkInput(''));
  delayWorkValidate=true;const attachmentCheck=new Promise(resolve=>{enteredWorkValidate=resolve;});
  await workDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).click();await attachmentCheck;
  await page.evaluate(()=>window.setNativeWorkMeta({attachmentIds:['new-attachment-without-draft-revision']}));releaseWorkValidate();
  await workDraft.getByText('工作会话或输入框已变化，没有填入。草稿保留，可重新核对或复制。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeFills),1,'attachment changes cannot be bypassed by an unchanged text revision');
  await page.evaluate(()=>{window.setNativeWorkMeta({attachmentIds:[]});window.switchWorkSession('work');});
  await page.evaluate(()=>window.setNativeWorkInput(''));
  delayWorkValidate=true;const targetCheck=new Promise(resolve=>{enteredWorkValidate=resolve;});
  await workDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).click();await targetCheck;
  await page.evaluate(()=>window.switchWorkSession('other'));releaseWorkValidate();
  await workDraft.getByText('工作会话或输入框已变化，没有填入。草稿保留，可重新核对或复制。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeFills),1,'switching foreground session during validation cannot reroute a draft');
  await workDraft.getByRole('textbox',{name:'工作指令整理要求',exact:true}).fill('慢指令整理');
  await workDraft.getByRole('button',{name:'整理草稿',exact:true}).click();await workDraft.getByRole('button',{name:'确认重新整理',exact:true}).click();
  await continueThinking(false);
  await workDraft.getByRole('button',{name:'停止整理',exact:true}).waitFor();await workDraft.getByRole('button',{name:'停止整理',exact:true}).click();
  for(const release of gates.splice(0))release();assert.equal(await workOutput.inputValue(),'这是我编辑后的工作指令，请先画草图。');
  await workOutput.press('Escape');assert.equal(await workDraft.count(),0);assert.equal(await dialog().count(),1);
  // Age a topic out of the complete recent history, then inspect its exact source in settings.
  const refRoom=(await state()).room.id,refContext=await owner('chat-context',{action:'open',roomId:refRoom,viewer:'reference-test',sequence:1,sessionId:'other'});
  const sendDirect=async(content,id)=>{const s=await state();await owner('chat',{action:'send',roomId:refRoom,personaId:s.room.targetPersonaId,
    recipientIds:s.room.targetPersonaIds,requestId:id,content,revision:s.room.revision,epoch:s.epoch,contextKey:refContext.id+':'+refContext.revision});
    for(let i=0;i<50&&(await state()).running;i++)await new Promise(setImmediate);};
  await sendDirect('设置布局先画草图，我还没决定。','reference-origin');
  for(let i=0;i<9;i++)await sendDirect('接着聊另一个话题'+i,'reference-age-'+i);
  await owner('memory',{action:'add',entry:{kind:'preference',scope:'persona',personaId:'大肥鱼（默认）',content:'WHALE_PRIVATE_REFERENCE'}});
  await owner('memory',{action:'add',entry:{kind:'preference',scope:'persona',personaId:'大肥龙',content:'DRAGON_PRIVATE_REFERENCE'}});
  await sendDirect('设置布局就按草图方案确定吧。','discussion-confirmation');
  await sendDirect('设置布局的草图还记得吗？','reference-recall');
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  await owner('chat-context',{action:'presence',roomId:refRoom,viewer:'reference-test',sequence:2,visible:false});
  const beforeReferenceCalls=calls.length,beforeReferenceReads=sourceReads.length;
  await page.getByRole('button',{name:'插件设置',exact:true}).click();await page.getByRole('tab',{name:'聊天室',exact:true}).click();
  await page.locator('[data-settings-fold="room-references"]>summary').click();
  const referencePanel=page.getByRole('region',{name:'房间参考信息',exact:true});
  await referencePanel.getByRole('combobox',{name:'选择房间参考记录',exact:true}).waitFor();
  const referenceData=await owner('chat-references?room='+encodeURIComponent(refRoom));
  const origin=referencePanel.getByRole('region',{name:'本次回复归属',exact:true});
  assert.match(await origin.innerText(),/设置布局的草图还记得吗/);
  assert.ok((await origin.innerText()).includes('当时点名：'+referenceData.records[0].request.recipients.map(p=>'@'+p.name).join(' ')));
  assert.match(await referencePanel.getByRole('region',{name:'本次人格偏好',exact:true}).innerText(),/DRAGON_PRIVATE_REFERENCE/);
  assert.doesNotMatch(await referencePanel.getByRole('region',{name:'本次人格偏好',exact:true}).innerText(),/WHALE_PRIVATE_REFERENCE/);
  const fishRecord=referenceData.records.find(r=>r.personaId==='大肥鱼（默认）'&&r.messageId===referenceData.records[0].messageId);
  await referencePanel.getByRole('combobox',{name:'选择房间参考记录',exact:true}).selectOption(fishRecord.id);
  assert.match(await origin.innerText(),/回应用户/);
  assert.match(await referencePanel.getByRole('region',{name:'本次人格偏好',exact:true}).innerText(),/WHALE_PRIVATE_REFERENCE/);
  assert.doesNotMatch(await referencePanel.getByRole('region',{name:'本次人格偏好',exact:true}).innerText(),/DRAGON_PRIVATE_REFERENCE/);
  await referencePanel.getByRole('combobox',{name:'选择房间参考记录',exact:true}).selectOption(referenceData.records[0].id);
  assert.match(await origin.innerText(),/回应用户/);
  assert.match(await origin.innerText(),/本轮职责：先回应用户/);
  const discussion=referencePanel.getByRole('region',{name:'房间讨论状态',exact:true});
  await discussion.locator(':scope > details > summary').click();
  await discussion.getByRole('button',{name:'新增讨论条目',exact:true}).click();
  const originalChoice=referenceData.discussionChoices.find(q=>q.ref.kind==='user'&&q.text==='设置布局先画草图，我还没决定。');
  const confirmedChoice=referenceData.discussionChoices.find(q=>q.ref.kind==='user'&&q.text==='设置布局就按草图方案确定吧。');
  await discussion.getByRole('combobox',{name:'讨论原话来源',exact:true}).selectOption(JSON.stringify(originalChoice.ref));
  await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).fill('草图布局方案');
  await discussion.getByRole('combobox',{name:'讨论条目状态',exact:true}).selectOption('proposal');
  await referencePanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await referencePanel.getByRole('button',{name:'正在读取…',exact:true}).waitFor({state:'hidden'});
  assert.equal(await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).inputValue(),'草图布局方案','refresh preserves a local discussion draft');
  failChatSave=true;await discussion.getByRole('button',{name:'保存讨论条目',exact:true}).click();
  await referencePanel.getByText('暂时无法确认保存结果，请刷新核对后重试。编辑草稿仍保留。',{exact:true}).waitFor();
  assert.equal(await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).inputValue(),'草图布局方案');
  await discussion.getByRole('button',{name:'保存讨论条目',exact:true}).click();
  const topic=discussion.getByRole('article',{name:'讨论条目 草图布局方案',exact:true});await topic.waitFor();
  assert.equal(await discussion.getByRole('form',{name:'新增房间讨论',exact:true}).count(),0);
  await topic.getByRole('button',{name:'更正',exact:true}).click();
  await discussion.getByRole('combobox',{name:'讨论条目状态',exact:true}).selectOption('confirmed');
  assert.equal(await discussion.getByRole('button',{name:'保存讨论条目',exact:true}).isEnabled(),false,'a decision needs explicitly selected user evidence');
  await discussion.getByRole('combobox',{name:'讨论状态用户依据',exact:true}).selectOption(JSON.stringify(confirmedChoice.ref));
  await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).fill('设置页布局先走草图');
  await page.setViewportSize({width:390,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(values.output)await page.locator('[data-persona-shell="settings"]').screenshot({path:path.join(values.output,'room-discussion-editor-mobile-dark.png')});
  await page.setViewportSize({width:1100,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  if(values.output)await page.locator('[data-persona-shell="settings"]').screenshot({path:path.join(values.output,'room-discussion-editor-desktop-light.png')});
  await discussion.getByRole('button',{name:'保存讨论条目',exact:true}).click();
  await discussion.getByRole('article',{name:'讨论条目 设置页布局先走草图',exact:true}).waitFor();
  assert.match(await discussion.innerText(),/已确定/);
  await discussion.getByRole('button',{name:'撤销最近修改',exact:true}).click();await topic.waitFor();
  assert.match(await topic.innerText(),/候选方案/);
  await topic.getByRole('button',{name:'移除',exact:true}).click();await topic.getByRole('button',{name:'确认移除',exact:true}).click();
  await topic.waitFor({state:'hidden'});
  await discussion.getByRole('button',{name:'撤销最近修改',exact:true}).click();await topic.waitFor();
  await topic.getByRole('button',{name:'更正',exact:true}).click();
  await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).fill('正在编辑而未保存的标题');
  const externalBoard=await owner('chat-references?room='+encodeURIComponent(refRoom)),externalEntry=externalBoard.discussion.entries[0];
  await owner('chat-discussion',{roomId:refRoom,action:'update',id:externalEntry.id,version:externalEntry.version,discussionRevision:externalBoard.discussion.revision,
    epoch:externalBoard.epoch,title:'另一个页面核对过的标题',status:'proposal'});
  await discussion.getByRole('button',{name:'保存讨论条目',exact:true}).click();
  await referencePanel.getByText('房间讨论已变化，请刷新核对后再保存。编辑草稿仍保留。',{exact:true}).waitFor();
  await referencePanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await referencePanel.getByRole('button',{name:'正在读取…',exact:true}).waitFor({state:'hidden'});
  assert.equal(await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).inputValue(),'正在编辑而未保存的标题');
  await discussion.getByRole('button',{name:'取消编辑',exact:true}).click();
  await discussion.getByRole('article',{name:'讨论条目 另一个页面核对过的标题',exact:true}).waitFor();
  const notes=referencePanel.getByRole('region',{name:'本次旧话题原话',exact:true});
  for(const summary of await notes.getByText('查看出处',{exact:true}).all())await summary.click();
  assert.match(await notes.innerText(),/设置布局先画草图/);
  failChatSave=true;await notes.getByRole('button',{name:'暂停引用',exact:true}).first().click();
  await referencePanel.getByText('暂时无法确认修改结果，请刷新核对后重试。',{exact:true}).waitFor();
  await notes.getByRole('button',{name:'暂停引用',exact:true}).first().click();
  await referencePanel.getByText('已暂停自动旧话题引用；聊天原记录保留。',{exact:true}).waitFor();
  assert.equal((await owner('chat-references?room='+encodeURIComponent(refRoom))).excluded.length,1);
  failReferenceRead=true;await referencePanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await referencePanel.getByText('参考信息暂时无法读取，可以重试。',{exact:true}).waitFor();
  await referencePanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await referencePanel.getByRole('button',{name:'正在读取…',exact:true}).waitFor({state:'hidden'});
  const blankRoom=await owner('chat-rooms',{action:'create',requestId:'blank-reference-room',name:'不混用参考的房间',memberIds:['大肥鱼（默认）'],
    targetPersonaIds:['大肥鱼（默认）'],epoch:(await state()).epoch});
  await referencePanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await referencePanel.getByRole('combobox',{name:'查看房间参考',exact:true}).selectOption(blankRoom.room.id);
  await referencePanel.getByText('这个房间还没有参考使用记录。发送聊天后会在这里记录。',{exact:true}).waitFor();
  assert.doesNotMatch(await referencePanel.innerText(),/WHALE_PRIVATE_REFERENCE|DRAGON_PRIVATE_REFERENCE|设置布局先画草图|另一个页面核对过的标题|正在编辑而未保存的标题/);
  await referencePanel.getByRole('combobox',{name:'查看房间参考',exact:true}).selectOption(refRoom);
  await referencePanel.getByRole('region',{name:'本次人格偏好',exact:true}).waitFor();
  assert.equal((await state()).room.id,blankRoom.room.id,'inspecting another room never selects it as the active chat');
  await page.setViewportSize({width:390,height:850});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(calls.length,beforeReferenceCalls);assert.equal(sourceReads.length,beforeReferenceReads,'inspecting references never refreshes source sessions');
  if(values.output)await page.locator('[data-persona-shell="settings"]').screenshot({path:path.join(values.output,'room-references-mobile-dark.png')});
  await discussion.locator(':scope > details > summary').click();
  await discussion.getByRole('article',{name:'讨论条目 另一个页面核对过的标题',exact:true}).getByRole('button',{name:'更正',exact:true}).click();
  await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).fill('来源变化后保留的整理草稿');
  const currentReferenceContext=await owner('chat-context',{action:'presence',roomId:refRoom,viewer:'reference-invalidation',sequence:1,visible:true});
  await owner('chat-context',{action:'detach',roomId:refRoom,sessionId:'other',revision:currentReferenceContext.revision});
  await owner('chat-context',{action:'presence',roomId:refRoom,viewer:'reference-invalidation',sequence:2,visible:false});
  await referencePanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await referencePanel.getByRole('button',{name:'正在读取…',exact:true}).waitFor({state:'hidden'});
  assert.equal(await discussion.getByRole('textbox',{name:'讨论条目标题',exact:true}).inputValue(),'来源变化后保留的整理草稿');
  const staleEditor=discussion.getByRole('form',{name:'更正房间讨论',exact:true});
  assert.match(await staleEditor.innerText(),/这句原话已不可用/);
  assert.doesNotMatch(await staleEditor.textContent(),/设置布局先画草图，我还没决定/,'refresh never restores an editor snapshot from an old reference scope');
  assert.equal(await discussion.getByRole('button',{name:'保存讨论条目',exact:true}).isEnabled(),false);
  assert.equal(calls.length,beforeReferenceCalls);assert.equal(sourceReads.length,beforeReferenceReads);
  await page.getByRole('button',{name:'插件设置',exact:true}).click();
  await open();await chooseRoom((await owner('chat?room='+encodeURIComponent(refRoom))).room.name);
  await page.evaluate(()=>window.setNativeWorkInput(''));await page.getByRole('button',{name:'整理工作指令',exact:true}).click();
  const staleWorkDraft=page.getByRole('region',{name:'工作指令草稿',exact:true});
  assert.equal(await staleWorkDraft.getByRole('textbox',{name:'可编辑的工作指令草稿',exact:true}).inputValue(),'这是我编辑后的工作指令，请先画草图。');
  await staleWorkDraft.getByRole('button',{name:'填入当前工作输入框',exact:true}).click();
  await staleWorkDraft.getByText('原话依据已变化或暂不可核对，没有填入。请刷新后重新整理，也可以复制草稿。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeFills),1,'changing room reference scope prevents a stale draft from entering the work input');
  await staleWorkDraft.getByRole('button',{name:'收起指令草稿',exact:true}).click();await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  // Conclusions explicitly choose per-call thinking, then fill the fixed native target and minimize only on success.
  await owner('settings',{chatThinking:false});
  const conclusionRoom=await owner('chat-rooms',{action:'create',requestId:'conclusion-room',name:'结论流程验证',memberIds:['大肥鱼（默认）'],
    targetPersonaIds:['大肥鱼（默认）'],epoch:(await state()).epoch});
  await open();await chooseRoom(conclusionRoom.room.name);await send('下一步先画设置页草图，保留现有功能。');await settled();
  await page.getByRole('button',{name:'整理工作指令',exact:true}).click();
  const conclusion=page.getByRole('region',{name:'工作指令草稿',exact:true}),conclusionThinking=conclusion.getByRole('group',{name:'本次结论思考设置',exact:true});
  await conclusion.getByRole('searchbox',{name:'筛选整理原话',exact:true}).fill('下一步先画设置页草图');
  await conclusion.getByRole('checkbox').first().check();
  const conclusionOutput=conclusion.getByRole('textbox',{name:'可编辑的工作指令草稿',exact:true});
  const quick=()=>conclusion.getByRole('button',{name:'整理结论并填入',exact:true});
  const startQuick=async()=>{const hasDraft=!!(await conclusionOutput.inputValue()).trim();await quick().click();
    if(hasDraft)await conclusion.getByRole('button',{name:'确认重新整理',exact:true}).click();};
  const reopenConclusion=async()=>{await dock.getByRole('button',{name:/还原聊天室/}).click();await input().waitFor();
    if(!await conclusion.count())await page.getByRole('button',{name:'整理工作指令',exact:true}).click();};
  const fillsBeforeConclusions=await page.evaluate(()=>window.nativeFills),callsBeforeChoice=calls.length;
  await page.evaluate(()=>window.setNativeWorkInput(''));
  await startQuick();await conclusionThinking.waitFor();
  assert.equal(calls.length,callsBeforeChoice,'opening the thinking choice does not call a model');
  assert.equal(await conclusionThinking.getByRole('button',{name:'开启思考并继续',exact:true}).evaluate(el=>el===document.activeElement),true);
  await capture('room-conclusion-thinking-mobile-dark',390,true);await page.setViewportSize({width:1100,height:850});
  await page.keyboard.press('Escape');assert.equal(await conclusionThinking.count(),0);assert.equal(await conclusion.count(),1);
  assert.equal(calls.length,callsBeforeChoice,'Esc dismisses the choice without starting a call or closing the draft panel');
  await startQuick();await conclusionThinking.waitFor();
  await conclusionThinking.getByRole('button',{name:'取消本次整理',exact:true}).click();
  assert.equal(calls.length,callsBeforeChoice);assert.equal(await page.evaluate(()=>window.nativeFills),fillsBeforeConclusions);
  await startQuick();await conclusionThinking.getByRole('button',{name:'开启思考并继续',exact:true}).click();await dock.waitFor();
  assert.equal(await dialog().count(),0);assert.equal(await page.evaluate(()=>window.nativeFills),fillsBeforeConclusions+1);
  assert.match(await page.getByLabel('工作会话输入',{exact:true}).inputValue(),/待确认/);
  assert.equal(calls.at(-1).reasoningEffort,'low');assert.equal((await owner('settings')).settings.chatThinking,false);
  await reopenConclusion();await page.evaluate(()=>window.setNativeWorkInput(''));
  await startQuick();await conclusionThinking.getByRole('button',{name:'保持关闭并继续',exact:true}).click();await dock.waitFor();
  assert.equal(calls.at(-1).reasoningEffort,'off');assert.equal(await page.evaluate(()=>window.nativeFills),fillsBeforeConclusions+2);
  await reopenConclusion();await owner('settings',{chatThinking:true});await page.evaluate(()=>window.setNativeWorkInput(''));
  await startQuick();await dock.waitFor();assert.equal(await conclusionThinking.count(),0,'an already-enabled chat does not ask to enable thinking again');
  assert.equal(calls.at(-1).reasoningEffort,'low');assert.equal(await page.evaluate(()=>window.nativeFills),fillsBeforeConclusions+3);
  await reopenConclusion();await conclusion.getByRole('textbox',{name:'工作指令整理要求',exact:true}).fill('慢指令整理');
  const quickDelayed=async(change)=>{
    await page.evaluate(()=>window.setNativeWorkInput('',{attachmentIds:[],occurrences:[],phase:'plain'}));const before=calls.length,fills=await page.evaluate(()=>window.nativeFills);
    await startQuick();for(let i=0;i<40&&calls.length===before;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls.length,before+1);await change();for(const release of gates.splice(0))release();
    await conclusion.getByRole('button',{name:'正在整理…',exact:true}).waitFor({state:'hidden'});
    assert.equal(await dialog().count(),1);assert.equal(await dock.count(),0);assert.equal(await page.evaluate(()=>window.nativeFills),fills);
    assert.match(await conclusionOutput.inputValue(),/待确认/);
  };
  await quickDelayed(()=>page.evaluate(()=>window.setNativeWorkInput('生成期间新输入的工作要求')));
  assert.equal(await page.getByLabel('工作会话输入',{exact:true}).inputValue(),'生成期间新输入的工作要求');
  await quickDelayed(()=>page.evaluate(()=>window.setNativeWorkMeta({attachmentIds:['conclusion-attachment-same-revision']})));
  await page.evaluate(()=>window.setNativeWorkMeta({attachmentIds:[]}));
  await quickDelayed(()=>page.evaluate(()=>window.switchWorkSession('work')));
  await page.evaluate(()=>window.setNativeWorkInput('',{attachmentIds:[],occurrences:[],phase:'plain'}));
  await conclusion.getByRole('textbox',{name:'工作指令整理要求',exact:true}).fill('普通结论整理');thinkingCapability='unavailable';
  const fillsBeforeUnsupported=await page.evaluate(()=>window.nativeFills);await startQuick();
  await conclusion.getByRole('button',{name:'正在整理…',exact:true}).waitFor({state:'hidden'});
  assert.equal(await dialog().count(),1);assert.equal(await dock.count(),0);assert.equal(await page.evaluate(()=>window.nativeFills),fillsBeforeUnsupported);
  assert.match(await conclusionOutput.inputValue(),/待确认/);thinkingCapability='available';
  thinkingCapability='unknown';await startQuick();
  await conclusion.getByText('无法确认模型本次思考方式，结论已保留为草稿。请核对后手动填入。',{exact:true}).waitFor();
  assert.equal(await dialog().count(),1);assert.equal(await dock.count(),0);assert.equal(await page.evaluate(()=>window.nativeFills),fillsBeforeUnsupported);
  assert.match(await conclusionOutput.inputValue(),/待确认/);thinkingCapability='available';
  const beforeScopeConclusion=calls.length,keptConclusion=await conclusionOutput.inputValue();
  const conclusionContext=await owner('chat-context',{action:'presence',roomId:conclusionRoom.room.id,viewer:'conclusion-scope-check',sequence:1,visible:true});
  await owner('chat-context',{action:'detach',roomId:conclusionRoom.room.id,sessionId:conclusionContext.primarySessionId,revision:conclusionContext.revision});
  await owner('chat-context',{action:'presence',roomId:conclusionRoom.room.id,viewer:'conclusion-scope-check',sequence:2,visible:false});
  await quick().click();await conclusion.getByText('房间参考或讨论状态已变化，请刷新核对原话。已有草稿保留。',{exact:true}).waitFor();
  assert.equal(calls.length,beforeScopeConclusion);assert.equal(await conclusionOutput.inputValue(),keptConclusion);
  assert.equal(await dialog().count(),1);assert.equal(await dock.count(),0);
  await conclusion.getByRole('button',{name:'收起指令草稿',exact:true}).click();await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  // Per-message selection cannot alter the room's authorized sources or its actual @ order.
  const relevanceRoom=await owner('chat-rooms',{action:'create',requestId:'context-selection-room',name:'本轮参考选择验证',
    memberIds:['大肥鱼（默认）','大肥龙'],targetPersonaIds:['大肥鱼（默认）','大肥龙'],epoch:(await state()).epoch});
  await open();await chooseRoom(relevanceRoom.room.name);
  await page.evaluate(()=>window.switchWorkSession('other'));
  await page.getByRole('button',{name:'参考来源',exact:true}).click();await page.getByRole('button',{name:'接入当前会话',exact:true}).click();
  await page.getByText('来源 · 2',{exact:true}).waitFor();await page.getByRole('button',{name:'收起来源',exact:true}).click();
  const fixedSelection=structuredClone((await state()).room),beforeIdleSelections=contextSelections.length,beforeIdleCalls=calls.length;
  await send('今天就聊点轻松的吧。');await settled();
  assert.equal(contextSelections.length,beforeIdleSelections+2,'the same director selects two actual speakers and exhausted candidates stop locally');
  const casualCalls=calls.slice(beforeIdleCalls).map(call=>readChatInput(call));
  assert.equal(casualCalls.length,2);assert.ok(casualCalls.every(payload=>!payload.workContext?.sources?.length&&!/work_REPORT|other_REPORT|work_GOAL|other_GOAL/.test(JSON.stringify(payload.workContext))),
    'casual talk receives no work-source bodies while keeping its reference scope metadata');
  const beforeWorkSelection=contextSelections.length,beforeSelectedCalls=calls.length;
  pauseContextSelection=true;const selectionEntered=new Promise(resolve=>{contextSelectionEntered=resolve;});
  await send('只参考当前工作会话，帮我看进展。');await selectionEntered;
  await page.getByText('正在接上这句话…',{exact:true}).waitFor();
  assert.equal(await page.locator('.dsh-persona-chat-typing').count(),0,'a queued primary is not shown typing while context selection runs');
  assert.equal(calls.length,beforeSelectedCalls,'the primary waits for its bounded source selection');
  const selectorPayload=readChatInput(contextSelections.at(-1));
  assert.equal(selectorPayload.task,'chat-room-director');assert.deepEqual(selectorPayload.sources.map(source=>source.id).sort(),['other','work']);
  assert.doesNotMatch(JSON.stringify(selectorPayload),/work_REPORT|other_REPORT|WHALE_PRIVATE_REFERENCE|DRAGON_PRIVATE_REFERENCE|WORK_ONLY_DO_NOT_READ/);
  releaseContextSelection();await settled();
  assert.equal(contextSelections.length,beforeWorkSelection+2);
  const selectedCalls=calls.slice(beforeSelectedCalls).map(call=>readChatInput(call));
  assert.equal(selectedCalls.length,2);assert.ok(selectedCalls.every(payload=>payload.workContext?.sources?.length===1&&payload.workContext.sources[0].sessionId==='work'));
  assert.ok(selectedCalls.every(payload=>JSON.stringify(payload.workContext).includes('work_REPORT')&&!JSON.stringify(payload.workContext).includes('other_REPORT')));
  const beforeCancelledSelection=calls.length;pauseContextSelection=true;
  const cancelSelectionEntered=new Promise(resolve=>{contextSelectionEntered=resolve;});
  await send('这次先取消参考筛选。');await cancelSelectionEntered;
  await page.getByRole('button',{name:'停止回复',exact:true}).click();await settled();releaseContextSelection();
  assert.equal(calls.length,beforeCancelledSelection,'cancelling preparation starts no queued primary call');
  const cancelledSelection=await state();assert.equal(cancelledSelection.running,false);
  const cancelledGroup=cancelledSelection.room.turns.filter(turn=>turn.user==='这次先取消参考筛选。');assert.equal(cancelledGroup.length,1);assert.equal(cancelledGroup[0].phase,'anchor');assert.equal(cancelledGroup[0].status,'ready','stopping a director retains the exact user anchor without inventing cancelled replies');
  await send('设置布局先画草图，我还没决定。');await settled();
  const relevanceReferences=await owner('chat-references?room='+encodeURIComponent(relevanceRoom.room.id));
  const relevanceQuote=relevanceReferences.discussionChoices.find(quote=>quote.ref.kind==='user'&&quote.text==='设置布局先画草图，我还没决定。');
  await owner('chat-discussion',{roomId:relevanceRoom.room.id,action:'add',requestId:'context-discussion',title:'草图布局待讨论',status:'proposal',
    source:relevanceQuote.ref,epoch:relevanceReferences.epoch,discussionRevision:relevanceReferences.discussion.revision});
  await send('设置布局的草图还记得吗？');await settled();
  assert.ok(readChatInput(calls.at(-1)).discussionState.length>0,'the prior room state exists before changing topic');
  const beforeLeaveWork=calls.length,beforeExplicitSelection=contextSelections.length;await send('先不聊工作了');await settled();
  const withoutWork=calls.slice(beforeLeaveWork).map(call=>readChatInput(call));
  assert.ok(withoutWork.every(payload=>!payload.workContext?.sources?.length&&payload.roomNotes.length===0&&payload.discussionState.length===0),
    'an explicit change to casual talk does not reintroduce extra old notes or discussion state');
  assert.equal(contextSelections.length,beforeExplicitSelection+2,'the director handles each actual speaker and explicit casual-only intent withholds work sources');
  const beforeInvalidSelection=calls.length;await send('筛选失败也别把所有工作都带进来。');await settled();
  assert.equal(calls.length,beforeInvalidSelection,'an invalid finite source key is rejected before any persona body call');
  assert.equal((await state()).directorFailure.reason,'control');
  assert.ok(calls.slice(beforeInvalidSelection).every(call=>!readChatInput(call).workContext?.sources?.length),
    'an unauthorized source proposal falls back without all-source injection');
  const fixedAfter=(await state()).room;
  assert.deepEqual(fixedAfter.sources,fixedSelection.sources);assert.deepEqual(fixedAfter.targetPersonaIds,fixedSelection.targetPersonaIds);
  const coordinationRecords=await owner('chat-references?room='+encodeURIComponent(relevanceRoom.room.id));
  assert.equal(coordinationRecords.records[0].coordination.basis,'explicit','a rejected director creates no fictional reference-use record; the prior actual casual reply remains latest');
  assert.equal(coordinationRecords.records[0].coordination.selectedSourceIds.length,0);
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();
  const callsBeforeCoordinationSettings=calls.length,selectionsBeforeSettings=contextSelections.length;
  await page.getByRole('button',{name:'插件设置',exact:true}).click();await page.getByRole('tab',{name:'聊天室',exact:true}).click();
  const selectionFold=page.locator('[data-settings-fold="room-references"]');
  if(!await selectionFold.evaluate(element=>element.open))await selectionFold.locator(':scope > summary').click();
  const coordinationPanel=page.getByRole('region',{name:'房间参考信息',exact:true});
  await coordinationPanel.getByRole('button',{name:'刷新参考信息',exact:true}).click();
  await coordinationPanel.getByRole('combobox',{name:'查看房间参考',exact:true}).selectOption(relevanceRoom.room.id);
  const coordinationCard=coordinationPanel.getByRole('region',{name:'本次参考选择',exact:true});
  await coordinationCard.getByText('这轮没有选择工作来源。',{exact:true}).waitFor();
  await coordinationCard.getByText('查看选择依据',{exact:true}).click();
  await coordinationCard.getByText('本轮明确指定',{exact:true}).waitFor();
  assert.match(await coordinationCard.innerText(),/不是对用户意图的确认/);
  assert.equal(calls.length,callsBeforeCoordinationSettings);assert.equal(contextSelections.length,selectionsBeforeSettings,'inspecting the choice never re-runs its model');
  if(values.output){
    await page.locator('[data-persona-shell="settings"]').screenshot({path:path.join(values.output,'room-context-selection-settings.png')});
    await page.setViewportSize({width:390,height:850});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the reference-choice card fits a narrow settings page');
    await page.locator('[data-persona-shell="settings"]').screenshot({path:path.join(values.output,'room-context-selection-settings-mobile.png')});
    await page.setViewportSize({width:1100,height:850});
  }
  await page.getByRole('button',{name:'插件设置',exact:true}).click();await page.evaluate(()=>window.switchWorkSession('work'));
  // Motion is a visual layer: it must not change input, source leases or model dispatch.
  const motionRoom=await owner('chat-rooms',{action:'create',requestId:'motion-room',name:'过渡动效验证',memberIds:['大肥鱼（默认）'],
    targetPersonaIds:['大肥鱼（默认）'],epoch:(await state()).epoch});
  await open();await chooseRoom(motionRoom.room.name);await page.emulateMedia({reducedMotion:'no-preference'});
  await send('保留原有聊天和滚动位置。'.repeat(110));await settled();
  await input().fill('动效过程中仍保留的草稿');await input().evaluate(el=>el.setSelectionRange(2,7));
  const motionScroll=await page.getByLabel('聊天消息',{exact:true}).evaluate(el=>{el.scrollTop=24;el.dispatchEvent(new Event('scroll'));return el.scrollTop;});
  assert.ok(motionScroll>0,'the motion check has a genuine reading position to preserve');
  const callsBeforeMotion=calls.length,sourceReadsBeforeMotion=sourceReads.length;
  const nativeMotion=await page.evaluate(()=>window.__chatMotionProbe.available);
  const countMotion=()=>page.evaluate(()=>window.__chatMotionProbe.operations.length);
  const waitMotion=()=>page.waitForFunction(()=>window.__chatMotionProbe.operations.every(op=>op.finished));
  let motionRestores=0;
  const minimizeForMotion=async()=>{
    const reads=sourceReads.length;await minimizeButton.click();await dock.waitFor();
    assert.equal(sourceReads.length,reads,'minimizing does not read source contents');
  };
  const restoreForMotion=async()=>{
    const reads=sourceReads.length;
    const refreshed=page.waitForResponse(r=>r.url().endsWith('/chat-context')&&r.request().method()==='POST'
      &&r.request().postDataJSON()?.action==='open');
    await restore.click();await input().waitFor();await refreshed;motionRestores++;
    assert.ok(sourceReads.length<=reads+1,'restoring performs at most its existing single-source freshness check');
  };
  const beforeNativeMin=await countMotion();
  await minimizeForMotion();
  if(nativeMotion){
    assert.equal(await countMotion(),beforeNativeMin+1,'minimizing uses the browser surface transition when supported');
    await page.waitForFunction(()=>window.__chatMotionProbe.operations.at(-1)?.ready);
    if(values.output){
      const nativeSnapshots=await page.evaluate(()=>{
        const animations=document.getAnimations().filter(animation=>String(animation.effect?.pseudoElement).startsWith('::view-transition')
          ||/view-transition|dsh-chat-surface/.test(animation.animationName??''));
        window.__chatMotionFrozen=animations;for(const animation of animations){animation.pause();animation.currentTime=120;}
        return animations.length;
      });
      assert.ok(nativeSnapshots>0,'the screenshot captures actual native snapshot animations');
      await page.screenshot({path:path.join(values.output,'room-minimize-motion-midpoint.png'),animations:'allow'});
      await page.evaluate(()=>{for(const animation of window.__chatMotionFrozen)animation.play();delete window.__chatMotionFrozen;});
    }
  }
  await waitMotion();
  await restoreForMotion();await waitMotion();
  assert.equal(await input().inputValue(),'动效过程中仍保留的草稿');
  assert.deepEqual(await input().evaluate(el=>[el===document.activeElement,el.selectionStart,el.selectionEnd]),[true,2,7]);
  assert.ok(Math.abs(await page.getByLabel('聊天消息',{exact:true}).evaluate(el=>el.scrollTop)-motionScroll)<=1,'restoring preserves the reading position');
  if(nativeMotion){
    await minimizeForMotion();await page.waitForFunction(()=>window.__chatMotionProbe.operations.at(-1)?.ready);
    assert.equal(await page.evaluate(()=>window.__chatMotionProbe.operations.at(-1).finished),false,'the preference changes during an actual unfinished animation');
    await page.emulateMedia({reducedMotion:'reduce'});await waitMotion();
    assert.equal(await page.locator('html[data-dsh-chat-motion]').count(),0,'changing motion preference immediately settles and cleans the transition');
    await restoreForMotion();await page.emulateMedia({reducedMotion:'no-preference'});
  }
  // Accessibility takes precedence over movement, including already-loaded room surfaces.
  await page.emulateMedia({reducedMotion:'reduce'});const beforeReduced=await countMotion();
  await minimizeForMotion();await restoreForMotion();
  assert.equal(await countMotion(),beforeReduced,'reduced motion never starts a native surface animation');
  assert.equal(await dialog().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Older webviews and native API failures still perform the same immediate owner action.
  await page.evaluate(()=>{window.__chatMotionSaved=document.startViewTransition;Object.defineProperty(document,'startViewTransition',{configurable:true,writable:true,value:undefined});});
  await minimizeForMotion();await restoreForMotion();
  assert.equal(await input().inputValue(),'动效过程中仍保留的草稿');
  await page.evaluate(()=>{document.startViewTransition=()=>{throw Error('simulated-native-motion-unavailable');};});
  await minimizeForMotion();await restoreForMotion();
  assert.equal(await input().inputValue(),'动效过程中仍保留的草稿');
  await page.evaluate(()=>{document.startViewTransition=window.__chatMotionSaved;delete window.__chatMotionSaved;});
  // A hidden page must not keep a deferred visual callback responsible for the state change.
  const beforeHidden=await countMotion();
  await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
  await minimizeForMotion();await restoreForMotion();
  assert.equal(await countMotion(),beforeHidden);await page.evaluate(()=>delete document.visibilityState);
  // Reverse and close during the visual transition, rather than waiting for a timer.
  await page.evaluate(()=>document.querySelector('[aria-label="最小化聊天室"]').click());await dock.waitFor();
  if(nativeMotion)assert.equal(await page.evaluate(()=>window.__chatMotionProbe.operations.at(-1).finished),false,'rapid reversal interrupts a running transition');
  await page.evaluate(()=>document.querySelector('.dsh-persona-chat-dock button').click());await input().waitFor();motionRestores++;
  await page.evaluate(()=>document.querySelector('.dsh-persona-chat [aria-label="关闭聊天室"]').click());
  await dialog().waitFor({state:'hidden'});await dock.waitFor({state:'hidden'});await waitMotion();
  assert.equal(await page.locator('.dsh-persona-chat,.dsh-persona-chat-dock').count(),0,'rapid changes leave no interactive surface behind');
  assert.equal(await page.locator('html[data-dsh-chat-motion]').count(),0,'finished or cancelled transitions release their document marker');
  assert.equal(calls.length,callsBeforeMotion,'motion adds no model requests');
  assert.ok(sourceReads.length-sourceReadsBeforeMotion<=motionRestores,'motion adds no reads beyond existing one-source resume checks');
  assert.equal(sourceReads.slice(sourceReadsBeforeMotion).every(id=>id==='work'),true,'motion never expands the fixed work-source scope');
  await open();assert.equal(await input().inputValue(),'动效过程中仍保留的草稿');
  assert.equal(await page.locator('.dsh-persona-chat-message[data-arriving=true]').count(),0,'opening history does not replay new-message entrance effects');
  await page.evaluate(()=>{
    document.querySelector('.dsh-persona-chat [aria-label="关闭聊天室"]').click();
    Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='聊天室').click();
  });
  await input().waitFor();await waitMotion();
  assert.equal(await dialog().count(),1,'closing and immediately reopening keeps a single room surface');
  assert.equal(await input().inputValue(),'动效过程中仍保留的草稿');
  assert.equal(await input().evaluate(el=>el===document.activeElement),true,'immediate reopen returns focus to the existing draft');
  if(values.output)await capture('room-motion-restored-mobile',390,true);
  // Both independent surfaces share one compact dock placement rule.
  const modelsBeforeDocks=calls.length;
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>window.reportReadingRuntime.open('work',0));
  await page.getByRole('dialog',{name:'报告阅读页',exact:true}).waitFor();
  await page.getByRole('button',{name:'最小化报告阅读页',exact:true}).click();
  await page.getByRole('button',{name:/还原聊天室/}).click();await input().waitFor();
  await minimizeButton.click();await dock.waitFor();
  for(const width of [1100,390,280]){
    await page.setViewportSize({width,height:850});
    await page.waitForFunction(()=>{
      const chat=document.querySelector('.dsh-persona-chat-dock'),report=document.querySelector('.dsh-report-reading-dock');
      if(!chat||!report)return false;const a=chat.getBoundingClientRect(),b=report.getBoundingClientRect();
      return a.left>=0&&b.left>=0&&a.right<=innerWidth&&b.right<=innerWidth&&a.bottom<=innerHeight&&b.bottom<=innerHeight
        &&b.bottom<a.top&&Math.abs(a.right-b.right)<2&&b.height<=50&&b.width<=150;
    });
    if(values.output&&width===390)await page.screenshot({path:path.join(values.output,'room-and-report-compact-docks-mobile.png')});
  }
  await page.getByRole('button',{name:'关闭报告阅读页',exact:true}).click();
  await page.waitForFunction(()=>Math.abs(innerWidth-document.querySelector('.dsh-persona-chat-dock').getBoundingClientRect().right-16)<2);
  await page.setViewportSize({width:390,height:850});await restore.click();await input().waitFor();
  assert.equal(await input().inputValue(),'动效过程中仍保留的草稿');
  assert.equal(calls.length,modelsBeforeDocks,'opening and arranging docks does not make model calls');
  await page.getByRole('button',{name:'关闭聊天室',exact:true}).click();await waitMotion();
  await runContinuity(motionRoom.room.name);
  await runMessageTimes();
  await runSilentReply();
  const clientPosts=routeReads.map(read=>read.chat).filter(body=>body&&['send','retry'].includes(body.action));
  assert.ok(clientPosts.some(body=>body.action==='retry'));
  assert.ok(clientPosts.every(body=>body.clientTime&&Number.isInteger(body.clientTime.utcOffsetMinutes)&&typeof body.clientTime.timeZone==='string'),'explicit sends and retries include browser-local time metadata');
  assert.ok(routeReads.map(read=>read.chat).filter(body=>body&&!['send','retry'].includes(body.action)).every(body=>!('clientTime'in body)),'passive and non-speaking actions carry no new clock metadata');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({result:'passed',calls:calls.length,judgements:judgements.length,contextSelections:contextSelections.length,checks:['lazy global launch','slow storage first-room retry and overlapping opens','pending first send has no premature stop action','foreground work persona for a new room','reverse primary selection order','historical mentions survive member changes','room creation and selected room persistence','shared timeline and historical speaker identity',
    'host code toolbar size and member panel hit testing','quote draft, cancellation, durable buffer save retry and source jump','long quote full-text preview, draft source jump and Esc without losing text','explicit work draft, read and generation retry, editing, replacement confirmation and clipboard fallback','native draft empty guard and revision-CAS insertion without submission','conclusion thinking choice, one-shot override and default-enabled bypass','successful conclusion fills and minimizes while target, text or attachments changes retain the room','work draft room retention, cancellation and mobile layout','lazy per-room reference inspection, private preference isolation and pause retry','reference question and frozen @ order across individual speakers','room discussion evidence, failed save retry, correction, undo and external conflict without losing a draft','discussion editor source invalidation never revives an old reference scope','bounded peer continuation completes the active reply before yielding queued speech to new input','borderless member strip and single-person simplification','header sources and visible member management','avatar options and composite updates','target changes during streaming','removed speaker cancellation','room-isolated drafts and sources','stream pacing and format retry',
    'ordered selected speakers and repeated single-record retry','one room director selects an unmentioned listener from real public events','broadcast reaches twenty-four ordinary plus eight peer replies in one thirty-two-seat live stream','explicit quick replies','owner avatar display','custom member avatar refresh','expanded composer and safe viewport','failed room save retains draft','clear versus delete','old Host reload guard','closed window stops polling',
    'minimize releases source presence and counts distinct completed replies','dock respects reduced motion and stops polling after the round','restore from dock or launcher preserves room, draft and caret',
    'native surface transitions preserve draft, selection and reading position without extra model calls or expanded source reads','reduced-motion, hidden-page and missing/failed native animation fallbacks','motion preference changes settle an active native animation','rapid minimize, restore, close and immediate reopen settle without stale visual state',
    'one room director handles source relevance and each next actor while unstarted seats never pretend to type','casual talk omits work bodies and explicit casual-only commands omit extra notes and discussion state','authorized source subset and invalid selection fallback preserve room sources and historical mentions','reference selection is inspected only in settings without re-running a model',
    'consecutive bubbles keep only the first historical portrait and name while quote and stream indices remain original','second-bubble quote survives save failure, reopen and source jump','lightweight local dates preserve cross-day boundaries and precise time metadata without changing canonical history','only explicit sends and retries attach browser-local clock metadata','explicit model silence retires live typing without a bubble, failure, automatic repeat or losing the next user cycle'],pageErrors:errors}));
  }
} catch(error) {
  if(browserPage&&!browserPage.isClosed()){
    const diagnostics=await browserPage.evaluate(async()=>({
      visibility:document.visibilityState,hasFocus:document.hasFocus(),
      animationFrame:await Promise.race([new Promise(resolve=>requestAnimationFrame(()=>resolve('received'))),new Promise(resolve=>setTimeout(()=>resolve('timed-out'),300))]),
      animations:document.getAnimations().map(animation=>({name:animation.animationName,currentTime:animation.currentTime,playState:animation.playState,endTime:animation.effect?.getComputedTiming().endTime})),
    })).catch(()=>null);
    console.error(JSON.stringify({browserFailure:diagnostics}));
    if(values.output){mkdirSync(values.output,{recursive:true});await browserPage.screenshot({path:path.join(values.output,'failure.png'),timeout:3000}).catch(()=>{});}
  }
  throw error;
} finally {
  finishOpening();for(const release of gates)release();releaseChatWrite?.();lateAckRelease?.();streamRelease?.();finishStream?.();releaseWorkValidate?.();releaseContextSelection?.();
  await browser.close();for(const stop of [...disposers].reverse())await stop();
  streamServer.closeAllConnections();await new Promise(resolve=>streamServer.close(resolve));
}
