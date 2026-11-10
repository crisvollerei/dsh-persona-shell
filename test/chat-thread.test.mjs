import test from 'node:test';
import assert from 'node:assert/strict';
import { chatThreadNotes } from '../lib/chat-thread.js';
import { quoteKey } from '../lib/chat-quote.js';

const scope = { roomId: 'room', generation: 2 };
const recipients = [{ id: 'b', name: '乙' }, { id: 'a', name: '甲' }];
const turn = (n, user = '聊另一件事', assistant = [], extra = {}) => ({ id: 'turn-' + n, messageId: 'message-' + n,
  attemptId: 'attempt-' + n, user, assistant, status: 'ready', recipientId: 'a', speakerName: '甲', recipients, ...extra });
const notes = (history, message = '草图', extra = {}) => chatThreadNotes(history, message, 0, { ...scope, ...extra });
const assistantRef = (n, index = 0) => ({ ...scope, kind: 'assistant', turnId: 'turn-' + n, attemptId: 'attempt-' + n, index });

test('older completed statements, suggestions and jokes are available as exact public quotes', () => {
  const bubbles = ['草图暂时保留。', '草图可以先画，不急着动工程。', '草图今天先当一块占位小饼干。'];
  const result = notes([turn(1, '换个话题', bubbles)]);
  assert.deepEqual(result.map(note => note.quote), bubbles);
  assert.ok(result.every(note => note.author.role === 'assistant' && note.author.id === 'a' && note.author.name === '甲'));
  assert.deepEqual(result.map(note => note.ref.index), [0, 1, 2]);
  assert.ok(result.every(note => note.messageId === 'message-1'));
  assert.ok(result.every(note => !Object.hasOwn(note, 'decision') && !Object.hasOwn(note, 'commitment') && !Object.hasOwn(note, 'status')));
});

test('negation and correction remain in their complete original statements without invented acceptance', () => {
  const user = '不是要删草图。我改口了，草图先保留，不代表确认采用。';
  const correction = '我刚才说错了：草图不是已完成，只是候选；先别执行。';
  const result = notes([turn(1, user, [correction])]);
  assert.deepEqual(result.map(note => note.quote), [user, correction]);
  assert.deepEqual(result[0].author, { role: 'user' });
  assert.deepEqual(result[0].ref, { ...scope, kind: 'user', messageId: 'message-1' });
  assert.deepEqual(result[1].ref, assistantRef(1));
  const tooLong = '草图' + '这是完整原话'.repeat(45) + '，最后更正：不要执行。';
  assert.ok(tooLong.length > 240);
  assert.deepEqual(notes([turn(2, tooLong, [tooLong])]), []);
});

test('real bubble indexes remain correct even when identical text appears more than once', () => {
  const repeated = '草图先放在这里，还没有采用。';
  const history = [turn(1, '说别的事', ['今晚吃米饭。', repeated, repeated])];
  const result = notes(history, '草图', { excluded: [assistantRef(1, 1)] });
  assert.equal(result.length, 1); assert.equal(result[0].quote, repeated);
  assert.deepEqual(result[0].ref, assistantRef(1, 2));
});

test('multiple personas retain their real authors, frozen recipients and separate original references', () => {
  const first = turn(1, '草图还没决定，先听听看法。', ['草图可以先画。']);
  const second = turn('1b', first.user, ['草图先留白，也是一种画法。'], {
    messageId: first.messageId, recipientId: 'b', speakerName: '乙' });
  const result = notes([first, second]);
  assert.deepEqual(result.map(note => note.author), [{ role: 'user' }, { role: 'assistant', id: 'a', name: '甲' }, { role: 'assistant', id: 'b', name: '乙' }]);
  assert.ok(result.every(note => JSON.stringify(note.recipients) === JSON.stringify(recipients)));
  assert.deepEqual(result.filter(note => note.author.role === 'assistant').map(note => note.ref.turnId), ['turn-1', 'turn-1b']);
  assert.equal(result[2].messageId, first.messageId);
});

test('failed, pending, interrupted and malformed speaker output cannot become room bookmarks', () => {
  for (const status of ['failed', 'pending', 'cancelled', 'interrupted']) assert.deepEqual(notes([turn(1, '说其他的', ['草图UNFINISHED'], { status })]), []);
  assert.deepEqual(notes([turn(1, '说其他的', ['草图NO_AUTHOR'], { recipientId: undefined })]), []);
  assert.deepEqual(notes([turn(1, '说其他的', ['草图NO_ATTEMPT'], { attemptId: undefined })]), []);
  assert.deepEqual(notes([turn(1, '说其他的', ['草图NO_NAME'], { speakerName: '' })]), []);
  assert.deepEqual(notes([turn(1, '说其他的', ['草图BAD_INDEX'], { assistant: Array(7).fill('草图重复。') })]).some(note => note.ref.index >= 6), false);
  // Accepted user words remain public even if the subsequent role response failed.
  const accepted = '草图我还没有决定。';
  assert.deepEqual(notes([turn(1, accepted, ['草图UNFINISHED'], { status: 'failed' })]).map(note => note.quote), [accepted]);
});

