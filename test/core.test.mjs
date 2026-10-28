// Offline checks for the pure halves of persona-shell: masking, prompt and validation.
// Run with: node --test persona-shell/test/
import test from 'node:test';
import assert from 'node:assert/strict';

import { mask, unmask, markersIntact } from '../lib/mask.js';
import { normalizePack, CLAUDE_PACK, BUILTIN_PRESETS } from '../lib/pack.js';
import { buildRewritePrompt, rewriteDistance, validateRewrite } from '../lib/prompt.js';

test('mask shields fenced code, inline code, paths, versions and urls', () => {
  const input = [
    '改好了 `npm run build` 这条命令。',
    '```js',
    'const a = 1;',
    '```',
    '见 D:\\work\\a.js 和 https://example.com/x 以及 v1.2.3。',
  ].join('\n');

  const { masked, literals } = mask(input);
  assert.equal(literals.length, 5);
  for (const literal of literals) assert.ok(!masked.includes(literal));
  assert.ok(masked.includes('[[0]]'));
  assert.equal(unmask(masked, literals), input);
});

test('the review counterexamples are shielded too', () => {
  // Each of these leaked as prose before: a bare command has no backticks, a
  // single-segment path failed the two-level rule, a URL with parentheses was cut
  // short, and a four-backtick fence closed at the inner triple and exposed the
  // rest of the code.
  const cases = [
    ['npm run build', '执行 npm run build 后继续。'],
    ['/tmp', '看 /tmp 目录'],
    ['./src/main.js', '打开 ./src/main.js 这个文件'],
    ['https://example.com/a(b)c', '见 https://example.com/a(b)c 这里'],
    ['````js\nconst a = 1;\n```\ninner\n````', '标题\n\n````js\nconst a = 1;\n```\ninner\n````\n\n结束'],
  ];

  for (const [literal, input] of cases) {
    const { masked, literals } = mask(input);
    assert.ok(literals.includes(literal), `should shield: ${literal}`);
    assert.ok(!masked.includes(literal), `must not leak: ${literal}`);
    assert.equal(unmask(masked, literals), input, 'and restore exactly');
  }
});

test('unmask restores the exact original bytes', () => {
  const input = 'run `a b` then D:\\x\\y.txt';
  const { masked, literals } = mask(input);
  assert.deepEqual(unmask(masked, literals), input);
});

test('markersIntact accepts exactly the handed-out set', () => {
  assert.equal(markersIntact('a [[0]] b [[1]]', 2), true);
  assert.equal(markersIntact('a [[0]] b', 2), false);
  assert.equal(markersIntact('a [[0]] b [[0]]', 2), false);
  assert.equal(markersIntact('a [[0]] b [[2]]', 2), false);
});

test('normalizePack fills gaps and drops junk', () => {
  const pack = normalizePack({ identity: '  冷淡  ', voice: ['', '短句'], report: null, avoid: null });
  assert.equal(pack.identity, '冷淡');
  assert.deepEqual(pack.voice, ['短句']);
  // Unfilled sections fall back to their defaults rather than rendering empty.
  assert.ok(pack.report.length > 0, 'report rules fall back to the default card');
  assert.ok(pack.avoid.length > 0);
  assert.ok(pack.samples.length > 0);
  assert.equal(normalizePack(null).identity.length > 0, true);
  assert.equal(normalizePack('nonsense').identity.length > 0, true);
});

