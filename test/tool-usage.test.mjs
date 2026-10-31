import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolUsage, restoreToolUsage } from '../lib/tool-usage.js';

function feed(collector = createToolUsage(), session = { id: 'main' }) {
  let seq = 0;
  const event = (type, data, override = {}) => collector.event(session, { type, seq: ++seq, data, ...override });
  return {
    collector, event,
    start: (turn = 1) => event('turn/start', { turn }),
    call: (callId, name = 'read', extra = {}) => event('tool/call', { callId, name, ...extra }),
    result: (toolCallId, isError = false, meta) => event('tool/result', { message: { toolCallId, isError, content: ['secret'] }, meta }),
    report: (id, extra = {}) => event('assistant/message', { turn: 1, ...extra, message: { id, content: [
      { type: 'text', text: '接着看下一部分。' }, { type: 'tool-call', id: 'next', name: 'read', arguments: 'private' },
    ] } }),
  };
}
const count = (calls, returned, errors = 0, earlier_returns = 0) => ({ calls, returned, errors, earlier_returns });

test('source boundaries, not queries, split three independent windows and frozen results', () => {
  const f = feed(); f.start();
  f.call('one', 'grep', { arguments: 'sensitive path' }); f.result('one');
  const first = f.report('report1');
  // Nothing reads or claims the first snapshot; a failed/unqueried rewrite cannot carry its counts forward.
  f.call('two', 'apply_patch'); f.result('two', true);
  const second = f.report('report2');
  assert.deepEqual(first.categories, { search: count(1, 1) });
  assert.deepEqual(second.categories, { edit: count(1, 1, 1) });
  assert.deepEqual(f.report('report3').categories, {});
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.categories.search));
  assert.throws(() => { first.categories.search.calls++; }, TypeError);
  assert.doesNotMatch(JSON.stringify(first), /one|grep|sensitive|private|secret/);
});

test('call ids and result ids deduplicate even when redelivered with a new sequence', () => {
  const f = feed(); f.start();
  f.call('one', 'grep'); f.call('one', 'execute'); f.result('one'); f.result('one', true);
  assert.deepEqual(f.report('report1').categories, { search: count(1, 1) });
  f.call('one'); f.result('one', true);
  f.event('tool/call', { callId: 'replay', name: 'read' }, { seq: 2 });
  assert.deepEqual(f.report('report2').categories, {});
});

test('repeated process message ids do not create a second boundary', () => {
  const f = feed(); f.start(); f.report('same');
  f.call('new');
  assert.equal(f.report('same'), undefined);
  f.result('new');
  assert.deepEqual(f.report('different').categories, { read: count(1, 1) });
});

test('late returns belong to the new window and never count their old start again', () => {
  const f = feed(); f.start(); f.call('slow', 'run_code');
  assert.deepEqual(f.report('before-return').categories, { execute: count(1, 0) });
  f.result('slow', true); f.call('fast', 'read_file'); f.result('fast');
  const snapshot = f.report('after-return');
  assert.deepEqual(snapshot.categories, { read: count(1, 1), execute: count(0, 1, 1, 1) });
  assert.deepEqual(restoreToolUsage(snapshot), snapshot);
  f.result('slow');
  assert.deepEqual(f.report('next').categories, {});
});

test('duplicate turn starts preserve dedup; new turns may reuse call ids; sessions remain isolated', () => {
  const collector = createToolUsage();
  const a = feed(collector, { id: 'a' }); const b = feed(collector, { id: 'b' });
  a.start(); b.start(); a.call('same', 'grep'); a.start(); a.call('same'); b.call('same', 'write');
  assert.deepEqual(a.report('a').categories, { search: count(1, 0) });
  assert.deepEqual(b.report('b').categories, { edit: count(1, 0) });
  a.start(2); a.call('same');
  assert.deepEqual(a.report('new-turn', { turn: 2 }).categories, { read: count(1, 0) });
});

test('attach midway and orphan returns make an incomplete interval explicit', () => {
  const f = feed();
  f.event('request/header', { turn: 1 }); f.call('seen');
  assert.equal(f.report('incomplete').available, false);
  f.call('complete'); f.result('complete');
  assert.equal(f.report('complete').available, true);
  f.result('unobserved');
  assert.equal(f.report('orphan').available, false);
  assert.equal(f.report('recovered').available, true);
});

test('only valid committed process reports rotate counts; unknown tools stay coarse', () => {
  const f = feed(); f.start(); f.call('unknown', 'vendor.sensitive-tool-name');
  f.report('interrupted', { interrupted: true });
  f.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '最终正文' }] } });
  f.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '' }, { type: 'tool-call' }] } });
  assert.deepEqual(f.report('valid').categories, { other: count(1, 0) });
});

test('bounded collectors fail closed rather than evicting ids and recounting', () => {
  const f = feed(createToolUsage({ maxCalls: 1 })); f.start();
  f.call('one'); f.call('two');
  assert.equal(f.report('full').available, false);
  f.call('one'); f.result('one');
  assert.equal(f.report('still-full').available, false);
});

