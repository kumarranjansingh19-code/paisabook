import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const bg = [15, 118, 110], white = [255, 255, 255], mint = [153, 246, 228], gold = [251, 191, 36];
  const r = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bar = (x, y, bx, by, bw, bh) => x >= bx && x < bx + bw && y >= by && y < by + bh;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let px = [0, 0, 0, 0];
      if (inRounded(x + 0.5, y + 0.5)) {
        const u = x / size, v = y / size;
        px = [...bg, 255];
        if (bar(u, v, 0.234, 0.293, 0.531, 0.07)) px = [...white, 255];
        else if (bar(u, v, 0.234, 0.465, 0.531, 0.07)) px = [...white, 255];
        else if (bar(u, v, 0.234, 0.637, 0.351, 0.07)) px = [...mint, 255];
        if ((u - 0.766) ** 2 + (v - 0.672) ** 2 <= 0.078 ** 2) px = [...gold, 255];
      }
      raw.set(px, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const s of [192, 512]) writeFileSync(new URL(`../public/icons/icon-${s}.png`, import.meta.url), png(s));
console.log('icons written');
