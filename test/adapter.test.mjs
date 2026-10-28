import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { makeSlots, AssistantNodeView, CHAT_SLOT, CHAT_MODULE } from './helpers/slots.mjs';
import { assessRewrite } from '../lib/review.js';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function hooks() {
  const cells = [];
  let cursor = 0;
  let effects;
  let dirty;
  let component;
  let props;
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (value) => {
        const next = typeof value === 'function' ? value(cells[index]) : value;
        if (!Object.is(next, cells[index])) { cells[index] = next; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const old = cells[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        cells[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = effect(); });
      }
    },
  };
  return { React,
    render(nextComponent = component, nextProps = props) {
      component = nextComponent; props = nextProps;
      let tree;
      do {
        cursor = 0; effects = []; dirty = false;
        tree = component(props);
        for (const effect of effects) effect();
      } while (dirty);
      return tree;
    },
    dispose() { for (const cell of cells) cell?.cleanup?.(); },
  };
}

async function mount(t, { host, enabled = true, prepare } = {}) {
  const fixture = makeSlots();
  prepare?.(fixture);
  const timers = new Map();
  const intervals = new Map();
  let nextId = 0;
  let definition;
  const reports = [];
  const requests = [];
  const settings = { enabled };
  const state = host ?? { rev: 1, rows: [], settings: { enabled: true } };
  const renderer = hooks();
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    URLSearchParams, AbortController, console,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(fn, delay) { const id = ++nextId; intervals.set(id, { fn, delay }); return id; },
    clearInterval: (id) => intervals.delete(id),
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/diagnostics')) reports.push(JSON.parse(options.body));
      return { ok: true, json: async () => String(url).includes('/state') ? state : { settings } };
    },
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  const module = definition.factory((id) => {
    if (id === 'react') return renderer.React;
    throw new Error(`unexpected require ${id}`);
  });
  const disposers = [];
  module.apply({ slots: fixture.slots, effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; } });
  const dispose = () => { renderer.dispose(); for (const fn of disposers.splice(0)) fn(); };
  t.after(dispose);
  await flush();
  const own = () => fixture.registrations.find((entry) => entry.options.key === 'assistant-step'
    && entry.component.name === 'PersonaDelegate');
  return { ...fixture, module, state, settings, reports, requests, renderer, timers, intervals, own, dispose,
    async refresh() { state.rev += 1; await module.__testing.refreshState('s1'); },
    async tick(delay) {
      const item = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(item, `a ${delay}ms timer exists`);
      timers.delete(item[0]); item[1].fn(); await flush();
    },
    render(node, props = {}) {
      const element = own().component({ sessionId: 's1', node, renderFactorySlot: () => null, ...props });
      return renderer.render(element.type, element.props);
    },
  };
}

const nodeOf = (blocks = [{ kind: 'text', text: 'original report' }], status = 'settled', seq = 7) => ({
  key: 'assistant:1', location: { kind: 'step', turn: { status: 'closed' } },
  data: { status, blocks, finalNode: { seq, blocks }, step: 1 },
});
const all = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(all) : [tree, ...tree.children.flatMap(all)];
/** The official report is no longer the first child; controls precede it now. */
const first = (tree) => all(tree).find((element) => element.type === AssistantNodeView);

test('delegation reuses official component/locale/inject and never mutates the registration', async (t) => {
  const app = await mount(t);
  assert.ok(app.own());
  assert.equal(app.own().options.locale, app.official.locale);
  assert.equal(app.own().options.inject, app.official.inject);
  assert.equal(app.own().options.children, undefined);
  assert.equal(app.official.component, AssistantNodeView);
  assert.equal(app.module.__testing.getChatRendererState().status, 'delegated');
});

test('Cordis ancestor display names and unnamed registrants are not mistaken for package ids', async (t) => {
  for (const registrant of ['root', 'loader', undefined]) {
    const app = await mount(t, { prepare({ slots, factories }) {
      for (const name of [CHAT_SLOT, 'conversation.chat.reasoning.body', 'conversation.chat.message.images']) {
        for (const entry of slots.entries(name)) entry.registrant = registrant;
      }
      for (const factory of factories.values()) factory.registrant = registrant;
    } });
    assert.ok(app.own());
  }
});

