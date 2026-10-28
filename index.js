/**
 * Persona Shell — Host half.
 *
 * Nothing here touches the system prompt, the tool set, the agent loop, or the
 * session log. This plugin only reads committed `assistant/message` events,
 * asks a second model to re-speak the same information in a persona, and
 * serves the result to the page over a same-origin route.
 *
 * Three properties matter more than persona quality:
 *
 * 1. **The session log is never written.** A rewrite is derived state held in
 *    this plugin's own memory, so the model can never see it on a later step
 *    and cannot start imitating it.
 * 2. **Failure is invisible.** Every path that is slow, refused, or malformed
 *    leaves the plain report in place.
 * 3. **Technical content cannot be corrupted.** Literals are masked locally and
 *    restored locally, so the rewriting model never receives the real bytes.
 */

import { mask, unmask } from './lib/mask.js';
import { BUILTIN_PRESETS, normalizePack } from './lib/pack.js';
import { buildExtractPrompt, parseExtractedPreset } from './lib/preset.js';
import { buildRewritePrompt, rewriteDistance, validateRewrite } from './lib/prompt.js';
import { Config, resolveConfig } from './lib/config.js';
import { observeFeedback, observeMessage, memoryLines, emptyProfile } from './lib/memory.js';
import { openStore } from './lib/store.js';

/** Cordis plugin name. */
export const name = 'persona-shell';

/** Route prefix this plugin owns. */
const ROUTE = '/persona-shell';

/** Name and id of the shipped preset; it cannot be deleted. */
const DEFAULT_PRESET_NAME = '大肥鱼（默认）';

/** Upper bound on stored presets, so a runaway loop cannot grow the file. */
const MAX_PRESETS = 30;

/**
 * Host build marker, bumped whenever the Host half changes shape.
 *
 * Mirrors the Client half's `CLIENT_BUILD`. The desktop client cannot reload its
 * bundles, so after a deploy "the fix did nothing" and "the new Host half never
 * loaded" are indistinguishable from the transcript alone; the public probe
 * publishes both ids so a restart can be verified with one request.
 */
const HOST_BUILD = 20261028;

/**
 * How often a streaming rewrite may publish a new partial revision.
 *
 * The page polls for changes, so a token-by-token rate would spend the whole
 * budget on polling. 120ms is tuned against the client's own cadence: the page
 * polls every 100ms during a rewrite, so publishing faster than that would only
 * produce revisions nobody ever reads. Slower and a short rewrite lands entirely
 * in one jump — a 70-character answer finishes in about 700ms, and at 240ms that
 * was two visible frames, which reads as "no streaming at all".
 */
const STREAM_INTERVAL_MS = 120;

/**
 * Diagnostic keys the public probe may name.
 *
 * A whitelist, not a slice of whatever happens to be present: internal reports
 * can carry free-form text (`reason`, error messages), and publishing key names
 * from an open set would leak the existence and shape of internal state.
 */
const PUBLIC_DIAGNOSTIC_KEYS = new Set([
  'applied',
  'authCounts',
  'authStatus',
  'clientBuild',
  'heartbeat',
  'shippedMarkdown',
]);

/**
 * Coerce a value to a member of a fixed set.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} fallback
 */
