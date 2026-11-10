// A room's own public words, not inferred facts or another form of long-term memory.
// Derive these bookmarks from persisted history, so clear/source changes also clear them.
import { quoteKey } from './chat-quote.js';
const conversationalWords = new Set([
  '今天', '昨天', '明天', '今晚', '上午', '下午', '晚上', '早上', '中午', '最近',
  '刚才', '之前', '上次', '记得', '那个', '这个', '继续', '现在', '这次', '本轮',
  '我们', '你们', '大家', '可以', '可能', '觉得', '一点', '一下', '这样', '那样',
  '说说', '聊聊', '聊天', '什么', '怎么', '因为', '所以', '然后', '不过', '其实',
  '已经', '还是', '就是', '只是', '或者', '需要', '要不', '好的', '没事', '当然', '确实',
  'the', 'and', 'that', 'this', 'earlier', 'previous', 'again', 'just', 'now', 'today', 'hello', 'thanks', 'please',
]);
// Remove common phrases before building bigrams so their shared boundary (e.g.
// “现在可以” -> “在可”) cannot become a false topic anchor.
const conversationalHan = new RegExp([...conversationalWords].filter(word => /\p{Script=Han}/u.test(word)).join('|'), 'gu');
const words = text => new Set((typeof text === 'string' ? text.toLowerCase().replace(conversationalHan, ' ').match(/[a-z0-9_-]{3,}|[\p{Script=Han}]{2,}/gu) ?? [] : [])
  .flatMap(word => /\p{Script=Han}/u.test(word) ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word])
  .filter(word => !conversationalWords.has(word)));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

export function chatThreadNotes(history, message, recentCount = 8, {roomId,generation=0,excluded=[]} = {}) {
  const groups = [];
  for (const turn of Array.isArray(history) ? history : []) {
    if (!turn || typeof turn !== 'object') continue;
    const previous = groups.at(-1);
    if (turn.messageId && previous?.id === turn.messageId) previous.turns.push(turn);
    else groups.push({ id: turn.messageId ?? turn.id, turns: [turn] });
  }
  const count = Number.isSafeInteger(recentCount) && recentCount >= 0 ? recentCount : 8;
  const earlier = count ? groups.slice(0, -count) : groups;
  const query = words(message);
  const context = query.size<=2&&/刚才|之前|上次|记得|那个|继续|earlier|previous/i.test(message)
    ? words(groups.slice(-2).map(g => g.turns[0].user).join('\n')) : new Set();
  const notes = [], excludedKeys = new Set((Array.isArray(excluded) ? excluded : []).map(quoteKey).filter(Boolean));
  for (let index = 0; index < earlier.length; index++) {
    const group = earlier[index], first = group.turns[0];
    const parts=first.userParts===undefined?[{id:group.id,text:first.user}]:Array.isArray(first.userParts)&&first.userParts.length>0&&first.userParts.length<=8
      &&new Set(first.userParts.map(part=>part?.id)).size===first.userParts.length
      &&first.userParts.every(part=>validId(part?.id)&&typeof part.text==='string'&&part.text.trim()&&part.text.length<=4000)
      &&first.userParts.map(part=>part.text).join('\n')===first.user?first.userParts:[];
    const quotes = parts.map(part=>({ author: { role: 'user' },text:part.text,messageId:part.id,
      ref:roomId?{roomId,generation,kind:'user',messageId:part.id}:undefined }));
    for (const turn of group.turns) if (turn.status === 'ready' && Array.isArray(turn.assistant)
      && validId(turn.recipientId) && typeof turn.speakerName === 'string' && turn.speakerName.trim() && turn.speakerName.length <= 80) {
      // A whole delivered bubble is evidence, including statements, suggestions and
      // jokes. Its wording does not establish an accepted decision or a promise.
      for (let bubble = 0; bubble < turn.assistant.length; bubble++) quotes.push({
        author: { role: 'assistant', id: turn.recipientId, name: turn.speakerName }, text: turn.assistant[bubble],
        ref:roomId?{roomId,generation,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index:bubble}:undefined });
    }
    for (let order = 0; order < quotes.length; order++) {
      const quote = quotes[order];
      if (!validId(group.id) || typeof quote.text !== 'string' || quote.text.length < 4 || quote.text.length > 240 || !quote.text.trim()) continue;
      const refKey = quote.ref ? quoteKey(quote.ref) : null;
      if ((quote.ref && !refKey) || (refKey && excludedKeys.has(refKey))) continue;
      const quoteWords = [...words(quote.text)], direct = quoteWords.some(word => query.has(word));
      const score = quoteWords.reduce((n, word) => n + (query.has(word) ? 4 : context.has(word) ? 1 : 0), 0);
      if (!score) continue;
      const recipients=(first.recipients??[]).map(({id,name})=>({id,name}));
      notes.push({ messageId: group.id, recipients, ...quote, score, direct, index, order });
    }
  }
  const selected = []; let chars = 0;
  // Recent context resolves bare references, not unrelated additions to an
  // already identifiable topic such as “之前那个草图”.
  const hasDirect = notes.some(note => note.direct);
  const ranked = notes.filter(note => !hasDirect || note.direct).sort((a, b) => b.score - a.score || b.index - a.index
    || Number(b.author.role === 'user') - Number(a.author.role === 'user') || b.order - a.order);
  for (const note of ranked) {
    if (chars + note.text.length > 800) continue;
    selected.push(note); chars += note.text.length;
    if (selected.length === 4) break;
  }
  return selected.sort((a, b) => a.index - b.index || a.order - b.order)
    .map(({ messageId, recipients, author, text,ref }) => ({ messageId, recipients, author, quote: text,...(ref?{ref}:{}) }));
}
