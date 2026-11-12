import test from 'node:test';
import assert from 'node:assert/strict';
import { domain, fixture, flush, reply, directorReply, preference, newRoom, roomSend, settledRoom, readChatInput } from './helpers/persona-chat-host.mjs';

const textOf = call => call.messages[0].content.find(block => block.type === 'text').text;
const output = text => (async function* () {
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const generated = () => ({ name: '渠道验收角色', identity: '独立角色，自称「吾」。',
  narration: { mode: 'voice', assistant: '原助手' }, report: ['REPORT_RULE：事实、条件与工作归属保留。'],
  voice: ['REPORT_VOICE：讲清原报告。'], samples: ['REPORT_SAMPLE：设备尚未验证。'],
  avoid: ['不替用户决定或补写感受。'], address: { user: '您', subagent: '协作者' },
  chat: { voice: ['CHAT_VOICE：留意日常细节，表达自己的选择。'], samples: [],
    dialogueExamples: [{ turns: [{ speaker: 'user', text: 'FICTIONAL_DAILY_NOT_MEMORY' },
      { speaker: 'self', text: '虚构的个人偏好。' }] }],
    workDialogueExamples: [{ turns: [{ speaker: 'user', text: 'FICTIONAL_WORK_NOT_REPORT' },
      { speaker: 'self', text: '虚构的讨论，不是实际核验。' }] }] } });

async function save(f, pack = generated(), name = pack.name) {
  const result = await f.request('presets', { action: 'save', name, pack });
  assert.equal(result.status, 200);
  return result.value.presets.find(value => value.name === name);
}
const selected = async f => {
  const state = (await f.request('presets')).value;
  return state.presets.find(value => value.name === state.active);
};
function formalReport(f, id, text) {
  const session = { id, header: {}, append() { assert.fail('expression cannot write source history'); } };
  f.bus.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  f.bus.emit('session/event', session, { type: 'assistant/message', seq: 2,
    data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } });
  f.bus.emit('session/event', session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } });
}

test('custom chat survives save, switching, restart and editing legacy fields with stable identity and private scope', async t => {
  const storage = domain(), first = fixture(t, { storage }); await first.ready();
  const card = generated(), saved = await save(first, card);
  assert.equal(saved.builtin, false); assert.equal(saved.character, undefined);
  assert.deepEqual(saved.pack.chat, card.chat);
  assert.equal(saved.pack.address.user, '您');
  await preference(first, 'PRIVATE_CUSTOM_STYLE', saved.id);
  await preference(first, 'PRIVATE_OTHER_STYLE', 'Claude小姐');
  const builtin = (await first.request('presets')).value.presets.find(value => value.builtin);
  assert.equal((await first.request('presets', { action: 'apply', id: builtin.id })).status, 200);
  assert.equal((await first.request('presets', { action: 'apply', id: saved.id })).status, 200);
  assert.deepEqual((await selected(first)).pack.chat, card.chat);
  assert.equal(first.requests.length, 0, 'save/apply and preference management never generate');
  await first.dispose();

  const second = fixture(t, { storage }); await second.ready();
  const restored = await selected(second);
  assert.equal(restored.id, saved.id); assert.equal(restored.builtin, false);
  assert.deepEqual(restored.pack.chat, card.chat);
  const changed = { ...restored.pack, voice: ['EDITED_REPORT_VOICE'], identity: '仍是同一自定义角色，自称「吾」。' };
  const edited = await second.request('settings', { pack: changed });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.value.settings.pack.chat, card.chat);
  assert.equal((await selected(second)).id, saved.id);
  assert.equal((await selected(second)).pack.address.user, '您');
  await second.dispose();

  const actors = [], third = fixture(t, { storage, script(call) {
    actors.push(call); return reply(['已接住当前用户原话。']);
  } }); await third.ready();
  const final = await selected(third);
  assert.equal(final.id, saved.id); assert.deepEqual(final.pack.chat, card.chat);
  assert.deepEqual(final.pack.voice, ['EDITED_REPORT_VOICE']);
  const room = await newRoom(third, [saved.id], '渠道持久化', 'durable-chat-profile');
  assert.equal((await roomSend(third, room, saved.id, 'REAL_CURRENT_USER_MESSAGE')).status, 200);
  const state = await settledRoom(third, room);
  assert.equal(actors.length, 1);
  assert.match(actors[0].system, /CHAT_VOICE/);
  assert.match(actors[0].system, /PRIVATE_CUSTOM_STYLE/);
  assert.doesNotMatch(actors[0].system, /PRIVATE_OTHER_STYLE|EDITED_REPORT_VOICE|REPORT_SAMPLE|REPORT_RULE/);
  assert.doesNotMatch(JSON.stringify(state.room), /FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT/);
  const memory = (await third.request('memory')).value;
  assert.doesNotMatch(JSON.stringify(memory), /FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT/);
  for (const call of third.directors) assert.doesNotMatch(JSON.stringify(call),
    /PRIVATE_CUSTOM_STYLE|PRIVATE_OTHER_STYLE|FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT/);
});

