import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatContext,CONTEXT_LIMITS} from '../lib/chat-context.js';
import {createChatSourceAdapter} from '../lib/chat-source.js';
import {selectWorkExcerpt,normalizeWorkExcerpt,restoreWorkExcerpt,WORK_EXCERPT_LIMITS} from '../lib/chat-excerpt.js';

const source=(report,extra={})=>({name:'原始工作会话',cursor:10,turn:8,turnStartSeq:5,goalSeq:6,reportSeq:9,
  turnStatus:'completed',reportStatus:'final',goal:'查看这份原报告，暂不发布。',report,...extra});
async function fixture(values){
  const calls=[];let failure=false;
  const adapter={projects:async()=>[],source:async id=>{calls.push(id);if(failure)throw Error('PRIVATE_PROVIDER_FAILURE');return values[id];}};
  const context=createChatContext({adapter,id:()=> 'excerpt-context'});context.presence('viewer',true);
  await context.open({sessionId:Object.keys(values)[0]});
  return{context,calls,fail:()=>{failure=true;},async attach(id){await context.attach(id);},capture:()=>context.capture(context.key())};
}
const size=capture=>capture.sources.reduce((sum,row)=>sum+row.goal.length+row.report.length+(row.previousReport?.text.length??0),0);
const event=(seq,type,data)=>({seq,type,data}),start=(seq,turn)=>event(seq,'turn/start',{turn});
const ask=(seq,text)=>event(seq,'user/message',{source:{kind:'user'},content:[{type:'text',text}]});
const answer=(seq,turn,text,extra={})=>event(seq,'assistant/message',{turn,message:{content:[{type:'text',text}]},...extra});
const end=(seq,turn,kind='completed')=>event(seq,'turn/end',{turn,reason:{kind}});

test('a 5001-character report supplies complete original paragraphs instead of being wholly blanked',async()=>{
  const intro='原始开场：'+ '甲'.repeat(1600),risk='发布条件：尚未验证真实客户端；只有用户确认后才可以发布。'+ '乙'.repeat(1600);
  const tail='原始收尾：'+ '丙'.repeat(5001-intro.length-risk.length-4-5);
  const report=[intro,risk,tail].join('\n\n');assert.equal(report.length,5001);
  const f=await fixture({s:source(report,{tool:'PRIVATE_TOOL_BODY',thought:'PRIVATE_THOUGHT'})});
  try{const row=f.capture().sources[0];assert.ok(row.report.length>0&&row.report.length<=5000);assert.equal(row.reportOmitted,true);
    assert.equal(row.reportStatus,'final');assert.equal(row.turn,8);assert.equal(row.reportSeq,9);
    assert.ok(row.report.includes(risk),'a middle limitation is considered, not only the first and last characters');
    assert.equal(row.reportExcerpt.coverage,'partial-unknown');assert.equal(row.reportExcerpt.originalChars,5001);
    assert.deepEqual(normalizeWorkExcerpt(row.reportExcerpt),row.reportExcerpt);
    assert.equal(restoreWorkExcerpt(report,row.reportExcerpt).text,row.report);assert.match(row.report,/原文省略/);
    assert.doesNotMatch(JSON.stringify(row),/PRIVATE_TOOL_BODY|PRIVATE_THOUGHT/);
  }finally{f.context.dispose();}
});

test('middle caution blocks and their headings remain in original order with explicit gaps',()=>{
  const paragraphs=Array.from({length:11},(_,index)=>`段落${index}：`+'正文'.repeat(270));
  paragraphs[5]='## 需要留意\r\n\r\n中间限制：除非完成审批，否则不能推送。\r\n';
  const report=paragraphs.join('\r\n\r\n'),selected=selectWorkExcerpt(report,1700);
  assert.ok(selected.text.includes('## 需要留意\r\n\r\n中间限制：除非完成审批，否则不能推送。'));
  assert.equal(selected.excerpt.coverage,'partial-unknown');assert.ok(selected.excerpt.spans.length<=32);
  assert.ok(selected.excerpt.omitted.length<=33);assert.match(selected.text,/原文省略/);
  for(let index=1;index<selected.excerpt.spans.length;index++)assert.ok(selected.excerpt.spans[index-1].end<selected.excerpt.spans[index].start);
  for(const span of selected.excerpt.spans){assert.notEqual(report[span.start-1]+report[span.start],'\r\n');assert.notEqual(report[span.end-1]+report[span.end],'\r\n');}
  assert.equal(restoreWorkExcerpt(report,selected.excerpt).text,selected.text);
});

