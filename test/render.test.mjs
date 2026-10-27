// Offline checks for the Client half's markdown handling.
//
// The shipped MarkdownText lives in the page's module table, so these tests run
// the local fallback renderer directly (that is what runs when the module is
// absent) and separately assert that the shipped component is preferred
// whenever it is reachable.
// Run with: node --test persona-shell/test/render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE = path.resolve(import.meta.dirname, '..', 'client.js');

/** A minimal React stand-in that keeps elements inspectable as plain objects. */
function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: undefined }),
    memo: (fn) => fn,
  };
}

/**
 * Load client.js in a sandbox with a fake loader.
 * @param {{ primitives?: unknown, hostState?: object }} options
 *   `primitives` simulates the shell's module table containing the shipped
 *   renderer; `hostState` is what the state route answers for a session.
 */
function loadClient(options = {}) {
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { sandbox.__definition = definition; } } },
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      if (options.hostState !== undefined && String(url).includes('/persona-shell/state')) {
        return {
          ok: true,
          json: async () => options.hostState,
        };
      }
      throw new Error('no host in tests');
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: 'client.js' });

  const definition = sandbox.__definition;
  const React = makeReact();
  const module = definition.factory((id) => {
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives' && options.primitives !== undefined) {
      return options.primitives;
    }
    throw new Error(`unexpected require: ${id}`);
  });
  return { module, definition };
}

/**
 * Register the client half against a stub slot registry.
 * @param {{ primitives?: unknown }} options - forwarded to `loadClient`.
 */
