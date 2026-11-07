import { deflateSync } from 'node:zlib';
export function makeAvatar(red = 100, compressed) {
  const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) { c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const type = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  const raster = Buffer.alloc((1 + 256 * 4) * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const offset = y * 1025 + 1 + x * 4; raster[offset] = red; raster[offset + 1] = 120; raster[offset + 2] = 180; raster[offset + 3] = 255;
  }
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', compressed ?? deflateSync(raster)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
