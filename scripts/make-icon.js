// Generates assets/icon.png (256x256) with no dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const px = Buffer.alloc(N * N * 4);

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

// rounded square (blurple) with a white speech bubble
const r = 56;
function inRoundRect(x, y, x0, y0, x1, y1, rad) {
  const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    let c = [0, 0, 0, 0];
    if (inRoundRect(x + 0.5, y + 0.5, 0, 0, N, N, r)) {
      c = [88, 101, 242, 255];
      const bubble = inRoundRect(x + 0.5, y + 0.5, 52, 60, 204, featureBottom(), 34);
      const tail = triangle(x + 0.5, y + 0.5, 78, 150, 78, 204, 124, 150);
      if (bubble || tail) c = [255, 255, 255, 255];
      const dot = [92, 128, 164].some(cx => (x + 0.5 - cx) ** 2 + (y + 0.5 - 108) ** 2 <= 100);
      if (bubble && dot) c = [88, 101, 242, 255];
    }
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  }
}
function featureBottom() { return 168; }
function triangle(px_, py, ax, ay, bx, by, cx, cy) {
  const d = (px_ - bx) * (ay - by) - (ax - bx) * (py - by);
  const d1 = (px_ - bx) * (ay - by) - (ax - bx) * (py - by);
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px_ - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px_ - ax);
  const u = (cx - bx) * (py - by) - (cy - by) * (px_ - bx);
  void d; void d1;
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out);
