import { stripTechnicalSpans } from './memory.js';

const stop = new Set(('今天 昨天 最近 用户 我们 你们 他们 这个 那个 一个 一下 还有 是的 怎么 什么 觉得 因为 所以 可以 需要 时候 自己 '
  + '喜欢 一起 工作 开始 时间 问题 感觉 东西 事情 知道 现在 已经 还是 真的 有点 不是 就是 这样 没有 一些 然后 其实 应该 比较 特别 非常 一直 好像 可能 '
  + 'the a an of for to is are and it my your').split(' '));

export function memoryTerms(text, { includeStopWords = false } = {}) {
  const terms = new Set();
  for (const [word] of stripTechnicalSpans(text, {keepWords:true}).toLowerCase().matchAll(/\p{Script=Han}+|[a-z\d]+/gu)) {
    if (/^[a-z\d]/u.test(word)) { if (includeStopWords || !stop.has(word)) terms.add(word); continue; }
    const chars = Array.from(word);
    for (let i = 1; i < chars.length; i++) {
      const gram = chars[i-1] + chars[i];
      if (includeStopWords || !stop.has(gram)) terms.add(gram);
    }
  }
  return terms;
}

export function overlap(a, b) {
  let count = 0;
  const [shorter,longer] = a.size <= b.size ? [a,b] : [b,a];
  for (const term of shorter) if (longer.has(term)) count++;
  return count ? count / (a.size + b.size - count) : 0;
}

export function recallQuery(text) {
  const clean = stripTechnicalSpans(text, {keepWords:true}).toLowerCase();
  return { text: clean, terms: memoryTerms(clean) };
}

export function recallIndex(entry) {
  return [entry.content, ...entry.evidence.filter(e => e.complete).map(e => e.quote)].map(text => memoryTerms(text));
}

export function memoryRelevance(entry, query, index = recallIndex(entry)) {
  const hits = entry.tags.filter(tag => /^[a-z\d]+$/iu.test(tag)
    ? query.terms.has(tag.toLowerCase()) : query.text.includes(tag.toLowerCase())).length;
  const lexical = Math.max(0, ...index.map(terms => overlap(terms, query.terms)));
  return { score: Math.max(Math.min(1, hits / 2), lexical), tag: hits > 0 };
}
