// Optional rc.3 compatibility probe, deliberately outside the dependency-free
// unit suite. See README for fixture preparation and explicit limitations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { assessRewrite } from '../../lib/review.js';

const { values } = parseArgs({ options: {
  fixtures: { type: 'string' }, deps: { type: 'string' },
  'react-deps': { type: 'string' }, cordis: { type: 'string' },
} });
assert.ok(values.fixtures && values.deps, 'Pass --fixtures <rc.3 fixture directory> --deps <test dependency package.json>');
const fixture = (dir) => path.resolve(values.fixtures, dir, 'package/lib/client.js');
for (const dir of ['dsh-client-ui-chat-rc3', 'dsh-client-ui-renderer-rc3', 'dsh-client-ui-slots-rc3', 'attachment-rc3', 'primitives-rc3']) {
  const manifest = JSON.parse(readFileSync(path.resolve(values.fixtures, dir, 'package/package.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.1-rc.3', `exact published fixture version for ${dir}`);
}
const deps = createRequire(path.resolve(values.deps));
const reactDeps = values['react-deps'] ? createRequire(path.resolve(values['react-deps'])) : deps;
const React = reactDeps('react');
const h = React.createElement;
const { flushSync } = reactDeps('react-dom');
const { JSDOM } = deps('jsdom');
const cordis = await import(pathToFileURL(values.cordis ? path.resolve(values.cordis) : deps.resolve('@deepseek-ai/cordis')));
const slotsModule = await import(pathToFileURL(path.resolve(values.fixtures, 'dsh-client-ui-slots-rc3/package/lib/index.js')));
const dom = new JSDOM('<!doctype html><body><main id="app"></main></body>', { url: 'https://example.invalid/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
const { createRoot } = reactDeps('react-dom/client');
const container = document.querySelector('#app');
const browserRoot = createRoot(container);

function region(source, file, prefix = 'client/') {
  const marker = `//#region lib/types/${prefix}${file}.js`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `published fixture contains ${file}`);
  return source.slice(start + marker.length, source.indexOf('//#endregion', start));
}
function cssMap(source, name) {
  const match = source.match(new RegExp(`var ${name} = (\\{[^}]+\\});`));
  assert.ok(match, `published CSS map ${name}`);
  return vm.runInNewContext(`(${match[1]})`);
}
function bundle(source, require) {
  let definition;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, queueMicrotask, console,
  });
  return definition.factory(require);
}

let mounts = 0;
let imageLoaderReceived;
// Leaf primitives and gallery IO are test doubles. All Assistant/Reasoning
// dispatch, default child adapters, SlotRegistry/Core, and React are real.
const primitives = {
  MarkdownText({ text, streaming }) {
    React.useEffect(() => { mounts += 1; }, []);
    return h('div', { className: 'leaf-markdown', 'data-streaming': streaming || undefined }, text);
  },
  JsonBlock: ({ payload }) => h('pre', { 'data-unknown': '' }, JSON.stringify(payload)),
  IconThinkOutlineRegular: () => h('i'), TextShimmer: ({ children }) => h('span', null, children),
  DisclosureRow: ({ title, children, collapsedContent, open, onToggle }) => h('section', { 'data-disclosure': '', 'data-open': open || undefined },
    h('button', { type: 'button', onClick: onToggle }, title), collapsedContent, children),
};
const primitiveSource = readFileSync(path.resolve(values.fixtures, 'primitives-rc3/package/lib/index.js'), 'utf8');
const modalCSS = readFileSync(path.resolve(values.fixtures, 'primitives-rc3/package/lib/Modal.module.css'), 'utf8');
const modalClassNames = Object.fromEntries([...modalCSS.matchAll(/\.([a-z][\w-]*)/gi)]
  .map((match) => [match[1], `official-modal-${match[1]}`]));
const primitiveSandbox = { ...React, ...reactDeps('react/jsx-runtime'), document, HTMLElement,
  createPortal: reactDeps('react-dom').createPortal,
  clsx: (...names) => names.filter(Boolean).join(' '), css$18: modalClassNames,
};
vm.createContext(primitiveSandbox);
vm.runInContext(['keyboard-composition', 'focus', 'useModalLayer', 'Modal'].map((name) => region(primitiveSource, name, '')).join('\n')
  + '\nglobalThis.officialModal = Modal;', primitiveSandbox);
primitives.Modal = primitiveSandbox.officialModal;
const modalStyle = document.createElement('style');
modalStyle.textContent = modalCSS.replace(/\.([a-z][\w-]*)/gi, (match, name) => `.${modalClassNames[name]}`);
document.head.appendChild(modalStyle);
const chatSource = readFileSync(fixture('dsh-client-ui-chat-rc3'), 'utf8');
const assistantCss = cssMap(chatSource, 'AssistantMarkdown_module_css_default');
const chatSandbox = {
  react: React, react_jsx_runtime: reactDeps('react/jsx-runtime'), document,
  _deepseek_ai_dsh_client_ui_primitives: primitives,
  AssistantMarkdown_module_css_default: assistantCss,
  ReasoningRow_module_css_default: cssMap(chatSource, 'ReasoningRow_module_css_default'),
  accessibility_module_css_default: { visuallyHidden: 'visually-hidden' },
  markdownLabels: () => ({}), fileMediaUrl: () => undefined,
};
vm.createContext(chatSandbox);
vm.runInContext(['chat/ReasoningRow', 'chat/AssistantMarkdown', 'chat/AssistantNodeView', 'chat/ReasoningContent']
  .map((name) => region(chatSource, name)).join('\n')
  + '\nglobalThis.official = { AssistantNodeView, ReasoningContent, DefaultReasoningBody };', chatSandbox);
const official = chatSandbox.official;
const imageSandbox = {};
vm.createContext(imageSandbox);
vm.runInContext(region(readFileSync(fixture('attachment-rc3'), 'utf8'), 'MessageImages')
  + '\nglobalThis.adapter = MessageImages;', imageSandbox);
const rendererSource = readFileSync(fixture('dsh-client-ui-renderer-rc3'), 'utf8');
// Expose only the published renderer constructor for the test boot. Production
// installs it through ui-renderer's full shell apply(), which is not run here.
const renderer = bundle(rendererSource.replace('exports.SlotRegistry = SlotRegistry;',
  'exports.__createSlotRenderer = createSlotRenderer; exports.SlotRegistry = SlotRegistry;'), (id) => {
  if (id === '@deepseek-ai/dsh-client-ui-slots') return slotsModule;
  if (id === '@deepseek-ai/cordis') return cordis;
  return reactDeps(id);
});
const ctx = new cordis.Context();
await ctx.plugin(renderer.SlotRegistry);
const slots = ctx.slots;
slots.install(renderer.__createSlotRenderer());
const localeSnapshot = {};
slots.installLocale({ bind: () => (key) => key, getSnapshot: () => localeSnapshot, subscribe: () => () => {} });
const binding = { ctx, key: 's1', hooks: {}, keyedHooks: {}, props: { sessionId: 's1' } };
const bindingSource = { getSnapshot: () => binding, subscribe: () => () => {} };
slots.installScope('session', { current: bindingSource, bindingSource: () => bindingSource,
  renderArea: (_binding, props) => props.children });
let owner;
const commonProps = {
  useDisclosure() {
    const [expanded, setExpanded] = React.useState(false);
    return { expanded, toggle: () => setExpanded((value) => !value) };
  },
  useGroupAction: () => undefined, useTurnData: () => undefined,
  openFile() {}, loadImage() {}, fileMentions: () => undefined,
};
slots.register({ name: 'root', children: {
  'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: commonProps },
  'settings.section': { kind: 'list', scope: 'root' },
  'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  'conversation.input.dock': { kind: 'list', scope: 'session' },
} }, (props) => h(React.Fragment, null,
  props.renderSlot('conversation.chat.node', owner, { entryKey: 'assistant-step' }),
  h('div', { 'data-test-progress-dock': '' }, props.renderSlot('conversation.input.dock', { session: { id: 's1' }, input: {} })),
));
slots.register({ name: 'conversation.input.dock', id: 'existing-dock-item' }, () => h('span', { 'data-existing-dock': '' }, 'existing dock'));
const policy = { settledReasoningPreview: true };
const policySource = { getSnapshot: () => policy, subscribe: () => () => {} };
const assistantOptions = {
  name: 'conversation.chat.node', key: 'assistant-step', locale: 'chat',
  children: { 'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
    'conversation.chat.message.images': { kind: 'single', scope: 'session' } },
  inject: () => ({ hooks: { presentation: policySource } }),
};
// Exercise Cordis's actual unnamed-module/display-name path, no manual
// registrant stamps. The official adapters below are unmodified bundle regions.
await ctx.plugin({ inject: ['slots'], apply(ctx) {
  ctx.slots.registerFactory({ name: 'conversation.chat.reasoning.content', scope: 'root', locale: 'chat' }, official.ReasoningContent);
  ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register({ name: 'conversation.chat.reasoning.body', priority: 100 }, official.DefaultReasoningBody));
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(assistantOptions, official.AssistantNodeView));
} });
await ctx.plugin({ inject: ['slots'], apply(ctx) {
  ctx.slots.registerFactory({ name: 'conversation.images.content', scope: 'root', locale: 'conversation' }, (props) => {
    imageLoaderReceived = props.loadImage;
    return h('div', { 'data-gallery': props.images.length }, 'gallery');
  });
  ctx.slots.inject('conversation.chat.message.images', () => ctx.slots.register({ name: 'conversation.chat.message.images', priority: 100 }, imageSandbox.adapter));
} });
const originalEntry = slots.entries('conversation.chat.node')[0];
const blocks = [
  { kind: 'reasoning', text: 'original reasoning' }, { kind: 'text', text: 'original report' },
  { kind: 'image', attachment: { id: 'one' } }, { kind: 'image', attachment: { id: 'two' } },
  { kind: 'other', block: { preserved: 'unknown-block' } },
];
const node = { key: 'n1', kind: 'assistant-step', location: { kind: 'root' },
  data: { status: 'settled', step: 1, finalNode: { seq: 7 }, blocks } };
