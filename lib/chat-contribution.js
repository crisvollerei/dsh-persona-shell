/** One local conversational task, never a fact, quotation or execution grant. */
const MOVES = new Set(['answer', 'ask', 'opine', 'react', 'develop', 'branch', 'correct']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Return a fresh bounded task, or null; never certify a partially valid task. */
export function normalizeChatContribution(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== 2) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (!Object.hasOwn(fields.move ?? {}, 'value') || !Object.hasOwn(fields.point ?? {}, 'value')) return null;
    const move = fields.move.value, point = fields.point.value;
    if (!MOVES.has(move) || typeof point !== 'string' || point.length > 180
      || CONTROL.test(point) || !point.trim()) return null;
    return { move, point: point.trim() };
  } catch { return null; }
}
