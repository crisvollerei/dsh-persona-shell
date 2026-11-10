import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, reply, newRoom, roomSend, settledRoom, whale, flush } from './helpers/persona-chat-host.mjs';

const input = options => readChatInput(options);
const draftReply = () => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ draft: '请先画草图；尚未确定的细节列为待确认。' }) };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const isDraft = options => input(options).task === 'work-instruction-draft';
const script = options => isDraft(options) ? draftReply() : reply(['先讨论布局。']);
const efforts = async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort:'low' } });
async function setup(t, extra = {}) {
  const f = fixture(t, { script, modelInfo: efforts, ...extra, config:{chatThinking:false,...extra.config} }); await f.ready();
  const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const info = (await f.request('chat-work-draft?room=' + encodeURIComponent(room.roomId))).value;
  const body = { action: 'generate', requestId: 'thinking-request', roomId: room.roomId, epoch: info.epoch, scopeKey: info.scopeKey,
    discussionRevision: info.discussionRevision, refs: [info.choices.find(q => q.ref.kind === 'user').ref], instruction: '整理结论' };
  return { f, room, info, body };
}
const generate = (f, body) => f.request('chat-work-draft', body);

test('the draft catalog exposes the current chat thinking default without starting a new call', async t => {
  const { f, room, info } = await setup(t); assert.equal(info.thinking, false);
  const before = f.calls.length; await f.request('settings', { chatThinking: true });
  const next = await f.request('chat-work-draft?room=' + encodeURIComponent(room.roomId));
  assert.equal(next.value.thinking, true); assert.equal(f.calls.length, before);
});

test('enabling thinking for one conclusion selects the lowest enabled effort without changing chat defaults', async t => {
  const { f, body } = await setup(t), before = (await f.request('settings')).value.settings;
  const result = await generate(f, { ...body, thinking: true }); assert.equal(result.status, 200); assert.equal(result.value.thinking, true);
  assert.equal(f.calls.at(-1).reasoningEffort, 'low');
  assert.equal(result.value.thinkingStatus, 'enabled');
  assert.equal((await f.request('settings')).value.settings.chatThinking, before.chatThinking);
  assert.equal((await generate(f, { ...body, requestId: 'default-after-one-shot' })).status, 200);
  assert.equal(f.calls.at(-1).reasoningEffort, 'off');
});

test('a default-enabled chat is inherited while a one-shot false override stays local to that request', async t => {
  const { f, body, info } = await setup(t, { config: { chatThinking: true } }); assert.equal(info.thinking, true);
  const inherited = await generate(f, body); assert.equal(inherited.status, 200); assert.equal(inherited.value.thinking, true);
  assert.equal(f.calls.at(-1).reasoningEffort, 'low');
  const overridden = await generate(f, { ...body, requestId: 'explicit-off', thinking: false });
  assert.equal(overridden.status, 200); assert.equal(overridden.value.thinking, false); assert.equal(f.calls.at(-1).reasoningEffort, 'off');
  assert.equal((await f.request('settings')).value.settings.chatThinking, true);
});

test('thinking participates in request identity so a reused id cannot silently retrieve a different conclusion policy', async t => {
  const { f, body } = await setup(t);
  assert.equal((await generate(f, { ...body, thinking: true })).status, 200); const before = f.calls.length;
  assert.equal((await generate(f, { ...body, thinking: true })).status, 200); assert.equal(f.calls.length, before);
  assert.equal((await generate(f, { ...body, thinking: false })).status, 409); assert.equal(f.calls.length, before);
  const noOverride = { ...body, requestId: 'inherited-identity' }; assert.equal((await generate(f, noOverride)).status, 200);
  await f.request('settings', { chatThinking: true });
  assert.equal((await generate(f, noOverride)).status, 409);
});

test('nonboolean per-request thinking is rejected before dispatch', async t => {
  const { f, body } = await setup(t), before = f.calls.length;
  for (const thinking of ['true', 1, null, {}]) assert.equal((await generate(f, { ...body, thinking })).status, 400);
  assert.equal(f.calls.length, before);
});

test('one-shot thinking preserves provider compatibility fallback and counts both actual attempts', async t => {
  let rejected = false;
  const { f, body } = await setup(t, { script: options => {
    if (isDraft(options) && options.reasoningEffort === 'low' && !rejected) { rejected = true; throw Object.assign(Error('typed rejection'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); }
    return script(options);
  } });
  const result = await generate(f, { ...body, thinking: true }); assert.equal(result.status, 200); assert.equal(result.value.thinking, true);
  const calls = f.calls.filter(isDraft); assert.equal(calls.length, 2); assert.equal(calls[0].reasoningEffort, 'low'); assert.equal(calls[1].reasoningEffort, undefined);
  assert.equal((await f.request('model-usage')).value.purposes.find(p => p.purpose === 'chat-draft').calls, 2);
});

test('unknown thinking capabilities use provider defaults without inventing effort aliases', async t => {
  const { f, body } = await setup(t, { modelInfo: undefined });
  const result = await generate(f, { ...body, thinking: true }); assert.equal(result.status, 200); assert.equal(result.value.thinking, true);
  assert.equal(result.value.thinkingStatus, 'unknown'); assert.equal(f.calls.at(-1).reasoningEffort, undefined); assert.equal((await f.request('settings')).value.settings.chatThinking, false);
});

test('a model that only exposes off cannot report a requested conclusion as thought-enabled', async t => {
  const { f, body } = await setup(t, { modelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }) });
  const result = await generate(f, { ...body, thinking: true });
  assert.equal(result.status, 200); assert.equal(result.value.thinking, true); assert.equal(result.value.thinkingStatus, 'unavailable');
  assert.equal(f.calls.at(-1).reasoningEffort, 'off');
});

test('a conclusion freezes its selected thinking policy while unrelated default settings change', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const { f, body } = await setup(t, { script: options => isDraft(options) ? (async function* () { await gate; yield* draftReply(); })() : script(options) });
  const pending = generate(f, body); await flush(); assert.equal(f.calls.at(-1).reasoningEffort, 'off');
  await f.request('settings', { chatThinking: true }); release();
  const result = await pending; assert.equal(result.status, 200); assert.equal(result.value.thinking, false);
  assert.equal(result.value.thinkingStatus, 'off'); assert.equal((await f.request('settings')).value.settings.chatThinking, true);
});

test('a thinking-enabled conclusion stays frozen when defaults turn off and never exposes thought deltas', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const { f, body } = await setup(t, { config: { chatThinking: true }, script: options => isDraft(options) ? (async function* () {
    yield { type: 'thinking-delta', text: 'PRIVATE_CONCLUSION_REASONING_NEVER_SHOW' }; await gate; yield* draftReply();
  })() : script(options) });
  const pending = generate(f, body); await flush(); const call = f.calls.at(-1); assert.equal(call.reasoningEffort, 'low');
  await f.request('settings', { chatThinking: false }); assert.equal(call.signal.aborted, false); release();
  const result = await pending; assert.equal(result.status, 200); assert.equal(result.value.thinking, true); assert.equal(result.value.thinkingStatus, 'enabled');
  assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE_CONCLUSION_REASONING_NEVER_SHOW/);
  assert.equal((await f.request('settings')).value.settings.chatThinking, false);
});
