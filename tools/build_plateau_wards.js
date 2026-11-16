#!/usr/bin/env node
/* Builds the game's local Tokyo map from PLATEAU's original 3D Tiles (2025 LOD2 buildings with textures).
 *
 *   cd tools && npm install && cd ..
 *   node --use-system-ca tools/build_plateau_wards.js [--target-mb 950] [--tex 512] [--wards shinjuku,chuo] [--cache DIR]
 *
 * For each ward it:
 *   1. asks the PLATEAU VIEW data catalog where the ward's tiles are and downloads the whole ward (tileset.json and every
 *      .b3dm) into a cache folder (default: ../plateau-cache next to the repo, reused on later runs);
 *   2. re-encodes the geometry (Draco with shared, quantized vertices: about 9 times smaller, see reencodeDraco), shrinks
 *      every texture so its longer side is at most --tex px (WebP stays WebP), and drops the building attribute tables (the
 *      game only needs the feature ids). The tile tree, levels of detail, file names and feature ids stay the same as
 *      PLATEAU's, so High graphics can stream the originals with the same tileset.json;
 *   3. builds one ground-height grid for the whole map (cities/tokyo/ground/tokyo.bin, 20 m cells) from each building's
 *      base height, filled in between (streets, parks, rivers, the bay) from the nearest buildings.
 * Without --tex it picks the texture size: it processes a sample of tiles at 1024, 768, 512, 384 and 256 px, estimates the
 * whole map at each, and takes the largest size whose total (map + the rest of the game) stays under --target-mb.
 * The result replaces cities/tokyo/<ward>/, cities/tokyo/ground/ and cities/tokyo/ground.json (old play-area folders are removed).
 */
"use strict";
const fs = require("fs"), path = require("path");

const WARDS = { shinjuku: 13104, shibuya: 13113, minato: 13103, chiyoda: 13101, sumida: 13107, koto: 13108, chuo: 13102, taito: 13106 };
const TEX_CANDIDATES = [1024, 768, 512, 384, 256];
const GEOID_OFFSET = 36.71;          // Tokyo: ellipsoid height of mean sea level (m), as in ground.json
const CELL_M = 20;

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "cities", "tokyo");
const CACHE = path.resolve(arg("cache", path.join(ROOT, "..", "plateau-cache")));
const TARGET_MB = +arg("target-mb", 950);
const FIXED_TEX = arg("tex") ? +arg("tex") : null;
const ONLY = arg("wards") ? arg("wards").split(",") : Object.keys(WARDS);

let sharp, draco, dracoEnc;
try { sharp = require("sharp"); } catch (e) { console.error("Run `npm install` in tools/ first (needs sharp and draco3dgltf)."); process.exit(1); }

// ---------------------------------------------------------------- download -------------------------------------------------
async function fetchRetry(url, as) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error(r.status + " " + url); return as === "json" ? await r.json() : Buffer.from(await r.arrayBuffer()); }
    catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); }
  }
}
async function pool(items, n, fn) {
  let i = 0, done = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); done++;
    if (done % 200 === 0) process.stdout.write(`  ${done}/${items.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`); } }));
}
function contentUris(tile, out = []) { if (tile.content && tile.content.uri) out.push(tile.content.uri); (tile.children || []).forEach((c) => contentUris(c, out)); return out; }
// most detailed tiles, each with its accumulated tile transform (column-major 4x4, 3D Tiles 1.1 may use them)
function leafTiles(tile, parentT = null, out = []) {
  const T = tile.transform ? (parentT ? mul(parentT, tile.transform) : tile.transform) : parentT;
  if (!(tile.children || []).length) { if (tile.content && tile.content.uri) out.push({ uri: tile.content.uri, T }); }
  else tile.children.forEach((c) => leafTiles(c, T, out));
  return out;
}

