/**
 * Persona Shell — Host half.
 *
 * Nothing here touches the system prompt, the tool set, the agent loop, or the
 * session log. It re-speaks committed reports and, only when opted in,
 * summarizes observed runtime counters during quiet turns. Both are served
 * to the page separately, never fed back into the working conversation.
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
import { assessRewrite, restoreReview } from './lib/review.js';
import { Config, resolveConfig } from './lib/config.js';
import { observeMessage, emptyProfile } from './lib/memory.js';
import { openStore } from './lib/store.js';
import { buildProgressPrompt, createProgress, validateProgress } from './lib/progress.js';
import { randomUUID } from 'node:crypto';
import { createRemoteContract } from './lib/remote-contract.js';
import { createStateStream } from './lib/state-stream.js';
import { createToolUsage, restoreToolUsage } from './lib/tool-usage.js';
import { runProcessRewrite, validateProcessNote } from './lib/process-rewrite.js';
import { createStructuredMemory } from './lib/structured-memory.js';
import { buildMemoryPrompt, createMemoryConsolidator } from './lib/memory-consolidation.js';
import { createConversations } from './lib/conversations.js';
import { createExpressionLlm } from './lib/expression-llm.js';
import { createModelUsage } from './lib/model-usage.js';
import { createMemoryUsage } from './lib/memory-usage.js';
import { CHAT_LIMITS, createPersonaChat, parseChatResponse, chatFailure } from './lib/persona-chat.js';
import { buildChatPrompt, publicChatExchange } from './lib/chat-prompt.js';
import { buildParticipationPrompt, parseParticipation } from './lib/chat-participation.js';
import { roomCharacterContext } from './lib/character-roster.js';
import { buildReplySuggestions, parseReplySuggestions } from './lib/reply-suggestions.js';
import { builtinAvatar, normalizeAvatar, restoreAvatar, avatarUrl, avatarContent, avatarVersion } from './lib/avatar.js';
import { createChatProfile } from './lib/chat-profile.js';
import { createChatContext } from './lib/chat-context.js';
import { userInput } from './lib/user-text.js';
import { sourceOutputUsable } from './lib/source-report.js';
import { createChatSourceAdapter } from './lib/chat-source.js';
import { createChatLive, partialChatReply } from './lib/chat-live.js';
import { readFile } from 'node:fs/promises';

/** Cordis plugin name. */
export const name = 'persona-shell';

/** Route prefix this plugin owns. */
const ROUTE = '/persona-shell';

/** Name and id of the shipped preset; it cannot be deleted. */
const DEFAULT_PRESET_NAME = '大肥鱼（默认）';

/** Upper bound on stored presets, so a runaway loop cannot grow the file. */
// Shipped additions must not displace any of the 26 previously available custom slots.
const MAX_PRESETS = BUILTIN_PRESETS.length + 26;
const LEGACY_ABSORBED_NAMES = new Set(['大肥鱼（默认）', '大肥龙', 'Claude小姐']);

/** Upper bound on per-session switch entries; the oldest is evicted first. */
const MAX_SESSION_SWITCHES = 500;

/**
 * Host build marker, bumped whenever the Host half changes shape.
 *
 * Mirrors the Client half's `CLIENT_BUILD`. The desktop client cannot reload its
 * bundles, so after a deploy "the fix did nothing" and "the new Host half never
 * loaded" are indistinguishable from the transcript alone; the public probe
 * publishes both ids so a restart can be verified with one request.
 */
const HOST_BUILD = 2026110724;

/**
 * How often a streaming rewrite may publish a new partial revision.
 *
 * Coalesce token-level changes before either the Remote stream or fallback
 * long-poll publishes them. A short rewrite should still arrive in several
 * visible frames, without making every token a transport update.
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

function waitWithSignal(value, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function* streamWithSignal(llm, options) {
  options.signal.throwIfAborted();
  const iterator = llm.stream(options)[Symbol.asyncIterator]();
  let ended = false;
  try {
    while (true) {
      const next = await waitWithSignal(iterator.next(), options.signal);
      if (next.done) { ended = true; return; }
      yield next.value;
    }
  } finally {
    if (!ended) {
      try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Best-effort adapter cleanup. */ }
    }
  }
}

