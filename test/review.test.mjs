import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assessRewrite, restoreReview, reviewFingerprint } from '../lib/review.js';
import { resolveConfig } from '../lib/config.js';
import { mask, unmask } from '../lib/mask.js';
import { rewriteDistance, validateRewrite } from '../lib/prompt.js';
import { normalizePack } from '../lib/pack.js';
import { makeSlots, AssistantNodeView } from './helpers/slots.mjs';

const assess = (original, candidate) => assessRewrite({
  original, candidate, maskedOriginal: original, maskedCandidate: candidate,
});

function fakeDocument() {
  const listeners = new Map();
  const observers = new Set();
  const document = {
    activeElement: null,
    width: 1000,
    height: 900,
    body: {},
    anchorRect: { left: 40, right: 68, top: 820, bottom: 848, width: 28, height: 28 },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatch(name, event) { for (const fn of [...(listeners.get(name) ?? [])]) fn(event); },
    listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
  document.documentElement = {
    get clientWidth() { return document.width; },
    get clientHeight() { return document.height; },
  };
  document.defaultView = {
    addEventListener: (name, fn) => document.addEventListener(`window:${name}`, fn),
    removeEventListener: (name, fn) => document.removeEventListener(`window:${name}`, fn),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
  };
  document.resize = (width) => {
    document.width = width;
    for (const observer of observers) observer.callback();
    document.dispatch('window:resize', {});
  };
  document.observerCount = () => observers.size;
  return document;
}

/** Stateful hooks/effect cleanup and DOM refs, rather than source-text assertions. */
function hookRenderer(document) {
  const hooks = [];
  const dom = new Map();
  let cursor = 0;
  let pending = [];
  let dirty = false;
  let component;
  let props;
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
      const old = hooks[index];
      if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
        hooks[index] = { deps, cleanup: old?.cleanup };
        pending.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
    useCallback: (fn) => fn,
    memo: (fn) => fn,
  };
  function attach(element, path = 'root', parent) {
    if (!element || typeof element !== 'object') return undefined;
    if (Array.isArray(element)) return undefined;
    let node = dom.get(path);
    if (!node || node.type !== element.type) {
      node = {
        type: element.type,
        ownerDocument: document,
        scrollTop: 0,
        getBoundingClientRect() {
          if (this.props['aria-label'] === '改写变化提示，查看原文') return document.anchorRect;
          return { left: 0, top: 0, right: document.width, bottom: 400, width: document.width, height: 400 };
        },
        contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
        focus() {
          const previous = document.activeElement;
          if (previous === this) return;
          document.activeElement = this;
          for (let ancestor = previous; ancestor; ancestor = ancestor.parent) {
            ancestor.props.onBlur?.({ currentTarget: ancestor, relatedTarget: this });
          }
          for (let ancestor = this; ancestor; ancestor = ancestor.parent) {
            ancestor.props.onFocus?.({ currentTarget: ancestor, relatedTarget: previous });
          }
        },
      };
      dom.set(path, node);
    }
    node.props = element.props;
    node.parent = parent;
    node.children = element.children.flat(Infinity).map((child, index) => attach(child, `${path}.${index}`, node)).filter(Boolean);
    if (element.props.ref) element.props.ref.current = node;
    element.dom = node;
    return node;
  }
  return {
    React,
    render(nextComponent = component, nextProps = props) {
      component = nextComponent;
      props = nextProps;
      let cycles = 0;
      do {
        assert.ok(cycles++ < 10, 'hooks settle without an update loop');
        dirty = false;
        cursor = 0;
        pending = [];
        tree = component(props);
        attach(tree);
        for (const run of pending) run();
      } while (dirty);
      return tree;
    },
    dispose() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function loadClient({ React, document, markdown = true, fetch = async () => { throw new Error('no host'); } } = {}) {
  let definition;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document, setTimeout, clearTimeout, fetch, console, URLSearchParams, AbortController,
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
  const shipped = function MarkdownText() {};
  const Modal = function Modal() {};
  const portals = [];
  const module = definition.factory((id) => {
    if (id === 'react') return React ?? {};
    // Keep the element inspectable in this harness; browser tests assert actual DOM separation.
    if (id === 'react-dom') return { createPortal: (element, target) => { portals.push({ element, target }); return element; } };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: markdown ? shipped : undefined, Modal };
    throw new Error(id);
  });
  return { module, shipped, Modal, portals };
}

function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  return [element, ...element.children.flatMap(nodes)];
}
const byRole = (tree, role) => nodes(tree).find((node) => node.props.role === role);
const button = (tree) => nodes(tree).find((node) => node.type === 'button');