async function downloadWard(name) {
  const dir = path.join(CACHE, name);
  fs.mkdirSync(dir, { recursive: true });
  const tsPath = path.join(dir, "tileset.json");
  let ts;
  if (fs.existsSync(tsPath)) ts = JSON.parse(fs.readFileSync(tsPath, "utf8"));
  else {
    const cat = await fetchRetry(`https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${WARDS[name]}-bldg-lod2-texture-2025/tileset.json`, "json");
    const src = cat.root && cat.root.children && cat.root.children[0] && cat.root.children[0].content && cat.root.children[0].content.uri;
    if (!/^https:\/\/.*tileset\.json$/.test(src || "")) throw new Error("catalog: no tileset for " + name);
    ts = await fetchRetry(src, "json");
    ts.__base = src.replace(/tileset\.json$/, "");
    fs.writeFileSync(tsPath, JSON.stringify(ts));
  }
  const uris = contentUris(ts.root);
  if (uris.some((u) => /\.json$/.test(u))) throw new Error(name + ": nested tilesets are not supported");
  let have = 0;
  await pool(uris, 16, async (u) => {
    const f = path.join(dir, u); if (fs.existsSync(f)) { have++; return; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const b = await fetchRetry(ts.__base + u); fs.writeFileSync(f + ".part", b); fs.renameSync(f + ".part", f);
  });
  const bytes = uris.reduce((s, u) => s + fs.statSync(path.join(dir, u)).size, 0);
  console.log(`${name}: ${uris.length} tiles, ${(bytes / 1e6).toFixed(1)} MB original (${have} already cached)`);
  return { name, dir, ts, uris, bytes };
}

// ---------------------------------------------------------------- b3dm ------------------------------------------------------
// Some wards (Taito, 2025) come as 3D Tiles 1.1: plain .glb tiles whose building ids are EXT_mesh_features feature ids
// (_FEATURE_ID_n attributes, with the attributes in an EXT_structural_metadata property table). They are converted to the
// same b3dm form as the other wards (ids as _BATCHID, BATCH_LENGTH in the feature table, no attribute table), so the game
// treats every ward alike. The file keeps its .glb name: Cesium tells the formats apart by their first bytes.
function glbAsB3dm(buf) {
  const jsonLen = buf.readUInt32LE(12), json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const binLen = buf.length > 20 + jsonLen + 8 ? buf.readUInt32LE(20 + jsonLen) : 0, bin = buf.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);
  let count = 0;
  for (const m of json.meshes || []) for (const pr of m.primitives) {
    const fx = pr.extensions && pr.extensions.EXT_mesh_features; if (!fx) continue;
    const fid = (fx.featureIds || [])[0];
    if (!fid || fid.attribute === undefined) throw new Error("EXT_mesh_features without a feature id attribute is not supported");
    const name = "_FEATURE_ID_" + fid.attribute;
    pr.attributes._BATCHID = pr.attributes[name]; delete pr.attributes[name];
    const dr = pr.extensions.KHR_draco_mesh_compression;
    if (dr && dr.attributes[name] !== undefined) { dr.attributes._BATCHID = dr.attributes[name]; delete dr.attributes[name]; }
    count = Math.max(count, fid.featureCount || 0);
    delete pr.extensions.EXT_mesh_features;
  }
  if (json.extensions) delete json.extensions.EXT_structural_metadata;
  for (const k of ["extensionsUsed", "extensionsRequired"]) if (json[k]) { json[k] = json[k].filter((x) => x !== "EXT_mesh_features" && x !== "EXT_structural_metadata"); if (!json[k].length) delete json[k]; }
  const ftJson = { BATCH_LENGTH: count }, ftBytes = Buffer.from(JSON.stringify(ftJson));
  return { featureTable: ftBytes, ftj: ftBytes.length, ftb: 0, ftJson, json, bin, fromGlb: true };
}
function parseB3dm(buf) {
  const magic = buf.toString("ascii", 0, 4);
  if (magic === "glTF") return glbAsB3dm(buf);
  if (magic !== "b3dm") throw new Error("not b3dm or glb");
  const ftj = buf.readUInt32LE(12), ftb = buf.readUInt32LE(16), btj = buf.readUInt32LE(20), btb = buf.readUInt32LE(24);
  const featureTable = buf.subarray(28, 28 + ftj + ftb), ftJson = JSON.parse(buf.toString("utf8", 28, 28 + ftj).trim() || "{}");
  const g = 28 + ftj + ftb + btj + btb;
  if (buf.toString("ascii", g, g + 4) !== "glTF") throw new Error("b3dm without GLB");
  const jsonLen = buf.readUInt32LE(g + 12);
  const json = JSON.parse(buf.toString("utf8", g + 20, g + 20 + jsonLen));
  const binStart = g + 20 + jsonLen + 8, binLen = buf.readUInt32LE(g + 20 + jsonLen);
  return { featureTable, ftj, ftb, ftJson, json, bin: buf.subarray(binStart, binStart + binLen) };
}
const pad = (n, a = 4) => (a - (n % a)) % a;
function writeB3dm(t, json, parts) {
  const views = json.bufferViews || [];
  let off = 0;
  views.forEach((bv, i) => { off += pad(off); bv.byteOffset = off; bv.byteLength = parts[i].length; off += parts[i].length; });
  if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = off;
  const binLen = off + pad(off);
  const js = Buffer.from(JSON.stringify(json)), jsPad = pad(js.length);
  const glbLen = 12 + 8 + js.length + jsPad + 8 + binLen;
  // feature table kept (BATCH_LENGTH, RTC_CENTER); batch table (building attributes) dropped
  if (t.fromGlb) { const n = Math.max(t.ftJson.BATCH_LENGTH, (json.__maxBatchId ?? -1) + 1); const b = Buffer.from(JSON.stringify({ BATCH_LENGTH: n })); t.featureTable = b; t.ftj = b.length; t.ftb = 0; }
  delete json.__maxBatchId;
  const ft = t.featureTable;
  const ftJson = Buffer.concat([ft.subarray(0, t.ftj), Buffer.alloc(pad(28 + t.ftj, 8), 0x20)]);
  const ftBin = Buffer.concat([ft.subarray(t.ftj), Buffer.alloc(pad(t.ftb, 8), 0)]);
  const head = 28 + ftJson.length + ftBin.length, out = Buffer.alloc(head + glbLen);
  out.write("b3dm", 0, "ascii"); out.writeUInt32LE(1, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(ftJson.length, 12); out.writeUInt32LE(ftBin.length, 16); out.writeUInt32LE(0, 20); out.writeUInt32LE(0, 24);
  ftJson.copy(out, 28); ftBin.copy(out, 28 + ftJson.length);
  let g = head;
  out.write("glTF", g, "ascii"); out.writeUInt32LE(2, g + 4); out.writeUInt32LE(glbLen, g + 8);
  out.writeUInt32LE(js.length + jsPad, g + 12); out.write("JSON", g + 16, "ascii"); js.copy(out, g + 20); out.fill(0x20, g + 20 + js.length, g + 20 + js.length + jsPad);
  g += 20 + js.length + jsPad;
  out.writeUInt32LE(binLen, g); out.write("BIN\0", g + 4, "ascii");
  views.forEach((bv, i) => parts[i].copy(out, g + 8 + bv.byteOffset));
  return out;
}
// PLATEAU's tiles store each triangle with its own three unquantized vertices (Draco "triangle soup", 32-bit floats). Re-encoding
// shares the vertices and quantizes them (positions 14 bits: about 1 cm on a 200 m tile, normals 10, texture coordinates 12),
// which makes the geometry about 9 times smaller with no visible change. Feature ids (_BATCHID) stay exact.
const stats = { dracoKept: 0 };
const ENC_BITS = { POSITION: 14, NORMAL: 10, TEXCOORD_0: 12 };
function reencodeDraco(json, bytes, pr, ext) {
  const d = new draco.Decoder(), db = new draco.DecoderBuffer(); db.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
  const mesh = new draco.Mesh(), st = d.DecodeBufferToMesh(db, mesh);
  if (!st.ok()) throw new Error("draco: " + st.error_msg());
  const nf = mesh.num_faces(), np = mesh.num_points(), faces = new Uint32Array(nf * 3), ia = new draco.DracoInt32Array();
  for (let i = 0; i < nf; i++) { d.GetFaceFromMesh(mesh, i, ia); faces[i * 3] = ia.GetValue(0); faces[i * 3 + 1] = ia.GetValue(1); faces[i * 3 + 2] = ia.GetValue(2); }
  draco.destroy(ia);
  const E = dracoEnc, mb = new E.MeshBuilder(), em = new E.Mesh(); mb.AddFacesToMesh(em, nf, faces);
  const ids = {}, enc = new E.Encoder();
  for (const [k, id] of Object.entries(ext.attributes)) {
    const at = d.GetAttributeByUniqueId(mesh, id), nc = at.num_components(), arr = new draco.DracoFloat32Array();
    d.GetAttributeFloatForAllPoints(mesh, at, arr); const n = arr.size(), v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = arr.GetValue(i); draco.destroy(arr);
    const type = k === "POSITION" ? E.POSITION : k === "NORMAL" ? E.NORMAL : /^TEXCOORD/.test(k) ? E.TEX_COORD : /^COLOR/.test(k) ? E.COLOR : E.GENERIC;
    const ct = json.accessors[pr.attributes[k]].componentType;
    if (ct === 5126) { ids[k] = mb.AddFloatAttributeToMesh(em, type, np, nc, v); if (ENC_BITS[k]) enc.SetAttributeQuantization(type, ENC_BITS[k]); }
    else { const T = { 5121: [Uint8Array, "AddUInt8Attribute"], 5123: [Uint16Array, "AddUInt16Attribute"], 5125: [Uint32Array, "AddUInt32Attribute"] }[ct];
      if (!T) throw new Error("unsupported attribute type " + ct + " for " + k);
      ids[k] = mb[T[1]](em, type, np, nc, T[0].from(v, (x) => Math.round(x))); }
    if (k === "_BATCHID") { let mx = json.__maxBatchId ?? -1; for (let i = 0; i < v.length; i++) if (v[i] > mx) mx = v[i]; json.__maxBatchId = mx; }
  }
  draco.destroy(mesh); draco.destroy(db); draco.destroy(d);
  enc.SetSpeedOptions(5, 5);
  let out = new E.DracoInt8Array(), len = enc.EncodeMeshToDracoBuffer(em, out);
  if (!len) { E.destroy(out); out = new E.DracoInt8Array(); enc.SetEncodingMethod(E.MESH_SEQUENTIAL_ENCODING); len = enc.EncodeMeshToDracoBuffer(em, out); }   // edgebreaker can refuse odd meshes
  if (!len) { E.destroy(out); E.destroy(enc); E.destroy(em); E.destroy(mb); stats.dracoKept++; return bytes; }   // keep the original encoding
  const res = Buffer.alloc(len); for (let i = 0; i < len; i++) res[i] = out.GetValue(i) & 0xff;
  E.destroy(out); E.destroy(enc); E.destroy(em); E.destroy(mb);
  // the encoder shares vertices, so the vertex count changes: read it back and fix the accessors
  const d2 = new draco.Decoder(), db2 = new draco.DecoderBuffer(); db2.Init(new Int8Array(res.buffer, res.byteOffset, res.byteLength), res.byteLength);
  const m2 = new draco.Mesh(); if (!d2.DecodeBufferToMesh(db2, m2).ok()) throw new Error("draco re-decode failed");
  const np2 = m2.num_points(), nf2 = m2.num_faces(); draco.destroy(m2); draco.destroy(db2); draco.destroy(d2);
  if (nf2 !== nf) throw new Error("draco: face count changed");
  for (const k of Object.keys(ext.attributes)) json.accessors[pr.attributes[k]].count = np2;
  if (pr.indices !== undefined) { const a = json.accessors[pr.indices]; a.count = nf * 3; if (np2 > 65535) a.componentType = 5125; }
  ext.attributes = ids;
  return res;
}
async function shrinkTile(buf, maxPx) {
  const t = parseB3dm(buf), json = t.json, views = json.bufferViews || [];
  const imgViews = new Map();
  for (const im of json.images || []) if (im.bufferView !== undefined) imgViews.set(im.bufferView, im);
  const dracoViews = new Map();
  for (const m of json.meshes || []) for (const pr of m.primitives) { const ext = pr.extensions && pr.extensions.KHR_draco_mesh_compression; if (ext) dracoViews.set(ext.bufferView, [pr, ext]); }
  const parts = await Promise.all(views.map(async (bv, i) => {
    const src = Buffer.from(t.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
    if (dracoViews.has(i)) { const [pr, ext] = dracoViews.get(i); return reencodeDraco(json, src, pr, ext); }
    const im = imgViews.get(i); if (!im) return src;
    const img = sharp(src), meta = await img.metadata();
    const s = Math.min(1, maxPx / Math.max(meta.width, meta.height));
    if (s >= 1 && im.mimeType === "image/webp") return src;
    const r = img.resize(Math.max(1, Math.round(meta.width * s)), Math.max(1, Math.round(meta.height * s)), { kernel: "lanczos3" });
    return im.mimeType === "image/png" ? r.png({ compressionLevel: 9 }).toBuffer() : im.mimeType === "image/jpeg" ? r.jpeg({ quality: 80 }).toBuffer() : r.webp({ quality: 80 }).toBuffer();
  }));
  return writeB3dm(t, json, parts);
}

// ---------------------------------------------------------------- ground ----------------------------------------------------
function ecefToGeo(x, y, z) {   // WGS84, radians / metres
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), b = a * (1 - f), ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(x, y), th = Math.atan2(z * a, p * b);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [Math.atan2(y, x), lat, p / Math.cos(lat) - N];
}
function nodeMatrix(n) {   // column-major 4x4
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation || [0, 0, 0], [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1];
  return [(1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0, tx, ty, tz, 1];
}
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function decodeDraco(bytes, ext) {
  const d = new draco.Decoder(), db = new draco.DecoderBuffer(); db.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
  const mesh = new draco.Mesh(), st = d.DecodeBufferToMesh(db, mesh);
  if (!st.ok()) { draco.destroy(mesh); draco.destroy(db); draco.destroy(d); throw new Error("draco: " + st.error_msg()); }
  const get = (id) => { if (id === undefined) return null; const at = d.GetAttributeByUniqueId(mesh, id), arr = new draco.DracoFloat32Array();
    d.GetAttributeFloatForAllPoints(mesh, at, arr); const n = arr.size(), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = arr.GetValue(i); draco.destroy(arr); return out; };
  const pos = get(ext.attributes.POSITION), bid = get(ext.attributes._BATCHID);
  draco.destroy(mesh); draco.destroy(db); draco.destroy(d);
  return { pos, bid };
}
function accessorFloats(json, bin, idx) {   // plain (non-Draco) accessor
  const a = json.accessors[idx], bv = json.bufferViews[a.bufferView], comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
  const stride = (bv.byteStride || comps * T.BYTES_PER_ELEMENT) / T.BYTES_PER_ELEMENT, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const view = new T(bin.buffer.slice(bin.byteOffset + base, bin.byteOffset + base + (a.count - 1) * stride * T.BYTES_PER_ELEMENT + comps * T.BYTES_PER_ELEMENT));
  const out = new Float32Array(a.count * comps); for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = view[i * stride + c]; return out;
}
// building base points of one tile: [{lon, lat, h}] (radians, ellipsoid metres), one per footprint vertex
function tileBasePoints(buf, T) {
  const t = parseB3dm(buf), json = t.json;
  const rtc = (json.extensions && json.extensions.CESIUM_RTC && json.extensions.CESIUM_RTC.center) || t.ftJson.RTC_CENTER || [0, 0, 0];
  const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  const out = [];
  const visit = (ni, parent) => {
    const n = json.nodes[ni], M = mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) for (const pr of json.meshes[n.mesh].primitives) {
      const ext = pr.extensions && pr.extensions.KHR_draco_mesh_compression;
      let pos, bid;
      if (ext) { const bv = json.bufferViews[ext.bufferView]; ({ pos, bid } = decodeDraco(t.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), ext)); }
      else { pos = accessorFloats(json, t.bin, pr.attributes.POSITION); bid = pr.attributes._BATCHID !== undefined ? accessorFloats(json, t.bin, pr.attributes._BATCHID) : null; }
      const W = mul(Y_UP_TO_Z_UP, M), nv = pos.length / 3, geo = new Array(nv), minH = new Map();
      for (let i = 0; i < nv; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        let X = W[0] * x + W[4] * y + W[8] * z + W[12] + rtc[0], Y = W[1] * x + W[5] * y + W[9] * z + W[13] + rtc[1], Z = W[2] * x + W[6] * y + W[10] * z + W[14] + rtc[2];
        if (T) { const x2 = T[0] * X + T[4] * Y + T[8] * Z + T[12], y2 = T[1] * X + T[5] * Y + T[9] * Z + T[13]; Z = T[2] * X + T[6] * Y + T[10] * Z + T[14]; X = x2; Y = y2; }
        const g = ecefToGeo(X, Y, Z);
        geo[i] = g; const b = bid ? bid[i] : 0; if (!(minH.get(b) <= g[2])) minH.set(b, g[2]);
      }
      for (let i = 0; i < nv; i++) { const b = bid ? bid[i] : 0, m = minH.get(b); if (geo[i][2] < m + 0.5) out.push({ lon: geo[i][0], lat: geo[i][1], h: m }); }
    }
    (n.children || []).forEach((c) => visit(c, M));
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const ni of (json.scenes[json.scene || 0] || { nodes: [] }).nodes) visit(ni, I);
  return out;
}
// One ground grid for the whole map (all wards together, so there are no overlaps or gaps between wards), 20 m cells.
// Each cell with building footprints gets their lowest base height; every other cell (streets, parks, rivers, the bay) is
// filled outward from them, ring by ring, each new cell the mean of its known neighbours.
function buildGround(wards) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const wd of wards) { const r = wd.ts.root.boundingVolume.region; w = Math.min(w, r[0]); s = Math.min(s, r[1]); e = Math.max(e, r[2]); n = Math.max(n, r[3]); }
  const lat0 = (s + n) / 2, mLat = 6371000, mLon = 6371000 * Math.cos(lat0);
  const size = Math.ceil(Math.max((e - w) * mLon, (n - s) * mLat) / CELL_M) + 1;
  const low = new Float64Array(size * size).fill(Infinity);   // lowest building base in each cell
  for (const wd of wards) {
    const leaves = leafTiles(wd.ts.root);
    console.log(`  ground: ${wd.name}, ${leaves.length} most detailed tiles`);
    let skipped = 0;
    for (const { uri: u, T } of leaves) {
      let pts; try { pts = tileBasePoints(fs.readFileSync(path.join(wd.dir, u)), T); } catch (er) { if (++skipped <= 5) console.warn("  ground: skipped " + u + ": " + er.message); continue; }
      for (const p of pts) {
        const x = Math.round((p.lon - w) / (e - w) * (size - 1)), y = Math.round((p.lat - s) / (n - s) * (size - 1));
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const i = y * size + x; if (p.h < low[i]) low[i] = p.h;
      }
    }
  }
  // Some features start high above the street (a tower's upper part stored as its own feature, walkways, roof structures).
  // A cell more than 12 m above the median of the cells with buildings within 250 m is dropped and filled like a street.
  const val = new Float64Array(size * size).fill(NaN); let front = [], dropped = 0;
  const R = Math.round(250 / CELL_M), nb = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x; if (low[i] === Infinity) continue;
    nb.length = 0;
    for (let Y = Math.max(0, y - R); Y <= Math.min(size - 1, y + R); Y++) for (let X = Math.max(0, x - R); X <= Math.min(size - 1, x + R); X++) { const v = low[Y * size + X]; if (v !== Infinity) nb.push(v); }
    nb.sort((a, b) => a - b);
    if (low[i] > nb[nb.length >> 1] + 12) { dropped++; continue; }
    val[i] = low[i]; front.push(i);
  }
  console.log(`  ground: ${front.length} cells with buildings, ${dropped} raised cells dropped`);
  if (!front.length) throw new Error("ground: no building footprints found");
  const seen = new Uint8Array(size * size); for (const i of front) seen[i] = 1;
  while (front.length) {
    const next = [];
    for (const i of front) { const x = i % size, y = (i / size) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy, j = Y * size + X; if (X >= 0 && Y >= 0 && X < size && Y < size && !seen[j]) { seen[j] = 1; next.push(j); } } }
    const vals = new Float64Array(next.length);
    next.forEach((i, k) => { const x = i % size, y = (i / size) | 0; let t = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < size && Y < size && !isNaN(val[Y * size + X])) { t += val[Y * size + X]; c++; } }
      vals[k] = t / c; });
    next.forEach((i, k) => { val[i] = vals[k]; });
    front = next;
  }
  const data = new Int16Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(-32767, Math.min(32767, Math.round(val[i] * 10)));
  const deg = (r) => +(r * 180 / Math.PI).toFixed(6);
  return { area: { name: "tokyo", west: deg(w), south: deg(s), east: deg(e), north: deg(n), size, file: "ground/tokyo.bin" }, data };
}