test('a ready rewrite copies only the text block in mixed official content', async (t) => {
  const blocks = [
    { kind: 'reasoning', text: 'original reasoning' }, { kind: 'text', text: 'original report' },
    { kind: 'image', attachment: { id: 'one' } }, { kind: 'image', attachment: { id: 'two' } },
    { kind: 'tool-call', callId: 'call1' }, { kind: 'unknown', block: { evidence: 'keep' } },
  ];
  const node = nodeOf(blocks);
  const snapshot = JSON.stringify(node);
  for (const block of blocks) Object.freeze(block);
  Object.freeze(blocks); Object.freeze(node.data); Object.freeze(node);
  const app = await mount(t, { host: { rev: 1, rows: [{ seq: 7, status: 'ready', text: 'persona report' }] } });
  await app.refresh();
  const tree = app.render(node);
  const report = first(tree);
  assert.equal(tree.type, Symbol.for('react.fragment'));
  assert.equal(report.type, AssistantNodeView);
  assert.equal(report.props.node.data.blocks[1].text, 'persona report');
  for (const index of [0, 2, 3, 4, 5]) assert.equal(report.props.node.data.blocks[index], blocks[index]);
  assert.equal(report.props.node.data.finalNode, node.data.finalNode);
  assert.equal(report.props.node.location, node.location);
  assert.equal(JSON.stringify(node), snapshot);
});

test('official owner props, hook faces and factory dispatch survive the wrapper', async (t) => {
  const app = await mount(t);
  const calls = [];
  const extras = { t: () => 'translation', useDisclosure() {}, useGroupAction() {}, usePresentation() {},
    useTurnData() {}, openFile() {}, fileMentions() {}, loadImage() {}, turnProcess: {},
    renderFactorySlot: (name, owner) => { calls.push({ name, owner }); return owner; } };
  const report = first(app.render(nodeOf(), extras));
  for (const key of Object.keys(extras)) assert.equal(report.props[key], extras[key]);
  const owner = { text: 'reasoning', running: false };
  const reasoning = report.props.renderSlot('conversation.chat.reasoning.body', owner);
  assert.equal(reasoning.children[0], owner);
  assert.equal(reasoning.props['data-slot'], 'conversation.chat.reasoning.body');
  assert.equal(reasoning.props.style.display, 'contents');
  const images = { images: [{ attachment: {} }], loadImage: extras.loadImage, align: 'start' };
  assert.equal(report.props.renderSlot('conversation.chat.message.images', images).children[0], images);
  assert.deepEqual(calls.map((call) => call.name), ['conversation.chat.reasoning.content', 'conversation.images.content']);
  assert.throws(() => report.props.renderSlot('unknown.child', {}), /unsupported official child/);
  const again = first(app.render(nodeOf(), extras));
  assert.equal(again.props.renderSlot, report.props.renderSlot, 'stable bridge avoids child hook churn');
});

test('reasoning, running, interrupted, empty and unsupported block layouts keep the exact official node', async (t) => {
  const app = await mount(t, { host: { rev: 1, rows: [{ seq: 7, status: 'ready', text: 'persona' }] } });
  await app.refresh();
  for (const [node, props] of [
    [nodeOf(), { groupPart: 'reasoning' }], [nodeOf(), { groupPart: 'future-part' }],
    [nodeOf(undefined, 'running'), {}], [nodeOf(undefined, 'interrupted'), {}],
    [nodeOf([]), {}], [nodeOf([{ kind: 'image', attachment: {} }]), {}],
    [nodeOf([{ kind: 'text', text: 'first' }, { kind: 'image' }, { kind: 'text', text: 'second' }]), {}],
  ]) {
    const tree = app.render(node, props);
    assert.equal(first(tree).type, AssistantNodeView);
    assert.equal(first(tree).props.node, node);
    assert.equal(all(tree).filter((element) => element.type === 'button').length, 0);
  }
});