test('local review is quiet for identity and measures additions as well as deletions', () => {
  assert.equal(assess('已完成检查。', '已完成检查。').editScore, 0);
  const original = '已完成检查。';
  const candidate = '已完成检查。部署也已完成。';
  assert.equal(rewriteDistance(original, candidate).novelShare, 0, 'the old diagnostic retains its semantics');
  assert.ok(assess(original, candidate).editScore > 0.4, 'appended claims no longer look identical');
  assert.ok(assess(candidate, original).editScore > 0.4, 'removals also count');
  assert.ok(assess('已经完成了检查。', '已经完成了检查哦。').editScore < 0.55);
  assert.equal(assess('', '').editScore, 0);
  assert.equal(assess('甲', '乙').editScore, 1);
});

test('negation, conditions, uncertainty and quantity changes are review signals, not hard verdicts', () => {
  for (const [original, candidate, reason] of [
    ['可以删除备份。', '不可以删除备份。', 'negation-change'],
    ['如果测试通过，可以部署。', '测试通过，可以部署。', 'condition-change'],
    ['可能已经修复。', '已经修复。', 'uncertainty-change'],
    ['有 2 个问题。', '有 3 个问题。', 'quantity-change'],
    ['You can deploy.', 'You cannot deploy.', 'negation-change'],
    ['It might work if tests pass.', 'It works. Tests pass.', 'uncertainty-change'],
  ]) assert.ok(assess(original, candidate).reasons.includes(reason), `${original} -> ${candidate}`);
  // The heuristic can over-warn on equivalent wording, and misses some task
  // reorderings. A quiet hint is never advertised as semantic validation.
  assert.ok(assess('并不复杂。', '很简单。').reasons.includes('negation-change'));
  assert.ok(assess('建议先执行测试，再执行构建。', '建议先执行构建，再执行测试。').editScore < 0.55);
});

test('unchanged code cannot dilute the prose score, and reordered literals raise a signal', () => {
  const original = `检查完成。\n\`\`\`js\n${'const unchanged = true;\n'.repeat(100)}\`\`\``;
  const { masked, literals } = mask(original);
  const maskedCandidate = '鲸鲸把这部分收拾好了。\n[[0]]';
  const review = assessRewrite({ original, candidate: unmask(maskedCandidate, literals), maskedOriginal: masked, maskedCandidate });
  assert.ok(review.editScore > 0.55);
  const reordered = '先 [[1]]，再 [[0]]。';
  assert.equal(validateRewrite({ original: '先 [[0]]，再 [[1]]。', candidate: reordered, literalCount: 2, maxRatio: 1.35 }).ok, true);
  assert.ok(assess('先 [[0]]，再 [[1]]。', reordered).reasons.includes('literal-order'));
});

test('review metadata is versioned, bounded and optional', () => {
  const review = assess('检查好了。', '鲸鲸收拾妥当啦。');
  assert.deepEqual(restoreReview(review), review);
  for (const bad of [undefined, null, {}, { ...review, version: 2 }, { ...review, editScore: NaN },
    { ...review, editScore: 2 }, { ...review, reasons: ['unknown'] }, { ...review, sourceHash: '' }]) {
    assert.equal(restoreReview(bad), undefined);
  }
});

