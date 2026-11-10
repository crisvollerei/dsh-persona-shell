import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextSelectionPrompt, parseContextSelection, contextSelectionFallback, publicCoordinationHistory, explicitContextSelection } from '../lib/chat-coordinator.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { buildParticipationPrompt } from '../lib/chat-participation.js';
import { readChatInput } from './helpers/chat-input.mjs';

const pack = { identity: '当前人格', voice: ['自然聊天'], samples: [], avoid: [], address: { user: '你' } };
const user = readChatInput;
const wire = prompt => JSON.stringify(prompt.messages ?? prompt.user);
const selection = (extra = {}) => ({ work: 'required', sourceIds: ['work-a'], request: 'answer', evidence: '部署怎么样', ...extra });
const parse = (value, message = '部署怎么样？') => parseContextSelection(JSON.stringify(value), ['work-a', 'work-b'], message);
const historyTurn = (n, extra = {}) => ({ id: 'turn-' + n, messageId: 'message-' + n, attemptId: 'attempt-' + n,
  roomId: 'room', scopeKey: null, user: '公开用户原话' + n,
  recipientId: 'a', speakerName: '甲', recipients: [{ id: 'a', name: '甲' }], status: 'ready', assistant: ['公开回复' + n], ...extra });
const prompt = extra => buildChatPrompt({ pack, history: [], message: '随便聊聊', roomId: 'room', generation: 0, ...extra });

test('context selection accepts only authorized sources with direct current-word evidence', () => {
  assert.deepEqual(parse(selection()), { ...selection(), basis: 'model' });
  assert.deepEqual(parse(selection({ sourceIds: ['work-b', 'work-a'] })).sourceIds, ['work-b', 'work-a']);
  assert.deepEqual(parse(selection({ work: 'not-needed', sourceIds: [], request: 'open', evidence: '' })),
    { work: 'not-needed', sourceIds: [], request: 'open', evidence: '', basis: 'model' });
  const unclear = parse(selection({ work: 'unclear', sourceIds: [], request: 'unclear', evidence: '' }));
  assert.equal(unclear.basis, 'model'); assert.notDeepEqual(unclear, contextSelectionFallback());
  assert.deepEqual(contextSelectionFallback('timeout'), { work: 'unclear', sourceIds: [], request: 'unclear', evidence: '', basis: 'timeout' });
});

test('malformed, truncated and authority-expanding selections all withhold work material', () => {
  const invalid = [null, [], {}, selection({ work: 'maybe' }), selection({ request: 'execute' }),
    selection({ sourceIds: ['not-attached'] }), selection({ sourceIds: ['work-a', 'work-a'] }), selection({ sourceIds: [] }),
    selection({ sourceIds: [1] }), selection({ sourceIds: 'work-a' }), selection({ evidence: '' }), selection({ evidence: '历史中才说过的' }),
    selection({ evidence: '  ' }), selection({ evidence: 1 }), selection({ work: 'not-needed' }), selection({ work: 'unclear' }),
    selection({ confidence: 0.9 }), selection({ basis: 'model' }), { ...selection(), __proto__: 'not-an-own-field', injected: true }];
  for (const value of invalid) assert.deepEqual(parse(value), contextSelectionFallback(), JSON.stringify(value));
  for (const wire of ['broken', '{"work":"required"', '```json\n' + JSON.stringify(selection()) + '\n```',
    JSON.stringify(selection()) + ' trailing', JSON.stringify(selection()).replace('"work":"required"', '"work":"unclear","work":"required"'),
    JSON.stringify(selection()).replace('"work":"required"', '"w\\u006frk":"unclear","work":"required"')])
    assert.deepEqual(parseContextSelection(wire, ['work-a'], '部署怎么样？'), contextSelectionFallback(), wire);
  assert.deepEqual(parseContextSelection(' '.repeat(8193), ['work-a'], '部署怎么样？'), contextSelectionFallback());
});