test('placeholders and partial rewrites touch only text, and the settled hold is bounded per row', async (t) => {
  const app = await mount(t, { host: { rev: 1, rows: [{ seq: 7, status: 'pending', text: '' }] } });
  await app.refresh();
  const image = { kind: 'image', attachment: {} };
  const node = nodeOf([{ kind: 'text', text: 'original report' }, image]);
  assert.equal(first(app.render(node)).props.node.data.blocks[0].text, '…');
  assert.equal(first(app.renderer.render()).props.node.data.blocks[1], image);
  await app.tick(app.module.__testing.HOLD_PLACEHOLDER_MS);
  assert.equal(first(app.renderer.render()).props.node, node);
  app.state.rows[0].partial = 'rewriting [[0]]'; app.state.rows[0].partialLiterals = ['`safe`'];
  await app.refresh();
  assert.equal(first(app.renderer.render()).props.node.data.blocks[0].text, 'rewriting `safe`');
  app.state.rows = [{ seq: 8, status: 'pending', text: '' }]; await app.refresh();
  assert.equal(first(app.render(nodeOf(undefined, 'settled', 8))).props.node.data.blocks[0].text, '…');
});

test('original controls and review hints remain siblings of the continuously mounted official report', async (t) => {
  const original = 'original report';
  const candidate = 'persona report';
  const review = assessRewrite({ original, candidate, maskedOriginal: original, maskedCandidate: candidate });
  const app = await mount(t, { host: { rev: 1, settings: { reviewThreshold: 0 },
    rows: [{ seq: 7, status: 'ready', text: candidate, final: true, review }] } });
  await app.refresh();
  let tree = app.render(nodeOf(), { t: (key) => key });
  const report = first(tree);
  const controls = all(tree).find((element) => element.props?.['data-persona-shell'] === 'controls');
  assert.ok(controls, 'the controls wrapper is rendered');
  assert.ok(all(controls).some((element) => Array.isArray(element.children) && element.children.includes('persona')),
    'the persona badge is in the controls');
  assert.ok(all(tree).indexOf(controls) < all(tree).indexOf(report), 'controls sit above the official report');
  const button = all(tree).find((element) => element.type === 'button');
  assert.equal(button.children[0], 'origin', 'the original toggle uses the established label');
  assert.ok(all(tree).indexOf(button) < all(tree).indexOf(report), 'controls sit above the official report');
  button.props.onClick();
  tree = app.renderer.render();
  assert.equal(first(tree).type, report.type);
  assert.equal(first(tree).props.node.data.blocks[0].text, candidate);
  const comparison = all(tree).find((element) => element.type === app.module.__testing.ComparisonDialog);
  assert.ok(comparison);
  assert.equal(comparison.props.original, original);
  assert.equal(comparison.props.persona, candidate);
  assert.equal(all(tree).find((element) => element.type === app.module.__testing.ReviewHint), undefined,
    'an old hint must not compete with the modal for Escape');
  comparison.props.onClose(); tree = app.renderer.render();
  const hint = all(tree).find((element) => element.type === app.module.__testing.ReviewHint);
  assert.ok(hint);
  assert.ok(all(tree).indexOf(hint) > all(tree).indexOf(first(tree)), 'the ※ hint stays after the official report');
  const preview = hint.props.renderOriginal();
  assert.equal(preview.type, AssistantNodeView);
  assert.equal(preview.props.node.data.blocks[0].text, original);
});

test('comparison snapshots preserve exact text and never leak into a different or pending row', async (t) => {
  const original = '  original report\n\n';
  const app = await mount(t, { host: { rev: 1,
    rows: [{ seq: 7, status: 'ready', text: 'first persona', final: true }] } });
  await app.refresh();
  let tree = app.render(nodeOf([{ kind: 'text', text: original }]));
  all(tree).find((element) => element.type === 'button').props.onClick();
  tree = app.renderer.render();
  const comparisonOf = (root) => all(root).find((element) => element.type === app.module.__testing.ComparisonDialog);
  assert.equal(comparisonOf(tree).props.original, original);
  assert.equal(comparisonOf(tree).props.persona, 'first persona');
  app.state.rows[0].text = 'updated persona'; await app.refresh();
  tree = app.renderer.render();
  assert.equal(comparisonOf(tree).props.persona, 'first persona', 'an open comparison is a read-only snapshot');
  assert.equal(first(tree).props.node.data.blocks[0].text, 'updated persona');
  app.state.rows[0].status = 'pending'; await app.refresh();
  assert.equal(comparisonOf(app.renderer.render()), undefined);
  app.state.rows[0].status = 'ready'; await app.refresh();
  tree = app.renderer.render();
  assert.equal(comparisonOf(tree), undefined, 'a finished new rewrite does not reopen an old comparison');
  all(tree).find((element) => element.type === 'button').props.onClick();
  tree = app.renderer.render();
  assert.equal(comparisonOf(tree).props.persona, 'updated persona');
  assert.equal(comparisonOf(app.render(nodeOf(undefined, 'settled', 8))), undefined);
});