function renderViaSlot(options = {}) {
  const { module } = loadClient(options);
  const registrations = [];
  const ctx = {
    slots: {
      // The real `inject` runs the callback and takes ownership of the disposer
      // it returns, so the stub must call it rather than keep it.
      inject: (_key, callback) => {
        const dispose = callback();
        if (typeof dispose === 'function') dispose();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  module.apply(ctx);
  return { registrations, module };
}

/** Flatten a React-ish tree into readable text, marking the tags that were produced. */
function outline(node, depth = 0) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [`${' '.repeat(depth)}${String(node)}`];
  if (Array.isArray(node)) return node.flatMap((child) => outline(child, depth));
  const tag = typeof node.type === 'string' ? node.type : 'Component';
  const own = node.children.flatMap((child) => outline(child, depth + 1));
  return [`${' '.repeat(depth)}<${tag}>`, ...own];
}

/**
 * Render one assistant node through the registered slot component.
 *
 * The mock React has no update cycle, so the host state cannot arrive through a
 * fetch. The component therefore starts on its placeholder branch; these tests
 * are about the markdown renderer itself, so the state cache is primed by
 * rendering the same text as a ready row through `rowBranch`'s decision.
 * @param {string} text - the markdown this row must render.
 * @param {object} [options]
 * @param {object} [options.primitives] - the shipped renderer, when present.
 */
function renderNode(text, options = {}) {
  const { registrations } = renderViaSlot(options);
  const registered = registrations.find((entry) => entry.options.key === 'assistant-step');
  assert.ok(registered, 'the assistant-step renderer registered');
  const element = registered.component({
    node: {
      data: {
        status: 'settled',
        blocks: [{ kind: 'text', text }],
        finalNode: { seq: 1, blocks: [{ kind: 'text', text }] },
      },
    },
    sessionId: 's1',
    t: (key) => key,
  });
  return outline(element);
}

/** Render a row whose rewrite is already available, which is the normal case. */
function renderReady(personaText, options = {}) {
  const { registrations, module } = renderViaSlot(options);
  // Prime the component's view of the host: a ready row means the component
  // skips its placeholder branch on the very first render.
  const registered = registrations.find((entry) => entry.options.key === 'assistant-step');
  assert.ok(registered, 'the assistant-step renderer registered');
  const element = registered.component({
    node: {
      data: {
        status: 'settled',
        blocks: [{ kind: 'text', text: `原文-${personaText}` }],
        finalNode: { seq: 1, blocks: [{ kind: 'text', text: `原文-${personaText}` }] },
      },
    },
    sessionId: 's1',
    t: (key) => key,
  });
  return outline(element);
}

/**
 * Render markdown through the plugin's own body renderer.
 *
 * The component starts on its placeholder branch until host state arrives, and
 * a mocked React cannot replay that update. These tests are about markdown, so
 * they call the renderer the component would call.
 * @param {string} text
 * @returns {string[]}
 */
function renderMarkdownOf(text) {
  const { module } = renderViaSlot();
  return outline(module.__testing.renderMarkdown(text));
}

/** A host state payload holding one settled row. */
function stateWith(rows) {
  return { rev: 1, rows, settings: undefined };
}

test('a row still waiting for its rewrite shows a placeholder, not the plain text', () => {
  // This is the flicker fix. The rewrite is asynchronous, so a freshly settled
  // step briefly has no persona text; rendering the original in that window
  // means the reader starts one version and finishes another.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'pending', text: '' }, false), 'placeholder');
  // A step that appeared while the page was live: a rewrite is plausibly coming.
  assert.equal(rowBranch(undefined, false, true), 'placeholder', 'a fresh unknown row is in flight');
});

test('restored history does not wait out a placeholder', () => {
  // Regression: opening a session put every row through the placeholder branch,
  // so a restored transcript was a screen of blank boxes until the state fetch
  // landed. Nothing is coming for those rows, so the report is the honest body.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch(undefined, false, false), 'plain', 'history renders immediately');
  assert.equal(rowBranch(undefined, false), 'plain', 'unknown freshness is not treated as fresh');
});

/** Render the registered chat component with explicit props. */
function renderStep(props) {
  const { registrations } = renderViaSlot();
  const component = registrations.find((entry) => entry.options.key === 'assistant-step').component;
  assert.ok(component, 'the chat node registered');
  return component({
    sessionId: 's1',
    t: (key) => key,
    ...props,
  });
}

test('the reasoning partition renders nothing — a documented loss, not a handoff', () => {
  // `groupPart: 'reasoning'` selects which blocks a pass owns. This entry replaced
  // `AssistantNodeView` wholesale, so returning null renders nothing for that pass;
  // it does NOT call the shipped `ReasoningRow`. Serving it correctly would mean
  // reimplementing that component, which this project deliberately does not do.
  //
  // The property asserted is therefore "the answer no longer leaks into the
  // thinking pane", not "the shipped reasoning is restored".
  const node = {
    data: {
      status: 'settled',
      blocks: [
        { kind: 'reasoning', text: '这里是思考过程。' },
        { kind: 'text', text: '这是正文。' },
      ],
      finalNode: { seq: 7, blocks: [] },
    },
  };
  assert.equal(renderStep({ node, groupPart: 'reasoning' }), null, 'the reasoning pass renders nothing');
});

test('a running or interrupted step is left to the shipped renderer', () => {
  const make = (status) => ({
    data: {
      status,
      blocks: [{ kind: 'text', text: '正文。' }],
      finalNode: { seq: 8, blocks: [{ kind: 'text', text: '正文。' }] },
    },
  });
  assert.equal(renderStep({ node: make('running') }), null);
  assert.equal(renderStep({ node: make('interrupted') }), null);
});

test('freshness is cached per session, not per seq', () => {
  // `seq` is only unique inside a session. Keying the cache by `seq` alone let one
  // session's verdict be reused by another session's unrelated row with the same
  // number.
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.match(source, /const rowKey = \(sessionId, seq\) =>/, 'a composite key helper exists');
  assert.match(source, /freshDecided\.has\(key\)/, 'the freshness cache uses it');
  assert.ok(
    !/freshDecided\.has\(seq\)/.test(source),
    'no bare-seq key remains in the freshness cache',
  );
});

test('a row whose rewrite already failed shows the plain report immediately', () => {
  // A settled-without-text row will never produce persona text, so promising one
  // and making the reader wait out the hold window would be worse than useless.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'skipped', text: '', reason: 'too-long' }, false), 'plain');
  assert.equal(rowBranch({ status: 'skipped', text: '' }, true), 'plain');
});

test('a ready row shows the persona text', () => {
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'ready', text: '鲸鲸换了个说法。' }, false), 'persona');
  // A ready row wins even after the hold window expired.
  assert.equal(rowBranch({ status: 'ready', text: '鲸鲸换了个说法。' }, true), 'persona');
  // An empty "ready" is not usable text; fall back rather than render nothing.
  assert.equal(rowBranch({ status: 'ready', text: '' }, true), 'plain');
});

