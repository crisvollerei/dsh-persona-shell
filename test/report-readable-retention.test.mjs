import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, domain, jsonReply } from './helpers/persona-chat-host.mjs';
import { makeReportSource } from '../lib/report-visualization.js';
import { parseReportReadable } from '../lib/report-readable.js';

test('a heading without its following prose cannot replace it, even when both were submitted under one ref', async t => {
  const storage = domain(), rows = ['## 台账记录\n草稿已经整理。','附录已经排好顺序。'];
  const original = rows.join('\n\n'), previous = ['## 台账记录\n草稿已经整理好了。','附录已经排好了顺序。'];
  const output = texts => ({ schemaVersion: 3, blocks: texts.map((text, i) => ({ ref: 'b'+(i+1), text })) });
  let attempted = previous;
  const f = fixture(t, {storage, script: () => jsonReply(output(attempted))});
  await f.ready(); await f.request('settings', { enabled:false, memory:false });
  const id = 'heading-and-body', session = { id, header:{} };
  for(const [type,seq,data] of [['turn/start',9,{turn:1}],['assistant/message',10,{turn:1,message:{content:[{type:'text',text:original}]}}],['turn/end',11,{turn:1,reason:{kind:'completed'}}]])f.bus.emit('session/event',session,{type,seq,data});
  const src=(await get(f,id)).value.source;
  assert.deepEqual(src.blocks.map(b=>b.text.trim()),rows);
  const initial=await generate(f,src,'old');
  assert.deepEqual(initial.value.result.blocks.map(b=>b.text),previous);
  for(const [i,structural] of ['## 台账记录','台账记录\n===','---'].entries()){
    attempted=[structural];
    const failed=await generate(f,src,'heading-only-'+i,true);
    assert.equal(failed.status,422);assert.equal(failed.value.issue?.code,'readable-all-fallback');
  }
  await f.dispose();
  const reopened=fixture(t,{storage});await reopened.ready();
  const retained=(await get(reopened,id)).value;
  assert.deepEqual(retained.result,initial.value.result);assert.equal(retained.generatedAt,initial.value.generatedAt);
  assert.equal(retained.source.text,original);assert.equal(reopened.calls.length,0);
  for(const replacingDraft of [false,true]){
    const mixed=parseReportReadable(JSON.stringify(output(['## 台账记录',previous[1]])),src,{replacingDraft});
    assert.equal(mixed.ok,true);assert.equal(mixed.value.blocks[0].text,src.blocks[0].text);assert.equal(mixed.value.blocks[1].text,previous[1]);
    assert.deepEqual(mixed.warnings,[{code:'readable-block-original',path:'$.blocks[0].text'}]);
  }
  const only=makeReportSource({sessionId:id,seq:15,text:'## 附录'});
  assert.equal(parseReportReadable(JSON.stringify(output(['## 附录'])),only,{replacingDraft:true}).ok,true);
});

const sourceText = '草稿已经整理。\n\n附录列出 2 项。\n\n## 附表\n\n```sh\nnode --version\n```\n\n| 清单 |\n| --- |\n| 复核 |';
const first = ['草稿已经整理好了。', '附录列出了 2 项。'];
const get = (f, id) => f.request(`report-visualization?session=${id}&seq=10&presentation=readable`);
const generate = (f, source, requestId, regenerate = false) => f.request('report-visualization', {
  action: 'generate', presentation: 'readable', sessionId: source.sessionId, seq: source.seq, sourceHash: source.hash, requestId, regenerate,
});
async function open(f, id) {
  const session = { id, header: {} };
  for (const [type, seq, data] of [['turn/start', 9, { turn: 1 }],
    ['assistant/message', 10, { turn: 1, message: { content: [{ type: 'text', text: sourceText }] } }],
    ['turn/end', 11, { turn: 1, reason: { kind: 'completed' } }]]) f.bus.emit('session/event', session, { type, seq, data });
  return (await get(f, id)).value.source;
}
async function host(t, storage, transform) {
  const f = fixture(t, { storage, script: options => {
    const { blocks } = JSON.parse(options.messages[0].content[0].text).source;
    assert.deepEqual(blocks.map(b => b.verbatim), [false, false, false, true, true]);
    return jsonReply({ schemaVersion: 3, blocks: transform(blocks.map(({ ref, text }) => ({ ref, text }))) });
  } });
  await f.ready(); await f.request('settings', { enabled: false, memory: false }); return f;
}