test('review settings reject wrong types and out-of-range thresholds', () => {
  assert.equal(resolveConfig({}).reviewHints, true);
  assert.equal(resolveConfig({}).reviewThreshold, 0.55);
  for (const value of [-1, 1.1, Infinity, NaN, '0.4', null]) {
    assert.equal(resolveConfig({ reviewThreshold: value }).reviewThreshold, 0.55);
  }
  assert.equal(resolveConfig({ reviewHints: false, reviewThreshold: 0 }).reviewThreshold, 0);
  assert.equal(resolveConfig({ reviewThreshold: 1 }).reviewThreshold, 1);
});

test('client review gating binds both texts and reuses the saved score at new thresholds', () => {
  const { reviewNeeded, reviewFingerprint: clientFingerprint } = loadClient().module.__testing;
  for (const text of ['', '中文\n`code`', '👩🏽‍💻\r\nEND', 'a'.repeat(8000)]) {
    assert.equal(clientFingerprint(text), reviewFingerprint(text));
  }
  const original = '已经完成了检查。';
  const text = '已经完成了检查哦。';
  const review = assess(original, text);
  const row = { status: 'ready', text, review, final: false };
  assert.equal(reviewNeeded(row, original, { reviewThreshold: 0.55 }), false);
  assert.equal(reviewNeeded(row, original, { reviewThreshold: 0.05 }), true);
  assert.equal(reviewNeeded(row, original, { reviewHints: false, reviewThreshold: 0 }), false);
  assert.equal(reviewNeeded({ ...row, status: 'pending' }, original, { reviewThreshold: 0 }), false);
  assert.equal(reviewNeeded({ ...row, review: undefined }, original, { reviewThreshold: 0 }), false);
  assert.equal(reviewNeeded({ ...row, review: { ...review, version: 2 } }, original, { reviewThreshold: 0 }), false);
  assert.equal(reviewNeeded(row, `${original} 已更新`, { reviewThreshold: 0 }), false);
  assert.equal(reviewNeeded({ ...row, text: `${text} 后编辑` }, original, { reviewThreshold: 0 }), false);
  assert.equal(reviewNeeded({ status: 'ready', text: original, review: assess(original, original) }, original, { reviewThreshold: 0 }), false);
  const negated = '不可以删除备份。';
  const negatedReview = assess('可以删除备份。', negated);
  assert.ok(negatedReview.reasons.length > 0, 'the heuristic notices the negation');
  assert.equal(reviewNeeded({ status: 'ready', text: negated, review: negatedReview }, '可以删除备份。', { reviewThreshold: 1 }), false,
    'a reason alone does not bypass the threshold');
  assert.equal(reviewNeeded({ status: 'ready', text: negated, review: negatedReview }, '可以删除备份。', { reviewThreshold: 0.01 }), true);
});

function interactionFixture(t) {
  const document = fakeDocument();
  const renderer = hookRenderer(document);
  t.after(() => renderer.dispose());
  const { module, shipped, portals } = loadClient({ React: renderer.React, document });
  const original = '## 原始结论\n\n先跑 `npm test`，**通过后**再部署。\n\n- 第一项\n- 第二项\n\n$x^2$';
  const review = assess(original, '鲸鲸来汇报啦。');
  const render = () => renderer.render(module.__testing.ReviewHint, { original, review });
  return { document, renderer, shipped, original, render, portals };
}