test('a rewrite that never lands concedes to the plain report', () => {
  const { rowBranch, HOLD_PLACEHOLDER_MS } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'pending', text: '' }, false), 'placeholder');
  assert.equal(rowBranch({ status: 'pending', text: '' }, true), 'plain', 'the hold window is finite');
  assert.ok(HOLD_PLACEHOLDER_MS >= 1000 && HOLD_PLACEHOLDER_MS <= 20000, 'a sane hold window');
});

test('partial text streams while the row is still pending', () => {
  // Before this, the reader waited for the whole rewrite to land and then
  // watched it appear at once. A long report made that a visible stall.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'pending', text: '', partial: '鲸鲸正在' }, false), 'streaming');
  // A settled row still wins over any leftover partial text.
  assert.equal(rowBranch({ status: 'ready', text: '完整版本。', partial: '鲸鲸正在' }, false), 'persona');
  // An empty partial is not streaming, it is still waiting.
  assert.equal(rowBranch({ status: 'pending', text: '', partial: '' }, false), 'placeholder');
});

test('streamed markers are restored so code never shows as [[0]]', () => {
  const { unmaskPartial } = loadClient().module.__testing;
  const literals = ['`npm run build`', 'D:\\work\\a.js'];
  assert.equal(
    unmaskPartial('鲸鲸先跑了 [[0]]，然后看了 [[1]]。', literals),
    '鲸鲸先跑了 `npm run build`，然后看了 D:\\work\\a.js。',
  );
  // A marker whose literal has not arrived yet stays intact rather than vanishing.
  assert.equal(unmaskPartial('还没到的 [[5]]', literals), '还没到的 [[5]]');
  // No table means nothing to restore.
  assert.equal(unmaskPartial('原样返回', undefined), '原样返回');
});