test('regeneration retains the same-source readable draft across restart when no prose survived, even with valid code and table blocks', async t => {
  const storage = domain();
  let transform = blocks => blocks.map((b, i) => ({ ...b, text: first[i] ?? b.text }));
  const f = await host(t, storage, blocks => transform(blocks));
  const source = await open(f, 'prior'), previous = await generate(f, source, 'first');
  assert.equal(previous.status, 200); assert.deepEqual(previous.value.result.blocks.slice(0, 2).map(b => b.text), first);

  // Blank and omitted prose (wire fallback), followed by a valid heading, code and table.
  transform = blocks => [{ ...blocks[0], text: '' }, ...blocks.slice(2)];
  const failure = await generate(f, source, 'incomplete-prose', true);
  assert.equal(failure.status, 422);
  assert.deepEqual(failure.value, { error: 'report-invalid-output', issue: { code: 'readable-all-fallback', path: '$.blocks' } });
  assert.deepEqual(await generate(f, source, 'incomplete-prose', true), failure, 'a repeated request returns the same receipt');
  assert.equal(f.calls.length, 2);

  // A missing first paragraph and a second paragraph rejected only by the final content check.
  transform = blocks => [{ ...blocks[1], text: '附录列出 9 项。' }, ...blocks.slice(2)];
  assert.equal((await generate(f, source, 'wrong-number', true)).value.issue.code, 'readable-all-fallback');
  const other = await open(f, 'other'); assert.equal(other.hash, source.hash);
  const initial = await generate(f, other, 'initial-fallback', true);
  assert.equal(initial.status, 200, 'another session with the same content has no prior draft');
  assert.deepEqual(initial.value.result.blocks.slice(0, 2).map(b => b.text), other.blocks.slice(0, 2).map(b => b.text));
  assert.equal(initial.value.source.text, sourceText);
  assert.ok(initial.value.warnings.some(w => w.code === 'readable-block-original'));
  await f.dispose();

  const restarted = await host(t, storage, () => assert.fail('opening cached reports must not generate'));
  const restored = (await get(restarted, 'prior')).value;
  assert.deepEqual(restored.result, previous.value.result); assert.deepEqual(restored.warnings, previous.value.warnings);
  assert.equal(restored.generatedAt, previous.value.generatedAt); assert.deepEqual(restored.source, source);
  assert.deepEqual((await get(restarted, 'other')).value.result, initial.value.result); assert.equal(restarted.calls.length, 0);
});

test('a heading alongside prose or an ordinary list item still counts; standalone headings and dividers cannot mask fallback', () => {
  for (const [passage, expected] of [['## 结论\n草稿已整理。', true], ['- 草稿已整理。', true],
    ['## 结论', false], ['结论\n====', false], ['---', false]]) {
    const source = makeReportSource({ sessionId: 'structure', seq: 10, text: passage + '\n\n附录列出 2 项。' });
    const wire = JSON.stringify({ schemaVersion: 3, blocks: [{ ref: 'b1', text: passage }] });
    assert.equal(parseReportReadable(wire, source, { replacingDraft: true }).ok, expected, passage);
  }
});

test('after a failed regeneration a new request may save mixed results, including a valid unchanged prose block', async t => {
  let transform = blocks => blocks.map((b, i) => ({ ...b, text: first[i] ?? b.text }));
  const f = await host(t, domain(), blocks => transform(blocks));
  const source = await open(f, 'retry'); assert.equal((await generate(f, source, 'first')).status, 200);
  transform = blocks => blocks.slice(2);
  assert.equal((await generate(f, source, 'failed-attempt', true)).status, 422);
  transform = blocks => [blocks[0], ...blocks.slice(2)];
  const same = await generate(f, source, 'retry-verbatim-prose', true);
  assert.equal(same.status, 200); assert.deepEqual(same.value.result.blocks.map(b => b.text.trim()), source.blocks.map(b => b.text.trim()));
  assert.deepEqual(same.value.warnings.filter(w => w.code === 'readable-block-original').map(w => w.path), ['$.blocks[1].text']);
  transform = blocks => [{ ...blocks[0], text: '草稿现已整理妥当。' }, ...blocks.slice(2)];
  const mixed = await generate(f, source, 'retry-edited-prose', true);
  assert.equal(mixed.status, 200); assert.equal(mixed.value.result.blocks[0].text, '草稿现已整理妥当。');
  assert.equal(mixed.value.result.blocks[1].text, source.blocks[1].text);
  assert.deepEqual((await get(f, 'retry')).value.result, mixed.value.result); assert.equal(f.calls.length, 4);
});
