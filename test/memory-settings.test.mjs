import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const event = (value) => ({ target: { value } });
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...node.children.flatMap(nodes)];
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' ? text(node.children) : String(node);
}
async function mount(t, fetch) {
  const hooks = []; let cursor = 0; let effects = []; let dirty = false;
  const React = {
    Fragment: Symbol(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (!Object.is(next, hooks[index])) { hooks[index] = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(fn, deps) {
      const index = cursor++; const previous = hooks[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        effects.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  let definition;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    fetch, setTimeout, clearTimeout, console, URLSearchParams, AbortController,
  });
  const plugin = definition.factory((id) => { if (id === 'react') return React; throw new Error(id); });
  const component = plugin.__testing.MemoryPanel;
  const props = { settings: { memory: true, memoryExtraction: false, presetName: '鲸鲸' },
    save: async () => ({ settings: {} }), presets: [{ id: 'whale', name: '鲸鲸' }, { id: 'dragon', name: '龙' }] };
  let tree;
  function render() {
    let cycles = 0;
    do {
      assert.ok(cycles++ < 8); cursor = 0; effects = []; dirty = false;
      tree = component(props); for (const effect of effects) effect();
    } while (dirty);
    return tree;
  }
  t.after(() => { for (const hook of hooks) hook?.cleanup?.(); });
  render(); await flush(); render();
  return {
    render, props,
    button(label, root = render()) {
      const node = nodes(root).find((n) => n.type === 'button' && text(n) === label);
      assert.ok(node, 'button ' + label); return node;
    },
    input(label) {
      const node = nodes(render()).find((n) => n.props['aria-label'] === label);
      assert.ok(node, 'input ' + label); return node;
    },
    draft: () => nodes(render()).find((n) => n.type === 'textarea' && n.props.placeholder),
    text: () => text(render()),
  };
}
const state = () => ({ activePersonaId: 'whale', sessionId: 's', revision: 1, entries: [],
  extraction: { pending: 0, status: 'idle' } });
const response = (value, ok = true) => ({ ok, json: async () => structuredClone(value) });

test('a failed manual save retains the entire draft and the same request can be retried', async (t) => {
  const data = state(); const calls = []; let fail = true;
  const ui = await mount(t, async (_url, options) => {
    if (!options) return response(data);
    const body = JSON.parse(options.body); calls.push(body);
    if (fail) return response({ error: 'memory-save-failed' }, false);
    data.entries.push({ ...body.entry, id: 'one', status: 'candidate', version: 1, origin: 'manual', evidence: [], expiresAt: null });
    return response(data);
  });
  ui.draft().props.onChange(event('请先说结果，再补充必要条件'));
  await ui.button('预览新记忆').props.onClick();
  assert.equal(ui.draft().props.value, '请先说结果，再补充必要条件');
  assert.match(ui.text(), /保存失败/);
  fail = false; await ui.button('预览新记忆').props.onClick();
  assert.equal(ui.draft().props.value, '');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].entry.personaId, 'whale');
});

test('correcting another persona explicitly targets its record without broadening its scope', async (t) => {
  const data = state(); let write;
  data.entries.push({ id: 'private', kind: 'preference', scope: 'persona', personaId: 'dragon', sessionId: null,
    content: '龙的私有偏好', status: 'active', origin: 'manual', pinned: false, version: 3, expiresAt: null });
  const ui = await mount(t, async (_url, options) => {
    if (options) write = JSON.parse(options.body);
    return response(data);
  });
  ui.input('筛选记忆').props.onChange(event('all'));
  await ui.button('更正').props.onClick();
  ui.input('更正后的记忆内容').props.onChange(event('修改后的龙的偏好'));
  ui.input('本次更正或撤销的原话').props.onChange(event('  只改龙的，不要影响鲸鲸。\n请保留说明。  '));
  await ui.button('预览更正').props.onClick();
  assert.equal(write.id, 'private'); assert.equal(write.action, 'propose');
  assert.equal(write.statement, '  只改龙的，不要影响鲸鲸。\n请保留说明。  ');
  assert.equal(write.scope, undefined); assert.equal(write.personaId, undefined);
  assert.equal(write.version, 3);
});

test('a late refresh cannot overwrite a newer successful mutation', async (t) => {
  const data = state(); let resolve; let reads = 0;
  const ui = await mount(t, async (_url, options) => {
    if (options) {
      const body = JSON.parse(options.body);
      data.entries = [{ ...body.entry, id: 'one', status: 'candidate', version: 1, origin: 'manual', evidence: [], expiresAt: null }];
      return response(data);
    }
    reads++;
    if (reads === 2) return new Promise((done) => { resolve = done; });
    return response(data);
  });
  const stale = ui.button('刷新记忆').props.onClick();
  ui.draft().props.onChange(event('新保存的偏好'));
  await ui.button('预览新记忆').props.onClick();
  resolve(response(state())); await stale;
  assert.match(ui.text(), /新保存的偏好/);
});

test('switching personas blocks old add handlers until the new memory scope is loaded', async (t) => {
  const data = state(); let posts = 0; let release; let reads = 0;
  const ui = await mount(t, async (_url, options) => {
    if (options) { posts++; return response(data); }
    reads++;
    if (reads > 1) return new Promise((resolve) => { release = resolve; });
    return response(data);
  });
  ui.draft().props.onChange(event('应该属于新角色的偏好'));
  const staleButton = ui.button('预览新记忆');
  ui.props.settings = { ...ui.props.settings, presetName: '龙' };
  ui.render();
  assert.equal(ui.button('预览新记忆').props.disabled, true);
  await staleButton.props.onClick();
  assert.equal(posts, 0);
  release(response({ ...data, activePersonaId: 'dragon' }));
  await flush();
  assert.equal(ui.draft().props.value, '', 'new persona starts with its own draft');
  ui.draft().props.onChange(event('龙的新草稿'));
  assert.equal(ui.button('预览新记忆').props.disabled, false);
});
