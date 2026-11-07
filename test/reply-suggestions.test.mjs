import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplySuggestions, parseReplySuggestions } from '../lib/reply-suggestions.js';

test('suggestions are strictly bounded candidate user utterances', () => {
  assert.deepEqual(parseReplySuggestions('{"suggestions":["  再解释一下？  ","再解释一下？","换个角度呢？"]}'), ['再解释一下？', '换个角度呢？']);
  for (const value of [{ messages: ['wrong'] }, { suggestions: [] }, { suggestions: ['a'], send: true },
    { suggestions: [''] }, { suggestions: [123] }, { suggestions: Array(4).fill('a') }, { suggestions: ['长'.repeat(161)] }]) {
    assert.equal(parseReplySuggestions(JSON.stringify(value)), undefined);
  }
  assert.equal(parseReplySuggestions('{"suggestions":["截断'), undefined);
});

test('suggestion prompt retains the actual discussion and explicit requirement without impersonating the role', () => {
  const history = Array.from({ length: 10 }, (_, n) => ({ user: '用户' + n, assistant: ['角色' + n], status: n === 9 ? 'failed' : 'ready' }));
  const prompt = buildReplySuggestions({ name: '鲸鲸', history, instruction: '帮我追问一下实现成本，口语一点' });
  const data = JSON.parse(prompt.user);
  assert.equal(data.instruction, '帮我追问一下实现成本，口语一点');
  assert.equal(data.recipient, '鲸鲸'); assert.equal(data.history.length, 8);
  assert.equal(data.history[0].user, '用户2'); assert.deepEqual(data.history.at(-1).assistant, []);
  assert.match(prompt.system, /用户消息/); assert.match(prompt.system, /不模仿/); assert.match(prompt.system, /不向任何地方发送消息/);
});
