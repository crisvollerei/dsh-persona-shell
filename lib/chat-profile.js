import { normalizeAvatar } from './avatar.js';
const fresh = () => ({ version: 1, revision: 0, avatar: null, avatarMode: 'account', userAddress: '' });
const modes = new Set(['account', 'custom', 'hidden']);

/** Plain optional address data. Count Unicode code points, not UTF-16 units or words. */
export function normalizeUserAddress(value) {
  // Check the raw value before trim so a trailing newline, BOM or direction
  // control cannot disappear into an apparently valid saved display string.
  if(typeof value!=='string'||/[\p{Cc}\p{Cs}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/u.test(value))return null;
  const address=value.trim();
  return address.length<=80&&[...address].length<=40?address:null;
}
function userAvatar(raw) {
  const value = normalizeAvatar(raw);
  if (value?.startsWith('builtin:')) throw new Error('invalid-avatar');
  return value;
}

/** Owner-controlled chat profile, separate from every persona and memory scope. */
export function createChatProfile({ persist = async () => {}, available = () => true } = {}) {
  let state = fresh(), writes = Promise.resolve();
  const read = () => ({ ...state });
  return {
    read, drain: () => writes,
    restore(raw) {
      state = fresh();
      if (raw?.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return;
      let avatar = null;
      try { avatar = userAvatar(raw.avatar); } catch { /* Invalid stored images are not displayed. */ }
      const avatarMode = modes.has(raw.avatarMode) ? raw.avatarMode : avatar ? 'custom' : 'account';
      state = { version: 1, revision: raw.revision, avatar, avatarMode: avatarMode === 'custom' && !avatar ? 'account' : avatarMode,
        userAddress:normalizeUserAddress(raw.userAddress)??'' };
    },
    update(input) {
      const task = writes.catch(() => {}).then(async () => {
        if (!available()) throw new Error('storage-not-ready');
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.revision) || input.revision < 0
          || (!Object.hasOwn(input, 'avatar') && !Object.hasOwn(input, 'avatarMode') && !Object.hasOwn(input,'userAddress'))) throw new Error('invalid-profile');
        const hasAvatar = Object.hasOwn(input, 'avatar');
        const avatar = hasAvatar ? userAvatar(input.avatar) : state.avatar;
        const avatarMode = input.avatarMode ?? (hasAvatar ? avatar ? 'custom' : 'account' : state.avatarMode);
        const userAddress=Object.hasOwn(input,'userAddress')?normalizeUserAddress(input.userAddress):state.userAddress;
        if (!modes.has(avatarMode) || (avatarMode === 'custom' && !avatar) || userAddress===null) throw new Error('invalid-profile');
        if (state.avatar === avatar && state.avatarMode === avatarMode && state.userAddress === userAddress) return read();
        if (input.revision !== state.revision) throw new Error('profile-conflict');
        const next = { version: 1, revision: state.revision + 1, avatar, avatarMode, userAddress };
        await persist({ ...next }); state = next;
        return read();
      });
      writes = task.catch(() => {}); return task;
    },
  };
}
