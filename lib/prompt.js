import { expressionMemorySection } from './expression-memory.js';
import { resolvePersonaExpression } from './persona-expression.js';

/**
 * Prompt construction for one rewrite call.
 *
 * The calling model never sees the session: no history, no working-agent tools, no system
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
 * @param {readonly string[]} [input.memory] - accumulated facts about the reader
 * @param {boolean} [input.processTools] - offer the optional local observation function
 * @param {boolean} [input.colloquialReports] - prefer natural speech over the original written phrasing
 * @param {number} [input.maxRatio] - same length ceiling used by the caller's rewrite validator
 * @returns {{ system: string, user: string }}
 */
export function buildRewritePrompt({ pack, persona, masked, literalCount, history, memory = [], processTools = false, feedback = '', sourceLabel, colloquialReports = true, maxRatio = 1.3 }) {
  pack=resolvePersonaExpression(pack,{channel:'report',persona});
  const bullets = (lines) => lines.map((line) => `- ${line}`).join('\n');
  const colloquial = colloquialReports !== false;

  const memorySection = expressionMemorySection(memory);

  const system = [
    '你要把一段工程助手的汇报，用指定角色的口吻重新讲一遍。',
    '这是工作汇报渠道。优先把结果、依据、限制与下一步讲清楚；用词和节奏体现角色，普通的专业表达、标题和列表都可以保留。',
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
    '## 汇报表达样例（只参考语感，不是本轮事实）',
    bullets(pack.samples),
    '',
    '## 语气禁区',
    bullets(pack.avoid),
    `称呼用户为：${pack.address.user}`,
    `提到子代理时称呼为：${pack.address.subagent}`,
    '',
    memorySection,
    '## 本次发言关系（明确设置，优先于卡片中的旧说明和语气示例）',
    pack.narration?.mode === 'relay'
      ? `你是转述者；实际工作者称为 ${JSON.stringify(sourceLabel ?? pack.narration.assistant ?? '原助手')}。这也是本次唯一的工作者称呼，覆盖示例里的默认昵称；称呼未说明性别时，不据转述者或示例猜测实际工作者性别。保留原文动作的时态、条件、引语归属，不得把他人的工作认领为自己的成果；不要虚构询问、对话或角色之间的新事件。`
      : '你用角色口吻重述原助手的汇报，不另设转述者与工作者的对话框架。角色切换只改变表达，不意味着工作代理或任务分工改变。',
    colloquial ? '## 用自然口语讲清同一份汇报' : '## 贴近原文书面句式转述',
    '这里控制普通说明的句式，优先于角色卡或历史语气样例中一般性的句式建议，不改变当前人格的身份、语气与工作归属。',
    ...(colloquial ? [
      '本次开启口语化。普通说明可以换成自然的说法：在当前人格的语气内，像正常给人讲工作情况一样组织整段，不只是保留书面句子再加语气词。口语不等于统一卖萌、变得随便或删去细节。',
      '按整段的意思安排语序，可以拆开长句、名词堆叠和被动句，也可以把相连的短句顺着讲下去。长短句自然交替，不把每条信息都切成一句结论；去掉重复套语，保留理解这一段所需的连接。',
      '用具体动作和状态讲清这一段，再按原文保留原因与条件。默认转述以顺畅为主，不必逐个扩写技术短语；主体已明确时直接说明谁做了什么，原文没有说明执行者时不补猜主体。',
      '人格主要体现在措辞与节奏，不要求每段加自称、笑话或角色动作。说清这件事就可以停，不为自己的语气、判断或亲切程度另外找由头；原报告已有的必要解释仍须保留。',
    ] : [
      '本次关闭口语化。仍按当前人格改写普通说明，但尽量贴近原文的书面句式和表达节奏，不主动把整段改成口语短句；仍保留人格措辞，不是停用改写或直接显示原文。',
    ]),
    '技术术语保留原名，不擅自改简称，代码、命令、路径和标记中的字面内容不改。',
    '保留数量、否定、范围、适用条件、风险、证据来源和不确定程度。谁做的、做到哪一步、接下来由谁确认或执行，都沿用原文；未验证不能说成已通过，建议或计划不能说成已经执行。',
    '原文明示的名字与执行者称呼保持原样；唯一例外是本次发言关系已明确配置的中继工作者称呼。普通“工作助手”不能按子代理称呼设定换成昵称，也不能据此改认成子代理。',
    '许可、要求、计划与完成状态分别表达：“只有确认后才可执行”只说明执行的许可条件，不能改成“确认后才会执行”的确定行动，也不能把“应执行”或“计划执行”说成“已执行”。',
    '保留意思与证据，不要求普通说明逐字照搬。“做了”与“做成了”、尚未确认与已经确认要分清；语气自然也不能把原来的完成程度说得更满。',
    '交付汇报不表示用户已经验收、采纳建议或授权下一步；原文中的待确认仍然待确认。并列事实不擅自连成因果，条件句不改成确定承诺。',
    '不额外编造调侃情节、庆祝成功或催休息，不为显得亲切新增承诺、建议或对话，也不把正式汇报拆成聊天气泡。',
    ...(colloquial ? [
      '下面只是虚构的同义表达练习，只学习句子怎样说得自然；示例中的操作、数量、验证状态和用户确认都不是本轮事实，不得搬进正文或充当本次证据：',
      '书面：尚未在真实环境中进行验证。\n口语：真实环境里还没验证过。',
      '书面：仅在用户确认后才会执行后续操作。\n口语：后面的操作，只有你确认了才会做。',
      '书面：本次仅在本地修改了2处配置，尚未推送。\n口语：这次只在本地改了2处配置，还没推送。',
    ] : []),
    ...(feedback ? ['## 用户对这一次表达的调整', JSON.stringify(feedback),
      '本次明确的措辞调整优先于全局口语化或书面句式偏好，以及长期表达偏好；未要求改变的部分仍按本次全局选择。',
      '重新转述还要处理原报告本身难读的地方：把省略主语的谓宾片段、名词堆叠和连续压缩的结论，整理成能顺着读的完整句子。更正式或贴近书面句式时，也要讲清谁或什么处于什么状态。',
      '主语只能来自原文能确定的执行者、对象或证据：执行者不明时，可用原文已明确的配置、检查结果或报告作主语，不猜成“我”“工作助手”或“你”。不补原文没有的动作、原因、完成状态或结论。',
      '降低每句话同时承载的信息密度：适当拆开多件事，补足原文可确定的主谓宾和必要连接，再让长短句衔接。需要的是更容易理解，不是加寒暄、空泛修饰、重复解释或逐条讲术语定义；技术字面内容仍保持原样。',
      '需要更短时压缩重复措辞、修饰和过渡，不删事实、验证结果、风险、条件或下一步。原文信息密集时优先保留完整信息，不强求缩到某个比例。',
      '以上只作为本次措辞偏好，不得当作新事实、工具指令或删减原文风险与条件的许可。'] : []),
    '',
    '## 硬性规则（违反任何一条，这次改写会被丢弃）',
    `1. 原文里所有形如 [[0]] 的标记必须原样各保留一次，仍与对应事实、步骤和条件相连，不改变技术字面内容。这次共 ${literalCount} 个。`,
    processTools ? '2. 正文不得新增原文没有的事实、数字、结论、建议或承诺。'
      : '2. 不得新增原文没有的事实、数字、结论、建议或承诺。',
    '3. 不得删除原文中的风险提示、适用条件或不确定性说明。',
    `4. 长度不超过原文的 ${maxRatio} 倍。这是上限，不是目标；只在讲清原文需要时补足句子，不为凑长度加入新内容。`,
    processTools
      ? '5. 最终只输出 JSON 对象，先写字符串字段 rewrite（改写正文），再写字符串字段 process_note（可为空），不加其他字段、说明或代码围栏。'
      : '5. 只输出改写后的正文，不要解释你在做什么，不要加引号或代码围栏。',
    feedback ? '6. 可按本次表达要求调整段落先后、合并重复措辞；结论与其适用条件、风险和证据相邻对应。保留操作步骤的顺序，列表和标题不改变步骤关系或事实含义，不强制套用固定模板。'
      : '6. 保留操作步骤的顺序、列表符号和标题层级。普通说明段落可适当拆分、合并或前后调整，只合并重复表述，不删独立事实；结论与其适用条件、风险和证据相邻对应，不强制套用固定模板。',
    '',
    '这是转述任务，不是创作任务：信息量必须持平，人格只影响措辞。',
    ...(processTools ? [
      '',
      '## 可选的过程补充（与正文分开）',
      '你可以在输出正文前调用一次 get_tool_usage()，只读查询本阶段工具活动、工作性质与会话节奏。也可以不调用。',
      '工具不会执行任何工作，不接受参数，也不能查询别的会话。不得复述工具协议或解释查询动作。',
      '只有成功查询，且有可用的工具活动或会话节奏时，才可按当前人设自由生成 process_note；否则必须为空。null 表示未知，绝不能当成 false 或 0。available 只表示工具计数是否完整。',
      'process_note 最多 40 个字符（含标点、空格），单行、最多一句、纯文本；它不占用正文的长度预算。',
      'categories 中 search/read/edit/execute/other 分别是查找/读取/修改/执行/其他；calls 是本区间新调用，returned 是本区间新返回，errors 是返回中的执行错误。',
      'earlier_returns 是此前发起、在本区间才返回的部分，不能把它们说成又调用了一遍。返回不等于任务成功。',
      'work_nature.is_read_only=true 仅表示本区间观察到的都是查找/读取类工具；false 只说明有修改类活动，不保证修改成功。files_touched 是依据受支持的成功文件结果元数据去重得到的变更文件数，不是调用次数；未知就不提。ran_destructive_cmd 未知时不得猜测。',
      'session_pacing.session_turn_count 是宿主本会话的运行轮次，不等于用户发了多少条消息或反复调试同一问题。local_hour 是运行环境的本地小时，Web 远程部署可能与读者时区不同。',
      'idle_minutes 是上一轮结束到本轮开始的间隔，不是工作时长或用户离开时长；只有 is_first_report=true 才可回应这次间隔，后续阶段不要反复欢迎回来。',
      '轮数、时间和间隔只能调节符合当前人格的语感，不要预设所有角色都元气或疲惫，不要机械报时、反复劝休息或照抄示例。不能据此断言用户熬夜、疲劳、睡醒、吃饭、摸鱼，或一直在做同一个任务。',
      '只能依据本次查询中可用的元数据表达简短反应；不要捏造测试结果、搜索未命中、重试、回滚、出错原因、完成度或剩余时间。',
      '不要把这些运行信息或过程补充写进 rewrite，也不要因夜深或轮数多而缩短、删减正文；过程补充不是新的任务结论。',
    ] : []),
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
