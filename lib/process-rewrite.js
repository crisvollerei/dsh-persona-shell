import { restoreToolUsage } from './tool-usage.js';

export const PROCESS_NOTE_LIMIT = 40;

/** Decode only the first JSON string value; never stream JSON syntax or the optional note. */
export function processRewritePartial(wire) {
  const match = wire.match(/^\s*\{\s*"rewrite"\s*:\s*/);
  if (!match || wire[match[0].length] !== '"') return '';
  let token = '"';
  let at = match[0].length + 1;
  let closed = false;
  for (; at < wire.length; at++) {
    const char = wire[at];
    if (char === '"') { closed = true; break; }
    if (char === '\\') {
      if (at + 1 >= wire.length) break;
      const size = wire[at + 1] === 'u' ? 6 : 2;
      if (at + size > wire.length) break;
      token += wire.slice(at, at + size); at += size - 1;
    } else token += char;
  }
  try {
    const text = JSON.parse(token + '"');
    return closed ? text : text.replace(/[\uD800-\uDBFF]$/, '');
  } catch { return ''; }
}

export function parseProcessRewrite(wire) {
  try {
    const value = JSON.parse(wire);
    if (!value || Array.isArray(value) || typeof value.rewrite !== 'string'
      || Object.keys(value).some((key) => !['rewrite', 'process_note'].includes(key))) return;
    return { rewrite: value.rewrite, note: value.process_note };
  } catch { return; }
}

/** These are bounded format/fact checks, not a semantic-fidelity proof. */
export function validateProcessNote(text, usage) {
  if (typeof text !== 'string') return;
  const value = text.trim();
  const facts = restoreToolUsage(usage);
  const pace = facts?.session_pacing;
  const hasPacing = pace && (pace.local_hour !== null || pace.session_turn_count !== null);
  if (!value || Array.from(value).length > PROCESS_NOTE_LIMIT || !facts
    || (!Object.keys(facts.categories).length && !hasPacing)
    || /[\r\n\u2028\u2029`<>\[\]{}*_#\\]|https?:|\[\[|\d\s*%|百分之/u.test(value)
    || value.replace(/(\d)\.(?=\d)/gu, '$1').split(/[。！？!?.]+/u).filter((part) => part.trim()).length > 1
    || /测试|回滚|改崩|修崩|崩溃|重试|没找到|未找到|定位|(?:已经|已|终于)(?:完成|修好|修复|解决)|马上|快完成|预计|剩余|\b(?:tests?|rollback|retries|retry|passed|fixed|completed|ETA)\b/iu.test(value)) return;
  const totals = { calls: 0, returned: 0, errors: 0, earlier_returns: 0 };
  for (const count of Object.values(facts.categories)) for (const key of Object.keys(totals)) totals[key] += count[key];
  if (/(?:错误|报错|失败|error|fail)/iu.test(value) && totals.errors === 0) return;
  const quantities = new Set(Object.values(totals).filter((n) => n > 0).map(String));
  for (const count of Object.values(facts.categories)) for (const n of Object.values(count)) if (n > 0) quantities.add(String(n));
  for (const n of [facts.work_nature?.files_touched, pace?.session_turn_count, pace?.local_hour,
    pace?.is_first_report ? pace.idle_minutes : null]) if (typeof n === 'number') quantities.add(String(n));
  if ([...value.matchAll(/\d+(?:\.\d+)?/g)].some(([n]) => !quantities.has(n))) return;
  if (/只读|只(?:查|读)|(?:没|未)(?:改动|修改|写入)|一行(?:也)?没改/u.test(value)
    && facts.work_nature?.is_read_only !== true) return;
  if (/危险命令|破坏性命令|destructive command/iu.test(value) && facts.work_nature?.ran_destructive_cmd !== true) return;
  for (const match of value.matchAll(/(?:改动|修改|写入|动)(?:了|过|共|\s){0,8}(\d+)\s*(?:个|份)?文件/gu)) {
    if (Number(match[1]) !== facts.work_nature?.files_touched) return;
  }
  for (const match of value.matchAll(/第\s*(\d+)\s*轮/gu)) if (Number(match[1]) !== pace?.session_turn_count) return;
  for (const match of value.matchAll(/(\d+)\s*点/gu)) if (Number(match[1]) !== pace?.local_hour) return;
  for (const match of value.matchAll(/(?:时隔|间隔|隔了|隔)\s*(\d+(?:\.\d+)?)\s*分钟/gu)) {
    if (!pace?.is_first_report || Number(match[1]) !== pace.idle_minutes) return;
  }
  // Explicit Arabic counts must also match their labelled category/outcome, not just occur somewhere.
  const labels = { search: '查找|搜索|检索', read: '读取|读文件', edit: '修改|编辑|写入',
    execute: '执行|运行', other: '其他' };
  for (const [key, label] of Object.entries(labels)) {
    for (const match of value.matchAll(new RegExp(`(?:${label})(?:了|过|共|工具|调用|返回|\\s){0,8}(\\d+)\\s*次`, 'gu'))) {
      const count = facts.categories[key];
      if (!count || ![count.calls, count.returned].includes(Number(match[1]))) return;
    }
  }
  const categorySuffix = new RegExp(`(?:${Object.values(labels).join('|')})(?:了|过|共|工具|调用|返回|\\s){0,8}$`, 'u');
  for (const [label, key] of [['调用|发起', 'calls'], ['返回', 'returned']]) {
    for (const match of value.matchAll(new RegExp(`(?:${label})(?:了|过|共|工具|\\s){0,8}(\\d+)\\s*次`, 'gu'))) {
      if (!categorySuffix.test(value.slice(0, match.index)) && Number(match[1]) !== totals[key]) return;
    }
  }
  for (const match of value.matchAll(/(\d+)\s*次(?:执行)?(?:错误|报错|失败)/gu)) if (Number(match[1]) !== totals.errors) return;
  return value;
}

/** Some providers do not settle a pending iterator read when their signal is aborted. */
async function* abortableStream(llm, options) {
  const iterator = llm.stream(options)[Symbol.asyncIterator]();
  let onAbort;
  let done = false;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new Error('process-aborted'));
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), cancelled]);
      if (next.done) { done = true; return; }
      yield next.value;
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    if (!done) {
      try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Best-effort provider cleanup. */ }
    }
  }
}

/** Bind the frozen observation to just this rewrite; it never enters report history. */
export async function runProcessRewrite({ llm, options, usage, allowed, onPartial, maxChars }) {
  const facts=restoreToolUsage(usage)??null;
  const messages=options.messages.slice(),last=messages.pop();
  messages.push({role:'user',content:[...(last?.content??[]),{type:'text',text:JSON.stringify({processUsage:facts})}]});
  const blocks=new Map(), closed=new Set();let wire='',finish,unindexed=false;
  const check=()=>{if(options.signal.aborted || !allowed())throw Error('process-disabled');};
  check();
  for await(const chunk of abortableStream(llm,{...options,messages})){
    check();
    if(chunk.type.startsWith('tool-call') || chunk.blockType==='tool-call' || chunk.block?.type==='tool-call')throw Error('process-tool-denied');
    if(chunk.type==='error')throw Error('process-stream-error');
    if(chunk.type==='finish'){finish=chunk.reason?.kind;continue;}
    if(chunk.type!=='text-delta' && !(chunk.type==='block-end' && chunk.block?.type==='text'))continue;
    if(chunk.index===undefined)unindexed=true;
    const i=chunk.index===undefined?0:chunk.index;
    if(!Number.isSafeInteger(i)||i<0||(unindexed&&(i!==0||[...blocks.keys()].some(key=>key!==0))))throw Error('process-block-index');
    if(closed.has(i))continue;
    if(!blocks.has(i) && blocks.size>=32)throw Error('process-block-limit');
    if(chunk.type==='block-end'){blocks.set(i,chunk.block.text??'');closed.add(i);}
    else blocks.set(i,(blocks.get(i)??'')+chunk.text);
    wire=[...blocks.keys()].sort((a,b)=>a-b).map(index=>blocks.get(index)).join('');if(wire.length>maxChars)throw Error('process-too-long');
    onPartial(processRewritePartial(wire));
  }
  check();if(finish!=='stop')throw Error('process-finish');
  const result=parseProcessRewrite(wire);if(!result)throw Error('process-format');
  return {text:result.rewrite,note:validateProcessNote(result.note,facts)};
}
