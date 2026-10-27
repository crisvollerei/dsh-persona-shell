/**
 * Prompt construction for one rewrite call.
 *
 * The calling model never sees the session: no history, no tools, no system
 * prompt of the working agent. It sees the voice card, at most a couple of
 * earlier successful samples for tone continuity, and one masked report.
 *
 * The card is split into two jobs and the prompt keeps them apart: `report`
 * governs how much character a *work report* can carry, `voice` and `samples`
 * describe what the character sounds like. Merging them is what produces either
 * a flat assistant or an unusable toy.
 */

/**
 * @param {object} input
 * @param {import('./pack.js').DEFAULT_PACK} input.pack
 * @param {string} input.masked - report prose with literals replaced by `[[n]]`
 * @param {number} input.literalCount
 * @param {readonly string[]} input.history - this session's earlier outputs, newest last
 * @param {string | undefined} input.stage - optional one-line environment note
 * @param {readonly string[]} [input.memory] - accumulated facts about the reader
 * @returns {{ system: string, user: string }}
 */
export function buildRewritePrompt({ pack, masked, literalCount, history, stage, memory = [] }) {
  const bullets = (lines) => lines.map((line) => `- ${line}`).join('\n');

  // Kept as its own section, and explicitly marked as tendencies rather than
  // rules: these lines come from counters, and a miscalculated ratio must not be
  // able to override what the report actually says.
  const memorySection = memory.length === 0
    ? []
    : [
      '## 关于这位读者（长期观察，仅作倾向参考）',
      bullets(memory),
      '这些只是倾向，不是硬规则；与原文事实冲突时一律以原文为准。',
      '',
    ];

  const system = [
    '你要把一段工程助手的汇报，用指定角色的口吻重新讲一遍。',
    '',
    '## 你是谁',
    pack.identity,
    '',
    '## 这份汇报里怎么说话',
    bullets(pack.report),
    '',
    '## 说话风格',
    bullets(pack.voice),
    '',
    '## 口头禅与语气示例（体会感觉，不要逐字复读）',
    bullets(pack.samples),
    '',
    '## 语气禁区',
    bullets(pack.avoid),
    `称呼用户为：${pack.address.user}`,
    `提到子代理时称呼为：${pack.address.subagent}`,
    '',
    ...memorySection,
    '## 硬性规则（违反任何一条，这次改写会被丢弃）',
    `1. 原文里所有形如 [[0]] 的标记必须原样、原位置保留。这次共 ${literalCount} 个。`,
    '2. 不得新增原文没有的事实、数字、结论、建议或承诺。',
    '3. 不得删除原文中的风险提示、适用条件或不确定性说明。',
    '4. 长度不超过原文的 1.3 倍。',
    '5. 只输出改写后的正文，不要解释你在做什么，不要加引号或代码围栏。',
    '6. 保留原文的段落结构、列表符号和标题层级。',
    '',
    '这是转述任务，不是创作任务：信息量必须持平，人格只影响措辞。',
  ].join('\n');

  const parts = [];
  if (history.length > 0) {
    // History samples are masked too, but their `[[n]]` markers belong to a
    // different call. Renumbering them into a separate namespace keeps the model
    // from treating a past placeholder as one it must reproduce now, and stops two
    // different snippets from sharing one marker.
    parts.push('下面是前几步已交付的口气，保持连续，但不要重复同样的句子。');
    parts.push('（其中的 {{n}} 是上一步的占位符，本步不要照抄。）');
    for (const sample of history) {
      parts.push('---', sample.trim().replace(/\[\[\s*(\d+)\s*\]\]/g, '{{$1}}'));
    }
    parts.push('---', '');
  }
  if (stage !== undefined && stage !== '') parts.push(`（本步语境：${stage}）`, '');
  parts.push('待改写：', masked);

  return { system, user: parts.join('\n') };
}

/**
 * How much of the original wording the rewrite actually replaced.
 *
 * A rewrite that only appends a catchphrase is not a rewrite, and "looks about
 * right" is not a measurement. This compares character bigrams, which is cheap,
 * language-agnostic and stable across punctuation changes, and reports the share
 * of the original's bigrams that did **not** survive — i.e. how much of the
 * sentence structure moved.
 * @param {string} original
 * @param {string} candidate
 * @returns {{ similarity: number, novelShare: number, lengthRatio: number }}
 *   `similarity` is 0..1 (1 = identical bigrams), `novelShare` is 1 - similarity,
 *   `lengthRatio` is candidate/original length.
 */
export function rewriteDistance(original, candidate) {
  const bigrams = (text) => {
    const clean = text.replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i + 1 < clean.length; i += 1) set.add(clean.slice(i, i + 2));
    return set;
  };

  const a = bigrams(original);
  const b = bigrams(candidate);
  if (a.size === 0) return { similarity: 1, novelShare: 0, lengthRatio: 1 };

  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;

  const similarity = shared / a.size;
  return {
    similarity: Number(similarity.toFixed(3)),
    novelShare: Number((1 - similarity).toFixed(3)),
    lengthRatio: Number((candidate.length / Math.max(1, original.length)).toFixed(3)),
  };
}

/**
 * Validate one candidate against the text it was asked to rewrite.
 *
 * Both sides are the masked vocabulary: the `[[n]]` markers are the contract
 * that protects code, paths and commands, so they are checked before anything
 * is restored. Length is measured on the same basis (the caller may pass a
 * separate baseline when the two vocabularies differ).
 * @param {object} input
 * @param {string} input.candidate - the model's output, still masked
 * @param {string} input.original - the masked input it was given
 * @param {number} input.literalCount
 * @param {number} input.maxRatio
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function validateRewrite({ candidate, original, literalCount, maxRatio }) {
  const text = candidate.trim();
  if (text === '') return { ok: false, reason: 'empty' };

  // Markers must be exactly the ones handed out, each once.
  const seen = new Set();
  for (const match of text.matchAll(/\[\[\s*(\d+)\s*\]\]/g)) {
    const index = Number(match[1]);
    if (index >= literalCount) return { ok: false, reason: 'unknown-marker' };
    if (seen.has(index)) return { ok: false, reason: 'duplicate-marker' };
    seen.add(index);
  }
  if (seen.size !== literalCount) return { ok: false, reason: 'dropped-marker' };

  // The model must not introduce fenced blocks of its own: code is a literal.
  //
  // Both fence styles count, and indentation is allowed: a fence may legally be
  // preceded by up to three spaces, so an anchored `^~~~` missed the very common
  // `  ~~~sh` form and let an invented block through validation.
  if (text.includes('```') || /^[ \t]*~~~/m.test(text)) {
    return { ok: false, reason: 'invented-fence' };
  }

  // Guard against a rewrite that pads rather than re-speaks. The floor keeps a
  // short report from being rejected for a normal expansion.
  const limit = Math.max(original.length * maxRatio, original.length + 200);
  if (text.length > limit) return { ok: false, reason: 'too-long' };

  return { ok: true, text };
}
