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

for (const scenario of ['ready', 'default', 'restart']) {
  test(`conversation dialog rejects a late opening response after a newer ${scenario} state`, async (t) => {
    const renderer = hookRenderer(), gate = deferred(); let definition;
    const initial = { sessionId: 's', instanceId: 'old-host', stateRev: 10, revision: 0, personaId: null,
      trigger: 'inherit', relay: null, ready: scenario !== 'ready', effectivePersonaId: 'whale', effectivePersonaName: '鲸鲸',
      presets: [{ id: 'whale', name: '鲸鲸' }, { id: 'claude', name: 'Claude小姐' }] };
    vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { definition = value; } } },
      setTimeout, clearTimeout, console, fetch: async () => { await gate.promise; return { ok: true, json: async () => copy(initial) }; } });
    const module = definition.factory((id) => { if (id === 'react') return renderer.React; throw new Error(id); });
    t.after(() => renderer.dispose());
    let incoming = initial;
    const component = () => module.__testing.ConversationPanel({ sessionId: 's', conversation: incoming, onClose() {} });
    renderer.render(component);
    incoming = { ...initial, stateRev: scenario === 'restart' ? 0 : 11, instanceId: scenario === 'restart' ? 'new-host' : initial.instanceId,
      ready: true, effectivePersonaId: 'claude', effectivePersonaName: 'Claude小姐' };
    renderer.render(component); gate.resolve(); await flush();
    const tree = renderer.render(component);
    assert.ok(text(tree).includes('正在使用：Claude小姐'), 'the current effective persona cannot revert');
    const save = nodes(tree).find((node) => node.type === 'button' && text(node) === '保存会话选择');
    assert.equal(save.props.disabled, false, 'readiness cannot revert to the opening snapshot');
  });
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
      if (reply?.appliedFail) return { ok: false, status: 503,
        json: async () => ({ error: 'settings-save-failed', appliedSettings: copy(host.settings) }) };
      return ok({ ...snapshot(), settingsPersistence: reply?.persistence });
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
  const checkbox = (label) => {
    const row = nodes(render()).find((node) => node.type === 'label' && text(node) === label);
    const input = row && nodes(row).find((node) => node.type === 'input' && node.props.type === 'checkbox');
    assert.ok(input, `checkbox ${label} exists`); return input;
  };
  const prompt = () => nodes(render()).find((node) => node.props.placeholder === '粘贴人设提示词…');
  const name = () => nodes(render()).find((node) => node.props.placeholder === '给这个预设起个名字');
  return { host, module, render, field, checkbox, button, presetButton, prompt, name, text: () => text(render()) };
}

test('model catalogues wait for visible selectors and abort a provider superseded in flight', async (t) => {
  const host = makeHost(), requests = [], originalFetch = host.fetch;
  Object.assign(host.settings, { provider: 'rewrite-old', chatProvider: 'chat-only', visualizationProvider: 'reading-only' });
  host.fetch = async (url, options) => {
    const provider = new URL(String(url), 'https://test.invalid').searchParams.get('provider');
    if (String(url).includes('/models?') && provider) {
      const gate = deferred(); requests.push({ provider, gate, signal: options?.signal }); await gate.promise;
      return { ok: true, json: async () => ({ models: [{ id: provider, name: provider }] }) };
    }
    return originalFetch(url, options);
  };
  const ui = await mount(t, host);
  assert.equal(requests.length, 0, 'the persona page does not prefetch model lists');
  ui.button('高级').props.onClick(); ui.render(); await flush();
  assert.deepEqual(requests.map(request => request.provider), ['rewrite-old', 'reading-only']);
  const providerSelect = nodes(ui.render()).find(node => node.type === 'select' && node.props['aria-label'] === '改写所用模型');
  await providerSelect.props.onChange(event('rewrite-new')); ui.render(); await flush();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.at(-1).provider, 'rewrite-new');
  requests.at(-1).gate.resolve(); await flush(); ui.render();
  requests[0].gate.resolve(); await flush();
  const modelSelect = nodes(ui.render()).find(node => node.type === 'select' && node.props['aria-label'] === '模型');
  assert.ok(nodes(modelSelect).some(node => node.type === 'option' && node.props.value === 'rewrite-new'));
  assert.equal(nodes(modelSelect).some(node => node.type === 'option' && node.props.value === 'rewrite-old'), false, 'a late catalogue cannot overwrite the new provider');
  ui.button('聊天室').props.onClick(); ui.render(); await flush();
  assert.equal(requests[1].signal.aborted, true, 'hiding reading settings aborts its request');
  assert.equal(requests.at(-1).provider, 'chat-only');
  requests[1].gate.resolve(); requests.at(-1).gate.resolve(); await flush();
});