const before = JSON.stringify(node);
for (const block of blocks) Object.freeze(block);
Object.freeze(blocks); Object.freeze(node.data); Object.freeze(node);
owner = { node };
const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const render = () => { flushSync(() => browserRoot.render(slots.renderSlot('root', {}))); return container.innerHTML; };
const click = (element) => { assert.ok(element); flushSync(() => element.click()); };
const main = () => container.querySelector(`[data-slot="conversation.chat.node"] > .${assistantCss.root}`);
render();
assert.ok(main());
click(container.querySelector('[data-disclosure] button'));
assert.match(main().textContent, /original reasoning/);
const baseline = main().outerHTML;
const review = assessRewrite({ original: 'original report', candidate: 'persona report',
  maskedOriginal: 'original report', maskedCandidate: 'persona report' });
const host = { rev: 1, rows: [{ seq: 7, status: 'ready', text: 'persona report', final: true, review }],
  settings: { enabled: true, reviewThreshold: 0.01 }, sessionEnabled: true };
const settings = { enabled: true };
let plugin;
vm.runInNewContext(readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { plugin = value.factory((id) => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : reactDeps(id)); } } },
  console, document, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async (url) => ({ ok: true, json: async () => String(url).includes('/state') ? host : { settings } }),
});
const fiber = await ctx.plugin(plugin);
try {
  await settle();
  await plugin.__testing.refreshState('s1');
  render();
  assert.equal(plugin.__testing.getChatRendererState().status, 'delegated');
  assert.equal(originalEntry.component, official.AssistantNodeView);
  click(container.querySelector('[data-disclosure] button'));
  assert.equal(main().outerHTML.replace('persona report', 'original report'), baseline,
    'official class names, child-slot anchors, DOM path and nontext branches match the baseline');
  assert.equal(imageLoaderReceived, commonProps.loadImage);
  assert.equal(JSON.stringify(node), before);
  const mainBefore = main();
  const reasoningBefore = main().querySelector('[data-disclosure]');
  const mountedBefore = mounts;
  const compareTrigger = container.querySelector('[data-persona-shell="controls"] button');
  compareTrigger.focus(); click(compareTrigger);
  assert.equal(main(), mainBefore);
  assert.equal(main().querySelector('[data-disclosure]'), reasoningBefore);
  assert.equal(main().querySelector('[data-disclosure]').dataset.open, 'true');
  let dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  assert.ok(dialog);
  assert.equal(container.contains(dialog), false, 'comparison is portaled outside the transcript');
  assert.match(dialog.querySelector('[data-comparison-side="original"]').textContent, /original report/);
  assert.match(dialog.querySelector('[data-comparison-side="persona"]').textContent, /persona report/);
  assert.equal(dialog.querySelector('[data-gallery]'), null);
  assert.equal(mounts, mountedBefore + 2, 'only the two read-only Markdown previews are mounted');
  const originalPreview = dialog.querySelector('[data-comparison-side="original"]');
  const surface = dialog.querySelector('.persona-shell-comparison-surface');
  surface.getBoundingClientRect = () => ({ width: 600 });
  flushSync(() => dom.window.dispatchEvent(new dom.window.Event('resize')));
  assert.equal(surface.dataset.narrow, 'true');
  assert.equal(dialog.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
  const tabs = dialog.querySelectorAll('[role="tab"]');
  click(tabs[1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(dialog.querySelector('[data-comparison-side="original"]'), originalPreview);
  const close = dialog.querySelector('[data-modal-autofocus]');
  close.focus();
  flushSync(() => close.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, dialog.querySelector('[data-comparison-side="persona"]'));
  flushSync(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(document.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, compareTrigger, 'official modal restores its trigger focus');
  assert.equal(main(), mainBefore);
  click(compareTrigger);
  dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  click(dialog.previousElementSibling);
  assert.equal(document.querySelector('[role="dialog"][aria-modal="true"]'), null, 'mask click closes the modal');
  const hint = container.querySelector('button[aria-label="改写变化提示，查看原文"]');
  click(hint);
  assert.match(document.querySelector('[data-persona-shell="review-panel"]').textContent, /original report/);
  assert.equal(container.querySelector('[data-persona-shell="review-panel"]'), null, 'hint preview escapes transcript clipping');
  assert.equal(main(), mainBefore);
  flushSync(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[data-persona-shell="review-panel"]'), null);
  for (const status of ['running', 'interrupted']) {
    owner = { node: { ...node, data: { ...node.data, status } } }; render();
    assert.match(main().textContent, /original report/);
    assert.ok(!main().textContent.includes('persona report'));
    assert.equal(container.querySelector('[data-persona-shell="controls"]'), null);
    if (status === 'running') assert.equal(main().dataset.streaming, 'true');
    else assert.match(main().textContent, /message.stopped/);
  }
  owner = { node, groupPart: 'reasoning' }; render();
  assert.match(main().textContent, /original reasoning/);
  assert.ok(!main().textContent.includes('persona report'));
  owner = { node }; render();
  const beforeNotice = main();
  const beforeNoticeReasoning = main().querySelector('[data-disclosure]');
  host.settings.progressNotices = true; settings.progressNotices = true;
  plugin.__testing.setProgressEnabled(true);
  host.progress = { text: '<img src=x> no new report yet', source: 'only observed counts' };
  host.rev += 1;
  await plugin.__testing.refreshState('s1'); render(); await settle(); render();
  const notice = container.querySelector('[data-persona-shell="progress"]');
  assert.ok(notice?.closest('[data-test-progress-dock]'), 'real session-scoped list dock renders the notice');
  assert.match(notice.textContent, /^◈<img src=x> no new report yet$/);
  assert.equal(notice.querySelector('img'), null, 'generated text is never interpreted as HTML');
  assert.ok(container.querySelector('[data-existing-dock]'), 'other dock entries remain visible');
  assert.equal(main(), beforeNotice);
  assert.equal(main().querySelector('[data-disclosure]'), beforeNoticeReasoning);
  host.progress = undefined; host.rev += 1;
  await plugin.__testing.refreshState('s1'); render();
  assert.equal(container.querySelector('[data-persona-shell="progress"]'), null);
  host.settings.progressNotices = false; settings.progressNotices = false;
  plugin.__testing.setProgressEnabled(false); render();
  const stopOverride = slots.register({ name: 'conversation.chat.message.images', priority: -5 }, () => h('div', { 'data-foreign-gallery': '' }, 'foreign gallery'));
  await settle(); render();
  assert.equal(plugin.__testing.getChatRendererState().status, 'incompatible');
  assert.match(main().textContent, /original report/);
  assert.ok(main().querySelector('[data-foreign-gallery]'));
  stopOverride(); await settle(); render();
  assert.equal(plugin.__testing.getChatRendererState().status, 'delegated');
  host.sessionEnabled = false; host.rev += 1;
  await plugin.__testing.refreshState('s1'); render();
  assert.match(main().textContent, /original report/);
  host.sessionEnabled = true; host.rev += 1;
  await plugin.__testing.refreshState('s1'); render();
  assert.match(main().textContent, /persona report/);
  const waitForStatus = async (status) => {
    const deadline = Date.now() + 7000;
    while (plugin.__testing.getChatRendererState().status !== status && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(plugin.__testing.getChatRendererState().status, status);
    render();
  };
  settings.enabled = false;
  await waitForStatus('disabled');
  assert.equal(slots.entriesOfSlot('conversation.chat.node')[0], originalEntry);
  assert.match(main().textContent, /original report/);
  settings.enabled = true;
  await waitForStatus('delegated');
  assert.match(main().textContent, /persona report/);
  await fiber.dispose(); await settle(); render();
  assert.equal(slots.entriesOfSlot('conversation.chat.node')[0], originalEntry);
  assert.match(main().textContent, /original report/);
  assert.ok(main().querySelector('[data-gallery="2"]'));
  assert.equal(JSON.stringify(node), before);
  console.log(JSON.stringify({ result: 'passed', target: '0.2.1-rc.3', registrant: originalEntry.registrant,
    assertions: ['actual production plugin + Cordis SlotRegistry/Core + React DOM', 'immutable mixed-block delegation',
      'default DOM/class/slot anchors match', 'official comparison Modal portal/focus/Tab/Escape/mask',
      'responsive tabs without preview remount', 'comparison/hint preserve main DOM and disclosure',
      'separate progress dock preserves assistant DOM, disclosure and other entries',
      'streaming/interruption/reasoning preserved', 'child conflict exits and recovers', 'session bypass',
      'real settings off/on releases and restores', 'Cordis unload restores official'],
    limitations: 'Leaf primitives, gallery IO and domain hook data use test doubles; not a live Desktop, real model, CSS layout or image loading test.',
  }, null, 2));
} finally {
  await fiber.dispose();
  flushSync(() => browserRoot.unmount());
  await ctx.fiber.dispose();
  dom.window.close();
}