test('at most three notes can be claimed per active turn; obsolete snapshots cannot claim', () => {
  const f = feed(); f.start(); f.call('one'); const snapshot = f.report('one');
  assert.equal(f.collector.claimNote(snapshot), true);
  assert.equal(f.collector.claimNote(snapshot), false);
  assert.equal(f.collector.claimNote(f.report('two')), true);
  assert.equal(f.collector.claimNote(f.report('three')), true);
  assert.equal(f.collector.claimNote(f.report('four')), false);
  f.collector.clear('main');
  f.call('after-toggle'); f.report('partial-after-toggle');
  f.call('complete-after-toggle');
  assert.equal(f.collector.claimNote(f.report('after-toggle')), false, 'switching off/on cannot renew the same turn budget');
  f.start(2);
  assert.equal(f.collector.claimNote(snapshot), false);
  f.event('turn/end', { turn: 2 });
  assert.equal(f.collector.claimNote(snapshot), false);
});

test('restoration rejects impossible counts and strips unrelated metadata', () => {
  const base = { available: true, scope: 'since_previous_process_report', categories: { read: count(1, 1) } };
  assert.deepEqual(restoreToolUsage({ ...base, secret: 'discard' }), base);
  for (const bad of [count(-1, 0), count(0, 1), count(1, 1, 2), count(1, 1, 0, 2), { ...count(1, 1), output: 'no' }]) {
    assert.equal(restoreToolUsage({ ...base, categories: { read: bad } }), undefined);
  }
  assert.equal(restoreToolUsage({ ...base, available: false }), undefined);
});

test('work nature distinguishes known read tools, mutation attempts and opaque execution', () => {
  const f = feed(); f.start(); f.call('read', 'grep'); f.result('read');
  assert.deepEqual(f.report('read').work_nature, { is_read_only: true, files_touched: 0, ran_destructive_cmd: false });
  f.call('edit', 'edit');
  assert.deepEqual(f.report('pending').work_nature, { is_read_only: false, files_touched: null, ran_destructive_cmd: false });
  f.call('another-read');
  assert.equal(f.report('older-edit-still-pending').work_nature.is_read_only, null);
  f.result('edit', false, { path: '/work/file.js', diffs: [{ path: '/work/file.js' }] });
  assert.equal(f.report('late-edit').work_nature.files_touched, 1);
  f.event('tool/call', { callId: 'shell', name: 'bash', get arguments() { assert.fail('must not inspect shell arguments'); } });
  f.result('shell');
  assert.deepEqual(f.report('opaque').work_nature, { is_read_only: null, files_touched: null, ran_destructive_cmd: null });
});

test('file counts deduplicate canonical paths within a window, not across all reports', () => {
  const f = feed(); f.start();
  const meta = { path: '/private/project/file.js', diffs: [{ get oldText() { assert.fail('must not inspect diff contents'); } }] };
  f.call('a', 'edit'); f.result('a', false, meta); f.result('a', false, meta);
  f.call('b', 'write'); f.result('b', false, { ...meta, operation: 'update' });
  f.call('c', 'write'); f.result('c', false, { path: '/private/project/new.js', operation: 'create', diffs: [] });
  const first = f.report('first');
  assert.equal(first.work_nature.files_touched, 2);
  assert.doesNotMatch(JSON.stringify(first), /private|project|file\.js|new\.js|oldText/);
  f.call('d', 'edit'); f.result('d', false, meta);
  assert.equal(f.report('next').work_nature.files_touched, 1);
  f.call('no-op', 'write'); f.result('no-op', false, { ...meta, operation: 'update', diffs: [] });
  assert.equal(f.report('no-op').work_nature.files_touched, 0);
});

test('missing, malformed, failed or unsupported mutation metadata is unknown, never a guessed file count', () => {
  for (const [name, error, meta] of [['edit', false, undefined], ['edit', true, { path: '/a', diffs: [{}] }],
    ['write', false, { path: '/a', diffs: [] }], ['apply_patch', false, { files_touched: 8 }],
    ['edit', false, { path: 'relative', diffs: [{}] }]]) {
    const f = feed(); f.start(); f.call('a', name); f.result('a', error, meta);
    assert.equal(f.report('unknown').work_nature.files_touched, null, name);
  }
});

test('pacing freezes with source reports and missing tool observation does not invent counts', () => {
  const f = feed(createToolUsage({ now: () => new Date(2026, 9, 31, 2).getTime(), monotonic: () => 0 }));
  f.start(); const first = f.report('first');
  assert.equal(first.session_pacing.is_first_report, true);
  assert.equal(f.report('next').session_pacing.is_first_report, false);
  assert.equal(first.session_pacing.is_first_report, true, 'later reports never mutate old query snapshots');
  const partial = feed(); partial.result('orphan');
  const unknown = partial.report('partial');
  assert.equal(unknown.available, false);
  assert.deepEqual(unknown.work_nature, { is_read_only: null, files_touched: null, ran_destructive_cmd: null });
  assert.deepEqual(restoreToolUsage(unknown), unknown);
});

test('restoration rejects contradictory nature, incomplete statistics and malformed pacing', () => {
  const f = feed(); f.start(); f.call('edit', 'edit');
  f.result('edit', false, { path: '/work/a', diffs: [{}] });
  const base = f.report('valid');
  assert.deepEqual(restoreToolUsage(base), base);
  for (const patch of [{ work_nature: { is_read_only: true, files_touched: 0, ran_destructive_cmd: false } },
    { work_nature: { ...base.work_nature, files_touched: 2 } },
    { work_nature: { ...base.work_nature, files_touched: '1' } },
    { session_pacing: { ...base.session_pacing, local_hour: 25 } },
    { available: false },
    { available: false, categories: {} }]) {
    assert.equal(restoreToolUsage({ ...base, ...patch }), undefined);
  }
});
