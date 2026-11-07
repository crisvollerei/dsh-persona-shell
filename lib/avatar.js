import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const AVATAR_BYTES = 384 * 1024;
const builtinIds = Object.freeze({ '大肥鱼（默认）': 'dafeiyu', '大肥龙': 'dafeilong', 'Claude小姐': 'claude', '鲸鲸（实验性）': 'jingjing', Gemini: 'gemini' });
const keys = new Set(Object.values(builtinIds));
export const builtinAvatar = (personaId) => Object.hasOwn(builtinIds, personaId) ? 'builtin:' + builtinIds[personaId] : null;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Only local, bounded raster data; avatars never become prompt fields or remote image requests. */
export function normalizeAvatar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('invalid-avatar');
  if (value.startsWith('builtin:') && keys.has(value.slice(8))) return value;
  const prefix = 'data:image/png;base64,';
  if (!value.startsWith(prefix) || value.length > prefix.length + Math.ceil(AVATAR_BYTES / 3) * 4) throw new Error('invalid-avatar');
  const encoded = value.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid-avatar');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length > AVATAR_BYTES || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('invalid-avatar');
  let offset = 8, first = true, idat = false, ended = false, channels;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error('invalid-avatar');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('invalid-avatar');
    if (first) {
      if (type !== 'IHDR' || length !== 13 || bytes.readUInt32BE(offset + 8) !== 256 || bytes.readUInt32BE(offset + 12) !== 256
        || bytes[offset + 16] !== 8 || ![2, 6].includes(bytes[offset + 17])
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new Error('invalid-avatar');
      first = false;
      channels = bytes[offset + 17] === 6 ? 4 : 3;
    } else if (type === 'IDAT' && length > 0) { idat = true; compressed.push(bytes.subarray(offset + 8, end - 4)); }
    else if (type === 'IEND' && length === 0) { ended = true; offset = end; break; }
    else if (!['sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type)) throw new Error('invalid-avatar');
    offset = end;
  }
  if (first || !idat || !ended || offset !== bytes.length) throw new Error('invalid-avatar');
  try {
    const stride = 1 + 256 * channels, size = stride * 256;
    const raster = inflateSync(Buffer.concat(compressed), { maxOutputLength: size });
    if (raster.length !== size) throw new Error('raster-size');
    for (let row = 0; row < 256; row++) if (raster[row * stride] > 4) throw new Error('filter');
  } catch { throw new Error('invalid-avatar'); }
  return value;
}

export function restoreAvatar(value) {
  try { return normalizeAvatar(value); } catch { return null; }
}
export const avatarVersion = (avatar) => createHash('sha256').update(avatar).digest('hex').slice(0, 16);
export function avatarUrl(preset) {
  if (!preset.avatar) return undefined;
  const version = avatarVersion(preset.avatar);
  // The artwork is the original full figure. Carry its display framing with
  // the asset itself, so an inherited picture keeps it and an uploaded one does not.
  return '/persona-shell/avatar/' + encodeURIComponent(preset.id) + '?v=' + version +
    (preset.avatar === 'builtin:gemini' ? '&frame=cat-portrait' : '');
}
export function avatarContent(avatar) {
  if (!avatar) return undefined;
  if (avatar.startsWith('builtin:') && keys.has(avatar.slice(8))) {
    return { file: new URL('../assets/avatars/' + avatar.slice(8) + '.webp', import.meta.url), type: 'image/webp' };
  }
  if (!avatar.startsWith('data:image/png;base64,')) return undefined;
  return { data: Buffer.from(avatar.slice('data:image/png;base64,'.length), 'base64'), type: 'image/png' };
}
