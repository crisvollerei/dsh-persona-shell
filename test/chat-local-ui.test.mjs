import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const namespace = '5a496db1-48f7-49dd-b4fb-d516810ff1bd';
const otherNamespace = '671705b7-510f-43b4-916c-27f4e2ff292a';
const storageKey = value => 'dsh-persona-shell:room-ui:v1:' + value;
const scope = 'room:sources:0';
const room = (extra = {}) => ({ id: 'room', generation: 0, turns: [{ id: 'turn-1', attemptId: 'attempt-1', messageId: 'message-1',
  user: '用户原话', assistant: ['人格公开原话'], status: 'ready', scopeKey: scope, recipientId: 'claude', speakerName: 'Claude小姐' }], ...extra });
const quote = () => ({ ref: { roomId: 'room', generation: 0, kind: 'assistant', turnId: 'turn-1', attemptId: 'attempt-1', index: 0 },
  text: '人格公开原话', author: { role: 'assistant', id: 'claude', name: 'Claude小姐' } });
const draft = (text, requestId, withQuote = false) => ({ text, requestId, ...(withQuote ? { quote: quote() } : {}) });

function pages() {
  const values = new Map(), writes = [], reads = [], windows = [];
  let clock = 1700000000000;
  function page({ getFails = false, setFails = false } = {}) {
    let definition;
    const listeners = new Map(), controls = { getFails, setFails };
    const localStorage = {
      getItem(key) { reads.push(String(key)); if (controls.getFails) throw Error('storage unavailable'); return values.get(String(key)) ?? null; },
      setItem(key, value) { if (controls.setFails) throw Error('quota'); const oldValue = values.get(String(key)) ?? null;
        values.set(String(key), String(value)); writes.push({ key: String(key), oldValue, newValue: String(value), sender: window }); },
    };
    const window = { __ModuleLoader__: { load(value) { definition = value; } }, crypto: { randomUUID }, localStorage,
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); } };
    class Clock extends Date { static now() { return ++clock; } }
    const context = { window, localStorage, Date: Clock, URLSearchParams, AbortController, console,
      fetch: () => assert.fail('local UI state must not make a network request'),
      setTimeout, clearTimeout, setInterval, clearInterval };
    vm.runInNewContext(source, context, { filename: 'client.js' });
    const module = definition.factory(id => {
      if (id === 'react') return { createElement() {}, useEffect() {} };
      throw Error('optional dependency absent: ' + id);
    });
    const ui = module.__testing.chatLocalUi; assert.ok(ui, 'the actual client exposes its local-state test seam');
    const result = { ui, controls, window, listeners,
      inspect() { return plain(ui.inspect()); },
      receive(event) { for (const callback of listeners.get('storage') ?? []) callback(event); },
    };
    windows.push(result); return result;
  }
  return { page, values, writes, reads,
    deliver(change = writes.at(-1)) { for (const target of windows) if (target.window !== change.sender) target.receive(change); },
  };
}
const records = page => new Map(page.inspect().records);
const drafts = page => new Map(page.inspect().drafts);

test('missing durable key disables storage and a changed host cannot inherit another profile draft', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host-a'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('原 profile 草稿', 'a')); const persisted = hub.values.get(storageKey(namespace));
  const before = { reads: hub.reads.length, writes: hub.writes.length };
  a.ui.bind(undefined, 'host-a'); a.ui.saveDraft('room', draft('仅本页临时输入', 'temp'));
  assert.equal(a.inspect().namespace, undefined); assert.equal(drafts(a).get('room').text, '仅本页临时输入');
  assert.deepEqual({ reads: hub.reads.length, writes: hub.writes.length }, before);
  assert.equal(hub.values.get(storageKey(namespace)), persisted);
  a.ui.bind(undefined, 'host-b'); assert.equal(drafts(a).size, 0); assert.equal(records(a).size, 0);
  a.ui.restore(room(), scope); assert.equal(drafts(a).get('room').text, '');
  assert.deepEqual({ reads: hub.reads.length, writes: hub.writes.length }, before);
});

test('a new durable profile key switches namespaces without reusing same-id room drafts', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host-a'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('甲 profile 草稿', 'a'));
  a.ui.bind(otherNamespace, 'host-b'); assert.equal(a.inspect().namespace, otherNamespace);
  assert.equal(a.ui.restore(room(), scope).text, ''); a.ui.saveDraft('room', draft('乙 profile 草稿', 'b'));
  a.ui.bind(namespace, 'host-c'); assert.equal(a.ui.restore(room(), scope).text, '甲 profile 草稿');
  assert.equal(JSON.parse(hub.values.get(storageKey(otherNamespace))).rooms.room.draft.text, '乙 profile 草稿');
});

