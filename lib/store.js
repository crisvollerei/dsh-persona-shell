/**
 * Durable storage for rewrites.
 *
 * Rewrites are derived state, so they must not go into the session log. They
 * also must not live only in memory: the host restarts often, and a restart
 * that wiped every rewrite would silently downgrade every earlier assistant
 * message back to its plain text.
 *
 * Storage is optional. When the host exposes no storage service the caller
 * keeps its in-memory rows, and only a restart is lost.
 */

/**
 * Domain name and version.
 *
 * The name must match the storage facility's `UNIT_NAME_RE`, which is
 * `/^[a-z][a-z0-9_]*$/`: lowercase, digits and underscores only. Neither
 * `persona-shell` (hyphen) nor `personaShell` (capital) is accepted — both fail
 * with "invalid unit name". Bump `version` for incompatible record changes.
 * Optional row.review metadata is versioned independently; old rows remain valid.
 */
const DOMAIN = 'persona_shell';
const VERSION = 1;

/** The profile table holds one aggregate row, so it needs one key. */
const PROFILE_KEY = 'default';

/** Key holding the id of the active preset, in the same table. */
const ACTIVE_KEY = 'activePreset';

/** Key holding the durable settings switches, in the same table. */
const SETTINGS_KEY = 'settings';

/**
 * Key holding per-session switch overrides.
 *
 * Same table as the profile and the active pointer for the same reason: the
 * storage facility counts tables, not keys, and this is a tiny settings-shaped
 * record. Keeping it out of the `sessions` table avoids changing that record's
 * shape and needing a domain version bump.
 */
const SESSION_SWITCHES_KEY = 'sessionSwitches';

/**
 * Open the plugin's own table.
 *
 * A single JSON blob per session keeps the record count at one write per step
 * batch instead of one write per row, and the whole blob is small: it holds
 * text the user already sees.
 *
 * Availability is re-checked every call: the facility is a service like any
 * other, and a plugin that started before it existed would otherwise stay
 * memory-only for the life of the process.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ get: (id: string) => Record<string, any>[], put: (id: string, rows: readonly any[]) => Promise<void>, close: () => Promise<void> } | undefined>}
 */
export async function openStore(ctx) {
  const storage = ctx.get('storageDomain');
  if (storage === undefined) {
    throw new Error('storage unavailable: storageDomain service is absent');
  }

  try {
    const domain = await storage.open({
      name: DOMAIN,
      version: VERSION,
      invalidRecords: 'backup-and-skip',
      tables: {
        // Keyed by session id; the value is that session's whole row set.
        sessions: { valueSchema: { parse: (value) => value } },
        // Cross-session learned preferences. One row, because it is a single
        // aggregate that every session reads and writes.
        profile: { valueSchema: { parse: (value) => value } },
        // Named persona presets, keyed by id.
        presets: { valueSchema: { parse: (value) => value } },
      },
    });

    const sessions = domain.table('sessions');
    const profile = domain.table('profile');
    const presetTable = domain.table('presets');
    return {
      get(sessionId) {
        const value = sessions.get(sessionId);
        return Array.isArray(value) ? value : [];
      },
      async put(sessionId, rows) {
        await sessions.put(sessionId, rows);
      },
      /** Cross-session learned preferences; a single row keyed `default`. */
      getProfile() {
        const value = profile.get(PROFILE_KEY);
        return value !== null && typeof value === 'object' ? value : undefined;
      },
      async putProfile(value) {
        await profile.put(PROFILE_KEY, value);
      },
      /** All stored presets, in insertion order as the KV returns them. */
      listPresets() {
        const out = [];
        for (const entry of presetTable.entries()) out.push(entry[1]);
        return out;
      },
      async putPreset(preset) {
        await presetTable.put(preset.id, preset);
      },
      /**
       * Which preset was active.
       *
       * Stored in the profile table under its own key rather than inside the
       * profile row: the profile is an accumulating aggregate, and mixing a
       * pointer into it would make every preset switch look like a learning
       * update. Both live in one table because the facility counts tables, not
       * keys.
       */
      getActivePreset() {
        const value = profile.get(ACTIVE_KEY);
        return typeof value === 'string' ? value : undefined;
      },
      async putActivePreset(id) {
        await profile.put(ACTIVE_KEY, id);
      },
      /**
       * The durable part of the settings.
       *
       * Only the switches and the model route: the persona card travels with its
       * preset, so duplicating it here would create a second source of truth.
       * Without this the page said 「已保存」 while a restart silently restored
       * the defaults — including turning memory back on for someone who had
       * switched it off.
       */
      getSettings() {
        const value = profile.get(SETTINGS_KEY);
        return value !== null && typeof value === 'object' ? value : undefined;
      },
      async putSettings(value) {
        await profile.put(SETTINGS_KEY, value);
      },
      /** Per-session switches: `{ rev, values }`, only explicit `false` entries. */
      getSessionSwitches() {
        const value = profile.get(SESSION_SWITCHES_KEY);
        return value !== null && typeof value === 'object' ? value : undefined;
      },
      async putSessionSwitches(value) {
        await profile.put(SESSION_SWITCHES_KEY, value);
      },
      async deletePreset(id) {
        return presetTable.delete(id);
      },
      async close() {
        await domain.close();
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    ctx.logger?.warn?.(`[persona-shell] storage unavailable — ${detail}`);
    // Re-thrown so the caller can surface it: a silently memory-only plugin is
    // indistinguishable from a persisting one until a restart loses everything.
    throw new Error(`storage unavailable: ${detail}`);
  }
}
