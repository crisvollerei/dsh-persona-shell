/** Only a complete source message may be rewritten or quoted as work progress. */
export function sourceOutputUsable(data) {
  if (data?.interrupted === true) return false;
  // Older sessions may omit the stream. DSH 0.2.x stores non-delta chunks
  // as { type: 'chunk', time, chunk }; a length stop still commits a message.
  if (!Array.isArray(data?.stream)) return true;
  return !data.stream.some(record => {
    const chunk = record?.chunk ?? record;
    if (chunk?.type === 'error') return true;
    if (chunk?.type !== 'finish') return false;
    return chunk.reason?.kind !== 'stop' && !(chunk.reason?.kind === 'tool-calls'
      && Array.isArray(data.message?.content) && data.message.content.some(b => b?.type === 'tool-call'));
  });
}
