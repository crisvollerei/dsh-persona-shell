import { normalizePack } from './pack.js';
import { buildExtractPrompt, parseGeneratedPreset } from './preset.js';
import { randomUUID } from 'node:crypto';
import { buildMemoryPrompt } from './memory-consolidation.js';
import { resolvePersonaExpression } from './persona-expression.js';
import { roomCharacterContext } from './character-roster.js';
import { avatarUrl } from './avatar.js';
import { personaTrial } from './persona-preview.js';

export function createHostMemoryPresets({
  activeExtractions, activePresetId, builtinAvatarOverrides, cfg, DEFAULT_PRESET_NAME,
  expressionLlm, MAX_PRESETS, getPresets, setPresets, getPresetWrites, setPresetWrites,
  resolveRouteAsync, settings, getSettingsRestored, getSettingsWrites, setSettingsWrites, getStore,
  getStoreClosing, getStoreState, streamWithSignal, waitWithSignal, warn,
}) {
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
    const active = getPresets().find((preset) => preset.name === settings.presetName);

    if (active !== undefined && active.builtin !== true) {
      const updated = { ...active, pack, at: Date.now() };
      await commitPresetChange({ entry: updated });
      setPresets(getPresets().map((preset) => (preset.id === active.id ? updated : preset)));
      return pack;
    }

    if (getPresets().length >= MAX_PRESETS) throw new Error('too-many-presets');

    // Fork from the active shipped preset (or from a name that no longer resolves).
    const base = active?.builtin === true
      ? (active.name === DEFAULT_PRESET_NAME ? '自定义' : active.name)
      : settings.presetName;
    let name = `${base} 2`;
    for (let index = 3; getPresets().some((preset) => preset.name === name); index += 1) {
      name = `${base} ${index}`;
    }
    if (active?.builtin === true) {
      const chat = resolvePersonaExpression(active.pack,{channel:'chat',persona:active});
      const report = resolvePersonaExpression(active.pack,{channel:'report',persona:active});
      const inherited = Object.fromEntries(['report','voice','samples']
        .filter(key=>JSON.stringify(pack[key])===JSON.stringify(active.pack[key])).map(key=>[key,report[key]]));
      pack = normalizePack({...pack,...inherited,chat:{voice:chat.voice,samples:chat.samples,
        dialogueExamples:chat.dialogueExamples,workDialogueExamples:chat.workDialogueExamples,gender:chat.gender,...pack.chat}});
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
    setPresets([...getPresets(), forked]);
    settings.presetName = name;
    return pack;
  }

  /** Persist the durable switches and route. */
  function saveSettings(opened = getStore()) {
    // Before restore, only pendingSettings may override the stored snapshot.
    if (opened === undefined || !getSettingsRestored()) {
      return Promise.resolve(getStoreState() === 'opening' ? 'pending' : 'memory-only');
    }
    const snapshot = {
      enabled: settings.enabled,
      includeToolSteps: settings.includeToolSteps,
      colloquialReports: settings.colloquialReports,
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
      chatResearchEnabled:settings.chatResearchEnabled,chatDeepReasoningEnabled:settings.chatDeepReasoningEnabled,chatDeepReasoningProvider:settings.chatDeepReasoningProvider,chatDeepReasoningModel:settings.chatDeepReasoningModel,
      chatSummarizeEnabled:settings.chatSummarizeEnabled,
      chatProvider:settings.chatProvider,chatModel:settings.chatModel,chatThinking:settings.chatThinking,
      chatReasoningEffort:settings.chatReasoningEffort,
      visualizationProvider:settings.visualizationProvider,visualizationModel:settings.visualizationModel,
      visualizationThinking:settings.visualizationThinking,
      readableThinking:settings.readableThinking,
    };
    // Capture before waiting: concurrent requests must keep their acceptance order.
    const task = getSettingsWrites().then(() => opened.putSettings(snapshot)).then(() => 'saved');
    setSettingsWrites(task.catch(() => {}));
    return task;
  }

  function queuePresetWrite(write) {
    const opened = getStore();
    const task = getPresetWrites().catch(() => {}).then(() => write(opened));
    setPresetWrites(task.catch(() => {}));
    return task;
  }

  async function commitPresetChange({ entry, removeId, activeId }) {
    if (getStoreClosing() || getStoreState() === 'opening') throw new Error('storage-not-ready');
    if (!getStore()) return; // Existing hosts without storage retain their explicit memory-only mode.
    const previous = getPresets().find((p) => p.id === (entry?.id ?? removeId));
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
    if (getStoreClosing()) throw new Error('storage-not-ready');
  }

  /** Strip the internal fields before sending a preset to the page. */
  function presetForClient(preset) {
    const character=roomCharacterContext(preset,getPresets().filter(p=>p.builtin===true));
    return {
      id: preset.id,
      name: preset.name,
      pack: preset.pack,
      builtin: preset.builtin === true,
      avatar: avatarUrl(preset),
      avatarOverridden: preset.builtin === true && builtinAvatarOverrides.has(preset.id),
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
      if (getStoreClosing()) throw new Error('disposed');
      const route = await waitWithSignal(resolveRouteAsync(sessionId,abort.signal), abort.signal);
      abort.signal.throwIfAborted();
      if (getStoreClosing()) throw new Error('disposed');
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
      if (getStoreClosing()) throw new Error('disposed');
      if (finish !== 'stop') return { ok: false, reason: `finish-${finish ?? 'missing'}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'extract-failed' };
    } finally {
      clearTimeout(timer);
      abort.abort();
      activeExtractions.delete(abort);
    }
    return parseGeneratedPreset(collected, personaPrompt);
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
      if (getStoreClosing()) throw new Error('disposed');
      const llm = expressionLlm('memory');
      if (!llm) throw new Error('no-llm');
      const route = await waitWithSignal(resolveRouteAsync(batch.routeSessionId??batch.sources[0].sessionId,abort.signal), abort.signal);
      abort.signal.throwIfAborted();
      if (!route || getStoreClosing()) throw new Error('no-route');
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

  async function previewPersona(body,sessionId,res) {
    if(getStoreClosing())throw Error('preview-unavailable');
    const persona=getPresets().find(p=>p.id===body.personaId);
    const trial=personaTrial({mode:body.mode,pack:body.pack,name:persona?.name??'预览人格',persona});
    const controller=new AbortController();activeExtractions.add(controller);
    const stop=()=>controller.abort(Error('preview-cancelled'));res.once?.('close',stop);
    const deadline=setTimeout(stop,cfg.timeoutMs);
    try {
      const route=await waitWithSignal(resolveRouteAsync(sessionId,controller.signal),controller.signal);
      const llm=expressionLlm('persona-preview');if(!llm || !route)throw Error('preview-unavailable');
      let wire='',finish;
      const messages=trial.messages??[{role:'user',content:[{type:'text',text:trial.user}]}];
      for await(const chunk of streamWithSignal(llm,{...route,system:trial.system,messages,signal:controller.signal,maxTokens:1024})){
        if(chunk.type==='error'||chunk.type.startsWith('tool-call')||chunk.block?.type==='tool-call'||chunk.blockType==='tool-call')throw Error('preview-format');
        if(chunk.type==='text-delta')wire+=chunk.text;if(wire.length>12000)throw Error('preview-format');
        if(chunk.type==='finish')finish=chunk.reason?.kind;
      }
      controller.signal.throwIfAborted();if(finish!=='stop')throw Error('preview-incomplete');
      return {original:trial.original,...trial.check(wire)};
    }finally{clearTimeout(deadline);res.off?.('close',stop);controller.abort();activeExtractions.delete(controller);}
  }

  return {
    commitPresetChange, extractPreset, persistActivePack, presetForClient, queuePresetWrite,
    saveSettings, extractMemories,previewPersona,
  };
}
