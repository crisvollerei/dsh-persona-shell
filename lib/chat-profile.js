import { normalizeAvatar } from './avatar.js';
const fresh = () => ({ version: 1, revision: 0, avatar: null, avatarMode: 'account' });
const modes = new Set(['account', 'custom', 'hidden']);
function userAvatar(raw) {
  const value = normalizeAvatar(raw);
  if (value?.startsWith('builtin:')) throw new Error('invalid-avatar');
  return value;
}

/** Presentation-only owner profile, separate from every persona and memory scope. */
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
      state = { version: 1, revision: raw.revision, avatar, avatarMode: avatarMode === 'custom' && !avatar ? 'account' : avatarMode };
    },
    update(input) {
      const task = writes.catch(() => {}).then(async () => {
        if (!available()) throw new Error('storage-not-ready');
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.revision) || input.revision < 0
          || (!Object.hasOwn(input, 'avatar') && !Object.hasOwn(input, 'avatarMode'))) throw new Error('invalid-profile');
        const hasAvatar = Object.hasOwn(input, 'avatar');
        const avatar = hasAvatar ? userAvatar(input.avatar) : state.avatar;
        const avatarMode = input.avatarMode ?? (hasAvatar ? avatar ? 'custom' : 'account' : state.avatarMode);
        if (!modes.has(avatarMode) || (avatarMode === 'custom' && !avatar)) throw new Error('invalid-profile');
        if (state.avatar === avatar && state.avatarMode === avatarMode) return read();
        if (input.revision !== state.revision) throw new Error('profile-conflict');
        const next = { version: 1, revision: state.revision + 1, avatar, avatarMode };
        await persist({ ...next }); state = next;
        return read();
      });
      writes = task.catch(() => {}); return task;
    },
  };
}
