import { restoreReview } from './review.js';
import { restoreToolUsage } from './tool-usage.js';
import { validateProcessNote } from './process-rewrite.js';

export function createHostReportRows({
  cfg, notifySession, originalReportLimit, rows, rowsBySession, sessionRows, setReportRow,
  getStore, touch, warn,
}) {
  /** Coalesce persistence so a burst of settles writes one blob per session. */
  const persistTimers = new Map();
  const awaitingHydration = new Set();

  /**
   * Write one session's rows now.
   *
   * Separate from the debounce so the unload path can drain instead of merely
   * cancelling: cancelling a pending write discarded a rewrite that had already
   * settled and been shown to the reader.
   * @param {string} sessionId
   */
  function flushPersist(sessionId) {
    if (getStore() === undefined) return Promise.resolve();
    // Pull the stored rows in first. The write replaces the whole session blob,
    // so persisting a session that was never hydrated would erase every row this
    // process has not touched yet — which is exactly what a restart plus one new
    // message used to do.
    if (sessionId !== '') {
      awaitingHydration.delete(sessionId);
      hydrate(sessionId);
      if (!hydrated.has(sessionId)) {
        awaitingHydration.add(sessionId);
        return Promise.resolve();
      }
    }
    const own = [...sessionRows(sessionId)];
    own.sort((a, b) => a.seq - b.seq);
    return getStore().put(sessionId, own.map((row) => ({
      seq: row.seq,
      status: row.status,
      text: row.text,
      reason: row.reason,
      model: row.model,
      distance: row.distance,
      review: row.review,
      processNote: row.processNote,
      processUsage: row.processUsage,
      process: row.process === true,
      original: row.original,
      version: row.version,
      speaker: row.speaker,
      memoryRefs: row.memoryRefs,
      sourceIsSubagent: row.sourceIsSubagent === true,
      final: row.final === true && row.finalInferred !== true,
      time: row.time,
    }))).catch((error) => warn(`persist failed for ${sessionId}`, error));
  }

  function schedulePersist(sessionId) {
    if (getStore() === undefined) return;
    if (persistTimers.has(sessionId)) return;
    persistTimers.set(sessionId, setTimeout(() => {
      persistTimers.delete(sessionId);
      flushPersist(sessionId);
    }, 400));
  }

  /** Sessions whose persisted rows have already been pulled in. */
  let hydrated = new Set();
  /** Hydrate one session's rows from the store, so a restart keeps them. */
  function hydrate(sessionId) {
    // Only mark a session as hydrated once a read actually happened: marking it
    // while storage was still opening would block the one read that matters.
    if (getStore() === undefined) return;
    if (hydrated.has(sessionId)) return;
    let savedRows;
    try {
      savedRows = getStore().get(sessionId);
    } catch (error) {
      // Leave it un-hydrated so a later state read can retry; a failed read
      // must not permanently hide this session's stored history.
      warn(`hydrate failed for ${sessionId}`, error);
      return;
    }
    try {
      let legacyFinalUnknown = false;
      let recoveredStatus = false;
      for (const saved of savedRows) {
        if (!Number.isSafeInteger(saved?.seq) || saved.seq < 0) continue;
        if (saved.final === undefined) legacyFinalUnknown = true;
        const key = `${sessionId}:${saved.seq}`;
        if (rows.has(key)) continue;
        if (saved.status !== 'ready' && saved.status !== 'skipped') recoveredStatus = true;
        setReportRow(key, {
          sessionId,
          seq: saved.seq,
          status: saved.status === 'ready' ? 'ready' : 'skipped',
          text: typeof saved.text === 'string' ? saved.text : '',
          reason: typeof saved.reason === 'string' ? saved.reason : '',
          model: typeof saved.model === 'string' ? saved.model : '',
          distance: typeof saved.distance === 'object' ? saved.distance : undefined,
          review: restoreReview(saved.review),
          processNote: saved.final === true ? undefined : validateProcessNote(saved.processNote, saved.processUsage),
          processUsage: saved.final === true ? undefined : restoreToolUsage(saved.processUsage),
          process: saved.process === true,
          original: typeof saved.original === 'string' && saved.original.length <= originalReportLimit ? saved.original : undefined,
          version: Number.isSafeInteger(saved.version) && saved.version > 0 ? saved.version : 1,
          speaker: typeof saved.speaker?.id === 'string' && typeof saved.speaker?.name === 'string'
            ? { id: saved.speaker.id.slice(0, 200), name: saved.speaker.name.slice(0, 80),
              mode: saved.speaker.mode === 'relay' ? 'relay' : 'voice' } : undefined,
          memoryRefs: Array.isArray(saved.memoryRefs) ? saved.memoryRefs.filter((ref) =>
            typeof ref?.id === 'string' && ref.id.length <= 160 && Number.isSafeInteger(ref.version) && ref.version > 0)
            .slice(0, 5).map((ref) => ({ id: ref.id, version: ref.version })) : [],
          sourceIsSubagent: saved.sourceIsSubagent === true,
          final: saved.final === true,
          time: typeof saved.time === 'number' ? saved.time : Date.now(),
        });
      }
      trim(sessionId);
      if (legacyFinalUnknown) markRestoredTail(sessionId);
      hydrated.add(sessionId);
      if (awaitingHydration.delete(sessionId)) schedulePersist(sessionId);
      if (recoveredStatus) touch(sessionId);
      else notifySession(sessionId);
    } catch (error) {
      warn(`hydrate failed for ${sessionId}`, error);
    }
  }

  /**
   * Give the newest restored row of a session the "final" flag.
   *
   * `final` is set by `turn/end`, which is a live event: a restart never replays
   * it, so every restored row arrived with `final: false` and the page drew no
   * persona badge and no 「原文」 toggle on any history at all.
   *
   * The exact turn boundary is not recoverable from stored rows, so the tail is
   * used: it is the one a reader scrolls back to, and being wrong here only
   * moves a button to a neighbouring row.
   * @param {string} sessionId
   */
  function markRestoredTail(sessionId) {
    let newest;
    for (const row of sessionRows(sessionId)) {
      if (row.final === true) return; // a live turn already marked one
      if (row.process === true) continue;
      if (row.status !== 'ready') continue;
      if (newest === undefined || row.seq > newest.seq) newest = row;
    }
    if (newest !== undefined) { newest.final = true; newest.finalInferred = true; }
  }

  /** Keep results bounded, including failed preparations that never reach rewrite(). */
  function trim(sessionId) {
    const own = [...sessionRows(sessionId)];
    const limit = Math.max(20, cfg.maxRowsPerSession);
    if (own.length <= limit) return;
    own.sort((a, b) => a.seq - b.seq);
    for (const row of own.slice(0, own.length - limit)) {
      rows.delete(`${row.sessionId}:${row.seq}`);
      rowsBySession.get(sessionId).delete(row.seq);
    }
    touch(sessionId);
  }

  return {
    trim, hydrate, schedulePersist, persistTimers, hydrated, flushPersist, awaitingHydration,
  };
}
