// Controlled Host calls verify prompt routing and data boundaries, not model naturalness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, normalizePack } from '../lib/pack.js';
import { resolvePersonaExpression } from '../lib/persona-expression.js';
import { mask, unmask } from '../lib/mask.js';
import { buildDirectorPrompt } from '../lib/chat-director.js';
import { fixture, flush, reply, preference, newRoom, roomSend, settledRoom, readChatInput } from './helpers/persona-chat-host.mjs';

const textOf = options => options.messages[0].content.find(block => block.type === 'text').text;
const output = text => (async function* () {
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const profile = (preset, channel) => resolvePersonaExpression(normalizePack(preset.pack), {
  channel, persona: { id: preset.id, builtin: true },
});

function channelFixture(t, options = {}) {
  const reports = [], actors = [], notices = [];
  const f = fixture(t, {
    modelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' } }),
    ...options,
    config:{chatThinking:false,...options.config},
    directorScript(call) {
      assert.equal(call.reasoningEffort, 'off', 'the controlled provider default high is explicitly overridden');
      const input = readChatInput(call), answered = new Set(input.events.filter(event => event.author.role === 'assistant').map(event => event.author.id));
      const choice = input.choices.find(value => !answered.has(value.id));
      return output(choice?.choiceId ?? 'WAIT');
    },
    script(call) {
      assert.equal(call.reasoningEffort, 'off', 'the controlled provider default high is explicitly overridden');
      if (call.system.startsWith('你是一个独立的状态播报员')) {
        notices.push(call); return output('还没有收到新的正文汇报，先等消息。');
      }
      let input; try { input = readChatInput(call); } catch {}
      if (input?.task === 'chat-control') {
        actors.push(call); return reply(['这是一条已完成的公开角色回应。']);
      }
      reports.push(call);
      const source = textOf(call).split('待改写：\n').at(-1);
      assert.notEqual(source, textOf(call), 'a formal report must carry its distinct masked source');
      return output(source);
    },
  });
  return { ...f, reports, actors, notices };
}

function reportSession(f, id) {
  const session = { id, header: {}, append() { assert.fail('the expression layer must not append to the source workflow'); } };
  let seq = 0, turn = 0;
  return {
    session,
    event(type, data) { f.bus.emit('session/event', session, { type, seq: ++seq, data }); },
    async report(text) {
      this.event('turn/start', { turn: ++turn });
      this.event('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } });
      const sourceSeq = seq;
      this.event('turn/end', { turn, reason: { kind: 'completed' } });
      await flush();
      const state = (await f.request('state?session=' + encodeURIComponent(id))).value;
      const row = state.rows.findLast(value => value.seq === sourceSeq);
      assert.ok(row, 'the Host publishes the source-bound row');
      assert.equal(row.status, 'ready', row.reason);
      assert.equal(row.final, true);
      assert.equal(row.text, text, 'the deterministic masked response is unmasked losslessly');
      return row;
    },
  };
}

async function applyPreset(f, id) {
  const result = await f.request('presets', { action: 'apply', id });
  assert.equal(result.status, 200);
}

function containsProfile(system, expression, fields = ['identity', 'voice', 'samples', 'avoid']) {
  for (const field of fields) for (const value of Array.isArray(expression[field]) ? expression[field] : [expression[field]])
    assert.ok(system.includes(value), `the actual request includes its ${field} material: ${value}`);
}

for (const preset of BUILTIN_PRESETS) test(`Host keeps ${preset.name} chat and formal report expression separate`, async t => {
  const f = channelFixture(t); await f.ready(); await applyPreset(f, preset.id);
  const work = reportSession(f, 'report-' + preset.id), source = '本轮只修改了 2 处本地配置；真实环境尚未验证，暂不推送。';
  await work.report(source);
  const binding = await newRoom(f, [preset.id], '分渠道核对', 'channel-' + preset.id);
  assert.equal((await roomSend(f, binding, preset.id, '今天想聊个小想法。')).status, 200);
  const room = (await settledRoom(f, binding)).room;
  assert.equal(room.turns.filter(turn => turn.assistant.length).length, 1);
  assert.equal(f.reports.length, 1); assert.equal(f.actors.length, 1);
  const report = profile(preset, 'report'), chat = profile(preset, 'chat');
  assert.notDeepEqual(chat.voice, report.voice); assert.notDeepEqual(chat.samples, report.samples);
  containsProfile(f.actors[0].system, chat); containsProfile(f.reports[0].system, report);
  for (const value of [...report.voice, ...report.samples, ...preset.pack.report]) assert.equal(f.actors[0].system.includes(value), false);
  for (const value of [...chat.voice, ...chat.samples]) assert.equal(f.reports[0].system.includes(value), false);
  assert.equal(textOf(f.reports[0]), '待改写：\n' + mask(source).masked);
  assert.equal(readChatInput(f.actors[0]).message, '今天想聊个小想法。');
  assert.doesNotMatch(JSON.stringify(f.actors[0].messages), /真实环境尚未验证|暂不推送/);
  await work.report('下一轮仅补充了本地检查，仍未部署；是否继续由用户确认。');
  assert.equal(f.reports.length, 2);
  containsProfile(f.reports[1].system, report);
  assert.doesNotMatch(JSON.stringify(f.reports[1]), /今天想聊个小想法|这是一条已完成的公开角色回应/,
    'neither the room transcript nor its completed actor response becomes formal report history');
});

test('formal relay reports keep complete masked literals, conditions and worker ownership with colloquial phrasing on or off', async t => {
  const preset = BUILTIN_PRESETS.find(value => value.pack.narration?.mode === 'relay');
  assert.ok(preset, 'the experimental relay persona is exercised through its real saved card');
  const f = channelFixture(t); await f.ready(); await applyPreset(f, preset.id);
  const source = '# 核对结果\n\n姐姐只修改了 2 处本地配置，其中 1 项尚未验证；这不代表已部署。\n\n- 只有用户确认后，姐姐才会运行 `npm run verify`。\n- 配置仍在 `./config/settings.json`，下一步由用户核对。\n- 风险：若权限不足，仍可能失败；参考 https://example.invalid/limits ，暂不推送。';
  const shielded = mask(source), work = reportSession(f, 'relay-report');
  for (const colloquialReports of [true, false]) {
    assert.equal((await f.request('settings', { colloquialReports })).status, 200);
    const row = await work.report(source), call = f.reports.at(-1);
    // A previous report can be included as a tone example, but the actual new source is identical.
    assert.equal(textOf(call).split('待改写：\n').at(-1), shielded.masked);
    assert.equal(unmask(textOf(call).split('待改写：\n').at(-1), shielded.literals), source);
    assert.equal(row.speaker.id, preset.id);
    assert.ok(call.system.includes('实际工作者称为 ' + JSON.stringify(preset.pack.narration.assistant)));
    assert.match(call.system, /保留原文动作的时态、条件、引语归属，不得把他人的工作认领为自己的成果/);
    assert.match(call.system, /保留数量、否定、范围、适用条件、风险、证据来源和不确定程度/);
    assert.match(call.system, /原样各保留一次，仍与对应事实、步骤和条件相连/);
    if (colloquialReports) assert.match(call.system, /本次开启口语化/);
    else {
      assert.match(call.system, /尽量贴近原文的书面句式和表达节奏/);
      assert.match(call.system, /仍保留人格措辞，不是停用改写或直接显示原文/);
      assert.doesNotMatch(call.system, /本次开启口语化/);
    }
  }
  assert.equal(f.reports.length, 2, 'turning off colloquial phrasing does not bypass the rewrite call');
});

test('saved custom cards retain their literal chat and report material without inheriting a lookalike builtin profile', async t => {
  const f = channelFixture(t); await f.ready();
  const card = {
    identity: 'CUSTOM_IDENTITY：名叫鲸鲸的原创角色。',
    report: ['CUSTOM_REPORT_ONLY：完整保留事实与条件。'],
    voice: ['CUSTOM_VOICE：慢一些，保留独特标点？！'],
    samples: ['CUSTOM_SAMPLE：这句话保持原样……'],
    avoid: ['CUSTOM_AVOID：不要替换我的用语。'],
    address: { user: 'CUSTOM_USER', subagent: 'CUSTOM_WORKER' },
    narration: { mode: 'relay', assistant: 'CUSTOM_ACTUAL_WORKER' },
  };
  const saved = await f.request('presets', { action: 'save', name: '大肥鱼（自定义）', pack: card });
  assert.equal(saved.status, 200);
  const preset = saved.value.presets.find(value => value.name === '大肥鱼（自定义）');
  assert.equal(preset.builtin, false); assert.deepEqual(preset.pack, card);
  const work = reportSession(f, 'custom-work'); await work.report('CUSTOM_ACTUAL_WORKER 本轮只在本地检查，尚未验证真实环境。');
  const binding = await newRoom(f, [preset.id], '自定义保留', 'custom-room');
  await roomSend(f, binding, preset.id, '聊聊一个新名字。'); await settledRoom(f, binding);
  assert.equal(f.actors.length, 1); assert.equal(f.reports.length, 1);
  for (const call of [f.actors[0], f.reports[0]]) {
    containsProfile(call.system, card);
    assert.ok(call.system.includes('CUSTOM_USER'));
    for (const builtin of BUILTIN_PRESETS) for (const value of profile(builtin, 'chat').voice)
      assert.equal(call.system.includes(value), false, 'custom content must not be expanded by names or appearance');
  }
  assert.equal(f.actors[0].system.includes(card.report[0]), false);
  assert.equal(f.actors[0].system.includes('CUSTOM_ACTUAL_WORKER'), false);
  assert.ok(f.reports[0].system.includes(card.report[0]));
  assert.ok(f.reports[0].system.includes('实际工作者称为 "CUSTOM_ACTUAL_WORKER"'));
  assert.deepEqual((await f.request('presets')).value.presets.find(value => value.id === preset.id).pack, card);
});

test('editing the default persona through Host settings retains the actual custom card and preserves the builtin', async t => {
  const f = channelFixture(t); await f.ready();
  const before = (await f.request('presets')).value, builtin = before.presets.find(value => value.id === BUILTIN_PRESETS[0].id);
  assert.equal(before.active, builtin.name);
  const card = {
    ...structuredClone(builtin.pack), identity: 'SETTINGS_CUSTOM_IDENTITY：从默认人格调整的独立身份。',
    voice: ['SETTINGS_CUSTOM_VOICE：原样保留的语气。'], samples: ['SETTINGS_CUSTOM_SAMPLE：这行不换成内置样例。'],
    report: ['SETTINGS_CUSTOM_REPORT：保留原文限制。'], address: { user: 'SETTINGS_CUSTOM_USER', subagent: 'SETTINGS_CUSTOM_AGENT' },
  };
  assert.equal((await f.request('settings', { pack: card })).status, 200);
  const saved = (await f.request('presets')).value, active = saved.presets.find(value => value.name === saved.active);
  assert.equal(active.builtin, false); assert.notEqual(active.id, builtin.id); assert.deepEqual(active.pack, card);
  assert.deepEqual(saved.presets.find(value => value.id === builtin.id).pack, builtin.pack, 'editing a builtin creates a separate persona');
  const row = await reportSession(f, 'settings-custom-default').report('本次只完成本地检查，未部署，仍需用户确认。');
  assert.equal(row.speaker.id, active.id); assert.equal(f.reports.length, 1);
  containsProfile(f.reports[0].system, card); assert.ok(f.reports[0].system.includes(card.report[0]));
  assert.ok(f.reports[0].system.includes('SETTINGS_CUSTOM_USER'));
  for (const sample of profile(BUILTIN_PRESETS[0], 'report').samples) assert.equal(f.reports[0].system.includes(sample), false);
});

test('the actual room director receives only public chat voice, while each actor retains its own private preference', async t => {
  const f = channelFixture(t); await f.ready();
  const members = BUILTIN_PRESETS.slice(0, 2);
  await preference(f, 'PRIVATE_FIRST_PERSONA_STYLE', members[0].id);
  await preference(f, 'PRIVATE_SECOND_PERSONA_STYLE', members[1].id);
  await preference(f, 'PRIVATE_ABSENT_PERSONA_STYLE', BUILTIN_PRESETS[2].id);
  const binding = await newRoom(f, members.map(value => value.id), '公开导演', 'director-privacy');
  const state = (await f.request('chat?room=' + encodeURIComponent(binding.roomId))).value;
  assert.equal((await f.request('chat-rooms', { action: 'update', roomId: binding.roomId, targetPersonaIds: members.map(value => value.id),
    revision: state.room.revision, epoch: state.epoch })).status, 200);
  await roomSend(f, binding, members[0].id, '两个名字你们更喜欢哪个？'); await settledRoom(f, binding);
  assert.equal(f.actors.length, 2); assert.ok(f.directors.length >= 2);
  for (const call of f.directors) {
    const material = JSON.stringify(call), input = readChatInput(call);
    assert.equal(input.task, 'chat-room-director');
    for (const preset of members) {
      const member = input.members.find(value => value.id === preset.id);
      assert.deepEqual(member.voice, profile(preset, 'chat').voice.slice(0, 2).map(value => value.slice(0, 80)));
      assert.equal(Object.hasOwn(member, 'pack'), false); assert.equal(Object.hasOwn(member, 'samples'), false);
      for (const sample of profile(preset, 'report').samples) assert.equal(material.includes(sample), false);
      for (const voice of profile(preset, 'report').voice) assert.equal(material.includes(voice), false);
    }
    assert.doesNotMatch(material, /PRIVATE_FIRST_PERSONA_STYLE|PRIVATE_SECOND_PERSONA_STYLE|PRIVATE_ABSENT_PERSONA_STYLE/);
  }
  for (const call of f.actors) {
    const id = readChatInput(call).speaker.id;
    assert.ok(call.system.includes(id === members[0].id ? 'PRIVATE_FIRST_PERSONA_STYLE' : 'PRIVATE_SECOND_PERSONA_STYLE'));
    assert.equal(call.system.includes(id === members[0].id ? 'PRIVATE_SECOND_PERSONA_STYLE' : 'PRIVATE_FIRST_PERSONA_STYLE'), false);
    assert.doesNotMatch(JSON.stringify(call), /PRIVATE_ABSENT_PERSONA_STYLE/);
  }
});

test('a stale builtin flag on an edited card does not grant the director builtin identity or relationships', () => {
  const preset = BUILTIN_PRESETS[0], edited = {
    ...structuredClone(preset.pack), identity: 'STALE_FLAG_CUSTOM_IDENTITY', voice: ['STALE_FLAG_CUSTOM_PUBLIC_VOICE'],
    samples: ['STALE_FLAG_SAMPLE_NOT_PUBLIC'], report: ['STALE_FLAG_REPORT_NOT_PUBLIC'],
  };
  const material = buildDirectorPrompt({ message: '随便聊聊', members: [{ id: preset.id, name: preset.name, builtin: true, pack: edited }] });
  const input = JSON.parse(material.user);
  assert.equal(input.members[0].identity, edited.identity);
  assert.deepEqual(input.members[0].voice, edited.voice);
  assert.equal(Object.hasOwn(input.members[0], 'preferredAddress'), false);
  assert.doesNotMatch(JSON.stringify(material), /STALE_FLAG_SAMPLE_NOT_PUBLIC|STALE_FLAG_REPORT_NOT_PUBLIC/);
  assert.equal(material.system.includes('小肥鱼是自己的亲妹妹'), false);
  assert.equal(material.system.includes(profile(preset, 'chat').identity), false);
});

test('opted-in Host progress uses the session-selected report profile and scoped memory with observation-only facts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const preset = BUILTIN_PRESETS.find(value => value.id === 'Claude小姐');
  const session = { id: 'progress-channel', header: {}, append() { assert.fail('progress is not a workflow message'); } };
  const agent = { session, status: 'running' };
  const f = channelFixture(t, { config: { progressNotices: true, progressMinutes: 1 },
    extraServices: [['agents', { get: id => id === session.id ? agent : undefined }]] });
  await f.ready(); await preference(f, 'PROGRESS_CLAUDE_PRIVATE_STYLE', preset.id);
  await preference(f, 'PROGRESS_OTHER_PRIVATE_STYLE', BUILTIN_PRESETS[0].id);
  const current = (await f.request('conversation?session=' + session.id)).value;
  assert.equal((await f.request('conversation', { action: 'select', sessionId: session.id,
    revision: current.revision, personaId: preset.id, trigger: 'inherit' })).status, 200);
  let seq = 0;
  const event = (type, data) => f.bus.emit('session/event', session, { type, seq: ++seq, data });
  event('turn/start', { turn: 1 });
  event('user/message', { turn: 1, content: [{ type: 'text', text: 'PRIVATE_WORK_REQUEST_NOT_FOR_NOTICE' }] });
  event('tool/call', { turn: 1, callId: 'observed-tool', name: 'PRIVATE_TOOL_NAME', arguments: { code: 'PRIVATE_TOOL_ARGUMENTS' } });
  for (let i = 0; i < 2; i++) {
    await f.request('state?session=' + session.id + '&viewing=1&viewer=channel-test&viewRev=1');
    t.mock.timers.tick(30_000); await flush();
  }
  const state = (await f.request('state?session=' + session.id)).value;
  assert.equal(f.notices.length, 1); assert.equal(f.reports.length, 0); assert.equal(f.actors.length, 0); assert.equal(f.directors.length, 0);
  assert.equal(state.rows.length, 0); assert.equal(state.progress.text, '还没有收到新的正文汇报，先等消息。');
  const call = f.notices[0], report = profile(preset, 'report');
  containsProfile(call.system, report, ['identity', 'voice', 'samples']);
  for (const value of preset.pack.report) assert.ok(call.system.includes(value));
  for (const value of [...profile(preset, 'chat').voice, ...profile(preset, 'chat').samples]) assert.equal(call.system.includes(value), false);
  assert.match(call.system, /PROGRESS_CLAUDE_PRIVATE_STYLE/); assert.doesNotMatch(JSON.stringify(call), /PROGRESS_OTHER_PRIVATE_STYLE|PRIVATE_WORK_REQUEST_NOT_FOR_NOTICE|PRIVATE_TOOL_NAME|PRIVATE_TOOL_ARGUMENTS/);
  assert.equal(call.messages.length, 1); assert.equal(call.messages[0].role, 'user'); assert.equal(call.tools, undefined);
  assert.match(textOf(call), /本轮已发起 1 次工具调用，收到 0 次返回/);
  assert.match(call.system, /工具已返回不等于任务成功/); assert.match(call.system, /不得推断任务内容、实际工作成果/);
  event('turn/end', { turn: 1 });
});