for (const builtin of [true, false]) test(`avatar save ${builtin ? 'overlays a builtin without saving its voice draft' : 'still saves custom voice drafts first'}`, async (t) => {
  const host = makeHost(), originalFetch = host.fetch;
  Object.assign(host.presets[0], { builtin, avatar: '/avatar/base?original', avatarOverridden: false });
  host.fetch = async (url, options) => {
    if (String(url).endsWith('/presets') && options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.action === 'avatar') {
        host.presetCalls.push(body);
        const preset = host.presets.find(p => p.id === body.id);
        preset.avatar = body.avatar ? '/avatar/base?override' : '/avatar/base?original';
        preset.avatarOverridden = !!body.avatar;
        return { ok: true, json: async () => copy({ ok: true, presets: host.presets, settings: host.settings, active: host.settings.presetName }) };
      }
    }
    return originalFetch(url, options);
  };
  const ui = await mount(t, host), originalPack = copy(host.settings.pack), originalName = host.settings.presetName;
  ui.field('通用语感（每行一条）').props.onChange(event('尚未提交的语气草稿'));
  ui.presetButton('base', '头像').props.onClick();
  let editor = nodes(ui.render()).find(node => node.type === ui.module.__testing.PersonaAvatarEditor);
  assert.ok(editor);
  assert.equal((await editor.props.onSave({ action: 'avatar', id: 'base', avatar: 'data:image/png;base64,mock', expectedAvatar: host.presets[0].avatar, requestId: 'avatar-overlay' })).ok, true);
  await flush(); ui.render();
  assert.equal(host.settings.presetName, originalName); assert.equal(host.presets.length, 2); assert.equal(host.presets[0].id, 'base');
  assert.equal(host.presets[0].builtin, builtin); assert.equal(host.presets[0].avatarOverridden, true);
  assert.equal(host.settingsCalls.length, builtin ? 0 : 1);
  if (builtin) assert.deepEqual(host.settings.pack, originalPack, 'display-only changes cannot alter the saved voice');
  assert.equal(ui.field('通用语感（每行一条）').props.value, '尚未提交的语气草稿', 'the voice draft survives avatar changes');
  ui.presetButton('base', '头像').props.onClick(); editor = nodes(ui.render()).find(node => node.type === ui.module.__testing.PersonaAvatarEditor);
  await editor.props.onSave({ action: 'avatar', id: 'base', avatar: null, expectedAvatar: host.presets[0].avatar, requestId: 'avatar-restore' });
  await flush(); ui.render();
  assert.equal(host.presets[0].avatarOverridden, false); assert.equal(host.presets[0].avatar, '/avatar/base?original');
});

function catalogueFixture(t) {
  const renderer = hookRenderer(), timers = new Map(), requests = []; let nextTimer = 0, definition;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { definition = value; } } },
    AbortController, console,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { const gate = deferred(); requests.push({ url, signal: options.signal, gate }); await gate.promise;
      return { ok: true, json: async () => ({ models: [{ id: 'late-model' }] }) }; } });
  const module = definition.factory(id => { if (id === 'react') return renderer.React; throw Error(id); });
  let provider = 'held-provider', visible = true, retry = 0;
  const render = () => renderer.render(() => module.__testing.useModelCatalogue(provider, visible, retry));
  t.after(() => renderer.dispose());
  return { requests, timers, render, module,
    hide() { visible = false; return render(); }, clear() { provider = ''; return render(); }, retry() { retry++; return render(); } };
}

