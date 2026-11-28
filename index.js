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

import { createHostSessionEvents } from './lib/host-session-events.js';
import { createHostReportRows } from './lib/host-report-rows.js';
import { createHostStorage } from './lib/host-storage.js';
import { createHostMemoryPresets } from './lib/host-memory-presets.js';
import { createHostChatRoutes } from './lib/host-chat-routes.js';
import { createHostReportRoutes } from './lib/host-report-routes.js';
import { createHostSettingsRoutes } from './lib/host-settings-routes.js';
import { createHostMemoryRoutes } from './lib/host-memory-routes.js';
import { createHostStatusRoutes } from './lib/host-status-routes.js';
import { createHostRewrite } from './lib/host-rewrite.js';
import {createAssetRoute} from './lib/host-asset-routes.js';
import {planAssetImport} from './lib/asset-backup.js';
import { createHostChat } from './lib/host-chat.js';
import { mask } from './lib/mask.js';
import { BUILTIN_PRESETS, normalizePack } from './lib/pack.js';
import { Config, resolveConfig } from './lib/config.js';
import { observeMessage, emptyProfile } from './lib/memory.js';
import { buildProgressPrompt, createProgress, validateProgress } from './lib/progress.js';
import { randomUUID } from 'node:crypto';
import { createRemoteContract } from './lib/remote-contract.js';
import { createStateStream, ROW_REV, versionReportRow } from './lib/state-stream.js';
import { createToolUsage } from './lib/tool-usage.js';
import { createStructuredMemory } from './lib/structured-memory.js';
import { createMemoryConsolidator } from './lib/memory-consolidation.js';
import { createConversations } from './lib/conversations.js';
import { createExpressionLlm } from './lib/expression-llm.js';
import { createModelUsage } from './lib/model-usage.js';
import { createChatTiming } from './lib/chat-timing.js';
import { createMemoryUsage } from './lib/memory-usage.js';
import { candidateSources, verifiedCandidates, isMemoryRoom } from './lib/chat-memory.js';
import { createPersonaChat, primaryChatTurn } from './lib/persona-chat.js';
import { createModelRouteResolver } from './lib/model-route.js';
import { createChatInputQueue } from './lib/chat-input-queue.js';
import { createChatScheduler, CHAT_INTERVAL_MS } from './lib/chat-scheduler.js';
import {createChatSupport} from './lib/chat-support.js';
import {runChatSupport} from './lib/chat-support-runner.js';
import {createSupportPageReader} from './lib/chat-support-web.js';
import { builtinAvatar, avatarUrl, avatarVersion } from './lib/avatar.js';
import { createChatProfile } from './lib/chat-profile.js';
import { createChatContext } from './lib/chat-context.js';
import { createChatReferenceUsage } from './lib/chat-reference-usage.js';
import { quoteKey,resolveChatQuote } from './lib/chat-quote.js';
import { discussionView } from './lib/chat-discussion.js';
import { prepareWorkDraft, buildWorkDraftPrompt, parseWorkDraft } from './lib/chat-work-draft.js';
import { createChatSourceAdapter } from './lib/chat-source.js';
import { createChatLive } from './lib/chat-live.js';
import { createReportViews } from './lib/report-views.js';
import { createReportViewJobs } from './lib/host-report-views.js';

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
const HOST_BUILD = 2026112802;
const DIRECTOR_REASONS = new Set(['wire-type','wire-size','control','json','duplicate-key','shape','choice','goal','contribution','actor','event','evidence',
  'stale-event','author','normal-ineligible','peer-ineligible','peer-call','non-stop','tool-call','too-long','scene','support']);
