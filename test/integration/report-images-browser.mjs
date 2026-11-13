// Published Markdown/AssistantMarkdown + real Chromium; controlled Host file IO.
// No model, profile, or workspace files are read through the fixture routes.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {makeReportSource} from '../../lib/report-visualization.js';
const {values}=parseArgs({options:{deps:{type:'string'},'browser-deps':{type:'string'},'native-deps':{type:'string'},fixtures:{type:'string'},executable:{type:'string'},output:{type:'string'}}});
assert.ok(values.deps&&values['native-deps']&&values.fixtures&&values.output);
const deps=createRequire(path.resolve(values.deps)),native=createRequire(path.resolve(values['native-deps'])),browserDeps=createRequire(path.resolve(values['browser-deps']??values.deps));
const {build}=deps('esbuild'),{chromium}=browserDeps('playwright');
const primitive=native.resolve('@deepseek-ai/dsh-client-ui-primitives');
assert.equal(JSON.parse(readFileSync(path.join(path.dirname(primitive),'../package.json'),'utf8')).version,'0.2.1-rc.3');
const official=readFileSync(path.join(values.fixtures,'lib/client.js'),'utf8');
function region(marker){const at=official.indexOf(marker);assert.ok(at>=0,marker);return official.slice(at+marker.length,official.indexOf('//#endregion',at));}
const workspace=region('//#region ../../util/workspace-path/lib/index.js');
const assistant=region('//#region lib/types/client/chat/AssistantMarkdown.js');
const labels={copy:'复制',copied:'已复制',code:'代码',expand:'展开',collapse:'收起',table:'表格',copyTable:'复制表格',tableCopied:'已复制表格'};
const text=[
 '# 带图片的原始报告',
 'Windows 绝对路径：\n![绝对路径](D:/reports/screen%20one.png)',
 '相对工作区路径：\n\n![相对路径](./art/chart.png)',
 'POSIX 绝对路径：\n\n![POSIX](/tmp/report.png)',
 '远程图片：\n\n![远程图片](https://images.invalid/chart.png)',
 '![引用式图片][plot]',
 '[plot]: D:/reports/reference.png',
 '[![链接内图片](./art/linked.png)](https://example.invalid/details)',
 '- 列表里的图 ![列表图](./art/list.png)',
 '代码原样保留：`![不能变成图片](./not-an-image.png)`',
 '![损坏图片](./missing.png)',
 '![不安全](javascript:alert%281%29)',
 '支持原文核对，尚未部署。',
 '```markdown\n![代码图](./must-not-load.png)',
].join('\n\n');
const source=makeReportSource({sessionId:'work',seq:10,text});
const readable={schemaVersion:3,blocks:source.blocks.map(b=>({ref:b.id,text:b.text.includes('Windows 绝对路径')?b.text.replace('Windows 绝对路径','Windows 路径'):b.text}))};
const client=readFileSync(new URL('../../client.js',import.meta.url),'utf8');
mkdirSync(values.output,{recursive:true});
const entry=`
import * as React from ${JSON.stringify(deps.resolve('react'))};import * as ReactDOM from ${JSON.stringify(deps.resolve('react-dom'))};import {createRoot} from ${JSON.stringify(deps.resolve('react-dom/client'))};
import * as primitives from ${JSON.stringify(primitive)};
const h=React.createElement,react=React,react_jsx_runtime={jsx:React.createElement};
const _deepseek_ai_dsh_client_ui_primitives=primitives;
${workspace}
const markdownLabels=()=>(${JSON.stringify(labels)});
const AssistantMarkdown_module_css_default={root:'official-report',body:'official-body'};
// The published code uses jsx(type, props, key); React's jsx runtime is required.
import * as jsxRuntime from ${JSON.stringify(deps.resolve('react/jsx-runtime'))};react_jsx_runtime.jsx=jsxRuntime.jsx;react_jsx_runtime.jsxs=jsxRuntime.jsxs;
${assistant}
let plugin;window.__ModuleLoader__={load:d=>plugin=d.factory(id=>id==='react'?React:id==='react-dom'?ReactDOM:id==='react-dom/client'?{createRoot}:id==='@deepseek-ai/dsh-client-ui-primitives'?primitives:undefined)};
${client}
const reportSource=${JSON.stringify(source)},readable=${JSON.stringify(readable)};window.modelCalls=0;window.openedFiles=[];window.nextSource=reportSource;
window.fetch=async(url,options)=>{const u=new URL(url,document.baseURI);if(options?.method)throw Error('unexpected write/model call');
 if(u.pathname.endsWith('/state'))return{ok:true,json:async()=>({instanceId:'images',rev:1,rows:[],reports:[{seq:10,final:true,available:true,hash:reportSource.hash}],settings:{enabled:false},sessionEnabled:false,switchesReady:true})};
 if(u.pathname.endsWith('/report-visualization'))return{ok:true,json:async()=>({available:true,source:window.nextSource,cached:u.searchParams.get('presentation')==='readable',result:u.searchParams.get('presentation')==='readable'?readable:undefined})};
 return{ok:true,json:async()=>({})};};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>window.copied=t},configurable:true});
const owner={sessionId:'work',seq:10,text:reportSource.text,cwd:'D:\\\\project',openFile:(...args)=>window.openedFiles.push(args)};
const nativeImages={resolve:p=>fileMediaUrl(document.baseURI,resolveWorkspacePath(owner.cwd,p)),labels:{open:'打开图片',loading:'加载中',failed:'图片加载失败',dialog:'原报告图片预览',close:'关闭'}};
const node={key:'assistant:10',location:{kind:'step',turn:{status:'closed'}},data:{status:'settled',blocks:[{kind:'text',text:reportSource.text}],finalNode:{seq:10},step:1}};
const NativeReport=()=>h(primitives.MarkdownDelegateProvider,{fileImages:nativeImages},h(AssistantMarkdown,{blocks:node.data.blocks,streaming:false,t:k=>k}));
plugin.__testing.applyControls({instanceId:'images',controlRev:1,settings:{enabled:false},sessionSwitches:{rev:1,values:{work:false}}},1);
createRoot(document.getElementById('app')).render(h('main',null,h('div',{id:'native-report'},h(NativeReport)),h(plugin.__testing.PersonaStep,{delegate:{entry:{component:()=>null}},sessionId:'work',cwd:owner.cwd,openFile:owner.openFile,node,renderFactorySlot:()=>null})));
window.testApi=plugin.__testing;window.owner=owner;window.reportSource=reportSource;
`;
writeFileSync(path.join(values.output,'entry.mjs'),entry);
await build({stdin:{contents:entry,resolveDir:path.dirname(primitive)},bundle:true,outfile:path.join(values.output,'probe.js'),platform:'browser',format:'iife',alias:{react:path.dirname(deps.resolve('react/package.json')),'react-dom':path.dirname(deps.resolve('react-dom/package.json'))},loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
const js=readFileSync(path.join(values.output,'probe.js'),'utf8'),css=readFileSync(path.join(values.output,'probe.css'),'utf8');
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{})});
const checks=[],errors=[],fileRequests=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/dsh/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><div id="app"></div></body></html>'});
   if(url.pathname.endsWith('/api/file')||url.hostname==='images.invalid'){fileRequests.push(url.href);if(url.searchParams.get('path')?.includes('missing'))return route.fulfill({status:404,body:''});return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><rect width="1600" height="600" fill="#759ad2"/></svg>'});}
   throw Error('unexpected external request '+url.href);});
 await page.goto('https://local.invalid/dsh/');await page.addStyleTag({content:css});await page.addScriptTag({content:js});
 const nativeImages=page.locator('#native-report img');await nativeImages.first().waitFor();
 await page.getByRole('button',{name:'阅读报告',exact:true}).click();
 const doc=page.locator('.rr-document[aria-label="原始报告全文"]');await doc.locator('img').first().waitFor();
 // Visit lazy images before checking error fallback and completed resources.
 for(const img of await doc.locator('img').all())await img.scrollIntoViewIfNeeded();
 await doc.getByText('图片加载失败 · 损坏图片',{exact:true}).waitFor();
 const imageSources=locator=>locator.locator('img').evaluateAll(nodes=>nodes.map(n=>({alt:n.alt,src:n.src})));
 const actual=await imageSources(doc),expected=await imageSources(page.locator('#native-report'));
 assert.deepEqual(actual,expected);assert.equal(actual.length,7);
 checks.push('report images match published AssistantMarkdown sources, order and alt text');
 assert.equal(new URL(actual.find(i=>i.alt==='相对路径').src).searchParams.get('path'),'D:\\project\\./art/chart.png');
 checks.push('relative files resolve against the originating session workspace');
 assert.ok(actual.find(i=>i.alt==='引用式图片'));assert.equal(await doc.locator('code').filter({hasText:'不能变成图片'}).innerText(),'![不能变成图片](./not-an-image.png)');
 assert.equal((await doc.locator('pre code').textContent()).trim(),'![代码图](./must-not-load.png)');
 checks.push('whole-document reference images, linked and list images remain native; inline code stays inert');
 assert.equal(await doc.locator('img[src^="javascript:"]').count(),0);checks.push('unsafe destinations remain inert; failed files retain native accessible fallback');
 const first=doc.getByRole('button',{name:'打开图片: 绝对路径',exact:true});await first.click();
 const preview=page.getByRole('dialog',{name:'报告图片预览',exact:true});await preview.waitFor();
 assert.equal(await preview.evaluate(e=>{const r=e.querySelector('button').getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
 await page.keyboard.press('Escape');await preview.waitFor({state:'detached'});assert.equal(await first.evaluate(e=>e===document.activeElement),true);
 assert.equal(await page.getByRole('dialog',{name:'报告阅读页',exact:true}).isVisible(),true);checks.push('official image preview is above the reader; Escape closes it and restores image focus');
 await page.getByRole('button',{name:'复制完整原文',exact:true}).click();assert.equal(await page.evaluate(()=>window.copied),source.text);checks.push('copy preserves the exact authored report including image destinations');
 const before=await imageSources(doc);await page.evaluate(()=>{window.owner.cwd='E:/another-session';});
 await page.getByRole('button',{name:'最小化报告阅读页',exact:true}).click();await page.getByRole('button',{name:'恢复报告阅读页',exact:true}).click();
 assert.deepEqual(await imageSources(doc),before);checks.push('minimize/restore and changes in the active workspace cannot retarget report images');
 await page.setViewportSize({width:390,height:740});await doc.locator('img').first().scrollIntoViewIfNeeded();
 assert.ok(await doc.locator('img').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().width<=360)));checks.push('native images fit a narrow reading window without changing aspect ratio');
 await page.getByRole('button',{name:'顺畅阅读',exact:true}).click();const readableDoc=page.getByLabel('顺畅阅读稿',{exact:true});await readableDoc.waitFor();
 await readableDoc.getByAltText('相对路径',{exact:true}).scrollIntoViewIfNeeded();assert.equal(await readableDoc.getByAltText('相对路径',{exact:true}).getAttribute('src'),actual.find(i=>i.alt==='相对路径').src);
 assert.equal(await readableDoc.getByAltText('引用式图片',{exact:true}).getAttribute('src'),actual.find(i=>i.alt==='引用式图片').src);
 assert.equal((await readableDoc.locator('pre code').textContent()).trim(),'![代码图](./must-not-load.png)');
 const passage=readableDoc.locator('.rr-readable-passage').filter({hasText:'Windows 路径'});await passage.hover();await passage.locator('summary').click();
 assert.equal(await passage.getByRole('region',{name:'本段原文',exact:true}).getByAltText('绝对路径',{exact:true}).getAttribute('src'),actual.find(i=>i.alt==='绝对路径').src);
 checks.push('cached readable passages share the original session file resolver without a model call');
 checks.push('split reference images and expanded source comparisons keep their original resources');
 await page.screenshot({path:path.join(values.output,'report-images-narrow.png'),fullPage:true,animations:'disabled'});
 // Direct reopen with a mismatched source must not reuse a previous relative path scope.
 await page.getByRole('button',{name:'关闭报告阅读页',exact:true}).click();await readableDoc.waitFor({state:'detached'});
 await page.evaluate(()=>{window.nextSource={...window.reportSource,text:'源已变化。\n\n'+window.reportSource.text,hash:'changed'};window.testApi.reportReadingRuntime.open('work',10,{...window.owner,cwd:'D:/wrong-scope'});});
 await page.getByLabel('原始报告全文',{exact:true}).getByText('源已变化。',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('原始报告全文',{exact:true}).getByAltText('相对路径',{exact:true}).count(),0);checks.push('a changed source drops the stale relative resource scope');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.modelCalls),0);
 console.log(JSON.stringify({result:'passed',checks,officialVersion:'0.2.1-rc.3',pageErrors:errors,physicalModelCalls:0,fileRequests:fileRequests.length}));
}finally{await browser.close();}