// ---------------------------------------------------------------- main ------------------------------------------------------
function dirBytes(d, skip) { let t = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (skip(p)) continue; t += f.isDirectory() ? dirBytes(p, skip) : fs.statSync(p).size; } return t; }
function seeded(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

(async () => {
  draco = await require("draco3dgltf").createDecoderModule({});
  dracoEnc = await require("draco3dgltf").createEncoderModule({});
  fs.mkdirSync(CACHE, { recursive: true });
  console.log("Cache: " + CACHE);
  const wards = [];
  for (const name of ONLY) { if (!WARDS[name]) throw new Error("unknown ward " + name); wards.push(await downloadWard(name)); }

  // the rest of the game (everything published except the Tokyo map)
  const other = dirBytes(ROOT, (p) => /[\\/](\.git|node_modules)$/.test(p) || p === OUT);
  let tex = FIXED_TEX;
  if (!tex) {
    const rnd = seeded(7), est = Object.fromEntries(TEX_CANDIDATES.map((c) => [c, 0]));
    console.log("Estimating texture size from a sample of tiles…");
    for (const wd of wards) {
      const sample = wd.uris.filter(() => rnd() < 0.05); if (sample.length < 12) sample.push(...wd.uris.slice(0, 12 - sample.length));
      const inB = sample.reduce((s, u) => s + fs.statSync(path.join(wd.dir, u)).size, 0);
      for (const c of TEX_CANDIDATES) { let outB = 0; await pool(sample, 8, async (u) => { const t = await shrinkTile(fs.readFileSync(path.join(wd.dir, u)), c); outB += t.length; }); est[c] += wd.bytes * outB / inB; }
    }
    const groundEst = 3e6;
    for (const c of TEX_CANDIDATES) console.log(`  ${c} px: map ≈ ${(est[c] / 1e6).toFixed(0)} MB, site ≈ ${((est[c] + other + groundEst) / 1e6).toFixed(0)} MB`);
    tex = TEX_CANDIDATES.find((c) => (est[c] + other + groundEst) * 1.03 <= TARGET_MB * 1e6);
    if (!tex) throw new Error(`even ${TEX_CANDIDATES[TEX_CANDIDATES.length - 1]} px textures do not fit in ${TARGET_MB} MB`);
    console.log(`Using ${tex} px textures (target ${TARGET_MB} MB).`);
  }

  let total = 0;
  for (const wd of wards) {
    console.log(`${wd.name}: re-encoding ${wd.uris.length} tiles, textures ${tex} px…`);
    const dst = path.join(OUT, wd.name + ".new"); fs.rmSync(dst, { recursive: true, force: true });
    await pool(wd.uris, 8, async (u) => { const f = path.join(dst, u); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, await shrinkTile(fs.readFileSync(path.join(wd.dir, u)), tex)); });
    const ts = JSON.parse(JSON.stringify(wd.ts)); delete ts.__base; delete ts.properties;
    fs.writeFileSync(path.join(dst, "tileset.json"), JSON.stringify(ts));
    fs.rmSync(path.join(OUT, wd.name), { recursive: true, force: true }); fs.renameSync(dst, path.join(OUT, wd.name));
    const b = dirBytes(path.join(OUT, wd.name), () => false); total += b;
    console.log(`${wd.name}: ${(b / 1e6).toFixed(1)} MB (original ${(wd.bytes / 1e6).toFixed(1)} MB)`);
  }
  if (ONLY.length === Object.keys(WARDS).length) {   // full build: one ground grid for the whole map; remove areas no longer used
    console.log("Ground grid…");
    const g = buildGround(wards);
    fs.rmSync(path.join(OUT, "ground"), { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, "ground"));
    fs.writeFileSync(path.join(OUT, g.area.file), Buffer.from(g.data.buffer));
    fs.writeFileSync(path.join(OUT, "ground.json"), JSON.stringify({ geoidOffset: GEOID_OFFSET,
      note: "heights are ellipsoidal metres * 10 as Int16 LE, row-major from the south-west corner (tools/build_plateau_wards.js)", areas: [g.area] }, null, 1));
    console.log(`  ${g.area.size} x ${g.area.size} cells`);
    for (const d of fs.readdirSync(OUT)) if (fs.statSync(path.join(OUT, d)).isDirectory() && d !== "ground" && !WARDS[d]) { console.log("removing " + d); fs.rmSync(path.join(OUT, d), { recursive: true, force: true }); }
  } else console.log("Partial build: the ground grid was not rebuilt (run without --wards for that).");
  const site = dirBytes(ROOT, (p) => /[\\/](\.git|node_modules)$/.test(p));
  if (stats.dracoKept) console.log(`${stats.dracoKept} meshes kept their original geometry encoding (could not be re-encoded).`);
  console.log(`\nDone: Tokyo map ${(total / 1e6).toFixed(1)} MB with ${tex} px textures; whole published site ≈ ${(site / 1e6).toFixed(1)} MB.`);
})().catch((e) => { console.error(e); process.exit(1); });
