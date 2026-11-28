import { readRequestBody } from './http-body.js';
import { normalizePack } from './pack.js';
import { emptyProfile } from './memory.js';
import { randomUUID } from 'node:crypto';
import { CHAT_SUPPORT_SETTINGS } from './chat-support-templates.js';
import { builtinAvatar, normalizeAvatar, avatarUrl, avatarContent } from './avatar.js';
import { readFile } from 'node:fs/promises';

export function createHostSettingsRoutes({
  checkGlobalSwitch, cancelCandidateJobs, previewPersona, recoverRelayCards,
  activeModelMetadata, activePresetId, activeProcessRewrites, activeRewrites, builtinAvatarOverrides,
  candidates, cfg, chats, chatSupport, commitPresetChange, conversations, currentSessionHint,
  DEFAULT_PRESET_NAME, extractPreset, getLlm, instanceId, invalidatePersona, isBuiltinName,
  MAX_PRESETS, memories, memoryConsolidator, memorySamples, memoryStats, memoryUsage, modelRoutes,
  notifySession, setPendingMemoryClear, persistActivePack, personaFor, getPresetChanging,
  setPresetChanging, presetForClient, getPresets, setPresets, setProfile, getProfile, progress,
  queuePresetWrite, readerMemoryLines, resolveRoute, retireStaleChatMemory, revisions, ROUTE,
  samples, saveMemory, saveMemoryUsage, saveSettings, scheduleProfileSave, sendJson,
  sessionSwitchState, setSetting, settings, getSettingsChanges, setSettingsChanges,
  getSettingsRestored, getStore, getStoreClosing, getStoreState, toolUsage, setToolUsageRevision,
  getToolUsageRevision, touch, trackModelTask, turnState, waitWithSignal, warn,
}) {
  return async function handleSettingsRoutes(req, res, url, path) {
    if (path.startsWith(ROUTE + '/avatar/') && req.method === 'GET') {
      let id;
      try { id = decodeURIComponent(path.slice((ROUTE + '/avatar/').length)); } catch { sendJson(res, 404, { error: 'avatar-not-found' }); return; }
      const content = avatarContent(getPresets().find((p) => p.id === id)?.avatar);
      if (!content) { sendJson(res, 404, { error: 'avatar-not-found' }); return; }
      try {
        const data = content.data ?? await readFile(content.file);
        res.writeHead(200, { 'content-type': content.type, 'content-length': data.length,
          'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
        res.end(data);
      } catch { sendJson(res, 404, { error: 'avatar-not-found' }); }
      return;
    }

    // Only ask an adapter for model metadata when a provider was requested.
    if (path === `${ROUTE}/models`) {
      if(req.method!=='GET'){sendJson(res,405,{error:'method-not-allowed'});return;}
      const llm = getLlm();
      if (llm === undefined) { sendJson(res, 200, { providers: [], models: [] }); return; }
      const provider=url.searchParams.get('provider')??'';
      if(provider.length>512||provider.trim()!==provider){sendJson(res,400,{error:'invalid-provider'});return;}
      const abort=new AbortController();let disconnected=false;
      const closed=()=>{disconnected=true;abort.abort(Error('metadata-cancelled'));};
      activeModelMetadata.add(abort);res.once?.('close',closed);
      const timer=setTimeout(()=>abort.abort(Error('metadata-timeout')),Math.min(cfg.timeoutMs,8000));
      const inspect=async()=>{
        const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value;
        const name=entry=>typeof entry.name==='string'&&entry.name.trim()&&entry.name.length<=160?entry.name:entry.id;
        try{
          abort.signal.throwIfAborted();
          const listedProviders=typeof llm.listProviders==='function'?llm.listProviders():[];
          const providers=(Array.isArray(listedProviders)?listedProviders:[]).filter(entry=>validId(entry?.id)).slice(0,1000)
            .map(entry=>({provider:entry.id,name:name(entry)}));
          let models=[];
          if(provider&&typeof llm.listModels==='function'){
            const listed=await waitWithSignal(llm.listModels(provider),abort.signal);
            models=(Array.isArray(listed)?listed:[]).filter(entry=>validId(entry?.id)).slice(0,4000)
              .map(entry=>({id:entry.id,name:name(entry)}));
          }
          abort.signal.throwIfAborted();return{providers,models};
        }catch{return{providers:[],models:[],error:'models-unavailable'};}
      };
      try{
        const result=await trackModelTask(inspect());
        if(!disconnected&&!res.destroyed&&!res.writableEnded)sendJson(res,getStoreClosing()?503:200,
          getStoreClosing()?{providers:[],models:[],error:'models-unavailable'}:result);
      }finally{
        clearTimeout(timer);activeModelMetadata.delete(abort);res.off?.('close',closed);
      }
      return;
    }

    if (path === `${ROUTE}/presets` && req.method === 'GET') {
      sendJson(res, 200, {
        presets: getPresets().map(presetForClient),
        active: settings.presetName,
        // Where a new preset's model call would go, so the page can warn before
        // the user waits on a call that cannot succeed.
        route: resolveRoute(currentSessionHint()) ?? null,
      });
      return;
    }

    if (path === `${ROUTE}/presets` && req.method === 'POST') {
      const raw = await readRequestBody(req, 560 * 1024);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      let body;
      try { body = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const action = body?.action;
      if(action==='preview'){
        try {sendJson(res,200,await trackModelTask(previewPersona(body,currentSessionHint(),res)));}
        catch(error){sendJson(res,error.message==='invalid-preview'?400:422,{error:'preview-unavailable'});}return;
      }
      if (getPresetChanging() && action !== 'generate') { sendJson(res, 409, { error: 'preset-change-pending' }); return; }
      if (getStoreState() === 'opening' && action !== 'generate') {
        sendJson(res, 503, { error: 'storage-not-ready' }); return;
      }
      if (action !== 'generate' && getStoreClosing()) {
        sendJson(res, 503, { error: 'storage-not-ready' }); return;
      }
      if (action !== 'generate') setPresetChanging(true);
      try {

      if (action === 'avatar') {
        if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
        const target = getPresets().find((p) => p.id === body.id);
        if (!target) { sendJson(res, 404, { error: 'preset not found' }); return; }
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) {
          sendJson(res, 400, { error: 'invalid-avatar-request' }); return;
        }
        let avatar;
        try {
          if (!Object.hasOwn(body, 'avatar')) throw new Error('invalid-avatar');
          avatar = normalizeAvatar(body.avatar);
        } catch { sendJson(res, 400, { error: 'invalid-avatar' }); return; }
        if (target.builtin && avatar === null) avatar = builtinAvatar(target.id);
        if (target.avatar === avatar || (!target.avatar && !avatar)) {
          sendJson(res, 200, { ok: true, presets: getPresets().map(presetForClient), active: settings.presetName, settings }); return;
        }
        if (body.expectedAvatar !== (avatarUrl(target) ?? null)) { sendJson(res, 409, { error: 'avatar-conflict' }); return; }
        const entry = { ...target, avatar, at: Date.now() };
        try {
          if (target.builtin) {
            const override = avatar === builtinAvatar(target.id) ? null : avatar;
            await queuePresetWrite(db => db.putBuiltinAvatar(target.id, { version: 1, avatar: override }));
            if (getStoreClosing()) throw new Error('storage-not-ready');
            if (override) builtinAvatarOverrides.set(target.id, override);
            else builtinAvatarOverrides.delete(target.id);
          } else await commitPresetChange({ entry });
          setPresets(getPresets().map((p) => p.id === entry.id ? entry : p));
          for (const id of revisions.keys()) notifySession(id);
          sendJson(res, 200, { ok: true, presets: getPresets().map(presetForClient), active: settings.presetName, settings });
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
        const existing = getPresets().find((preset) => preset.name === name && preset.builtin !== true);
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
        if (existing === undefined && getPresets().length >= MAX_PRESETS) { sendJson(res, 400, { error: 'too many presets' }); return; }
        await commitPresetChange({ entry, activeId: entry.id });
        if (existing === undefined) {
          setPresets([...getPresets(), entry]);
        } else {
          setPresets(getPresets().map((preset) => (preset.id === entry.id ? entry : preset)));
        }
        invalidatePersona('persona-changed', (id) => !conversations.read(id).personaId
          || personaFor(id).id === entry.id, entry.id);
        settings.pack = entry.pack;
        settings.presetName = entry.name;
        checkGlobalSwitch();
        for (const id of revisions.keys()) touch(id);
        sendJson(res, 200, { ok: true, presets: getPresets().map(presetForClient), active: settings.presetName, settings });
        return;
      }

      // --- rename ----------------------------------------------------------
      if (action === 'rename') {
        const id = typeof body.id === 'string' ? body.id : '';
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
        const target = getPresets().find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        if (target.builtin === true) { sendJson(res, 400, { error: 'builtin preset cannot be renamed' }); return; }
        if (name === '') { sendJson(res, 400, { error: 'name required' }); return; }
        if (isBuiltinName(name)) { sendJson(res, 400, { error: 'reserved name' }); return; }
        if (getPresets().some((preset) => preset.id !== id && preset.name === name)) {
          sendJson(res, 400, { error: 'name already used' });
          return;
        }

        const renamed = { ...target, name, at: Date.now() };
        await commitPresetChange({ entry: renamed });
        setPresets(getPresets().map((preset) => (preset.id === id ? renamed : preset)));
        // `presetName` is the display label, so an active rename has to move with
        // it; the stored pointer is an id and does not change.
        if (settings.presetName === target.name) {
          settings.presetName = name;
        }
        for (const id of revisions.keys()) touch(id);
        sendJson(res, 200, { ok: true, presets: getPresets().map(presetForClient), active: settings.presetName, settings });
        return;
      }

      // --- apply -----------------------------------------------------------
      if (action === 'apply') {
        const id = typeof body.id === 'string' ? body.id : '';
        const target = getPresets().find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        await commitPresetChange({ activeId: target.id });
        invalidatePersona('persona-changed', (sid) => !conversations.read(sid).personaId
          || !getPresets().some((p) => p.id === conversations.read(sid).personaId));
        settings.pack = normalizePack(target.pack);
        settings.presetName = target.name;
        checkGlobalSwitch();
        for (const sessionId of revisions.keys()) touch(sessionId);
        sendJson(res, 200, { ok: true, settings, presets: getPresets().map(presetForClient), active: settings.presetName });
        return;
      }

      // --- delete ----------------------------------------------------------
      if (action === 'delete') {
        const id = typeof body.id === 'string' ? body.id : '';
        const target = getPresets().find((preset) => preset.id === id);
        if (target === undefined) { sendJson(res, 404, { error: 'preset not found' }); return; }
        if (target.builtin === true) { sendJson(res, 400, { error: 'builtin preset cannot be deleted' }); return; }
        await commitPresetChange({ removeId: id, ...(settings.presetName === target.name ? { activeId: getPresets()[0].id } : {}) });
        invalidatePersona('persona-deleted', (sid) => personaFor(sid).id === target.id, target.id);
        setPresets(getPresets().filter((preset) => preset.id !== id));
        // Deleting the active preset falls back to the shipped one rather than
        // leaving `pack` pointing at something that no longer exists — and the
        // stored pointer has to move with it, or the next restart restores a
        // preset that is gone.
        if (settings.presetName === target.name) {
          settings.pack = normalizePack(getPresets()[0]?.pack);
          settings.presetName = getPresets()[0]?.name ?? DEFAULT_PRESET_NAME;
        }
        if (memories.retireMissingPersonas(getPresets().map(p=>p.id))) {
          memoryConsolidator.cancel();
          await saveMemory().catch(error=>warn('retired persona memory save failed',error));
          memoryConsolidator.notify();
        }
        await recoverRelayCards(id).catch(error=>warn('handoff close failed',error));
        checkGlobalSwitch();
        for (const id of revisions.keys()) touch(id);
        sendJson(res, 200, { ok: true, presets: getPresets().map(presetForClient), active: settings.presetName, settings });
        return;
      }

      sendJson(res, 400, { error: 'unknown action' });
      return;
      } catch {
        sendJson(res, 503, { error: 'preset-save-failed' }); return;
      } finally { if (action !== 'generate') setPresetChanging(false); }
    }

    if (path === `${ROUTE}/settings` && req.method === 'GET') {
      sendJson(res, 200, {
        instanceId, controlRev: revisions.get('') ?? 0,
        settings,
        memory: readerMemoryLines(),
        memoryStats: memoryStats(),
        presets: getPresets().map(presetForClient),
        // Per-session overrides ride on the settings read the page already
        // polls, so a toggle made in another window reaches this one without a
        // second request shape.
        sessionSwitches: sessionSwitchState(),
      });
      return;
    }

    if (path === `${ROUTE}/settings` && req.method === 'POST') {
      if (getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      const raw = await readRequestBody(req, 64 * 1024);
      if (raw === undefined) { sendJson(res, 413, { error: 'too large' }); return; }
      let patch;
      try { patch = JSON.parse(raw === '' ? '{}' : raw); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      // Serialize the whole change, including a card write before scalar fields.
      const previous = getSettingsChanges();
      let complete;
      setSettingsChanges(new Promise(resolve => { complete = resolve; }));
      await previous;
      try {
      if (getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      const settingsStore = getStore();
      let responseSettings, settingsPersistence, memorySaveFailed = false;
      if (patch !== null && typeof patch === 'object') {
        if (patch.pack !== undefined && getStoreState() === 'opening') {
          sendJson(res, 503, { error: 'storage-not-ready' }); return;
        }
        if (patch.pack !== undefined && getPresetChanging()) { sendJson(res, 409, { error: 'preset-change-pending' }); return; }
        const processChanged = ['enabled', 'includeToolSteps', 'processToolUsage']
          .some((key) => typeof patch[key] === 'boolean' && patch[key] !== settings[key]);
        if (patch.pack !== undefined) {
          const oldId = activePresetId();
          const oldBuiltin = getPresets().find((p) => p.id === oldId)?.builtin === true;
          let pack = normalizePack(patch.pack);
          setPresetChanging(true);
          try { pack = await persistActivePack(pack); }
          catch (error) { sendJson(res, error?.message === 'too-many-presets' ? 400 : 503, { error: 'preset-save-failed' }); return; }
          finally { setPresetChanging(false); }
          invalidatePersona('persona-changed', (id) => !conversations.read(id).personaId
            || (!oldBuiltin && personaFor(id).id === oldId), oldBuiltin ? undefined : oldId);
          settings.pack = pack;
          // Write the edit back into the preset it belongs to. Without this the
          // change lived only in memory: the presets table still held the old
          // card, and the next restart silently restored it — which reads as
          // "my edits do not save".
        }
        if(['provider','model','chatProvider','chatModel'].some(key=>typeof patch[key]==='string'))modelRoutes.invalidate();
        if (typeof patch.provider === 'string') setSetting('provider', patch.provider.trim());
        if (typeof patch.model === 'string') setSetting('model', patch.model.trim());
        if (typeof patch.reasoningEffort === 'string') setSetting('reasoningEffort', patch.reasoningEffort.trim());
        if(typeof patch.chatProvider==='string')setSetting('chatProvider',patch.chatProvider.trim());
        if(typeof patch.chatModel==='string')setSetting('chatModel',patch.chatModel.trim());
        for(const [template,key] of Object.entries(CHAT_SUPPORT_SETTINGS))if(typeof patch[key]==='boolean'){setSetting(key,patch[key]);if(!patch[key])for(const room of chats.list())chatSupport.cancelRoom(room.id,'disabled',template);}
        for(const key of ['chatDeepReasoningProvider','chatDeepReasoningModel'])if(typeof patch[key]==='string'&&patch[key].length<=180)setSetting(key,patch[key].trim());
        if(typeof patch.chatThinking==='boolean')setSetting('chatThinking',patch.chatThinking);
        if(typeof patch.chatReasoningEffort==='string'&&patch.chatReasoningEffort.trim().length<=128)setSetting('chatReasoningEffort',patch.chatReasoningEffort.trim());
        if(typeof patch.visualizationProvider==='string')setSetting('visualizationProvider',patch.visualizationProvider.trim());
        if(typeof patch.visualizationModel==='string')setSetting('visualizationModel',patch.visualizationModel.trim());
        if(typeof patch.visualizationThinking==='boolean')setSetting('visualizationThinking',patch.visualizationThinking);
        if(typeof patch.readableThinking==='boolean')setSetting('readableThinking',patch.readableThinking);
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
        if (typeof patch.colloquialReports === 'boolean' && patch.colloquialReports !== settings.colloquialReports) {
          setSetting('colloquialReports', patch.colloquialReports);
          // Old tone samples must not pull a newly selected expression style back.
          samples.clear();
          for (const controller of activeRewrites.values()) controller.abort(new Error('expression-changed'));
        }
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
          setToolUsageRevision(getToolUsageRevision() + 1);
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
        if (patch.memory===false || patch.enabled===false || patch.clearMemory===true) cancelCandidateJobs();
        if (patch.memory === false || patch.memoryExtraction === false || patch.enabled === false) {
          memoryConsolidator.cancel();
          if (getSettingsRestored()) memories.discardQueue();
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
          setProfile(emptyProfile());
          memoryConsolidator.cancel();
          memories.clear();
          memoryUsage.clear();
          retireStaleChatMemory('memory-cleared');
          invalidatePersona('memory-cleared');
          setPendingMemoryClear(!getSettingsRestored());
          memorySamples.length = 0;
          scheduleProfileSave();
          if (getStore() && getSettingsRestored()) {
            try { await Promise.all([getStore().putProfile(getProfile()), saveMemory(), saveMemoryUsage()]); }
            catch { memorySaveFailed = true; }
          }
        }
        memoryConsolidator.notify();
        if (['enabled', 'progressNotices', 'progressMinutes', 'provider', 'model'].some((key) => key in patch)) progress.configure();
        for (const id of revisions.keys()) touch(id);
        checkGlobalSwitch();
        responseSettings = { ...settings };
        // An admitted settings write is drained during unload. A completed
        // commit still receives its acknowledgement; new requests are refused.
        try { settingsPersistence = await saveSettings(settingsStore); }
        catch (error) {
          warn('settings persist failed', error);
          // Live effects already happened; do not pretend a failed write rolled them back.
          sendJson(res, 503, { error: 'settings-save-failed', appliedSettings: responseSettings }); return;
        }
        if (memorySaveFailed) { sendJson(res, 503, { error: 'memory-save-failed', appliedSettings: responseSettings }); return; }
      }
      sendJson(res, 200, {
        settings: responseSettings ?? settings,
        settingsPersistence,
        memory: readerMemoryLines(),
        memoryStats: memoryStats(),
        // Returned so the page can show which preset the edit landed in — an
        // edit to the builtin forks a new preset, and the user has to see that.
        presets: getPresets().map(presetForClient),
        sessionSwitches: sessionSwitchState(),
      });
      return;
      } finally { complete(); }
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