test('generate returns a preview only, then explicit save enables independent chat and report requests', async t => {
  const sourcePrompt = 'GENERATOR_SOURCE_ONLY：原创角色，自称吾，称呼用户为您，日常喜欢不规则的小物件，工作转述保留原始事实。';
  const card = generated();
  card.chat.dialogueExamples[0].turns.push({speaker:'user',text:'那先留着这个想法。'});
  card.chat.dialogueExamples.push({turns:[{speaker:'user',text:'今天先听雨？'},{speaker:'self',text:'好，先听这一阵。'},{speaker:'user',text:'嗯。'}]});
  card.chat.workDialogueExamples[0].turns.push({speaker:'user',text:'先保留未知。'});
  const records=[['persona',1],['name',card.name],['identity',card.identity],['narration','voice','原助手'],['address','您','协作者'],
    ...card.report.map(line=>['report',line]),...card.voice.map(line=>['voice',line]),['sample','REPORT_SAMPLE：设备尚未验证。','REPORT_SAMPLE：设备还没验证。'],
    ...card.avoid.map(line=>['avoid',line]),...card.chat.voice.map(line=>['chat_voice',line]),
    ...card.chat.dialogueExamples.flatMap((group,index)=>group.turns.map(turn=>['daily',index,turn.speaker,turn.text])),
    ...card.chat.workDialogueExamples.flatMap((group,index)=>group.turns.map(turn=>['work',index,turn.speaker,turn.text])),['end']];
  const expectedChat={...card.chat,source:{text:sourcePrompt,identity:card.identity,voice:[...card.chat.voice],enabled:true}};
  const extractions = [], reports = [], actors = [];
  const f = fixture(t, { directorScript(call) {
    // Channel routing is under test; a known work session must not make the
    // fixture's default source selector turn this personal question into work.
    const input = readChatInput(call), events = input.events ?? [];
    const index = events.findLastIndex(event => event.author.role === 'user'), event = events[index];
    const answered = events.slice(index + 1).some(value => value.author.role === 'assistant');
    const person = input.members[0];
    return directorReply({ work: 'not-needed', sourceIds: [], request: 'open', evidence: input.message.slice(0, 120) },
      event && !answered ? { id: person.id, kind: 'normal', to: 'user', evidence: {
        eventId: event.id, index: 0, text: event.messages[0] }, goal: '回应本人收到的个人偏好问题。' } : null);
  }, script(call) {
    if (textOf(call).includes('GENERATOR_SOURCE_ONLY')) { extractions.push(call); return output(records.map(record=>JSON.stringify(record)).join('\n')); }
    let input; try { input = readChatInput(call); } catch {}
    if (input?.task === 'chat-control') { actors.push(call); return reply(['本人回应当前提问。']); }
    reports.push(call);
    const source = textOf(call).split('待改写：\n').at(-1);
    assert.notEqual(source, textOf(call), 'formal request uses a distinct masked source');
    return output(source);
  } }); await f.ready();
  const before = (await f.request('presets')).value;
  const preview = await f.request('presets', { action: 'generate', prompt:sourcePrompt });
  assert.equal(preview.status, 200); assert.equal(preview.value.ok, true);
  assert.deepEqual(preview.value.preset.chat, expectedChat);
  assert.deepEqual((await f.request('presets')).value.presets, before.presets, 'generation alone never saves a card');
  assert.equal((await f.request('presets')).value.active, before.active);
  assert.equal(extractions.length, 1);
  assert.equal(reports.length + actors.length + f.directors.length, 0);

  const saved = await save(f, preview.value.preset);
  assert.equal(saved.builtin, false); assert.equal(saved.character, undefined);
  assert.deepEqual(saved.pack.chat, expectedChat);
  formalReport(f, 'channel-formal-report', '工作助手只完成了2项本地检查，设备尚未验证。');
  await flush();
  assert.equal(reports.length, 1);
  assert.match(reports[0].system, /REPORT_VOICE|REPORT_SAMPLE/);
  assert.doesNotMatch(JSON.stringify(reports[0]), /CHAT_VOICE|FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT|GENERATOR_SOURCE_ONLY/);
  const row = (await f.request('state?session=channel-formal-report')).value.rows[0];
  assert.equal(row.status, 'ready', row.reason);

  const room = await newRoom(f, [saved.id], '新生成角色', 'generated-chat-profile');
  await roomSend(f, room, saved.id, '我想听听你的个人偏好。');
  const state = await settledRoom(f, room);
  assert.equal(actors.length, 1);
  assert.match(actors[0].system, /CHAT_VOICE/);
  assert.match(actors[0].system, /FICTIONAL_DAILY_NOT_MEMORY/);
  assert.doesNotMatch(actors[0].system, /REPORT_VOICE|REPORT_SAMPLE|REPORT_RULE/);
  assert.doesNotMatch(JSON.stringify(actors[0].messages), /FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT/);
  assert.doesNotMatch(JSON.stringify(state.room), /FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT/);
});

