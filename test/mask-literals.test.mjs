import test from 'node:test';
import assert from 'node:assert/strict';
import { mask, markers, markersIntact, unmask } from '../lib/mask.js';
import { validateRewrite } from '../lib/prompt.js';

test('ordinary English uses of command names remain editable prose', () => {
  for (const prose of [
    'Please go to the settings and enable the option.',
    'Make sure all tests pass, then go back to the report.',
    'We should make sure all tests pass.',
    'The node is ready and cargo is available.',
    'Please make the report clear.',
    'This npm package provides a renderer.',
    'Published npm packages remain available.',
  ]) {
    assert.deepEqual(mask(prose), { masked: prose, literals: [] }, prose);
  }
});

test('bare command recognition stops at prose and does not cross a line break', () => {
  const input = 'Run npm test and then go to the settings.\nmake sure all tests pass.\nThe git status is clean.';
  const result = mask(input);
  assert.deepEqual(result.literals, ['npm test', 'git status']);
  assert.equal(result.masked, 'Run [[0]] and then go to the settings.\nmake sure all tests pass.\nThe [[1]] is clean.');
  assert.equal(unmask(result.masked, result.literals), input);
});

test('real bare commands retain their flags, arguments and exact bytes', () => {
  for (const command of [
    'npm run build', 'npx --yes typescript --version', 'pnpm install --frozen-lockfile',
    'node scripts/check.mjs', 'python -m pytest', 'git diff --check',
    'go test ./...', 'go version', 'go env GOPATH', 'make all', 'make custom-target',
    'make -f Makefile test', 'docker compose up', 'curl --version',
  ]) {
    const input = `执行 ${command} 后继续。`;
    const result = mask(input);
    assert.deepEqual(result.literals, [command], command);
    assert.equal(unmask(result.masked, result.literals), input);
  }
});

test('explicit command wording still protects a noun-like or invalid command literally',()=>{
  assert.deepEqual(mask('执行 npm package。').literals,['npm package']);
  assert.deepEqual(mask('Run npm package').literals,['npm package']);
});

test('explicit code, nested fences, paths and versions stay protected regardless of English ambiguity', () => {
  const input = [
    '`go to the settings` and `make sure all tests pass` are literal examples.',
    '````txt\nmake sure all tests pass\n```\ngo to the settings\n````',
    '路径 D:\\work\\settings.json 和 ./src/main.js 以及 /tmp，版本 v0.5.0。',
  ].join('\n');
  const result = mask(input);
  assert.equal(result.literals.length, 7);
  assert.ok(result.literals.includes('````txt\nmake sure all tests pass\n```\ngo to the settings\n````'));
  assert.ok(result.literals.includes('v0.5.0'));
  assert.equal(unmask(result.masked, result.literals), input);
});

test('equal literal bytes retain independent occurrence markers and conditions', () => {
  const input = '检查通过后运行 `npm test`；权限未验时不要运行 `npm test`。';
  const result = mask(input);
  assert.deepEqual(result.literals, ['`npm test`', '`npm test`']);
  assert.deepEqual(markers(result.masked), [0, 1]);
  assert.equal(markersIntact('检查通过后运行 [[0]]；权限未验时不要运行 [[1]]。', 2), true);
  assert.equal(markersIntact('检查通过后运行 [[0]]；权限未验时不要运行 [[0]]。', 2), false);
  assert.equal(validateRewrite({ original: result.masked, candidate: '检查通过后运行 [[0]]。', literalCount: 2, maxRatio: 1.35 }).ok, false);
  assert.equal(unmask(result.masked, result.literals), input);
});