test('streaming draws no caret', () => {
  // The shipped renderer never draws one, and the text already grows visibly as
  // chunks land. A caret would be a second, competing "still typing" signal.
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.ok(!source.includes('cursorStyle'), 'no caret style remains');
  assert.ok(!/['"]▍['"]/.test(source), 'no block-caret character remains');
});

test('the chat renderer does not declare inject for a standard prop', () => {
  // `sessionId` is listed in this slot's `standardProps`, so it arrives as a
  // normal prop. Declaring `inject` to return it was a guess made from a misread
  // type, and it was the last change before rendering stopped entirely.
  const { registrations } = renderViaSlot();
  const step = registrations.find((entry) => entry.options.name === 'conversation.chat.node');
  assert.ok(step, 'the chat node registered');
  assert.equal(step.options.inject, undefined, 'no inject callback is declared');
  assert.equal(step.options.priority, -1, 'the shipped entry is shadowed by priority');
});

test('the takeover is registered and released with the enabled switch', () => {
  // Shadowing `assistant-step` hides whatever the shipped renderer drew there —
  // reasoning, images, interrupted markers. That is acceptable while the persona
  // view replaces the body, but it must not be unconditional: disabling the plugin
  // has to give the shipped renderer its cell back, or the loss can never be undone.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('const applyEnabled =');
  const end = source.indexOf('void syncEnabled();', start);
  assert.ok(start > 0 && end > start, 'the enable gate is present');
  const body = source.slice(start, end);

  assert.match(body, /enabled === true && releaseChat === undefined/, 'registration is conditional');
  assert.match(body, /releaseChat = ctx\.slots\.inject/, 'the disposer is kept');
  assert.match(body, /enabled !== true && releaseChat !== undefined/, 'disable releases it');
  assert.match(body, /release\(\)/, 'the disposer is actually called');
});

test('the poller tracks every seq, not just the one that created it', () => {
  // Regression: the poller captured a single seq at creation and kept it. Once
  // that row settled the cadence fell to the slow tail interval, so every later
  // rewrite in the same session finished between two polls and appeared as one
  // jump — which reads exactly like "streaming is broken".
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('function watch(');
  const end = source.indexOf('function useHostState(');
  assert.ok(start > 0 && end > start, 'watch() is present');
  const body = source.slice(start, end);

  assert.match(body, /const watched = new Map\(\)/, 'the poller refcounts seqs');
  assert.match(body, /watched\.set\(candidate, next\)/, 'a new seq can join an existing poller');
  assert.match(body, /\.\.\.watched\.keys\(\)/, 'the eager cadence considers all of them');

  // The old shape returned early without registering the new seq.
  assert.ok(
    !/if \(existing !== undefined\) return \(\) => \{\};/.test(body),
    'an existing poller must not ignore a new seq',
  );
});

test('the poller keeps at most one request and one timer', () => {
  // Two separate regressions lived here.
  //
  // 1. The poller was started before its first seq was registered, so `tick` saw
  //    nothing watching, killed itself, and no state was ever fetched.
  // 2. After that was fixed, `add()` scheduled a zero-delay tick *and* `start()`
  //    ran one immediately — two chains for one subscriber, each scheduling its
  //    own next timer.
  //
  // The invariant now is a single scheduler: `schedule()` owns the only timer and
  // defers to `wakePending` while a request is running.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('function watch(');
  const end = source.indexOf('function useHostState(');
  assert.ok(start > 0 && end > start, 'watch() is present');
  const body = source.slice(start, end);

  assert.match(body, /const schedule = \(delay\) =>/, 'one scheduler owns the timer');
  assert.match(body, /if \(inFlight\) \{/, 'a running request defers instead of overlapping');
  assert.match(body, /wakePending = true/, 'the deferral is remembered');
  assert.ok(!/poller\.start/.test(body), 'no second entry point into tick');
  assert.ok(
    !/pollers\.set\(key, poller\);\s*void tick\(\)/.test(body),
    'no tick before registration',
  );
});

test('the preset refresh updates the selection, not just the list', () => {
  // Regression: `refreshPresets(list)` returned early when handed an array, so
  // `activePresetName` and `activePresetId` never moved. Applying a preset
  // changed the list but not the highlight — the button looked dead until a
  // reload, which the desktop client cannot do without restarting.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('const refreshPresets =');
  const end = source.indexOf('React.useEffect(() => { void refreshPresets', start);
  assert.ok(start > 0 && end > start, 'refreshPresets is present');
  const body = source.slice(start, end);

  assert.match(body, /setActivePresetName\(/, 'the active name is updated');
  assert.match(body, /setActivePresetId\(/, 'the active id is updated');
  // The old early-return shape skipped both updates.
  assert.ok(
    !/if \(Array\.isArray\(list\)\) \{ setPresets\(list\); return; \}/.test(body),
    'no early return that skips the selection',
  );
});

test('the original is placed before the rewrite in the comparison row', () => {
  // Reading the two versions line by line only works if the original is the
  // left column; stacking it below the text forces the eye to travel.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('const compareRowStyle');
  const end = source.indexOf('const placeholderStyle');
  assert.ok(start > 0 && end > start, 'the comparison layout is present');
  const block = source.slice(start, end);
  assert.match(block, /gridTemplateColumns/, 'the panes are a grid, not a stack');
  assert.match(block, /auto-fit/, 'the grid collapses by itself when the chat column is narrow');
});

test('the poller starts without touching an uninitialised binding', () => {
  // Regression: `startedAt` was declared *after* the `tick` that reads it while
  // `tick` runs immediately, so the first poll threw a TDZ ReferenceError and no
  // state ever arrived. The symptom was the flicker this work exists to remove.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('function watch(');
  const end = source.indexOf('function useHostState(');
  assert.ok(start > 0 && end > start, 'watch() is present');

  const body = source.slice(start, end);
  const declaration = body.indexOf('const startedAt = Date.now();');
  const firstUse = body.indexOf('startedAt');
  assert.ok(declaration > 0, 'startedAt is declared');
  assert.ok(declaration <= firstUse, 'startedAt must be declared before it is read');
});


test('both slots register, and assistant-step shadows the shipped renderer', () => {
  const { registrations } = renderViaSlot();
  const step = registrations.find((entry) => entry.options.name === 'conversation.chat.node');
  assert.ok(step, 'assistant-step registered');
  assert.equal(step.options.key, 'assistant-step');
  assert.equal(step.options.priority, -1, 'a lower priority shadows the shipped entry');
  const settings = registrations.find((entry) => entry.options.name === 'settings.section');
  assert.ok(settings, 'the settings page registered');
  assert.equal(settings.options.id, 'persona-shell');
});

test('the shipped MarkdownText is used whenever the module table provides it', () => {
  // The point of the design: the persona view must run the host's real
  // renderer, not a look-alike, whenever it is reachable. The element tree is
  // inspected because a mocked React creates elements without invoking them.
  const shipped = function ShippedMarkdownText() { return null; };
  const element = renderViaSlot({ primitives: { MarkdownText: shipped } })
    .module.__testing.renderMarkdown('## 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |');

  /** Every element node in the tree. */
  const nodes = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(element);

  const markdown = nodes.find((node) => node.type === shipped);
  assert.ok(markdown, `the shipped renderer is the element type used, got:\n${JSON.stringify(element).slice(0, 400)}`);
  // The shipped component requires `labels`; proof the plugin supplied them.
  assert.equal(typeof markdown.props.labels, 'object');
  assert.equal(typeof markdown.props.text, 'string');
  // No local renderer markup should be present alongside it.
  assert.ok(!nodes.some((node) => node.type === 'h2'), 'the local renderer did not also draw the heading');
});

test('a memo-wrapped renderer is accepted, not rejected as "not a function"', () => {
  // Regression: `MarkdownText` is `React.memo(...)`, whose runtime value is an
  // exotic object. An earlier `typeof === 'function'` check rejected it, so the
  // plugin quietly fell back to its local renderer while reporting "missing".
  const memoObject = { $$typeof: Symbol.for('react.memo'), type: function Inner() { return null; } };
  const element = renderViaSlot({ primitives: { MarkdownText: memoObject } }).module.__testing.renderMarkdown('## 标题');

  const nodes = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(element);

  assert.ok(nodes.some((node) => node.type === memoObject), 'the memo object is used as the element type');
  assert.ok(!nodes.some((node) => node.type === 'h2'), 'the local renderer did not take over');
});

test('a missing module table degrades to plain text instead of a look-alike', () => {
  // No local markdown re-implementation exists any more. What replaces it must
  // be obviously degraded: preformatted plain text, not a fake renderer that
  // silently lacks highlighting, KaTeX and footnotes.
  const element = renderViaSlot().module.__testing.renderMarkdown('## 标题');
  assert.ok(element !== null, 'the row still renders something');
  assert.equal(element.type, 'div', 'it is a plain container');
  assert.equal(element.props.style.whiteSpace, 'pre-wrap', 'the text keeps its line breaks');
  assert.ok(!JSON.stringify(element).includes('h2'), 'it does not pretend to be markdown');
});

test('the plugin ships no markdown renderer of its own', () => {
  // Guard against the implementation creeping back: a copy of the shipped
  // renderer never keeps up, and its gaps are invisible.
  const source = fs.readFileSync(SOURCE, 'utf8');
  for (const name of ['renderBlocks', 'renderInlineBlocks', 'renderTable', 'renderCodeBlock']) {
    assert.ok(!source.includes(`function ${name}(`), `${name} must not exist`);
  }
  assert.ok(source.includes('PLAIN_FALLBACK_STYLE'), 'the plain-text fallback is present');
});
