#!/usr/bin/env node
/* Importe un document NetMap (.json export mode-fichier) dans un document SERVEUR via l'API REST.
   Crée le document, pousse le snapshot (meta + collections), puis importe les images de façade
   (inline `faceImages` data-URL OU compagnon .nmfb).

   Usage :
     node scripts/import-json.mjs <fichier.json> [compagnon.nmfb] [options]
   Options :
     --name "Titre"         nom du document (défaut : meta.docName ou nom de fichier)
     --url  http://host:3000 base du serveur (défaut : http://localhost:3000)
     --api-base /api        préfixe API (défaut : /api)
     --basic user:pass      auth HTTP Basic (mode dev BASIC_AUTH)
     --cookie "k=v; ..."    en-tête Cookie (session SSO)
*/
import { readFileSync } from "node:fs";
import path from "node:path";

/* ---- arguments ---- */
const argv = process.argv.slice(2);
const opt = { url: "http://localhost:3000", apiBase: "/api" };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--name") opt.name = argv[++i];
  else if (a === "--url") opt.url = argv[++i];
  else if (a === "--api-base") opt.apiBase = argv[++i];
  else if (a === "--basic") opt.basic = argv[++i];
  else if (a === "--cookie") opt.cookie = argv[++i];
  else if (a.startsWith("--")) { console.error("option inconnue:", a); process.exit(2); }
  else pos.push(a);
}
const jsonPath = pos.find((p) => /\.json$/i.test(p));
const nmfbPath = pos.find((p) => /\.nmfb$/i.test(p));
if (!jsonPath) { console.error("usage: node scripts/import-json.mjs <fichier.json> [compagnon.nmfb] [--name ..] [--url ..] [--basic user:pass] [--cookie ..]"); process.exit(2); }

const API = opt.url.replace(/\/+$/, "") + opt.apiBase;
function headers(json) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (opt.basic) h["Authorization"] = "Basic " + Buffer.from(opt.basic).toString("base64");
  if (opt.cookie) h["Cookie"] = opt.cookie;
  return h;
}
async function http(method, path, body, isForm) {
  const res = await fetch(API + path, { method, headers: isForm ? headers(false) : headers(!!body), body: isForm ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(method + " " + path + " → HTTP " + res.status + (t ? " " + t.slice(0, 200) : "")); }
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

/* ---- images : data-URL inline / compagnon .nmfb ---- */
function dataUrlToBuf(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl || "");
  if (!m) return null;
  const type = m[1] || "application/octet-stream";
  const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
  return { type, buf };
}
function parseNmfb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 9 || buf[0] !== 0x4E || buf[1] !== 0x4D || buf[2] !== 0x46 || buf[3] !== 0x42) throw new Error("compagnon .nmfb : signature NMFB invalide");
  const mlen = dv.getUint32(5, true);
  const manifest = JSON.parse(new TextDecoder().decode(buf.subarray(9, 9 + mlen)));
  let off = 9 + mlen; const out = [];
  for (const im of (manifest.images || [])) { const n = im.bytes || 0; out.push({ ...im, type: im.type || "application/octet-stream", buf: Buffer.from(buf.subarray(off, off + n)) }); off += n; }
  return out;
}
async function putImage(docId, im) {
  const fd = new FormData();
  fd.append("meta", JSON.stringify({ id: im.id, name: im.name || "", u_height: im.u_height || 1, face: im.face || "front", description: im.description || "", type: im.type || "" }));
  fd.append("blob", new Blob([im.buf], { type: im.type || "application/octet-stream" }), im.name || im.id);
  await http("PUT", "/documents/" + encodeURIComponent(docId) + "/images/" + encodeURIComponent(im.id), fd, true);
}

/* ---- import ---- */
const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
const name = opt.name || (raw.meta && raw.meta.docName) || path.basename(jsonPath).replace(/\.json$/i, "");

// images : compagnon .nmfb prioritaire, sinon inline faceImages
let images = [];
if (nmfbPath) images = parseNmfb(readFileSync(nmfbPath));
else if (Array.isArray(raw.faceImages)) images = raw.faceImages.map((fi) => { const d = dataUrlToBuf(fi.data); return d ? { ...fi, type: d.type, buf: d.buf } : null; }).filter(Boolean);

// snapshot SANS les images inline (elles partent par les endpoints /images)
const snapshot = { ...raw }; delete snapshot.faceImages;
const nbEntities = Object.keys(snapshot).filter((k) => Array.isArray(snapshot[k])).reduce((n, k) => n + snapshot[k].length, 0);

console.log(`Import « ${name} » → ${API}  (${nbEntities} entités, ${images.length} image(s))`);
const doc = await http("POST", "/documents", { name });
console.log("  document créé:", doc.id);
await http("PUT", "/documents/" + encodeURIComponent(doc.id) + "/snapshot", snapshot);
console.log("  snapshot poussé");
let n = 0;
for (const im of images) { try { await putImage(doc.id, im); n++; } catch (e) { console.warn("  image", im.id, "échouée:", e.message); } }
console.log(`  ${n}/${images.length} image(s) importée(s)`);
console.log("OK ✓  document", doc.id, "«" + name + "»");
