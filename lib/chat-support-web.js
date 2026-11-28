import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate } from 'node:zlib';
import { publicSupportUrl } from './chat-support-templates.js';

export function publicIpv4(value) {
  const p = value.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || b === 2)) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}
export function supportAbortable(value, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? Error('support-cancelled'));
    signal?.addEventListener('abort', stop, { once: true });
    Promise.resolve(value)
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', stop));
  });
}
function pageText(raw) {
  const body = raw.replace(
    /<(script|style|noscript|svg|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    ' '
  );
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(body)?.[2];
  return (main?.trim() ? main : body)
    .replace(/<[^>]*>/gu, ' ')
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|#39);/gu,
      (s) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[s]
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 5000);
}

async function responseText(response, encoding, charset, signal) {
  let received = 0,
    decoded = 0;
  const compressed = encoding !== 'identity';
  const count = new Transform({
    transform(chunk, _, done) {
      received += chunk.length;
      if (received > (compressed ? 524288 : 262144)) done(Error('support-page-size'));
      else done(null, chunk);
    }
  });
  const decoder = encoding === 'gzip' ? [createGunzip()] : encoding === 'deflate' ? [createInflate()] : [];
  const chunks = [];
  await pipeline(
    response,
    count,
    ...decoder,
    async (source) => {
      for await (const chunk of source) {
        decoded += chunk.length;
        if (decoded > 1048576) throw Error('support-page-size');
        chunks.push(chunk);
      }
    },
    { signal }
  );
  let textDecoder;
  try { textDecoder = new TextDecoder(charset); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    textDecoder = new TextDecoder('utf-8');
  }
  return textDecoder.decode(Buffer.concat(chunks));
}
/** Anonymous HTTPS only; DNS is pinned on every hop, not merely checked before a second lookup. */
export function createSupportPageReader({ lookup = dnsLookup, request = httpsRequest, timeoutMs = 15000 } = {}) {
  async function read(raw, signal) {
    const original = publicSupportUrl(raw);
    if (!original) throw Error('support-url');
    let current = new URL(original);
    for (let hop = 0; hop <= 2; hop++) {
      signal?.throwIfAborted();
      const addresses = await supportAbortable(lookup(current.hostname, { family: 4, all: true }), signal);
      if (!addresses.length || addresses.some((a) => a.family !== 4 || !publicIpv4(a.address)))
        throw Error('support-private-address');
      const pinned = addresses[0].address;
      const response = await new Promise((resolve, reject) => {
        const req = request(
          current,
          {
            family: 4,
            signal,
            headers: {
              'user-agent': 'dsh-persona-shell/0.5.5',
              'accept': 'text/html,text/plain',
              'accept-encoding': 'gzip, deflate, identity'
            },
            lookup: (_host, options, cb) =>
              options?.all ? cb(null, [{ address: pinned, family: 4 }]) : cb(null, pinned, 4)
          },
          resolve
        );
        req.on('error', reject);
        req.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        const next = new URL(response.headers.location ?? '', current);
        const wwwAlias =
          next.hostname === 'www.' + current.hostname || current.hostname === 'www.' + next.hostname;
        if (
          hop === 2 ||
          (!wwwAlias && next.origin !== current.origin) ||
          !publicSupportUrl(next.href) ||
          !response.headers.location
        )
          throw Error('support-redirect');
        current = next;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        throw Error('support-page-status');
      }
      const type = String(response.headers['content-type'] ?? '');
      const encoding = String(response.headers['content-encoding'] ?? 'identity')
        .trim()
        .toLowerCase();
      if (
        !/^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/iu.test(type) ||
        !['gzip', 'deflate', 'identity'].includes(encoding)
      ) {
        response.destroy();
        throw Error('support-page-type');
      }
      const charset = /;\s*charset\s*=\s*["']?([\w-]+)/iu.exec(type)?.[1] ?? 'utf-8';
      const raw = await responseText(response, encoding, charset, signal);
      const text = type.toLowerCase().startsWith('text/plain')
        ? raw.replace(/\s+/gu, ' ').trim().slice(0, 5000)
        : pageText(raw);
      if (!text) throw Error('support-page-empty');
      return { url: current.href, text };
    }
    throw Error('support-redirect');
  }
  return async function readPage(raw, { signal } = {}) {
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(Error('support-page-timeout')),timeoutMs);
    const combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
    try { return await read(raw,combined); }
    catch(error) { combined.throwIfAborted(); throw error; }
    finally { clearTimeout(timer); }
  };
}