test('a model catalogue timeout aborts and cannot be undone by a late successful response', async t => {
  const ui = catalogueFixture(t); ui.render(); assert.equal(ui.requests.length, 1);
  for (const fire of [...ui.timers.values()]) fire();
  assert.equal(ui.requests[0].signal.aborted, true); assert.equal(ui.render().failed, true);
  ui.requests[0].gate.resolve(); await flush();
  assert.equal(ui.render().failed, true); assert.equal(ui.render().models.length, 0);
  ui.retry(); assert.equal(ui.requests.length, 2); assert.equal(ui.render().failed, false);
  ui.hide(); assert.equal(ui.requests[1].signal.aborted, true);
  ui.requests[1].gate.resolve(); await flush(); assert.equal(ui.render().models.length, 0);
});

test('empty model selection retires its request without retaining a previous catalogue', async t => {
  const ui = catalogueFixture(t); ui.render(); ui.clear();
  assert.equal(ui.requests[0].signal.aborted, true); assert.equal(ui.timers.size, 0);
  ui.requests[0].gate.resolve(); await flush();
  assert.equal(ui.render().models.length, 0); assert.equal(ui.render().failed, false); assert.equal(ui.requests.length, 1);
});

test('fallback explanations stay on demand and never expose arbitrary provider errors', t => {
  const { reportFallbackReason } = catalogueFixture(t).module.__testing;
  assert.equal(reportFallbackReason({ status: 'ready', reason: 'source-worker-change' }), '');
  assert.equal(reportFallbackReason({ status: 'pending' }), '');
  assert.match(reportFallbackReason({ status: 'skipped', reason: 'source-quantity-change' }), /现有检查/);
  assert.match(reportFallbackReason({ status: 'skipped', reason: 'dropped-marker' }), /技术内容/);
  assert.match(reportFallbackReason({ status: 'failed', reason: 'timeout' }), /时限/);
  assert.doesNotMatch(reportFallbackReason({ status: 'failed', reason: 'PRIVATE_PROVIDER_TOKEN_ERROR' }), /PRIVATE|TOKEN/);
});

test('fixed source labels use existing metadata and distinguish another foreground work page', t => {
  const { roomReferenceHint } = catalogueFixture(t).module.__testing;
  const context = { initialized: true, primarySessionId: 'source-a', sources: [{ sessionId: 'source-a', name: '原参考任务' }, { sessionId: 'source-b', name: '补充任务' }] };
  const before = copy(context), same = roomReferenceHint(context, 'source-a'), other = roomReferenceHint(context, 'work-c');
  assert.equal(same.text, '来源 · 原参考任务 +1'); assert.equal(same.different, false);
  assert.equal(other.text, '固定 · 原参考任务 +1'); assert.equal(other.different, true); assert.match(other.title, /主要参考与当前工作页不同/);
  assert.equal(roomReferenceHint(context, undefined).different, false, 'unknown foreground metadata is not guessed');
  assert.equal(roomReferenceHint({ initialized: true, sources: [] }, 'work-c').text, '来源 · 0');
  assert.equal(roomReferenceHint(undefined, 'work-c').text, '连接中'); assert.deepEqual(context, before);
});

test('colloquial report saving defaults on and preserves a newer persona draft', async (t) => {
  const ui = await mount(t), gate = deferred();
  assert.equal(ui.checkbox('口语化转述').props.checked, true, 'a missing old setting displays the enabled default');
  ui.host.settingsReplies.push({ gate });
  const saving = ui.checkbox('口语化转述').props.onChange({ target: { checked: false } }); await flush();
  assert.deepEqual(ui.host.settingsCalls, [{ colloquialReports: false }], 'only the global expression option is written');
  ui.field('通用语感（每行一条）').props.onChange(event('正在输入的新语感\n尚未提交'));
  gate.resolve(); await saving;
  assert.equal(ui.checkbox('口语化转述').props.checked, false);
  assert.equal(ui.field('通用语感（每行一条）').props.value, '正在输入的新语感\n尚未提交', 'an older scalar save cannot replace a newer card draft');
  assert.deepEqual(ui.host.settings.pack.voice, ['原始语感']);
});