test('opted-in real Host progress uses legacy report material rather than a custom chat override', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const session = { id: 'custom-progress-channel', header: {}, append() { assert.fail('notice cannot write workflow'); } };
  const agent = { session, status: 'running' }, notices = [];
  const f = fixture(t, { config: { progressNotices: true, progressMinutes: 1 },
    extraServices: [['agents', { get: id => id === session.id ? agent : undefined }]], script(call) {
      notices.push(call); return output('还没有收到新的正文汇报，先等消息。');
    } }); await f.ready();
  const saved = await save(f), current = (await f.request('conversation?session=' + session.id)).value;
  assert.equal((await f.request('conversation', { action: 'select', sessionId: session.id,
    revision: current.revision, personaId: saved.id, trigger: 'inherit' })).status, 200);
  let seq = 0;
  const event = (type, data) => f.bus.emit('session/event', session, { type, seq: ++seq, data });
  event('turn/start', { turn: 1 });
  event('tool/call', { turn: 1, callId: 'observed-tool', name: 'PRIVATE_TOOL_NAME', arguments: { secret: 'PRIVATE_TOOL_ARGUMENTS' } });
  for (let i = 0; i < 2; i++) {
    await f.request('state?session=' + session.id + '&viewing=1&viewer=custom-channel&viewRev=1');
    t.mock.timers.tick(30_000); await flush();
  }
  assert.equal(notices.length, 1);
  assert.match(notices[0].system, /REPORT_VOICE/);
  assert.match(notices[0].system, /REPORT_SAMPLE/);
  assert.doesNotMatch(JSON.stringify(notices[0]), /CHAT_VOICE|FICTIONAL_DAILY_NOT_MEMORY|FICTIONAL_WORK_NOT_REPORT|PRIVATE_TOOL_NAME|PRIVATE_TOOL_ARGUMENTS/);
  assert.equal(notices[0].tools, undefined);
  event('turn/end', { turn: 1 });
});