test('the default card is the 大肥鱼 persona, not a generic assistant', () => {
  const pack = normalizePack(undefined);
  assert.match(pack.identity, /大肥鱼/);
  assert.match(pack.identity, /鲸/);
  // Self-reference: the user asked for 「鲸鲸」 specifically. The identity may
  // *mention* the rejected wording in order to forbid it, so the check is that
  // the replacement is actually prescribed, not that the old string is absent.
  assert.match(pack.identity, /鲸鲸/);
  assert.match(pack.identity, /不用「本鱼」/, 'the card must forbid the old self-reference');
  assert.ok(!pack.report.join('').includes('本鱼'), 'report rules must not ask for 本鱼');
  assert.ok(!pack.samples.join('').includes('本鱼'), 'samples must not model 本鱼');
  assert.ok(pack.samples.some((line) => line.includes('鲸鲸')), 'samples must model 鲸鲸');
  // The report rules must exist separately from the voice rules: that split is
  // what keeps a technical report readable while still sounding like her.
  assert.ok(pack.report.length >= 3);
  assert.ok(pack.report.join('').includes('技术'));
  assert.ok(pack.samples.length >= 3);
});

test('the shipped presets include Claude小姐 as a second complete card', () => {
  // The default preset must not be the only shipped character: the settings page
  // offers presets as alternatives, and a user should be able to switch to a
  // second voice without writing a persona prompt first.
  assert.equal(BUILTIN_PRESETS.length, 2, 'exactly two shipped presets');
  const claude = BUILTIN_PRESETS.find((entry) => entry.name === 'Claude小姐');
  assert.ok(claude, 'the Claude preset is shipped');
  assert.equal(claude.id, 'Claude小姐', 'the id is stable so a saved selection can find it');

  const pack = normalizePack(CLAUDE_PACK);
  assert.match(pack.identity, /Claude小姐/);
  assert.match(pack.identity, /社区二创/, 'it is labelled a community creation, not an official persona');
  assert.match(pack.identity, /「我」|用「我」/, 'it prescribes a first person');
  assert.ok(!pack.identity.includes('鲸鲸'), 'the whale self-reference must not leak into another persona');
  assert.ok(!pack.samples.join('').includes('鲸鲸'), 'nor into its samples');
  assert.ok(pack.report.length >= 3);
  assert.ok(pack.report.join('').includes('技术'));
  assert.ok(pack.samples.some((line) => line.includes('笼子好歹是金的')), 'the signature line survives');
  assert.ok(pack.avoid.join('').includes('规矩多'));
  assert.equal(pack.address.user, '你');
  assert.equal(pack.address.subagent, '子代理', 'the whale helper name must not leak in');
});

test('every shipped preset is a distinct, complete card', () => {
  const ids = new Set();
  const names = new Set();
  for (const entry of BUILTIN_PRESETS) {
    assert.ok(typeof entry.id === 'string' && entry.id !== '');
    assert.ok(typeof entry.name === 'string' && entry.name !== '');
    assert.ok(!ids.has(entry.id), `duplicate preset id: ${entry.id}`);
    assert.ok(!names.has(entry.name), `duplicate preset name: ${entry.name}`);
    ids.add(entry.id);
    names.add(entry.name);

    const pack = normalizePack(entry.pack);
    assert.ok(pack.identity.trim() !== '', `${entry.name} has an identity`);
    for (const field of ['report', 'voice', 'samples', 'avoid']) {
      assert.ok(pack[field].length > 0, `${entry.name} has ${field}`);
    }
    assert.ok(pack.address.user !== '' && pack.address.subagent !== '');
    const { system } = buildRewritePrompt({ pack, masked: '改好了 [[0]]。', literalCount: 1, history: [] });
    assert.ok(system.includes(pack.identity), `${entry.name} reaches the rewrite prompt`);
  }
});

test('prompt carries the marker count and forbids invention', () => {
  const pack = normalizePack(undefined);
  const { system, user } = buildRewritePrompt({
    pack, masked: '改好了 [[0]] 。', literalCount: 1, history: ['上次这样说。'], stage: '刚执行了 read',
  });
  assert.ok(system.includes('1 个'));
  assert.ok(system.includes('不得新增原文没有的事实'));
  // Both halves of the card reach the prompt.
  assert.ok(system.includes('你是谁'));
  assert.ok(system.includes('这份汇报里怎么说话'));
  assert.ok(system.includes('口头禅与语气示例'));
  assert.ok(user.includes('[[0]]'));
  assert.ok(user.includes('上次这样说。'));
  assert.ok(user.includes('刚执行了 read'));
});

