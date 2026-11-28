import { buildReportEmphasisPrompt, validateReportEmphasis } from './report-emphasis.js';
import { buildReportReadablePrompt, parseReportReadable, REPORT_READABLE_LIMITS } from './report-readable.js';
import { createReportReadingPlan } from './report-reading.js';
import { reportViewIssue } from './report-views.js';
import { buildReportVisualizationPrompt, validateReportVisualization } from './report-visualization.js';

const reportKey = (id, seq) => JSON.stringify([id, seq]);
const requestKey = (id, seq, requestId, presentation) => JSON.stringify([id, seq, requestId, presentation]);
const cancelKey = (key, hash = null) => JSON.stringify([key, hash]);

/** Coordinate reading jobs for one Host instance. Source capture and cache writes belong to views. */
export function createReportViewJobs({ views, getSettings, timeoutMs, readableTimeoutMs, resolveRoute,
  createLlm, waitWithSignal, streamWithSignal, trackModelTask, isClosing }) {
  const active = new Map();
  const receipts = new Map();
  const cancelled = new Set();

  function pruneReceipts() {
    // Retain bounded idempotency receipts, including failures, while never evicting a live request.
    for (const [id, receipt] of receipts) {
      if (receipts.size > 128 && ![...active.values()].some(job => job.requestKey === receipt.key)) receipts.delete(id);
    }
  }

  function state(id, seq, presentation = 'summary') {
    const current = views.read(id, seq, presentation);
    const version = presentation === 'readable' ? 3 : presentation === 'emphasis' ? 2 : 1;
    const matches = current.result?.schemaVersion === version;
    return { ...current, result: matches ? current.result : undefined, cached: matches,
      warnings: matches ? current.warnings : undefined, unreferenced: matches ? current.unreferenced : undefined,
      model: matches ? current.model : undefined, generatedAt: matches ? current.generatedAt : undefined,
      readingPlan: presentation === 'emphasis' && current.source
        ? createReportReadingPlan(current.source, matches ? current.result : undefined) : undefined,
      presentation, running: active.has(reportKey(id, seq)) };
  }

  async function generate(body) {
    const { sessionId, seq, sourceHash, requestId } = body;
    const presentation = body.presentation ?? 'summary';
    const key = reportKey(sessionId, seq);
    const request = requestKey(sessionId, seq, requestId, presentation);
    const regenerate = body.regenerate === true;
    const previous = receipts.get(requestId);
    if (previous) {
      if (previous.key !== request || previous.hash !== sourceHash || previous.regenerate !== regenerate) throw Error('report-request-conflict');
      return previous.task;
    }
    if (cancelled.has(cancelKey(request, sourceHash)) || cancelled.has(cancelKey(request))) throw Error('report-cancelled');
    const current = state(sessionId, seq, presentation);
    if (!current.available) throw Error(current.reason);
    if (current.source.hash !== sourceHash) throw Error('report-source-changed');
    if (current.cached && !regenerate) {
      receipts.set(requestId, { key: request, hash: sourceHash, regenerate, task: Promise.resolve(current) });
      pruneReceipts();
      return current;
    }
    if (active.has(key)) throw Error('report-busy');
    if (active.size >= 3) throw Error('report-capacity');

    const abort = new AbortController();
    const { signal } = abort;
    const job = { abort, requestKey: request, saving: false };
    const source = current.source;
    const settings = getSettings();
    const readable = presentation === 'readable';
    const options = { provider: settings.provider, model: settings.model,
      thinking: readable ? settings.readableThinking !== false : settings.visualizationThinking === true,
      thinkingRequired: readable && settings.readableThinking !== false };
    active.set(key, job);
    const timer = setTimeout(() => abort.abort(Error('report-timeout')), readable ? readableTimeoutMs : timeoutMs);
    timer.unref?.();
    const valid = () => {
      signal.throwIfAborted();
      if (isClosing()) throw Error('report-cancelled');
      const latest = views.read(sessionId, seq);
      if (!latest.available || latest.source.hash !== sourceHash) throw Error('report-source-changed');
    };

    const task = (async () => {
      try {
        const route = await resolveRoute(sessionId, { provider: options.provider, model: options.model }, {
          signal, reportRoute: views.route(sessionId, seq), overrideSource: 'reading',
        });
        valid();
        const llm = createLlm(valid, options);
        if (!route || !llm) throw Error('report-model-unavailable');
        const prompt = readable ? buildReportReadablePrompt(source)
          : presentation === 'emphasis' ? buildReportEmphasisPrompt(source) : buildReportVisualizationPrompt(source);
        let text = '', finish;
        for await (const chunk of streamWithSignal(llm, { ...route, system: prompt.system, messages: prompt.messages,
          temperature: 0.15, maxTokens: readable ? (options.thinking ? 24576 : 16384)
            : options.thinking ? 12288 : 8192, signal })) {
          valid();
          if (chunk.type === 'text-delta') {
            text += chunk.text;
            if (text.length > (readable ? REPORT_READABLE_LIMITS.wireChars : 48000)) {
              throw Object.assign(Error('report-invalid-output'), { issue: { code: 'wire-too-long', path: '$' } });
            }
          } else if (chunk.type === 'finish') finish = chunk.reason?.kind;
          else if (chunk.type === 'error' || chunk.type === 'tool-call') throw Error('report-generation-failed');
        }
        valid();
        if (finish !== 'stop') throw Error('report-incomplete');
        const parsed = readable ? parseReportReadable(text, source, { replacingDraft: current.cached && regenerate })
          : presentation === 'emphasis' ? validateReportEmphasis(text, source) : validateReportVisualization(text, source);
        if (!parsed.ok) throw Object.assign(Error('report-invalid-output'), { issue: reportViewIssue(parsed.issue) });
        try {
          await waitWithSignal(views.cache(sessionId, seq, sourceHash, parsed.value, route, parsed, () => {
            valid();
            job.saving = true;
            clearTimeout(timer);
          }), signal);
        } catch (error) {
          throw Error(error.message === 'report-source-changed' ? error.message : 'report-save-failed');
        }
        const saved = state(sessionId, seq, presentation);
        if (!saved.cached || saved.source?.hash !== sourceHash) throw Error('report-source-changed');
        return { ...saved, running: false };
      } catch (error) {
        const reason = signal.aborted ? signal.reason?.message : error?.message;
        throw Object.assign(Error(reason === 'expression-thinking-unavailable' ? 'report-thinking-unavailable'
          : /^report-/.test(reason ?? '') ? reason : 'report-generation-failed'),
        { issue: reason === 'report-invalid-output' ? reportViewIssue(error?.issue) : undefined });
      } finally {
        clearTimeout(timer);
        abort.abort();
        if (active.get(key) === job) active.delete(key);
      }
    })();
    const tracked = trackModelTask(task);
    receipts.set(requestId, { key: request, hash: sourceHash, regenerate, task: tracked });
    pruneReceipts();
    return tracked;
  }

  function cancel({ sessionId, seq, requestId, presentation = 'summary', sourceHash }) {
    const request = requestKey(sessionId, seq, requestId, presentation);
    const receipt = receipts.get(requestId);
    if (receipt && (receipt.key !== request || (sourceHash !== undefined && receipt.hash !== sourceHash))) {
      throw Error('report-request-conflict');
    }
    const job = active.get(reportKey(sessionId, seq));
    const matchingJob = job?.requestKey === request ? job : undefined;
    if (matchingJob?.saving) return 'saving';
    if (receipt && !matchingJob) return 'settled';

    // Cancellation can arrive before generation. A missing hash matches the exact legacy request.
    cancelled.add(cancelKey(request, receipt?.hash ?? sourceHash));
    while (cancelled.size > 128) cancelled.delete(cancelled.values().next().value);
    matchingJob?.abort.abort(Error('report-cancelled'));
    return 'cancelled';
  }

  function dispose() {
    for (const job of active.values()) if (!job.saving) job.abort.abort(Error('disposed'));
    receipts.clear();
    cancelled.clear();
  }

  return { state, generate, cancel, dispose };
}