test('a missing registry face or unsupported host keeps the official entry', async (t) => {
  for (const prepare of [
    ({ slots }) => { slots.entries = undefined; },
    ({ official }) => { official.locale = 'future-chat'; },
    ({ official }) => { official.children['future.child'] = { kind: 'single', scope: 'session' }; },
    ({ official }) => { official.store = {}; },
  ]) {
    const app = await mount(t, { prepare });
    assert.equal(app.own(), undefined);
    assert.equal(app.module.__testing.getChatRendererState().status, 'incompatible');
    assert.equal(app.official.component, AssistantNodeView);
  }
});

test('missing or foreign Content Factories prevent takeover instead of drawing incomplete rows', async (t) => {
  for (const prepare of [
    ({ factories }) => factories.delete('factory:conversation.images.content'),
    ({ factories }) => { factories.get('factory:conversation.chat.reasoning.content').registrant = 'another-plugin'; },
  ]) {
    const app = await mount(t, { prepare });
    assert.equal(app.own(), undefined);
    assert.equal(app.module.__testing.getChatRendererState().reason, 'official-factory-unavailable');
  }
});

test('a new child-slot override releases takeover immediately, and its removal restores delegation', async (t) => {
  const app = await mount(t);
  const stop = app.slots.register({ name: 'conversation.chat.reasoning.body', priority: -5, registrant: 'another-plugin' }, () => null);
  await flush();
  assert.equal(app.own(), undefined);
  assert.equal(app.module.__testing.getChatRendererState().reason, 'child-slot-conflict');
  stop(); await flush();
  assert.ok(app.own());
  assert.equal(app.official.component, AssistantNodeView);
});

test('even an inactive child override with an identical component name opts out of delegation', async (t) => {
  const app = await mount(t);
  const component = app.slots.entries('conversation.chat.message.images')[0].component;
  const stop = app.slots.register({ name: 'conversation.chat.message.images', priority: 101 }, component);
  await flush();
  assert.equal(app.own(), undefined);
  stop(); await flush(); assert.ok(app.own());
});

test('assistant conflicts exit safely but other keyed cells do not affect the adapter', async (t) => {
  const app = await mount(t);
  app.slots.register({ name: CHAT_SLOT, key: 'some-other-node', registrant: 'another-plugin' }, () => null);
  await flush(); assert.ok(app.own());
  const stop = app.slots.register({ name: CHAT_SLOT, key: 'assistant-step', priority: -10, registrant: 'another-plugin' }, () => null);
  await flush();
  assert.equal(app.own(), undefined);
  assert.equal(app.module.__testing.getChatRendererState().reason, 'assistant-slot-conflict');
  stop(); await flush(); assert.ok(app.own());
});

test('quiet factory loss is caught by the settings heartbeat and is retried after restoration', async (t) => {
  const app = await mount(t);
  const factory = app.factories.get('factory:conversation.images.content');
  app.factories.delete('factory:conversation.images.content');
  await app.tick(5000);
  assert.equal(app.own(), undefined);
  app.factories.set('factory:conversation.images.content', factory);
  await app.tick(5000); assert.ok(app.own());
});

