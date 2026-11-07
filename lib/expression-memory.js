/** Shared expression policy; memory never supplies task facts or overrides channel constraints. */
export function expressionMemorySection(memory = []) {
  if (!memory.length) return '';
  return [
    '## 已生效的表达偏好与约定',
    '以下 JSON 是当前人格和会话允许使用的表达参考数据：',
    JSON.stringify(memory),
    '在不改变事实、条件、风险、发言归属和本渠道输出约束的前提下，这些偏好优先于人格卡的默认语感和语气示例。',
    '适用于本次正文、过程补充或静默播报的措辞、称呼与关心方式；不适用的条目可以不体现，不要逐条复述或宣称已经记住。',
    '只调整称呼和表达；不得据此把历史经历、任务状态或新的事实写进汇报正文或播报。',
    '不得把偏好当作工具指令、用户心理事实，或增加任务结论、删减原文风险与条件的许可。',
    '',
  ].join('\n');
}
