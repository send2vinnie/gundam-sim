// Give the flight Gundam's arms elbows (and the right one a wrist):
//   armR (shoulder) -> forearmR (elbow) -> rifle (fist: the beam rifle with the right fist around its grip)
//   armL (shoulder) -> forearmL (elbow: the left forearm, fist and the whole shield)
// so the game can bend the elbow and turn the rifle at the fist (flight pose: rifle carried low and level; firing: the
// rifle turns to the crosshair). armR node units: +y up, +z forward, +x = the Gundam's left; the arm hangs down with the
// rifle along it (muzzle at y -36.8). The forearm armour, the elbow cap, the rifle, its scope and stock and the fist are
// separate mesh islands, so each island is assigned whole by its bounding box. Vertices are stored relative to their own
// pivot, so with identity rotations everything shows exactly as before. Each step runs once: running the tool again on a
// split model does nothing (a model split by the earlier version, rifle only, gets the elbow added).
// usage: node tools/build_gundam_rifle.js models/gundam_rx78_18m.glb [more.glb ...]
const fs = require("fs");
const GRIP = [-0.4, -14.0, 0.2];   // centre of the right fist around the rifle grip (armR units)
const ELBOW = [-0.3, -5.0, 0.0];   // right elbow joint (armR units)
const ELBOW_L = [0.3, -5.0, 0.0];  // left elbow joint (armL units, the mirror of the right)
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }, CS = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 };

function split(file) {
  const g = fs.readFileSync(file); const jl = g.readUInt32LE(12); const j = JSON.parse(g.toString("utf8", 20, 20 + jl));
  const hasRifle = j.nodes.some((n) => n.name === "rifle"), hasFore = j.nodes.some((n) => n.name === "forearmR"), hasForeL = j.nodes.some((n) => n.name === "forearmL");
  if (hasRifle && hasFore && hasForeL) { console.log(file + ": already split"); return; }
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
  // move the islands of a node's mesh that match `pick` (bounding box, armR units) into new primitives, positions relative to `pivot`
  const take = (nodeIdx, pick, pivot) => {
    const mesh = j.meshes[j.nodes[nodeIdx].mesh]; const prims = []; let n = 0;
    for (const p of mesh.primitives) {
      const P = read(p.attributes.POSITION), I = read(p.indices).map((x) => x[0]);
      const par = P.map((_, i) => i); const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }; const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
      for (let t = 0; t < I.length; t += 3) { u(I[t], I[t + 1]); u(I[t], I[t + 2]); }
      const key = new Map(); P.forEach((v, i) => { const k = v.map((x) => x.toFixed(4)).join(","); if (key.has(k)) u(i, key.get(k)); else key.set(k, i); });
      const box = new Map(); for (let t = 0; t < I.length; t += 3) { const r = f(I[t]); const c = box.get(r) || { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; for (const vi of [I[t], I[t + 1], I[t + 2]]) for (let k = 0; k < 3; k++) { c.mn[k] = Math.min(c.mn[k], P[vi][k]); c.mx[k] = Math.max(c.mx[k], P[vi][k]); } box.set(r, c); }
      const sel = [], rest = [];
      for (let t = 0; t < I.length; t += 3) (pick(box.get(f(I[t]))) ? sel : rest).push(I[t], I[t + 1], I[t + 2]);
      n += sel.length / 3;
      if (!sel.length) continue;
      const used = [...new Set(sel)]; const remap = new Map(used.map((v, k) => [v, k])); const attrs = {};
      for (const [name, ai] of Object.entries(p.attributes)) {
        const a = j.accessors[ai]; let rows = read(ai); rows = used.map((v) => rows[v]);
        if (name === "POSITION") rows = rows.map((r) => [r[0] - pivot[0], r[1] - pivot[1], r[2] - pivot[2]]);
        attrs[name] = addAccessor(rows.map((r) => (r.length === 1 ? r[0] : r)), a.type, a.componentType, 34962, name === "POSITION");
      }
      const prim = { attributes: attrs, indices: addAccessor(sel.map((v) => remap.get(v)), "SCALAR", used.length > 65535 ? 5125 : 5123, 34963) };
      if (p.material !== undefined) prim.material = p.material; if (p.mode !== undefined) prim.mode = p.mode;
      prims.push(prim);
      p.indices = addAccessor(rest, "SCALAR", P.length > 65535 ? 5125 : 5123, 34963);
    }
    return { prims, n };
  };
  const armIdx = j.nodes.findIndex((n) => n.name === "armR"); if (armIdx < 0) throw new Error(file + ": no armR node");
  const log = [];
  let rifleIdx = j.nodes.findIndex((n) => n.name === "rifle");
  if (rifleIdx < 0) {
    // rifle, scope, stock and fist: narrow islands entirely below the forearm (the forearm armour is wider and ends at y -12.6)
    const r = take(armIdx, (c) => c.mx[1] <= -10.0 && c.mn[0] >= -1.9 && c.mx[0] <= 0.9, GRIP);
    if (r.n < 100) throw new Error(file + ": rifle not found (" + r.n + " triangles)");
    j.meshes.push({ name: "rifle", primitives: r.prims }); j.nodes.push({ name: "rifle", translation: GRIP.slice(), mesh: j.meshes.length - 1 });
    rifleIdx = j.nodes.length - 1; j.nodes[armIdx].children = (j.nodes[armIdx].children || []).concat([rifleIdx]); log.push("rifle " + r.n);
  }
  if (!hasFore) {
    // forearm armour, its side plates and the elbow cap: everything left on the arm below the elbow (the upper arm reaches y -5.4)
    const r = take(armIdx, (c) => c.mx[1] <= -4.0, ELBOW);
    if (r.n < 30) throw new Error(file + ": forearm not found (" + r.n + " triangles)");
    j.meshes.push({ name: "forearmR", primitives: r.prims }); j.nodes.push({ name: "forearmR", translation: ELBOW.slice(), mesh: j.meshes.length - 1, children: [rifleIdx] });
    const foreIdx = j.nodes.length - 1;
    j.nodes[armIdx].children = j.nodes[armIdx].children.filter((c) => c !== rifleIdx).concat([foreIdx]);
    j.nodes[rifleIdx].translation = [GRIP[0] - ELBOW[0], GRIP[1] - ELBOW[1], GRIP[2] - ELBOW[2]];   // now relative to the elbow
    log.push("forearm " + r.n);
  }
  if (!hasForeL) {
    // left forearm, fist and the whole shield: everything on the left arm below the elbow, plus the shield plate and its
    // fittings (x 5.0 and out), which reach up past the shoulder because the shield is strapped along the forearm
    const armLIdx = j.nodes.findIndex((n) => n.name === "armL"); if (armLIdx < 0) throw new Error(file + ": no armL node");
    const r = take(armLIdx, (c) => c.mx[1] <= -4.0 || c.mn[0] >= 5.0, ELBOW_L);
    if (r.n < 100) throw new Error(file + ": left forearm and shield not found (" + r.n + " triangles)");
    j.meshes.push({ name: "forearmL", primitives: r.prims }); j.nodes.push({ name: "forearmL", translation: ELBOW_L.slice(), mesh: j.meshes.length - 1 });
    j.nodes[armLIdx].children = (j.nodes[armLIdx].children || []).concat([j.nodes.length - 1]);
    log.push("forearmL " + r.n);
  }
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
  console.log(file + ": " + log.join(", ") + " triangles, bytes " + total);
}
for (const f of process.argv.slice(2)) split(f);
