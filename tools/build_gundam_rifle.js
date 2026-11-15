// Split the flight Gundam's beam rifle and right fist off the right arm, as a "rifle" node (child of armR) pivoted at the
// fist, so the game can turn the rifle at the wrist (the model has no elbow): in flight it keeps the barrel level while
// the arm is raised. armR node units: +y up, +z forward, +x = the Gundam's left; the arm hangs down with the rifle along it
// (muzzle at y -36.8). The rifle, its scope and stock and the fist are separate mesh islands below the forearm, so each
// island is assigned whole by its bounding box. Vertices are stored relative to the pivot, so with an identity rotation
// the rifle shows exactly as before. Running it again on a split model does nothing.
// usage: node tools/build_gundam_rifle.js models/gundam_rx78_18m.glb [more.glb ...]
const fs = require("fs");
const GRIP = [-0.4, -14.0, 0.2];   // centre of the right fist around the rifle grip (armR units)
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }, CS = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 };

function split(file) {
  const g = fs.readFileSync(file); const jl = g.readUInt32LE(12); const j = JSON.parse(g.toString("utf8", 20, 20 + jl));
  if (j.nodes.some((n) => n.name === "rifle")) { console.log(file + ": already split"); return; }
  let bin = Buffer.from(g.slice(28 + jl, 28 + jl + g.readUInt32LE(20 + jl)));
  const read = (ai) => { const a = j.accessors[ai], bv = j.bufferViews[a.bufferView], n = NC[a.type], cs = CS[a.componentType], b = (bv.byteOffset || 0) + (a.byteOffset || 0), st = bv.byteStride || n * cs;
    const o = []; for (let i = 0; i < a.count; i++) { const v = []; for (let k = 0; k < n; k++) { const off = b + i * st + k * cs; v.push(a.componentType === 5126 ? bin.readFloatLE(off) : cs === 4 ? bin.readUInt32LE(off) : cs === 2 ? bin.readUInt16LE(off) : bin.readUInt8(off)); } o.push(v); } return o; };
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const addAccessor = (rows, type, componentType, target, minmax) => {
    const n = NC[type], cs = CS[componentType]; const b = Buffer.alloc(rows.length * n * cs);
    rows.forEach((r, i) => (n === 1 ? [r] : r).forEach((x, k) => { const off = (i * n + k) * cs; if (componentType === 5126) b.writeFloatLE(x, off); else if (cs === 4) b.writeUInt32LE(x, off); else b.writeUInt16LE(x, off); }));
    bin = pad4(bin); const bv = { buffer: 0, byteOffset: bin.length, byteLength: b.length }; if (target) bv.target = target; j.bufferViews.push(bv); bin = Buffer.concat([bin, b]);
    const acc = { bufferView: j.bufferViews.length - 1, componentType, count: rows.length, type };
    if (minmax) { acc.min = [0, 1, 2].map((k) => Math.min(...rows.map((r) => r[k]))); acc.max = [0, 1, 2].map((k) => Math.max(...rows.map((r) => r[k]))); }
    j.accessors.push(acc); return j.accessors.length - 1;
  };
  // rifle, scope, stock and fist: narrow islands entirely below the forearm (the forearm armour is wider and ends at y -12.6)
  const isRifle = (c) => c.mx[1] <= -10.0 && c.mn[0] >= -1.9 && c.mx[0] <= 0.9;
  const armIdx = j.nodes.findIndex((n) => n.name === "armR"); if (armIdx < 0) throw new Error(file + ": no armR node");
  const mesh = j.meshes[j.nodes[armIdx].mesh]; const prims = []; let nRifle = 0, nArm = 0;
  for (const p of mesh.primitives) {
    const P = read(p.attributes.POSITION), I = read(p.indices).map((x) => x[0]);
    const par = P.map((_, i) => i); const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }; const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    for (let t = 0; t < I.length; t += 3) { u(I[t], I[t + 1]); u(I[t], I[t + 2]); }
    const key = new Map(); P.forEach((v, i) => { const k = v.map((x) => x.toFixed(4)).join(","); if (key.has(k)) u(i, key.get(k)); else key.set(k, i); });
    const box = new Map(); for (let t = 0; t < I.length; t += 3) { const r = f(I[t]); const c = box.get(r) || { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; for (const vi of [I[t], I[t + 1], I[t + 2]]) for (let k = 0; k < 3; k++) { c.mn[k] = Math.min(c.mn[k], P[vi][k]); c.mx[k] = Math.max(c.mx[k], P[vi][k]); } box.set(r, c); }
    const rifleIdx = [], armIdxs = [];
    for (let t = 0; t < I.length; t += 3) (isRifle(box.get(f(I[t]))) ? rifleIdx : armIdxs).push(I[t], I[t + 1], I[t + 2]);
    nRifle += rifleIdx.length / 3; nArm += armIdxs.length / 3;
    if (!rifleIdx.length) continue;
    const used = [...new Set(rifleIdx)]; const remap = new Map(used.map((v, k) => [v, k])); const attrs = {};
    for (const [name, ai] of Object.entries(p.attributes)) {
      const a = j.accessors[ai]; let rows = read(ai); rows = used.map((v) => rows[v]);
      if (name === "POSITION") rows = rows.map((r) => [r[0] - GRIP[0], r[1] - GRIP[1], r[2] - GRIP[2]]);
      attrs[name] = addAccessor(rows.map((r) => (r.length === 1 ? r[0] : r)), a.type, a.componentType, 34962, name === "POSITION");
    }
    const prim = { attributes: attrs, indices: addAccessor(rifleIdx.map((v) => remap.get(v)), "SCALAR", used.length > 65535 ? 5125 : 5123, 34963) };
    if (p.material !== undefined) prim.material = p.material; if (p.mode !== undefined) prim.mode = p.mode;
    prims.push(prim);
    p.indices = addAccessor(armIdxs, "SCALAR", P.length > 65535 ? 5125 : 5123, 34963);
  }
  if (!prims.length || nRifle < 100) throw new Error(file + ": rifle not found (" + nRifle + " triangles)");
  j.meshes.push({ name: "rifle", primitives: prims }); j.nodes.push({ name: "rifle", translation: GRIP, mesh: j.meshes.length - 1 });
  j.nodes[armIdx].children = (j.nodes[armIdx].children || []).concat([j.nodes.length - 1]);
  // drop accessors/bufferViews no longer referenced (the old index buffers)
  const usedA = new Set(); for (const m of j.meshes) for (const p of m.primitives) { Object.values(p.attributes).forEach((x) => usedA.add(x)); if (p.indices !== undefined) usedA.add(p.indices); }
  const map = new Map(); const acc = []; j.accessors.forEach((a, i) => { if (usedA.has(i)) { map.set(i, acc.length); acc.push(a); } });
  for (const m of j.meshes) for (const p of m.primitives) { for (const k in p.attributes) p.attributes[k] = map.get(p.attributes[k]); if (p.indices !== undefined) p.indices = map.get(p.indices); }
  j.accessors = acc;
  const usedBV = new Set(acc.map((a) => a.bufferView)); (j.images || []).forEach((im) => im.bufferView !== undefined && usedBV.add(im.bufferView));
  const bvMap = new Map(); const nb = []; const parts = []; let off = 0;
  j.bufferViews.forEach((bv, i) => { if (!usedBV.has(i)) return; const d = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength); const st = (off + 3) & ~3; if (st > off) parts.push(Buffer.alloc(st - off)); parts.push(d); bvMap.set(i, nb.length); nb.push(Object.assign({}, bv, { byteOffset: st })); off = st + d.length; });
  bin = pad4(Buffer.concat(parts)); for (const a of j.accessors) a.bufferView = bvMap.get(a.bufferView); for (const im of j.images || []) if (im.bufferView !== undefined) im.bufferView = bvMap.get(im.bufferView); j.bufferViews = nb;
  j.buffers[0].byteLength = bin.length;
  let jb = Buffer.from(JSON.stringify(j), "utf8"); if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)]);
  const total = 28 + jb.length + bin.length;
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(total, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(jb.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([h, c1, jb, c2, bin]));
  console.log(file + ": rifle " + nRifle + " triangles, arm " + nArm + ", bytes " + total);
}
for (const f of process.argv.slice(2)) split(f);