test('review placement flips above bottom anchors, below top anchors, and clamps narrow viewports', () => {
  const { reviewPlacement } = loadClient().module.__testing;
  const bounds = { left: 12, right: 988, top: 12, bottom: 888 };
  const bottom = reviewPlacement({ left: 40, top: 820, bottom: 848 }, 400, bounds);
  assert.equal(bottom.top, 414);
  assert.equal(bottom.width, 560);
  assert.ok(bottom.top + Math.min(400, bottom.maxHeight) < 820);
  const top = reviewPlacement({ left: 40, top: 30, bottom: 58 }, 400, bounds);
  assert.equal(top.top, 64);
  const narrow = reviewPlacement({ left: 300, top: 500, bottom: 528 }, 400,
    { left: 12, right: 308, top: 12, bottom: 628 });
  assert.equal(narrow.left, 12);
  assert.equal(narrow.width, 296);
  assert.ok(narrow.top >= 12 && narrow.top + narrow.maxHeight <= 628);
});

test('review preview portals to the body, follows scrolling/resizing and closes offscreen', (t) => {
  const { document, render, portals } = interactionFixture(t);
  let tree = render();
  assert.equal(tree.props.style.display, 'inline-flex', 'blank space beside the mark is not a hover target');
  tree.props.onMouseEnter();
  let panel = byRole(render(), 'tooltip');
  assert.equal(portals.at(-1).target, document.body);
  assert.equal(panel.props.style.position, 'fixed');
  assert.equal(panel.props.style.top, 414);
  document.anchorRect = { ...document.anchorRect, top: 30, bottom: 58 };
  document.dispatch('window:scroll', {});
  panel = byRole(render(), 'tooltip');
  assert.equal(panel.props.style.top, 64);
  document.resize(320);
  panel = byRole(render(), 'tooltip');
  assert.equal(panel.props.style.left, 12);
  assert.equal(panel.props.style.width, 296);
  document.anchorRect = { ...document.anchorRect, top: -50, bottom: -22 };
  document.dispatch('window:scroll', {});
  assert.equal(byRole(render(), 'tooltip'), undefined);
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.observerCount(), 0);
});

test('hint hover/focus previews the actual original with official Markdown rendering and Escape remains dismissed until re-entry', (t) => {
  const { document, shipped, original, render } = interactionFixture(t);
  let tree = render();
  assert.equal(byRole(tree, 'tooltip'), undefined);
  tree.props.onMouseEnter();
  tree = render();
  const tooltip = byRole(tree, 'tooltip');
  assert.ok(tooltip);
  const markdown = nodes(tooltip).filter((node) => node.type === shipped);
  assert.equal(markdown.length, 1, 'hover uses the shipped Markdown renderer');
  assert.equal(markdown[0].props.text, original);
  assert.equal(nodes(tooltip).filter((node) => node.type === 'button').length, 0, 'preview has no interactive controls');
  let prevented = false;
  document.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  tree = render();
  assert.ok(prevented);
  assert.equal(byRole(tree, 'tooltip'), undefined);
  tree = render();
  assert.equal(byRole(tree, 'tooltip'), undefined, 'hover alone cannot immediately reopen a dismissed hint');
  tree.props.onMouseLeave();
  tree = render();
  button(tree).dom.focus();
  tree = render();
  assert.ok(byRole(tree, 'tooltip'), 'keyboard focus also previews');
  document.dispatch('pointerdown', { target: {} });
  assert.equal(byRole(render(), 'tooltip'), undefined);
});

test('click/touch pins a nonmodal original popup with the whole official Markdown renderer', (t) => {
  const { document, shipped, original, render } = interactionFixture(t);
  let tree = render();
  button(tree).props.onClick(); // No hover/focus prerequisite: also the touch path.
  tree = render();
  const dialog = byRole(tree, 'dialog');
  assert.ok(dialog);
  assert.equal(document.activeElement, dialog.dom);
  const markdown = nodes(dialog).filter((node) => node.type === shipped);
  assert.equal(markdown.length, 1);
  assert.equal(markdown[0].props.text, original, 'no sentence splitting or Markdown rewriting');
  tree.props.onMouseLeave();
  assert.ok(byRole(render(), 'dialog'), 'pinned popup survives mouse leave');
  const close = nodes(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '关闭原文预览');
  close.props.onClick();
  tree = render();
  assert.equal(byRole(tree, 'dialog'), undefined);
  assert.equal(byRole(tree, 'tooltip'), undefined, 'focus restoration must not immediately reopen the preview');
  assert.equal(document.activeElement, button(tree).dom);
  button(tree).props.onClick();
  tree = render();
  document.dispatch('pointerdown', { target: button(tree).dom });
  assert.ok(byRole(render(), 'dialog'), 'inside clicks do not dismiss');
  document.dispatch('pointerdown', { target: {} });
  assert.equal(byRole(render(), 'dialog'), undefined);
});

