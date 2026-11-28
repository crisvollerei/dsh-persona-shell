import { normalizePack } from './pack.js';
import { emptyProfile } from './memory.js';
import { openStore } from './store.js';
import { CHAT_SUPPORT_SETTINGS } from './chat-support-templates.js';
import { builtinAvatar, restoreAvatar } from './avatar.js';

export function createHostStorage({
  recoverRelayCards = async () => {},
  builtinAvatarOverrides, chatSupport, conversations, ctx, setEnabledRestored, hydrate,
  invalidatePersona, LEGACY_ABSORBED_NAMES, MAX_PRESETS, memories, memoryConsolidator, memoryUsage,
  modelUsage, chatTiming, getModelUsageRevision, getPendingMemoryClear, setPendingMemoryClear,
  pendingSessionSwitchValues, pendingSettings, getPresets, setPresets, getProfile, setProfile,
  progress, setProgressRestored, queuePresetWrite, revisions, rows, saveModelUsage,
  saveSessionSwitches, saveSettings, scheduleMemoryUsageSave, scheduleModelUsageSave,
  scheduleProfileSave, sessionSwitches, getSessionSwitchRev, setSessionSwitchRev, settings,
  setSettingsRestored, setStore, getStoreClosing, setStoreError, setStoreState,
  setToolUsageRestored, touch, warn,
}) {
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
    setSettingsRestored(false);
    setEnabledRestored(false);
    setStoreState('opening');
    for (const id of revisions.keys()) touch(id);

    let restoring;
    const task = openStore(ctx).then((opened) => {
      const restoreUsage = (saved) => {
        chatTiming.restore(saved?.chatTiming);
        modelUsage.restore(saved);
      };
      if (getStoreClosing()) {
        // Shutting down: close what arrived and report nothing. The close is part
        // of this task, so the unload chain waits for the domain to be released.
        return (async () => {
          try {
            if (getModelUsageRevision() > 0) {
              restoreUsage(opened.getModelUsage());
              await saveModelUsage(opened);
            }
          } finally { await opened.close(); }
        })().catch((error) => warn('late store flush/close failed', error));
      }
      restoring = opened;
      // Read all startup records before applying any of them or scheduling writes.
      const savedUsage = opened.getModelUsage();
      const savedSupport = opened.getChatSupport();
      const savedProfile = opened.getProfile();
      const savedMemory = opened.getMemory();
      const savedMemoryUsage = opened.getMemoryUsage();
      const savedPresets = opened.listPresets();
      const restored = getPresets().filter((preset) => preset.builtin === true);
      const avatars = new Map(restored.map(preset => [preset.id, opened.getBuiltinAvatar(preset.id)]));
      const savedConversations = opened.getConversations();
      const savedActive = opened.getActivePreset();
      const savedSettings = opened.getSettings();
      const savedSwitches = opened.getSessionSwitches();

      restoreUsage(savedUsage);
      chatSupport.restore(savedSupport);
      const clearedBeforeRestore = getPendingMemoryClear();
      memories.restore(savedMemory, { clear: clearedBeforeRestore });
      memoryUsage.restore(savedMemoryUsage, { clear: clearedBeforeRestore });
      if (clearedBeforeRestore) {
        setProfile(emptyProfile());
        setPendingMemoryClear(false);
      } else if (savedProfile !== undefined) {
        setProfile(savedProfile.messages >= getProfile().messages ? savedProfile : getProfile());
      }
      memories.migrate(getProfile());
      setProfile({ ...getProfile(), stated: {} });

      // Restore saved presets, keeping every shipped preset first and always
      // present even if the stored copy is missing or corrupt.
      const renamed = [];
      builtinAvatarOverrides.clear();
      for (const preset of restored) {
        const saved = avatars.get(preset.id);
        const avatar = saved?.version === 1 ? restoreAvatar(saved.avatar) : null;
        if (avatar && avatar !== builtinAvatar(preset.id)) {
          preset.avatar = avatar;
          builtinAvatarOverrides.set(preset.id, avatar);
        } else preset.avatar = builtinAvatar(preset.id);
      }
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
          renamed.push(custom);
          continue;
        }
        if (builtin !== undefined) {
          absorbed.set(raw.id, builtin.id);
          continue;
        }
        restored.push({ ...raw, pack: normalizePack(raw.pack), avatar: restoreAvatar(raw.avatar) });
      }
      setPresets(restored.slice(0, MAX_PRESETS));
      conversations.restore(savedConversations);

      // Restore the selection the user left behind. Without this the active
      // persona lived only in memory and a restart quietly reverted to the
      // default, which is indistinguishable from the switch never having worked.
      if (typeof savedActive === 'string' && savedActive !== '') {
        const activeId = absorbed.get(savedActive) ?? savedActive;
        const active = getPresets().find((preset) => preset.id === activeId);
        if (active !== undefined) {
          invalidatePersona();
          settings.pack = normalizePack(active.pack);
          settings.presetName = active.name;
        }
      }

      // Restore the durable switches and route. The page reports 「已保存」 for
      // these, so losing them on restart is a promise broken — and re-enabling
      // memory for someone who switched it off is worse than an inconvenience.
      if (savedSettings !== null && typeof savedSettings === 'object') {
        if (['step', 'report'].includes(savedSettings.trigger)) settings.trigger = savedSettings.trigger;
        for (const key of ['enabled', 'includeToolSteps', 'colloquialReports', 'memory', 'memoryExtraction', 'reviewHints', 'subagentSteps', 'subagentReports']) {
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
        for (const key of ['provider', 'model', 'reasoningEffort','chatProvider','chatModel','visualizationProvider','visualizationModel']) {
          if (typeof savedSettings[key] === 'string') settings[key] = savedSettings[key];
        }
        for(const key of Object.values(CHAT_SUPPORT_SETTINGS))if(typeof savedSettings[key]==='boolean')settings[key]=savedSettings[key];
        for(const key of ['chatDeepReasoningProvider','chatDeepReasoningModel'])if(typeof savedSettings[key]==='string'&&savedSettings[key].length<=180)settings[key]=savedSettings[key].trim();
        if(typeof savedSettings.chatThinking==='boolean')settings.chatThinking=savedSettings.chatThinking;
        if(typeof savedSettings.chatReasoningEffort==='string'&&savedSettings.chatReasoningEffort.trim().length<=128)settings.chatReasoningEffort=savedSettings.chatReasoningEffort.trim();
        if(typeof savedSettings.visualizationThinking==='boolean')settings.visualizationThinking=savedSettings.visualizationThinking;
        if(typeof savedSettings.readableThinking==='boolean')settings.readableThinking=savedSettings.readableThinking;
      }
      for (const [key, value] of pendingSettings) settings[key] = value;
      if (!settings.memory || !settings.memoryExtraction) memories.discardQueue();
      // The switches are now authoritative; memory collection may resume — but
      // never during shutdown, where nothing should keep publishing state.

      // Per-session overrides. A missing/corrupt record means "all sessions
      // follow the global switch", which is exactly the pre-feature state.
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
      setSessionSwitchRev(Math.max(getSessionSwitchRev(), savedRev) + (appliedPending ? 1 : 0));
      setStore(opened);
      setStoreState('open');
      setStoreError('');
      restoring = undefined;
      for (const sessionId of new Set([...rows.values()].map(row => row.sessionId))) hydrate(sessionId);
      if (!getStoreClosing()) {
        setSettingsRestored(true);
        setEnabledRestored(true);
        setProgressRestored(true);
        setToolUsageRestored(true);
      }
      scheduleModelUsageSave();
      if (clearedBeforeRestore || savedMemoryUsage) scheduleMemoryUsageSave();
      if (clearedBeforeRestore || getProfile().messages > 0) scheduleProfileSave();
      for (const custom of renamed) {
        void queuePresetWrite(db => db.putPreset(custom)).catch(error => warn('preset label save failed', error));
      }
      if (appliedPending) {
        pendingSessionSwitchValues.clear();
        saveSessionSwitches();
      }
      for (const id of sessionSwitches.keys()) memories.discardSession(id);
      // A process may have stopped between deleting a preset and retiring its queued work.
      if (memories.retireMissingPersonas(getPresets().map(p=>p.id))) scheduleProfileSave();
      if(!getStoreClosing())void recoverRelayCards().catch(error=>warn('handoff recovery failed',error));
      if (pendingSettings.size > 0) {
        pendingSettings.clear();
        void saveSettings().catch(error => warn('settings persist failed', error));
      }
      // A held /state request may have observed the storage-opening values;
      // wake every known session so the client can leave its loading state.
      for (const id of revisions.keys()) touch(id);
      progress.configure();
      memoryConsolidator.notify();
    }).catch(async (error) => {
      if (restoring) await restoring.close().catch(closeError => warn('failed store close', closeError));
      setStoreError(error instanceof Error ? error.message : String(error));
      // Nothing can be restored. The question is what "unknown" should mean, and
      // the safe answer is "do not collect": a missing facility is not evidence
      // that the user never saved `memory:false`, and collecting on a guess breaks
      // a privacy switch. Collection stays off until storage actually reports.
      if (!getStoreClosing()) {
        setStoreState('failed');
        // Storage is unusable, not merely slow: fall back to the config default
        // for rewriting, while memory collection stays off (it is the privacy
        // switch and "unknown" must not read as "on").
        setEnabledRestored(true);
        warn('storage failed; rewrites are memory-only and memory collection stays off', error);
        for (const id of revisions.keys()) touch(id);
      }
    });
    openingTasks.add(task);
    task.finally(() => { openingTasks.delete(task); }).catch(() => {});
  };

  return {
    openWhenAvailable, openingTasks,
  };
}