test('explicit request categories need evidence without turning an open sentence into authorization', () => {
  for (const request of ['answer', 'advice', 'listen']) {
    assert.deepEqual(parse(selection({ work: 'not-needed', sourceIds: [], request, evidence: '' })), contextSelectionFallback());
    assert.equal(parse(selection({ work: 'not-needed', sourceIds: [], request })).request, request);
  }
  assert.equal(parse(selection({ work: 'not-needed', sourceIds: [], request: 'open', evidence: '' })).request, 'open');
});

test('only complete supported commands veto work references for this message without guessing quoted or mixed intent', () => {
  for (const message of ['先不聊工作了', '今天别谈代码', '这次只闲聊', '  暂时不谈工作。 ', '现在就聊聊天吧！'])
    assert.deepEqual(explicitContextSelection(message), { work: 'not-needed', sourceIds: [], request: 'open', evidence: message, basis: 'explicit' });
  for (const message of ['“先不聊工作了”', '他说先不聊工作了', '如果今天别谈代码会怎样', '先不聊工作了，帮我看一下部署',
    '先不聊工作了？', '不聊工作是不是更好', '累了', '今天工作怎么样', '', undefined])
    assert.equal(explicitContextSelection(message), undefined, String(message));
});

test('the selector receives public words and source names, never work bodies or private persona state', () => {
  const result = buildContextSelectionPrompt({ message: '先不聊工作', history: [historyTurn(1, { privateMemory: 'PRIVATE_MEMORY',
    pack: { identity: 'PRIVATE_PERSONA' }, source: { report: 'WORK_BODY' } })],
    quotedMessage: { author: { role: 'assistant', id: 'a', name: '甲', memory: 'PRIVATE_QUOTE' }, text: '公开被引用原话', ref: { secret: 'PRIVATE_REF' } },
    sources: [{ id: 'work-a', name: '部署项目', projectName: '文件夹', primary: true, available: true,
      goal: 'WORK_GOAL', report: 'WORK_BODY', previousReport: 'OLD_WORK', tools: ['TOOL_SECRET'], filePath: 'PATH_SECRET' }],
    memory: ['PRIVATE_MEMORY'], pack: { identity: 'PRIVATE_PERSONA' } });
  const value = user(result);
  assert.equal(value.task, 'chat-context-selection');
  assert.deepEqual(value.sources, [{ id: 'work-a', name: '部署项目', projectName: '文件夹', primary: true, available: true }]);
  assert.equal(value.history[0].responses[0].messages[0], '公开回复1');
  assert.deepEqual(value.quotedMessage, { author: { role: 'assistant', id: 'a', name: '甲' }, text: '公开被引用原话' });
  assert.doesNotMatch(result.user + result.system, /PRIVATE_|WORK_BODY|WORK_GOAL|OLD_WORK|TOOL_SECRET|PATH_SECRET/);
  assert.match(result.system, /不推断用户心理/); assert.match(result.system, /不确定不等于必须追问/);
});

test('the same ambiguous sentence carries different public context instead of a keyword verdict', () => {
  const message = '那现在怎么办';
  const deployment = user(buildContextSelectionPrompt({ message, history: [historyTurn(1, { user: '刚才部署失败了', assistant: ['我们先看看失败条件。'] })],
    sources: [{ id: 'work-a', name: '部署项目' }] }));
  const dinner = user(buildContextSelectionPrompt({ message, history: [historyTurn(1, { user: '晚饭食材没有了', assistant: ['面条和米饭都吃完了。'] })],
    sources: [{ id: 'work-a', name: '部署项目' }] }));
  assert.equal(deployment.message, dinner.message);
  assert.equal(deployment.history[0].user, '刚才部署失败了'); assert.equal(dinner.history[0].user, '晚饭食材没有了');
  assert.deepEqual(parseContextSelection(JSON.stringify(selection({ evidence: message })), ['work-a'], message).sourceIds, ['work-a']);
  assert.equal(parseContextSelection(JSON.stringify(selection({ work: 'not-needed', sourceIds: [], evidence: message })), ['work-a'], message).work, 'not-needed');
  // This verifies the available context and protocol, not a model's semantic accuracy.
});