const DIRECTOR_FINISHES = new Set(['stop','max-tokens','tool-calls','error','aborted']);

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
export function apply(ctx, rawConfig, runtime = {}) {
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
    colloquialReports: cfg.colloquialReports,
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
    chatResearchEnabled:cfg.chatResearchEnabled===true,chatDeepReasoningEnabled:cfg.chatDeepReasoningEnabled===true,
    chatSummarizeEnabled:cfg.chatSummarizeEnabled===true,
    chatDeepReasoningProvider:cfg.chatDeepReasoningProvider??'',chatDeepReasoningModel:cfg.chatDeepReasoningModel??'',
    chatProvider: cfg.chatProvider ?? '', chatModel: cfg.chatModel ?? '', chatThinking: cfg.chatThinking === true,
    chatReasoningEffort: cfg.chatReasoningEffort ?? '',
    visualizationProvider: cfg.visualizationProvider, visualizationModel: cfg.visualizationModel,
    visualizationThinking: cfg.visualizationThinking,
    readableThinking: cfg.readableThinking,
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
  let settingsWrites = Promise.resolve();
  let settingsChanges = Promise.resolve();
  let presetChanging = false;
  const builtinAvatarOverrides = new Map();

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
  const rewriteListeners = new Set();
  let globalPersonaSignal;
  const globalSignal=()=>JSON.stringify([activePresetId(),settings.enabled]);
  const publicPersonaReady = () => settingsRestored || (storeState === 'unavailable' && enabledRestored);
  function checkGlobalSwitch(){
    if(!rewriteListeners.size)return;
    const next=globalSignal();if(next===globalPersonaSignal)return;
    globalPersonaSignal=next;emitSwitched(null);
  }
  function emitPluginEvent(fields) {
    if (storeClosing || !rewriteListeners.size) return;
    const event = Object.freeze({ version: 1, ...fields });
    for (const listener of [...rewriteListeners]) {
      try { Promise.resolve(listener(event)).catch(() => warn('personaShell listener rejected')); }
      catch { warn('personaShell listener failed'); }
    }
  }
  const emitRewrite=(type,sessionId,seq,personaId,category)=>emitPluginEvent({type,sessionId,seq,personaId,...(category?{category}:{})});
  function emitSwitched(sessionId) {
    if(publicPersonaReady())emitPluginEvent({type:'persona:switched',sessionId,personaId:sessionId===null?activePresetId():personaFor(sessionId).id,
      enabled:settings.enabled===true&&(sessionId===null||sessionEnabledFor(sessionId))});
  }
  const rowsBySession = new Map();
  const sessionRows = sessionId => rowsBySession.get(sessionId)?.values() ?? [];
  function setReportRow(key, row) {
    row=versionReportRow(row);
    rows.set(key, row);
    let own = rowsBySession.get(row.sessionId);
    if (!own) rowsBySession.set(row.sessionId, own = new Map());
    own.set(row.seq, row);
    return row;
  }
  const originalReportLimit = 60000;
  const reportFits = text => text.length <= cfg.maxRewriteChars
    || text.length <= originalReportLimit && mask(text).masked.length <= cfg.maxRewriteChars;
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
  const candidateJobs = new Map();
  function cancelCandidateJobs(roomId, onlyStale = false) {
    for (const [id, job] of candidateJobs) {
      if ((!roomId || roomId === id) && (!onlyStale || !job.valid(chats.read(id)))) job.controller.abort(Error('chat-memory-source'));
    }
  }
  async function discoverChatMemory(body) {
    if(!settings.enabled || !settings.memory)throw Error('memory-disabled');
    if(typeof body.room!=='string' || !body.room)throw Error('chat-memory-source');
    const room=chats.read(body.room);
    const valid = current => current?.id === body.room && (current.generation ?? 0) === body.generation
      && roomScopeKey(current) === body.scopeKey && (current.referenceRevision ?? 0) === body.referenceRevision;
    if(!valid(room))throw Error('chat-memory-source');
    if(candidateJobs.has(room.id))throw Error('memory-conflict');
    const sources=candidateSources(room,body.scopeKey,memories.snapshot().entries,presets.map(p=>p.id));
    if(!sources.length)return {count:0};
    const controller=new AbortController();candidateJobs.set(room.id,{controller,valid});
    try {
      const proposals=await extractMemories({channel:'chat',sources,routeSessionId:room.primarySessionId??currentSessionHint()},controller.signal);
      controller.signal.throwIfAborted();
      return await chats.withRoom(room.id,current=>saveMemoryMutation({action:'propose'},{requireEnabled:true,applyChange:staged=>{
        controller.signal.throwIfAborted();
        if(!valid(current))throw Error('chat-memory-source');
        const fresh=candidateSources(current,body.scopeKey,staged.snapshot().entries,presets.map(p=>p.id)).filter(s=>sources.some(old=>old.id===s.id && old.text===s.text && old.personaId===s.personaId));
        const candidates=verifiedCandidates(proposals,fresh,current,body.scopeKey);
        for(const candidate of candidates)staged.rememberChat(candidate,'candidate');
        return {count:candidates.length};
      },finish:()=>{controller.signal.throwIfAborted();}}));
    } finally {candidateJobs.delete(room.id);}
  }
  const activeModelMetadata = new Set();
  const modelTasks = new Set();
  const reportViews = createReportViews({ store: () => store, changed: id => notifySession(id),
    warn: error => warn('report view persistence failed', error) });
  const reportViewJobs = createReportViewJobs({
    views: reportViews,
    getSettings: () => ({ provider: settings.visualizationProvider, model: settings.visualizationModel,
      readableThinking: settings.readableThinking, visualizationThinking: settings.visualizationThinking }),
    timeoutMs: cfg.timeoutMs,
    readableTimeoutMs: cfg.readableTimeoutMs,
    resolveRoute: async (sessionId, options, context) => routePair(
      await waitWithSignal(modelRoutes.resolve(sessionId, options, context), context.signal)),
    createLlm: (valid, options) => expressionLlm('report-visualization', undefined, { ...options, beforeAttempt: valid }),
    waitWithSignal, streamWithSignal, trackModelTask,
    isClosing: () => storeClosing,
  });
  const activeChats = new Map();
  const chatJobsFor = roomId => [...activeChats.values()].filter(job=>job.roomId===roomId);
  const chatJobKey = (roomId,attemptId) => JSON.stringify([roomId,attemptId]);
  const chatLive = createChatLive();
  const chatStreamControllers = new Set();
  const activeSuggestions = new Map();
  const activeWorkDrafts = new Map(), workDraftRequests = new Map(), cancelledWorkDrafts = new Set();
  const chatStarting = new Set();
  const chatRounds = new Map();
  const chatDirectorFailures=new Map();
  const chatDirectorClocks=new Map();
  // The room decision clock and per-member cooldowns share the same interval.
  const chatIntervalMs = Number.isSafeInteger(runtime?.chatIntervalMs) && runtime.chatIntervalMs >= 0 ? runtime.chatIntervalMs : CHAT_INTERVAL_MS;
  const chatScheduler=createChatScheduler({intervalMs:chatIntervalMs});
  const chatInputs = createChatInputQueue({ intervalMs:0, persist:async value=>{
    if(!store||storeClosing||!settingsRestored)throw Error('storage-not-ready');
    await store.putChatInputQueue(value);
  }});
  const chatInputTimers=new Map(),chatInputDraining=new Set(),chatInputBindings=new Map();
  let chatInputRestore=Promise.resolve(),chatInputReady=false;
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
  function capturedRoomContext(roomId,key,options){
    const source=contextForRoom(roomId);if(!source||!key)throw Error('context-not-open');
    const value=source.capture(key,options),selection=source.selection(key),room=chats.read(roomId);
    if(JSON.stringify(room.sources)!==JSON.stringify(selection.sources.map(s=>s.id))||room.primarySessionId!==selection.primarySessionId)throw Error('chat-context-unsaved');
    return {...value,sourceCatalog:selection.sources,scopeKey:roomScopeKey(room)};
  }
  let chatRecordsLoaded = false, chatProfileLoaded = false;
  let chatLocalStateKey,chatLocalKeyWrite;
  async function ensureChatLocalStateKey(){
    if(chatLocalStateKey||!settingsRestored||!store||storeClosing)return;
    if(chatLocalKeyWrite)return chatLocalKeyWrite;
    const opened=store;
    const task=(async()=>{
      const saved=opened.getChatLocalStateKey();
      const valid=saved?.version===1&&typeof saved.id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(saved.id);
      const key=valid?saved.id:randomUUID();
      if(!valid)await opened.putChatLocalStateKey({version:1,id:key});
      // Unsent drafts stay in the browser. Only a durable profile identifier
      // is exposed, so another Host/profile cannot inherit those local drafts.
      if(!storeClosing&&store===opened)chatLocalStateKey=key;
    })().catch(error=>warn('chat local state namespace unavailable',error)).finally(()=>{if(chatLocalKeyWrite===task)chatLocalKeyWrite=undefined;});
    chatLocalKeyWrite=task;return task;
  }
  let chatReferenceTimer,chatReferenceWrites=Promise.resolve(),chatReferenceRevision=0,savedChatReferenceRevision=0,chatReferencePersistFailed=false;
  const chatReferenceUsage=createChatReferenceUsage({changed(){chatReferenceRevision++;scheduleChatReferenceSave();}});
  function scheduleChatReferenceSave(){
    if(!chatRecordsLoaded||!store||storeClosing||chatReferenceTimer!==undefined)return;
    chatReferenceTimer=setTimeout(()=>{chatReferenceTimer=undefined;void saveChatReferences(store).catch(error=>warn('chat reference persist failed',error));},1500);
    chatReferenceTimer.unref?.();
  }
  function saveChatReferences(opened){
    chatReferenceWrites=chatReferenceWrites.catch(()=>{}).then(async()=>{
      if(!chatRecordsLoaded||!opened||savedChatReferenceRevision===chatReferenceRevision)return;
      const revision=chatReferenceRevision;
      try{await opened.putChatReferenceUsage(chatReferenceUsage.snapshot());savedChatReferenceRevision=revision;chatReferencePersistFailed=false;}
      catch(error){chatReferencePersistFailed=true;throw error;}
    });return chatReferenceWrites;
  }
  function ensureChatRecords() {
    if (!chatRecordsLoaded && settingsRestored && store && !storeClosing) {
      chats.restore(store.getPersonaChats());chatReferenceUsage.restore(store.getChatReferenceUsage()); chatRecordsLoaded = true;
      chatInputRestore=chatInputs.restore(store.getChatInputQueue()).then(()=>{chatInputReady=true;});
      void chatInputRestore.catch(error=>warn('chat input restore failed',error));
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
      if (current.relay?.status === 'cancelled' && previous.relay?.handoffId && previous.relay.status !== 'cancelled') {
        void finishRelayCard(id,current.relay).catch(error=>warn('handoff close failed',error));
      }
      if (personaFor(id, previous).id !== personaFor(id, current).id || previous.personaId!==current.personaId) emitSwitched(id);
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
  const modelRoutes=createModelRouteResolver({getService:key=>ctx.get(key),getSettings:()=>settings,
    getTurnRoute:id=>turnState.get(id),isClosing:()=>storeClosing});
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
  let importingAssets = false;
  const memories = createStructuredMemory({ changed: () => scheduleProfileSave() });
  let usageWrites = Promise.resolve();
  let usageTimer;
  let usageSaveFailed = false;
  const memoryUsage = createMemoryUsage({ changed: () => scheduleMemoryUsageSave() });
  let modelUsageWrites = Promise.resolve(), modelUsageTimer, modelUsageWriteFailed = false;
  let modelUsageRevision = 0, savedModelUsageRevision = 0;
  const modelUsage = createModelUsage({ changed() { modelUsageRevision++; scheduleModelUsageSave(); } });
  const chatTiming = createChatTiming({changed(){modelUsageRevision++;scheduleModelUsageSave();}});
  const supportPageReader=runtime.supportPageReader??createSupportPageReader();
  const chatSupport=createChatSupport({timeoutMs:runtime.supportTimeoutMs??60000,
    save:value=>{if(!store||storeClosing)throw Error('storage-not-ready');return store.putChatSupport(value);},
    execute:async({job,signal,update,admit})=>{
      const options=job.template==='reason'?{provider:settings.chatDeepReasoningProvider||settings.chatProvider,
        model:settings.chatDeepReasoningProvider?settings.chatDeepReasoningModel:settings.chatModel,thinking:true,thinkingRequired:true}
        :{provider:settings.chatProvider,model:settings.chatModel,thinking:false};
      const sourceRoom=chats.read(job.roomId);
      const route=await waitWithSignal(resolveChatRouteAsync(sourceRoom?.primarySessionId??currentSessionHint(),options,signal),signal);
      if(!route)throw Error('support-model-unavailable');
      const web=ctx.get('web');
      if(job.template==='research'&&(typeof web?.search!=='function'||typeof web.searchReady==='function'&&!await waitWithSignal(web.searchReady(route.provider),signal)))throw Error('support-search-unavailable');
      return runChatSupport({job,signal,update,admit,search:(request,abort)=>web.search(request,abort),readPage:supportPageReader,
        call:async(request,onDispatch)=>{
          const llm=expressionLlm('chat-support-'+job.template,()=>{onDispatch();const round=chatRounds.get(job.roomId);
            if(round?.messageId===job.messageId)round.timing.calls.support++;},options,
            decision=>update({model:{provider:decision.provider,model:decision.model,thinking:decision.effective??decision.mode}}));
          if(!llm)throw Error('support-model-unavailable');let text='',finish;
          for await(const chunk of streamWithSignal(llm,{...request,...route})){
            signal.throwIfAborted();if(chunk.type.startsWith('tool-call')||chunk.type==='block-start'&&chunk.blockType==='tool-call'||chunk.type==='error')throw Error('support-format');
            if(chunk.type==='text-delta')text+=chunk.text;if(text.length>16000)throw Error('support-format');if(chunk.type==='finish')finish=chunk.reason?.kind;
          }
          if(finish!=='stop'||!text.trim())throw Error('support-format');return text;
        }});
    }});
  const supportScope=room=>({roomId:room.id,generation:room.generation??0,scopeKey:roomScopeKey(room),referenceRevision:room.referenceRevision??0});
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
    const inherited = presets.find((p) => p.name === settings.presetName);
    // Keep the actual configured card, including standalone custom configuration.
    // Its builtin provenance still needs a complete card match in the channel view.
    return preset ?? { id: activePresetId(), name: settings.presetName, pack: settings.pack,
      ...(inherited ? { builtin: inherited.builtin === true } : {}) };
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

  function expressionLlm(purpose, onDispatch, chatOptions, onDecision) {
    const llm = getLlm();
    return llm === undefined ? undefined : createExpressionLlm(llm, { reasoningEffort: chatOptions ? chatOptions.reasoningEffort??'' : settings.reasoningEffort,
      thinking: chatOptions?.thinking,thinkingRequired:chatOptions?.thinkingRequired===true, beforeAttempt:chatOptions?.beforeAttempt, onDispatch,
      onAttempt: route => modelUsage.begin({ purpose, ...route }),
      onDecision: (decision) => { if (!storeClosing) diagnostics.expressionModel = { purpose, ...decision }; onDecision?.(decision); } });
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
        await opened.putModelUsage({...modelUsage.snapshot(),chatTiming:chatTiming.snapshot()});
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
    const selection = memories.selection({ personaId, sessionId, text, purpose: channel === 'chat' ? 'chat' : 'rewrite' });
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
  function saveMemoryMutation(action, { handoff = false, requireEnabled = false, applyChange, finish } = {}) {
    const opened = store;
    const task = memoryWrites.catch(() => {}).then(async () => {
      if (!opened || storeClosing) throw new Error('storage-not-ready');
      if (requireEnabled && !settings.memory) throw Error('memory-disabled');
      const baseline = memories.snapshot();
      const staged = createStructuredMemory();
      staged.restore(baseline);
      const result = applyChange ? applyChange(staged) : handoff ? staged.handoff(action) : staged.mutate(action);
      const next = staged.snapshot();
      await opened.putMemory(next);
      if (storeClosing || (requireEnabled && !settings.memory) || memories.snapshot().revision !== baseline.revision) {
        // A concurrent clear/edit wins. Repair the durable copy before reporting conflict.
        await opened.putMemory(memories.snapshot());
        throw new Error('memory-conflict');
      }
      memories.restore(next);
      if (finish) {
        try { await finish(); } catch (error) {
          if (memories.snapshot().revision === next.revision) memories.restore(baseline);
          await opened.putMemory(memories.snapshot()); throw error;
        }
      }
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

  function finishRelayCard(sessionId, relay) {
    return saveMemoryMutation({action:'close'}, {handoff:true,applyChange:staged=>{
      let record=staged.snapshot().handoffs.find(h=>h.id===relay.handoffId && h.sessionId===sessionId && h.toPersonaId===relay.toPersonaId);
      if (!record || record.status==='closed') return;
      const change=action=>staged.handoff({action,id:record.id,sessionId,personaId:relay.toPersonaId,version:record.version});
      if (relay.status==='cancelled' && record.status==='pending') return change('cancel');
      if (record.status==='pending') record=change('accept');
      return change('close');
    }});
  }

  async function recoverRelayCards(deletedPersona) {
    const open=new Set(memories.snapshot().handoffs.filter(h=>h.status!=='closed').map(h=>h.id));
    if(!open.size)return;
    for(const [sessionId,choice] of Object.entries(conversations.snapshot().sessions)){
      const relay=choice.relay;
      if(!relay?.handoffId || !open.has(relay.handoffId) || (deletedPersona && relay.toPersonaId!==deletedPersona)) continue;
      const missing=!presets.some(p=>p.id===relay.toPersonaId);
      if(relay.status!=='pending' || missing)await finishRelayCard(sessionId,missing?{...relay,status:'cancelled'}:relay);
    }
  }

  function memoryState() {
    const snapshot = memories.snapshot();
    ensureChatProfile();
    if (snapshot.entries.some(e=>isMemoryRoom(e.sessionId) || e.contextRef)) ensureChatRecords();
    for(const entry of snapshot.entries){
      if(!entry.contextRef)continue;
      const room=chats.read(entry.contextRef.roomId);
      const q=room && !room.excludedReferences?.some(r=>quoteKey(r)===quoteKey(entry.contextRef)) && resolveChatQuote(room,entry.contextRef,roomScopeKey(room));
      if(q && q.author.role==='assistant')entry.contextNote={author:q.author.name,text:q.text};
    }
    const roomNames=chatRecordsLoaded?Object.fromEntries(chats.list().map(r=>[r.id,r.name])):{};
    const sessionTitles=Object.fromEntries([...roomContexts.values()].flatMap(c=>(c.snapshot().sources??[]).map(s=>[s.sessionId,s.name])));
    return { revision: snapshot.revision, entries: snapshot.entries, operations: snapshot.operations,roomNames,sessionTitles,
      capacity:memories.capacity(), hasUserAddress:!!chatProfile.read().userAddress,
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
    return { instanceId, revision: value.revision, avatarMode: value.avatarMode, userAddress:value.userAddress, reportAddress:value.reportAddress, userGender:value.userGender,
      avatar: value.avatar ? ROUTE + '/chat-profile/avatar?v=' + avatarVersion(value.avatar) : null };
  }
  function reportRetryUnavailable(row,sessionId){
    if(!row||typeof row.original!=='string'||!row.original.trim()||!reportFits(row.original))return 'source-unavailable';
    if(row.reason==='no-prose')return 'report-no-prose';
    if(!row.speaker||!presets.some(p=>p.id===row.speaker.id))return 'persona-not-found';
    if(row.retrying||inFlight.has(`${sessionId}:${row.seq}`))return 'feedback-in-progress';
    if(!['ready','skipped','failed'].includes(row.status))return 'report-incomplete';
    if(storeClosing||!settingsRestored||!enabledRestored)return 'rewrite-disabled';
    return null;
  }

  // A completed source captured while automatic rewriting was off has no rewrite
  // row yet. Expose a bounded, read-only proposal; only an explicit feedback POST
  // materializes it, and the source hash/persona/version must still match.
  function manualReportRow(sessionId,seq) {
    try {
      const view=reportViews.read(sessionId,seq);
      if(!view.available||!view.source)return undefined;
      const persona=personaFor(sessionId);
      return {sessionId,seq,version:1,final:true,status:'skipped',text:'',
        reason:rewriteBlockReason(sessionId),original:view.source.text,sourceHash:view.source.hash,
        speaker:{id:persona.id,name:persona.name,mode:persona.pack.narration?.mode??'voice'}};
    } catch { return undefined; }
  }

  function chatState(key) {
    ensureChatRecords();
    const room = chats.read(key);
    const personaId = room?.targetPersonaId ?? (presets.some(p=>p.id===key)?key:activePresetId());
    const preparing=!!room && chatStarting.has(room.id);
    const current=room?chatRounds.get(room.id):undefined;
    const round=!preparing && current && !current.abort.signal.aborted ? current : undefined;
    const running = !!room && (preparing||!!round||chatInputDraining.has(room.id)||chatInputs.list(room.id).some(b=>b.status==='pending'||b.status==='sending')||chatJobsFor(room.id).some(job=>!job.abort.signal.aborted));
    if (room && !running) for (const turn of room.turns) if (turn.status === 'pending') turn.status = 'interrupted';
    const contacts = presets.map((p) => ({ id: p.id, name: p.name, archived: false, avatar: avatarUrl(p) }));
    for (const old of chats.contacts()) if (!contacts.some((p) => p.id === old.personaId)) {
      contacts.push({ id: old.personaId, name: old.name, archived: true });
    }
    for(const id of room?.memberIds??[])if(!contacts.some(p=>p.id===id))contacts.push({id,name:'已移除的人格',archived:true,avatar:null});
    const context=room?roomContexts.get(room.id):undefined;
    const memberActivity=(room?.memberIds??[]).flatMap(id=>{
      const typing=chatJobsFor(room.id).some(job=>job.generating&&!job.abort.signal.aborted&&room.turns.some(t=>t.attemptId===job.attemptId&&t.recipientId===id&&t.status==='pending'));
      return typing?[{id,state:'typing'}]:round?.listeningMemberIds?.includes(id)?[{id,state:'listening'}]:[];
    });
    const canYield=!!round&&!room.turns.some(t=>t.messageId===round.messageId&&t.phase!=='anchor'&&t.status==='pending');
    const rooms=chats.list().map(item=>({...item,running:chatStarting.has(item.id)||chatInputDraining.has(item.id)||chatInputs.list(item.id).some(b=>b.status==='pending'||b.status==='sending')||!!(chatRounds.get(item.id)&&!chatRounds.get(item.id).abort.signal.aborted)||chatJobsFor(item.id).some(job=>!job.abort.signal.aborted)}));
    return { instanceId,chatSchema:3,discussionVersion:2,roundFirstTextMs:round?.timing.firstText,roomMemoryCount:room?memories.roomCount(room.id):0,memoryEnabled:settings.memory,localStateKey:chatLocalStateKey,roundId:round?.id,roundMessageId:round?.messageId,roundPhase:preparing?'preparing':round?.stage,
      personalCounts:room&&settings.memory?chatReferenceUsage.personalCounts(room.id,roomScopeKey(room)):{},memoryRevision:memories.revision(),
      directorFailure:room?chatDirectorFailures.get(room.id)??null:null,queuedInputs:room?chatInputs.list(room.id):[],inputRevision:chatInputs.snapshot().revision,canQueue:chatInputReady,
      roundElapsedMs:round?Math.max(0,Date.now()-round.startedAt):undefined,roundModel:round?.model,canYield,activeAttemptIds:room?chatJobsFor(room.id).filter(job=>job.started&&!job.abort.signal.aborted).map(job=>job.attemptId):[], personaId, room, scopeKey:roomScopeKey(room), rooms, activeRoomId:chats.active(), running:!!running, contacts, epoch: chats.epoch(), userProfile: publicChatProfile(), defaultPersonaId: activePresetId(),
      supportTasks:room?chatSupport.view(supportScope(room)):[],supportCapabilities:{research:settings.chatResearchEnabled===true,reason:settings.chatDeepReasoningEnabled===true,
        summarize:settings.chatSummarizeEnabled===true,workReferences:!!room?.sources?.length,searchService:typeof ctx.get('web')?.search==='function'},
      memberActivity,imagesAvailable:typeof ctx.get('attachments')?.saveImages==='function'&&typeof ctx.get('attachments')?.readImage==='function',
      ready: settingsRestored && !!store && !storeClosing, modelReady: modelRoutes.canResolve(context?.snapshot().primarySessionId??currentSessionHint(),{provider:settings.chatProvider,model:settings.chatModel}) };
  }

  function roomPublicChoices(room,scope,excluded=[]){
    const discussionChoices=[];
    const paused=new Set(excluded.map(quoteKey));
    for(const turn of room.turns){
      for(const part of turn.userParts??[{id:turn.messageId}]){
        const user={roomId:room.id,generation:room.generation??0,kind:'user',messageId:part.id};
        if(!discussionChoices.some(q=>quoteKey(q.ref)===quoteKey(user))){const quote=resolveChatQuote(room,user,scope);if(quote)discussionChoices.push(quote);}
      }
      if(turn.status==='ready')for(let index=0;index<turn.assistant.length;index++){
        const quote=resolveChatQuote(room,{roomId:room.id,generation:room.generation??0,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index},scope);
        if(quote)discussionChoices.push(quote);
      }
    }
    return discussionChoices.filter(q=>!paused.has(quoteKey(q.ref))).slice(-120).reverse();
  }

  function roomReferenceState(requestedRoom){
    if(!chatRecordsLoaded)return{initialized:false,rooms:[],room:null,records:[],excluded:[]};
    const rooms=chats.list(),room=chats.read(requestedRoom??chats.active());
    if(requestedRoom&&!room)throw Error('chat-room-not-found');
    if(!room)return{initialized:true,rooms,room:null,records:[],excluded:[]};
    const scope=roomScopeKey(room),context=roomContexts.get(room.id),cache=context?.snapshot();
    const discussion=discussionView(room,scope);
    const paused=new Set((room.excludedReferences??[]).map(quoteKey));
    const showQuote=ref=>{const quoted=resolveChatQuote(room,ref,scope);return{ref,...(quoted?{author:quoted.author,text:quoted.text}:{}),available:!!quoted,excluded:paused.has(quoteKey(ref))};};
    const records=chatReferenceUsage.read(room.id).map(record=>{
      const inScope=record.scopeKey===scope;
      // Recover the originating question from this exact attempt, never from a
      // reused message id or a similarly named room. The ledger keeps no text.
      const turn=inScope?room.turns.find(t=>t.attemptId===record.attemptId&&t.messageId===record.messageId
        &&t.recipientId===record.personaId&&(t.scopeKey??t.contextKey??null)===scope):undefined;
      const primary=turn?room.turns.filter(t=>t.messageId===turn.messageId&&primaryChatTurn(t)):[];
      const allowed=inScope&&settings.memory&&presets.some(p=>p.id===record.personaId)?memories.references(record.memory,{personaId:record.personaId,sessionId:room.id,purpose:'chat'}):[];
      return{...record,inScope,personaName:room.turns.find(t=>t.attemptId===record.attemptId)?.speakerName??presets.find(p=>p.id===record.personaId)?.name??'已移除的人格',
        discussion:record.discussion.map(ref=>{const item=inScope?discussion.entries.find(e=>e.id===ref.id&&e.version===ref.version&&e.available):null;
          return{...ref,available:!!item,...(item?{title:item.title,status:item.status}:{})};}),
        request:turn?{available:true,text:turn.user,recipients:turn.recipients.map(({id,name})=>({id,name})),
          ...(turn.directedPlanId?{responseKind:turn.responsePlan?.kind,replyTo:turn.responsePlan?.to}:{}),
          phase:turn.phase??'primary',...(primaryChatTurn(turn)?{order:primary.findIndex(t=>t.id===turn.id)+1}: {})}:{available:false},
        notes:record.notes.map(ref=>inScope?showQuote(ref):{ref,available:false}),
        quote:record.quote?(inScope?showQuote(record.quote):{ref:record.quote,available:false}):null,
        memory:record.memory.map(ref=>{const entry=inScope?allowed.find(e=>e.id===ref.id&&e.version===ref.version):undefined;
          return{...ref,available:!!entry,...(entry?{content:entry.content,scope:entry.scope,recordedAt:entry.occurredAt??entry.createdAt,evidence:entry.evidence.map(e=>e.quote)}
            :inScope&&settings.memory?{status:memories.versionStatus(ref.id)==='retracted'?'已撤销':'已更新'}:{})};}),
        work:record.work.map(ref=>{const source=inScope?context?.resolveReference(ref):null;
          return{...ref,available:!!source,...(source?{goal:source.goal,report:source.report,
            ...(source.previousReport?{previousReport:{...ref.previousReport,...source.previousReport}}:{})}: {})};})};
    });
    return{initialized:true,rooms,room:{id:room.id,name:room.name},scopeKey:scope,epoch:chats.epoch(),referenceRevision:room.referenceRevision??0,
      currentSources:(room.sources??[]).map(id=>{const cached=cache?.sources.find(s=>s.sessionId===id);return{sessionId:id,name:cached?.name??'工作会话',readAt:cached?.checkedAt??null,primary:id===room.primarySessionId};}),
      discussion,discussionChoices:roomPublicChoices(room,scope),records,excluded:(room.excludedReferences??[]).map(showQuote),persistence:chatReferencePersistFailed?'failed':'local'};
  }

  function preparedWorkDraft(body){
    if(storeClosing||!settingsRestored||!store)throw Error('storage-not-ready');
    if(!chatRecordsLoaded)throw Error('context-not-open');
    const room=chats.read(body.roomId);
    if(!room)throw Error('chat-room-not-found');
    if(!chats.acceptsEpoch(room.id,body.epoch))throw Error('chat-draft-context-changed');
    return prepareWorkDraft(room,body,roomScopeKey(room));
  }

  function generateWorkDraft(body){
    if(body.thinking!==undefined&&typeof body.thinking!=='boolean')throw Error('invalid-chat-draft');
    const prepared=preparedWorkDraft(body),sourceFingerprint=JSON.stringify(prepared);
    const thinking=body.thinking??(settings.chatThinking===true);
    const options={provider:settings.chatProvider,model:settings.chatModel,thinking,reasoningEffort:settings.chatReasoningEffort};
    const fingerprint=JSON.stringify({source:prepared,thinking,reasoningEffort:thinking?options.reasoningEffort:''}),key=JSON.stringify([body.roomId,body.requestId]);
    if(typeof body.requestId!=='string'||!body.requestId.trim()||body.requestId.length>160)throw Error('invalid-chat-draft');
    if(cancelledWorkDrafts.has(key))throw Error('chat-draft-cancelled');
    const existing=workDraftRequests.get(key);
    if(existing){if(existing.fingerprint!==fingerprint)throw Error('chat-draft-conflict');return existing.promise;}
    activeWorkDrafts.get(body.roomId)?.abort.abort(Error('chat-draft-superseded'));
    const abort=new AbortController(),entry={roomId:body.roomId,requestId:body.requestId,fingerprint,abort,done:false};
    const timer=setTimeout(()=>abort.abort(Error('chat-draft-timeout')),Math.min(cfg.timeoutMs,thinking?60000:20000));
    const valid=()=>{
      if(storeClosing||abort.signal.aborted||activeWorkDrafts.get(body.roomId)!==entry)return false;
      try{return JSON.stringify(preparedWorkDraft(body))===sourceFingerprint;}catch{return false;}
    };
    entry.valid=valid;
    activeWorkDrafts.set(body.roomId,entry);workDraftRequests.set(key,entry);
    entry.promise=trackModelTask((async()=>{
      try{
        const room=chats.read(body.roomId);
        const route=await waitWithSignal(resolveChatRouteAsync(room?.primarySessionId??currentSessionHint(),options,abort.signal),abort.signal);
        if(!valid())throw Error('chat-draft-context-changed');
        if(!route)throw Error('chat-draft-unavailable');
        let thinkingDecision;
        const llm=expressionLlm('chat-draft',undefined,{...options,beforeAttempt(){if(!valid())throw Error('chat-draft-context-changed');}},
          ({mode,reason,effective})=>{thinkingDecision={mode,reason,effective};});
        if(!llm)throw Error('chat-draft-unavailable');
        const {system,user}=buildWorkDraftPrompt(prepared);let wire='',finish;
        for await(const chunk of streamWithSignal(llm,{provider:route.provider,model:route.model,system,
          messages:[{role:'user',content:[{type:'text',text:user}]}],maxTokens:thinking?8192:2500,signal:abort.signal})){
          if(!valid())throw Error('chat-draft-context-changed');
          if(chunk.type==='error')throw Error('chat-draft-unavailable');
          if(chunk.type.startsWith('tool-call')||(chunk.type==='block-start'&&chunk.blockType==='tool-call')
            ||(chunk.type==='block-end'&&chunk.block?.type==='tool-call'))throw Error('chat-draft-format');
          if(chunk.type==='text-delta')wire+=chunk.text;if(wire.length>24000)throw Error('chat-draft-too-large');
          if(chunk.type==='finish')finish=chunk.reason?.kind;
        }
        abort.signal.throwIfAborted();
        if(!valid())throw Error('chat-draft-context-changed');
        if(finish!=='stop')throw Error('chat-draft-incomplete');
        const draft=parseWorkDraft(wire);if(!draft)throw Error('chat-draft-format');
        const thinkingStatus=!thinking?'off':thinkingDecision?.mode==='thinking'?'enabled'
          :thinkingDecision?.reason==='thinking-unavailable'?'unavailable':'unknown';
        return{requestId:body.requestId,basis:prepared.basis,draft,thinking,thinkingStatus};
      }finally{
        clearTimeout(timer);entry.done=true;
        if(activeWorkDrafts.get(body.roomId)===entry)activeWorkDrafts.delete(body.roomId);
        while(workDraftRequests.size>64){const oldest=[...workDraftRequests].find(([,value])=>value.done);
          if(!oldest)break;workDraftRequests.delete(oldest[0]);}
      }
    })());
    return entry.promise;
  }

  const {
    retireOldRoomReferences, retireInvalidWorkDrafts, retireChatInputRuntime, launchChatRound,
    armChatInput,
  } = createHostChat({
    activeChats, activeWorkDrafts, capturedRoomContext, cfg, chatContext, chatDirectorClocks,
    chatDirectorFailures, chatInputBindings, chatInputDraining,
    getChatInputReady: () => chatInputReady, getChatInputRestore: () => chatInputRestore,
    chatInputs, chatInputTimers, chatIntervalMs, chatJobKey, chatJobsFor, chatLive, chatProfile, chatTiming,
    chatReferenceUsage, chatRounds, chats, chatScheduler, chatSupport, contextForRoom, ctx,
    currentSessionHint, getDiagnostics: () => diagnostics, DIRECTOR_FINISHES, DIRECTOR_REASONS,
    ensureChatProfile, expressionLlm, expressionMemory, instanceId, memories,
    getPresets: () => presets, resolveChatRouteAsync, roomContexts, roomScopeKey, settings,
    getStoreClosing: () => storeClosing, streamWithSignal, supportScope, trackModelTask,
    waitWithSignal, warn, workDraftRequests, cancelCandidateJobs,
  });

  const {
    commitPresetChange, extractPreset, persistActivePack, presetForClient, queuePresetWrite,
    saveSettings, extractMemories,previewPersona,
  } = createHostMemoryPresets({
    activeExtractions, activePresetId, builtinAvatarOverrides, cfg, DEFAULT_PRESET_NAME,
    expressionLlm, MAX_PRESETS, getPresets: () => presets, setPresets: value => (presets = value),
    getPresetWrites: () => presetWrites, setPresetWrites: value => (presetWrites = value),
    resolveRouteAsync, settings, getSettingsRestored: () => settingsRestored,
    getSettingsWrites: () => settingsWrites, setSettingsWrites: value => (settingsWrites = value),
    getStore: () => store, getStoreClosing: () => storeClosing, getStoreState: () => storeState,
    streamWithSignal, waitWithSignal, warn,
  });

  const memoryConsolidator = createMemoryConsolidator({
    memory: memories,
    enabled: () => !storeClosing && !importingAssets && settingsRestored && settings.enabled === true
      && settings.memory === true && settings.memoryExtraction === true,
    run: (batch, signal) => trackModelTask(extractMemories(batch, signal)),
  });

  function notifySession(sessionId) {
    if (storeClosing) return;
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    wakeStateWaiters(sessionId);
    stateStream.changed(sessionId);
  }
  const touch = (sessionId) => {
    notifySession(sessionId);
    if (storeClosing) return;
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

  const {
    trim, hydrate, schedulePersist, persistTimers, hydrated, flushPersist, awaitingHydration,
  } = createHostReportRows({
    cfg, notifySession, originalReportLimit, rows, rowsBySession, sessionRows, setReportRow,
    getStore: () => store, touch, warn,
  });

  /** The route the rewrite call should use: explicit override, else the turn's own route. */
  /**
   * A session id for a request that is not tied to one session.
   *
   * Preset generation runs from the settings page, which belongs to no session,
   * but the route still has to come from somewhere. The most recently active
   * session is the best available answer; an explicit settings-page model
   * override wins regardless.
   */
  const sessionActivity = new Map();
  function noteSessionActivity(session, event) {
    if (typeof session?.id !== 'string' || !session.id || session.id.length > 512 || isSubagent(session) || session?.header?.origin === 'subagent'
      || !['user/message', 'user-message', 'request/header', 'turn/start', 'assistant/message', 'turn/end'].includes(event.type)) return;
    const prior = sessionActivity.get(session.id), seq = Number.isSafeInteger(event.seq) ? event.seq : undefined;
    if ((seq === undefined && prior) || (seq !== undefined && seq <= (prior?.seq ?? -1))) return;
    sessionActivity.delete(session.id);
    sessionActivity.set(session.id, { seq: seq ?? -1 });
    while (sessionActivity.size > 64) sessionActivity.delete(sessionActivity.keys().next().value);
  }
  function currentSessionHint() {
    const validPart = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512;
    for (const sessionId of [...sessionActivity.keys()].reverse()) {
      const state = turnState.get(sessionId);
      if (validPart(state?.provider) && validPart(state?.model)) return sessionId;
    }
    return undefined;
  }

  const routePair=route=>route?{provider:route.provider,model:route.model}:undefined;
  function resolveRoute(sessionId) {return routePair(modelRoutes.peek(sessionId));}
  async function resolveRouteAsync(sessionId,signal) {return routePair(await modelRoutes.resolve(sessionId,undefined,{signal}));}
  function chatRoute(sessionId,options={provider:settings.chatProvider,model:settings.chatModel}) {return routePair(modelRoutes.peek(sessionId,options));}
  async function resolveChatRouteAsync(sessionId,options,signal) {return routePair(await modelRoutes.resolve(sessionId,options,{signal}));}

  const {
    isSubagent, isUserMessage, reportText, hasToolCall, enqueue, skip, rewrite,
  } = createHostRewrite({
    emitRewrite, memories, finishRelayCard,
    getReportAddress: () => { ensureChatProfile(); const profile = chatProfile.read(); return profile.reportAddress ? profile.userAddress : ''; },
    activeProcessRewrites, activeRewritePersonas, activeRewrites, cfg, conversationErrors,
    conversations, getEnabledRestored: () => enabledRestored, expressionLlm, expressionMemory,
    inFlight, modelRoutes, notifySession, personaFor, getPresets: () => presets, reportViews,
    resolveRouteAsync, revisionFor, rewriteAllowedFor, rewriteBlockReason, routePair, rows,
    samples, setReportRow, settings, getSettingsRestored: () => settingsRestored,
    getStoreClosing: () => storeClosing, STREAM_INTERVAL_MS, streamWithSignal, toolUsage,
    getToolUsageRestored: () => toolUsageRestored, getToolUsageRevision: () => toolUsageRevision,
    touch, trackModelTask, trim, turnState, waitWithSignal, warn,
  });

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
          const route = await waitWithSignal(resolveRouteAsync(sessionId,signal), signal);
          const llm = expressionLlm('progress', () => memoryContext.usage?.sent());
          if (signal.aborted || !route || !llm) throw new Error('progress-unavailable');
          const { system, user } = buildProgressPrompt(normalizePack(persona.pack), facts, memoryContext.entries.map((e) => e.content),
            {id:persona.id,builtin:persona.builtin===true});
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

  const {
    onSessionEvent,
  } = createHostSessionEvents({
    activeRewrites, candidates, chatContext, getDiagnostics: () => diagnostics,
    getEnabledRestored: () => enabledRestored, enqueue, hasToolCall, isSubagent, isUserMessage,
    latestSourceSeq, looksLikePastedPersona, noteSessionActivity, observeUserText, personaFor,
    progress, reportFits, reportText, reportViews, rewriteAllowedFor, roomContexts, rows, samples,
    sessionEnabledFor, settings, getSettingsRestored: () => settingsRestored, skip,
    getStoreClosing: () => storeClosing, toolUsage, getToolUsageRestored: () => toolUsageRestored,
    touch, triggerFor, turnState,
  });

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
  const {
    openWhenAvailable, openingTasks,
  } = createHostStorage({
    recoverRelayCards,
    builtinAvatarOverrides, chatSupport, conversations, ctx,
    setEnabledRestored: value => (enabledRestored = value), hydrate, invalidatePersona,
    LEGACY_ABSORBED_NAMES, MAX_PRESETS, memories, memoryConsolidator, memoryUsage, modelUsage,
    getModelUsageRevision: () => modelUsageRevision, chatTiming,
    getPendingMemoryClear: () => pendingMemoryClear,
    setPendingMemoryClear: value => (pendingMemoryClear = value), pendingSessionSwitchValues,
    pendingSettings, getPresets: () => presets, setPresets: value => (presets = value),
    getProfile: () => profile, setProfile: value => (profile = value), progress,
    setProgressRestored: value => (progressRestored = value), queuePresetWrite, revisions, rows,
    saveModelUsage, saveSessionSwitches, saveSettings, scheduleMemoryUsageSave,
    scheduleModelUsageSave, scheduleProfileSave, sessionSwitches,
    getSessionSwitchRev: () => sessionSwitchRev,
    setSessionSwitchRev: value => (sessionSwitchRev = value), settings,
    setSettingsRestored: value => {settingsRestored=value;if(value&&rewriteListeners.size)globalPersonaSignal=globalSignal();}, setStore: value => (store = value),
    getStoreClosing: () => storeClosing, setStoreError: value => (storeError = value),
    setStoreState: value => (storeState = value),
    setToolUsageRestored: value => (toolUsageRestored = value), touch, warn,
  });

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

  const projectedRows=new WeakMap();
  let nextWireRev=0;
  const stateFor = (sessionId) => {
    // Reads during storage opening must participate in the later ready notice.
    if (!revisions.has(sessionId)) revisions.set(sessionId, 0);
    // A page that opens an old session asks before any event arrives, so this
    // is where a restart's rows come back.
    if (sessionId !== '') hydrate(sessionId);
    const own = [...sessionRows(sessionId)];
    for(const report of settingsRestored&&enabledRestored?reportViews.list(sessionId):[])if(report.available&&!own.some(row=>row.seq===report.seq)){
      const proposal=manualReportRow(sessionId,report.seq);if(proposal)own.push(proposal);
    }
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
      reports: reportViews.list(sessionId),
      rows: own.map((row) => {
        const process=settings.processToolUsage===true && settings.includeToolSteps===true && row.final!==true;
        const memory=settings.memory===true && row.memoryRefs?.length ? memories.revision() : -1;
        const ready=settingsRestored&&enabledRestored&&!storeClosing,flight=inFlight.has(`${sessionId}:${row.seq}`);
        const cache=projectedRows.get(row);
        if(cache && cache.rev===row.rev && cache.process===process && cache.memory===memory && Date.now()<cache.expires
          && cache.ready===ready && cache.flight===flight && cache.presets===presets)return cache.view;
        const entries=memory>=0&&row.speaker?memories.references(row.memoryRefs,{personaId:row.speaker.id,sessionId}):[];
        const retryReason=reportRetryUnavailable(row,sessionId);
        const view={
        seq: row.seq,
        sourceHash: row.sourceHash,
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
        canRetry: retryReason===null,
        retryUnavailableReason: retryReason,
        memories: entries.map(({id,version,content,scope})=>({id,version,content,scope})),
        processNote: row.final !== true && settings.processToolUsage === true && settings.includeToolSteps === true ? row.processNote : undefined,
        processUsage: row.final !== true && settings.processToolUsage === true && settings.includeToolSteps === true ? row.processUsage : undefined,
        distance: row.distance,
        review: row.review,
        // True for the step that closed its turn; the page puts the badge and
        // the 「原文」 toggle on that one only.
        final: row.final === true,
        };
        if (row.rev !== undefined) {
          view[ROW_REV] = ++nextWireRev;
          projectedRows.set(row,{rev:row.rev,process,memory,ready,flight,presets,view,
            expires:Math.min(Infinity,...entries.map(e=>e.expiresAt??Infinity))});
        }
        return view;
      }),
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

  const chatRoutePaths = new Set([
    ROUTE + '/chat/live', ROUTE + '/chat/memory', ROUTE + '/chat-references', ROUTE + '/chat-discussion',
    ROUTE + '/chat-context', ROUTE + '/chat-profile', ROUTE + '/chat-profile/avatar',
    ROUTE + '/chat-image', ROUTE + '/chat-model-options', ROUTE + '/chat-rooms', ROUTE + '/chat',
    ROUTE + '/chat-work-draft', ROUTE + '/chat/suggestions',
  ]);
  const handleChatRoutes = createHostChatRoutes({
    saveMemoryMutation, discoverChatMemory, roomMemoryCount:id=>memories.roomCount(id,true),
    activeChats, activeModelMetadata, activePresetId, activeSuggestions, activeWorkDrafts,
    armChatInput, cancelledWorkDrafts, capturedRoomContext, cfg, chatContext, chatContextState,
    chatDirectorClocks, chatDirectorFailures, chatInputBindings,
    getChatInputRestore: () => chatInputRestore, chatInputs, chatJobKey, chatJobsFor, chatLive,
    chatProfile, getChatRecordsLoaded: () => chatRecordsLoaded, chatReferenceUsage, chatRounds,
    chats, chatScheduler, chatStarting, chatState, chatStreamControllers, chatSupport,
    contextForRoom, ctx, currentSessionHint, ensureChatLocalStateKey, ensureChatProfile,
    ensureChatRecords, expressionLlm, generateWorkDraft, getLlm, instanceId, launchChatRound,
    modelRoutes, personaFor, preparedWorkDraft, getPresets: () => presets, publicChatProfile,
    resolveChatRouteAsync, retireChatInputRuntime, retireInvalidWorkDrafts, retireOldRoomReferences,
    roomContexts, roomPublicChoices, roomReferenceState, roomScopeKey, ROUTE, sendJson, settings,
    getSettingsRestored: () => settingsRestored, getStore: () => store,
    getStoreClosing: () => storeClosing, streamWithSignal, supportScope, trackModelTask,
    waitWithSignal,
  });

  const reportRoutePaths = new Set([
    ROUTE + '/report-visualization', ROUTE + '/conversation', ROUTE + '/feedback',
  ]);
  const handleReportRoutes = createHostReportRoutes({
    memories,
    conversationErrors, conversations, conversationState, hydrate, latestSourceSeq, manualReportRow,
    memoryConsolidator, personaFor, getPresets: () => presets, reportRetryUnavailable,
    reportViewJobs, reportViews, revisionFor, rewrite, ROUTE, rows, samples, saveMemoryMutation,
    sendJson, sessionRows, setReportRow, settings, getSettingsRestored: () => settingsRestored,
    getStore: () => store, getStoreClosing: () => storeClosing, getStoreState: () => storeState,
    touch, trackModelTask,
  });

  const settingsRoutePaths = new Set([
    ROUTE + '/models', ROUTE + '/presets', ROUTE + '/settings',
  ]);
  const handleSettingsRoutes = createHostSettingsRoutes({
    checkGlobalSwitch, previewPersona, recoverRelayCards,
    activeModelMetadata, activePresetId, activeProcessRewrites, activeRewrites,
    builtinAvatarOverrides, candidates, cfg, chats, chatSupport, commitPresetChange, conversations,
    currentSessionHint, DEFAULT_PRESET_NAME, extractPreset, getLlm, instanceId, invalidatePersona,
    isBuiltinName, MAX_PRESETS, memories, memoryConsolidator, memorySamples, memoryStats, cancelCandidateJobs,
    memoryUsage, modelRoutes, notifySession,
    setPendingMemoryClear: value => { pendingMemoryClear = value; }, persistActivePack, personaFor,
    getPresetChanging: () => presetChanging, setPresetChanging: value => { presetChanging = value; },
    presetForClient, getPresets: () => presets, setPresets: value => { presets = value; },
    setProfile: value => { profile = value; }, getProfile: () => profile, progress, queuePresetWrite,
    readerMemoryLines, resolveRoute, retireStaleChatMemory, revisions, ROUTE, samples, saveMemory,
    saveMemoryUsage, saveSettings, scheduleProfileSave, sendJson, sessionSwitchState, setSetting,
    settings, getSettingsChanges: () => settingsChanges,
    setSettingsChanges: value => { settingsChanges = value; },
    getSettingsRestored: () => settingsRestored, getStore: () => store,
    getStoreClosing: () => storeClosing, getStoreState: () => storeState, toolUsage,
    setToolUsageRevision: value => { toolUsageRevision = value; },
    getToolUsageRevision: () => toolUsageRevision, touch, trackModelTask, turnState, waitWithSignal,
    warn,
  });

  const memoryRoutePaths = new Set([
    ROUTE + '/memory', ROUTE + '/memory/handoffs',
  ]);
  const assetState=()=>{ensureChatRecords();return {presets,entries:memories.snapshot().entries,rooms:chats.list(),limit:MAX_PRESETS};};
  const handleAssets=createAssetRoute({state:assetState,ready:()=>settingsRestored && !!store && !storeClosing,sendJson,
    async commit(body){
      if(presetChanging)throw Error('backup-conflict');
      importingAssets=true; presetChanging=true;
      memoryConsolidator.cancel();
      try {
        // Room deletes take the directory lock before the memory write queue. Use the same order for imports.
        return await chats.withDirectory(() => {
          const task=memoryWrites.catch(()=>{}).then(()=>queuePresetWrite(async db=>{
            if(storeClosing || !db)throw Error('storage-not-ready');
            const {cards,additions,summary,token}=planAssetImport(body.file,assetState(),body.fallbackPersona);
            if(token!==body.token)throw Error('backup-conflict');
            if(!cards.length && !additions.length)return summary;
            const before=memories.snapshot(), next={...before,revision:before.revision+1,epoch:before.epoch+1,entries:[...before.entries,...additions]};
            const valid=()=>!storeClosing && memories.revision()===before.revision;
            try {
              await db.importAssets(cards,additions,next,valid,()=>{memories.restore(next);presets=[...presets,...cards];});
            } catch (error) {
              // A user observation or clear changes live memory synchronously, outside the write queue.
              if(memories.revision()!==before.revision)await db.putMemory(memories.snapshot());
              throw error;
            }
            for(const id of revisions.keys())notifySession(id);
            return summary;
          }));
          memoryWrites=task.catch(()=>{});return task;
        });
      } finally {
        importingAssets=false; presetChanging=false; memoryConsolidator.notify();
      }
    }});
  const handleMemoryRoutes = createHostMemoryRoutes({
    withMemoryRoom:(id,save)=>{ensureChatRecords();return chats.withRoom(id,room=>{if(!room)throw Error('memory-room-missing');return save();});},
    memories, memoryConsolidator, memoryState, getPresets: () => presets, ROUTE, saveMemoryMutation,
    sendJson, settings, getSettingsRestored: () => settingsRestored, getStore: () => store,
    getStoreClosing: () => storeClosing,
  });

  const statusRoutePaths = new Set([
    ROUTE + '/model-usage', ROUTE + '/progress-view', ROUTE + '/state', ROUTE + '/session-switch',
    ROUTE + '/diagnostics',
  ]);
  const handleStatusRoutes = createHostStatusRoutes({
    emitSwitched,
    activeRewrites, candidates, setDiagnostics: value => { diagnostics = value; },
    getDiagnostics: () => diagnostics, getEnabledRestored: () => enabledRestored,
    MAX_SESSION_SWITCHES, memories, memoryConsolidator, modelUsage, chatTiming,
    getModelUsageWriteFailed: () => modelUsageWriteFailed, pendingSessionSwitchValues,
    getProfile: () => profile, progress, readerMemoryLines, revisions, ROUTE, rows,
    saveSessionSwitches, sendJson, sessionSwitches,
    setSessionSwitchRev: value => { sessionSwitchRev = value; },
    getSessionSwitchRev: () => sessionSwitchRev, sessionSwitchState, settings,
    getSettingsRestored: () => settingsRestored, stateFor, getStore: () => store,
    getStoreClosing: () => storeClosing, getStoreError: () => storeError,
    getStoreState: () => storeState, toolUsage, touch, turnState, waitForStateChange,
  });

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

    if (statusRoutePaths.has(path)) return handleStatusRoutes(req, res, url, path);
    if (path===ROUTE+'/backup') return handleAssets(req,res,url);
    if (chatRoutePaths.has(path)) return handleChatRoutes(req, res, url, path);
    if (settingsRoutePaths.has(path) || path.startsWith(ROUTE + '/avatar/')) return handleSettingsRoutes(req, res, url, path);
    if (memoryRoutePaths.has(path)) return handleMemoryRoutes(req, res, url, path);
    if (reportRoutePaths.has(path)) return handleReportRoutes(req, res, url, path);
    sendJson(res, 404, { error: 'not found' });
  }

  // Register now when the service is already present, else wait for it.
  if (webServer !== undefined) registerRoutes(webServer, ctx);
  else ctx.inject(['webServer'], (ready) => registerRoutes(ready.webServer, ready));

  // Public registry and service APIs keep this JS plugin dependency-free. Both
  // faces consume the exact same strict contract (the browser copy is generated).
  const service = {
    ctx,
    apiVersion: 1,
    getActivePersona(sessionId) {
      if (storeClosing || !publicPersonaReady() || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) return null;
      const persona = personaFor(sessionId);
      const card = presets.find(p => p.id === persona.id);
      return { id: persona.id, name: persona.name, mode: persona.pack.narration?.mode ?? 'voice', avatar: card ? avatarUrl(card) ?? null : null,
        enabled:settings.enabled===true && sessionEnabledFor(sessionId) };
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      const receive = event => listener(event);
      if(!rewriteListeners.size)globalPersonaSignal=globalSignal();
      if (!storeClosing) rewriteListeners.add(receive);
      return () => rewriteListeners.delete(receive);
    },
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
  ctx.provide?.('personaShell', service);
  ctx.inject(['typert'], (owner) => {
    const registry = owner.get('typert');
    if (typeof registry?.register !== 'function' || typeof owner.provide !== 'function') return;
    if (typeof ctx.provide !== 'function') owner.provide('personaShell', service);
    const contribution = createRemoteContract();
    registry.register({ package: contribution.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors });
  });

  ctx.effect(() => () => {
    storeClosing = true;
    rewriteListeners.clear();
    modelRoutes.dispose();
    for(const timer of chatInputTimers.values())clearTimeout(timer);chatInputTimers.clear();
    chatInputBindings.clear();
    chatDirectorClocks.clear();chatDirectorFailures.clear();
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
    cancelCandidateJobs();
    for (const controller of activeExtractions) controller.abort(new Error('disposed'));
    for (const controller of activeModelMetadata) controller.abort(new Error('disposed'));
    reportViewJobs.dispose();
    for (const pending of activeChats.values()) pending.abort.abort(new Error('disposed'));
    for(const round of chatRounds.values())round.abort.abort(Error('disposed'));
    for (const pending of activeSuggestions.values()) pending.abort.abort(new Error('disposed'));
    for(const pending of activeWorkDrafts.values())pending.abort.abort(Error('disposed'));
    workDraftRequests.clear();
    cancelledWorkDrafts.clear();
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
    if (chatReferenceTimer !== undefined) { clearTimeout(chatReferenceTimer); chatReferenceTimer = undefined; }
    // Collect the writes to await. `putProfile` is awaited below so the final
    // state reaches the backend before the domain is torn down.
    const pending = [conversations.drain(), chats.drain(),chatInputs.drain(),chatInputRestore,chatScheduler.drain(),chatLocalKeyWrite,reportViews.drain(store)];
    if (store !== undefined && settingsRestored) {
      pending.push(store.putProfile(profile).catch((error) => warn('profile flush failed', error)));
      pending.push(saveMemory().catch((error) => warn('memory flush failed', error)));
      pending.push(saveMemoryUsage().catch((error) => warn('memory usage flush failed', error)));
    }
    for (const timer of persistTimers.values()) clearTimeout(timer);
    for (const sessionId of new Set([...persistTimers.keys(), ...awaitingHydration])) {
      pending.push(flushPersist(sessionId));
    }
    persistTimers.clear();
    awaitingHydration.clear();
    rows.clear();
    rowsBySession.clear();
    revisions.clear();
    samples.clear();
    hydrated.clear();
    turnState.clear();
    candidates.clear();
    inFlight.clear();
    sessionActivity.clear();

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
    const supportDrain=chatSupport.dispose();
    const modelsDrain = Promise.allSettled([...modelTasks]);
    const owned = closing === undefined
      ? Promise.resolve()
      : Promise.allSettled([...pending, supportDrain, modelsDrain, memoryDrain, presetWrites, settingsWrites, settingsChanges, chatProfile.drain()])
        .then(async () => {
          // Abort settlement may finish after the first flush; retain its final delivery state.
          try { await closing.putMemoryUsage(memoryUsage.snapshot()); }
          catch (error) { warn('memory usage flush failed', error); }
          try { await saveModelUsage(closing); }
          catch (error) { warn('model usage flush failed', error); }
          try { await saveChatReferences(closing); }
          catch (error) { warn('chat reference flush failed', error); }
          await closing.close();
        })
        .catch((error) => warn('store close failed', error));
    return Promise.all([owned, supportDrain, memoryDrain, Promise.allSettled(tasks), modelsDrain])
      .catch((error) => warn('store teardown failed', error));
  }, 'persona-shell.dispose');
}