test('a late send acknowledgement preserves another page newer text and resolves its quote from canonical room words', () => {
  const hub = pages(), a = hub.page(), b = hub.page();
  a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope); a.ui.saveDraft('room', draft('已经发出的旧输入', 'old'));
  b.ui.bind(namespace, 'host'); b.ui.restore(room(), scope); b.ui.saveDraft('room', draft('另一页的新草稿', 'new', true));
  // Deliberately delay the storage event: the acknowledgement must compare durable state as well.
  const preserved = plain(a.ui.saveDraft('room', draft('', 'empty-after-ack'), 'old', room(), scope));
  assert.equal(preserved.text, '另一页的新草稿'); assert.equal(preserved.requestId, 'new');
  assert.deepEqual(preserved.quote, quote()); assert.deepEqual(drafts(a).get('room').quote, quote());
  assert.equal(JSON.parse(hub.values.get(storageKey(namespace))).rooms.room.draft.requestId, 'new');
  hub.deliver(); assert.equal(a.ui.restore(room(), scope).text, '另一页的新草稿');
});

test('cross-page draft events synchronize current input and unrelated namespace events do nothing', () => {
  const hub = pages(), a = hub.page(), b = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  b.ui.bind(namespace, 'host'); b.ui.restore(room(), scope); b.ui.saveDraft('room', draft('实时同步的原话', 'new', true));
  hub.deliver(); const synced = plain(a.ui.restore(room(), scope));
  assert.equal(synced.text, '实时同步的原话'); assert.deepEqual(synced.quote, quote());
  const before = a.inspect(); a.receive({ key: storageKey(otherNamespace), oldValue: null, newValue: '{}' });
  assert.deepEqual(a.inspect(), before);
});

test('cross-page room clearing removes old input and quote instead of resurrecting them from memory', () => {
  const hub = pages(), a = hub.page(), b = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('必须清掉的旧草稿', 'old', true)); b.ui.bind(namespace, 'host'); b.ui.restore(room(), scope);
  b.ui.clear('room'); hub.deliver(); assert.equal(drafts(a).has('room'), false); assert.equal(records(a).has('room'), false);
  const empty = a.ui.restore(room(), scope); assert.equal(empty.text, ''); assert.equal(empty.quote, undefined);
  const acknowledged = a.ui.saveDraft('room', draft('', 'empty-after-ack'), 'old', room(), scope);
  assert.equal(acknowledged.text, ''); assert.equal(acknowledged.quote, undefined);
  assert.doesNotMatch(hub.values.get(storageKey(namespace)), /必须清掉的旧草稿|turn-1|attempt-1/);
});

test('a pending scroll update cannot revive a cross-page deletion before its delayed storage event arrives', () => {
  const hub = pages(), a = hub.page(), b = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('删除前的私有草稿', 'deleted', true)); b.ui.bind(namespace, 'host'); b.ui.restore(room(), scope);
  b.ui.clear('room'); const deletion = hub.writes.at(-1);
  // The browser may deliver the remote deletion after the old page's queued reading/caret effect.
  a.ui.update('room', { selection: { start: 1, end: 2 }, reading: { atBottom: false, scrollTop: 64, known: ['attempt-1'] } });
  hub.deliver(deletion);
  assert.doesNotMatch(hub.values.get(storageKey(namespace)), /删除前的私有草稿|turn-1/);
  const restored = a.ui.restore(room(), scope); assert.equal(restored.text, ''); assert.equal(restored.quote, undefined);
});

test('a delayed deletion event does not erase a genuinely newer explicit user edit', () => {
  const hub = pages(), a = hub.page(), b = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('旧草稿', 'old')); b.ui.bind(namespace, 'host'); b.ui.clear('room');
  const deletion = hub.writes.at(-1); a.ui.saveDraft('room', draft('删除之后用户新写的内容', 'explicit-new', true));
  hub.deliver(deletion); const restored = plain(a.ui.restore(room(), scope));
  assert.equal(restored.text, '删除之后用户新写的内容'); assert.equal(restored.requestId, 'explicit-new'); assert.deepEqual(restored.quote, quote());
});

