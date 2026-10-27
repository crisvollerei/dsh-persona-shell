/**
 * Persona presets.
 *
 * A preset is a named pack plus the prompt it was generated from. Two ways to
 * fill one: hand-edit the fields, or paste a persona prompt and let the model
 * compress it into the card shape. Either way the result is the same object, so
 * switching presets is just swapping `pack`.
 *
 * The generation path is the interesting one, and its whole difficulty is that
 * a chat persona prompt and a *report shell* want different things. A typical
 * persona prompt spends most of its words on appearance, backstory and how to
 * behave while chatting with someone — none of which a rewrite can use, since a
 * rewrite only re-voices a technical report. So the generator's job is
 * translation, not summary: keep the voice, drop the roleplay, and produce the
 * rules that keep the character from eating the content.
 */

/**
 * The schema a generated preset must satisfy, as a readable contract.
 *
 * Kept next to the code the prompt builder uses so the two cannot drift: if a
 * field is added to `DEFAULT_PACK`, this list is what the generator is told to
 * fill.
 */
export const PRESET_FIELDS = [
  { key: 'name', description: '预设名称，4-12 字，能一眼认出角色' },
  { key: 'identity', description: '身份与自称，2-3 句。必须写明第一人称用什么词' },
  { key: 'report', description: '工作汇报里的说话规则，3-6 条' },
  { key: 'voice', description: '通用语感，3-6 条' },
  { key: 'samples', description: '语气示例，3-5 句，体现角色说话的样子' },
  { key: 'avoid', description: '语气禁区，2-5 条' },
  {
    key: 'address',
    description: '称呼，只放称呼词本身：「user」对用户（通常是"你"）、「subagent」对子代理。'
      + '不要写解释、括号或条件说明——这个值会被直接放进句子',
  },
];

/**
 * Build the extraction prompt.
 *
 * Deliberately explicit about what to throw away. Left to itself a model writes
 * a summary of the persona prompt, appearance and all, and the resulting card
 * says nothing about how a sentence should sound.
 * @param {string} personaPrompt - the user's own persona description, verbatim.
 * @returns {{ system: string, user: string }}
 */
export function buildExtractPrompt(personaPrompt) {
  const system = [
    '你要把一段「聊天人设」改写成一张「汇报改写人格卡」。',
    '',
    '关键区别：这张卡不是用来和用户聊天的，而是用来把工程助手的**技术汇报**换一种口气重讲一遍。',
    '所以只保留「说话风格」，丢掉所有只在闲聊里才用得上的东西。',
    '',
    '## 必须丢掉',
    '- 外貌描写（发色、瞳色、服装、体型）—— 改写正文时用不上',
    '- 背景故事、出身设定 —— 同上',
    '- 陪聊行为准则（怎么安慰人、什么时候撒娇）—— 改写汇报时不会出现',
    '- 梗的完整解释 —— 只留用法',
    '',
    '## 必须保留并转写',
    '- 第一人称用什么词（例如「本鱼」「鲸鲸」「吾」）—— 这是最重要的信号',
    '- 句子长短、语气、口癖、说话节奏',
    '- 对用户的称呼',
    '- 一个能让人听出角色的说话样本',
    '- 明确的禁区：不骂人、不默认恋爱关系等',
    '',
    '## 特别注意：汇报场景',
    '`report` 这一段描述「在一份技术汇报里该怎么说话」，与闲聊不同：',
    '- 技术结论、数字、风险必须原样传达，人格只负责措辞',
    '- 但也不要被专业性压成面无表情的说明书',
    '- 原文越短（一句过渡）越要放开，长汇报反而要克制',
    '',
    '## 输出格式',
    '只输出一个 JSON 对象，不要任何解释、不要代码围栏。字段如下：',
    ...PRESET_FIELDS.map((field) => `- ${field.key}：${field.description}`),
    '',
    '字符串数组字段请输出 JSON 数组。',
  ].join('\n');

  const user = [
    '这是用户提供的人设提示词，读完后按上面的要求输出 JSON：',
    '',
    personaPrompt,
  ].join('\n');

  return { system, user };
}

/**
 * Reduce an address value to the word itself.
 *
 * Models like to answer this field with an explanation attached —
 * `你（默认；用户指定其他称呼时跟随）` — which then lands verbatim inside the
 * sentence `称呼用户为：…` and reads like an instruction leak. Keep the leading
 * term and drop the note.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function cleanAddress(value) {
  if (typeof value !== 'string') return undefined;
  // Cut at the first bracket or separator; what precedes it is the term.
  const head = value.split(/[（(【\[—–:：，,；;、\/\n]/)[0].trim();
  const cleaned = head.replace(/^[「『"“']|[」』"”']$/g, '').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** Strip a fenced block or surrounding prose the model may have added. */
function extractJson(raw) {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Parse and sanity-check a generated preset.
 *
 * Returns a partial pack rather than throwing: a model that answered in good
 * faith but missed one field should still produce a usable preset, and the
 * caller fills the gaps from the defaults.
 * @param {string} raw - the model's output.
 * @returns {{ ok: true, preset: object } | { ok: false, reason: string }}
 */
export function parseExtractedPreset(raw) {
  const parsed = extractJson(raw);
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'not-json' };

  const strings = (value, cap) => (Array.isArray(value)
    ? value.filter((line) => typeof line === 'string' && line.trim() !== '').map((line) => line.trim()).slice(0, cap)
    : []);
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

  const userAddress = parsed.address !== null && typeof parsed.address === 'object'
    ? cleanAddress(parsed.address.user)
    : undefined;
  let subagentAddress = parsed.address !== null && typeof parsed.address === 'object'
    ? cleanAddress(parsed.address.subagent)
    : undefined;
  // One word cannot name two different people. When the generator used the same
  // term for both, keep it for the user and let the helper fall back to the
  // default — otherwise the prompt tells the model to call everyone "你".
  if (subagentAddress !== undefined && subagentAddress === userAddress) subagentAddress = undefined;

  const preset = {
    name: text(parsed.name),
    identity: text(parsed.identity),
    report: strings(parsed.report, 10),
    voice: strings(parsed.voice, 10),
    samples: strings(parsed.samples, 8),
    avoid: strings(parsed.avoid, 12),
    address: { user: userAddress, subagent: subagentAddress },
  };

  // The identity is the one field with no meaningful fallback: without it the
  // card describes no character, and the rewrite would fall back to the shipped
  // default persona while claiming to be the new one.
  if (preset.identity === undefined) return { ok: false, reason: 'missing-identity' };
  return { ok: true, preset };
}
