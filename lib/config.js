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
  /** Accumulate and use cross-session observations about the reader. */
  memory: true,
  /**
   * Subagent sessions are separate conversations the user rarely reads: a spawned
   * helper's mid-task narration and its final answer. Both default to off, as two
   * switches, because "its progress chatter is not worth rewriting" and "its
   * conclusion might be" are different judgements.
   */
  subagentSteps: false,
  subagentReports: false,
  provider: '',
  model: '',
  reasoningEffort: '',
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
    memory: pick('memory', (value) => typeof value === 'boolean'),
    subagentSteps: pick('subagentSteps', (value) => typeof value === 'boolean'),
    subagentReports: pick('subagentReports', (value) => typeof value === 'boolean'),
    provider: text('provider').trim(),
    model: text('model').trim(),
    reasoningEffort: text('reasoningEffort').trim(),
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
