import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinAvatar, normalizeAvatar, restoreAvatar, avatarUrl, avatarContent, AVATAR_BYTES } from '../lib/avatar.js';
import { normalizePack } from '../lib/pack.js';
import { makeAvatar } from './helpers/avatar-fixture.mjs';
import { deflateSync } from 'node:zlib';

test('avatar accepts known builtin references and bounded local PNGs without allowing URLs, SVG or malformed data', () => {
  const valid = makeAvatar(); assert.equal(normalizeAvatar(valid), valid);
  assert.equal(normalizeAvatar(builtinAvatar('大肥龙')), 'builtin:dafeilong');
  assert.equal(builtinAvatar('自定义'), null); assert.equal(normalizeAvatar(null), null);
  assert.equal(builtinAvatar('toString'), null); assert.equal(builtinAvatar('__proto__'), null);
  for (const raw of ['https://remote.invalid/image.jpg', 'file:///private.png', 'builtin:../secret', 'builtin:unknown',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,' + 'A'.repeat(AVATAR_BYTES * 2), { url: valid },
    valid.slice(0, -4), valid.replace('iVBOR', 'AAAAA')]) {
    assert.throws(() => normalizeAvatar(raw), /invalid-avatar/); assert.equal(restoreAvatar(raw), null);
  }
});

test('a checksum-valid PNG still needs a valid bounded raster and valid row filters', () => {
  const badFilter = Buffer.alloc(256 * 1025); badFilter[0] = 9;
  for (const compressed of [Buffer.from('not a zlib stream'), deflateSync(Buffer.alloc(1024 * 1024)), deflateSync(badFilter)]) {
    assert.throws(() => normalizeAvatar(makeAvatar(100, compressed)), /invalid-avatar/);
  }
});

test('avatar metadata is versioned for the page, stored outside the pack and resolves only fixed builtin paths', () => {
  const first = { id: '自定义 / 甲', avatar: makeAvatar() }, second = { ...first, avatar: makeAvatar(200) };
  assert.notEqual(avatarUrl(first), avatarUrl(second)); assert.match(avatarUrl(first), /%2F/);
  assert.equal(avatarUrl({}), undefined); assert.equal(avatarContent(null), undefined);
  assert.equal(avatarContent('builtin:../secret'), undefined);
  assert.equal(avatarContent('builtin:claude').file.pathname.endsWith('/assets/avatars/claude.webp'), true);
  const cat = builtinAvatar('Gemini');
  assert.equal(avatarContent(cat).file.pathname.endsWith('/assets/avatars/gemini.webp'), true);
  assert.match(avatarUrl({ id: 'fork', avatar: cat }), /&frame=cat-portrait$/);
  assert.doesNotMatch(avatarUrl({ id: 'Gemini', avatar: first.avatar }), /frame=/);
  assert.deepEqual(avatarContent(first.avatar).data, Buffer.from(first.avatar.split(',')[1], 'base64'));
  assert.equal(Object.hasOwn(normalizePack({ identity: '角色', avatar: first.avatar }), 'avatar'), false);
});
