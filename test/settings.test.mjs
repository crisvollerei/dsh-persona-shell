import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizePack } from '../lib/pack.js';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const event = (value) => ({ target: { value } });
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  return [element, ...element.children.flatMap(nodes)];
}
function text(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return '';
  if (typeof element !== 'object') return String(element);
  if (Array.isArray(element)) return element.map(text).join('');
  return text(element.children);
}

// Exercise the registered settings component with stateful hooks and its real handlers.
function hookRenderer() {
  const hooks = [];
  let cursor;
  let pending;
  let dirty;
  let component;
  let tree;
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (!Object.is(hooks[index], next)) { hooks[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        hooks[index] = { deps, cleanup: previous?.cleanup };
        pending.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
    useCallback: (fn) => fn,
    memo: (fn) => fn,
  };
  return {
    React,
    render(next = component) {
      component = next;
      let cycles = 0;
      do {
        assert.ok(cycles++ < 10, 'settings settle without a render loop');
        dirty = false;
        cursor = 0;
        pending = [];
        tree = component({});
        for (const run of pending) run();
      } while (dirty);
      return tree;
    },
    dispose() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function makeHost() {
  const base = normalizePack({ identity: '原始身份', report: ['原始汇报规则'], voice: ['原始语感'] });
  const other = normalizePack({ identity: '另一预设身份', report: ['另一汇报规则'] });
  const host = {
    settings: { enabled: true, presetName: '原预设', pack: base },
    presets: [{ id: 'base', name: '原预设', pack: base }, { id: 'other', name: '另一预设', pack: other }],
    settingsCalls: [], presetCalls: [],
    settingsReplies: [], presetReplies: [],
    generated: { ...normalizePack({ identity: '生成的身份', report: ['生成规则'] }), name: '建议名称' },
  };
  const ok = (body) => ({ ok: true, json: async () => copy(body) });
  const snapshot = () => ({ ok: true, settings: copy(host.settings), presets: copy(host.presets), active: host.settings.presetName });
  host.fetch = async (url, options) => {
    if (String(url).endsWith('/settings')) {
      if (options?.method !== 'POST') return ok({ settings: host.settings });
      const patch = JSON.parse(options.body);
      host.settingsCalls.push(patch);
      const reply = host.settingsReplies.shift();
      if (reply?.gate) await reply.gate.promise;
      if (reply?.fail) return { ok: false, status: 503, json: async () => ({ error: 'storage-not-ready' }) };
      host.settings = { ...host.settings, ...patch };
      if (patch.pack) {
        host.settings.pack = normalizePack(patch.pack);
        host.presets = host.presets.map((preset) => preset.name === host.settings.presetName
          ? { ...preset, pack: host.settings.pack } : preset);
      }
      return ok(snapshot());
    }
    if (String(url).endsWith('/presets')) {
      if (options?.method !== 'POST') {
        const initial = snapshot();
        if (host.presetsReadGate) await host.presetsReadGate.promise;
        return ok(initial);
      }
      const body = JSON.parse(options.body);
      host.presetCalls.push(body);
      const reply = host.presetReplies.find((entry) => entry.action === body.action);
      if (reply) host.presetReplies.splice(host.presetReplies.indexOf(reply), 1);
      if (reply?.gate) await reply.gate.promise;
      if (reply?.fail) return { ok: false, status: 503, json: async () => ({ error: 'storage-not-ready' }) };
      if (body.action === 'generate') return ok({ ok: true, preset: host.generated });
      if (body.action === 'apply') {
        const preset = host.presets.find((entry) => entry.id === body.id);
        host.settings = { ...host.settings, presetName: preset.name, pack: preset.pack };
      } else if (body.action === 'save') {
        const preset = { id: 'generated', name: body.name, pack: normalizePack(body.pack) };
        host.presets.push(preset);
        host.settings = { ...host.settings, presetName: preset.name, pack: preset.pack };
      }
      return ok(snapshot());
    }
    return ok({ providers: [], models: [] });
  };
  return host;
}

async function mount(t, host = makeHost()) {
  const renderer = hookRenderer();
  const timers = new Map();
  let timerId = 0;
  let definition;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: host.fetch, console, URLSearchParams, AbortController,
  }, { filename: 'client.js' });
  const module = definition.factory((id) => {
    if (id === 'react') return renderer.React;
    throw new Error(`Unused module: ${id}`);
  });
  let component;
  const cleanups = [];
  module.apply({
    effect(fn) { const stop = fn(); if (typeof stop === 'function') cleanups.push(stop); },
    slots: {
      inject(_key, fn) { return fn(); },
      register(options, value) { if (options.name === 'settings.section') component = value; return () => {}; },
    },
  });
  t.after(() => { renderer.dispose(); for (const stop of cleanups) stop(); timers.clear(); });
  let tree = renderer.render(component);
  nodes(tree).find((node) => typeof node.props.onLoaded === 'function').props.onLoaded({ settings: copy(host.settings) });
  await flush();
  const render = () => { tree = renderer.render(); return tree; };
  render();
  const field = (label) => {
    const row = nodes(render()).find((node) => node.type === 'div'
      && node.children.some((child) => child?.type === 'span' && text(child) === label));
    const input = row && nodes(row).find((node) => ['input', 'textarea'].includes(node.type));
    assert.ok(input, `field ${label} exists`);
    return input;
  };
  const button = (label, root = render()) => {
    const result = nodes(root).find((node) => node.type === 'button' && text(node) === label);
    assert.ok(result, `button ${label} exists`);
    return result;
  };
  const presetButton = (id, label = '启用') => button(label, nodes(render()).find((node) => node.props.key === id));
  const prompt = () => nodes(render()).find((node) => node.props.placeholder === '粘贴人设提示词…');
  const name = () => nodes(render()).find((node) => node.props.placeholder === '给这个预设起个名字');
  return { host, render, field, button, presetButton, prompt, name, text: () => text(render()) };
}

test('late settings responses preserve drafts in both another field and the same field', async (t) => {
  const ui = await mount(t);
  const gate = deferred();
  ui.host.settingsReplies.push({ gate });
  ui.field('身份').props.onChange(event('第一次身份'));
  const saving = ui.field('身份').props.onBlur(event('第一次身份'));
  await flush();
  ui.field('汇报里的说话规则（每行一条）').props.onChange(event('正在写的规则\n第二行还没写完'));
  ui.field('身份').props.onChange(event('继续输入的身份'));
  gate.resolve();
  await saving;
  assert.equal(ui.host.settings.pack.identity, '第一次身份');
  assert.equal(ui.field('身份').props.value, '继续输入的身份');
  assert.equal(ui.field('汇报里的说话规则（每行一条）').props.value, '正在写的规则\n第二行还没写完');
  await ui.field('身份').props.onBlur(event('继续输入的身份'));
  assert.equal(ui.host.settings.pack.identity, '继续输入的身份');
  assert.equal(ui.field('汇报里的说话规则（每行一条）').props.value, '正在写的规则\n第二行还没写完');
});

test('successive field saves use the last confirmed card and serialize their requests', async (t) => {
  const ui = await mount(t);
  const gate = deferred();
  ui.host.settingsReplies.push({ gate });
  const first = ui.field('身份').props.onBlur(event('新的身份'));
  await flush();
  const second = ui.field('汇报里的说话规则（每行一条）').props.onBlur(event('第一条规则\n\n第二条规则'));
  const third = ui.field('子代理称呼').props.onBlur(event('助手们'));
  await flush();
  assert.equal(ui.host.settingsCalls.length, 1, 'only the oldest save is in flight');
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(ui.host.settingsCalls.length, 3);
  assert.equal(ui.host.settingsCalls[1].pack.identity, '新的身份');
  assert.deepEqual(ui.host.settingsCalls[2].pack.report, ['第一条规则', '第二条规则']);
  assert.equal(ui.host.settings.pack.identity, '新的身份');
  assert.deepEqual(ui.host.settings.pack.report, ['第一条规则', '第二条规则']);
  assert.equal(ui.host.settings.pack.address.subagent, '助手们');
  assert.equal(ui.field('子代理称呼').props.value, '助手们');
});

test('failed card save preserves the draft and can be retried without retyping', async (t) => {
  const ui = await mount(t);
  ui.host.settingsReplies.push({ fail: true });
  ui.field('通用语感（每行一条）').props.onChange(event('还没保存的语感'));
  await ui.field('通用语感（每行一条）').props.onBlur(event('还没保存的语感'));
  assert.deepEqual(ui.host.settings.pack.voice, ['原始语感']);
  assert.equal(ui.field('通用语感（每行一条）').props.value, '还没保存的语感');
  assert.match(ui.text(), /保存失败，请重试/);
  await ui.field('通用语感（每行一条）').props.onBlur(event(ui.field('通用语感（每行一条）').props.value));
  assert.deepEqual(ui.host.settings.pack.voice, ['还没保存的语感']);
});

test('preset switch waits for old writes, saves unblurred edits, and rejects stale card handlers', async (t) => {
  const ui = await mount(t);
  const saveGate = deferred();
  const applyGate = deferred();
  ui.host.settingsReplies.push({ gate: saveGate });
  ui.host.presetReplies.push({ action: 'apply', gate: applyGate });
  const oldField = ui.field('身份');
  const saving = oldField.props.onBlur(event('切换前的新身份'));
  await flush();
  ui.field('汇报里的说话规则（每行一条）').props.onChange(event('尚未失焦的修改'));
  const switching = ui.presetButton('other').props.onClick();
  assert.equal(ui.field('身份').props.disabled, true);
  oldField.props.onChange(event('迟到的旧卡片输入'));
  await oldField.props.onBlur(event('迟到的旧卡片失焦'));
  await flush();
  assert.equal(ui.host.presetCalls.length, 0, 'switch has not raced the save');
  saveGate.resolve();
  await saving;
  await flush();
  assert.equal(ui.host.presetCalls.length, 1);
  assert.equal(ui.host.presets[0].pack.identity, '切换前的新身份');
  assert.deepEqual(ui.host.presets[0].pack.report, ['尚未失焦的修改']);
  applyGate.resolve();
  await switching;
  assert.equal(ui.field('身份').props.value, '另一预设身份');
  assert.equal(ui.field('汇报里的说话规则（每行一条）').props.value, '另一汇报规则');
  assert.equal(ui.field('身份').props.disabled, false);
  const count = ui.host.settingsCalls.length;
  await oldField.props.onBlur(event('切换后迟到的失焦'));
  assert.equal(ui.host.settingsCalls.length, count);
  assert.equal(ui.host.settings.pack.identity, '另一预设身份');
  await ui.field('身份').props.onBlur(event('在新预设继续输入'));
  assert.equal(ui.host.settings.pack.identity, '在新预设继续输入');
});

test('preset switch stops on unsaved draft failure and retry preserves the original card edits', async (t) => {
  const ui = await mount(t);
  ui.field('语气示例（每行一条）').props.onChange(event('切换前需要留下的示例'));
  ui.host.settingsReplies.push({ fail: true });
  const failed = await ui.presetButton('other').props.onClick();
  assert.equal(failed.ok, false);
  assert.equal(ui.host.presetCalls.length, 0);
  assert.equal(ui.host.settings.presetName, '原预设');
  assert.equal(ui.field('语气示例（每行一条）').props.value, '切换前需要留下的示例');
  assert.match(ui.text(), /切换前保存人格修改失败，请重试/);
  assert.equal(ui.field('语气示例（每行一条）').props.disabled, false);
  await ui.presetButton('other').props.onClick();
  assert.deepEqual(ui.host.presets[0].pack.samples, ['切换前需要留下的示例']);
  assert.equal(ui.host.settings.presetName, '另一预设');
});

test('generated preset remains editable after a failed save and clears only after a successful retry', async (t) => {
  const ui = await mount(t);
  const prompt = '请生成一个说话简洁、认真负责、语气温和且保留技术细节的角色。';
  ui.prompt().props.onChange(event(prompt));
  await ui.button('生成预设').props.onClick();
  ui.name().props.onChange(event('我的角色名'));
  ui.prompt().props.onChange(event('之后编辑的另一份人设，不属于当前生成结果。'));
  const gate = deferred();
  ui.host.presetReplies.push({ action: 'save', gate, fail: true });
  const saveButton = ui.button('保存并启用');
  const saving = saveButton.props.onClick();
  const duplicate = saveButton.props.onClick();
  await flush();
  assert.equal(ui.host.presetCalls.filter((call) => call.action === 'save').length, 1);
  assert.equal(ui.button('保存并启用').props.disabled, true);
  assert.equal(ui.button('丢弃').props.disabled, true);
  assert.equal(ui.name().props.disabled, true);
  gate.resolve();
  await Promise.all([saving, duplicate]);
  assert.equal(ui.name().props.value, '我的角色名');
  assert.match(ui.text(), /身份：生成的身份/);
  assert.match(ui.text(), /storage-not-ready/);
  assert.equal(ui.button('保存并启用').props.disabled, false);
  ui.name().props.onChange(event('重试时改名'));
  await ui.button('保存并启用').props.onClick();
  const saveCalls = ui.host.presetCalls.filter((call) => call.action === 'save');
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[1].source, prompt, 'source belongs to the generated result, not the later prompt');
  assert.equal(saveCalls[1].name, '重试时改名');
  assert.equal(ui.host.presetCalls.filter((call) => call.action === 'generate').length, 1, 'retry does not regenerate');
  assert.equal(ui.name(), undefined, 'successful save closes the generated preview');
  assert.equal(ui.field('身份').props.value, '生成的身份');
});

test('late initial preset list cannot undo the selection returned by saving a generated preset', async (t) => {
  const host = makeHost();
  host.presetsReadGate = deferred();
  const ui = await mount(t, host);
  ui.prompt().props.onChange(event('这是足够长的人设提示词，请生成一个认真又温和的汇报角色。'));
  await ui.button('生成预设').props.onClick();
  await ui.button('保存并启用').props.onClick();
  assert.match(ui.text(), /当前：建议名称/);
  host.presetsReadGate.resolve();
  await flush();
  assert.match(ui.text(), /当前：建议名称/);
  assert.ok(nodes(ui.render()).some((node) => node.props.key === 'generated'));
  assert.equal(ui.field('身份').props.value, '生成的身份');
});
