/** Latest-state coalescing, not an unbounded token/event journal. */
export function createStateStream({ read }) {
  const listeners = new Map();
  let closed = false;
  const stats = { active: 0, opened: 0, snapshots: 0, deltas: 0 };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const changed = (key) => { for (const notify of listeners.get(key) ?? []) notify(); };
  return {
    changed,
    stats: () => ({ ...stats }),
    close() {
      closed = true;
      for (const key of listeners.keys()) changed(key);
    },
    async *observe(key, signal) {
      if (closed || signal.aborted) return;
      let dirty = true;
      let wake;
      const notify = () => { dirty = true; wake?.(); };
      let own = listeners.get(key);
      if (!own) { own = new Set(); listeners.set(key, own); }
      // Attach before capturing the opening baseline: no snapshot/listener gap.
      own.add(notify);
      stats.active += 1; stats.opened += 1;
      signal.addEventListener('abort', notify);
      let previous;
      try {
        while (!closed && !signal.aborted) {
          if (!dirty) {
            await new Promise((resolve) => { wake = resolve; });
            wake = undefined;
            continue;
          }
          dirty = false;
          const next = clone(read(key));
          if (previous && JSON.stringify(previous) === JSON.stringify(next)) continue;
          if (previous === undefined) {
            stats.snapshots += 1;
            yield { ...next, type: 'snapshot' };
          } else {
            stats.deltas += 1;
            const before = new Map(previous.rows.map((row) => [row.seq, JSON.stringify(row)]));
            const after = new Set(next.rows.map((row) => row.seq));
            const { rows, ...metadata } = next;
            yield { ...metadata, type: 'delta', baseRev: previous.rev,
              upsert: rows.filter((row) => before.get(row.seq) !== JSON.stringify(row)),
              removed: previous.rows.filter((row) => !after.has(row.seq)).map((row) => row.seq) };
          }
          previous = next;
        }
      } finally {
        signal.removeEventListener('abort', notify);
        own.delete(notify);
        stats.active -= 1;
        if (!own.size) listeners.delete(key);
      }
    },
  };
}
