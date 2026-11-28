// This only admits an extra, model-reviewed peer opportunity. Other room
// conversation does not have to use a vocative or one of these forms.
const pairs = new Map(
  Object.entries({ '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', '`': '`', '（': '）', '(': ')' })
);
const closers = new Set(pairs.values());
function spokenText(line) {
  const chars = line.replace(/^[ \t]*>[^\r\n]*/gmu, part => '\0'.repeat(part.length)).split('');
  const stack = [], ranges = [], gazes = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const open=closers.has(ch)?stack.findLastIndex(item=>item.close===ch):-1;
    if (open!==-1) {
      ranges.push({start:stack[open].start, end:i+1});
      stack.length=open;
    } else if (pairs.has(ch) && !(ch === '"' && /\d/u.test(chars[i-1] ?? ''))) {
      stack.push({start:i, close:pairs.get(ch)});
    }
  }
  // A stray delimiter (including an inch mark) must leave subsequent dialogue audible.
  let maskedEnd = 0;
  for (const {start,end} of ranges.sort((a,b)=>a.start-b.start)) {
    if(start < maskedEnd) continue;
    if(chars[start]==='（' || chars[start]==='(') {
      const gaze = /^(?:转头|转身|回头|侧头|扭头)?(?:看向|望向|看着|望着|看了看|看|望)\s*(.+?)$/u.exec(line.slice(start+1,end-1).trim());
      if(gaze) gazes.push({name:gaze[1],start,end});
    }
    chars.fill('\0',start,end); maskedEnd=end;
  }
  return { spoken: chars.join(''), gazes };
}

function coversAddress(line, span, evidence) {
  if (span.end - span.start > 1600) return false;
  if (evidence === undefined) return true;
  const offset = line.indexOf(evidence, Math.max(0, span.end - evidence.length));
  return offset >= 0 && offset <= span.start && offset + evidence.length >= span.end;
}

/** Locate a public direct address, rather than matching a name in reported speech or a description. */
export function directPeerAddress(line, names, roster, evidence) {
  if (typeof line !== 'string' || !names.length || !names.some((name) => line.includes(name))) return null;
  const { spoken, gazes } = spokenText(line),
    all = [...new Set(roster)].sort((a, b) => b.length - a.length);
  // Only a directed question after a standalone gaze can make a stage direction an address.
  for (const { name, start, end } of gazes) {
    const cue = /^[ \t，,]*(?:你|您)(?:呢|怎么看|觉得|怎么想|也觉得|要不要|能不能|愿不愿|想不想)/u.exec(spoken.slice(end));
    if (!names.includes(name) || !cue) continue;
    const span = { start, end: end + cue[0].length };
    if (coversAddress(line, span, evidence)) return span;
  }
  // Starting at a clause boundary distinguishes "小克，借我一盏灯" from
  // "我去问小克，你先等着". A mention marker is itself an explicit address.
  for (const lead of spoken.matchAll(/(?:^|[\r\n，,。.!！?？;；：:…—\0])[ \t]*[@＠]?|[@＠]/gu)) {
    let start = lead.index + lead[0].length;
    const tag = /[@＠]$/u.test(lead[0]);
    if (!tag && !all.some(name => spoken.startsWith(name, start))) {
      const transition = /^(?:话说|对了|不过|要不(?:让)?|顺便(?:问问)?|那)[ \t]*/u.exec(spoken.slice(start));
      if (transition) start += transition[0].length;
    }
    if (spoken[start] === '\0' || (tag && /[\w.]/u.test(line[start - 2] ?? ''))) continue;
    let at = start,
      found = false;
    while (at < line.length) {
      const name = all.find((value) => spoken.startsWith(value, at));
      if (!name) break;
      found ||= names.includes(name);
      at += name.length;
      const join = /^[ \t]*(?:、|和|跟|与|&)[ \t]*[@＠]?/u.exec(spoken.slice(at));
      if (!join || !all.some((value) => spoken.startsWith(value, at + join[0].length))) break;
      at += join[0].length;
    }
    if (!found) continue;
    const following = spoken.slice(at);
    if (tag && /[\w]/u.test(line[at - 1]) && /^[\w]/u.test(following)) continue;
    const cue =
      /^[ \t]*(?:[呀啊呢呐嘛哦啦]?(?:$|[，,。.!！?？；;：:…—\r\n])|你|您|(?:能不能|可以|能)?(?:借我|帮我|陪我)|觉得呢|怎么看|也?来评评理|要不要|说说)/u.exec(
        following
      );
    if (!tag && !cue) continue;
    let end = at + (tag ? 0 : cue[0].trimEnd().length);
    const topic = !tag && /^[ \t]*[呀啊呢呐嘛哦啦]?[ \t]*[，,][ \t]*(?:她|他|这人|那家伙)/u.exec(following);
    if (topic) {
      // “小克啊，她刚走” introduces a topic. “你能帮我叫她吗” in the next clause addresses 小克.
      const request = /^[^，,。.!！?？；;：:…—\r\n]*[，,][ \t]*(?:那|请)?(?:你|您)(?:能|可不可以|可以|愿不愿|要不要|帮|来)/u.exec(
        following.slice(topic[0].length)
      );
      if (!request) continue;
      end = at + topic[0].length + request[0].length;
    }
    const span = { start: tag ? start - 1 : start, end };
    if (coversAddress(line, span, evidence)) return span;
  }
  return null;
}