test('Escape closes a pinned hint and unmount removes all document listeners', (t) => {
  const { document, renderer, render } = interactionFixture(t);
  button(render()).props.onClick();
  render();
  assert.equal(document.listenerCount(), 4, 'dismissal plus scroll/resize positioning listeners');
  assert.equal(document.observerCount(), 1);
  document.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  let tree = render();
  assert.equal(byRole(tree, 'dialog'), undefined);
  assert.equal(byRole(tree, 'tooltip'), undefined);
  assert.equal(document.activeElement, button(tree).dom);
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.observerCount(), 0);
  button(tree).props.onClick();
  tree = render();
  assert.ok(byRole(tree, 'dialog'));
  renderer.dispose();
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.observerCount(), 0);
});

function comparisonFixture(t, options = {}) {
  const document = fakeDocument();
  const renderer = hookRenderer(document);
  const { module, shipped, Modal } = loadClient({ React: renderer.React, document, ...options });
  const original = '## 原始结论\n\n先跑 `npm test`，通过后再部署。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$$x^2$$';
  const persona = '## 鲸鲸汇报\n\n先跑 `npm test` 哦，确认通过后再部署。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$$x^2$$';
  let closed = 0;
  const render = () => renderer.render(module.__testing.ComparisonDialog, { original, persona, onClose: () => { closed += 1; } });
  t.after(() => renderer.dispose());
  return { document, renderer, module, shipped, Modal, original, persona, render, closed: () => closed };
}

test('comparison uses the official modal with two complete Markdown documents, not assistant copies', (t) => {
  const { Modal, shipped, original, persona, render, closed } = comparisonFixture(t);
  const tree = render();
  assert.equal(tree.type, Modal);
  assert.equal(tree.props.open, true);
  assert.equal(tree.props.headless, true);
  assert.deepEqual(nodes(tree).filter((node) => node.type === shipped).map((node) => node.props.text), [original, persona]);
  assert.equal(nodes(tree).filter((node) => node.type === AssistantNodeView).length, 0);
  assert.equal(nodes(tree).find((node) => node.props.role === 'tablist').props.hidden, true);
  const panes = nodes(tree).filter((node) => node.type === 'section');
  assert.ok(panes.every((pane) => pane.props.role === 'region' && pane.props.hidden === false));
  button(tree).props.onClick();
  assert.equal(closed(), 1);
  tree.props.onClose();
  assert.equal(closed(), 2, 'official mask and Escape use the same close command');
});