test('an applied but unpersisted setting stays visible and retries current settings without replaying a card', async t => {
  const ui = await mount(t);
  ui.host.settingsReplies.push({ appliedFail: true });
  await ui.checkbox('口语化转述').props.onChange({ target: { checked: false } });
  assert.equal(ui.checkbox('口语化转述').props.checked, false);
  assert.match(ui.text(), /当前已生效，但保存失败/);
  ui.host.settingsReplies.push({ fail: true });
  await ui.button('重试保存当前设置').props.onClick();
  assert.match(ui.text(), /保存失败，请重试/);
  assert.equal(ui.button('重试保存当前设置').props.disabled, false, 'a failed retry must remain retryable');
  ui.field('通用语感（每行一条）').props.onChange(event('新的未保存卡片草稿'));
  await ui.button('重试保存当前设置').props.onClick();
  assert.deepEqual(ui.host.settingsCalls, [{ colloquialReports: false }, {}, {}]);
  assert.equal(ui.field('通用语感（每行一条）').props.value, '新的未保存卡片草稿');
  assert.deepEqual(ui.host.settings.pack.voice, ['原始语感']);
  assert.match(ui.text(), /已保存/); assert.doesNotMatch(ui.text(), /重试保存当前设置/);
});

for (const persistence of ['pending', 'memory-only']) {
  test(`settings show ${persistence} without claiming durable success`, async t => {
    const ui = await mount(t);
    ui.host.settingsReplies.push({ persistence });
    await ui.checkbox('口语化转述').props.onChange({ target: { checked: false } });
    const status = nodes(ui.render()).find(node => node.props.className === 'dsh-persona-save-state');
    assert.match(text(status), persistence === 'pending' ? /存储尚未就绪/ : /仅本次生效/);
    assert.doesNotMatch(text(status), /已保存/);
    assert.equal(ui.checkbox('口语化转述').props.checked, false);
  });
}

test('final-only disables process controls without clearing their choices', async t => {
  const host = makeHost(); Object.assign(host.settings, { trigger: 'report', includeToolSteps: true, processToolUsage: true });
  const ui = await mount(t, host);
  assert.equal(ui.checkbox('同时改写阶段性输出').props.disabled, true);
  assert.equal(ui.checkbox('允许过程转述参考运行信息').props.disabled, true);
  assert.equal(ui.checkbox('同时改写阶段性输出').props.checked, true);
  assert.equal(ui.checkbox('允许过程转述参考运行信息').props.checked, true);
  assert.match(ui.text(), /原选择已保留/);
  const scope = nodes(ui.render()).find(node => node.props['aria-label'] === '默认转述范围');
  await scope.props.onChange(event('step'));
  assert.equal(ui.checkbox('同时改写阶段性输出').props.disabled, false);
  assert.equal(ui.checkbox('允许过程转述参考运行信息').props.disabled, false);
  await ui.checkbox('同时改写阶段性输出').props.onChange({ target: { checked: false } });
  assert.equal(ui.checkbox('允许过程转述参考运行信息').props.disabled, true);
  assert.equal(ui.checkbox('允许过程转述参考运行信息').props.checked, true);
});

test('colloquial report setting honors saved false and can retry a failed save', async (t) => {
  const host = makeHost(); host.settings.colloquialReports = false;
  const ui = await mount(t, host); assert.equal(ui.checkbox('口语化转述').props.checked, false);
  host.settingsReplies.push({ fail: true });
  await ui.checkbox('口语化转述').props.onChange({ target: { checked: true } });
  assert.equal(ui.checkbox('口语化转述').props.checked, false, 'failed writes keep the confirmed setting');
  assert.match(ui.text(), /保存失败，请重试/);
  await ui.checkbox('口语化转述').props.onChange({ target: { checked: true } });
  assert.equal(ui.checkbox('口语化转述').props.checked, true); assert.equal(host.settings.colloquialReports, true);
});

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
  assert.equal(ui.button('稍后编辑').props.disabled, true);
  assert.equal(ui.name().props.disabled, true);
  gate.resolve();
  await Promise.all([saving, duplicate]);
  assert.equal(ui.name().props.value, '我的角色名');
  assert.equal(nodes(ui.render()).find(node => node.props['aria-label'] === '生成身份摘要')?.props.value, '生成的身份');
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