test('overlong atomic paragraphs and unfinished fences are omitted without fabricated partial sentences or code',()=>{
  const paragraph='完整但过长的单段：'+'长'.repeat(6000),whole=selectWorkExcerpt(paragraph,5000);
  assert.equal(whole.text,'');assert.equal(whole.omitted,true);assert.equal(whole.excerpt.omitted[0].reason,'oversize-block');
  const code='```js\n'+'const longBody = "x";\n'.repeat(400)+'CODE_END\n```\n';
  const report='开头说明。\n\n'+code+'\n条件：尚未批准执行。\n\n末尾说明。';
  const chosen=selectWorkExcerpt(report,600);assert.ok(chosen.text.includes('条件：尚未批准执行。'));
  assert.doesNotMatch(chosen.text,/```|const longBody|CODE_END/);assert.ok(chosen.excerpt.omitted.some(span=>span.reason==='oversize-block'));
  const unclosed=selectWorkExcerpt('说明。\n\n```js\n'+'危险代码\n'.repeat(200),100);
  assert.doesNotMatch(unclosed.text,/```|危险代码/);assert.ok(unclosed.excerpt.omitted.some(span=>span.reason==='unclosed-fence'));
  const indented='    if (mustApprove) INDENTED_FIRST;\n\n    else INDENTED_LAST;\n'+'    neverSplit();\n'.repeat(40);
  const noHalfCode=selectWorkExcerpt('原始说明。\n\n'+indented+'\n原文末尾。',110);
  assert.doesNotMatch(noHalfCode.text,/INDENTED_FIRST|INDENTED_LAST|neverSplit/,'an indented code block cannot lose its later branch');
});

test('a retained fenced block and a loose list are complete original units',()=>{
  const code='```sh\nprintf "risk remains\\n"\nexit 0\n```\n',list='- 第一项有条件。\n\n- 第二项只有确认后执行。\n';
  const report='说明。\n\n'+code+'\n'+list+'\n'+'大段正文'.repeat(900),selected=selectWorkExcerpt(report,240);
  if(selected.text.includes('printf'))assert.ok(selected.text.includes(code));
  if(selected.text.includes('第一项')||selected.text.includes('第二项'))assert.ok(selected.text.includes(list));
  assert.equal(restoreWorkExcerpt(report,selected.excerpt).text,selected.text);
});

test('all selected current sources stay within the shared budget before historical reports are considered',async()=>{
  const reportA=Array.from({length:7},(_,index)=>`A${index}：`+(index===3?'风险：未获发布批准。':'')+'甲'.repeat(900)).join('\n\n');
  const reportB=Array.from({length:4},(_,index)=>`B${index}：`+(index===2?'条件：仅本地通过。':'')+'乙'.repeat(850)).join('\n\n');
  const values={a:source(reportA,{name:'A',goal:'A'.repeat(300),previousReport:{turn:7,seq:3,text:'上轮原文：'+'旧'.repeat(1500)}}),
    b:source(reportB,{name:'B',goal:'B'.repeat(300)})};
  const f=await fixture(values);
  try{await f.attach('b');const capture=f.capture();assert.deepEqual(capture.sources.map(row=>row.sessionId),['a','b']);
    assert.ok(size(capture)<=CONTEXT_LIMITS.chars);assert.ok(capture.sources.every(row=>row.report.length>0));
    assert.ok(capture.sources[0].report.includes('风险：未获发布批准。'));assert.ok(capture.sources[1].report.includes('条件：仅本地通过。'));
    assert.equal(capture.sources[0].previousReportOmitted,true);assert.equal(capture.sources[0].previousReport.turn,7);
    assert.equal(capture.sources[0].previousReport.text,'');assert.equal(capture.sources[0].previousReport.excerpt.coverage,'partial-unknown');
    const second=capture.sources[1],before=f.calls.length,resolved=f.context.resolveReference(second);
    assert.equal(resolved.report,second.report);assert.equal(f.calls.length,before,'inspection must not start reads');
    const snapshot=f.context.snapshot().sources.find(row=>row.sessionId==='b');assert.notEqual(snapshot.report,second.report,'actual budget selection may differ from the settings snapshot');
    assert.equal(snapshot.report,reportB);assert.equal(second.reportOmitted,true);
  }finally{f.context.dispose();}
});

test('recorded fragments resolve only against the original text and exact current source metadata',async()=>{
  const report=Array.from({length:9},(_,index)=>`原始${index}：`+(index===4?'风险：尚未验收。':'')+'字'.repeat(750)).join('\n\n');
  const values={s:source(report)},f=await fixture(values);
  try{const ref=f.capture().sources[0],before=f.calls.length;assert.equal(f.context.resolveReference(ref).report,ref.report);
    for(const changed of [{...ref,cursor:11},{...ref,turn:7},{...ref,reportSeq:3},{...ref,goalSeq:2},{...ref,reportStatus:'progress'},{...ref,goalOmitted:true},
      {...ref,cursor:'10'},{...ref,reportExcerpt:{...ref.reportExcerpt,extra:'PRIVATE_UNTRUSTED'}},
      {...ref,reportExcerpt:{...ref.reportExcerpt,digest:'0'.repeat(64)}},{...ref,reportExcerpt:undefined}])assert.equal(f.context.resolveReference(changed),null);
    assert.equal(f.calls.length,before);values.s=source(report.replace('原始4','变更4'));await f.context.refresh(true);
    assert.equal(f.context.resolveReference(ref),null,'same cursor/length cannot disguise changed fragment source text');
  }finally{f.context.dispose();}
});

test('failed reads and lagging snapshots never restore an old excerpt as current work',async()=>{
  const values={s:source('旧报告原文')},f=await fixture(values);
  try{const ref=f.capture().sources[0];f.fail();await f.context.refresh(true);
    assert.deepEqual(f.capture().sources,[]);assert.equal(f.capture().omitted[0].reason,'read-failed');assert.equal(f.context.resolveReference(ref),null);
  }finally{f.context.dispose();}
  const lag=await fixture({s:source('旧快照',{cursor:4})});
  try{const ref=lag.capture().sources[0];lag.context.event({id:'s'},{type:'assistant/message',seq:11});await lag.context.prepareCapture(lag.context.key());
    assert.deepEqual(lag.capture().sources,[]);assert.equal(lag.capture().omitted[0].reason,'update-pending');assert.equal(lag.context.resolveReference(ref),null);
  }finally{lag.context.dispose();}
});

test('a new turn progress keeps the preceding final separate and tool-carrying text is never promoted to final',async()=>{
  const events=[start(1,7),ask(2,'旧目标'),answer(3,7,'上轮结果，仍有原始条件。'),end(4,7),start(5,8),ask(6,'本轮新目标'),answer(7,8,'本轮只开始准备。')];
  const adapter=createChatSourceAdapter({get:key=>key==='sessionQuery'?{observeSession:async()=>({events})}:undefined});
  const context=createChatContext({adapter});context.presence('viewer',true);
  try{await context.open({sessionId:'work'});let row=context.capture(context.key()).sources[0];
    assert.deepEqual([row.turn,row.reportSeq,row.reportStatus,row.report],[8,7,'progress','本轮只开始准备。']);
    assert.deepEqual(row.previousReport,{turn:7,seq:3,text:'上轮结果，仍有原始条件。'});
    events.push(event(8,'assistant/message',{turn:8,message:{content:[{type:'text',text:'PRIVATE_TOOL_CARRY_TEXT'},{type:'tool-call',name:'read'}]}}),end(9,8));
    await context.refresh(true);row=context.capture(context.key()).sources[0];assert.equal(row.reportStatus,'progress');assert.equal(row.previousReport.turn,7);
    assert.doesNotMatch(JSON.stringify(row),/PRIVATE_TOOL_CARRY_TEXT/);
    events.splice(-2,2,answer(8,8,'本轮正式结果。'),end(9,8));await context.refresh(true);row=context.capture(context.key()).sources[0];
    assert.equal(row.reportStatus,'final');assert.equal(row.turn,8);assert.equal(row.previousReport,undefined);
  }finally{context.dispose();}
});

test('excerpt metadata is bounded, pointer-only and cannot select half an original block',()=>{
  const raw=Array.from({length:200},(_,index)=>`段${index}：😀\r\n`+'字'.repeat(30)).join('\r\n\r\n'),selected=selectWorkExcerpt(raw,800);
  assert.ok(selected.text.length<=800);assert.ok(selected.excerpt.spans.length<=WORK_EXCERPT_LIMITS.spans);
  assert.ok(selected.excerpt.omitted.length<=WORK_EXCERPT_LIMITS.spans+1);assert.ok(normalizeWorkExcerpt(selected.excerpt));
  assert.equal(normalizeWorkExcerpt({...selected.excerpt,body:'PRIVATE_BODY'}),null);
  assert.equal(normalizeWorkExcerpt({...selected.excerpt,spans:Array(33).fill({start:0,end:1})}),null);
  const forged={...selected.excerpt,includedChars:1,spans:[{start:0,end:1}],omitted:[{start:1,end:raw.length,reason:'budget'}]};
  assert.ok(normalizeWorkExcerpt(forged));assert.equal(restoreWorkExcerpt(raw,forged),null);
  const oversized=selectWorkExcerpt('字'.repeat(WORK_EXCERPT_LIMITS.inputChars+1));
  assert.equal(oversized.text,'');assert.equal(oversized.excerpt.omitted[0].reason,'source-too-large');assert.ok(normalizeWorkExcerpt(oversized.excerpt));
  assert.equal(restoreWorkExcerpt('字'.repeat(WORK_EXCERPT_LIMITS.inputChars+1),oversized.excerpt),null,'unfingerprinted omitted bodies cannot be certified as a past quote');
});