function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** Runtime schema for the row: a Standard Schema resolver with no dependencies. */
export { Config };

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  const warn = (message, error) => {
    const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
    ctx.logger?.warn?.(`[persona-shell] ${message}${detail}`);
  };

  if (!cfg.enabled) return;

  // Resolved at use, not captured here.
  //
  // Both services are optional in a given composition, and either can arrive
  // after this plugin is applied. Capturing once meant a plugin that started
  // before `llm` existed stayed permanently `no-llm` even after the service came
  // up — the comment here claimed lazy reading while the code did the opposite.
  const webServer = ctx.get('webServer');
  const getLlm = () => ctx.get('llm');
  const getConnection = () => ctx.get('connection');
  if (getLlm() === undefined) warn('llm service is absent; rewrites are disabled');

  /**
   * Apply the host's Host/Origin and browser-authentication checks to a request.
   *
   * `webServer` owns no auth of its own by design; every route mounted on it is
   * responsible for calling this. When the `connection` service is absent there is
   * nothing to check against, so the request is refused rather than allowed: an
   * unauthenticated fallback here would silently undo the protection.
   * @param {import('node:http').IncomingMessage} req
   * @returns {401 | 403 | undefined}
   */
  const requestRejection = (req) => {
    const connection = getConnection();
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      // Deny by default.
      //
      // An earlier version allowed the request and only recorded the absence,
      // which kept the plugin usable in a composition without Connection but left
      // the routes open — the security hole this was meant to close, merely
      // logged. `webServer` owns no authentication of its own, so "cannot check"
      // has to mean "do not serve". `allowUnauthenticatedRoutes` is the explicit
      // opt-out for a deployment that knowingly runs without that service.
      if (cfg.allowUnauthenticatedRoutes === true) {
        diagnostics.authStatus = 'unavailable';
        diagnostics.auth = 'connection-service-absent-allowed-by-config';
        return undefined;
      }
      diagnostics.authStatus = 'unavailable';
      diagnostics.auth = 'connection-service-absent-denied';
      return 403;
    }
    try {
      const rejection = connection.requestRejection({ headers: req.headers });
      // Counters, not a single last value: an unauthenticated probe would
      // otherwise overwrite the evidence that the page itself is working.
      const counters = diagnostics.authCounts ?? { ok: 0, rejected: 0 };
      if (rejection === undefined) counters.ok += 1;
      else counters.rejected += 1;
      diagnostics.authCounts = counters;
      // Split for the public probe. `authStatus` is a fixed enum safe to publish;
      // `authDetail` may carry internal text and stays behind authentication.
      diagnostics.authStatus = rejection === undefined ? 'ok' : 'rejected';
      diagnostics.auth = rejection === undefined ? 'ok' : `rejected-${rejection}`;
      return rejection;
    } catch (error) {
      // A throwing check must not silently become an open door.
      diagnostics.authStatus = 'error';
      diagnostics.auth = `error: ${error instanceof Error ? error.message : String(error)}`;
      return 403;
    }
  };

  /** Live settings, seeded from Config and writable from the settings route. */
  const settings = {
    enabled: true,
    /** Whether narration from tool-calling steps is rewritten too. */
    includeToolSteps: cfg.includeToolSteps,
    /** Whether accumulated reader observations reach the prompt at all. */
    memory: cfg.memory,
    /** Subagent conversations: mid-task narration, then the final answer. */
    subagentSteps: cfg.subagentSteps === true,
    subagentReports: cfg.subagentReports === true,
    pack: normalizePack(undefined),
    /** Name of the preset `pack` came from, for display. */
    presetName: DEFAULT_PRESET_NAME,
    provider: cfg.provider ?? '',
    model: cfg.model ?? '',
    reasoningEffort: cfg.reasoningEffort ?? '',
  };

  /**
   * Named persona presets, newest last.
   *
   * The shipped presets are always present and not deletable: there has to be a
   * way back to the characters this plugin was built around, and that must not
   * depend on the user having kept a copy.
   */
  let presets = BUILTIN_PRESETS.map((entry) => ({
    id: entry.id,
    name: entry.name,
    pack: normalizePack(entry.pack),
    source: '',
    builtin: true,
    at: 0,
  }));

  /**
   * Last self-report from a page: whether the shipped markdown renderer
   * resolved from the module table. A silent fallback looks identical to a
   * working one from here, so the page reports it and this holds it.
   */
  let diagnostics = {};

  /** Storage lifecycle, surfaced through the diagnostics route. */
  let storeState = 'unavailable';
  let storeError = '';

  /**
   * Whether the persisted switches have been applied.
   *
   * False until storage actually reports the saved values. Memory collection
   * waits for it: the defaults are permissive, so collecting on a guess would
   * violate a `memory:false` the user already chose. A storage facility that is
   * absent, still opening, or failed therefore keeps collection off — none of
   * those states is evidence that the switch was never turned off.
   */
  let settingsRestored = false;

  /** `${sessionId}:${seq}` → row. */
  const rows = new Map();
  /** sessionId → newest revision counter. */
  const revisions = new Map();
  /** sessionId → recent successful outputs, for tone continuity. */
  const samples = new Map();
  /** `${sessionId}:${seq}` currently being rewritten. */
  const inFlight = new Set();
  /** sessionId → running-turn facts harvested from the log. */
  const turnState = new Map();
  /** sessionId → the candidate text of the turn so far (`trigger: 'report'`). */
  const candidates = new Map();

  /** Durable store, attached asynchronously; absent means memory-only. */
  let store = undefined;

  /**
   * Cross-session accumulated profile of how this user writes.
   *
   * Aggregate counters only: no message text is retained, so a restart loses
   * nothing that could reconstruct a conversation. Loaded from the profile
   * table once storage opens.
   */
  let profile = emptyProfile();
  /** Debounced writer for the profile row. */
  let profileTimer;

  /**
   * Remove harness-injected context from a user message.
   *
   * `user/message` carries both the user's words and a block the harness prepends
   * every turn: `Current runtime context.` followed by ~800 characters of English
   * about the working directory, the GUI URL and the time. Counting that as the
   * user's own writing made a Chinese writer measure as 5% Chinese.
   *
   * Stripped rather than skipped, because the same message usually contains what
   * the user actually typed after it.
   * @param {string} text
   * @returns {string | undefined} the user's own words, or undefined if none.
   */
  function stripInjectedContext(text) {
    if (typeof text !== 'string') return undefined;
    // The injected block is a run of lines, each either a `Key: value` pair or a
    // known harness sentence. Everything else is the user's own writing, so the
    // rule is per line rather than one big match — a single block regex ate only
    // the first line and left 560 characters of English behind.
    //
    // The tail of the block is prose about the agent's own tooling ("Use
    // list_agents({}) to find your teammates…"), which has no stable prefix. It is
    // caught by shape instead: a line that is mostly Latin and mentions a tool
    // call is harness prose, not something a user types.
    const INJECTED_LINE = /^(?:Current runtime context\.|Current working directory:|Current DSH file policy:|Current DeepSeek Harness|Approval prompts are disabled|You are (?:the Team Lead|an AI agent)|Time sampled while preparing|Browser time zone for this request:|Elapsed since the preceding|\[model changed:|The runtime context)/;
    const HARNESS_PROSE = /\b[A-Za-z_]+\(\{?[^)]*\}?\)|\b(?:use|Use) [a-z][A-Za-z_]+\(/;
    const kept = text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed === '') return false;
        if (INJECTED_LINE.test(trimmed)) return false;
        // Mostly-Latin lines that talk about calling a tool are harness prose.
        const han = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
        if (han === 0 && HARNESS_PROSE.test(trimmed)) return false;
        return true;
      });
    const trimmed = kept.join('\n').replace(/\s+/g, ' ').trim();
    return trimmed === '' ? undefined : trimmed;
  }

  /**
   * Whether a message is a pasted persona document rather than something the
   * user wrote about themselves.
   *
   * This exists because the memory feature read a pasted 1800-character persona
   * as if every line of it were a personal preference, stored a dozen of them,
   * and fed them into *other* personas' prompts. A pasted document is content,
   * not a statement about the reader.
   *
   * Detected by shape, not by a keyword: persona documents are long, use numbered
   * or titled sections, and are mostly not conversational. All three are cheap
   * and none of them match a normal message.
   * @param {string} text
   * @returns {boolean}
   */
  function looksLikePastedPersona(text) {
    if (typeof text !== 'string') return false;
    // Ordinary messages are short. A paragraph is already unusual; a document is
    // unambiguous.
    if (text.length < 300) return false;

    // Section headings: "一、身份", "## 说话风格", "1. 角色设定".
    const headings = (text.match(/(?:^|\n)\s*(?:[一二三四五六七八九十]+、|#{1,4}\s|\d+[.、]\s*)/g) ?? []).length;
    if (headings >= 3) return true;

    // Very long text with no question and no first-person reference to the user's
    // own situation reads as supplied material rather than a request.
    const looksLikeDocument = text.length > 800
      && !/[?？]/.test(text.slice(0, 200))
      && (text.match(/[。\n]/g) ?? []).length > 20;
    return looksLikeDocument;
  }

  /**
   * Learn from one user message.
   *
   * The shared counters always update. Corrections are recorded against the
   * preset that is active *now*, because a complaint about the current voice does
   * not describe how the user wants a different character to speak.
   * @param {string} text
   */
  function observeUserText(text) {
    // Record what was actually sampled, so a surprising ratio can be traced to a
    // specific message instead of guessed at. Lengths and counts only: this is a
    // debugging aid, and it must not become a second copy of the user's words.
    const sample = {
      len: text.length,
      han: (text.match(/[\u4e00-\u9fff]/g) ?? []).length,
      latin: (text.match(/[A-Za-z]/g) ?? []).length,
      head: text.slice(0, 24).replace(/\s+/g, ' '),
      at: Date.now(),
    };
    memorySamples.push(sample);
    while (memorySamples.length > 12) memorySamples.shift();
    // Written straight into the host's diagnostics bag: `reportDiagnostics` is the
    // client-side poster and does not exist here.
    diagnostics.memorySamples = memorySamples;

    profile = observeMessage(profile, text);
    const presetId = activePresetId();
    profile = observeFeedback(profile, text, presetId);
    scheduleProfileSave();
  }

  /** Recent memory samples, for diagnosing a surprising ratio. */
  const memorySamples = [];

  /** Whether a name is reserved by a shipped preset. */
  function isBuiltinName(name) {
    return presets.some((preset) => preset.builtin === true && preset.name === name);
  }

  /** Id of the preset currently in force, used to scope corrections. */
  function activePresetId() {
    const active = presets.find((preset) => preset.name === settings.presetName);
    return active?.id ?? DEFAULT_PRESET_NAME;
  }

  function scheduleProfileSave() {
    if (store === undefined) return;
    if (profileTimer !== undefined) return;
    profileTimer = setTimeout(() => {
      profileTimer = undefined;
      store.putProfile(profile).catch((error) => warn('profile persist failed', error));
    }, 1500);
  }

  /**
   * Write the live pack back into whichever preset is active.
   *
   * Editing the card fields is how a user tunes a persona; if that edit is not
   * written to the preset, the next restart restores the stored copy and the
   * work is lost. Two cases need different treatment:
   *
   * - A **user preset**: update it in place.
   * - The **builtin preset**: it cannot be modified (there has to be a way back
   *   to the shipped character), so an edit forks a new preset instead. That is
   *   also what a user expects: "I changed the default, keep my version".
   *
   * Returns the name that is now active, so the caller can report it.
   */
  function persistActivePack() {
    const active = presets.find((preset) => preset.name === settings.presetName);

    if (active !== undefined && active.builtin !== true) {
      const updated = { ...active, pack: settings.pack, at: Date.now() };
      presets = presets.map((preset) => (preset.id === active.id ? updated : preset));
      savePreset(updated);
      return settings.presetName;
    }

    if (presets.length >= MAX_PRESETS) return settings.presetName;

    // Fork from the active shipped preset (or from a name that no longer resolves).
    const base = active?.builtin === true
      ? (active.name === DEFAULT_PRESET_NAME ? '自定义' : active.name)
      : settings.presetName;
    let name = `${base} 2`;
    for (let index = 3; presets.some((preset) => preset.name === name); index += 1) {
      name = `${base} ${index}`;
    }
    const forked = {
      id: `preset-${Date.now().toString(36)}`,
      name,
      pack: settings.pack,
      source: active?.source ?? '',
      builtin: false,
      at: Date.now(),
    };
    presets = [...presets, forked];
    savePreset(forked);
    saveActivePreset(forked.id);
    settings.presetName = name;
    return name;
  }

  /** Persist the durable switches and route. */
  function saveSettings() {
    if (store === undefined) return;
    store.putSettings({
      enabled: settings.enabled,
      includeToolSteps: settings.includeToolSteps,
      memory: settings.memory,
      subagentSteps: settings.subagentSteps,
      subagentReports: settings.subagentReports,
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
    }).catch((error) => warn('settings persist failed', error));
  }

  /** Persist one preset; a failed write must not break the live settings. */
  function savePreset(preset) {
    if (store === undefined) return;
    store.putPreset(preset).catch((error) => warn('preset persist failed', error));
  }

  /**
   * Remember which preset is active, so a restart comes back to it.
   *
   * Without this the selection lived only in memory: switching persona worked
   * until the process restarted and then silently reverted to the default, which
   * reads as "the switch never stuck".
   */
  function saveActivePreset(id) {
    if (store === undefined) return;
    store.putActivePreset(id).catch((error) => warn('active preset persist failed', error));
  }

  /** Strip the internal fields before sending a preset to the page. */
  function presetForClient(preset) {
    return {
      id: preset.id,
      name: preset.name,
      pack: preset.pack,
      builtin: preset.builtin === true,
      // The generated preset keeps the prompt it came from, so the user can see
      // what it was derived from and regenerate rather than start over.
      hasSource: typeof preset.source === 'string' && preset.source !== '',
    };
  }

  /**
   * Extract a persona card from a free-form persona prompt.
   *
   * Runs as a separate, tool-less model call, exactly like a rewrite: the
   * working conversation is never touched, and the generated card is just data
   * until the user saves it.
   * @param {string} personaPrompt
   * @param {{ provider: string, model: string }} route
   */
  async function extractPreset(personaPrompt, route) {
    const llm = getLlm();
    if (llm === undefined) return { ok: false, reason: 'no-llm' };
    const { system, user } = buildExtractPrompt(personaPrompt);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('extract-timeout')), Math.max(2000, cfg.timeoutMs));
    let collected = '';
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        signal: abort.signal,
      };
      if (settings.reasoningEffort !== '') options.reasoningEffort = settings.reasoningEffort;
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta') collected += chunk.text;
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'extract-failed' };
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return parseExtractedPreset(collected);
  }

  const touch = (sessionId) => {
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    schedulePersist(sessionId);
  };

  /** Coalesce persistence so a burst of settles writes one blob per session. */
  const persistTimers = new Map();

  /**
   * Write one session's rows now.
   *
   * Separate from the debounce so the unload path can drain instead of merely
   * cancelling: cancelling a pending write discarded a rewrite that had already
   * settled and been shown to the reader.
   * @param {string} sessionId
   */
  function flushPersist(sessionId) {
    if (store === undefined) return Promise.resolve();
    // Pull the stored rows in first. The write replaces the whole session blob,
    // so persisting a session that was never hydrated would erase every row this
    // process has not touched yet — which is exactly what a restart plus one new
    // message used to do.
    hydrate(sessionId);
    const own = [];
    for (const row of rows.values()) if (row.sessionId === sessionId) own.push(row);
    own.sort((a, b) => a.seq - b.seq);
    return store.put(sessionId, own.map((row) => ({
      seq: row.seq,
      status: row.status,
      text: row.text,
      reason: row.reason,
      model: row.model,
      distance: row.distance,
      final: row.final === true,
      time: row.time,
    }))).catch((error) => warn(`persist failed for ${sessionId}`, error));
  }

  function schedulePersist(sessionId) {
    if (store === undefined) return;
    if (persistTimers.has(sessionId)) return;
    persistTimers.set(sessionId, setTimeout(() => {
      persistTimers.delete(sessionId);
      flushPersist(sessionId);
    }, 400));
  }

  /** Sessions whose persisted rows have already been pulled in. */
  let hydrated = new Set();
  /** Hydrate one session's rows from the store, so a restart keeps them. */
  function hydrate(sessionId) {
    // Only mark a session as hydrated once a read actually happened: marking it
    // while storage was still opening would block the one read that matters.
    if (store === undefined) return;
    if (hydrated.has(sessionId)) return;
    hydrated.add(sessionId);
    try {
      for (const saved of store.get(sessionId)) {
        const key = `${sessionId}:${saved.seq}`;
        if (rows.has(key)) continue;
        rows.set(key, {
          sessionId,
          seq: saved.seq,
          status: saved.status === 'ready' ? 'ready' : 'skipped',
          text: typeof saved.text === 'string' ? saved.text : '',
          reason: typeof saved.reason === 'string' ? saved.reason : '',
          model: typeof saved.model === 'string' ? saved.model : '',
          distance: typeof saved.distance === 'object' ? saved.distance : undefined,
          final: saved.final === true,
          time: typeof saved.time === 'number' ? saved.time : Date.now(),
        });
      }
      markRestoredTail(sessionId);
      touch(sessionId);
    } catch (error) {
      warn(`hydrate failed for ${sessionId}`, error);
    }
  }

  /**
   * Give the newest restored row of a session the "final" flag.
   *
   * `final` is set by `turn/end`, which is a live event: a restart never replays
   * it, so every restored row arrived with `final: false` and the page drew no
   * persona badge and no 「原文」 toggle on any history at all.
   *
   * The exact turn boundary is not recoverable from stored rows, so the tail is
   * used: it is the one a reader scrolls back to, and being wrong here only
   * moves a button to a neighbouring row.
   * @param {string} sessionId
   */
  function markRestoredTail(sessionId) {
    let newest;
    for (const row of rows.values()) {
      if (row.sessionId !== sessionId) continue;
      if (row.final === true) return; // a live turn already marked one
      if (row.status !== 'ready') continue;
      if (newest === undefined || row.seq > newest.seq) newest = row;
    }
    if (newest !== undefined) newest.final = true;
  }

  /** Keep one session's rows bounded; oldest settled rows fall off first. */  function trim(sessionId) {
    const own = [];
    for (const row of rows.values()) if (row.sessionId === sessionId) own.push(row);
    const limit = Math.max(20, cfg.maxRowsPerSession);
    if (own.length <= limit) return;
    own.sort((a, b) => a.seq - b.seq);
    for (const row of own.slice(0, own.length - limit)) rows.delete(`${row.sessionId}:${row.seq}`);
  }

  /** The route the rewrite call should use: explicit override, else the turn's own route. */
  /**
   * A session id for a request that is not tied to one session.
   *
   * Preset generation runs from the settings page, which belongs to no session,
   * but the route still has to come from somewhere. The most recently active
   * session is the best available answer; an explicit settings-page model
   * override wins regardless.
   */
  function currentSessionHint() {
    let best;
    for (const [sessionId, state] of turnState) {
      if (state?.provider === undefined || state?.model === undefined) continue;
      if (best === undefined) best = sessionId;
    }
    return best;
  }

  function resolveRoute(sessionId) {
    // A provider without a model means "this provider's default", not "ignore the
    // setting". The old test required both to be non-empty, so choosing
    // 「该提供方的默认模型」 silently fell through to the session's route — the
    // page showed a provider the rewrite was not using, and the user could not
    // tell where their requests were going.
    if (settings.provider !== '') {
      return { provider: settings.provider, model: settings.model };
    }
    const state = turnState.get(sessionId);
    if (state?.provider !== undefined && state?.model !== undefined) {
      return { provider: state.provider, model: state.model };
    }
    return undefined;
  }

  /**
   * Resolve the model route, filling in a provider's default model when the user
   * chose a provider but no model.
   *
   * The synchronous `resolveRoute` cannot ask the provider for its default, and
   * passing an empty model through would either fail or pick something
   * unexpected. Asking here keeps the promise the settings page makes: choosing
   * 「该提供方的默认模型」 uses that provider.
   * @param {string | undefined} sessionId
   */
  async function resolveRouteAsync(sessionId) {
    const route = resolveRoute(sessionId);
    if (route === undefined) return undefined;
    if (route.model !== '') return route;

    const llm = getLlm();
    if (llm === undefined || typeof llm.listModels !== 'function') return undefined;
    try {
      const listed = await llm.listModels(route.provider);
      const first = Array.isArray(listed) ? listed[0] : undefined;
      if (first === undefined || typeof first.id !== 'string' || first.id === '') return undefined;
      return { provider: route.provider, model: first.id };
    } catch {
      return undefined;
    }
  }

  /**
   * Rewrite one text. Never throws: any failure settles the row without text,
   * which the page renders as the plain report.
   */
  async function rewrite({ sessionId, seq, text }) {
    const key = `${sessionId}:${seq}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    const row = rows.get(key);
    if (row === undefined) { inFlight.delete(key); return; }

    const settle = (status, reason, value) => {
      row.status = status;
      row.reason = reason;
      row.text = value ?? '';
      // A settled row never keeps a partial: the page treats `partial` as
      // "keeps growing", and a stale one would freeze mid-sentence.
      row.partial = '';
      row.partialLiterals = undefined;
      touch(sessionId);
    };

    try {
      const llm = getLlm();
      if (llm === undefined) { settle('skipped', 'no-llm'); return; }

      const route = await resolveRouteAsync(sessionId);
      if (route === undefined) { settle('skipped', 'no-route'); return; }

      const { masked, literals } = mask(text);
      // Prose is what gets rewritten; a text that is almost entirely literals
      // (a bare diff or command) has nothing to re-speak.
      const prose = masked.replace(/\[\[\d+\]\]/g, '').trim();
      if (prose.length < 2) { settle('skipped', 'no-prose'); return; }

      const { system, user } = buildRewritePrompt({
        pack: settings.pack,
        masked,
        literalCount: literals.length,
        history: samples.get(sessionId) ?? [],
        stage: turnState.get(sessionId)?.stage,
        memory: settings.memory === true ? memoryLines(profile, activePresetId()) : [],
      });

      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(new Error('rewrite-timeout')),
        Math.max(1000, cfg.timeoutMs),
      );

      let collected = '';
      try {
        const options = {
          provider: route.provider,
          model: route.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          signal: abort.signal,
        };
        if (settings.reasoningEffort !== '') options.reasoningEffort = settings.reasoningEffort;

        // Emit as the model writes. The partial text is the model's own output,
        // so it is still masked; unmasking waits for the final, validated text.
        // A throttle keeps a fast model from making every token a revision.
        let lastEmit = 0;
        const flush = (force) => {
          const now = Date.now();
          if (!force && now - lastEmit < STREAM_INTERVAL_MS) return;
          lastEmit = now;
          row.partial = collected;
          // The page needs the literal table to put code back while streaming;
          // markers alone would show as `[[0]]`.
          row.partialLiterals = literals;
          touch(sessionId);
        };

        for await (const chunk of llm.stream(options)) {
          if (chunk.type === 'text-delta') {
            collected += chunk.text;
            flush(false);
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind;
            if (kind === 'error' || kind === 'aborted') {
              settle('skipped', `finish-${kind}`);
              return;
            }
          }
        }
        flush(true);
      } finally {
        clearTimeout(timer);
        abort.abort();
      }

      // Validate in the masked vocabulary first: the markers are the whole
      // contract, and unmasking destroys the evidence used to check it.
      const verdict = validateRewrite({
        candidate: collected,
        original: masked,
        literalCount: literals.length,
        maxRatio: cfg.maxRatio,
      });
      if (!verdict.ok) { settle('skipped', verdict.reason); return; }

      row.text = unmask(collected.trim(), literals);
      row.model = `${route.provider}/${route.model}`;
      row.status = 'ready';
      row.reason = '';
      // The final text supersedes the stream; dropping the partial keeps the
      // page from having to decide which of the two to trust.
      row.partial = '';
      // Recorded for the operator, never used as a gate: whether a rewrite is
      // "enough" is the persona card's job, and a number here would only be a
      // second opinion that costs a whole extra call.
      row.distance = rewriteDistance(
        masked.replace(/\[\[\d+\]\]/g, ''),
        collected.replace(/\[\[\d+\]\]/g, ''),
      );
      touch(sessionId);

      const list = samples.get(sessionId) ?? [];
      // Store the MASKED rewrite, never `row.text`.
      //
      // `row.text` has its literals restored, and the sample is fed back as
      // `history` on the next call — so a code snippet, path or secret from one
      // report was being sent to the model verbatim on the following step. That
      // breaks the one guarantee this plugin makes about technical content: the
      // model only ever sees `[[n]]` placeholders. The masked form still carries
      // the voice, which is all continuity needs.
      list.push(verdict.text);
      while (list.length > Math.max(0, cfg.keepSamples)) list.shift();
      samples.set(sessionId, list);
    } catch (error) {
      settle('skipped', error instanceof Error ? error.message.slice(0, 120) : 'error');
      warn(`rewrite failed for ${key}`, error);
    } finally {
      inFlight.delete(key);
      trim(sessionId);
    }
  }

  /** Queue one text for rewriting. */
  function enqueue(sessionId, seq, text) {
    rows.set(`${sessionId}:${seq}`, {
      sessionId,
      seq,
      status: 'pending',
      text: '',
      reason: '',
      model: '',
      time: Date.now(),
    });
    touch(sessionId);
    void rewrite({ sessionId, seq, text });
  }

  /** Skip a text without spending a call, but still tell the page why. */
  function skip(sessionId, seq, reason) {
    rows.set(`${sessionId}:${seq}`, {
      sessionId, seq, status: 'skipped', text: '', reason, model: '', time: Date.now(),
    });
    // Trim here too. `trim()` used to run only in `rewrite()`'s finally, so every
    // skipped row — subagent output by default — accumulated without ever being
    // bounded by `maxRowsPerSession`.
    trim(sessionId);
    touch(sessionId);
  }

  /**
   * Whether this session belongs to a subagent rather than the user.
   *
   * `delegationDepth` on the session header is the marker: a session the user
   * opened has depth 0 (or none), a spawned helper's is at least 1. Read from the
   * header because the runtime object is the only place that carries it.
   * @param {any} session
   * @returns {boolean}
   */
  function isSubagent(session) {
    const depth = session?.header?.delegationDepth;
    return typeof depth === 'number' && depth > 0;
  }

  /** Whether this message asked for tools, i.e. it is mid-task rather than a report. */
  function hasToolCall(event) {
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => block?.type === 'tool-call');
  }

  /**
   * Whether this event carries a message the user wrote.
   *
   * The exact type is verified at runtime through the diagnostics route rather
   * than assumed: a wrong guess here is silent (memory would simply never learn
   * anything), which is exactly the failure mode this plugin has been bitten by
   * before.
   * @param {any} event
   */
  function isUserMessage(event) {
    const type = event?.type;
    if (typeof type !== 'string') return false;
    return type === 'user/message' || type === 'user-message';
  }

  /**
   * The user's own words from one message, or `undefined`.
   *
   * The shape is `data.content` — verified against a live event, not assumed.
   * `assistant/message` nests its body under `data.message`, and the two differ;
   * reading the wrong one yields `undefined` silently, which is how the first
   * version of this learned nothing at all.
   *
   * Only `text` blocks count. Command echoes, attachments and injected context
   * are not the user's prose and would skew every ratio.
   * @param {any} event
   */
  function userTextOf(event) {
    const direct = event?.data?.content;
    const nested = event?.data?.message?.content;
    const content = Array.isArray(direct) ? direct : (Array.isArray(nested) ? nested : undefined);
    if (content === undefined) return undefined;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text === '' ? undefined : text;
  }

  /**
   * Pull the readable text of one assistant message, or `undefined` when there is
   * nothing a reader would see.
   *
   * A step that is about to call a tool still emits narration ("现在改常量：…"),
   * and in a long turn that narration is most of what the user reads. Whether it
   * gets the persona treatment is the user's call (`includeToolSteps`), not a
   * silent rule: the earlier version hardcoded it away and the middle of every
   * turn stayed plain.
   * @param {any} event - the committed `assistant/message` event.
   * @param {boolean} includeToolSteps - whether tool-calling steps count.
   */
  function reportText(event, includeToolSteps) {
    if (event.data?.interrupted === true) return undefined;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const hasToolCall = content.some((block) => block?.type === 'tool-call');
    if (hasToolCall && !includeToolSteps) return undefined;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text === '' ? undefined : text;
  }

  function onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !settings.enabled) return;

    // Diagnostic: record the event types actually seen, so the memory feature can
    // be built on observed shapes instead of an assumed one.
    if (diagnostics.seenTypes === undefined) diagnostics.seenTypes = {};
    if (typeof event.type === 'string') {
      diagnostics.seenTypes[event.type] = (diagnostics.seenTypes[event.type] ?? 0) + 1;
    }

    // Shape probe for the subagent switch. `delegationDepth` lives on the
    // session header: 0 (or absent) for a session the user opened, >0 for a
    // subagent's. Collected across distinct sessions so both kinds are seen.
    // (Verified on this build: main = 0, spawned teammate = 1.)

    // Memory: learn from what the user writes. Only user-authored text is
    // evidence about the reader; assistant output and tool traffic say nothing
    // about how someone wants to be spoken to.
    //
    // The switch is checked here, not only where the memory is consumed. Turning
    // it off must stop collection as well as use — otherwise the profile keeps
    // growing while the UI says the feature is off, which is a privacy promise
    // broken silently.
    //
    // `settingsRestored` guards the startup window. The stored switches arrive
    // asynchronously, so between `apply` and the storage opening, `settings.memory`
    // still holds its default `true` — a user who had switched memory off would
    // have their first messages collected and persisted before the saved value
    // came back. Collection waits until the real value is known.
    if (settings.memory === true && settingsRestored && isUserMessage(event)) {
      const text = stripInjectedContext(userTextOf(event));
      if (text !== undefined && !looksLikePastedPersona(text)) observeUserText(text);
    }

    if (event.type === 'request/header') {
      const state = turnState.get(sessionId) ?? {};
      const header = event.data?.header;
      state.provider = header?.config?.provider;
      state.model = header?.config?.model;
      state.stage = undefined;
      turnState.set(sessionId, state);
      return;
    }

    if (event.type === 'turn/start') {
      const state = turnState.get(sessionId) ?? {};
      state.turn = event.data?.turn;
      state.steps = 0;
      state.tools = 0;
      state.stage = undefined;
      turnState.set(sessionId, state);
      return;
    }

    if (event.type === 'tool/call') {
      const state = turnState.get(sessionId);
      if (state !== undefined) {
        state.tools = (state.tools ?? 0) + 1;
        state.stage = `刚执行了 ${event.data?.name ?? '一个工具'}`;
      }
      return;
    }

    if (event.type === 'turn/end') {
      // Mark the step that closed this turn. The page shows the persona badge
      // and the 「原文」 toggle on that one only: a control on every mid-turn
      // narration turns the transcript into a wall of chrome, while the closing
      // report is the one a reader actually wants to compare.
      const closing = turnState.get(sessionId)?.lastSeq;
      if (typeof closing === 'number') {
        const row = rows.get(`${sessionId}:${closing}`);
        if (row !== undefined) {
          row.final = true;
          touch(sessionId);
        }
      }

      // `report` mode only rewrites the last report of a finished turn.
      if (cfg.trigger === 'report') {
        const candidate = candidates.get(sessionId);
        candidates.delete(sessionId);
        if (candidate !== undefined && event.data?.reason?.kind === 'completed') {
          enqueue(sessionId, candidate.seq, candidate.text);
          // `enqueue` is what creates the row, so the `final` marking above runs
          // before the row exists and silently does nothing in this mode. Mark it
          // here instead, after creation.
          const created = rows.get(`${sessionId}:${candidate.seq}`);
          if (created !== undefined) {
            created.final = true;
            touch(sessionId);
          }
        }
      }
      return;
    }

    if (event.type !== 'assistant/message') return;

    const state = turnState.get(sessionId) ?? {};
    state.steps = (state.steps ?? 0) + 1;

    // Every settled message carries the route that produced it, so the rewrite
    // follows the conversation's own model without waiting for a request
    // header (those are emitted only on a new series or a config change).
    const source = event.data?.message?.source;
    if (typeof source?.provider === 'string' && typeof source?.model === 'string') {
      state.provider = source.provider;
      state.model = source.model;
    }
    turnState.set(sessionId, state);

    const text = reportText(event, settings.includeToolSteps);
    if (text === undefined) return;

    // Remembered so `turn/end` can mark the closing report.
    state.lastSeq = event.seq;
    turnState.set(sessionId, state);
    if (text.length > cfg.maxRewriteChars) { skip(sessionId, event.seq, 'too-long'); return; }

    // Subagent sessions: a spawned helper's own conversation. Two independent
    // switches, because its mid-task chatter and its final answer are different
    // propositions — the chatter is usually never read, the conclusion often is.
    if (isSubagent(session)) {
      const carriesToolCall = hasToolCall(event);
      const allowed = carriesToolCall ? settings.subagentSteps === true : settings.subagentReports === true;
      if (!allowed) {
        skip(sessionId, event.seq, carriesToolCall ? 'subagent-step-off' : 'subagent-report-off');
        return;
      }
    }

    if (cfg.trigger === 'report') {
      candidates.set(sessionId, { seq: event.seq, text });
      return;
    }

    enqueue(sessionId, event.seq, text);
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'persona-shell.events');

  // Durable rows.
  //
  // Opened through `ctx.inject`, not straight from `ctx.get`: a composition
  // decides its own activation order, so the storage facility may not exist yet
  // while this plugin starts. Retrying on a timer would be a guess; injection
  // runs exactly when the service arrives.
  //
  // A failure is recorded rather than swallowed — a memory-only plugin looks
  // identical to a persisting one until a restart throws the history away.
  let storeClosing = false;
  /**
   * Every open attempt, so unload can wait for the facility to be released.
   *
   * Tracking only the resolved handle left a hole: an unload during the open
   * returned immediately because `store` was still undefined, the new instance
   * then found the domain staged by the first one and failed with `already-open`,
   * and nothing retries — that process stayed memory-only for good.
   */
  const openingTasks = new Set();

  const openWhenAvailable = () => {
    // Close the collection gate before anything asynchronous starts. The saved
    // switches are still unknown at this moment, and their defaults are
    // permissive: collecting now would violate a `memory:false` the user already
    // chose. Re-opening the gate is the last step of a successful restore.
    settingsRestored = false;
    storeState = 'opening';

    const task = openStore(ctx).then((opened) => {
      if (storeClosing) {
        // Shutting down: close what arrived and report nothing. The close is part
        // of this task, so the unload chain waits for the domain to be released.
        return opened.close().catch((error) => warn('late store close failed', error));
      }
      store = opened;
      storeState = 'open';
      storeError = '';
      // Pull in whatever the previous run already wrote.
      for (const sessionId of rows.keys()) {
        const id = sessionId.includes(':') ? sessionId.slice(0, sessionId.indexOf(':')) : sessionId;
        hydrate(id);
      }
      // Adopt the persisted reader profile, keeping anything already observed
      // during the window before storage finished opening.
      const savedProfile = opened.getProfile();
      if (savedProfile !== undefined) {
        profile = savedProfile.messages >= profile.messages ? savedProfile : profile;
      }
      if (profile.messages > 0) scheduleProfileSave();

      // Restore saved presets, keeping every shipped preset first and always
      // present even if the stored copy is missing or corrupt.
      const savedPresets = opened.listPresets();
      const restored = presets.filter((preset) => preset.builtin === true);
      for (const raw of savedPresets) {
        if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
        if (restored.some((preset) => preset.id === raw.id)) continue;
        restored.push({ ...raw, pack: normalizePack(raw.pack) });
      }
      presets = restored.slice(0, MAX_PRESETS);

      // Restore the selection the user left behind. Without this the active
      // persona lived only in memory and a restart quietly reverted to the
      // default, which is indistinguishable from the switch never having worked.
      const savedActive = opened.getActivePreset();
      if (typeof savedActive === 'string' && savedActive !== '') {
        const active = presets.find((preset) => preset.id === savedActive);
        if (active !== undefined) {
          settings.pack = normalizePack(active.pack);
          settings.presetName = active.name;
        }
      }

      // Restore the durable switches and route. The page reports 「已保存」 for
      // these, so losing them on restart is a promise broken — and re-enabling
      // memory for someone who switched it off is worse than an inconvenience.
      const savedSettings = opened.getSettings();
      if (savedSettings !== null && typeof savedSettings === 'object') {
        for (const key of ['enabled', 'includeToolSteps', 'memory', 'subagentSteps', 'subagentReports']) {
          if (typeof savedSettings[key] === 'boolean') settings[key] = savedSettings[key];
        }
        for (const key of ['provider', 'model', 'reasoningEffort']) {
          if (typeof savedSettings[key] === 'string') settings[key] = savedSettings[key];
        }
      }
      // The switches are now authoritative; memory collection may resume — but
      // never during shutdown, where nothing should keep publishing state.
      if (!storeClosing) settingsRestored = true;
    }, (error) => {
      storeError = error instanceof Error ? error.message : String(error);
      // Nothing can be restored. The question is what "unknown" should mean, and
      // the safe answer is "do not collect": a missing facility is not evidence
      // that the user never saved `memory:false`, and collecting on a guess breaks
      // a privacy switch. Collection stays off until storage actually reports.
      if (!storeClosing) {
        storeState = 'failed';
        warn('storage failed; rewrites are memory-only and memory collection stays off', error);
      }
    });
    openingTasks.add(task);
    task.finally(() => { openingTasks.delete(task); }).catch(() => {});
  };
  ctx.inject(['storageDomain'], () => {
    openWhenAvailable();
  });

  // ---------------------------------------------------------------------------
  // Client route: same-origin JSON, so the page needs no Remote codegen.
  // ---------------------------------------------------------------------------

  // A composition decides its own activation order, so `webServer` may not exist
  // yet while this plugin starts. `ctx.get` is tried first; when it is absent the
  // registration is deferred through `ctx.inject`, which runs once the service
  // actually arrives and re-runs if it is replaced.
  const registerRoutes = (server, owner) => {
    owner.effect(
      () => server.register({ kind: 'prefix', path: ROUTE, handler: handle }),
      'persona-shell.route',
    );
  };

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  const stateFor = (sessionId) => {
    // A page that opens an old session asks before any event arrives, so this
    // is where a restart's rows come back.
    hydrate(sessionId);
    const own = [];
    for (const row of rows.values()) if (row.sessionId === sessionId) own.push(row);
    own.sort((a, b) => a.seq - b.seq);
    return {
      rev: revisions.get(sessionId) ?? 0,
      settings,
      rows: own.map((row) => ({
        seq: row.seq,
        status: row.status,
        text: row.text,
        // Streaming text, still masked: the page unmasks it with the table
        // below. Absent once the row settles.
        partial: row.partial === undefined ? '' : row.partial,
        partialLiterals: row.partialLiterals === undefined ? undefined : row.partialLiterals,
        reason: row.reason,
        distance: row.distance,
        // True for the step that closed its turn; the page puts the badge and
        // the 「原文」 toggle on that one only.
        final: row.final === true,
      })),
    };
  };

  /**
   * Raw counters behind the memory summary, for the settings page.
   *
   * Exposed because an inference the user cannot inspect is one they cannot
   * correct; seeing "messages: 43, 中文 92%" makes a wrong call obvious.
   */
  function memoryStats() {
    return {
      messages: profile.messages,
      hanShare: profile.totalChars > 0 ? Number((profile.hanChars / profile.totalChars).toFixed(2)) : 0,
      meanSentence: profile.sentences > 0 ? Math.round(profile.chars / profile.sentences) : 0,
      stated: Array.isArray(profile.stated) ? profile.stated.length : 0,
      updatedAt: profile.updatedAt,
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // Authenticate before anything else.
    //
    // Unauthenticated liveness probe, answered before the auth check.
    //
    // This is a PUBLIC response, so it is built from a fixed shape rather than by
    // forwarding diagnostic values. An earlier version passed `diagnostics.auth`
    // straight through, which is normally `ok` or `rejected-401` — but on a
    // throwing auth check it carried the internal `error.message`, and that text
    // crossed the authentication boundary. Every field below is validated against
    // an enum or a range; anything unexpected becomes a neutral value.
    if (path === `${ROUTE}/ping`) {
      const authStatus = diagnostics.authStatus;
      sendJson(res, 200, {
        ok: true,
        hostBuild: HOST_BUILD,
        clientBuild: Number.isInteger(diagnostics.clientBuild) ? diagnostics.clientBuild : null,
        shippedMarkdown: pickEnum(diagnostics.shippedMarkdown, ['ok', 'missing', 'unresolvable'], 'unknown'),
        storage: pickEnum(storeState, ['unavailable', 'opening', 'open', 'failed'], 'unknown'),
        rows: Number.isInteger(rows.size) && rows.size >= 0 ? rows.size : 0,
        auth: pickEnum(authStatus, ['ok', 'rejected', 'unavailable', 'error'], 'unknown'),
        heartbeatAge: typeof diagnostics.heartbeat === 'number' && diagnostics.heartbeat <= Date.now()
          ? Date.now() - diagnostics.heartbeat
          : null,
        // Only key names from a known set: "the client never reported" and "the
        // report was dropped" look the same from outside otherwise.
        diagnosticKeys: Object.keys(diagnostics)
          .filter((key) => PUBLIC_DIAGNOSTIC_KEYS.has(key))
          .sort(),
      });
      return;
    }

    const rejection = requestRejection(req);
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
      return;
    }

    if (path === `${ROUTE}/state`) {
      const sessionId = url.searchParams.get('session') ?? '';
      if (sessionId === '') { sendJson(res, 400, { error: 'session required' }); return; }
      sendJson(res, 200, stateFor(sessionId));
      return;
    }

    // Options for the settings page. Providers are cheap to list; models cost
    // one adapter interrogation, so they are only fetched when asked for.
    if (path === `${ROUTE}/models`) {
      const llm = getLlm();
      if (llm === undefined) { sendJson(res, 200, { providers: [], models: [] }); return; }
      try {
        const provider = url.searchParams.get('provider') ?? '';
        const providers = typeof llm.listProviders === 'function'
          ? llm.listProviders().map((entry) => ({ provider: entry.id, name: entry.name }))
          : [];
        let models = [];
        if (provider !== '' && typeof llm.listModels === 'function') {
          const listed = await llm.listModels(provider);
          models = (Array.isArray(listed) ? listed : []).map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }));
        }
        sendJson(res, 200, { providers, models });
      } catch (error) {
        sendJson(res, 200, { providers: [], models: [], error: String(error?.message ?? error) });
      }
      return;
    }

    if (path === `${ROUTE}/diagnostics` && req.method === 'POST') {
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 8 * 1024) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      try {
        // Merge, never replace. Each report is a partial fact — the build id
        // arrives at apply time, the renderer verdict at first render, a probe
        // exactly once — so replacing meant the last report erased every earlier
        // one. That is why a perfectly good `applied: true` kept disappearing.
        const report = JSON.parse(raw === '' ? '{}' : raw);
        if (report !== null && typeof report === 'object') {
          diagnostics = { ...diagnostics, ...report };
          diagnostics.at = Date.now();
        }
      } catch { /* A malformed report changes nothing. */ }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === `${ROUTE}/diagnostics`) {
      sendJson(res, 200, {
        ...diagnostics,
        stored: diagnostics.at !== undefined,
        // Storage health rides along: a memory-only plugin otherwise looks
        // exactly like a persisting one until a restart loses the history.
        storage: storeState,
        storageError: storeError,
        rowCount: rows.size,
        // What memory has actually learned, so the numbers are inspectable
        // rather than taken on faith.
        memory: {
          messages: profile.messages,
          lines: memoryLines(profile, activePresetId()),
          enabled: settings.memory === true,
        },
      });
      return;
    }

    if (path === `${ROUTE}/presets` && req.method === 'GET') {
      sendJson(res, 200, {
        presets: presets.map(presetForClient),
        active: settings.presetName,
        // Where a new preset's model call would go, so the page can warn before
        // the user waits on a call that cannot succeed.
        route: resolveRoute(currentSessionHint()) ?? null,
      });
      return;
    }

    if (path === `${ROUTE}/presets` && req.method === 'POST') {
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 256 * 1024) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      let body;
      try { body = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const action = body?.action;

      // --- generate from a persona prompt -----------------------------------
      if (action === 'generate') {
        const personaPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (personaPrompt.length < 20) { sendJson(res, 400, { error: 'prompt too short' }); return; }
        if (personaPrompt.length > 24000) { sendJson(res, 400, { error: 'prompt too long' }); return; }
        const route = await resolveRouteAsync(currentSessionHint());
        if (route === undefined) { sendJson(res, 200, { ok: false, reason: 'no-route' }); return; }
        const result = await extractPreset(personaPrompt, route);
        if (result.ok !== true) { sendJson(res, 200, { ok: false, reason: result.reason }); return; }
        sendJson(res, 200, { ok: true, preset: result.preset });
        return;
      }

      // --- save ------------------------------------------------------------
      if (action === 'save') {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
        if (name === '') { sendJson(res, 400, { error: 'name required' }); return; }
        if (isBuiltinName(name)) { sendJson(res, 400, { error: 'reserved name' }); return; }

        // Re-saving under an existing name replaces it, which is what "update
        // this preset after editing it" means to a user.
        const existing = presets.find((preset) => preset.name === name && preset.builtin !== true);
        const entry = {
          id: existing?.id ?? `preset-${Date.now().toString(36)}`,
          name,
          pack: normalizePack(body.pack),
          source: typeof body.source === 'string' ? body.source.slice(0, 24000) : (existing?.source ?? ''),
          builtin: false,
          at: Date.now(),
        };
        if (existing === undefined) {
          if (presets.length >= MAX_PRESETS) { sendJson(res, 400, { error: 'too many presets' }); return; }
          presets = [...presets, entry];
        } else {
          presets = presets.map((preset) => (preset.id === entry.id ? entry : preset));
        }
        savePreset(entry);
        saveActivePreset(entry.id);
        settings.pack = entry.pack;
        settings.presetName = entry.name;
        for (const id of revisions.keys()) touch(id);
        sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings });
        return;
      }

      // --- rename ----------------------------------------------------------
      if (action === 'rename') {
        const id = typeof body.id === 'string' ? body.id : '';
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
        const target = presets.find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        if (target.builtin === true) { sendJson(res, 400, { error: 'builtin preset cannot be renamed' }); return; }
        if (name === '') { sendJson(res, 400, { error: 'name required' }); return; }
        if (isBuiltinName(name)) { sendJson(res, 400, { error: 'reserved name' }); return; }
        if (presets.some((preset) => preset.id !== id && preset.name === name)) {
          sendJson(res, 400, { error: 'name already used' });
          return;
        }

        const renamed = { ...target, name, at: Date.now() };
        presets = presets.map((preset) => (preset.id === id ? renamed : preset));
        savePreset(renamed);
        // `presetName` is the display label, so an active rename has to move with
        // it; the stored pointer is an id and does not change.
        if (settings.presetName === target.name) settings.presetName = name;
        sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings });
        return;
      }

      // --- apply -----------------------------------------------------------
      if (action === 'apply') {
        const id = typeof body.id === 'string' ? body.id : '';
        const target = presets.find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        settings.pack = normalizePack(target.pack);
        settings.presetName = target.name;
        saveActivePreset(target.id);
        for (const sessionId of revisions.keys()) touch(sessionId);
        sendJson(res, 200, { ok: true, settings, presets: presets.map(presetForClient), active: settings.presetName });
        return;
      }

      // --- delete ----------------------------------------------------------
      if (action === 'delete') {
        const id = typeof body.id === 'string' ? body.id : '';
        const target = presets.find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        if (target.builtin === true) { sendJson(res, 400, { error: 'builtin preset cannot be deleted' }); return; }
        presets = presets.filter((preset) => preset.id !== id);
        if (store !== undefined) store.deletePreset(id).catch((error) => warn('preset delete failed', error));
        // Deleting the active preset falls back to the shipped one rather than
        // leaving `pack` pointing at something that no longer exists — and the
        // stored pointer has to move with it, or the next restart restores a
        // preset that is gone.
        if (settings.presetName === target.name) {
          settings.pack = normalizePack(presets[0]?.pack);
          settings.presetName = presets[0]?.name ?? DEFAULT_PRESET_NAME;
          saveActivePreset(presets[0]?.id ?? DEFAULT_PRESET_NAME);
        }
        sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings });
        return;
      }

      sendJson(res, 400, { error: 'unknown action' });
      return;
    }

    if (path === `${ROUTE}/settings` && req.method === 'GET') {
      sendJson(res, 200, {
        settings,
        memory: memoryLines(profile, activePresetId()),
        memoryStats: memoryStats(),
        presets: presets.map(presetForClient),
      });
      return;
    }

    if (path === `${ROUTE}/settings` && req.method === 'POST') {
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 64 * 1024) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      let patch;
      try { patch = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      if (patch !== null && typeof patch === 'object') {
        if (patch.pack !== undefined) {
          settings.pack = normalizePack(patch.pack);
          // Write the edit back into the preset it belongs to. Without this the
          // change lived only in memory: the presets table still held the old
          // card, and the next restart silently restored it — which reads as
          // "my edits do not save".
          persistActivePack();
        }
        if (typeof patch.provider === 'string') settings.provider = patch.provider.trim();
        if (typeof patch.model === 'string') settings.model = patch.model.trim();
        if (typeof patch.reasoningEffort === 'string') settings.reasoningEffort = patch.reasoningEffort.trim();
        if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
        if (typeof patch.includeToolSteps === 'boolean') settings.includeToolSteps = patch.includeToolSteps;
        if (typeof patch.memory === 'boolean') settings.memory = patch.memory;
        if (typeof patch.subagentSteps === 'boolean') settings.subagentSteps = patch.subagentSteps;
        if (typeof patch.subagentReports === 'boolean') settings.subagentReports = patch.subagentReports;
        // Clearing the learned profile is a user right, not a debug affordance:
        // the plugin collects observations about them, so discarding them must
        // be one click away.
        if (patch.clearMemory === true) {
          profile = emptyProfile();
          scheduleProfileSave();
        }
        // Persist the switches and the route. The page reports 「已保存」, so a
        // restart that restored the defaults would make that a lie.
        saveSettings();
        for (const id of revisions.keys()) touch(id);
      }
      sendJson(res, 200, {
        settings,
        memory: memoryLines(profile, activePresetId()),
        memoryStats: memoryStats(),
        // Returned so the page can show which preset the edit landed in — an
        // edit to the builtin forks a new preset, and the user has to see that.
        presets: presets.map(presetForClient),
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  // Register now when the service is already present, else wait for it.
  if (webServer !== undefined) registerRoutes(webServer, ctx);
  else ctx.inject(['webServer'], (ready) => registerRoutes(ready.webServer, ready));

  ctx.effect(() => () => {
    storeClosing = true;
    // Stop accepting new work first, then drain.
    //
    // Three separate bugs lived here: the memory timer was never cleared, so it
    // fired after `store` was undefined and threw; the 400ms coalesced writes were
    // cancelled without flushing, so a row that had just settled was lost; and the
    // close was fire-and-forget, so a plugin reloaded immediately afterwards found
    // the domain still closing and failed to open it — `already-open` — and then
    // stayed memory-only for the rest of that process, because nothing retries.
    if (profileTimer !== undefined) {
      clearTimeout(profileTimer);
      profileTimer = undefined;
    }
    // Collect the writes to await. `putProfile` is awaited below so the final
    // state reaches the backend before the domain is torn down.
    const pending = [];
    if (store !== undefined) {
      pending.push(store.putProfile(profile).catch((error) => warn('profile flush failed', error)));
    }
    for (const [sessionId, timer] of persistTimers) {
      clearTimeout(timer);
      pending.push(flushPersist(sessionId));
    }
    persistTimers.clear();
    rows.clear();
    revisions.clear();
    samples.clear();
    hydrated.clear();
    turnState.clear();
    candidates.clear();
    inFlight.clear();

    const closing = store;
    store = undefined;
    // Wait for the whole teardown, including an open that is still in flight.
    //
    // Handling only a resolved handle left a real hole: an unload during the open
    // returned immediately, the facility kept the domain staged, and a reload
    // straight afterwards failed with `already-open` — then stayed memory-only for
    // the life of that process, because nothing retries an open failure.
    //
    // A task whose open lands during shutdown closes its own handle (see the
    // `storeClosing` branch), so awaiting these tasks is what makes "closed" mean
    // closed rather than merely "we called close".
    const tasks = [...openingTasks];
    const owned = closing === undefined
      ? Promise.resolve()
      : Promise.allSettled(pending)
        .then(() => closing.close())
        .catch((error) => warn('store close failed', error));
    return Promise.all([owned, Promise.allSettled(tasks)])
      .catch((error) => warn('store teardown failed', error));
  }, 'persona-shell.dispose');
}