test('generated review opens once with the same editable draft and can be postponed without adopting it', async (t) => {
  const ui = await mount(t);
  const findReview = () => nodes(ui.render()).find(node => node.props.role === 'dialog' && node.props['aria-label'] === '核对生成的人格');
  const reviewFold = () => nodes(ui.render()).find(node => node.type === 'details'
    && node.children.some(child => child?.type === 'summary' && text(child) === '核对生成结果（未保存）'));
  ui.prompt().props.onChange(event('一个喜欢收集旧地图、说话平实的虚构人物，不根据外形推断其性别。'));
  await ui.button('生成预设').props.onClick();
  assert.ok(findReview());
  assert.equal(ui.host.presetCalls.filter(call => call.action === 'save').length, 0);
  const identity = nodes(ui.render()).find(node => node.props['aria-label'] === '生成身份摘要');
  identity.props.onChange(event('自己核对后的身份'));
  const gender = nodes(ui.render()).find(node => node.props['aria-label'] === '生成人格性别（聊天室）');
  assert.equal(gender.props.value, 'unset');
  assert.equal(text(gender.children.find(node => node.props.value === 'unset')), '不指定');
  assert.match(text(gender.children.find(node => node.props.value === 'none')), /^无性别/);
  assert.match(ui.text(), /男娘、假小子是表达风格/);
  await ui.button('稍后编辑').props.onClick();
  assert.equal(findReview(), undefined);
  assert.equal(reviewFold().props.open, false);
  await ui.presetButton('other').props.onClick();
  assert.equal(findReview(), undefined, 'switching cards cannot reopen the reminder');
  assert.equal(ui.name().props.value, '建议名称');
  assert.equal(nodes(ui.render()).find(node => node.props['aria-label'] === '生成身份摘要').props.value, '自己核对后的身份');
  reviewFold().props.onToggle({ currentTarget: { open: true } });
  assert.ok(findReview());
  assert.equal(nodes(ui.render()).find(node => node.props['aria-label'] === '生成身份摘要').props.value, '自己核对后的身份');
});

test('failed generation does not open review or replace a postponed draft and generation locks review controls', async (t) => {
  const ui = await mount(t);
  const findReview = () => nodes(ui.render()).find(node => node.props.role === 'dialog' && node.props['aria-label'] === '核对生成的人格');
  ui.prompt().props.onChange(event('一份足够长的虚构人物材料，只用于检查失败生成与核对面板的生命周期。'));
  ui.host.presetReplies.push({ action: 'generate', fail: true });
  await ui.button('生成预设').props.onClick();
  assert.equal(findReview(), undefined);
  await ui.button('生成预设').props.onClick();
  ui.name().props.onChange(event('保留的预览名字'));
  await ui.button('稍后编辑').props.onClick();
  ui.host.presetReplies.push({ action: 'generate', fail: true });
  await ui.button('生成预设').props.onClick();
  assert.equal(findReview(), undefined);
  assert.equal(ui.name().props.value, '保留的预览名字');
  const reviewFold = nodes(ui.render()).find(node => node.type === 'details'
    && node.children.some(child => child?.type === 'summary' && text(child) === '核对生成结果（未保存）'));
  reviewFold.props.onToggle({ currentTarget: { open: true } });
  const gate = deferred();
  ui.host.presetReplies.push({ action: 'generate', gate, fail: true });
  const generating = ui.button('生成预设').props.onClick();
  await flush();
  assert.equal(ui.button('稍后编辑').props.disabled, true);
  assert.equal(ui.button('丢弃').props.disabled, true);
  assert.equal(ui.name().props.disabled, true);
  findReview().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.ok(findReview(), 'an in-flight generation cannot dismiss the locked review');
  gate.resolve(); await generating;
  assert.ok(findReview(), 'a failure preserves a review that was already open');
  assert.equal(ui.name().props.value, '保留的预览名字');
});

test('late initial preset list cannot undo the selection returned by saving a generated preset', async (t) => {
  const host = makeHost();
  host.presetsReadGate = deferred();
  const ui = await mount(t, host);
  ui.prompt().props.onChange(event('这是足够长的人设提示词，请生成一个认真又温和的汇报角色。'));
  await ui.button('生成预设').props.onClick();
  await ui.button('保存并启用').props.onClick();
  assert.ok(nodes(ui.render()).some((node) => node.props.key === 'generated' && node.props['data-active'] === true));
  host.presetsReadGate.resolve();
  await flush();
  assert.ok(nodes(ui.render()).some((node) => node.props.key === 'generated' && node.props['data-active'] === true));
  assert.ok(nodes(ui.render()).some((node) => node.props.key === 'generated'));
  assert.equal(ui.field('身份').props.value, '生成的身份');
});