test('unrelated small talk cannot retrieve old work merely through time or conversational filler', () => {
  const history = [turn(1, '今天部署代码还有报错。', ['现在可以检查部署日志，先别改代码。', '下午我们再看测试结果。'])];
  for (const message of ['今天聊聊晚饭吧', '下午好呀', '现在可以随便聊聊天吗', '晚饭想吃什么', 'hello, thanks'])
    assert.deepEqual(notes(history, message), [], message);
  assert.ok(notes(history, '部署日志的报错呢').some(note => note.quote === history[0].assistant[0]));
});

test('paused original refs stay excluded without suppressing a different author or generation', () => {
  const history = [turn(1, '草图我还没决定。', ['草图暂时保留。']), turn(2, '聊别的', ['草图先当个小饼干。'], { recipientId: 'b', speakerName: '乙' })];
  const paused = assistantRef(1);
  const result = notes(history, '草图', { excluded: [paused, null, { invalid: true }] });
  assert.ok(!result.some(note => quoteKey(note.ref) === quoteKey(paused)));
  assert.ok(result.some(note => note.author.role === 'user')); assert.ok(result.some(note => note.author.id === 'b'));
  const otherGeneration = notes(history, '草图', { excluded: [{ ...paused, generation: 1 }] });
  assert.ok(otherGeneration.some(note => quoteKey(note.ref) === quoteKey(paused)));
});

test('selection budgets count selected complete quotes and skip a large candidate to fit another relevant one', () => {
  const history = [turn(0, '说别的', ['草图' + '短'.repeat(98)]), turn(1, '说别的', ['草图' + '次'.repeat(218)]),
    ...[2, 3, 4].map(n => turn(n, '说别的', ['草图' + '长'.repeat(228)]))];
  const result = notes(history);
  assert.equal(result.length, 4); assert.equal(result.reduce((sum, note) => sum + note.quote.length, 0), 790);
  assert.deepEqual(result.map(note => note.messageId), ['message-0', 'message-2', 'message-3', 'message-4']);
  assert.ok(result.every(note => note.quote === history.find(item => item.messageId === note.messageId).assistant[0]));
});

test('equal relevance favors newer original messages while returning selected notes in original conversation order', () => {
  const history = Array.from({ length: 9 }, (_, n) => turn(n, '换话题', ['草图' + '甲'.repeat(n + 3)]));
  const result = notes(history);
  assert.equal(result.length, 4); assert.deepEqual(result.map(note => note.messageId), ['message-5', 'message-6', 'message-7', 'message-8']);
  const stronger = turn('old', '换话题', ['草图布局先保留。']);
  assert.ok(notes([stronger, ...history], '草图布局').some(note => note.messageId === stronger.messageId));
});

test('recent exclusion counts user-message groups rather than individual persona responses', () => {
  const first = turn(1, '草图还没定。', ['草图暂时保留。']);
  const second = turn('1b', first.user, ['草图留个位置。'], { messageId: first.messageId, recipientId: 'b', speakerName: '乙' });
  const history = [first, second, ...Array.from({ length: 8 }, (_, n) => turn(n + 2, '说别的事情', ['不相关的公开回应。']))];
  const result = chatThreadNotes(history, '草图', 8, scope);
  assert.equal(result.length, 3); assert.ok(result.every(note => note.messageId === first.messageId));
  assert.deepEqual(chatThreadNotes(history.slice(0, -1), '草图', 8, scope), []);
});

test('a short explicit continuation can use only the recent public topic as a weak anchor', () => {
  const history = [turn(0, '旧的部署先放着。', ['部署需要核对日志。']), turn(1, '草图先保留。', ['草图只是候选。']),
    turn(2, '后来聊别的', ['先到这里。']), turn(3, '草图怎么处理', ['先留白。'])];
  const result = chatThreadNotes(history, '继续', 2, scope);
  assert.ok(result.some(note => note.messageId === 'message-1'));
  assert.ok(!result.some(note => note.messageId === 'message-0'));
});

test('an explicit older topic does not import the unrelated recent work topic as extra weak matches', () => {
  const history = [turn(0, '草图还没有决定。', ['草图暂时保留。']), turn(1, '部署日志还在报错。', ['部署日志要另行核对。']),
    turn(2, '刚才在看部署日志', ['先看错误条件。']), turn(3, '部署日志还要再看', ['只保留公开记录。'])];
  const result = chatThreadNotes(history, '之前那个草图', 2, scope);
  assert.ok(result.length > 0); assert.ok(result.every(note => note.messageId === 'message-0'));
});