test('public coordinator history keeps complete grouped turns and excludes failed or pending assistant output', () => {
  const history = [historyTurn(1), historyTurn(1, { id: 'second', recipientId: 'b', speakerName: '乙', assistant: ['同轮乙的原话'] }),
    historyTurn(2, { status: 'failed', assistant: ['FAILED_OUTPUT'] }), historyTurn(3, { status: 'pending', assistant: ['STREAMING_OUTPUT'] })];
  const projected = publicCoordinationHistory(history);
  assert.equal(projected.length, 3); assert.deepEqual(projected[0].responses.map(reply => reply.speaker.id), ['a', 'b']);
  assert.deepEqual(projected.slice(1).map(entry => entry.responses), [[], []]);
  assert.doesNotMatch(JSON.stringify(projected), /FAILED_OUTPUT|STREAMING_OUTPUT/);
  assert.equal(publicCoordinationHistory(Array.from({ length: 10 }, (_, n) => historyTurn(n))).length, 4);
  const long = publicCoordinationHistory([historyTurn(1), historyTurn(2, { user: '原'.repeat(2700), assistant: ['完整句'] })]);
  assert.equal(long.at(-1).user.length, 2700); assert.ok(JSON.stringify(long).includes('完整句'));
  assert.deepEqual(publicCoordinationHistory([historyTurn(1, { user: '原'.repeat(3001) })]), []);
});

test('source catalog is a bounded unique metadata projection', () => {
  const values = Array.from({ length: 20 }, (_, i) => ({ id: 'source-' + i, name: '工作' + i }));
  const sources = user(buildContextSelectionPrompt({ message: '现在呢', sources: [{ id: 'bad', name: '' }, values[0], values[0], ...values] })).sources;
  assert.equal(sources.length, 6); assert.equal(new Set(sources.map(source => source.id)).size, 6);
});

test('chat uses only selected work sources and strips selector evidence and internal basis', () => {
  const coordination = { ...selection(), basis: 'model', evidence: 'EVIDENCE_NOT_A_CHAT_FIELD', confidence: 'NOT_A_PROBABILITY' };
  const result = prompt({ coordination, workContext: { key: 'scope', sources: [{ sessionId: 'work-a', report: 'SELECTED_REPORT' },
    { sessionId: 'work-b', report: 'UNSELECTED_REPORT' }] } });
  assert.deepEqual(user(result).coordination, { work: 'required', sourceIds: ['work-a'], request: 'answer' });
  assert.match(result.system, /progress 不是最终结果/); assert.match(wire(result), /SELECTED_REPORT/);
  assert.doesNotMatch(wire(result), /UNSELECTED_REPORT|EVIDENCE_NOT_A_CHAT_FIELD|NOT_A_PROBABILITY|"basis"/);
});

test('chat with no actual work selection has short access rules and does not assume a request for advice', () => {
  for (const extra of [{}, { workContext: { key: 'scope', sources: [] } }, { coordination: { work: 'unclear', sourceIds: [], request: 'unclear' },
    workContext: { sources: [{ sessionId: 'work-a', report: 'NOT_SELECTED' }] } }]) {
    const result = prompt(extra);
    assert.deepEqual(user(result).workContext, extra.workContext ? { ...(extra.workContext.key ? { key: extra.workContext.key } : {}), sources: [], omitted: [],
      referenceAccess: { attachedCount: 0, status: 'not-attached' }, sourceCatalog: [] } : undefined);
    assert.doesNotMatch(result.system, /goalHasAttachments|reportStatus|previousReport/);
    assert.doesNotMatch(wire(result), /NOT_SELECTED/); assert.match(result.system, /没有工具执行/);
    assert.match(result.system, /不把每次发言都组织成背景、理由、建议、追问和结尾/); assert.match(result.system, /够了就停/);
  }
});

const discussion = [{ id: 'topic', version: 1, title: '旧工作话题', status: 'proposal', reviewedBy: 'user-in-settings', source: {
  ref: { roomId: 'room', generation: 0, kind: 'user', messageId: 'message-0' }, author: { role: 'user', name: '我' }, text: '设置布局先画草图' }, evidence: null }];
const oldHistory = Array.from({ length: 10 }, (_, i) => historyTurn(i, { user: i ? '后来聊第' + i + '件事' : '设置布局先画草图，我还没决定。' }));

