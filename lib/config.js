/**
 * Config validation.
 *
 * Cordis resolves a plugin's `Config` through the Standard Schema interface
 * (`Config['~standard'].validate`), so the row schema is written to that
 * contract instead of importing a schema library: this package is installed by
 * linking the workspace directory into the profile, which installs no
 * dependencies of its own.
 */

/** Defaults resolved once, in one place. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  trigger: 'step',
  /** Rewrite the narration a step emits right before it calls tools. */
  includeToolSteps: true,
  /** Use natural spoken phrasing for report prose without summarizing its facts. */
  colloquialReports: true,
  /** Allow process rewrites to query frozen tool counts, work nature and session pacing. */
  processToolUsage: false,
  /** Accumulate and use cross-session observations about the reader. */
  memory: true,
  /** Opt in to sending bounded user excerpts for background candidate extraction. */
  memoryExtraction: false,
  /** Show a discreet original-text hint for unusually changed final rewrites. */
  reviewHints: true,
  reviewThreshold: 0.55,
  /** Optional observation-only notices while a viewed main turn is quiet. */
  progressNotices: false,
  progressMinutes: 5,
  /**
   * Subagent sessions are separate conversations the user rarely reads: a spawned
   * helper's mid-task narration and its final answer. Both default to off, as two
   * switches, because "its progress chatter is not worth rewriting" and "its
   * conclusion might be" are different judgements.
   */
  subagentSteps: false,
  subagentReports: false,
  /**
   * Serve the plugin's routes when the Connection service is absent.
   *
   * Off by default: `webServer` has no authentication of its own, so a route with
   * no way to check a request must refuse it. Turn this on only in a deployment
   * that knowingly runs without Connection and wants the routes anyway.
   */
  allowUnauthenticatedRoutes: false,
  provider: '',
  model: '',
  /** Empty selects off when supported, otherwise the lowest advertised effort. */
  reasoningEffort: '',
  /** Chat follows the rewrite route unless explicitly overridden. */
  chatProvider: '',
  chatModel: '',
  chatThinking: true,
  /** Empty uses the selected model's published thinking default. */
  chatReasoningEffort: '',
  visualizationProvider: '',
  visualizationModel: '',
  visualizationThinking: false,
  /** Readable prose polishing uses the model's thinking default independently. */
  readableThinking: true,
  maxRewriteChars: 6000,
  maxRatio: 1.35,
  timeoutMs: 45000,
  keepSamples: 2,
  maxRowsPerSession: 240,
});

/**
 * Fill a raw row config with defaults and drop values of the wrong type, so a
 * hand-edited `cordis.patch.yml` cannot put the plugin into an incoherent state.
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const pick = (key, test) => (test(source[key]) ? source[key] : DEFAULTS[key]);

  const number = (key, min, max) => pick(key, (value) => typeof value === 'number' && Number.isFinite(value)
    && value >= min && value <= max);
  const text = (key) => pick(key, (value) => typeof value === 'string');

  return {
    enabled: pick('enabled', (value) => typeof value === 'boolean'),
    trigger: pick('trigger', (value) => value === 'step' || value === 'report'),
    includeToolSteps: pick('includeToolSteps', (value) => typeof value === 'boolean'),
    colloquialReports: pick('colloquialReports', (value) => typeof value === 'boolean'),
    processToolUsage: pick('processToolUsage', (value) => typeof value === 'boolean'),
    memory: pick('memory', (value) => typeof value === 'boolean'),
    memoryExtraction: pick('memoryExtraction', (value) => typeof value === 'boolean'),
    reviewHints: pick('reviewHints', (value) => typeof value === 'boolean'),
    reviewThreshold: number('reviewThreshold', 0, 1),
    progressNotices: pick('progressNotices', (value) => typeof value === 'boolean'),
    progressMinutes: pick('progressMinutes', (value) => Number.isInteger(value) && value >= 1 && value <= 60),
    subagentSteps: pick('subagentSteps', (value) => typeof value === 'boolean'),
    subagentReports: pick('subagentReports', (value) => typeof value === 'boolean'),
    allowUnauthenticatedRoutes: pick('allowUnauthenticatedRoutes', (value) => typeof value === 'boolean'),
    provider: text('provider').trim(),
    model: text('model').trim(),
    reasoningEffort: text('reasoningEffort').trim(),
    chatProvider: text('chatProvider').trim(),
    chatModel: text('chatModel').trim(),
    chatThinking: pick('chatThinking', value=>typeof value==='boolean'),
    chatReasoningEffort: pick('chatReasoningEffort',value=>typeof value==='string'&&value.trim().length<=128).trim(),
    visualizationProvider: text('visualizationProvider').trim(),
    visualizationModel: text('visualizationModel').trim(),
    visualizationThinking: pick('visualizationThinking', value=>typeof value==='boolean'),
    readableThinking: pick('readableThinking', value=>typeof value==='boolean'),
    maxRewriteChars: number('maxRewriteChars', 200, 60000),
    maxRatio: number('maxRatio', 1, 4),
    timeoutMs: number('timeoutMs', 1000, 300000),
    keepSamples: number('keepSamples', 0, 8),
    maxRowsPerSession: number('maxRowsPerSession', 20, 5000),
  };
}

/**
 * The row's `Config` in Standard Schema form. `resolveConfig` is total, so
 * validation never reports issues: a mistyped field falls back to its default
 * rather than disabling the plugin.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'persona-shell',
    validate: (value) => ({ value: resolveConfig(value) }),
  },
};
