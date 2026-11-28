import { isDeepStrictEqual } from 'node:util';

export const ROW_REV = Symbol('report-row-revision');

// Report fields (including review, speaker and memoryRefs) are replaced as whole values.
export function versionReportRow(fields) {
  let rev=0;
  return new Proxy(fields, {
    get(target,key){return key==='rev'?rev:target[key];},
    set(target,key,value){if(!Object.is(target[key],value)){target[key]=value;rev++;}return true;},
    deleteProperty(target,key){if(Object.hasOwn(target,key)){delete target[key];rev++;}return true;},
  });
}

/** Latest-state coalescing, not an unbounded token/event journal. */
export function createStateStream({ read }) {
  const listeners = new Map();
  let closed = false;
  const stats = { active: 0, opened: 0, snapshots: 0, deltas: 0 };
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
      let cache = new Map();
      try {
        while (!closed && !signal.aborted) {
          if (!dirty) {
            await new Promise((resolve) => { wake = resolve; });
            wake = undefined;
            continue;
          }
          dirty = false;
          const { rows, ...metadata } = read(key);
          const header = JSON.stringify(metadata);
          const nextCache = new Map();
          const encoded = new Map();
          for (const row of rows) {
            let entry = cache.get(row.seq);
            const rev = row[ROW_REV];
            if (!entry || (rev !== undefined ? entry.rev !== rev : !isDeepStrictEqual(row, entry.snapshot))) {
              const wire = JSON.stringify(row);
              entry = rev !== undefined ? { rev, wire } : { snapshot: structuredClone(row), wire };
            }
            nextCache.set(row.seq, entry);
            encoded.set(row.seq, entry.wire);
          }
          cache = nextCache;
          const previousRows = previous?.rows;
          if (!previousRows) {
            stats.snapshots += 1;
            previous = { header, rows: encoded, rev: metadata.rev };
            yield { ...JSON.parse(header), rows: [...encoded.values()].map(value => JSON.parse(value)), type: 'snapshot' };
          } else {
            const upsert = [...encoded].filter(([seq, value]) => previousRows.get(seq) !== value);
            const removed = [...previousRows.keys()].filter(seq => !encoded.has(seq));
            if (previous.header === header && !upsert.length && !removed.length) continue;
            const baseRev = previous.rev;
            previous = { header, rows: encoded, rev: metadata.rev };
            stats.deltas += 1;
            yield { ...JSON.parse(header), type: 'delta', baseRev, removed,
              upsert: upsert.map(([,value]) => JSON.parse(value)) };
          }
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