test('casual or listening turns skip old work reminders while retaining recent public context and explicit quotes', () => {
  const quotedMessage = { ref: { roomId: 'room', generation: 0, kind: 'user', messageId: 'message-9' },
    author: { role: 'user', name: '我' }, text: oldHistory[9].user };
  for (const request of ['open', 'listen', 'unclear']) {
    const result = user(prompt({ history: oldHistory, message: '设置布局先放着，陪我聊聊。', discussionState: discussion, quotedMessage,
      coordination: { work: 'not-needed', sourceIds: [], request } }));
    assert.deepEqual(result.roomNotes, []); assert.deepEqual(result.discussionState, []);
    assert.ok(result.history.length > 0); assert.deepEqual({ ref: result.quotedMessage.ref,
      author: result.quotedMessage.author, text: result.quotedMessage.text }, quotedMessage);
  }
});

test('a non-work question or advice request can still recall same-room original words without external work bodies', () => {
  for (const request of ['answer', 'advice']) {
    const result = user(prompt({ history: oldHistory, message: '上次设置布局的草图还记得吗？', discussionState: discussion,
      coordination: { work: 'not-needed', sourceIds: [], request }, workContext: { sources: [{ sessionId: 'work-a', report: 'WORK_BODY' }] } }));
    assert.ok(result.roomNotes.some(note => note.quote === oldHistory[0].user));
    assert.equal(result.discussionState.length, 1); assert.deepEqual(result.workContext, { sources: [], omitted: [],
      referenceAccess: { attachedCount: 0, status: 'not-attached' }, sourceCatalog: [] }); assert.doesNotMatch(JSON.stringify(result), /WORK_BODY/);
  }
  const legacy = user(prompt({ history: oldHistory, message: '上次设置布局的草图还记得吗？', discussionState: discussion }));
  assert.ok(legacy.roomNotes.length > 0); assert.equal(legacy.discussionState.length, 1);
});

test('failed or uncertain selection cannot revive old tasks while rooms without work sources can still recall their own words',()=>{
  for(const basis of ['invalid','timeout','unavailable','model']){
    const value=user(prompt({history:oldHistory,message:'布局先放着，聊点别的吧。',discussionState:discussion,
      coordination:{work:'unclear',sourceIds:[],request:'unclear',basis}}));
    assert.deepEqual(value.roomNotes,[]);assert.deepEqual(value.discussionState,[]);assert.ok(value.history.length>0);
  }
  const value=user(prompt({history:oldHistory,message:'上次设置布局的草图还记得吗？',discussionState:discussion,
    coordination:{work:'unclear',sourceIds:[],request:'unclear',basis:'no-sources'}}));
  assert.ok(value.roomNotes.length>0);assert.equal(value.discussionState.length,1);
});

test('listener judgement sees recent public context and finished exchange without gaining private state or work content', () => {
  const result = buildParticipationPrompt({ message: '那你呢', history: [historyTurn(1, { user: '刚才我们聊晚饭', privateMemory: 'PRIVATE_HISTORY' })],
    quotedMessage: { author: { role: 'assistant', id: 'a', name: '甲' }, text: '你爱吃面吗', memory: 'PRIVATE_QUOTE' },
    coordination: { work: 'not-needed', sourceIds: [], request: 'open', evidence: 'SECRET_EVIDENCE', basis: 'model' },
    exchange: [{ speaker: { id: 'a', name: '甲' }, messages: ['我喜欢汤面。'] }],
    candidates: [{ id: 'b', name: '乙', pack, memory: ['PRIVATE_CANDIDATE'] }], limit: 1, workContext: { report: 'WORK_BODY' } });
  const value = user(result);
  assert.equal(value.history[0].user, '刚才我们聊晚饭'); assert.equal(value.quotedMessage.author.id, 'a');
  assert.deepEqual(value.coordination, { work: 'not-needed', sourceIds: [], request: 'open' });
  assert.doesNotMatch(result.user, /PRIVATE_|SECRET_EVIDENCE|WORK_BODY/);
  assert.match(result.system, /现在实际完成的 exchange 再判断/);
});
