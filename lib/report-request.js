import { hasBuiltinExpressionProfile, resolvePersonaExpression } from './persona-expression.js';

/**
 * Prepare one report's expression and acceptance context without I/O or state.
 * `pack` is the persisted card; persona provenance and sourceIsSubagent come
 * from the Host. An explicit sourceLabel remains a trusted caller override for
 * existing prompt callers. Without it, a real helper source uses this card's
 * helper name. Report text itself cannot select the author or authenticate a card.
 *
 * maxRatio is the caller's already-selected budget (including any retry floor).
 * Validators add their own original/candidate at use time: masked for structural
 * validation, restored report prose for fidelity. This helper does not mask text,
 * choose a model, read memory, generate, validate semantics, or persist anything.
 */
export function prepareReportRequest({ pack, persona, masked, literalCount, history = [], memory = [],
  processTools = false, feedback = '', sourceLabel, sourceIsSubagent = false,
  colloquialReports = true, maxRatio = 1.3 }) {
  const builtin = hasBuiltinExpressionProfile(pack, persona);
  let expression = resolvePersonaExpression(pack, { channel: 'report', persona });
  const child = sourceIsSubagent === true;
  const relay = expression.narration?.mode === 'relay';
  const mainWorkerLabel = expression.narration?.assistant;
  const subagentLabel = expression.address.subagent;
  const actualSourceLabel = sourceLabel ?? (child ? subagentLabel : undefined);
  const workerLabel = actualSourceLabel ?? mainWorkerLabel ?? '原助手';
  const source = { sourceIsSubagent: child, sourceLabel: actualSourceLabel,
    workerLabel, mainWorkerLabel, subagentLabel, relay, voice: !relay };

  // Instantiate only trusted builtin work-report material. Identity, social
  // relationships, avoid rules, custom cards and saved examples stay untouched.
  if (builtin && relay && typeof mainWorkerLabel === 'string' && mainWorkerLabel
    && typeof actualSourceLabel === 'string' && actualSourceLabel.trim() && actualSourceLabel !== mainWorkerLabel) {
    const name = line => line.split(mainWorkerLabel).join(actualSourceLabel);
    expression = { ...expression, report: expression.report.map(name), samples: expression.samples.map(sample => {
      const split = sample.indexOf('\n表达：');
      return split < 0 ? sample : sample.slice(0, split) + name(sample.slice(split));
    }) };
  }

  return {
    expression,
    source,
    promptOptions: { expression, source, masked, literalCount, history: [...history], memory: [...memory],
      processTools, feedback, colloquialReports, maxRatio },
    validationOptions: { literalCount, maxRatio },
    fidelityOptions: { relay, workerLabel, mainWorkerLabel, voice: !relay,
      subagentLabel, sourceIsSubagent: child, allowEquivalentQuantities: true },
  };
}
