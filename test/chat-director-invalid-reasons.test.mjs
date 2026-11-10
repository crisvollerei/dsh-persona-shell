import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

let definition;
vm.runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),{
  window:{__ModuleLoader__:{load(value){definition=value;}}},setTimeout(){return 1;},clearTimeout(){},console,URLSearchParams,AbortController,
},{filename:'client.js'});
const React={createElement(){},memo:fn=>fn,useEffect(){}};
const {chatDirectorIssueReason:explain}=definition.factory(id=>{if(id==='react')return React;throw Error('unused module '+id);}).__testing;

test('director UI explains every stable failure category without printing the raw model result',()=>{
  const reasons=['wire-type','wire-size','control','json','duplicate-key','shape','choice','goal','actor','event','evidence','stale-event','author',
    'normal-ineligible','peer-ineligible','peer-call','non-stop','too-long','tool-call'];
  for(const reason of reasons){const label=explain({code:'invalid',reason,wire:'PRIVATE_RAW_MODEL_TEXT'});
    assert.equal(typeof label,'string');assert.notEqual(label,'接话安排未通过校验',reason);assert.doesNotMatch(label,/PRIVATE_RAW_MODEL_TEXT/);}
  assert.match(explain({code:'invalid',reason:'choice'}),/本次候选/);
  assert.match(explain({code:'invalid',reason:'stale-event'}),/已经处理/);
  assert.match(explain({code:'invalid',reason:'non-stop'}),/未完整结束/);
});

test('unknown reasons, provider text and prototype keys use safe code-level fallbacks',()=>{
  for(const reason of ['<script>PRIVATE_TOKEN</script>','toString','constructor','__proto__',{},null]){
    assert.equal(explain({code:'invalid',reason,finish:'SECRET_PROVIDER_VALUE'}),'接话安排未通过校验');
    assert.equal(explain({code:'timeout',reason}),'调度判断超时');
  }
  assert.equal(explain({code:'unavailable',reason:'unrecognized-model-error'}),'调度调用暂不可用');
  assert.equal(explain({code:'constructor',reason:'__proto__'}),'调度未完成');
  assert.equal(explain(undefined),'调度未完成');
});

test('specific stable reasons take priority while finish metadata never becomes displayed text',()=>{
  assert.equal(explain({code:'invalid',reason:'tool-call',finish:'tool-calls'}),'调度返回了不支持的工具请求');
  assert.equal(explain({code:'invalid',reason:'goal',finish:'stop'}),'接话目标未能识别');
  assert.equal(explain({code:'invalid',finish:'aborted'}),'接话安排未通过校验');
});