test('narrow comparison tabs keep both panes mounted and restore independent reading positions', (t) => {
  const { document, render } = comparisonFixture(t);
  document.width = 600;
  let tree = render();
  const panes = nodes(tree).filter((node) => node.type === 'section');
  const scroll = (root, side) => nodes(root).find((node) => node.props['data-comparison-side'] === side);
  const originalDOM = scroll(tree, 'original').dom;
  assert.equal(panes[0].props.role, 'tabpanel');
  assert.equal(panes[0].props.hidden, false);
  assert.equal(panes[1].props.hidden, true);
  originalDOM.scrollTop = 240;
  scroll(tree, 'original').props.onScroll({ currentTarget: originalDOM });
  nodes(tree).find((node) => node.props.role === 'tab' && node.children.includes('人格版')).props.onClick();
  tree = render();
  const personaDOM = scroll(tree, 'persona').dom;
  personaDOM.scrollTop = 150;
  scroll(tree, 'persona').props.onScroll({ currentTarget: personaDOM });
  originalDOM.scrollTop = 0;
  nodes(tree).find((node) => node.props.role === 'tab' && node.children.includes('原文')).props.onClick();
  tree = render();
  assert.equal(scroll(tree, 'original').dom, originalDOM);
  assert.equal(originalDOM.scrollTop, 240);
  document.resize(1000); tree = render();
  assert.ok(nodes(tree).filter((node) => node.type === 'section').every((pane) => pane.props.hidden === false));
  assert.equal(scroll(tree, 'original').dom, originalDOM);
  assert.equal(scroll(tree, 'persona').dom, personaDOM);
  assert.equal(personaDOM.scrollTop, 150);
});

test('comparison tabs implement arrow/Home/End navigation and matching ARIA relationships', (t) => {
  const { document, render } = comparisonFixture(t);
  document.width = 400;
  let tree = render();
  for (const [key, label] of [['ArrowRight', '人格版'], ['Home', '原文'], ['End', '人格版'], ['ArrowLeft', '原文']]) {
    let prevented = false;
    byRole(tree, 'tablist').props.onKeyDown({ key, preventDefault() { prevented = true; } });
    tree = render();
    const selected = nodes(tree).find((node) => node.props.role === 'tab' && node.props['aria-selected']);
    assert.equal(prevented, true);
    assert.equal(selected.children[0], label);
    assert.equal(selected.props.tabIndex, 0);
    assert.equal(document.activeElement, selected.dom);
    const panel = nodes(tree).find((node) => node.props.id === selected.props['aria-controls']);
    assert.equal(panel.props.hidden, false);
    assert.equal(panel.props['aria-labelledby'], selected.props.id);
  }
});

test('comparison resize observers/listeners are released on unload, with a resize-only fallback', (t) => {
  const first = comparisonFixture(t);
  first.render();
  assert.equal(first.document.observerCount(), 1);
  assert.equal(first.document.listenerCount(), 1);
  first.renderer.dispose();
  assert.equal(first.document.observerCount(), 0);
  assert.equal(first.document.listenerCount(), 0);
  const second = comparisonFixture(t);
  second.document.defaultView.ResizeObserver = undefined;
  second.render(); second.document.resize(400);
  assert.equal(byRole(second.render(), 'tablist').props.hidden, false);
});

test('comparison keeps original text accessible if MarkdownText is missing', (t) => {
  const { original, persona, render } = comparisonFixture(t, { markdown: false });
  const tree = render();
  const fallbacks = nodes(tree).filter((node) => node.props.style?.whiteSpace === 'pre-wrap');
  assert.deepEqual(fallbacks.map((node) => node.children[0]), [original, persona]);
});

