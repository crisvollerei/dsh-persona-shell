// Offline checks for the Client half's markdown handling.
//
// The shipped MarkdownText lives in the page's module table, so these tests run
// the local fallback renderer directly (that is what runs when the module is
// absent) and separately assert that the shipped component is preferred
// whenever it is reachable.
// Run with: node --test persona-shell/test/render.test.mjs
import test, { after } from 'node:test';
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
      // The chat takeover is installed only after the host confirms the switch is
      // on, so the stub must answer the settings read the way a live host would.
      if (String(url).includes('/persona-shell/settings')) {
        return {
          ok: true,
          json: async () => ({
            settings: { enabled: options.enabled !== false },
            sessionSwitches: { rev: 0, values: {} },
          }),
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
 * Every context created by these tests, so the file's `after` hook can stop the
 * plugin's timers.
 *
 * `apply` owns two native timers that are not part of the mocked slot registry:
 * a heartbeat interval and — more importantly — a 5 s settings-sync loop that
 * re-arms itself forever. The plugin releases both through `ctx.effect`; a stub
 * without `effect` would leave the loop running after the last test and the test
 * process would never exit (the suite printed every ✔ and then hung).
 */
const appliedContexts = [];

after(() => {
  for (const ctx of appliedContexts) {
    for (const dispose of ctx.effects.splice(0)) dispose();
  }
});

/**
 * Register the client half against a stub slot registry.
 * @param {{ primitives?: unknown }} options - forwarded to `loadClient`.
 */
function renderViaSlot(options = {}) {
  const { module } = loadClient(options);
  const registrations = [];
  /** Disposers returned by `inject` callbacks, kept so teardown can be tested. */
  const injectedDisposers = [];
  /** Teardown callbacks the plugin hands to `ctx.effect`. */
  const effects = [];
  const ctx = {
    // Cordis calls the effect callback and keeps whatever disposer it returns.
    // Calling the callback without invoking that disposer would leave the
    // plugin's settings-sync timer running forever.
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') effects.push(dispose);
    },
    effects,
    slots: {
      // `inject` runs the callback for every declaration lifetime and takes
      // ownership of whatever disposer it returns. The stub must NOT invoke that
      // disposer: the takeover registration returns one, and calling it would
      // register and immediately unregister — leaving an empty list that makes
      // every assertion below pass against nothing.
      inject: (_key, callback) => {
        const dispose = callback();
        if (typeof dispose === 'function') injectedDisposers.push(dispose);
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {
          const index = registrations.findIndex((entry) => entry.options === options);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
  };
  appliedContexts.push(ctx);
  module.apply(ctx);
  return { registrations, module };
}

/**
 * Apply the plugin and let the deferred takeover decision run.
 *
 * The shipped renderer keeps the cell until the host confirms the plugin is on, so
 * a synchronous read sees no registration — and every assertion would then pass
 * against nothing.
 */
async function applyAndSettle(options = {}) {
  const result = renderViaSlot(options);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
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
async function renderNode(text, options = {}) {
  const { registrations } = await applyAndSettle(options);
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
async function renderReady(personaText, options = {}) {
  const { registrations, module } = await applyAndSettle(options);
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
async function renderMarkdownOf(text) {
  const { module } = await applyAndSettle();
  return outline(module.__testing.renderMarkdown(text));
}

/** A host state payload holding one settled row. */
function stateWith(rows) {
  return { rev: 1, rows, settings: undefined };
}

test('a row still waiting for its rewrite shows a placeholder, not the plain text', async () => {
  // This is the flicker fix. The rewrite is asynchronous, so a freshly settled
  // step briefly has no persona text; rendering the original in that window
  // means the reader starts one version and finishes another.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'pending', text: '' }, false), 'placeholder');
  // A step that appeared while the page was live: a rewrite is plausibly coming.
  assert.equal(rowBranch(undefined, false, true), 'placeholder', 'a fresh unknown row is in flight');
});

test('restored history does not wait out a placeholder', async () => {
  // Regression: opening a session put every row through the placeholder branch,
  // so a restored transcript was a screen of blank boxes until the state fetch
  // landed. Nothing is coming for those rows, so the report is the honest body.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch(undefined, false, false), 'plain', 'history renders immediately');
  assert.equal(rowBranch(undefined, false), 'plain', 'unknown freshness is not treated as fresh');
});

/** Render the registered chat component with explicit props. */
async function renderStep(props) {
  const { registrations } = await applyAndSettle();
  const component = registrations.find((entry) => entry.options.key === 'assistant-step').component;
  assert.ok(component, 'the chat node registered');
  return component({
    sessionId: 's1',
    t: (key) => key,
    ...props,
  });
}

test('the reasoning partition renders nothing — a documented loss, not a handoff', async () => {
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
  assert.equal(await renderStep({ node, groupPart: 'reasoning' }), null, 'the reasoning pass renders nothing');
});

test('a running or interrupted step is left to the shipped renderer', async () => {
  const make = (status) => ({
    data: {
      status,
      blocks: [{ kind: 'text', text: '正文。' }],
      finalNode: { seq: 8, blocks: [{ kind: 'text', text: '正文。' }] },
    },
  });
  assert.equal(await renderStep({ node: make('running') }), null);
  assert.equal(await renderStep({ node: make('interrupted') }), null);
});

test('freshness is cached per session, not per seq', async () => {
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

test('a row whose rewrite already failed shows the plain report immediately', async () => {
  // A settled-without-text row will never produce persona text, so promising one
  // and making the reader wait out the hold window would be worse than useless.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'skipped', text: '', reason: 'too-long' }, false), 'plain');
  assert.equal(rowBranch({ status: 'skipped', text: '' }, true), 'plain');
});

test('a ready row shows the persona text', async () => {
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'ready', text: '鲸鲸换了个说法。' }, false), 'persona');
  // A ready row wins even after the hold window expired.
  assert.equal(rowBranch({ status: 'ready', text: '鲸鲸换了个说法。' }, true), 'persona');
  // An empty "ready" is not usable text; fall back rather than render nothing.
  assert.equal(rowBranch({ status: 'ready', text: '' }, true), 'plain');
});

test('a rewrite that never lands concedes to the plain report', async () => {
  const { rowBranch, HOLD_PLACEHOLDER_MS } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'pending', text: '' }, false), 'placeholder');
  assert.equal(rowBranch({ status: 'pending', text: '' }, true), 'plain', 'the hold window is finite');
  assert.ok(HOLD_PLACEHOLDER_MS >= 1000 && HOLD_PLACEHOLDER_MS <= 20000, 'a sane hold window');
});

test('partial text streams while the row is still pending', async () => {
  // Before this, the reader waited for the whole rewrite to land and then
  // watched it appear at once. A long report made that a visible stall.
  const { rowBranch } = loadClient().module.__testing;
  assert.equal(rowBranch({ status: 'pending', text: '', partial: '鲸鲸正在' }, false), 'streaming');
  // A settled row still wins over any leftover partial text.
  assert.equal(rowBranch({ status: 'ready', text: '完整版本。', partial: '鲸鲸正在' }, false), 'persona');
  // An empty partial is not streaming, it is still waiting.
  assert.equal(rowBranch({ status: 'pending', text: '', partial: '' }, false), 'placeholder');
});

test('streamed markers are restored so code never shows as [[0]]', async () => {
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

test('streaming draws no caret', async () => {
  // The shipped renderer never draws one, and the text already grows visibly as
  // chunks land. A caret would be a second, competing "still typing" signal.
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.ok(!source.includes('cursorStyle'), 'no caret style remains');
  assert.ok(!/['"]▍['"]/.test(source), 'no block-caret character remains');
});

test('the chat renderer does not declare inject for a standard prop', async () => {
  // `sessionId` is listed in this slot's `standardProps`, so it arrives as a
  // normal prop. Declaring `inject` to return it was a guess made from a misread
  // type, and it was the last change before rendering stopped entirely.
  const { registrations } = await applyAndSettle();
  const step = registrations.find((entry) => entry.options.name === 'conversation.chat.node');
  assert.ok(step, 'the chat node registered');
  assert.equal(step.options.inject, undefined, 'no inject callback is declared');
  assert.equal(step.options.priority, -1, 'the shipped entry is shadowed by priority');
});

test('the takeover follows the global and per-session switches', async () => {
  // Shadowing `assistant-step` hides whatever the shipped renderer drew there —
  // reasoning, images, interrupted markers. That is acceptable only while the
  // persona view replaces the body: disabling the plugin *or the current session*
  // must give the shipped renderer its cell back.
  const { chatTakeoverEnabled } = loadClient().module.__testing;
  const off = new Map([['s-off', false]]);
  assert.equal(chatTakeoverEnabled(true, 's-on', off), true, 'global on + session on');
  assert.equal(chatTakeoverEnabled(true, 's-off', off), false, 'a session switch wins over the global default');
  assert.equal(chatTakeoverEnabled(false, 's-on', off), false, 'the global switch is the master');
  assert.equal(chatTakeoverEnabled(true, undefined, off), true, 'no active session yet follows the global switch');

  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.match(source, /refreshChatTakeover = \(\) =>/, 'the controller is installed with the plugin');
  assert.match(source, /chatTakeoverEnabled\(globalEnabled, activeSessionId, sessionOff\)/, 'the gate uses both switches');
  assert.match(source, /releaseChatSlot\(\)/, 'the disposer is actually called');
});

test('the per-session switch registers in the session header utilities', async () => {
  const { registrations } = await applyAndSettle();
  const entry = registrations.find((candidate) => candidate.options.name === 'conversation.session.header.utilities');
  assert.ok(entry, 'the header utility registered');
  assert.equal(entry.options.id, 'persona-shell');
  assert.equal(entry.options.order, 10);

  const element = entry.component({ sessionId: 's1', t: (key) => key });
  assert.equal(element.type, 'button', 'it renders a real button');
  assert.equal(element.props.role, 'switch');
  assert.equal(element.props['aria-checked'], true, 'the default is on');
  assert.equal(element.props.disabled, false, 'enabled once the host confirms the global switch');
});

test('the poller tracks every seq, not just the one that created it', async () => {
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
  assert.match(body, /watched\.size === 0\) stop\(\)/, 'the poller stops when the last seq leaves');

  // The old shape returned early without registering the new seq.
  assert.ok(
    !/if \(existing !== undefined\) return \(\) => \{\};/.test(body),
    'an existing poller must not ignore a new seq',
  );
});

test('the poller holds one long-poll request and wakes it for a new seq', async () => {
  // The long-poll loop replaced the fixed 100/300/6000ms cadence. The invariants
  // that must survive: one request at a time, one timer at a time, and a wake
  // that aborts the held request instead of waiting out the Host's hold window.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('function watch(');
  const end = source.indexOf('function useHostState(');
  assert.ok(start > 0 && end > start, 'watch() is present');
  const body = source.slice(start, end);

  assert.match(body, /const schedule = \(delay\) =>/, 'one scheduler owns the timer');
  assert.match(body, /if \(inFlight\) \{/, 'a running request defers instead of overlapping');
  assert.match(body, /wakePending = true/, 'the deferral is remembered');
  assert.match(body, /wait: knownRev \? \(canAbort \? STATE_WAIT_MS : 3000\) : 0/, 'the request asks the Host to hold once a revision is known');
  assert.match(body, /if \(delay === 0 && controller !== undefined\) controller\.abort\(\)/, 'a new row aborts the hold');
  assert.ok(!/poller\.start/.test(body), 'no second entry point into tick');
  assert.ok(
    !/pollers\.set\(key, poller\);\s*void tick\(\)/.test(body),
    'no tick before registration',
  );
});

test('the preset refresh updates the selection, not just the list', async () => {
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

test('the original is placed before the rewrite in the comparison row', async () => {
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

test('the poller uses a bounded hold window', async () => {
  // A hold that outlives the page's patience would look like a dead fetch. The
  // window is bounded, and the non-abortable fallback is shorter still.
  const { STATE_WAIT_MS } = loadClient().module.__testing;
  assert.ok(STATE_WAIT_MS >= 5000 && STATE_WAIT_MS <= 30000, 'a sane long-poll window');
  assert.ok(3000 < STATE_WAIT_MS, 'the fallback without AbortController is shorter');
});


test('both slots register, and assistant-step shadows the shipped renderer', async () => {
  const { registrations } = await applyAndSettle();
  const step = registrations.find((entry) => entry.options.name === 'conversation.chat.node');
  assert.ok(step, 'assistant-step registered');
  assert.equal(step.options.key, 'assistant-step');
  assert.equal(step.options.priority, -1, 'a lower priority shadows the shipped entry');
  const settings = registrations.find((entry) => entry.options.name === 'settings.section');
  assert.ok(settings, 'the settings page registered');
  assert.equal(settings.options.id, 'persona-shell');
});

test('the shipped MarkdownText is used whenever the module table provides it', async () => {
  // The point of the design: the persona view must run the host's real
  // renderer, not a look-alike, whenever it is reachable. The element tree is
  // inspected because a mocked React creates elements without invoking them.
  const shipped = function ShippedMarkdownText() { return null; };
  const element = (await applyAndSettle({ primitives: { MarkdownText: shipped } }))
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

test('a memo-wrapped renderer is accepted, not rejected as "not a function"', async () => {
  // Regression: `MarkdownText` is `React.memo(...)`, whose runtime value is an
  // exotic object. An earlier `typeof === 'function'` check rejected it, so the
  // plugin quietly fell back to its local renderer while reporting "missing".
  const memoObject = { $$typeof: Symbol.for('react.memo'), type: function Inner() { return null; } };
  const element = (await applyAndSettle({ primitives: { MarkdownText: memoObject } })).module.__testing.renderMarkdown('## 标题');

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

test('a missing module table degrades to plain text instead of a look-alike', async () => {
  // No local markdown re-implementation exists any more. What replaces it must
  // be obviously degraded: preformatted plain text, not a fake renderer that
  // silently lacks highlighting, KaTeX and footnotes.
  const element = (await applyAndSettle()).module.__testing.renderMarkdown('## 标题');
  assert.ok(element !== null, 'the row still renders something');
  assert.equal(element.type, 'div', 'it is a plain container');
  assert.equal(element.props.style.whiteSpace, 'pre-wrap', 'the text keeps its line breaks');
  assert.ok(!JSON.stringify(element).includes('h2'), 'it does not pretend to be markdown');
});

test('the plugin ships no markdown renderer of its own', async () => {
  // Guard against the implementation creeping back: a copy of the shipped
  // renderer never keeps up, and its gaps are invisible.
  const source = fs.readFileSync(SOURCE, 'utf8');
  for (const name of ['renderBlocks', 'renderInlineBlocks', 'renderTable', 'renderCodeBlock']) {
    assert.ok(!source.includes(`function ${name}(`), `${name} must not exist`);
  }
  assert.ok(source.includes('PLAIN_FALLBACK_STYLE'), 'the plain-text fallback is present');
});
