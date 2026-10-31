import { createHash } from 'node:crypto';

/** Only the published DSH fs edit/write result metadata is supported. Never inspect arguments or diff text. */
export function changedFileKey(name, data) {
  if (!['edit', 'write'].includes(name) || data?.message?.isError !== false) return;
  const meta = data.meta;
  if (!meta || typeof meta.path !== 'string' || meta.path.length > 8192
    || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(meta.path) || !Array.isArray(meta.diffs) || meta.diffs.length > 4096
    || (name === 'write' && !['create', 'update'].includes(meta.operation))) return;
  if (meta.diffs.length === 0 && meta.operation !== 'create') return null;
  // The producer supplies a canonical execution-world path; keep only an opaque identity locally.
  return createHash('sha256').update(meta.path).digest('hex');
}

export function workNature({ available, categories, calls, files, unknownFiles }) {
  const unknown = { is_read_only: null, files_touched: null, ran_destructive_cmd: null };
  if (!available) return Object.freeze(unknown);
  const activity = (key) => (categories[key]?.calls ?? 0) + (categories[key]?.returned ?? 0) > 0;
  const pending = [...calls.values()].filter((call) => !call.returned && !['read', 'search'].includes(call.category));
  const opaque = activity('execute') || activity('other') || pending.some((call) => call.category !== 'edit');
  return Object.freeze({
    is_read_only: activity('edit') ? false : opaque || pending.length ? null
      : activity('read') || activity('search') ? true : null,
    files_touched: opaque || pending.length || unknownFiles ? null : files.size,
    // No common command-risk metadata exists in the current SDK; an opaque execution is unknown.
    ran_destructive_cmd: opaque ? null : false,
  });
}

export function restoreWorkNature(value) {
  const fields = ['is_read_only', 'files_touched', 'ran_destructive_cmd'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || ![null, true, false].includes(value.is_read_only) || ![null, true, false].includes(value.ran_destructive_cmd)
    || !(value.files_touched === null || (Number.isInteger(value.files_touched) && value.files_touched >= 0 && value.files_touched <= 4096))
    || (value.is_read_only === true && (value.files_touched !== 0 || value.ran_destructive_cmd !== false))) return;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}