test('an entry crash exits once and does not reinstall a failing renderer on each poll', async (t) => {
  const app = await mount(t);
  app.slots.reportEntryError(CHAT_SLOT, app.own().entry);
  await flush();
  assert.equal(app.own(), undefined);
  assert.equal(app.module.__testing.getChatRendererState().status, 'error');
  await app.tick(5000); assert.equal(app.own(), undefined);
  app.settings.enabled = false; await app.tick(5000);
  app.settings.enabled = true; await app.tick(5000); assert.ok(app.own(), 'an explicit off/on allows recovery');
});

test('a Content Factory crash also relinquishes the assistant slot', async (t) => {
  const app = await mount(t);
  app.slots.reportEntryError('factory:conversation.images.content', { component() {} });
  await flush();
  assert.equal(app.own(), undefined);
  assert.equal(app.module.__testing.getChatRendererState().status, 'error');
});

test('official renderer removal and re-registration use the new entry without stale ownership', async (t) => {
  const app = await mount(t);
  app.disposeOfficial(); await flush();
  assert.equal(app.own(), undefined);
  const { component, options, ...metadata } = app.official;
  app.slots.register({ name: CHAT_SLOT, ...options, ...metadata, registrant: CHAT_MODULE }, component);
  await flush(); assert.ok(app.own());
  assert.equal(app.module.__testing.resolveChatDelegate(app.slots, app.own().component).entry,
    app.slots.entries(CHAT_SLOT).find((entry) => entry.registrant === CHAT_MODULE));
});

test('disabled startup and unload leave no persona renderer, timers or registry observers', async (t) => {
  const disabled = await mount(t, { enabled: false });
  assert.equal(disabled.own(), undefined);
  const app = await mount(t);
  app.render(nodeOf());
  assert.ok(app.subscriberCount() > 0);
  app.dispose(); await flush();
  assert.equal(app.own(), undefined);
  assert.equal(app.slots.entriesOfSlot(CHAT_SLOT)[0], app.official);
  assert.equal(app.subscriberCount(), 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.intervals.size, 0);
});

test('progress has a separate list dock and its default-off component starts no poll or view lease', async (t) => {
  const app = await mount(t);
  const dock = app.registrations.find((entry) => entry.options.name === 'conversation.input.dock');
  assert.equal(dock.component, app.module.__testing.ProgressNotice);
  const before = app.timers.size;
  const tree = app.renderer.render(dock.component, { sessionId: 's1' });
  assert.equal(tree, null);
  assert.equal(app.timers.size, before);
  assert.equal(app.requests.filter((request) => request.url.endsWith('/progress-view')).length, 0);
});

test('progress subscribes before any assistant exists, prefixes plain text locally and releases its view', async (t) => {
  const text = '<img src=x onerror=alert(1)> 还没有新的正文。';
  const app = await mount(t, { host: { rev: 1, rows: [], sessionEnabled: true,
    settings: { enabled: true, progressNotices: true }, progress: { text, source: 'observed facts' } } });
  const { ProgressNotice, PROGRESS_PREFIX } = app.module.__testing;
  app.module.__testing.setProgressEnabled(true);
  await app.refresh();
  const tree = app.renderer.render(ProgressNotice, { sessionId: 's1', t: (key) => key });
  assert.equal(tree.props.role, 'status');
  assert.equal(tree.props['data-persona-shell'], 'progress');
  assert.match(tree.props['aria-label'], /插件生成/);
  assert.ok(all(tree).some((node) => node.children.includes(PROGRESS_PREFIX)));
  assert.ok(all(tree).some((node) => node.children.includes(text)), 'model output stays escaped text, not HTML/Markdown');
  assert.ok(!all(tree).some((node) => node.type === 'img' || node.props.dangerouslySetInnerHTML));
  await app.tick(0);
  assert.ok(app.requests.some((request) => request.url.includes('/state?') && request.url.includes('viewing=1')));
  const views = () => app.requests.filter((request) => request.url.endsWith('/progress-view')).map((request) => JSON.parse(request.options.body));
  assert.equal(views().at(-1).visible, true);
  app.state.progress = undefined; await app.refresh();
  assert.equal(app.renderer.render(), null, 'main output can remove the notice without changing any assistant node');
  app.dispose(); await flush();
  assert.equal(views().at(-1).visible, false);
  assert.equal(app.timers.size, 0);
});
