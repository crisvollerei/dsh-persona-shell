/** Return undefined if the request exceeds the route's byte limit. */
export async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}
