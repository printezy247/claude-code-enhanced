#!/usr/bin/env node
// Generates build/icon.png (512x512) without any image dependency:
// rounded dark tile with a "❯" chevron and a block cursor.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

// --- CRC32 for PNG chunks -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// --- geometry helpers ------------------------------------------------------
function sdRoundBox(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

const R = 96; // tile corner radius
function render() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5, py = y + 0.5;
      // tile with vertical gradient, 1.5px AA
      const dTile = sdRoundBox(px, py, SIZE / 2, SIZE / 2, SIZE / 2 - 2, SIZE / 2 - 2, R);
      let r = 0, g = 0, b = 0, a = 0;
      const tileA = Math.max(0, Math.min(1, 0.5 - dTile / 1.5));
      if (tileA > 0) {
        const t = py / SIZE;
        // #161721 (top) -> #2b2150 (bottom)
        r = 0x16 + (0x2b - 0x16) * t;
        g = 0x17 + (0x21 - 0x17) * t;
        b = 0x21 + (0x50 - 0x21) * t;
        // "❯" chevron: two thick rounded segments
        const dChev = Math.min(
          sdSegment(px, py, 158, 178, 246, 256),
          sdSegment(px, py, 246, 256, 158, 334)
        );
        const chevA = Math.max(0, Math.min(1, 0.5 - (dChev - 20) / 1.5));
        // block cursor (claude-ish terracotta)
        const dCur = sdRoundBox(px, py, 322, 334, 44, 20, 8);
        const curA = Math.max(0, Math.min(1, 0.5 - dCur / 1.5));
        // subtle top rim light
        const rim = Math.max(0, Math.min(1, 0.5 - (sdRoundBox(px, py, SIZE / 2, SIZE / 2, SIZE / 2 - 2, SIZE / 2 - 2, R) + 1) / 1.5)) *
          Math.max(0, 1 - py / 90) * 0.10;
        if (chevA > 0) { r = r * (1 - chevA) + 0xed * chevA; g = g * (1 - chevA) + 0xee * chevA; b = b * (1 - chevA) + 0xf2 * chevA; }
        if (curA > 0) { r = r * (1 - curA) + 0xd9 * curA; g = g * (1 - curA) + 0x77 * curA; b = b * (1 - curA) + 0x57 * curA; }
        r = Math.min(255, r + 255 * rim); g = Math.min(255, g + 255 * rim); b = Math.min(255, b + 255 * rim);
        a = tileA * 255;
      }
      const o = rowStart + 1 + x * 4;
      raw[o] = Math.round(r); raw[o + 1] = Math.round(g); raw[o + 2] = Math.round(b); raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, render());
console.log('wrote', out);