/** Runtime schema for the row: a Standard Schema resolver with no dependencies. */
export { Config };

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, rawConfig) {
  const instanceId = randomUUID();
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
    trigger: cfg.trigger,
    processToolUsage: cfg.processToolUsage,
    /** Whether accumulated reader observations reach the prompt at all. */
    memory: cfg.memory,
    memoryExtraction: cfg.memoryExtraction,
    reviewHints: cfg.reviewHints,
    reviewThreshold: cfg.reviewThreshold,
    progressNotices: cfg.progressNotices,
    progressMinutes: cfg.progressMinutes,
    /** Subagent conversations: mid-task narration, then the final answer. */
    subagentSteps: cfg.subagentSteps === true,
    subagentReports: cfg.subagentReports === true,
    pack: normalizePack(undefined),
    /** Name of the preset `pack` came from, for display. */
    presetName: DEFAULT_PRESET_NAME,
    provider: cfg.provider ?? '',
    model: cfg.model ?? '',
    reasoningEffort: cfg.reasoningEffort ?? '',
    chatProvider: cfg.chatProvider ?? '', chatModel: cfg.chatModel ?? '', chatThinking: cfg.chatThinking === true,
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
    avatar: builtinAvatar(entry.id),
    at: 0,
  }));
  let presetWrites = Promise.resolve();
  let presetChanging = false;

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
  let progressRestored = ctx.get('storageDomain') === undefined;
  const pendingSettings = new Map();
  let pendingMemoryClear = false;
  let toolUsageRestored = ctx.get('storageDomain') === undefined;
  let toolUsageRevision = 0;
  const toolUsage = createToolUsage();

  /**
   * Whether the runtime `enabled` switch is known.
   *
   * Unlike memory, a deployment without storage has no saved value to restore,
   * so the config default is authoritative there. While a storage facility is
   * opening, wait for the saved switch rather than rewrite for someone who had
   * turned the plugin off before the last restart.
   */
  let enabledRestored = ctx.get('storageDomain') === undefined;

  /** `${sessionId}:${seq}` → row. */
  const rows = new Map();
  /** sessionId → newest revision counter. */
  const revisions = new Map();
  /** sessionId → recent successful outputs, for tone continuity. */
  const samples = new Map();
  /** `${sessionId}:${seq}` currently being rewritten. */
  const inFlight = new Set();
  /** `${sessionId}:${seq}` → AbortController of the in-flight rewrite. */
  const activeRewrites = new Map();
  /** `${sessionId}:${seq}` → the persona actually used, including historical retries. */
  const activeRewritePersonas = new Map();
  const activeProcessRewrites = new Map();
  const activeExtractions = new Set();
  const modelTasks = new Set();
  const activeChats = new Map();
  const chatJobsFor = roomId => [...activeChats.values()].filter(job=>job.roomId===roomId);
  const chatJobKey = (roomId,attemptId) => JSON.stringify([roomId,attemptId]);
  const chatLive = createChatLive();
  const chatStreamControllers = new Set();
  const activeSuggestions = new Map();
  const chatStarting = new Set();
  const chatRounds = new Map();
  const chats = createPersonaChat({ persist: async (snapshot) => {
    if (!store || storeClosing || !settingsRestored) throw new Error('storage-not-ready');
    await store.putPersonaChats(snapshot);
  } });
  const chatSourceAdapter = createChatSourceAdapter(ctx);
  const chatContext = createChatContext({ adapter: chatSourceAdapter });
  const roomContexts = new Map();
  function contextForRoom(roomId, create = false) {
    if (!roomId) return chatContext;
    if (!chats.read(roomId)) throw Error('chat-room-not-found');
    if (!roomContexts.has(roomId) && create) roomContexts.set(roomId,createChatContext({adapter:chatSourceAdapter}));
    return roomContexts.get(roomId);
  }
  const roomScopeKey = room => room ? room.id+':sources:'+(room.sourceVersion??0) : null;
  function capturedRoomContext(roomId,key){
    const source=contextForRoom(roomId);if(!source||!key)throw Error('context-not-open');
    const value=source.capture(key),selection=source.snapshot(),room=chats.read(roomId);
    if(JSON.stringify(room.sources)!==JSON.stringify(selection.sources.map(s=>s.sessionId))||room.primarySessionId!==selection.primarySessionId)throw Error('chat-context-unsaved');
    return {...value,scopeKey:roomScopeKey(room)};
  }
  let chatRecordsLoaded = false, chatProfileLoaded = false;
  function ensureChatRecords() {
    if (!chatRecordsLoaded && settingsRestored && store && !storeClosing) {
      chats.restore(store.getPersonaChats()); chatRecordsLoaded = true;
    }
  }
  function ensureChatProfile() {
    if (!chatProfileLoaded && settingsRestored && store && !storeClosing) {
      chatProfile.restore(store.getChatProfile()); chatProfileLoaded = true;
    }
  }
  const chatContextState = (context, roomId) => {
    const value = (context??(!roomId?chatContext:undefined))?.snapshot() ?? {initialized:false};
    return { ...value, roomId,scopeKey:roomId?roomScopeKey(chats.read(roomId)):value.id?value.id+':'+value.revision:null,
      reportPersonaId: value.primarySessionId ? personaFor(value.primarySessionId).id : activePresetId() };
  };
  const sessionPersonaRevisions = new Map();
  const latestSourceSeq = new Map();
  const conversationErrors = new Map();
  const conversations = createConversations({ id: randomUUID,
    persist: async (snapshot) => {
      if (!store || storeClosing || !settingsRestored) throw new Error('storage-not-ready');
      await store.putConversations(snapshot);
    }, changed: (id, previous) => {
      // Evaluate both choices at the commit boundary, using the latest global defaults.
      const current = conversations.read(id);
      if (personaFor(id, previous).id !== personaFor(id, current).id || triggerFor(id, previous) !== triggerFor(id, current)) {
        const relayStarted = previous.relay?.status === 'pending' && current.relay?.status === 'active'
          && previous.relay.id === current.relay.id;
        invalidatePersona(relayStarted ? 'relay-started' : 'conversation-changed', (sessionId) => sessionId === id);
        // Relay begins at an observed report boundary; keep later source candidates and counters.
        if (!relayStarted) { candidates.delete(id); toolUsage.clear(id); }
      }
      touch(id);
    } });
  /** sessionId → running-turn facts harvested from the log. */
  const turnState = new Map();
  /** sessionId → the candidate text of the turn so far (`trigger: 'report'`). */
  const candidates = new Map();

  /**
   * Per-session switch overrides.
   *
   * Only an explicit `false` is stored; a missing entry follows the global
   * switch. Keeping the map sparse means a fresh install and every old profile
   * behave exactly as before (all sessions on).
   */
  const sessionSwitches = new Map();
  /** Toggles made before the saved map is restored; applied on open. */
  const pendingSessionSwitchValues = new Map();
  /** Monotonic revision for the map, so a client can ignore stale answers. */
  let sessionSwitchRev = 0;

  /**
   * sessionId → Set<wake> for held `/state` requests.
   *
   * A long-poll request resolves on the next `touch(sessionId)` or its timeout;
   * this is what turns the page's fixed polling cadence into event-driven
   * updates. The set stores the resolver itself so a request can remove exactly
   * its own waiter when the client disconnects.
   */
  const stateWaiters = new Map();
  const stateStream = createStateStream({ read: (id) => stateFor(id) });

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
  let memoryWrites = Promise.resolve();
  const memories = createStructuredMemory({ changed: () => scheduleProfileSave() });
  let usageWrites = Promise.resolve();
  let usageTimer;
  let usageSaveFailed = false;
  const memoryUsage = createMemoryUsage({ changed: () => scheduleMemoryUsageSave() });
  let modelUsageWrites = Promise.resolve(), modelUsageTimer, modelUsageWriteFailed = false;
  let modelUsageRevision = 0, savedModelUsageRevision = 0;
  const modelUsage = createModelUsage({ changed() { modelUsageRevision++; scheduleModelUsageSave(); } });
  /** Debounced writer for the profile row. */
  let profileTimer;

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
  function observeUserText(text, context) {
    const before = new Set(memories.snapshot().entries.filter((e) => e.status === 'active').map((e) => e.id));
    if (Number.isSafeInteger(context.seq) && !memories.observe({ ...context, text,
      queue: settings.memoryExtraction === true })) return;
    for (const entry of memories.snapshot().entries) if (entry.status === 'active' && !before.has(entry.id)) invalidateMemoryScope(entry);
    // Record what was actually sampled, so a surprising ratio can be traced to a
    // specific message instead of guessed at. Lengths and counts only: this is a
    // debugging aid, and it must not become a second copy of the user's words.
    const sample = {
      len: text.length,
      han: (text.match(/[\u4e00-\u9fff]/g) ?? []).length,
      latin: (text.match(/[A-Za-z]/g) ?? []).length,
      at: Date.now(),
    };
    memorySamples.push(sample);
    while (memorySamples.length > 12) memorySamples.shift();
    // Written straight into the host's diagnostics bag: `reportDiagnostics` is the
    // client-side poster and does not exist here.
    diagnostics.memorySamples = memorySamples;

    profile = observeMessage(profile, text);
    scheduleProfileSave();
    memoryConsolidator.notify();
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

  function personaFor(sessionId, choice = conversations.read(sessionId)) {
    const selected = choice.personaId;
    const preset = presets.find((p) => p.id === selected);
    return preset ?? { id: activePresetId(), name: settings.presetName, pack: settings.pack };
  }
  function triggerFor(sessionId, choice = conversations.read(sessionId)) {
    const own = choice.trigger;
    return own === 'inherit' ? settings.trigger : own;
  }
  function conversationState(sessionId) {
    if (!revisions.has(sessionId)) revisions.set(sessionId, 0);
    const own = conversations.read(sessionId);
    const effective = personaFor(sessionId);
    return { ...own, sessionId, instanceId, stateRev: revisions.get(sessionId),
      effectivePersonaId: effective.id, effectivePersonaName: effective.name,
      effectiveTrigger: triggerFor(sessionId), missingPersona: !!own.personaId && !presets.some((p) => p.id === own.personaId),
      presets: presets.map((p) => ({ id: p.id, name: p.name, narration: p.pack.narration })),
      relayError: conversationErrors.get(sessionId),
      ready: settingsRestored && !!store && !storeClosing };
  }
  const revisionFor = (id) => sessionPersonaRevisions.get(id) ?? 0;

  function invalidatePersona(reason = 'persona-changed', affected = () => true, requestPersonaId) {
    const ids = new Set([...revisions.keys(), ...samples.keys(), ...turnState.keys()]);
    for (const key of activeRewrites.keys()) ids.add(key.slice(0, key.lastIndexOf(':')));
    for (const id of ids) if (affected(id)) {
      sessionPersonaRevisions.set(id, revisionFor(id) + 1);
      samples.delete(id);
      progress.configure(id);
    }
    for (const [key, controller] of activeRewrites) {
      if (affected(key.slice(0, key.lastIndexOf(':')))
        || (requestPersonaId !== undefined && activeRewritePersonas.get(key) === requestPersonaId)) controller.abort(new Error(reason));
    }
    for (const pending of activeChats.values()) {
      const current = presets.find((p) => p.id === pending.personaId);
      if (!current || current.pack !== pending.pack || (requestPersonaId === pending.personaId
        && ['persona-changed', 'persona-deleted'].includes(reason))) pending.abort.abort(new Error('persona-changed'));
    }
    for (const pending of activeSuggestions.values()) {
      const current = presets.find((p) => p.id === pending.personaId);
      if (!current || current.pack !== pending.pack || (requestPersonaId === pending.personaId
        && ['persona-changed', 'persona-deleted'].includes(reason))) pending.abort.abort(new Error('persona-changed'));
    }
  }

  function retireStaleChatMemory(reason, applies = () => true) {
    // Queued speakers have not read their preferences yet. Neither judges nor
    // suggestions use private memory; a change must not retire their whole room.
    for (const job of activeChats.values()) {
      if (applies(job.roomId, job.personaId) && job.hasStaleMemory?.()) job.abort.abort(new Error(reason));
    }
  }

  function invalidateMemoryScope(...scopes) {
    const applies = (sessionId, personaId) => scopes.some(scope => scope && (scope.scope === 'shared'
      || (scope.scope === 'persona' ? personaId === scope.personaId
        : sessionId === scope.sessionId && (!scope.personaId || personaId === scope.personaId))));
    invalidatePersona('memory-changed', (id) => applies(id, personaFor(id).id));
    // Historical retries may use a different persona from the session's current selection.
    for (const [key, controller] of activeRewrites) if (applies(key.slice(0, key.lastIndexOf(':')), activeRewritePersonas.get(key))) {
      controller.abort(new Error('memory-changed'));
    }
    retireStaleChatMemory('memory-changed', applies);
  }

  function trackModelTask(task) {
    modelTasks.add(task);
    void task.finally(() => modelTasks.delete(task)).catch(() => {});
    return task;
  }

  function setSetting(key, value) {
    settings[key] = value;
    if (!settingsRestored) pendingSettings.set(key, value);
  }

  function expressionLlm(purpose, onDispatch, chatOptions) {
    const llm = getLlm();
    return llm === undefined ? undefined : createExpressionLlm(llm, { reasoningEffort: chatOptions ? '' : settings.reasoningEffort,
      thinking: chatOptions?.thinking, onDispatch,
      onAttempt: route => modelUsage.begin({ purpose, ...route }),
      onDecision: (decision) => { if (!storeClosing) diagnostics.expressionModel = { purpose, ...decision }; } });
  }

  function scheduleModelUsageSave() {
    if (!store || storeClosing || modelUsageTimer !== undefined || savedModelUsageRevision === modelUsageRevision) return;
    modelUsageTimer = setTimeout(() => {
      modelUsageTimer = undefined;
      void saveModelUsage(store).catch(error => warn('model usage persist failed', error));
    }, 1500);
    modelUsageTimer.unref?.();
  }

  function saveModelUsage(opened) {
    modelUsageWrites = modelUsageWrites.catch(() => {}).then(async () => {
      if (!opened || savedModelUsageRevision === modelUsageRevision) return;
      const revision = modelUsageRevision;
      try {
        await opened.putModelUsage(modelUsage.snapshot());
        savedModelUsageRevision = revision;
        modelUsageWriteFailed = false;
      } catch (error) { modelUsageWriteFailed = true; throw error; }
    });
    return modelUsageWrites;
  }

  function scheduleMemoryUsageSave() {
    if (!store || storeClosing || usageTimer !== undefined) return;
    usageTimer = setTimeout(() => {
      usageTimer = undefined;
      void saveMemoryUsage().catch((error) => warn('memory usage persist failed', error));
    }, 1500);
    usageTimer.unref?.();
  }

  function saveMemoryUsage() {
    if (!store) return Promise.resolve();
    const opened = store;
    usageWrites = usageWrites.catch(() => {}).then(async () => {
      try { await opened.putMemoryUsage(memoryUsage.snapshot()); usageSaveFailed = false; }
      catch (error) { usageSaveFailed = true; throw error; }
    });
    return usageWrites;
  }

  function expressionMemory(personaId, sessionId, text, channel) {
    if (!settings.memory || !settingsRestored) return { entries: [] };
    const selection = memories.selection({ personaId, sessionId, text });
    return { entries: selection.entries, usage: memoryUsage.begin({ personaId, sessionId, channel, selection }) };
  }

  function scheduleProfileSave() {
    if (store === undefined) return;
    if (profileTimer !== undefined) return;
    profileTimer = setTimeout(() => {
      profileTimer = undefined;
      store.putProfile(profile).catch((error) => warn('profile persist failed', error));
      void saveMemory().catch((error) => warn('memory persist failed', error));
    }, 1500);
  }

  function saveMemory() {
    if (store === undefined) return Promise.resolve();
    const opened = store;
    memoryWrites = memoryWrites.catch(() => {}).then(() => opened.putMemory(memories.snapshot()));
    return memoryWrites;
  }

  /** Commit owner changes only after durable storage succeeds; concurrent observation/clear wins. */
  function saveMemoryMutation(action, { handoff = false, requireEnabled = false } = {}) {
    const opened = store;
    const task = memoryWrites.catch(() => {}).then(async () => {
      if (!opened || storeClosing) throw new Error('storage-not-ready');
      const baseline = memories.snapshot();
      const staged = createStructuredMemory();
      staged.restore(baseline);
      const result = handoff ? staged.handoff(action) : staged.mutate(action);
      const next = staged.snapshot();
      await opened.putMemory(next);
      if (storeClosing || (requireEnabled && !settings.memory) || memories.snapshot().revision !== baseline.revision) {
        // A concurrent clear/edit wins. Repair the durable copy before reporting conflict.
        await opened.putMemory(memories.snapshot());
        throw new Error('memory-conflict');
      }
      memories.restore(next);
      if (!handoff && !['propose', 'propose-add', 'dismiss', 'reject'].includes(action.action)
        && next.revision !== baseline.revision) {
        const before = action.action === 'update' ? baseline.entries.find(e => e.id === action.id) : undefined;
        invalidateMemoryScope(before, action.action === 'confirm' ? result.target : result);
      }
      return result;
    });
    memoryWrites = task.catch(() => {});
    return task;
  }

  function readerMemoryLines(sessionId = currentSessionHint(), text = '') {
    return memories.select({ personaId: activePresetId(), sessionId, text })
      .map((entry) => entry.content);
  }

  function memoryState() {
    const snapshot = memories.snapshot();
    return { revision: snapshot.revision, entries: snapshot.entries, operations: snapshot.operations,
      activePersonaId: activePresetId(), activePresetName: settings.presetName, sessionId: currentSessionHint() ?? null,
      extraction: memoryConsolidator.state(),
      usage: { ...memoryUsage.snapshot(), persistence: usageSaveFailed ? 'failed' : store ? 'local' : 'unavailable' } };
  }

  const chatProfile = createChatProfile({
    available: () => settingsRestored && !!store && !storeClosing,
    persist: (value) => store.putChatProfile(value),
  });
  function publicChatProfile() {
    ensureChatProfile();
    const value = chatProfile.read();
    return { instanceId, revision: value.revision, avatarMode: value.avatarMode,
      avatar: value.avatar ? ROUTE + '/chat-profile/avatar?v=' + avatarVersion(value.avatar) : null };
  }
  function chatState(key) {
    ensureChatRecords();
    const room = chats.read(key);
    const personaId = room?.targetPersonaId ?? (presets.some(p=>p.id===key)?key:activePresetId());
    const preparing=!!room && chatStarting.has(room.id);
    const current=room?chatRounds.get(room.id):undefined;
    const round=!preparing && current && !current.abort.signal.aborted ? current : undefined;
    const running = !!room && (preparing||!!round||chatJobsFor(room.id).some(job=>!job.abort.signal.aborted));
    if (room && !running) for (const turn of room.turns) if (turn.status === 'pending') turn.status = 'interrupted';
    const contacts = presets.map((p) => ({ id: p.id, name: p.name, archived: false, avatar: avatarUrl(p) }));
    for (const old of chats.contacts()) if (!contacts.some((p) => p.id === old.personaId)) {
      contacts.push({ id: old.personaId, name: old.name, archived: true });
    }
    for(const id of room?.memberIds??[])if(!contacts.some(p=>p.id===id))contacts.push({id,name:'已移除的人格',archived:true,avatar:null});
    const context=room?roomContexts.get(room.id):undefined;
    return { instanceId,chatSchema:3,discussionVersion:2,roundId:round?.id,roundMessageId:round?.messageId,roundPhase:preparing?'preparing':round?.stage,activeAttemptIds:room?chatJobsFor(room.id).filter(job=>job.started&&!job.abort.signal.aborted).map(job=>job.attemptId):[], personaId, room, scopeKey:roomScopeKey(room), rooms:chats.list(), activeRoomId:chats.active(), running:!!running, contacts, epoch: chats.epoch(), userProfile: publicChatProfile(), defaultPersonaId: activePresetId(),
      ready: settingsRestored && !!store && !storeClosing, modelReady: !!chatRoute(context?.snapshot().primarySessionId??currentSessionHint()) };
  }

  function launchChat(persona, room, turn, workContext,waitFor,round) {
    if (storeClosing || turn.status !== 'pending') return;
    const key=chatJobKey(room.id,turn.attemptId);
    const previous = chatJobsFor(room.id).find(job=>job.turnId===turn.id);
    if (previous?.attemptId === turn.attemptId && !previous.abort.signal.aborted) return;
    previous?.abort.abort(new Error('chat-superseded'));
    const abort = new AbortController();
    const aborted=()=>abort.abort(round.abort.signal.reason);round.abort.signal.addEventListener('abort',aborted,{once:true});if(round.abort.signal.aborted)aborted();
    if(!chats.hasMember(room.id,persona.id))abort.abort(Error('chat-member-removed'));
    const chatOptions={provider:settings.chatProvider,model:settings.chatModel,thinking:settings.chatThinking};
    let liveRevision=0,lastLiveAt=0,progressTimer;
    const pending = { personaId: persona.id, roomId: room.id,turnId:turn.id,messageId:turn.messageId,started:!waitFor, pack: persona.pack, abort, attemptId: turn.attemptId, contextKey: workContext?.key };
    activeChats.set(key, pending);
    const publish=(status,messages=[])=>{
      if(activeChats.get(key)!==pending)return;
      chatLive.publish(key,{instanceId,personaId:persona.id,roomId:room.id,turnId:turn.id,
        attemptId:turn.attemptId,revision:++liveRevision,status,messages});
      const members=chats.liveGroup(room.id,turn.messageId);
      if(!members?.some(t=>t.id===turn.id&&t.attemptId===turn.attemptId))return;
      const frames=members.map(t=>chatLive.read(chatJobKey(room.id,t.attemptId))).filter(Boolean);
      chatLive.publish(room.id,{instanceId,roomId:room.id,frames,
        status:frames.length===members.length&&frames.every(f=>!['streaming','queued'].includes(f.status))?'settled':'streaming'});
    };
    publish(waitFor?'queued':'streaming');
    const sourceContext=roomContexts.get(room.id)??chatContext;
    return trackModelTask((async () => {
      let memoryContext;
      let outcome = 'failed';
      let timer;
      const valid = () => !storeClosing && presets.find((p) => p.id === persona.id)?.pack === persona.pack
        && chats.hasMember(room.id,persona.id)
        && (!workContext || sourceContext.key() === workContext.key);
      try {
        if(waitFor)await waitWithSignal(waitFor,abort.signal);
        abort.signal.throwIfAborted();
        if(!valid())throw Error('persona-changed');
        const current=chats.read(room.id),position=current?.turns.findIndex(t=>t.id===turn.id&&t.attemptId===turn.attemptId);
        if(position===undefined||position<0||current.turns[position].status!=='pending')throw Error('chat-cancelled');
        const preceding=current.turns.slice(0,position).filter(t=>t.messageId===turn.messageId&&t.status==='ready'
          &&(t.scopeKey??t.contextKey??null)===(turn.scopeKey??turn.contextKey??null));
        pending.started=true;publish('streaming');
        timer=setTimeout(()=>abort.abort(new Error('chat-timeout')),cfg.timeoutMs);
        const route = await waitWithSignal(resolveChatRouteAsync(workContext?.primarySessionId??currentSessionHint(),chatOptions), abort.signal);
        if (!valid() || !route) throw new Error('chat-unavailable');
        memoryContext = expressionMemory(persona.id, room.id, turn.user, 'chat');
        const refs = entries => JSON.stringify(entries.map(({ id, version }) => [id, version]));
        const used = refs(memoryContext.entries);
        pending.hasStaleMemory = () => used !== refs(settings.memory
          ? memories.select({ personaId: persona.id, sessionId: room.id, text: turn.user }) : []);
        const llm = expressionLlm('chat', () => {
          if (!valid()) throw new Error('persona-changed');
          memoryContext.usage?.sent();
        },chatOptions);
        if (!llm) throw new Error('chat-unavailable');
        const history = room.turns.filter(t => t.messageId!==turn.messageId&&(t.scopeKey??t.contextKey??null) === (turn.scopeKey??turn.contextKey??null));
        const currentMemberIds=chats.read(room.id)?.memberIds??[];
        const castMembers=currentMemberIds.map(id=>presets.find(p=>p.id===id)).filter(Boolean);
        const { system, user } = buildChatPrompt({ pack: persona.pack, history, message: turn.user,
          exchange:preceding,phase:turn.phase,
          cast:roomCharacterContext(persona,castMembers),
          memory: memoryContext.entries.map((e) => e.content), workContext,
          speaker:{id:persona.id,name:persona.name},recipients:turn.recipients,participants:castMembers.map(({id,name})=>({id,name})) });
        let wire = '', finish;
        for await (const chunk of streamWithSignal(llm, { provider: route.provider, model: route.model, system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 2048, signal: abort.signal })) {
          if (!valid()) throw new Error('persona-changed');
          if (chunk.type === 'error') throw chunk.error ?? chunk.failure ?? new Error('chat-model-error');
          if (chunk.type.startsWith('tool-call')
            || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
            || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) throw new Error('chat-invalid');
          if (chunk.type === 'text-delta') {wire += chunk.text;
            if(wire.length>24000)throw Error('chat-too-long');
            if(!progressTimer){const delay=Math.max(0,40-(Date.now()-lastLiveAt));
              if(!delay){publish('streaming',partialChatReply(wire));lastLiveAt=Date.now();}
              else progressTimer=setTimeout(()=>{progressTimer=undefined;if(valid()&&!abort.signal.aborted){publish('streaming',partialChatReply(wire));lastLiveAt=Date.now();}},delay);
            }}
          if (wire.length > 24000) throw new Error('chat-too-long');
          if (chunk.type === 'finish') {
            finish = chunk.reason?.kind;
            if (finish === 'error') throw chunk.reason.failure ?? new Error('chat-model-error');
          }
        }
        clearTimeout(progressTimer);progressTimer=undefined;
        abort.signal.throwIfAborted();
        if (!valid() || finish !== 'stop') throw new Error(finish === 'max-tokens' ? 'chat-length' : 'chat-incomplete');
        const messages = parseChatResponse(wire);
        if (!messages) { outcome = 'rejected'; throw new Error('chat-format'); }
        const applied = await chats.finish({ personaId: persona.id, roomId: room.id, id: turn.id,
          attemptId: turn.attemptId, status: 'ready', messages, valid: () => valid() && !abort.signal.aborted });
        outcome = applied ? 'generated' : 'cancelled';
        publish(applied?'ready':'cancelled',applied?messages.map(text=>({text,complete:true})):[]);
      } catch (error) {
        const failure = chatFailure(error, abort.signal);
        if (abort.signal.aborted && failure !== 'timeout') outcome = 'cancelled';
        if (!storeClosing) try {
          await chats.finish({ personaId: persona.id, roomId: room.id, id: turn.id, attemptId: turn.attemptId,
            status: outcome === 'cancelled' ? 'cancelled' : 'failed', failure });
        } catch (error) { warn('chat result persist failed', error); }
        publish(outcome==='cancelled'?'cancelled':'failed');
      } finally {
        memoryContext?.usage?.finish(outcome);
        clearTimeout(progressTimer);
        clearTimeout(timer); abort.abort();
        round.abort.signal.removeEventListener('abort',aborted);
        if (activeChats.get(key) === pending) activeChats.delete(key);
      }
    })());
  }

  function launchChatRound(result,workContext) {
    const room=result.room,turns=result.turns??[result.turn],messageId=turns[0].messageId;
    const original=room.turns.find(t=>t.messageId===messageId);
    const abort=new AbortController(),round={id:randomUUID(),roomId:room.id,messageId,abort,stage:'speaking',epoch:chats.epoch(),
      contextKey:workContext?.key,attempts:new Set(turns.map(t=>t.attemptId)),
      members:presets.filter(p=>original.memberIdsAtSend.includes(p.id)&&room.memberIds.includes(p.id)),
      selected:original.recipients.map(p=>p.id)};
    chatRounds.get(room.id)?.abort.abort(Error('chat-superseded'));chatRounds.set(room.id,round);
    const source=roomContexts.get(room.id)??chatContext;
    const valid=()=>!storeClosing&&!abort.signal.aborted&&chatRounds.get(room.id)===round&&chats.acceptsEpoch(room.id,round.epoch)
      &&chats.read(room.id)?.turns.at(-1)?.messageId===messageId&&(!workContext||source.key()===workContext.key);
    const totalTimer=setTimeout(()=>abort.abort(Error('chat-timeout')),Math.min(120000,cfg.timeoutMs*8));
    const queue=(batch,currentRoom)=>{let chain;for(const turn of batch){const person=round.members.find(p=>p.id===turn.recipientId);
      const task=person?launchChat(person,currentRoom,turn,workContext,chain,round)
        :(chain??Promise.resolve()).then(()=>chats.finish({roomId:room.id,id:turn.id,attemptId:turn.attemptId,status:'cancelled',failure:'persona-changed'}));
      chain=Promise.allSettled([chain,task]);
    }return chain??Promise.resolve();};
    const main=queue(turns,room);
    void trackModelTask((async()=>{
      try{
        await main;if(!valid()||turns.every(t=>t.phase==='reaction'))return;
        const current=chats.read(room.id),primary=current.turns.filter(t=>t.messageId===messageId&&t.phase!=='reaction');
        const candidates=round.members.filter(p=>!round.selected.includes(p.id)&&chats.hasMember(room.id,p.id)&&presets.find(v=>v.id===p.id)?.pack===p.pack);
        const limit=Math.min(CHAT_LIMITS.reactions,candidates.length),scopeKey=workContext?.scopeKey??workContext?.key??null;
        if(!limit||!candidates.length||!primary.some(t=>t.status==='ready')||primary.some(t=>(t.scopeKey??t.contextKey??null)!==scopeKey))return;
        round.stage='listening';const controller=new AbortController(),stop=()=>controller.abort(abort.signal.reason);
        abort.signal.addEventListener('abort',stop,{once:true});if(abort.signal.aborted)stop();
        const timer=setTimeout(()=>controller.abort(Error('chat-timeout')),Math.min(8000,cfg.timeoutMs));let picked=[];
        try{
          const options={provider:settings.chatProvider,model:settings.chatModel,thinking:false};
          const route=await waitWithSignal(resolveChatRouteAsync(workContext?.primarySessionId??currentSessionHint(),options),controller.signal);
          const llm=expressionLlm('chat-participation',()=>{if(!valid())throw Error('chat-cancelled');},options);
          if(route&&llm&&valid()){
            const castMembers=round.members.filter(p=>chats.hasMember(room.id,p.id)&&presets.find(v=>v.id===p.id)?.pack===p.pack);
            const presentCandidates=candidates.filter(p=>castMembers.includes(p));
            if(!presentCandidates.length)return;
            const {system,user}=buildParticipationPrompt({message:primary[0].user,recipients:primary[0].recipients,exchange:publicChatExchange(primary,4000),candidates:presentCandidates,limit:Math.min(limit,presentCandidates.length),
              cast:roomCharacterContext(null,castMembers,{allRelationships:true})});
            let wire='',finish;
            for await(const chunk of streamWithSignal(llm,{provider:route.provider,model:route.model,system,messages:[{role:'user',content:[{type:'text',text:user}]}],maxTokens:256,signal:controller.signal})){
              if(chunk.type==='error'||chunk.type.startsWith('tool-call')||(chunk.type==='block-start'&&chunk.blockType==='tool-call')||(chunk.type==='block-end'&&chunk.block?.type==='tool-call'))throw Error('invalid-participation');
              if(chunk.type==='text-delta')wire+=chunk.text;if(wire.length>4096)throw Error('invalid-participation');
              if(chunk.type==='finish')finish=chunk.reason?.kind;
            }
            if(finish==='stop'&&!controller.signal.aborted)picked=parseParticipation(wire,presentCandidates.map(p=>p.id),limit);
          }
        }catch{/* Silence is the safe, ordinary fallback for a listener decision. */}
        finally{clearTimeout(timer);abort.signal.removeEventListener('abort',stop);controller.abort();}
        if(!valid())return;
        const recipients=picked.map(id=>candidates.find(p=>p.id===id)).filter(p=>chats.hasMember(room.id,p.id)&&presets.find(v=>v.id===p.id)?.pack===p.pack).map(p=>({id:p.id,name:p.name}));
        const added=await chats.appendReactions({roomId:room.id,messageId,planId:round.id,primaryAttempts:primary.map(t=>({id:t.id,attemptId:t.attemptId})),recipients,
          epoch:round.epoch,contextKey:workContext?.key??null,scopeKey,valid});
        if(valid()&&added.created&&added.turns.length){for(const t of added.turns)round.attempts.add(t.attemptId);round.stage='speaking';await queue(added.turns,added.room);}
      }catch{/* A failed listener append does not discard successful primary replies. */}
      finally{
        clearTimeout(totalTimer);
        if(abort.signal.aborted&&!storeClosing){const pending=chats.read(room.id)?.turns.filter(t=>t.messageId===messageId&&t.status==='pending'&&round.attempts.has(t.attemptId))??[];
          if(pending.length)try{await chats.cancel({roomId:room.id,id:pending[0].id,attemptId:pending[0].attemptId,messageId,
            attempts:pending.map(t=>({id:t.id,attemptId:t.attemptId})),epoch:round.epoch});}catch{/* Clear/delete may already have retired this generation. */}}
        if(chatRounds.get(room.id)===round)chatRounds.delete(room.id);
      }
    })());
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
  async function persistActivePack(pack) {
    const active = presets.find((preset) => preset.name === settings.presetName);

    if (active !== undefined && active.builtin !== true) {
      const updated = { ...active, pack, at: Date.now() };
      await commitPresetChange({ entry: updated });
      presets = presets.map((preset) => (preset.id === active.id ? updated : preset));
      return settings.presetName;
    }

    if (presets.length >= MAX_PRESETS) throw new Error('too-many-presets');

    // Fork from the active shipped preset (or from a name that no longer resolves).
    const base = active?.builtin === true
      ? (active.name === DEFAULT_PRESET_NAME ? '自定义' : active.name)
      : settings.presetName;
    let name = `${base} 2`;
    for (let index = 3; presets.some((preset) => preset.name === name); index += 1) {
      name = `${base} ${index}`;
    }
    const forked = {
      id: `preset-${randomUUID()}`,
      name,
      pack,
      avatar: active?.avatar ?? null,
      source: active?.source ?? '',
      builtin: false,
      at: Date.now(),
    };
    await commitPresetChange({ entry: forked, activeId: forked.id });
    presets = [...presets, forked];
    settings.presetName = name;
    return name;
  }

  /** Persist the durable switches and route. */
  function saveSettings() {
    if (store === undefined) return;
    store.putSettings({
      enabled: settings.enabled,
      includeToolSteps: settings.includeToolSteps,
      trigger: settings.trigger,
      processToolUsage: settings.processToolUsage,
      memory: settings.memory,
      memoryExtraction: settings.memoryExtraction,
      reviewHints: settings.reviewHints,
      reviewThreshold: settings.reviewThreshold,
      progressNotices: settings.progressNotices,
      progressMinutes: settings.progressMinutes,
      subagentSteps: settings.subagentSteps,
      subagentReports: settings.subagentReports,
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      chatProvider:settings.chatProvider,chatModel:settings.chatModel,chatThinking:settings.chatThinking,
    }).catch((error) => warn('settings persist failed', error));
  }

  function queuePresetWrite(write) {
    const opened = store;
    const task = presetWrites.catch(() => {}).then(() => write(opened));
    presetWrites = task.catch(() => {});
    return task;
  }

  async function commitPresetChange({ entry, removeId, activeId }) {
    if (storeClosing || storeState === 'opening') throw new Error('storage-not-ready');
    if (!store) return; // Existing hosts without storage retain their explicit memory-only mode.
    const previous = presets.find((p) => p.id === (entry?.id ?? removeId));
    const previousActive = activePresetId();
    await queuePresetWrite(async (opened) => {
      try {
        if (entry) await opened.putPreset(entry);
        if (removeId) await opened.deletePreset(removeId);
        if (activeId !== undefined) await opened.putActivePreset(activeId);
      } catch (error) {
        // The storage wrapper has no cross-key transaction. Restore acknowledged keys on an ordinary failure.
        try {
          if (entry || removeId) {
            if (previous) await opened.putPreset(previous);
            else await opened.deletePreset(entry.id);
          }
          if (activeId !== undefined) await opened.putActivePreset(previousActive);
        } catch (rollbackError) { warn('preset rollback failed', rollbackError); }
        throw error;
      }
    });
    if (storeClosing) throw new Error('storage-not-ready');
  }

  /** Strip the internal fields before sending a preset to the page. */
  function presetForClient(preset) {
    const character=roomCharacterContext(preset,presets.filter(p=>p.builtin===true));
    return {
      id: preset.id,
      name: preset.name,
      pack: preset.pack,
      builtin: preset.builtin === true,
      avatar: avatarUrl(preset),
      ...(character?.self?{character:{...character.self,relations:character.relationships}}:{}),
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
   * @param {string | undefined} sessionId
   */
  async function extractPreset(personaPrompt, sessionId) {
    const llm = expressionLlm('preset');
    if (llm === undefined) return { ok: false, reason: 'no-llm' };
    const { system, user } = buildExtractPrompt(personaPrompt);

    const abort = new AbortController();
    activeExtractions.add(abort);
    const timer = setTimeout(() => abort.abort(new Error('extract-timeout')), Math.max(2000, cfg.timeoutMs));
    let collected = '';
    try {
      if (storeClosing) throw new Error('disposed');
      const route = await waitWithSignal(resolveRouteAsync(sessionId), abort.signal);
      abort.signal.throwIfAborted();
      if (storeClosing) throw new Error('disposed');
      if (route === undefined) return { ok: false, reason: 'no-route' };
      const options = {
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        signal: abort.signal,
      };
      let finish;
      for await (const chunk of streamWithSignal(llm, options)) {
        abort.signal.throwIfAborted();
        if (chunk.type === 'text-delta') collected += chunk.text;
        else if (chunk.type === 'finish') finish = chunk.reason?.kind;
      }
      abort.signal.throwIfAborted();
      if (storeClosing) throw new Error('disposed');
      if (finish !== 'stop') return { ok: false, reason: `finish-${finish ?? 'missing'}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'extract-failed' };
    } finally {
      clearTimeout(timer);
      abort.abort();
      activeExtractions.delete(abort);
    }
    return parseExtractedPreset(collected);
  }

  async function extractMemories(batch, parentSignal) {
    const abort = new AbortController();
    const cancelled = () => abort.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', cancelled, { once: true });
    if (parentSignal.aborted) cancelled();
    activeExtractions.add(abort);
    const timer = setTimeout(() => abort.abort(new Error('memory-timeout')), Math.max(1000, cfg.timeoutMs));
    try {
      abort.signal.throwIfAborted();
      if (storeClosing) throw new Error('disposed');
      const llm = expressionLlm('memory');
      if (!llm) throw new Error('no-llm');
      const route = await waitWithSignal(resolveRouteAsync(batch.sources[0].sessionId), abort.signal);
      abort.signal.throwIfAborted();
      if (!route || storeClosing) throw new Error('no-route');
      const prompt = buildMemoryPrompt(batch);
      const options = { ...route, system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }], signal: abort.signal };
      let text = ''; let finish;
      for await (const chunk of streamWithSignal(llm, options)) {
        abort.signal.throwIfAborted();
        if (chunk.type === 'text-delta') text += chunk.text;
        if (text.length > 16384) throw new Error('memory-too-long');
        if (chunk.type === 'finish') finish = chunk.reason?.kind;
        if (chunk.type === 'error') throw new Error('memory-stream-error');
      }
      abort.signal.throwIfAborted();
      if (finish !== 'stop') throw new Error('memory-incomplete');
      const value = JSON.parse(text);
      if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.entries)) {
        throw new Error('memory-format');
      }
      return value.entries;
    } finally {
      clearTimeout(timer); abort.abort(); activeExtractions.delete(abort);
      parentSignal.removeEventListener('abort', cancelled);
    }
  }

  const memoryConsolidator = createMemoryConsolidator({
    memory: memories,
    enabled: () => !storeClosing && settingsRestored && settings.enabled === true
      && settings.memory === true && settings.memoryExtraction === true,
    run: (batch, signal) => trackModelTask(extractMemories(batch, signal)),
  });

  const touch = (sessionId) => {
    if (storeClosing) return;
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    wakeStateWaiters(sessionId);
    stateStream.changed(sessionId);
    if (sessionId !== '') schedulePersist(sessionId);
  };

  /** Wake every request held for this session. */
  function wakeStateWaiters(sessionId) {
    const waiters = stateWaiters.get(sessionId);
    if (waiters === undefined) return;
    for (const wake of [...waiters]) wake();
  }

  /**
   * Hold one `/state` request until the session's revision moves or timeout.
   *
   * `req`/`res` are Node objects in production and plain stubs in tests, so the
   * close hooks are optional. A client that goes away mid-wait must remove its
   * waiter; otherwise memory grows one entry per abandoned request. Listening on
   * the response as well as the request covers both the socket-close and the
   * response-lifecycle shapes across Node versions.
   *
   * @param {string} sessionId
   * @param {number} timeoutMs
   * @param {{ on?: Function, off?: Function } | undefined} req
   * @param {{ on?: Function, off?: Function } | undefined} res
   * @returns {Promise<void>}
   */
  function waitForStateChange(sessionId, timeoutMs, req, res) {
    return new Promise((resolve) => {
      let settled = false;
      let waiters = stateWaiters.get(sessionId);
      if (waiters === undefined) {
        waiters = new Set();
        stateWaiters.set(sessionId, waiters);
      }
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) stateWaiters.delete(sessionId);
        if (typeof req?.off === 'function') req.off('close', finish);
        if (typeof res?.off === 'function') res.off('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiters.add(finish);
      if (typeof req?.on === 'function') req.on('close', finish);
      if (typeof res?.on === 'function') res.on('close', finish);
    });
  }

  /** Whether this session should be rewritten, before the global switch. */
  function sessionEnabledFor(sessionId) {
    return sessionSwitches.get(sessionId) !== false;
  }

  /** The full rewrite gate: global master + restore window + session override. */
  function rewriteAllowedFor(sessionId) {
    return !storeClosing && settings.enabled === true && enabledRestored && sessionEnabledFor(sessionId);
  }

  /** Why rewriteAllowedFor() is false, for the row's skipped reason. */
  function rewriteBlockReason(sessionId) {
    if (settings.enabled !== true || !enabledRestored) return 'disabled';
    if (sessionSwitches.get(sessionId) === false) return 'session-off';
    return 'blocked';
  }

  /** The switch map as the client sees it. */
  const sessionSwitchState = () => ({
    instanceId,
    rev: sessionSwitchRev,
    values: Object.fromEntries(sessionSwitches),
  });

  /** Persist the per-session switches; a failed write must not break the page. */
  function saveSessionSwitches() {
    if (store === undefined || !settingsRestored) return;
    store.putSessionSwitches(sessionSwitchState())
      .catch((error) => warn('session switches persist failed', error));
  }

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
    if (sessionId !== '') hydrate(sessionId);
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
      review: row.review,
      processNote: row.processNote,
      processUsage: row.processUsage,
      process: row.process === true,
      original: row.original,
      version: row.version,
      speaker: row.speaker,
      memoryRefs: row.memoryRefs,
      sourceIsSubagent: row.sourceIsSubagent === true,
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
    let savedRows;
    try {
      savedRows = store.get(sessionId);
    } catch (error) {
      // Leave it un-hydrated so a later state read can retry; a failed read
      // must not permanently hide this session's stored history.
      warn(`hydrate failed for ${sessionId}`, error);
      return;
    }
    hydrated.add(sessionId);
    try {
      for (const saved of savedRows) {
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
          review: restoreReview(saved.review),
          processNote: saved.final === true ? undefined : validateProcessNote(saved.processNote, saved.processUsage),
          processUsage: saved.final === true ? undefined : restoreToolUsage(saved.processUsage),
          process: saved.process === true,
          original: typeof saved.original === 'string' && saved.original.length <= cfg.maxRewriteChars ? saved.original : undefined,
          version: Number.isSafeInteger(saved.version) && saved.version > 0 ? saved.version : 1,
          speaker: typeof saved.speaker?.id === 'string' && typeof saved.speaker?.name === 'string'
            ? { id: saved.speaker.id.slice(0, 200), name: saved.speaker.name.slice(0, 80),
              mode: saved.speaker.mode === 'relay' ? 'relay' : 'voice' } : undefined,
          memoryRefs: Array.isArray(saved.memoryRefs) ? saved.memoryRefs.filter((ref) =>
            typeof ref?.id === 'string' && ref.id.length <= 160 && Number.isSafeInteger(ref.version) && ref.version > 0)
            .slice(0, 5).map((ref) => ({ id: ref.id, version: ref.version })) : [],
          sourceIsSubagent: saved.sourceIsSubagent === true,
          final: saved.final === true,
          time: typeof saved.time === 'number' ? saved.time : Date.now(),
        });
      }
      trim(sessionId);
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
      if (row.process === true) continue;
      if (row.status !== 'ready') continue;
      if (newest === undefined || row.seq > newest.seq) newest = row;
    }
    if (newest !== undefined) newest.final = true;
  }

  /** Keep results bounded, including failed preparations that never reach rewrite(). */
  function trim(sessionId) {
    const own = [];
    for (const row of rows.values()) if (row.sessionId === sessionId) own.push(row);
    const limit = Math.max(20, cfg.maxRowsPerSession);
    if (own.length <= limit) return;
    own.sort((a, b) => a.seq - b.seq);
    for (const row of own.slice(0, own.length - limit)) rows.delete(`${row.sessionId}:${row.seq}`);
    touch(sessionId);
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

  function chatRoute(sessionId,options={provider:settings.chatProvider,model:settings.chatModel}) {
    return options.provider?{provider:options.provider,model:options.model}:resolveRoute(sessionId);
  }
  async function resolveChatRouteAsync(sessionId,options) {
    const route=chatRoute(sessionId,options);if(!route||route.model)return route;
    try{const models=await getLlm()?.listModels?.(route.provider);const first=Array.isArray(models)?models[0]:undefined;
      return typeof first?.id==='string'&&first.id?{provider:route.provider,model:first.id}:undefined;}catch{return undefined;}
  }

  /**
   * Rewrite one text. Never throws: any failure settles the row without text,
   * which the page renders as the plain report.
   */
  async function rewrite({ sessionId, seq, text, usage, usageRevision, rowOverride, packOverride, feedback = '' }) {
    const key = `${sessionId}:${seq}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    const row = rowOverride ?? rows.get(key);
    if (row === undefined) { inFlight.delete(key); return; }
    const revision = revisionFor(sessionId);
    const persona = packOverride ?? personaFor(sessionId);
    const processAllowed = () => rewriteAllowedFor(sessionId) && revision === revisionFor(sessionId)
      && settings.includeToolSteps === true && settings.processToolUsage === true
      && toolUsageRestored && usageRevision === toolUsageRevision;
    const processMode = usage !== undefined && processAllowed();
    const settle = (status, reason, value) => {
      if (storeClosing) return;
      row.status = status;
      row.reason = reason;
      row.text = value ?? '';
      row.partial = '';
      row.partialLiterals = undefined;
      touch(sessionId);
    };

    if (!rewriteAllowedFor(sessionId)) {
      settle('skipped', rewriteBlockReason(sessionId));
      inFlight.delete(key);
      trim(sessionId);
      return;
    }

    // Route discovery belongs to the same cancellation and deadline as generation.
    const abort = new AbortController();
    activeRewrites.set(key, abort);
    activeRewritePersonas.set(key, persona.id);
    if (processMode) activeProcessRewrites.set(key, abort);
    const timer = setTimeout(() => abort.abort(new Error('rewrite-timeout')), Math.max(1000, cfg.timeoutMs));
    let memoryContext;
    let rejected = false;
    try {
      const llm = expressionLlm('rewrite', () => {
        memoryContext?.usage?.sent();
        row.memoryRefs = (memoryContext?.entries ?? []).map((e) => ({ id: e.id, version: e.version }));
      });
      if (llm === undefined) { settle('skipped', 'no-llm'); return; }
      const route = await waitWithSignal(resolveRouteAsync(sessionId), abort.signal);
      abort.signal.throwIfAborted();
      if (!rewriteAllowedFor(sessionId)) { settle('skipped', rewriteBlockReason(sessionId)); return; }
      if (revision !== revisionFor(sessionId)) { settle('skipped', 'persona-changed'); return; }
      if (route === undefined) { settle('skipped', 'no-route'); return; }

      const { masked, literals } = mask(text);
      const prose = masked.replace(/\[\[\d+\]\]/g, '').trim();
      if (prose.length < 2) { settle('skipped', 'no-prose'); return; }
      memoryContext = expressionMemory(persona.id, sessionId, text, feedback ? 'retry' : processMode ? 'process' : 'report');
      const { system, user } = buildRewritePrompt({
        pack: persona.pack,
        masked,
        literalCount: literals.length,
        history: feedback ? [] : samples.get(sessionId) ?? [],
        memory: memoryContext.entries.map((e) => e.content),
        processTools: processMode,
        feedback,
        sourceLabel: row.sourceIsSubagent ? persona.pack.address.subagent : undefined,
      });
      const options = {
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        signal: abort.signal,
      };
      let collected = '';
      let processNote;
      let lastEmit = 0;
      const flush = (force) => {
        const now = Date.now();
        if (!force && now - lastEmit < STREAM_INTERVAL_MS) return;
        lastEmit = now;
        row.partial = collected;
        row.partialLiterals = literals;
        touch(sessionId);
      };
      if (processMode) {
        const result = await runProcessRewrite({ llm, options, usage, allowed: processAllowed,
          maxChars: Math.ceil(Math.max(masked.length * cfg.maxRatio, masked.length + 200) * 6 + 1024),
          onPartial(value) { collected = value; flush(false); } });
        collected = result.text;
        processNote = result.note;
      } else {
        let finish;
        for await (const chunk of streamWithSignal(llm, options)) {
          abort.signal.throwIfAborted();
          if (!rewriteAllowedFor(sessionId)) throw new Error(rewriteBlockReason(sessionId));
          if (chunk.type === 'text-delta') {
            collected += chunk.text;
            flush(false);
          } else if (chunk.type === 'finish') {
            finish = chunk.reason?.kind;
            if (finish !== 'stop') throw new Error(`finish-${finish ?? 'unknown'}`);
          }
        }
        if (finish !== 'stop') throw new Error('finish-missing');
      }
      abort.signal.throwIfAborted();
      if (!rewriteAllowedFor(sessionId)) { settle('skipped', rewriteBlockReason(sessionId)); return; }
      if (revision !== revisionFor(sessionId)) { settle('skipped', 'persona-changed'); return; }
      const verdict = validateRewrite({
        candidate: collected,
        original: masked,
        literalCount: literals.length,
        maxRatio: cfg.maxRatio,
      });
      if (!verdict.ok) { rejected = true; settle('skipped', verdict.reason); return; }

      row.text = unmask(collected.trim(), literals);
      row.model = `${route.provider}/${route.model}`;
      row.status = 'ready';
      row.reason = '';
      if (processMode && processAllowed() && processNote && row.final !== true && toolUsage.claimNote(usage)) {
        row.processNote = processNote;
        row.processUsage = restoreToolUsage(usage);
      }
      row.partial = '';
      row.partialLiterals = undefined;
      row.distance = rewriteDistance(
        masked.replace(/\[\[\d+\]\]/g, ''),
        collected.replace(/\[\[\d+\]\]/g, ''),
      );
      row.review = assessRewrite({
        original: text,
        candidate: row.text,
        maskedOriginal: masked,
        maskedCandidate: verdict.text,
      });
      touch(sessionId);

      // Keep only masked samples from the current persona, without runtime observations.
      if (processMode || feedback || persona.id !== personaFor(sessionId).id) return;
      const list = samples.get(sessionId) ?? [];
      list.push(verdict.text);
      while (list.length > Math.max(0, cfg.keepSamples)) list.shift();
      samples.set(sessionId, list);
    } catch (error) {
      settle('skipped', error instanceof Error ? error.message.slice(0, 120) : 'error');
      if (!abort.signal.aborted) warn(`rewrite failed for ${key}`, error);
    } finally {
      memoryContext?.usage?.finish(row.status === 'ready' ? 'generated' : abort.signal.aborted ? 'cancelled' : rejected ? 'rejected' : 'failed');
      clearTimeout(timer);
      abort.abort();
      activeRewrites.delete(key);
      activeRewritePersonas.delete(key);
      activeProcessRewrites.delete(key);
      inFlight.delete(key);
      trim(sessionId);
    }
  }

  /** Queue one text for rewriting. */
  function enqueue(sessionId, seq, text, usage, process = false) {
    if (rows.has(`${sessionId}:${seq}`)) return;
    rows.set(`${sessionId}:${seq}`, {
      sessionId,
      seq,
      status: 'pending',
      text: '',
      reason: '',
      model: '',
      time: Date.now(),
      process,
      original: text,
      version: 1,
      speaker: { id: personaFor(sessionId).id, name: personaFor(sessionId).name,
        mode: personaFor(sessionId).pack.narration?.mode ?? 'voice' },
      sourceIsSubagent: turnState.get(sessionId)?.sourceIsSubagent === true,
    });
    touch(sessionId);
    const row = rows.get(`${sessionId}:${seq}`);
    const queuedRevision = revisionFor(sessionId);
    const queuedConversation = conversations.read(sessionId);
    const start = async () => {
      if (queuedConversation.relay?.status === 'pending') {
        try {
          if (await conversations.take(sessionId, seq, (id) => presets.some((p) => p.id === id))) {
            conversationErrors.delete(sessionId);
          } else if (queuedRevision !== revisionFor(sessionId)) {
            const current = conversations.read(sessionId);
            const joinedRelay = current.revision === queuedConversation.revision + 1
              && current.relay?.id === queuedConversation.relay.id && current.relay.status === 'active'
              && seq >= current.relay.consumedSeq && personaFor(sessionId).id === current.relay.toPersonaId;
            if (!joinedRelay) { row.status = 'skipped'; row.reason = 'persona-changed'; touch(sessionId); return; }
          }
          const persona = personaFor(sessionId);
          row.speaker = { id: persona.id, name: persona.name, mode: persona.pack.narration?.mode ?? 'voice' };
        } catch (error) {
          conversationErrors.set(sessionId, error?.message === 'relay-persona-deleted'
            ? '接手人格已被删除，本次接力已取消。这份汇报保留原文。'
            : '这次接力没有保存成功，这份汇报保留原文；仍等待下一份汇报接手。');
          row.status = 'skipped'; row.reason = 'relay-save-failed'; touch(sessionId); return;
        }
      }
      if (storeClosing || rows.get(`${sessionId}:${seq}`) !== row) return;
      await rewrite({ sessionId, seq, text, usage, usageRevision: toolUsageRevision });
    };
    void trackModelTask(start().finally(() => trim(sessionId)));
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
    if (!sourceOutputUsable(event.data)) return undefined;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const hasToolCall = content.some((block) => block?.type === 'tool-call');
    if (hasToolCall && !includeToolSteps) return undefined;
    const textBlocks = content.filter((block) => block?.type === 'text' && typeof block.text === 'string');
    // The renderer suppresses multi-text-block nodes; do not spend a rewrite on
    // a row the page can never display.
    if (textBlocks.length !== 1) return undefined;
    const text = textBlocks[0].text.trim();
    return text === '' ? undefined : text;
  }

  const progress = createProgress({
    config: () => ({ enabled: settings.enabled === true && enabledRestored
      && settings.progressNotices === true && progressRestored && !storeClosing,
      minutes: settings.progressMinutes }),
    allowed: (session) => rewriteAllowedFor(session.id) && !isSubagent(session)
      && session.header?.origin !== 'subagent',
    agentFor: (sessionId) => ctx.get('agents')?.get?.(sessionId),
    changed: touch,
    produce(sessionId, facts, signal) {
      return trackModelTask((async () => {
        const persona = personaFor(sessionId);
        const memoryContext = expressionMemory(persona.id, sessionId, facts, 'progress');
        let outcome = 'failed';
        try {
          const route = await waitWithSignal(resolveRouteAsync(sessionId), signal);
          const llm = expressionLlm('progress', () => memoryContext.usage?.sent());
          if (signal.aborted || !route || !llm) throw new Error('progress-unavailable');
          const { system, user } = buildProgressPrompt(normalizePack(persona.pack), facts, memoryContext.entries.map((e) => e.content));
          let text = '';
          let finished = false;
          for await (const chunk of streamWithSignal(llm, { provider: route.provider, model: route.model, system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 512, signal })) {
            if (signal.aborted) throw new Error('progress-aborted');
            if (chunk.type === 'error' || chunk.type === 'tool-call') throw new Error('progress-invalid');
            if (chunk.type === 'text-delta') {
              text += chunk.text;
              if (text.length > 220) { outcome = 'rejected'; return undefined; }
            }
            if (chunk.type === 'finish') finished = chunk.reason?.kind === 'stop';
          }
          outcome = finished ? (validateProgress(text, facts) ? 'generated' : 'rejected') : 'failed';
          return finished ? text : undefined;
        } finally { memoryContext.usage?.finish(signal.aborted ? 'cancelled' : outcome); }
      })());
    },
  });

  function onSessionEvent(session, event) {
    if (storeClosing) return;
    chatContext.event(session, event);
    for (const context of roomContexts.values()) context.event(session,event);
    if (typeof session?.id === 'string' && Number.isSafeInteger(event.seq)) {
      latestSourceSeq.set(session.id, Math.max(event.seq, latestSourceSeq.get(session.id) ?? -1));
    }
    const observeUsage = triggerFor(session?.id) === 'step' && toolUsageRestored && settings.processToolUsage === true
      && settings.includeToolSteps === true && !storeClosing && rewriteAllowedFor(session?.id)
      && !isSubagent(session) && session?.header?.origin !== 'subagent';
    let usage;
    if (observeUsage) usage = toolUsage.event(session, event);
    else toolUsage.clear(session?.id);
    progress.event(session, event);
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !settings.enabled || !enabledRestored) return;
    // A per-session switch turns off rewriting *and* memory observation for that
    // conversation. Returning here is what keeps a disabled session from
    // spending a model call or silently feeding the shared reader profile.
    if (!sessionEnabledFor(sessionId)) return;

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
    if (isUserMessage(event)) {
      const input = userInput(event.data), text = input?.text;
      if (text != null && settings.memory === true && settingsRestored && !isSubagent(session)
        && session?.header?.origin !== 'subagent' && !looksLikePastedPersona(text)) {
        observeUserText(text, { sessionId, seq: event.seq, personaId: personaFor(sessionId).id });
      }
      // A real steering message starts a new question, even within the same
      // turn. A report that predates it cannot be its final answer.
      const state = turnState.get(sessionId);
      const turn = event.data?.turn ?? event.data?.message?.turn;
      if (input && state && event.seq > (state.reportCursor ?? -1)
        && !(Number.isSafeInteger(turn) && Number.isSafeInteger(state.turn) && turn < state.turn)) {
        candidates.delete(sessionId);
        state.lastSeq = undefined;
        state.reportCursor = event.seq;
      }
      return;
    }

    if (event.type === 'request/header') {
      const state = turnState.get(sessionId) ?? {};
      const header = event.data?.header;
      state.provider = header?.config?.provider;
      state.model = header?.config?.model;
      turnState.set(sessionId, state);
      return;
    }

    if (!['turn/start', 'assistant/message', 'turn/end'].includes(event.type)) return;
    const state = turnState.get(sessionId) ?? {};
    if (!Number.isSafeInteger(event.seq) || event.seq <= (state.reportCursor ?? -1)) return;
    if (state.turn != null && event.data?.turn != null && event.data.turn < state.turn) return;
    state.reportCursor = event.seq;
    turnState.set(sessionId, state);

    if (event.type === 'turn/start') {
      state.turn = event.data?.turn;
      state.lastSeq = undefined;
      candidates.delete(sessionId);
      return;
    }

    if (event.type === 'turn/end') {
      // Mark the step that closed this turn. The page shows the persona badge
      // and the 「原文」 toggle on that one only: a control on every mid-turn
      // narration turns the transcript into a wall of chrome, while the closing
      // report is the one a reader actually wants to compare.
      const matchesTurn = state.turn == null || event.data?.turn == null || state.turn === event.data.turn;
      const reason = event.data?.reason?.kind;
      const closing = matchesTurn && reason === 'completed' ? state.lastSeq : undefined;
      // Legacy streams can omit the finish chunk. If the first evidence of
      // truncation is the turn end, withdraw only this turn's last source.
      if (matchesTurn && reason === 'max-tokens' && state.lastSeq !== undefined) {
        const key = `${sessionId}:${state.lastSeq}`;
        if (rows.get(key)?.original !== undefined) {
          activeRewrites.get(key)?.abort(Error('source-max-tokens'));
          samples.delete(sessionId);
          skip(sessionId, state.lastSeq, 'source-max-tokens');
        }
      }
      state.lastSeq = undefined;
      if (typeof closing === 'number') {
        const row = rows.get(`${sessionId}:${closing}`);
        if (row !== undefined) {
          row.final = true;
          row.processNote = undefined;
          row.processUsage = undefined;
          touch(sessionId);
        }
      }

      // `report` mode only rewrites the last report of a finished turn.
      if (triggerFor(sessionId) === 'report') {
        const candidate = candidates.get(sessionId);
        candidates.delete(sessionId);
        if (candidate !== undefined && candidate.seq === closing) {
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

    state.sourceIsSubagent = isSubagent(session);
    // A later committed assistant message supersedes the earlier candidate,
    // even when it is interrupted, tool-only, too long or otherwise ineligible.
    candidates.delete(sessionId);
    state.lastSeq = undefined;
    if (event.data?.turn != null) state.turn = event.data.turn;

    // Every settled message carries the route that produced it, so the rewrite
    // follows the conversation's own model without waiting for a request
    // header (those are emitted only on a new series or a config change).
    const source = event.data?.message?.source;
    if (typeof source?.provider === 'string' && typeof source?.model === 'string') {
      state.provider = source.provider;
      state.model = source.model;
    }
    const text = reportText(event, settings.includeToolSteps);
    if (text === undefined) return;

    const process = hasToolCall(event);
    if (!process) state.lastSeq = event.seq;
    if (text.length > cfg.maxRewriteChars) { skip(sessionId, event.seq, 'too-long'); return; }

    // Subagent sessions: a spawned helper's own conversation. Two independent
    // switches, because its mid-task chatter and its final answer are different
    // propositions — the chatter is usually never read, the conclusion often is.
    if (isSubagent(session)) {
      const allowed = process ? settings.subagentSteps === true : settings.subagentReports === true;
      if (!allowed) {
        skip(sessionId, event.seq, process ? 'subagent-step-off' : 'subagent-report-off');
        return;
      }
    }

    if (triggerFor(sessionId) === 'report') {
      if (!process) candidates.set(sessionId, { seq: event.seq, text });
      return;
    }

    enqueue(sessionId, event.seq, text, usage, process);
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'persona-shell.events');
  ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent, frame }) => progress.stream(agent, frame),
    { global: true }), 'persona-shell.progress-stream');
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => progress.status(agent, status),
    { global: true }), 'persona-shell.progress-status');
  // Observe the lifetime, including questions nested inside run_code. Return
  // next() unchanged: this listener supplies no answer and changes no decision.
  ctx.effect(() => ctx.on('user-questions/request', (request, next) => {
    const release = progress.wait(request?.agent);
    try {
      const result = next();
      void Promise.resolve(result).then(release, release);
      return result;
    } catch (error) { release(); throw error; }
  }, { global: true, prepend: true }), 'persona-shell.progress-question-wait');

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
    enabledRestored = false;
    storeState = 'opening';
    for (const id of revisions.keys()) touch(id);

    const task = openStore(ctx).then((opened) => {
      if (storeClosing) {
        // Shutting down: close what arrived and report nothing. The close is part
        // of this task, so the unload chain waits for the domain to be released.
        return (async () => {
          try {
            if (modelUsageRevision > 0) {
              modelUsage.restore(opened.getModelUsage());
              await saveModelUsage(opened);
            }
          } finally { await opened.close(); }
        })().catch((error) => warn('late store flush/close failed', error));
      }
      store = opened;
      storeState = 'open';
      storeError = '';
      modelUsage.restore(opened.getModelUsage());
      scheduleModelUsageSave();
      // Pull in whatever the previous run already wrote.
      for (const sessionId of rows.keys()) {
        const id = sessionId.includes(':') ? sessionId.slice(0, sessionId.indexOf(':')) : sessionId;
        hydrate(id);
      }
      // Adopt the persisted reader profile, keeping anything already observed
      // during the window before storage finished opening.
      const savedProfile = opened.getProfile();
      const clearedBeforeRestore = pendingMemoryClear;
      memories.restore(opened.getMemory(), { clear: clearedBeforeRestore });
      memoryUsage.restore(opened.getMemoryUsage(), { clear: clearedBeforeRestore });
      if (clearedBeforeRestore || opened.getMemoryUsage()) scheduleMemoryUsageSave();
      if (clearedBeforeRestore) {
        profile = emptyProfile();
        pendingMemoryClear = false;
      } else if (savedProfile !== undefined) {
        profile = savedProfile.messages >= profile.messages ? savedProfile : profile;
      }
      if (clearedBeforeRestore || profile.messages > 0) scheduleProfileSave();
      memories.migrate(profile);
      profile = { ...profile, stated: {} };

      // Restore saved presets, keeping every shipped preset first and always
      // present even if the stored copy is missing or corrupt.
      const savedPresets = opened.listPresets();
      const restored = presets.filter((preset) => preset.builtin === true);
      const occupiedNames = new Set([...restored, ...savedPresets].map(p => p?.name));
      /** Old custom-preset id → the shipped preset that now carries its name. */
      const absorbed = new Map();
      for (const raw of savedPresets) {
        if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
        if (restored.some((preset) => preset.id === raw.id)) continue;
        // A name that is shipped now supersedes a custom preset created under it
        // before it became builtin. 大肥龙 was such a preset: the shipped card is
        // its content, so keeping the old row would only duplicate the name.
        const builtin = restored.find((preset) => preset.builtin && preset.name === raw.name);
        // New or renamed builtins can collide with an unrelated user's card. Preserve
        // its ID, conversations, memories and selection; disambiguate only the label.
        if (builtin && !LEGACY_ABSORBED_NAMES.has(builtin.name)) {
          const base = raw.name + ' · 自定义';
          let name = base;
          for (let n = 2; occupiedNames.has(name); n++) name = base + ' ' + n;
          occupiedNames.add(name);
          const custom = { ...raw, name, builtin: false, pack: normalizePack(raw.pack), avatar: restoreAvatar(raw.avatar) };
          restored.push(custom);
          void queuePresetWrite(db => db.putPreset(custom)).catch(error => warn('preset label save failed', error));
          continue;
        }
        if (builtin !== undefined) {
          absorbed.set(raw.id, builtin.id);
          continue;
        }
        restored.push({ ...raw, pack: normalizePack(raw.pack), avatar: restoreAvatar(raw.avatar) });
      }
      presets = restored.slice(0, MAX_PRESETS);
      conversations.restore(opened.getConversations());

      // Restore the selection the user left behind. Without this the active
      // persona lived only in memory and a restart quietly reverted to the
      // default, which is indistinguishable from the switch never having worked.
      const savedActive = opened.getActivePreset();
      if (typeof savedActive === 'string' && savedActive !== '') {
        const activeId = absorbed.get(savedActive) ?? savedActive;
        const active = presets.find((preset) => preset.id === activeId);
        if (active !== undefined) {
          invalidatePersona();
          settings.pack = normalizePack(active.pack);
          settings.presetName = active.name;
        }
      }

      // Restore the durable switches and route. The page reports 「已保存」 for
      // these, so losing them on restart is a promise broken — and re-enabling
      // memory for someone who switched it off is worse than an inconvenience.
      const savedSettings = opened.getSettings();
      if (savedSettings !== null && typeof savedSettings === 'object') {
        if (['step', 'report'].includes(savedSettings.trigger)) settings.trigger = savedSettings.trigger;
        for (const key of ['enabled', 'includeToolSteps', 'memory', 'memoryExtraction', 'reviewHints', 'subagentSteps', 'subagentReports']) {
          if (typeof savedSettings[key] === 'boolean') settings[key] = savedSettings[key];
        }
        if (typeof savedSettings.processToolUsage === 'boolean') settings.processToolUsage = savedSettings.processToolUsage;
        if (Number.isFinite(savedSettings.reviewThreshold)
          && savedSettings.reviewThreshold >= 0 && savedSettings.reviewThreshold <= 1) {
          settings.reviewThreshold = savedSettings.reviewThreshold;
        }
        if (typeof savedSettings.progressNotices === 'boolean') settings.progressNotices = savedSettings.progressNotices;
        if (Number.isInteger(savedSettings.progressMinutes) && savedSettings.progressMinutes >= 1 && savedSettings.progressMinutes <= 60) {
          settings.progressMinutes = savedSettings.progressMinutes;
        }
        for (const key of ['provider', 'model', 'reasoningEffort','chatProvider','chatModel']) {
          if (typeof savedSettings[key] === 'string') settings[key] = savedSettings[key];
        }
        if(typeof savedSettings.chatThinking==='boolean')settings.chatThinking=savedSettings.chatThinking;
      }
      for (const [key, value] of pendingSettings) settings[key] = value;
      if (!settings.memory || !settings.memoryExtraction) memories.discardQueue();
      // The switches are now authoritative; memory collection may resume — but
      // never during shutdown, where nothing should keep publishing state.
      if (!storeClosing) {
        settingsRestored = true;
        enabledRestored = true;
        progressRestored = true;
        toolUsageRestored = true;
      }

      // Per-session overrides. A missing/corrupt record means "all sessions
      // follow the global switch", which is exactly the pre-feature state.
      const savedSwitches = opened.getSessionSwitches();
      const savedValues = savedSwitches !== null && typeof savedSwitches === 'object'
        && savedSwitches.values !== null && typeof savedSwitches.values === 'object'
        ? savedSwitches.values
        : undefined;
      const savedRev = savedSwitches !== null && typeof savedSwitches === 'object'
        && Number.isInteger(savedSwitches.rev) && savedSwitches.rev >= 0
        ? savedSwitches.rev
        : 0;
      if (savedSwitches !== null && typeof savedSwitches === 'object') {
        sessionSwitches.clear();
        if (savedValues !== undefined) {
          for (const [sessionId, value] of Object.entries(savedValues)) {
            if (value === false && typeof sessionId === 'string' && sessionId !== '') {
              sessionSwitches.set(sessionId, false);
            }
          }
        }
      }
      // A toggle made while the storage was still opening must win over the
      // older saved copy; otherwise the open would silently undo the user's
      // click and a restart would lose it.
      let appliedPending = false;
      for (const [sessionId, enabled] of pendingSessionSwitchValues) {
        appliedPending = true;
        if (enabled) sessionSwitches.delete(sessionId);
        else sessionSwitches.set(sessionId, false);
      }
      sessionSwitchRev = Math.max(sessionSwitchRev, savedRev) + (appliedPending ? 1 : 0);
      if (appliedPending) {
        pendingSessionSwitchValues.clear();
        saveSessionSwitches();
      }
      for (const id of sessionSwitches.keys()) memories.discardSession(id);
      if (pendingSettings.size > 0) { pendingSettings.clear(); saveSettings(); }
      // A held /state request may have observed the storage-opening values;
      // wake every known session so the client can leave its loading state.
      for (const id of revisions.keys()) touch(id);
      progress.configure();
      memoryConsolidator.notify();
    }, (error) => {
      storeError = error instanceof Error ? error.message : String(error);
      // Nothing can be restored. The question is what "unknown" should mean, and
      // the safe answer is "do not collect": a missing facility is not evidence
      // that the user never saved `memory:false`, and collecting on a guess breaks
      // a privacy switch. Collection stays off until storage actually reports.
      if (!storeClosing) {
        storeState = 'failed';
        // Storage is unusable, not merely slow: fall back to the config default
        // for rewriting, while memory collection stays off (it is the privacy
        // switch and "unknown" must not read as "on").
        enabledRestored = true;
        warn('storage failed; rewrites are memory-only and memory collection stays off', error);
        for (const id of revisions.keys()) touch(id);
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
    // Reads during storage opening must participate in the later ready notice.
    if (!revisions.has(sessionId)) revisions.set(sessionId, 0);
    // A page that opens an old session asks before any event arrives, so this
    // is where a restart's rows come back.
    if (sessionId !== '') hydrate(sessionId);
    const own = [];
    for (const row of rows.values()) if (row.sessionId === sessionId) own.push(row);
    own.sort((a, b) => a.seq - b.seq);
    return {
      instanceId,
      rev: revisions.get(sessionId) ?? 0,
      settings,
      conversation: sessionId ? conversationState(sessionId) : undefined,
      sessionSwitches: sessionId === '' ? sessionSwitchState() : undefined,
      // The effective value for this session; `sessionEnabled` alone would
      // misreport the global switch as on. The full map arrives in /settings.
      sessionEnabled: settings.enabled === true && enabledRestored && sessionEnabledFor(sessionId),
      switchesReady: enabledRestored,
      rows: own.map((row) => ({
        seq: row.seq,
        status: row.status,
        text: row.text,
        // Streaming text, still masked: the page unmasks it with the table
        // below. Absent once the row settles.
        partial: row.partial === undefined ? '' : row.partial,
        partialLiterals: row.partialLiterals === undefined ? undefined : row.partialLiterals,
        reason: row.reason,
        version: row.version ?? 1,
        speaker: row.speaker,
        retrying: row.retrying === true,
        feedbackError: row.feedbackError,
        canRetry: typeof row.original === 'string' && !!row.speaker && presets.some((p) => p.id === row.speaker.id),
        memories: settings.memory === true && row.speaker ? memories.references(row.memoryRefs,
          { personaId: row.speaker.id, sessionId }).map((e) =>
            ({ id: e.id, version: e.version, content: e.content, scope: e.scope })) : [],
        processNote: row.final !== true && settings.processToolUsage === true && settings.includeToolSteps === true ? row.processNote : undefined,
        processUsage: row.final !== true && settings.processToolUsage === true && settings.includeToolSteps === true ? row.processUsage : undefined,
        distance: row.distance,
        review: row.review,
        // True for the step that closed its turn; the page puts the badge and
        // the 「原文」 toggle on that one only.
        final: row.final === true,
      })),
      // Ephemeral UI state only: deliberately absent from flushPersist().
      progress: progress.notice(sessionId),
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
      stated: memories.select({ personaId: activePresetId(), sessionId: currentSessionHint() }).length,
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
        stateSync: { ...stateStream.stats(),
          client: pickEnum(diagnostics.stateTransport?.status, ['starting', 'ready', 'fallback', 'blocked'], 'unknown') },
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

    if (path === ROUTE + '/model-usage') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
      if (storeClosing || storeState === 'opening') { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      const range = url.searchParams.get('days') ?? '7';
      if (!['1', '7', '30'].includes(range)) { sendJson(res, 400, { error: 'invalid-usage-range' }); return; }
      sendJson(res, 200, { ...modelUsage.report(Number(range)),
        persistence: modelUsageWriteFailed ? 'failed' : store ? 'local' : 'memory-only' });
      return;
    }
    if(path===ROUTE+'/chat/live'&&req.method==='GET'){
      const personaId=url.searchParams.get('persona'),attemptId=url.searchParams.get('attempt');
      const multiplex=url.searchParams.get('batch')==='1',requestedRoom=url.searchParams.get('room');
      if(multiplex?!requestedRoom||requestedRoom.length>160:!personaId||personaId.length>160||!attemptId||attemptId.length>160){sendJson(res,400,{error:'invalid-chat-stream'});return;}
      if(typeof res.write!=='function'){sendJson(res,503,{error:'chat-stream-unavailable'});return;}
      const abort=new AbortController(),closed=()=>abort.abort();res.once?.('close',closed);req.once?.('aborted',closed);
      chatStreamControllers.add(abort);
      try{
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'private, no-cache, no-transform','x-accel-buffering':'no'});res.flushHeaders?.();
        const roomId=requestedRoom??chats.read(personaId)?.id??personaId;
        for await(const frame of chatLive.observe(multiplex?roomId:chatJobKey(roomId,attemptId),abort.signal)){
          if(abort.signal.aborted||res.destroyed)break;
          const value=multiplex?frame??{instanceId,roomId,status:'closed',frames:[]}
            :frame?.attemptId===attemptId&&frame.personaId===personaId?frame:{instanceId,personaId,roomId,attemptId,status:'closed',messages:[]};
          if(!res.write('data:'+JSON.stringify(value)+'\n\n')){
            let drain;try{await waitWithSignal(new Promise(resolve=>{drain=resolve;res.once('drain',drain);}),abort.signal);}finally{res.off?.('drain',drain);}
          }
          if(!['streaming','queued'].includes(value.status))break;
        }
      }catch{/* Disconnected clients continue with the canonical snapshot on reopening. */}
      finally{abort.abort();chatStreamControllers.delete(abort);res.off?.('close',closed);req.off?.('aborted',closed);if(!res.writableEnded&&!res.destroyed)res.end();}
      return;
    }
    if (path === ROUTE + '/chat-context' && (req.method === 'POST' || req.method === 'GET')) {
      if (!settingsRestored || !store || storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      let body, source=chatContext, roomId;
      try {
        if (req.method === 'GET') {
          roomId=url.searchParams.get('room')||undefined;source=contextForRoom(roomId);
          if (!source?.snapshot().initialized) throw Error('context-not-open');
          if (source.presence(url.searchParams.get('viewer'), true, Number(url.searchParams.get('sequence')))) await source.refresh();
          sendJson(res, 200, chatContextState(source,roomId)); return;
        }
        let raw=''; for await (const piece of req) { raw+=piece; if (raw.length>4096) throw Error('invalid-context-request'); }
        body=JSON.parse(raw);
        if (!body || typeof body!=='object' || Array.isArray(body)) throw Error('invalid-context-request');
        if(body.action==='open'){ensureChatRecords();ensureChatProfile();}
        // A close can arrive before the open it supersedes; retain its sequence
        // without opening the room's references or reading their contents.
        roomId=body.roomId;source=contextForRoom(roomId,body.action==='open'||(body.action==='presence'&&body.visible===false));
        if(!source)throw Error('context-not-open');
        if (body.action==='open' || body.action==='presence') {
          if (!source.presence(body.viewer, body.visible !== false, body.sequence) || body.visible === false) {
            sendJson(res,200,chatContextState(source,roomId)); return;
          }
          if (body.action==='open') {
            const room=roomId?chats.read(roomId):null;
            await source.open({sessionId:body.sessionId,selection:room?.sources?{sessionIds:room.sources,primarySessionId:room.primarySessionId}:undefined});
          }
        } else {
          if (!source.active()) throw Error('context-not-open');
          if (['attach','detach'].includes(body.action) && body.revision!==source.snapshot().revision) throw Error('chat-context-changed');
          if (body.action==='attach') await source.attach(body.sessionId,body.primary===true);
          else if (body.action==='detach') source.detach(body.sessionId);
          else if (body.action==='sessions') { sendJson(res,200,{roomId,items:await source.sessions(body.projectId)});return; }
          else if (body.action==='dismiss') source.dismiss(body.noticeId);
          else if (body.action==='refresh') await source.refresh(true);
          else if (body.action==='focus') source.touch(body.sessionId,'view',body.viewer);
          else throw Error('invalid-context-action');
          for (const pending of activeChats.values()) if ((roomId?pending.roomId===roomId:!roomContexts.has(pending.roomId)) && pending.contextKey && pending.contextKey!==source.key()) pending.abort.abort(Error('chat-context-changed'));
          for(const round of chatRounds.values())if((roomId?round.roomId===roomId:!roomContexts.has(round.roomId))&&round.contextKey&&round.contextKey!==source.key())round.abort.abort(Error('chat-context-changed'));
          for (const pending of activeSuggestions.values()) if ((roomId?pending.roomId===roomId:!roomContexts.has(pending.roomId)) && pending.contextKey && pending.contextKey!==source.key()) pending.abort.abort(Error('suggestions-context-changed'));
        }
        if(roomId && ['open','attach','detach','refresh'].includes(body.action)){
          const value=source.snapshot(),sessionIds=value.sources.map(s=>s.sessionId),room=chats.read(roomId);
          if(JSON.stringify(room?.sources)!==JSON.stringify(sessionIds)||room?.primarySessionId!==value.primarySessionId)
            await chats.sources({roomId,sessionIds,primarySessionId:value.primarySessionId});
        }
        sendJson(res,200,chatContextState(source,roomId));
      } catch (error) {
        const known=/^(context-|invalid-context-|chat-context-)/.test(error.message??'');
        const invalid=error instanceof SyntaxError || /^invalid-context-/.test(error.message??'');
        sendJson(res,error.message==='chat-room-not-found'?404:invalid?400:known?409:503,
          {error:error.message==='chat-room-not-found'?error.message:invalid?'invalid-context-request':known?error.message:'context-unavailable',state:chatContextState(source,roomId)});
      }
      return;
    }
    if (path === ROUTE + '/chat-profile' && req.method === 'GET') { sendJson(res, 200, publicChatProfile()); return; }
    if (path === ROUTE + '/chat-profile' && req.method === 'POST') {
      if (!settingsRestored || !store || storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      ensureChatProfile();
      let raw = '';
      for await (const piece of req) { raw += piece; if (raw.length > 560 * 1024) { sendJson(res, 413, { error: 'too-large' }); return; } }
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-profile');
        await chatProfile.update(body);
        if (!storeClosing) sendJson(res, 200, publicChatProfile());
        else sendJson(res, 503, { error: 'storage-not-ready' });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        sendJson(res, reason === 'profile-conflict' ? 409 : /^invalid-/.test(reason) ? 400 : 503,
          { error: reason === 'profile-conflict' ? reason : reason.startsWith('invalid-') ? reason : 'profile-save-failed', state: publicChatProfile() });
      }
      return;
    }
    if (path === ROUTE + '/chat-profile/avatar' && req.method === 'GET') {
      ensureChatProfile();
      const content = avatarContent(chatProfile.read().avatar);
      if (!content) { sendJson(res, 404, { error: 'avatar-not-found' }); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': content.data.length,
        'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(content.data); return;
    }
    if (path.startsWith(ROUTE + '/avatar/') && req.method === 'GET') {
      let id;
      try { id = decodeURIComponent(path.slice((ROUTE + '/avatar/').length)); } catch { sendJson(res, 404, { error: 'avatar-not-found' }); return; }
      const content = avatarContent(presets.find((p) => p.id === id)?.avatar);
      if (!content) { sendJson(res, 404, { error: 'avatar-not-found' }); return; }
      try {
        const data = content.data ?? await readFile(content.file);
        res.writeHead(200, { 'content-type': content.type, 'content-length': data.length,
          'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
        res.end(data);
      } catch { sendJson(res, 404, { error: 'avatar-not-found' }); }
      return;
    }

    if (path === `${ROUTE}/progress-view` && req.method === 'POST') {
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 2048) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      if (!body || typeof body.viewer !== 'string' || !body.viewer || body.viewer.length > 100
        || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.visible !== 'boolean'
        || (body.visible && (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200))) {
        sendJson(res, 400, { error: 'invalid viewer' }); return;
      }
      progress.viewer(body.viewer, body.visible ? body.sessionId : undefined, body.revision);
      sendJson(res, 200, { ok: true }); return;
    }

    if (path === `${ROUTE}/state`) {
      const sessionId = url.searchParams.get('session') ?? '';
      if (sessionId === '') { sendJson(res, 400, { error: 'session required' }); return; }
      if (url.searchParams.get('viewing') === '1' && sessionId.length <= 200) {
        const viewer = url.searchParams.get('viewer');
        const rawViewRev = url.searchParams.get('viewRev');
        const viewRev = rawViewRev === null ? undefined : Number(rawViewRev);
        if (typeof viewer === 'string' && viewer !== '' && viewer.length <= 100
          && Number.isSafeInteger(viewRev) && viewRev >= 0) {
          progress.viewer(viewer, sessionId, viewRev);
        }
      }
      // Long-poll: the page asks with the revision it already has and a wait
      // budget. If nothing moved, hold the request until `touch()` wakes it or
      // the budget expires, then answer with the current state either way.
      // This preserves the existing route shape (a GET returning one JSON
      // document) and works through the Desktop IPC fetch carrier, where an
      // EventSource would not.
      const sinceParam = url.searchParams.get('rev');
      const waitParam = url.searchParams.get('wait');
      const since = sinceParam === null ? undefined : Number(sinceParam);
      const wait = waitParam === null ? 0 : Number(waitParam);
      if (Number.isInteger(since) && Number.isFinite(wait) && wait > 0) {
        const current = revisions.get(sessionId) ?? 0;
        if (since === current) await waitForStateChange(sessionId, Math.min(wait, 30000), req, res);
        if (storeClosing || res.writableEnded === true || res.destroyed === true) return;
      }
      sendJson(res, 200, stateFor(sessionId));
      return;
    }

    // One session's own switch. Global `enabled` remains the master: a session
    // can turn the persona off, not on while the plugin is globally off.
    if (path === `${ROUTE}/session-switch` && req.method === 'POST') {
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 4 * 1024) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      let body;
      try { body = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const rawSessionId = body !== null && typeof body === 'object' && typeof body.sessionId === 'string'
        ? body.sessionId.trim()
        : '';
      if (rawSessionId === '') { sendJson(res, 400, { error: 'session id required' }); return; }
      if (rawSessionId.length > 200) { sendJson(res, 400, { error: 'session id too long' }); return; }
      const sessionId = rawSessionId;
      if (body === null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be a boolean' });
        return;
      }
      if (body.enabled) sessionSwitches.delete(sessionId);
      else {
        if (!sessionSwitches.has(sessionId) && sessionSwitches.size >= MAX_SESSION_SWITCHES) {
          const oldest = sessionSwitches.keys().next().value;
          if (oldest !== undefined) sessionSwitches.delete(oldest);
        }
        sessionSwitches.set(sessionId, false);
      }
      sessionSwitchRev += 1;
      if (store === undefined || !settingsRestored) {
        // Storage may not have delivered the saved map yet; replay this toggle
        // on top of it when it does, instead of losing it to the older copy.
        pendingSessionSwitchValues.set(sessionId, body.enabled);
      }
      if (body.enabled === false) {
        memoryConsolidator.cancel();
        if (settingsRestored) memories.discardSession(sessionId);
        // Stop spending tokens on a session the user just turned off. The
        // abort is observed by the stream loop and settles the row skipped.
        for (const [key, controller] of activeRewrites) {
          if (key.startsWith(`${sessionId}:`)) controller.abort(new Error('session-off'));
        }
        // In-flight turn facts belong to the disabled stretch; a later turn
        // starts them again. Rows already written stay, so re-enabling restores
        // the history the reader had.
        turnState.delete(sessionId);
        candidates.delete(sessionId);
        toolUsage.clear(sessionId);
      }
      progress.configure(sessionId);
      saveSessionSwitches();
      touch(sessionId);
      touch('');
      memoryConsolidator.notify();
      sendJson(res, 200, {
        ok: true,
        sessionId,
        sessionEnabled: body.enabled === true && settings.enabled === true && enabledRestored,
        sessionSwitches: sessionSwitchState(),
      });
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
          lines: readerMemoryLines(),
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

    if (path === ROUTE + '/memory' && req.method === 'GET') {
      sendJson(res, 200, memoryState()); return;
    }

    if(path===ROUTE+'/chat-rooms'&&req.method==='POST'){
      if(!settingsRestored||!store||storeClosing){sendJson(res,503,{error:'storage-not-ready'});return;}
      ensureChatRecords();let body;
      try{
        let raw='';for await(const part of req){raw+=part;if(raw.length>12000)throw Error('invalid-chat-room');}body=JSON.parse(raw);
        const before=chats.read(body.roomId);let selected=body.roomId;
        if(body.action==='ensure-first' || body.action==='create'){
          if(body.epoch!==chats.epoch())throw Error('chat-conflict');
          if(!Array.isArray(body.memberIds)||body.memberIds.some(id=>!presets.some(p=>p.id===id)))throw Error('persona-not-found');
          const room=await chats.create(body,{onlyIfEmpty:body.action==='ensure-first'});selected=room.id;
        }else if(body.action==='select')await chats.select(body);
        else if(body.action==='update'){
          if(!before)throw Error('chat-room-not-found');
          if(body.memberIds!==undefined&&(!Array.isArray(body.memberIds)||body.memberIds.some(id=>!before.memberIds.includes(id)&&!presets.some(p=>p.id===id))))throw Error('persona-not-found');
          if(body.targetPersonaId!==undefined&&!presets.some(p=>p.id===body.targetPersonaId))throw Error('persona-not-found');
          if(body.targetPersonaIds!==undefined&&(!Array.isArray(body.targetPersonaIds)||body.targetPersonaIds.some(id=>!presets.some(p=>p.id===id))))throw Error('persona-not-found');
          const room=await chats.update(body);
          for(const pending of chatJobsFor(room.id))if(!room.memberIds.includes(pending.personaId))pending.abort.abort(Error('chat-member-removed'));
          activeSuggestions.get(room.id)?.abort.abort(Error('suggestions-context-changed'));
        }else if(body.action==='delete'){
          await chats.remove(body);chatRounds.get(body.roomId)?.abort.abort(Error('chat-cleared'));for(const pending of chatJobsFor(body.roomId))pending.abort.abort(Error('chat-cleared'));
          activeSuggestions.get(body.roomId)?.abort.abort(Error('chat-cleared'));
          roomContexts.get(body.roomId)?.dispose();roomContexts.delete(body.roomId);chatLive.clearRoom(body.roomId);selected=chats.active();
        }else throw Error('invalid-chat-room-action');
        sendJson(res,200,chatState(selected));
      }catch(error){const code=error instanceof SyntaxError?'invalid-chat-room':error.message;
        sendJson(res,code==='chat-room-not-found'?404:code?.includes('conflict')?409:/^(invalid-|chat-|persona-)/.test(code??'')?400:503,
          {error:/^(invalid-|chat-|persona-)/.test(code??'')?code:'chat-save-failed',state:chatState(body?.roomId??chats.active())});}
      return;
    }
    if (path === ROUTE + '/chat' && req.method === 'GET') {
      ensureChatRecords();
      const sessionId = url.searchParams.get('session');
      if (sessionId !== null && (!sessionId.trim() || sessionId.length > 200)) { sendJson(res, 400, { error: 'invalid-session' }); return; }
      const reportPersonaId = sessionId ? personaFor(sessionId).id : activePresetId();
      const explicitRoom=url.searchParams.get('room'),legacyPersona=url.searchParams.get('persona');
      const id = explicitRoom || legacyPersona || chats.active() || reportPersonaId;
      if (explicitRoom&&!chats.read(id)) {sendJson(res,404,{error:'chat-room-not-found'});return;}
      if (legacyPersona&&!presets.some((p) => p.id === id) && !chats.read(id)) { sendJson(res, 404, { error: 'persona-not-found' }); return; }
      sendJson(res, 200, { ...chatState(id), reportPersonaId }); return;
    }
    if (path === ROUTE + '/chat/suggestions' && req.method === 'POST') {
      if (!settingsRestored || !store || storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      ensureChatRecords();
      let raw = '';
      for await (const piece of req) { raw += piece; if (raw.length > 24000) { sendJson(res, 413, { error: 'too-large' }); return; } }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const persona = presets.find((p) => p.id === body?.personaId);
      const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
      if (!persona || instruction.length > 4000) { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const room = chats.read(body.roomId??persona.id);
      if(body.roomId&&(!room||!room.memberIds.includes(persona.id)||room.targetPersonaId!==persona.id)){
        sendJson(res,409,{error:'suggestions-context-changed'});return;
      }
      const sourceContext=roomContexts.get(room?.id)??chatContext;
      const contextKey=body.contextKey??null;
      if (contextKey && (!sourceContext.active() || contextKey!==sourceContext.key())) {sendJson(res,409,{error:'suggestions-context-changed'});return;}
      const epoch = body.epoch ?? 0;
      if (!chats.acceptsEpoch(room?.id, epoch) || (room?.id ?? null) !== body.roomId || (room?.revision ?? 0) !== body.revision) {
        sendJson(res, 409, { error: 'suggestions-context-changed' }); return;
      }
      let suggestionScope=contextKey;
      if(body.roomId&&(roomContexts.has(body.roomId)||!room?.legacyPersonaId)){try{suggestionScope=capturedRoomContext(body.roomId,contextKey).scopeKey;}catch{
        sendJson(res,409,{error:'suggestions-context-changed'});return;}}
      const suggestionHistory=(room?.turns??[]).filter(t=>(t.scopeKey??t.contextKey??null)===suggestionScope);
      if (!instruction.trim() && !suggestionHistory.length) { sendJson(res, 400, { error: 'suggestions-no-context' }); return; }
      const suggestionKey=room?.id??persona.id;
      activeSuggestions.get(suggestionKey)?.abort.abort(new Error('superseded'));
      const abort = new AbortController();
      const chatOptions={provider:settings.chatProvider,model:settings.chatModel,thinking:settings.chatThinking};
      const pending = { personaId: persona.id,roomId:room?.id, pack: persona.pack, abort, contextKey };
      activeSuggestions.set(suggestionKey, pending);
      const closed = () => { if (!res.writableEnded) abort.abort(new Error('disconnected')); };
      res.once?.('close', closed);
      const timer = setTimeout(() => abort.abort(new Error('suggestions-timeout')), Math.min(cfg.timeoutMs, 20000));
      const current = () => !storeClosing && chats.acceptsEpoch(room?.id, epoch) && presets.find((p) => p.id === persona.id)?.pack === persona.pack
        && (!contextKey || sourceContext.key()===contextKey)
        && (chats.read(body.roomId??persona.id)?.id ?? null) === body.roomId && (chats.read(body.roomId??persona.id)?.revision ?? 0) === body.revision;
      try {
        const suggestions = await trackModelTask((async () => {
          const route = await waitWithSignal(resolveChatRouteAsync(contextKey?sourceContext.snapshot().primarySessionId:currentSessionHint(),chatOptions), abort.signal);
          const llm = expressionLlm('reply-suggestions', () => {
            if (!current()) throw new Error('suggestions-context-changed');
          },chatOptions);
          if (!route || !llm || !current()) throw new Error('suggestions-unavailable');
          const { system, user } = buildReplySuggestions({ name:room?.targetPersonaIds.map(id=>presets.find(p=>p.id===id)?.name??id).join('、')??persona.name, history: suggestionHistory, instruction });
          let wire = '', finish;
          for await (const chunk of streamWithSignal(llm, { provider: route.provider, model: route.model, system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 768, signal: abort.signal })) {
            if (chunk.type === 'error' || chunk.type.startsWith('tool-call')
              || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
              || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) throw new Error('suggestions-invalid');
            if (chunk.type === 'text-delta') wire += chunk.text;
            if (wire.length > 4096) throw new Error('suggestions-too-long');
            if (chunk.type === 'finish') finish = chunk.reason?.kind;
          }
          abort.signal.throwIfAborted();
          const result = finish === 'stop' ? parseReplySuggestions(wire) : undefined;
          if (!result || !current()) throw new Error('suggestions-context-changed');
          return result;
        })());
        abort.signal.throwIfAborted();
        if (!current()) throw new Error('suggestions-context-changed');
        if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { personaId: persona.id, roomId: body.roomId, revision: body.revision, suggestions });
      } catch {
        if (!res.destroyed && !res.writableEnded) sendJson(res, current() ? 422 : 409,
          { error: current() ? 'suggestions-failed' : 'suggestions-context-changed' });
      } finally {
        clearTimeout(timer); res.removeListener?.('close', closed); abort.abort();
        if (activeSuggestions.get(suggestionKey) === pending) activeSuggestions.delete(suggestionKey);
      }
      return;
    }
    if (path === ROUTE + '/chat' && req.method === 'POST') {
      if (!settingsRestored || !store || storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      ensureChatRecords();
      let raw = '';
      for await (const piece of req) { raw += piece; if (raw.length > 24000) { sendJson(res, 413, { error: 'too-large' }); return; } }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const id = body?.personaId;
      if (typeof id !== 'string' || !id || id.length > 160) { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const selectedRoom=chats.read(body.roomId??id),roomKey=selectedRoom?.id??id;
      if(body.roomId&&!selectedRoom){sendJson(res,404,{error:'chat-room-not-found'});return;}
      const recipientId=body.action==='retry'&&body.roomId?selectedRoom.turns.find(t=>t.id===body.id)?.recipientId:id;
      const persona = presets.find((p) => p.id === recipientId);
      try {
        if (body.action === 'send' || body.action === 'retry') {
          if (!persona) { sendJson(res, 400, { error: 'persona-not-found' }); return; }
          if (chatStarting.has(roomKey)) { sendJson(res, 409, { error: 'chat-busy', state: chatState(body.roomId??id) }); return; }
          const previousRound=chatRounds.get(roomKey);
          if(body.action==='retry'&&previousRound&&!previousRound.abort.signal.aborted&&previousRound.stage==='listening')throw Error('chat-busy');
          // launchChatRound supersedes the old judgement only after the new message is durable.
          const allowOrphan = !chatJobsFor(roomKey).some(job=>!job.abort.signal.aborted);
          chatStarting.add(roomKey);
          let result;
          try {
            const sourceContext=body.roomId?contextForRoom(body.roomId):chatContext;
            if(body.roomId&&(!sourceContext||!body.contextKey))throw Error('context-not-open');
            if(body.contextKey)await sourceContext.prepareCapture(body.contextKey);
            const workContext=body.roomId?capturedRoomContext(body.roomId,body.contextKey):body.contextKey ? sourceContext.capture(body.contextKey) : undefined;
            const contextKey=workContext?.key??null;
            const scopeKey=workContext?.scopeKey??contextKey;
            const targetIds=body.recipientIds??selectedRoom?.targetPersonaIds??[persona.id];
            if(body.action==='send'&&(!Array.isArray(targetIds)||targetIds.some(target=>!presets.some(p=>p.id===target))))throw Error('invalid-chat-message');
            result = body.action === 'send' ? await chats.send({ ...body,personaId:persona.id,recipients:targetIds.map(id=>({id,name:presets.find(p=>p.id===id).name})), contextKey,scopeKey, name: persona.name, allowOrphan })
              : await chats.retry({ ...body,personaId:persona.id, contextKey,scopeKey, name: persona.name, allowOrphan });
            if (workContext?.primarySessionId) sourceContext.touch(workContext.primarySessionId,'message');
            if (!storeClosing && result.created)launchChatRound(result,workContext);
          } finally { chatStarting.delete(roomKey); }
        } else if (body.action === 'cancel') {
          const round=chatRounds.get(roomKey);
          if(body.roundId&&round?.id===body.roundId&&round.messageId===body.messageId&&chats.acceptsEpoch(roomKey,body.epoch))round.abort.abort(Error('chat-cancelled'));
          const cancelled = body.attempts?.length===0&&body.roundId?false:await chats.cancel(body);
          if(cancelled&&round&&(body.messageId===undefined||round.messageId===body.messageId)
            &&(body.attempts?body.attempts.some(p=>round.attempts.has(p.attemptId)):round.attempts.has(body.attemptId)))round.abort.abort(Error('chat-cancelled'));
          if(cancelled)for(const pending of chatJobsFor(roomKey))if(body.attempts?body.attempts.some(p=>p.id===pending.turnId&&p.attemptId===pending.attemptId)
            :body.messageId?pending.messageId===body.messageId:pending.attemptId===body.attemptId)pending.abort.abort(new Error('chat-cancelled'));
        } else if (body.action === 'clear') {
          const pending = chatJobsFor(roomKey);
          const suggestions = activeSuggestions.get(roomKey);
          if (await chats.clear(body)) { chatRounds.get(roomKey)?.abort.abort(Error('chat-cleared'));for(const job of pending)job.abort.abort(new Error('chat-cleared')); suggestions?.abort.abort(new Error('chat-cleared'));chatLive.clearRoom(roomKey); }
        } else { sendJson(res, 400, { error: 'invalid-chat-action' }); return; }
        if (storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
        sendJson(res, 200, chatState(body.roomId??id));
      } catch (error) {
        const reason = error?.message ?? 'chat-save-failed';
        const known = /^(invalid-chat|chat-|context-not-open)/.test(reason);
        sendJson(res, /conflict|busy|context-changed|context-unsaved|context-not-open/.test(reason) ? 409 : known ? 400 : 503,
          { error: known ? reason : 'chat-save-failed', state: chatState(body.roomId??id) });
      }
      return;
    }

    if (path === ROUTE + '/conversation' && req.method === 'GET') {
      const id = url.searchParams.get('session');
      if (!id || id.length > 200) { sendJson(res, 400, { error: 'invalid-session' }); return; }
      sendJson(res, 200, conversationState(id)); return;
    }
    if ([ROUTE + '/conversation', ROUTE + '/feedback'].includes(path) && req.method === 'POST') {
      if (!settingsRestored || !store || storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      let raw = '';
      for await (const piece of req) { raw += piece; if (raw.length > 8192) { sendJson(res, 413, { error: 'too large' }); return; } }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const sessionId = body?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) {
        sendJson(res, 400, { error: 'invalid-session' }); return;
      }
      if (path === ROUTE + '/conversation') {
        hydrate(sessionId);
        const latest = Math.max(latestSourceSeq.get(sessionId) ?? -1,
          ...[...rows.values()].filter((r) => r.sessionId === sessionId).map((r) => r.seq));
        try {
          await conversations.update(sessionId, body, { knownPersona: (id) => presets.some((p) => p.id === id),
            currentPersonaId: () => personaFor(sessionId).id, latestSeq: latest });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'conversation-save-failed';
          sendJson(res, reason.includes('conflict') || reason === 'relay-already-pending' ? 409
            : ['invalid-session', 'invalid-trigger', 'persona-not-found', 'relay-same-persona', 'invalid-conversation-action'].includes(reason) ? 400 : 503,
          { error: reason, conversation: conversationState(sessionId) }); return;
        }
        conversationErrors.delete(sessionId);
        touch(sessionId);
        sendJson(res, 200, conversationState(sessionId)); return;
      }
      hydrate(sessionId);
      const row = rows.get(`${sessionId}:${body.seq}`);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!row || row.status !== 'ready' || row.version !== body.version || row.speaker?.id !== body.personaId) {
        sendJson(res, 409, { error: 'report-conflict' }); return;
      }
      if (!content || content.length > 240 || !['once', 'persona', 'session', 'shared'].includes(body.scope)) {
        sendJson(res, 400, { error: 'invalid-feedback' }); return;
      }
      const speaker = presets.find((p) => p.id === row.speaker.id);
      if (!speaker) { sendJson(res, 400, { error: 'persona-not-found' }); return; }
      if (body.scope !== 'once') {
        if (!settings.memory) { sendJson(res, 400, { error: 'memory-disabled' }); return; }
        let entry;
        try {
          memoryConsolidator.cancel();
          entry = await saveMemoryMutation({ action: 'add', entry: { kind: 'preference', content, scope: body.scope,
            personaId: body.scope === 'persona' ? speaker.id : null, sessionId: body.scope === 'session' ? sessionId : null } },
          { requireEnabled: true });
        } catch (error) {
          memoryConsolidator.notify();
          sendJson(res, error?.message === 'memory-conflict' ? 409 : 503,
            { error: ['memory-capacity', 'memory-conflict'].includes(error?.message) ? error.message : 'memory-save-failed' }); return;
        }
        memoryConsolidator.notify(); touch(sessionId);
        sendJson(res, 200, { ok: true, entry }); return;
      }
      if (!rewriteAllowedFor(sessionId)) { sendJson(res, 400, { error: 'rewrite-disabled' }); return; }
      if (!row.original) { sendJson(res, 400, { error: 'source-unavailable' }); return; }
      if (row.retrying || inFlight.has(`${sessionId}:${body.seq}`)) { sendJson(res, 409, { error: 'feedback-in-progress' }); return; }
      row.retrying = true; row.feedbackError = undefined; touch(sessionId);
      const draft = { ...row, status: 'pending', partial: '', processNote: undefined, processUsage: undefined };
      const retryRevision = revisionFor(sessionId);
      await trackModelTask(rewrite({ sessionId, seq: body.seq, text: row.original, rowOverride: draft, packOverride: speaker, feedback: content }));
      row.retrying = false;
      if (storeClosing) { sendJson(res, 503, { error: 'disposed' }); return; }
      if (rows.get(`${sessionId}:${body.seq}`) !== row || row.version !== body.version) {
        sendJson(res, 409, { error: 'report-conflict' }); return;
      }
      if (draft.status !== 'ready' || retryRevision !== revisionFor(sessionId)
        || presets.find((p) => p.id === speaker.id)?.pack !== speaker.pack) {
        row.feedbackError = '这次调整没有完成，已保留原来的汇报。'; touch(sessionId);
        sendJson(res, 422, { error: 'feedback-rewrite-failed' }); return;
      }
      Object.assign(row, draft, { final: row.final, version: row.version + 1, retrying: false, feedbackError: undefined });
      samples.delete(sessionId); touch(sessionId);
      sendJson(res, 200, { ok: true }); return;
    }
    if (path === ROUTE + '/memory/handoffs' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session');
      const personaId = url.searchParams.get('persona');
      if (!sessionId || !personaId) { sendJson(res, 400, { error: 'session-and-persona-required' }); return; }
      sendJson(res, 200, { handoffs: memories.snapshot().handoffs.filter((h) =>
        h.sessionId === sessionId && h.toPersonaId === personaId).map((h) => ({
          ...h, ...memories.handoffContext(h.id, { sessionId, personaId }),
        })) });
      return;
    }
    if ([ROUTE + '/memory', ROUTE + '/memory/handoffs'].includes(path) && req.method === 'POST') {
      if (!settingsRestored || !store || storeClosing) {
        sendJson(res, 503, { error: 'storage-not-ready' }); return;
      }
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 32768) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'invalid-memory-action' }); return;
      }
      if (body.action === 'consolidate' && path === ROUTE + '/memory') {
        if (!settings.memory || !settings.memoryExtraction || !settings.enabled) {
          sendJson(res, 400, { error: 'memory-extraction-disabled' }); return;
        }
        void memoryConsolidator.start();
        sendJson(res, 200, memoryState()); return;
      }
      let result;
      try {
        const personaIds = [body.entry?.personaId, body.personaId, body.fromPersonaId, body.toPersonaId].filter(Boolean);
        if (personaIds.some((id) => !presets.some((preset) => preset.id === id))) throw new Error('persona-not-found');
        memoryConsolidator.cancel();
        result = await saveMemoryMutation(body, { handoff: path === ROUTE + '/memory/handoffs' });
      } catch (error) {
        memoryConsolidator.notify();
        const reason = error instanceof Error ? error.message : 'invalid-memory-action';
        const known = /^(?:invalid-|memory-|private-|persona-|session-|unproven-)/.test(reason);
        sendJson(res, reason.endsWith('-conflict') ? 409 : known ? 400 : 503,
          { error: known ? reason : 'memory-save-failed' }); return;
      }
      memoryConsolidator.notify();
      sendJson(res, 200, { ...memoryState(), result });
      return;
    }

    if (path === `${ROUTE}/presets` && req.method === 'POST') {
      let raw = '';
      for await (const piece of req) {
        raw += piece;
        if (raw.length > 560 * 1024) { sendJson(res, 413, { error: 'too large' }); return; }
      }
      let body;
      try { body = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const action = body?.action;
      if (presetChanging && action !== 'generate') { sendJson(res, 409, { error: 'preset-change-pending' }); return; }
      if (storeState === 'opening' && action !== 'generate') {
        sendJson(res, 503, { error: 'storage-not-ready' }); return;
      }
      if (action !== 'generate' && storeClosing) {
        sendJson(res, 503, { error: 'storage-not-ready' }); return;
      }
      if (action !== 'generate') presetChanging = true;
      try {

      if (action === 'avatar') {
        if (!settingsRestored || !store || storeClosing) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
        const target = presets.find((p) => p.id === body.id);
        if (!target) { sendJson(res, 404, { error: 'preset not found' }); return; }
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) {
          sendJson(res, 400, { error: 'invalid-avatar-request' }); return;
        }
        let avatar;
        try {
          if (!Object.hasOwn(body, 'avatar')) throw new Error('invalid-avatar');
          avatar = normalizeAvatar(body.avatar);
        } catch { sendJson(res, 400, { error: 'invalid-avatar' }); return; }
        const duplicate = target.builtin ? presets.find((p) => p.id === 'preset-avatar-' + body.requestId) : undefined;
        if (duplicate && (duplicate.avatarParentId !== target.id || duplicate.avatar !== avatar)) {
          sendJson(res, 409, { error: 'avatar-conflict' }); return;
        }
        if (duplicate || target.avatar === avatar || (!target.avatar && !avatar)) {
          sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings }); return;
        }
        if (body.expectedAvatar !== (avatarUrl(target) ?? null)) { sendJson(res, 409, { error: 'avatar-conflict' }); return; }
        if (target.builtin && presets.length >= MAX_PRESETS) { sendJson(res, 400, { error: 'too many presets' }); return; }
        let name = target.name;
        if (target.builtin) {
          const base = target.name + ' · 我的版本'; name = base;
          for (let suffix = 2; presets.some((p) => p.name === name); suffix++) name = base + ' ' + suffix;
        }
        const entry = { ...target, id: target.builtin ? 'preset-avatar-' + body.requestId : target.id,
          name, avatar, builtin: false, at: Date.now(), ...(target.builtin ? { avatarParentId: target.id } : {}) };
        try {
          await commitPresetChange({ entry, ...(target.builtin ? { activeId: entry.id } : {}) });
          if (target.builtin) {
            presets = [...presets, entry];
            invalidatePersona('persona-changed', (id) => !conversations.read(id).personaId);
            settings.presetName = entry.name; settings.pack = entry.pack;
            progress.configure();
          } else presets = presets.map((p) => p.id === entry.id ? entry : p);
          for (const id of revisions.keys()) touch(id);
          sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings });
        } catch { sendJson(res, 503, { error: 'avatar-save-failed' }); }
        return;
      }

      // --- generate from a persona prompt -----------------------------------
      if (action === 'generate') {
        const personaPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (personaPrompt.length < 20) { sendJson(res, 400, { error: 'prompt too short' }); return; }
        if (personaPrompt.length > 24000) { sendJson(res, 400, { error: 'prompt too long' }); return; }
        const result = await trackModelTask(extractPreset(personaPrompt, currentSessionHint()));
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
          id: existing?.id ?? `preset-${randomUUID()}`,
          name,
          pack: normalizePack(body.pack),
          avatar: existing?.avatar ?? null,
          ...(existing?.avatarParentId ? { avatarParentId: existing.avatarParentId } : {}),
          source: typeof body.source === 'string' ? body.source.slice(0, 24000) : (existing?.source ?? ''),
          builtin: false,
          at: Date.now(),
        };
        if (existing === undefined && presets.length >= MAX_PRESETS) { sendJson(res, 400, { error: 'too many presets' }); return; }
        await commitPresetChange({ entry, activeId: entry.id });
        if (existing === undefined) {
          presets = [...presets, entry];
        } else {
          presets = presets.map((preset) => (preset.id === entry.id ? entry : preset));
        }
        invalidatePersona('persona-changed', (id) => !conversations.read(id).personaId
          || personaFor(id).id === entry.id, entry.id);
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
        await commitPresetChange({ entry: renamed });
        presets = presets.map((preset) => (preset.id === id ? renamed : preset));
        // `presetName` is the display label, so an active rename has to move with
        // it; the stored pointer is an id and does not change.
        if (settings.presetName === target.name) {
          settings.presetName = name;
        }
        for (const id of revisions.keys()) touch(id);
        sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings });
        return;
      }

      // --- apply -----------------------------------------------------------
      if (action === 'apply') {
        const id = typeof body.id === 'string' ? body.id : '';
        const target = presets.find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        await commitPresetChange({ activeId: target.id });
        invalidatePersona('persona-changed', (sid) => !conversations.read(sid).personaId
          || !presets.some((p) => p.id === conversations.read(sid).personaId));
        settings.pack = normalizePack(target.pack);
        settings.presetName = target.name;
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
        await commitPresetChange({ removeId: id, ...(settings.presetName === target.name ? { activeId: presets[0].id } : {}) });
        invalidatePersona('persona-deleted', (sid) => personaFor(sid).id === target.id, target.id);
        presets = presets.filter((preset) => preset.id !== id);
        // Deleting the active preset falls back to the shipped one rather than
        // leaving `pack` pointing at something that no longer exists — and the
        // stored pointer has to move with it, or the next restart restores a
        // preset that is gone.
        if (settings.presetName === target.name) {
          settings.pack = normalizePack(presets[0]?.pack);
          settings.presetName = presets[0]?.name ?? DEFAULT_PRESET_NAME;
        }
        for (const id of revisions.keys()) touch(id);
        sendJson(res, 200, { ok: true, presets: presets.map(presetForClient), active: settings.presetName, settings });
        return;
      }

      sendJson(res, 400, { error: 'unknown action' });
      return;
      } catch {
        sendJson(res, 503, { error: 'preset-save-failed' }); return;
      } finally { if (action !== 'generate') presetChanging = false; }
    }

    if (path === `${ROUTE}/settings` && req.method === 'GET') {
      sendJson(res, 200, {
        instanceId, controlRev: revisions.get('') ?? 0,
        settings,
        memory: readerMemoryLines(),
        memoryStats: memoryStats(),
        presets: presets.map(presetForClient),
        // Per-session overrides ride on the settings read the page already
        // polls, so a toggle made in another window reaches this one without a
        // second request shape.
        sessionSwitches: sessionSwitchState(),
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
        if (patch.pack !== undefined && storeState === 'opening') {
          sendJson(res, 503, { error: 'storage-not-ready' }); return;
        }
        if (patch.pack !== undefined && presetChanging) { sendJson(res, 409, { error: 'preset-change-pending' }); return; }
        const processChanged = ['enabled', 'includeToolSteps', 'processToolUsage']
          .some((key) => typeof patch[key] === 'boolean' && patch[key] !== settings[key]);
        if (patch.pack !== undefined) {
          const oldId = activePresetId();
          const oldBuiltin = presets.find((p) => p.id === oldId)?.builtin === true;
          const pack = normalizePack(patch.pack);
          presetChanging = true;
          try { await persistActivePack(pack); }
          catch (error) { sendJson(res, error?.message === 'too-many-presets' ? 400 : 503, { error: 'preset-save-failed' }); return; }
          finally { presetChanging = false; }
          invalidatePersona('persona-changed', (id) => !conversations.read(id).personaId
            || (!oldBuiltin && personaFor(id).id === oldId), oldBuiltin ? undefined : oldId);
          settings.pack = pack;
          // Write the edit back into the preset it belongs to. Without this the
          // change lived only in memory: the presets table still held the old
          // card, and the next restart silently restored it — which reads as
          // "my edits do not save".
        }
        if (typeof patch.provider === 'string') setSetting('provider', patch.provider.trim());
        if (typeof patch.model === 'string') setSetting('model', patch.model.trim());
        if (typeof patch.reasoningEffort === 'string') setSetting('reasoningEffort', patch.reasoningEffort.trim());
        if(typeof patch.chatProvider==='string')setSetting('chatProvider',patch.chatProvider.trim());
        if(typeof patch.chatModel==='string')setSetting('chatModel',patch.chatModel.trim());
        if(typeof patch.chatThinking==='boolean')setSetting('chatThinking',patch.chatThinking);
        if (typeof patch.enabled === 'boolean') setSetting('enabled', patch.enabled);
        if (patch.enabled === false) {
          // Stop any rewrite already spending tokens under the old switch.
          for (const controller of activeRewrites.values()) controller.abort(new Error('disabled'));
          // A turn that was mid-flight when the master switch went off must not
          // leave a stale `report`-mode candidate for the next turn to consume.
          turnState.clear();
          candidates.clear();
          toolUsage.clear();
        }
        if (typeof patch.includeToolSteps === 'boolean') setSetting('includeToolSteps', patch.includeToolSteps);
        if (['step', 'report'].includes(patch.trigger) && patch.trigger !== settings.trigger) {
          setSetting('trigger', patch.trigger);
          invalidatePersona('scope-changed', (id) => conversations.read(id).trigger === 'inherit');
          for (const id of new Set([...revisions.keys(), ...turnState.keys(), ...candidates.keys()])) {
            if (conversations.read(id).trigger === 'inherit') { candidates.delete(id); toolUsage.clear(id); }
          }
        }
        if (typeof patch.processToolUsage === 'boolean') {
          setSetting('processToolUsage', patch.processToolUsage);
        }
        if (processChanged) {
          toolUsageRevision++;
          toolUsage.clear();
          for (const controller of activeProcessRewrites.values()) controller.abort(new Error('process-disabled'));
        }
        if (typeof patch.memory === 'boolean') {
          const changed = patch.memory !== settings.memory;
          setSetting('memory', patch.memory);
          if (changed) {
            invalidatePersona('memory-changed');
            retireStaleChatMemory('memory-changed');
          }
        }
        if (typeof patch.memoryExtraction === 'boolean') setSetting('memoryExtraction', patch.memoryExtraction);
        if (patch.memory === false || patch.memoryExtraction === false || patch.enabled === false) {
          memoryConsolidator.cancel();
          if (settingsRestored) memories.discardQueue();
        }
        if (typeof patch.reviewHints === 'boolean') {
          setSetting('reviewHints', patch.reviewHints);
        }
        if (Number.isFinite(patch.reviewThreshold) && patch.reviewThreshold >= 0 && patch.reviewThreshold <= 1) {
          setSetting('reviewThreshold', patch.reviewThreshold);
        }
        if (typeof patch.progressNotices === 'boolean') {
          setSetting('progressNotices', patch.progressNotices);
        }
        if (Number.isInteger(patch.progressMinutes) && patch.progressMinutes >= 1 && patch.progressMinutes <= 60) {
          setSetting('progressMinutes', patch.progressMinutes);
        }
        if (typeof patch.subagentSteps === 'boolean') setSetting('subagentSteps', patch.subagentSteps);
        if (typeof patch.subagentReports === 'boolean') setSetting('subagentReports', patch.subagentReports);
        // Clearing the learned profile is a user right, not a debug affordance:
        // the plugin collects observations about them, so discarding them must
        // be one click away.
        if (patch.clearMemory === true) {
          profile = emptyProfile();
          memoryConsolidator.cancel();
          memories.clear();
          memoryUsage.clear();
          retireStaleChatMemory('memory-cleared');
          invalidatePersona('memory-cleared');
          pendingMemoryClear = !settingsRestored;
          memorySamples.length = 0;
          scheduleProfileSave();
          if (store && settingsRestored) {
            try { await Promise.all([store.putProfile(profile), saveMemory(), saveMemoryUsage()]); }
            catch { sendJson(res, 503, { error: 'memory-save-failed' }); return; }
          }
        }
        // Persist the switches and the route. The page reports 「已保存」, so a
        // restart that restored the defaults would make that a lie.
        saveSettings();
        memoryConsolidator.notify();
        if (['enabled', 'progressNotices', 'progressMinutes', 'provider', 'model'].some((key) => key in patch)) progress.configure();
        for (const id of revisions.keys()) touch(id);
      }
      sendJson(res, 200, {
        settings,
        memory: readerMemoryLines(),
        memoryStats: memoryStats(),
        // Returned so the page can show which preset the edit landed in — an
        // edit to the builtin forks a new preset, and the user has to see that.
        presets: presets.map(presetForClient),
        sessionSwitches: sessionSwitchState(),
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  // Register now when the service is already present, else wait for it.
  if (webServer !== undefined) registerRoutes(webServer, ctx);
  else ctx.inject(['webServer'], (ready) => registerRoutes(ready.webServer, ready));

  // Public registry and service APIs keep this JS plugin dependency-free. Both
  // faces consume the exact same strict contract (the browser copy is generated).
  ctx.inject(['typert'], (owner) => {
    const registry = owner.get('typert');
    if (typeof registry?.register !== 'function' || typeof owner.provide !== 'function') return;
    const contribution = createRemoteContract();
    const service = {
      ctx: owner,
      // Public Cordis Tracker metadata rebinds ctx to each Gateway invocation.
      [Symbol.for('cordis.tracker')]: { associate: 'personaShell', property: 'ctx' },
      async *observe(key, signal) {
        const invocation = this.ctx.invocation;
        if (invocation?.peer?.principal?.kind !== 'owner') {
          throw Object.assign(new Error('Persona Shell state is owner-only'), {
            code: 'persona-shell/owner-required', details: {}, isDSHRemoteError: true,
          });
        }
        let active = true;
        const lease = `remote-${randomUUID()}`;
        // Per-physical-stream leases prevent an old connection's cleanup from
        // withdrawing the replacement connection's foreground view.
        void (async () => {
          try {
            for await (const view of invocation.uplink()) {
              if (!active || signal.aborted) return;
              if (key !== '') progress.viewer(lease, view.visible ? key : undefined, view.revision);
            }
          } catch (error) {
            if (active && !signal.aborted) warn('state uplink failed', error);
          }
        })();
        try { yield* stateStream.observe(key, signal); }
        finally {
          active = false;
          progress.viewer(lease, undefined, Number.MAX_SAFE_INTEGER);
        }
      },
    };
    service.typertRemote = { service, serviceKey: 'personaShell', namespace: 'personaShell' };
    owner.provide('personaShell', service);
    registry.register({ package: contribution.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors });
  });

  ctx.effect(() => () => {
    storeClosing = true;
    for(const controller of chatStreamControllers)controller.abort();chatStreamControllers.clear();
    chatLive.close();
    chatContext.dispose();
    for(const context of roomContexts.values())context.dispose();roomContexts.clear();
    stateStream.close();
    progress.dispose();
    toolUsage.dispose();
    const memoryDrain = memoryConsolidator.dispose();
    // Stop rewrites before dropping the rows they would settle into: a model
    // stream must not keep spending tokens after the plugin is gone.
    for (const controller of activeRewrites.values()) controller.abort(new Error('disposed'));
    for (const controller of activeExtractions) controller.abort(new Error('disposed'));
    for (const pending of activeChats.values()) pending.abort.abort(new Error('disposed'));
    for(const round of chatRounds.values())round.abort.abort(Error('disposed'));
    for (const pending of activeSuggestions.values()) pending.abort.abort(new Error('disposed'));
    // Release every held long-poll request before tearing down: a response left
    // waiting on a dead plugin would hang until its timeout.
    for (const waiters of [...stateWaiters.values()]) {
      for (const wake of [...waiters]) wake();
    }
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
    if (usageTimer !== undefined) { clearTimeout(usageTimer); usageTimer = undefined; }
    if (modelUsageTimer !== undefined) { clearTimeout(modelUsageTimer); modelUsageTimer = undefined; }
    // Collect the writes to await. `putProfile` is awaited below so the final
    // state reaches the backend before the domain is torn down.
    const pending = [conversations.drain(), chats.drain()];
    if (store !== undefined) {
      pending.push(store.putProfile(profile).catch((error) => warn('profile flush failed', error)));
      pending.push(saveMemory().catch((error) => warn('memory flush failed', error)));
      pending.push(saveMemoryUsage().catch((error) => warn('memory usage flush failed', error)));
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
    const modelsDrain = Promise.allSettled([...modelTasks]);
    const owned = closing === undefined
      ? Promise.resolve()
      : Promise.allSettled([...pending, modelsDrain, memoryDrain, presetWrites, chatProfile.drain()])
        .then(async () => {
          // Abort settlement may finish after the first flush; retain its final delivery state.
          try { await closing.putMemoryUsage(memoryUsage.snapshot()); }
          catch (error) { warn('memory usage flush failed', error); }
          try { await saveModelUsage(closing); }
          catch (error) { warn('model usage flush failed', error); }
          await closing.close();
        })
        .catch((error) => warn('store close failed', error));
    return Promise.all([owned, memoryDrain, Promise.allSettled(tasks), modelsDrain])
      .catch((error) => warn('store teardown failed', error));
  }, 'persona-shell.dispose');
}