test('room clear generation wins over an older page snapshot and cannot be overwritten by its delayed acknowledgement', () => {
  const hub = pages(), a = hub.page(), b = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('上一代草稿', 'old', true)); b.ui.bind(namespace, 'host');
  const cleared = room({ generation: 1, turns: [] }); b.ui.restore(cleared, scope); b.ui.saveDraft('room', draft('清空后的新草稿', 'new-generation'));
  hub.deliver(); const stale = a.ui.restore(room(), scope); assert.equal(stale.text, ''); assert.equal(stale.quote, undefined);
  a.ui.saveDraft('room', draft('', 'old-ack'), 'old', room(), scope);
  const durable = JSON.parse(hub.values.get(storageKey(namespace))).rooms.room;
  assert.equal(durable.generation, 1); assert.equal(durable.draft.text, '清空后的新草稿');
  const latest = a.ui.restore(cleared, scope); assert.equal(latest.text, '清空后的新草稿'); assert.equal(latest.quote, undefined);
});

test('changing reference scope keeps unsent text but invalidates its old quote in memory and durable storage', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('文字可以继续编辑', 'same', true));
  const changed = a.ui.restore(room(), 'room:sources:1'); assert.equal(changed.text, '文字可以继续编辑');
  assert.equal(changed.requestId, 'same'); assert.equal(changed.quote, undefined);
  assert.equal(records(a).get('room').draft.quoteRef, null);
  assert.equal(JSON.parse(hub.values.get(storageKey(namespace))).rooms.room.draft.quoteRef, null);
});

test('a later clear generation discards both unsent input and the previous reading position', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('上一代输入', 'old', true));
  a.ui.update('room', { reading: { atBottom: false, scrollTop: 400, known: ['old-attempt'], anchor: { turnId: 'turn-1', kind: 'assistant', index: 0 }, offset: 12 } });
  const cleared = a.ui.restore(room({ generation: 2, turns: [] }), scope);
  assert.equal(cleared.text, ''); assert.equal(cleared.quote, undefined);
  const stored = records(a).get('room'); assert.equal(stored.generation, 2); assert.equal(stored.reading, null);
  assert.equal(stored.draft.quoteRef, null);
});

test('unavailable or quota-limited storage keeps the live draft usable without making network calls', () => {
  for (const failure of [{ getFails: true }, { setFails: true }, { getFails: true, setFails: true }]) {
    const hub = pages(), a = hub.page(failure); assert.doesNotThrow(() => a.ui.bind(namespace, 'host'));
    a.ui.restore(room(), scope); assert.doesNotThrow(() => a.ui.saveDraft('room', draft('失败仍保留的草稿', 'local', true)));
    const current = a.ui.restore(room(), scope); assert.equal(current.text, '失败仍保留的草稿'); assert.deepEqual(plain(current.quote), quote());
  }
});

test('a temporary read failure after persistence cannot masquerade as deletion or overwrite the saved draft', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('读取失败也不能丢掉的原稿', 'durable', true));
  const persisted = hub.values.get(storageKey(namespace)), writes = hub.writes.length;
  // Writes remain available: only the read fails, so a mistaken empty result could destroy the disk copy.
  a.controls.getFails = true; a.ui.update('room', { selection: { start: 1, end: 3 },
    reading: { atBottom: false, scrollTop: 200, known: ['attempt-1'] } });
  const current = plain(a.ui.restore(room(), scope)); assert.equal(current.text, '读取失败也不能丢掉的原稿');
  assert.equal(current.requestId, 'durable'); assert.deepEqual(current.quote, quote());
  assert.equal(hub.values.get(storageKey(namespace)), persisted); assert.equal(hub.writes.length, writes);
  a.controls.getFails = false;
  assert.equal(a.ui.read().room.draft.text, '读取失败也不能丢掉的原稿');
  a.ui.update('room', { selection: { start: 2, end: 4 } });
  assert.equal(a.ui.read().room.draft.text, '读取失败也不能丢掉的原稿');
  assert.deepEqual(plain(a.ui.read().room.selection), { start: 2, end: 4 });
  a.ui.restore(room({ id: 'other-room', turns: [] }), scope);
  a.ui.saveDraft('other-room', draft('其他房间的输入也不能被清掉', 'other-draft'));
  const beforeClear = hub.values.get(storageKey(namespace)), beforeClearWrites = hub.writes.length;
  a.controls.getFails = true; a.ui.clear('room');
  assert.equal(hub.values.get(storageKey(namespace)), beforeClear);
  assert.equal(hub.writes.length, beforeClearWrites, 'clearing one room cannot overwrite unread storage with an empty room map');
  assert.equal(drafts(a).get('other-room').text, '其他房间的输入也不能被清掉');
});