test('validateRewrite accepts a faithful rewrite', () => {
  const verdict = validateRewrite({
    candidate: '我改好了 [[0]]。',
    original: '已经改好了 [[0]]。',
    literalCount: 1,
    maxRatio: 1.35,
  });
  assert.equal(verdict.ok, true);
});

test('validateRewrite refuses dropped, invented and bloated output', () => {
  const base = { original: '已经改好了 [[0]]。', literalCount: 1, maxRatio: 1.35 };
  assert.equal(validateRewrite({ ...base, candidate: '已经改好了。' }).ok, false);
  assert.equal(validateRewrite({ ...base, candidate: '好了 [[0]] [[1]]' }).ok, false);
  assert.equal(validateRewrite({ ...base, candidate: '好了 [[0]]\n```\nx\n```' }).ok, false);
  // Tail fences count too: the input side protects `~~~`, so the output side has
  // to reject a block the model invents with the same syntax.
  assert.equal(validateRewrite({ ...base, candidate: '好了 [[0]]\n~~~sh\nx\n~~~' }).ok, false);
  assert.equal(validateRewrite({ ...base, candidate: '好了 [[0]]\n\n~~~\nx\n~~~' }).ok, false);
  assert.equal(validateRewrite({ ...base, candidate: '' }).ok, false);
  assert.equal(validateRewrite({ ...base, candidate: '好'.repeat(400) + '[[0]]' }).ok, false);
});

test('a fenced block is protected as one literal across the round trip', () => {
  const input = '我改了这段：\n```js\nconst x = path.join(a, b);\n```\n现在它通过了。';
  const { masked, literals } = mask(input);
  assert.equal(literals.length, 1);
  assert.match(literals[0], /path\.join/);

  const modelOutput = '这段我动了：\n[[0]]\n过了。';
  const verdict = validateRewrite({
    candidate: modelOutput,
    original: masked,
    literalCount: literals.length,
    maxRatio: 1.35,
  });
  assert.equal(verdict.ok, true);
  const restored = unmask(verdict.text, literals);
  assert.ok(restored.includes('const x = path.join(a, b);'), 'code survives byte for byte');
  assert.ok(!restored.includes('[[') , 'no marker leaks');
});

test('rewriteDistance separates a real rewrite from an appended catchphrase', () => {
  // Diagnostic only: the number is recorded beside each rewrite so an operator
  // can see whether the persona moved anything. It is deliberately NOT a gate —
  // whether a rewrite is in character is the persona card's job, and a threshold
  // here would cost a second model call to satisfy a proxy metric.
  const original = '刚刚完整走了一遍配置文件的加载流程，逐一核对了读取、解析和默认值填充环节，发现两处小问题。';

  // The pattern this metric makes visible: body copied verbatim, one line of
  // character glued on the end. By eye it reads "personalised"; it is not.
  const appended = `${original} 鲸鲸这条尾巴总算能甩得踏实点了。`;
  const appendedScore = rewriteDistance(original, appended);
  assert.equal(appendedScore.novelShare, 0, 'an appended sentence must not count as movement');
  assert.ok(appendedScore.lengthRatio > 1.3, 'it is detectably longer without being different');

  // A genuine re-voicing moves sentence structure, not just length.
  const rewritten = '鲸鲸刚把配置加载的流程整个走了一遍，读取、解析、默认值填充都挨个核过，揪出两处小毛病。';
  const rewrittenScore = rewriteDistance(original, rewritten);
  assert.ok(rewrittenScore.novelShare > 0.4, `expected real movement, got ${rewrittenScore.novelShare}`);
  assert.ok(rewrittenScore.lengthRatio < 1.3, 'a re-voicing does not have to be longer');

  // Identity is the degenerate case and must read as zero movement.
  assert.equal(rewriteDistance(original, original).novelShare, 0);
});