test('ready mid-turn reports show hints without disturbing the main Markdown document', async (t) => {
  const document = fakeDocument();
  const renderer = hookRenderer(document);
  const original = '## 检查\n\n条件确认后再继续。';
  const text = '## 鲸鲸汇报\n\n条件都核过啦，接着往前走哦。';
  const row = { seq: 1, status: 'ready', text, final: false, review: assess(original, text), processNote: '哼，这段工具可没闲着。' };
  const host = { rev: 1, settings: { enabled: true, reviewHints: true, reviewThreshold: 0,
    processToolUsage: true, includeToolSteps: true }, rows: [row] };
  const { module } = loadClient({
    React: renderer.React, document,
    fetch: async (url) => ({ ok: true, json: async () => String(url).includes('/state') ? host : { settings: host.settings } }),
  });
  const effects = [];
  const { slots, registrations } = makeSlots();
  module.apply({
    effect(fn) { const stop = fn(); if (typeof stop === 'function') effects.push(stop); },
    slots,
  });
  t.after(() => { renderer.dispose(); for (const stop of effects) stop(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const step = registrations.find((entry) => entry.options.key === 'assistant-step').component;
  assert.ok(step);
  const props = {
    delegate: module.__testing.resolveChatDelegate(slots, step), renderFactorySlot: () => null,
    sessionId: 's1', groupPart: 'response',
    node: { data: { status: 'settled', blocks: [{ kind: 'text', text: original }], finalNode: { seq: 1 } } },
  };
  renderer.render(module.__testing.PersonaStep, props);
  await new Promise((resolve) => setTimeout(resolve, 20));
  let tree = renderer.render();
  assert.equal(nodes(tree).filter((node) => node.type === module.__testing.ReviewHint).length, 1, 'a non-final report can carry a hint');
  assert.equal(nodes(tree).filter((node) => node.type === 'button').length, 0, 'no final-row header was added');
  assert.deepEqual(nodes(tree).filter((node) => node.type === AssistantNodeView).map((node) => node.props.node.data.blocks[0].text), [text]);
  const note = (root) => nodes(root).find((node) => node.props['data-persona-shell'] === 'process-note');
  assert.deepEqual(note(tree).children, [row.processNote], 'plain text is a separate sibling, outside official report text');
  const official = nodes(tree).find((node) => node.type === AssistantNodeView);
  host.settings.processToolUsage = false;
  tree = renderer.render();
  assert.equal(note(tree), undefined);
  assert.equal(nodes(tree).find((node) => node.type === AssistantNodeView).type, official.type);
  host.settings.processToolUsage = true;
  row.final = true;
  assert.equal(note(renderer.render()), undefined, 'final reports never display an aside');
  row.final = false;
  host.settings.includeToolSteps = false;
  assert.equal(note(renderer.render()), undefined);
  host.settings.includeToolSteps = true;
  row.processNote = '字'.repeat(41);
  assert.equal(note(renderer.render()), undefined, 'the client also bounds restored/wire notes');
  row.processNote = '哼，这段工具可没闲着。';
  host.settings.reviewHints = false;
  assert.equal(nodes(renderer.render()).filter((node) => node.type === module.__testing.ReviewHint).length, 0);
  host.settings.reviewHints = true;
  row.status = 'pending';
  row.partial = '正文尚在生成';
  row.text = '';
  tree = renderer.render();
  assert.equal(nodes(tree).filter((node) => node.type === module.__testing.ReviewHint).length, 0);
  assert.equal(note(tree), undefined, 'a pending body never exposes the optional note');
  assert.deepEqual(nodes(tree).filter((node) => node.type === AssistantNodeView).map((node) => node.props.node.data.blocks[0].text), ['正文尚在生成']);
});

test('settings controls persist the hint switch and commit a threshold only after slider blur', async (t) => {
  const document = fakeDocument();
  const renderer = hookRenderer(document);
  let saved = { enabled: true, reviewHints: true, reviewThreshold: 0.55, pack: normalizePack() };
  const writes = [];
  const { module } = loadClient({
    React: renderer.React, document,
    fetch: async (url, options) => {
      if (String(url).endsWith('/settings')) {
        if (options?.method === 'POST') {
          const patch = JSON.parse(options.body);
          writes.push(patch);
          saved = { ...saved, ...patch };
        }
        return { ok: true, json: async () => ({ settings: saved }) };
      }
      return { ok: true, json: async () => ({ presets: [], providers: [], models: [] }) };
    },
  });
  const effects = [];
  let settingsComponent;
  module.apply({
    effect(fn) { const stop = fn(); if (typeof stop === 'function') effects.push(stop); },
    slots: {
      inject(_key, fn) { const stop = fn(); return () => stop?.(); },
      register(options, component) { if (options.name === 'settings.section') settingsComponent = component; return () => {}; },
    },
  });
  t.after(() => { renderer.dispose(); for (const stop of effects) stop(); });
  let tree = renderer.render(settingsComponent, {});
  nodes(tree).find((node) => typeof node.props.onLoaded === 'function').props.onLoaded({ settings: saved });
  tree = renderer.render();
  const hintSwitch = (root) => nodes(nodes(root).find((node) => node.type === 'label'
    && nodes(node).some((child) => child.children.includes('改写变化提示')))).find((node) => node.type === 'input');
  await hintSwitch(tree).props.onChange({ target: { checked: false } });
  tree = renderer.render();
  assert.equal(hintSwitch(tree).props.checked, false);
  assert.equal(nodes(tree).find((node) => node.props.type === 'range').props.disabled, true);
  await hintSwitch(tree).props.onChange({ target: { checked: true } });
  tree = renderer.render();
  let slider = nodes(tree).find((node) => node.props.type === 'range');
  slider.props.onChange({ target: { value: '0.25' } });
  tree = renderer.render();
  slider = nodes(tree).find((node) => node.props.type === 'range');
  assert.equal(slider.props.value, 0.25);
  assert.equal(writes.length, 2, 'dragging does not send a request for every tick');
  await slider.props.onBlur({ target: { value: '0.25' } });
  tree = renderer.render();
  assert.deepEqual(writes.at(-1), { reviewThreshold: 0.25 });
  assert.equal(nodes(tree).find((node) => node.props.type === 'range').props.value, 0.25);
  const progressSwitch = (root) => nodes(nodes(root).find((node) => node.type === 'label'
    && nodes(node).some((child) => child.children.includes('静默状态播报（默认关闭）')))).find((node) => node.type === 'input');
  assert.equal(progressSwitch(tree).props.checked, false);
  assert.equal(nodes(tree).find((node) => node.props.type === 'number').props.disabled, true);
  await progressSwitch(tree).props.onChange({ target: { checked: true } });
  tree = renderer.render();
  assert.equal(nodes(tree).find((node) => node.props.type === 'number').props.disabled, false);
  const countBefore = writes.length;
  nodes(tree).find((node) => node.props.type === 'number').props.onChange({ target: { value: '7' } });
  tree = renderer.render();
  assert.equal(writes.length, countBefore);
  await nodes(tree).find((node) => node.props.type === 'number').props.onBlur({ target: { value: '7' } });
  tree = renderer.render();
  assert.deepEqual(writes.at(-1), { progressMinutes: 7 });
  assert.equal(nodes(tree).find((node) => node.props.type === 'number').props.value, 7);
  await nodes(tree).find((node) => node.props.type === 'number').props.onBlur({ target: { value: '0' } });
  assert.equal(writes.length, countBefore + 1, 'invalid intervals do not get saved');
  const toggle = (root, label) => nodes(nodes(root).find((node) => node.type === 'label'
    && nodes(node).some((child) => child.children.includes(label)))).find((node) => node.type === 'input');
  const usageLabel = '允许过程转述参考运行信息（默认关闭）';
  assert.equal(toggle(tree, usageLabel).props.checked, false);
  await toggle(tree, usageLabel).props.onChange({ target: { checked: true } });
  tree = renderer.render();
  assert.deepEqual(writes.at(-1), { processToolUsage: true });
  assert.equal(toggle(tree, usageLabel).props.checked, true);
  await toggle(tree, '同时改写阶段性输出').props.onChange({ target: { checked: false } });
  tree = renderer.render();
  assert.equal(toggle(tree, usageLabel).props.disabled, true);
  assert.equal(toggle(tree, usageLabel).props.checked, true, 'the nested preference survives disabling process rewrites');
  const rows = nodes(tree).filter((node) => node.props.style?.margin === '0 0 14px');
  assert.ok(rows.some((node) => nodes(node).some((child) => child.children.includes(usageLabel))
    && nodes(node).some((child) => child.children.includes('同时改写阶段性输出'))), 'both controls share the same settings group');
});
