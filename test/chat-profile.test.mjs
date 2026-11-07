import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatProfile } from '../lib/chat-profile.js';
import { makeAvatar } from './helpers/avatar-fixture.mjs';

test('user avatar commits before visibility, survives restore, and an acknowledged retry is idempotent', async () => {
  let release, saved; const gate = new Promise((r) => { release = r; });
  const profile = createChatProfile({ persist: async (value) => { await gate; saved = value; } });
  const avatar = makeAvatar(); const task = profile.update({ revision: 0, avatar });
  await Promise.resolve(); assert.equal(profile.read().avatar, null); release(); await task;
  assert.equal(profile.read().revision, 1); assert.equal(saved.avatar, avatar);
  assert.equal((await profile.update({ revision: 0, avatar })).revision, 1);
  const restored = createChatProfile(); restored.restore(saved); assert.deepEqual(restored.read(), profile.read());
});

test('failed or concurrent user avatar writes preserve the last confirmed value', async () => {
  let fail = false;
  const profile = createChatProfile({ persist: async () => { if (fail) throw Error('disk'); } });
  const first = makeAvatar(), second = makeAvatar(200);
  const results = await Promise.allSettled([profile.update({ revision: 0, avatar: first }), profile.update({ revision: 0, avatar: second })]);
  assert.equal(results[0].status, 'fulfilled'); assert.match(results[1].reason.message, /profile-conflict/);
  fail = true; await assert.rejects(profile.update({ revision: 1, avatar: null }), /disk/);
  assert.equal(profile.read().avatar, first); assert.equal(profile.read().revision, 1);
  fail = false; await profile.update({ revision: 1, avatar: null }); assert.equal(profile.read().avatar, null);
  await profile.drain();
});

test('user profile rejects remote images and builtin role images, and ignores malformed persisted metadata', async () => {
  const profile = createChatProfile();
  for (const avatar of ['https://invalid.test/a.png', 'builtin:jingjing', 'data:image/svg+xml;base64,PHN2Zy8+']) {
    await assert.rejects(profile.update({ revision: 0, avatar }), /invalid-avatar/);
    profile.restore({ version: 1, revision: 9, avatar }); assert.equal(profile.read().avatar, null);
  }
  profile.restore({ version: 1, revision: -1, avatar: makeAvatar() }); assert.equal(profile.read().revision, 0);
  const opening = createChatProfile({ available: () => false });
  await assert.rejects(opening.update({ revision: 0, avatar: makeAvatar() }), /storage-not-ready/);
});

test('account is the default, legacy uploads stay custom, and hiding preserves the uploaded image', async () => {
  const profile = createChatProfile(); assert.equal(profile.read().avatarMode, 'account');
  const avatar = makeAvatar(); profile.restore({ version: 1, revision: 5, avatar });
  assert.equal(profile.read().avatarMode, 'custom');
  await profile.update({ revision: 5, avatarMode: 'hidden' });
  assert.equal(profile.read().avatar, avatar); assert.equal(profile.read().avatarMode, 'hidden');
  const next = createChatProfile(); next.restore(profile.read()); assert.equal(next.read().avatarMode, 'hidden');
  await profile.update({ revision: 6, avatarMode: 'account' }); assert.equal(profile.read().avatar, avatar);
  await assert.rejects(profile.update({ revision: 6, avatarMode: 'custom' }), /profile-conflict/);
  await profile.update({ revision: 7, avatarMode: 'custom' });
  await profile.update({ revision: 8, avatar: null }); assert.equal(profile.read().avatarMode, 'account');
  await assert.rejects(profile.update({ revision: 9, avatarMode: 'custom' }), /invalid-profile/);
});

test('display-mode save failures and invalid modes do not alter confirmed state', async () => {
  const profile = createChatProfile({ persist: async () => { throw Error('disk'); } });
  await assert.rejects(profile.update({ revision: 0, avatarMode: 'hidden' }), /disk/);
  assert.equal(profile.read().avatarMode, 'account'); assert.equal(profile.read().revision, 0);
  await assert.rejects(profile.update({ revision: 0, avatarMode: 'other' }), /invalid-profile/);
  await assert.rejects(profile.update(null), /invalid-profile/);
});
