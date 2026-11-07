/** Local policy for this plugin's expression calls; never changes the working agent's LLM. */
const unsupportedEffort = (error) => error?.code === 'UNSUPPORTED_REASONING_EFFORT';
const controlsOf = ({ provider, model, temperature, maxTokens, stop }) => ({ provider, model,
  ...(temperature === undefined ? {} : { temperature }), ...(maxTokens === undefined ? {} : { maxTokens }),
  ...(stop === undefined ? {} : { stop }) });

function waitFor(value, signal) {
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function selectEffort(model, requested, thinking) {
  const efforts = model?.reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return { mode: 'provider-default', effective: undefined, reason: 'no-selectable-efforts' };
  }
  const ids = efforts.map((e) => e?.id).filter((id) => typeof id === 'string' && id !== '');
  if(thinking===true){const enabled=ids.find(id=>id!=='off');
    return enabled?{mode:'thinking',effective:enabled,reason:'chat-enabled'}
      :{mode:'off',effective:ids[0],reason:'thinking-unavailable'};}
  if (requested && ids.includes(requested)) return { mode: 'custom', effective: requested, reason: 'explicit' };
  if (ids.includes('off')) return { mode: 'off', effective: 'off', reason: requested ? 'unsupported-custom' : 'default' };
  // The official metadata orders efforts from least to greatest. No guessed aliases.
  return { mode: ids.length ? 'minimum' : 'provider-default', effective: ids[0],
    reason: requested ? 'unsupported-custom' : 'off-unavailable' };
}

/** Freeze one preference and one compatibility-retry budget across a logical request and tool continuation. */
export function createExpressionLlm(llm, { reasoningEffort = '', thinking, onDecision = () => {}, onDispatch = () => {}, onAttempt } = {}) {
  const requested = thinking===false ? '' : typeof reasoningEffort === 'string' ? reasoningEffort.trim() : '';
  let fallback = false, retried = false, exposed = false;
  return {
    async *stream(options) {
      while (true) {
        options.signal?.throwIfAborted();
        let attempted;
        try {
          const controls = controlsOf(options);
          let plan, source;
          const configure = (proposed, model) => {
            plan = fallback ? { mode: 'provider-default', effective: undefined, reason: 'compatibility-retry' }
              : selectEffort(model, requested, thinking);
            const next = { ...proposed };
            delete next.reasoningEffort;
            attempted = plan.effective;
            if (attempted !== undefined) next.reasoningEffort = attempted;
            return next;
          };
          let selected;
          if (typeof llm.prepareCall === 'function') {
            const prepared = await waitFor(llm.prepareCall(controls, options.signal, configure), options.signal);
            options.signal?.throwIfAborted();
            selected = prepared.config;
            source = (next) => prepared.stream(next);
          } else if (typeof llm.resolveModelInfo === 'function') {
            const model = await waitFor(llm.resolveModelInfo(options.provider, options.model, options.signal), options.signal);
            options.signal?.throwIfAborted();
            selected = configure(controls, model);
            source = (next) => llm.stream(next);
          } else {
            // Old hosts expose no exact metadata. Probe off; only a typed parameter rejection may retry.
            attempted = fallback || thinking===true ? undefined : requested || 'off';
            plan = { mode: fallback || thinking===true ? 'provider-default' : requested ? 'custom' : 'probe-off', effective: attempted,
              reason: fallback ? 'compatibility-retry' : thinking===true ? 'thinking-capability-unknown' : 'metadata-unavailable' };
            selected = { ...controls, ...(attempted === undefined ? {} : { reasoningEffort: attempted }) };
            source = (next) => llm.stream(next);
          }
          const next = { ...options };
          delete next.reasoningEffort;
          Object.assign(next, selected);
          onDecision({ provider: next.provider, model: next.model, requested,
            ...plan, effective: selected.reasoningEffort ?? null, fallback });
          options.signal?.throwIfAborted();
          onDispatch();
          // One receipt per physical stream, after route preparation and all dispatch gates.
          // In particular a compatibility retry and a tool continuation each cost another call.
          const attempt = onAttempt?.({ provider: next.provider, model: next.model });
          let retry = false, finished = false;
          const onAbort = () => attempt?.finish(finished);
          if (attempt) options.signal?.addEventListener('abort', onAbort, { once: true });
          try {
            for await (const chunk of source(next)) {
              options.signal?.throwIfAborted();
              if (chunk.type === 'usage') attempt?.usage(chunk.usage);
              if (chunk.type === 'finish') finished = ['stop', 'tool-calls'].includes(chunk.reason?.kind);
              const failure = chunk.type === 'finish' && chunk.reason?.kind === 'error'
                ? chunk.reason.failure : chunk.type === 'error' ? chunk.error ?? chunk.failure : undefined;
              if (attempted !== undefined && !retried && !exposed && unsupportedEffort(failure)) {
                retry = true; break;
              }
              exposed = true;
              yield chunk;
            }
          } catch (error) {
            finished = false;
            throw error;
          } finally {
            // A stalled adapter may never reach here; abort above also settles once.
            if (attempt) options.signal?.removeEventListener('abort', onAbort);
            attempt?.finish(finished);
          }
          if (!retry) return;
        } catch (error) {
          options.signal?.throwIfAborted();
          if (attempted === undefined || retried || exposed || !unsupportedEffort(error)) throw error;
        }
        retried = true; fallback = true;
      }
    },
  };
}
