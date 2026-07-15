/* Génère les icônes PWA (PNG) à partir du logo DC Manager (3 nœuds reliés), SANS dépendance externe :
   encodeur PNG minimal (zlib), rendu supersamplé ×2 pour un anti-aliasing correct.
   À relancer si le logo ou les tailles changent :  node scripts/gen-pwa-icons.mjs
   Sortie : src-client/pwa/icon-192.png · icon-512.png · icon-maskable-512.png (réémis tels quels par webpack). */
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-client", "pwa");

/* ---- couleurs (cohérentes avec le thème) ---- */
const BG = [10, 10, 10, 255];        // --bg  #0a0a0a
const FG = [255, 85, 0, 255];        // --accent #ff5500

/* ---- encodeur PNG (RGBA 8 bits) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }   // filtre 0 par ligne
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8 bits, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ---- dessin (rendu HD puis sous-échantillonnage 2×2 → AA) ---- */
const NODES = [[5, 6], [19, 6], [12, 18]];   // logo en repère 24×24 (cf. brand-logo SVG)
const EDGES = [[0, 1], [0, 2], [1, 2]];      // triangle de liaisons (réseau)
const R_NODE = 2.6, W_EDGE = 1.5;            // rayon nœud / épaisseur arête (unités viewBox)

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function renderIcon(size, contentFrac) {
  const SS = 2, R = size * SS;                 // supersampling ×2
  const content = R * contentFrac, off = (R - content) / 2, scale = content / 24;
  const X = (u) => off + u * scale, Y = (v) => off + v * scale;
  const nodes = NODES.map(([u, v]) => [X(u), Y(v)]);
  const rNode = R_NODE * scale, wEdge = (W_EDGE * scale) / 2;
  const hi = Buffer.alloc(R * R * 4);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    let on = false;
    for (const [a, b] of EDGES) { if (distToSegment(x + 0.5, y + 0.5, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]) <= wEdge) { on = true; break; } }
    if (!on) for (const [nx, ny] of nodes) { if (Math.hypot(x + 0.5 - nx, y + 0.5 - ny) <= rNode) { on = true; break; } }
    const c = on ? FG : BG, o = (y * R + x) * 4;
    hi[o] = c[0]; hi[o + 1] = c[1]; hi[o + 2] = c[2]; hi[o + 3] = c[3];
  }
  // sous-échantillonnage box 2×2 → image finale (size×size)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const o = ((y * SS + dy) * R + (x * SS + dx)) * 4; r += hi[o]; g += hi[o + 1]; b += hi[o + 2]; a += hi[o + 3]; }
    const n = SS * SS, o = (y * size + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
// icônes « any » : logo à ~72 % ; maskable : ~56 % (le logo reste dans la zone sûre centrale ⌀80 %).
writeFileSync(path.join(OUT_DIR, "icon-192.png"), renderIcon(192, 0.72));
writeFileSync(path.join(OUT_DIR, "icon-512.png"), renderIcon(512, 0.72));
writeFileSync(path.join(OUT_DIR, "icon-maskable-512.png"), renderIcon(512, 0.56));
console.log("Icônes PWA générées dans", OUT_DIR);