test('metadata writes after quota recovery preserve the unsaved local edit without overwriting another page newer draft', async t => {
  for (const remoteEdit of [false, true]) await t.test(remoteEdit ? 'another page has a newer draft' : 'disk still contains the acknowledged draft', () => {
    const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
    a.ui.saveDraft('room', draft('已存的旧草稿 A', 'a'));
    a.controls.setFails = true; a.ui.saveDraft('room', draft('配额失败时用户新写的 B', 'b', true));
    assert.equal(drafts(a).get('room').text, '配额失败时用户新写的 B');
    let remoteChange;
    if (remoteEdit) {
      const b = hub.page(); b.ui.bind(namespace, 'host'); b.ui.restore(room(), scope);
      b.ui.saveDraft('room', draft('另一页面后来写的 C', 'c', true)); remoteChange = hub.writes.at(-1);
    }
    a.controls.setFails = false; a.ui.update('room', { reading: { atBottom: false, scrollTop: 120, known: ['attempt-1'] } });
    if (remoteEdit) {
      const durable = JSON.parse(hub.values.get(storageKey(namespace))).rooms.room.draft;
      assert.equal(durable.text, '另一页面后来写的 C'); assert.equal(durable.requestId, 'c');
      assert.equal(drafts(a).get('room').text, '配额失败时用户新写的 B');
      hub.deliver(remoteChange);
    }
    const restored = plain(a.ui.restore(room(), scope)); assert.equal(restored.text, '配额失败时用户新写的 B');
    assert.equal(restored.requestId, 'b'); assert.deepEqual(restored.quote, quote());
    if (remoteEdit) assert.equal(JSON.parse(hub.values.get(storageKey(namespace))).rooms.room.draft.text, '另一页面后来写的 C');
  });
});

test('an authoritative clear generation discards even a dirty local draft and its obsolete quote', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('旧代已存草稿', 'old-generation'));
  a.controls.setFails = true; a.ui.saveDraft('room', draft('旧代未能保存的新输入', 'dirty-old', true));
  a.ui.update('room', { reading: { atBottom: false, scrollTop: 400, known: ['attempt-1'] } });
  a.controls.setFails = false;
  const b = hub.page(); b.ui.bind(namespace, 'host'); b.ui.restore(room({ generation: 1, turns: [] }), scope);
  hub.deliver();
  const stale = a.ui.restore(room(), scope); assert.equal(stale.text, ''); assert.equal(stale.quote, undefined);
  const current = a.ui.restore(room({ generation: 1, turns: [] }), scope); assert.equal(current.text, ''); assert.equal(current.quote, undefined);
  const durable = JSON.parse(hub.values.get(storageKey(namespace))).rooms.room;
  assert.equal(durable.generation, 1); assert.equal(durable.draft.text, ''); assert.equal(durable.draft.quoteRef, null);
  assert.equal(records(a).get('room').reading, null);
});

test('reading snapshots retain more than forty known replies and restore caret and anchor state across pages', () => {
  const hub = pages(), a = hub.page(); a.ui.bind(namespace, 'host'); a.ui.restore(room(), scope);
  a.ui.saveDraft('room', draft('继续编辑这段文字', 'caret'));
  const known = Array.from({ length: 128 }, (_, i) => 'attempt-' + i);
  a.ui.update('room', { selection: { start: 2, end: 5 }, reading: { atBottom: false, scrollTop: 480, known,
    anchor: { turnId: 'turn-1', kind: 'assistant', index: 0 }, offset: -18 }, visitedAt: 1700000000000 });
  const b = hub.page(); b.ui.bind(namespace, 'restarted-host'); b.ui.restore(room(), scope);
  const restored = records(b).get('room'); assert.deepEqual(restored.reading.known, known);
  assert.deepEqual(restored.selection, { start: 2, end: 5 }); assert.equal(restored.reading.scrollTop, 480);
  assert.equal(restored.reading.atBottom, false); assert.equal(restored.reading.offset, -18);
  assert.deepEqual(restored.reading.anchor, { turnId: 'turn-1', kind: 'assistant', index: 0 });
});
