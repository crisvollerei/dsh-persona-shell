/** Local policy for this plugin's expression calls; never changes the working agent's LLM. */
import { imageInputStatus } from './chat-images.js';
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

/** Public model controls only; no provider credentials, arbitrary metadata or guessed levels. */
export function reasoningOptions(model) {
  const valid=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
  const efforts=[],seen=new Set();
  for(const option of (Array.isArray(model?.reasoning?.efforts)?model.reasoning.efforts:[]).slice(0,32)){
    if(!valid(option?.id,128)||seen.has(option.id))continue;
    seen.add(option.id);efforts.push({id:option.id,name:valid(option.name,160)?option.name:option.id});
  }
  const defaultEffort=seen.has(model?.reasoning?.defaultEffort)?model.reasoning.defaultEffort:null;
  return{status:efforts.some(option=>option.id!=='off')?'available':efforts.length?'unavailable':'unknown',efforts,defaultEffort};
}

function selectEffort(model, requested, thinking,thinkingRequired=false) {
  const metadata=reasoningOptions(model),ids=metadata.efforts.map(option=>option.id);
  if (!ids.length) {
    if(thinkingRequired)throw Error('expression-thinking-unavailable');
    return { mode: 'provider-default', effective: undefined, reason: thinking===true?'thinking-capability-unknown':'no-selectable-efforts' };
  }
  if(thinking===true){
    if(requested&&requested!=='off'&&ids.includes(requested))return{mode:'thinking',effective:requested,reason:'explicit'};
    const enabled=ids.find(id=>id!=='off');
    if(!enabled){if(thinkingRequired)throw Error('expression-thinking-unavailable');return{mode:'off',effective:'off',reason:'thinking-unavailable'};}
    if(metadata.defaultEffort&&metadata.defaultEffort!=='off')return{mode:'thinking',effective:metadata.defaultEffort,reason:'chat-model-default'};
    if(metadata.defaultEffort==='off')return{mode:'thinking',effective:enabled,reason:'chat-default-off'};
    if(thinkingRequired)return{mode:'thinking',effective:enabled,reason:'required-enabled-effort'};
    // Advertising controls does not reveal the provider's default. Do not pick
    // an arbitrary grade or label the resulting draft as definitely thinking.
    return{mode:'provider-default',effective:undefined,reason:'thinking-default-unknown'};
  }
  if (requested && ids.includes(requested)) return { mode: 'custom', effective: requested, reason: 'explicit' };
  if (ids.includes('off')) return { mode: 'off', effective: 'off', reason: requested ? 'unsupported-custom' : 'default' };
  // The official metadata orders efforts from least to greatest. No guessed aliases.
  return { mode: ids.length ? 'minimum' : 'provider-default', effective: ids[0],
    reason: requested ? 'unsupported-custom' : 'off-unavailable' };
}

/** Freeze one preference and one compatibility-retry budget across a logical request and tool continuation. */
export function createExpressionLlm(llm, { reasoningEffort = '', thinking,thinkingRequired=false, onDecision = () => {}, onDispatch = () => {}, onAttempt } = {}) {
  const requested = thinking===false ? '' : typeof reasoningEffort === 'string' ? reasoningEffort.trim() : '';
  let fallback = false, retried = false, exposed = false;
  return {
    async *stream(options) {
      while (true) {
        options.signal?.throwIfAborted();
        let attempted;
        try {
          const controls = controlsOf(options);
          let plan, source, omitImages=false;
          const configure = (proposed, model) => {
            if(options.messages?.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='image'))&&imageInputStatus(model)==='unsupported'){
              if(options.imageInputRequired!==false)throw Error('chat-vision-unavailable');
              omitImages=true;
            }
            plan = fallback ? { mode: 'provider-default', effective: undefined, reason: 'compatibility-retry' }
              : selectEffort(model, requested, thinking,thinkingRequired);
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
            if(thinkingRequired)throw Error('expression-thinking-unavailable');
            // Old hosts expose no exact metadata. Probe off; only a typed parameter rejection may retry.
            attempted = fallback || thinking===true ? undefined : requested || 'off';
            plan = { mode: fallback || thinking===true ? 'provider-default' : requested ? 'custom' : 'probe-off', effective: attempted,
              reason: fallback ? 'compatibility-retry' : thinking===true ? 'thinking-capability-unknown' : 'metadata-unavailable' };
            selected = { ...controls, ...(attempted === undefined ? {} : { reasoningEffort: attempted }) };
            source = (next) => llm.stream(next);
          }
          const next = { ...options };
          delete next.imageInputRequired;
          if(omitImages)next.messages=options.messages.map(message=>({...message,content:message.content.map(block=>block.type==='image'
            ?{type:'text',text:'此前的用户图片：当前模型不支持视觉，未提供图像内容；不要据此声称看到了图片。'}:block)}));
          delete next.reasoningEffort;
          Object.assign(next, selected);
          if(thinkingRequired&&(!next.reasoningEffort||next.reasoningEffort==='off'))throw Error('expression-thinking-unavailable');
          // A prepared call binds its resolved config to its adapter. Do not
          // alter those controls after preparation, including a provider default
          // filled by the SDK. Our plan remains unknown when metadata is absent.
          onDecision({ provider: next.provider, model: next.model, requested,
            ...plan, effective: next.reasoningEffort ?? null, fallback });
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
                if(thinkingRequired)throw Error('expression-thinking-unavailable');
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
          if(thinkingRequired&&unsupportedEffort(error))throw Error('expression-thinking-unavailable');
          if (attempted === undefined || retried || exposed || !unsupportedEffort(error)) throw error;
        }
        retried = true; fallback = true;
      }
    },
  };
}
