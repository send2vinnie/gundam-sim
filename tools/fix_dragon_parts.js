// Re-attach the dragon's small white parts (teeth and claws, material "dracaufeulambert4SG") to the surface they sit on.
// When the head/wing/leg joints were added, the 4 teeth kept body weights (so they stayed behind when the head turned)
// and the 6 hand claws got mostly wing weights (so they flapped away from the hands). Each part (a mesh island) now
// takes the skin weights of the nearest vertex of the dragon's body mesh (material "dracaufeulambert2SG") to the part's
// base (its vertex closest to that surface), for all its vertices, so it moves rigidly with that spot: teeth with the
// head, hand claws with the hands, foot claws with the ankles. Only JOINTS_0/WEIGHTS_0 change, in place.
// First, the front arms (dragon.glb and the start screen's dragon_stand.glb), shoulder to hand: they were weighted mostly to the
// wings, so the elbows and hands flapped with every wing beat. They now ride on the body joint (blended back to the old
// weights toward the wing roots, so the shoulders stay smooth). Run it on the models as they were before this tool.
// usage: node tools/fix_dragon_parts.js models/dragon.glb [models/dragon_stand.glb]
const fs = require("fs");
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }, CS = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 };

const jointNamesOf = (j) => j.skins[0].joints.map((x) => j.nodes[x].name);
function fix(file) {
  const g = fs.readFileSync(file); const jl = g.readUInt32LE(12); const j = JSON.parse(g.toString("utf8", 20, 20 + jl));
  const binStart = 28 + jl, bin = g.subarray(binStart, binStart + g.readUInt32LE(20 + jl));   // edited in place
  const A = (ai) => { const a = j.accessors[ai], bv = j.bufferViews[a.bufferView]; return { a, n: NC[a.type], cs: CS[a.componentType], base: (bv.byteOffset || 0) + (a.byteOffset || 0), st: bv.byteStride || NC[a.type] * CS[a.componentType] }; };
  const get = (X, i, k) => { const off = X.base + i * X.st + k * X.cs; return X.a.componentType === 5126 ? bin.readFloatLE(off) : X.cs === 1 ? bin.readUInt8(off) : X.cs === 2 ? bin.readUInt16LE(off) : bin.readUInt32LE(off); };
  const set = (X, i, k, v) => { const off = X.base + i * X.st + k * X.cs; if (X.a.componentType === 5126) bin.writeFloatLE(v, off); else if (X.cs === 1) bin.writeUInt8(v, off); else if (X.cs === 2) bin.writeUInt16LE(v, off); else bin.writeUInt32LE(v, off); };
  const rows = (X) => { const o = []; for (let i = 0; i < X.a.count; i++) { const v = []; for (let k = 0; k < X.n; k++) v.push(get(X, i, k)); o.push(v); } return o; };
  const matIdx = (name) => j.materials.findIndex((m) => m.name === name);
  const skinned = j.meshes.map((m) => m.primitives).flat().filter((p) => p.attributes.JOINTS_0 !== undefined);
  const bodyPrims = skinned.filter((p) => p.material === matIdx("dracaufeulambert2SG"));
  const partPrims = skinned.filter((p) => p.material === matIdx("dracaufeulambert4SG"));
  if (!bodyPrims.length || !partPrims.length) { console.log(file + ": no skinned body/part primitives, nothing to do"); return; }
  // the body surface: the biggest body primitive
  const body = bodyPrims.sort((a, b) => j.accessors[b.attributes.POSITION].count - j.accessors[a.attributes.POSITION].count)[0];
  const BP = rows(A(body.attributes.POSITION)), BJ = rows(A(body.attributes.JOINTS_0)), BW = rows(A(body.attributes.WEIGHTS_0));
  // front arms and hands -> body, in the flight model's native frame (+x its left, -y forward, +z up); dragon_stand.glb
  // (no head joint) is the same mesh in another frame: native = (-z, -x - 1, y)
  const bodyJ = jointNamesOf(j).indexOf("body");
  const toNative = j.nodes.some((n) => n.name === "head") ? (v) => v : (v) => [-v[2], -v[0] - 1, v[1]];
  if (bodyJ >= 0) {
    const BX = A(body.attributes.JOINTS_0), BWX = A(body.attributes.WEIGHTS_0); let n = 0;
    BP.forEach((v0, i) => {
      // the whole front arm, shoulder to hand (upper arm, elbow, forearm, hand): beside the chest, in front of / below the
      // wing roots. Blended out toward the back (y 1.0..1.5) and, behind the hands, up into the wing roots (z 11.5..12.3).
      const v = toNative(v0), ax = Math.abs(v[0]); if (ax < 2.5 || ax > 7.5 || v[2] < 6.5 || v[2] > 13 || v[1] > 1.5 || v[1] < -3) return;
      const ramp = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
      const t = ramp(1.5 - v[1], 0, 0.5) * (v[1] <= -0.3 ? 1 : ramp(12.3 - v[2], 0, 0.8)) * ramp(v[2], 6.5, 7);
      if (t <= 0) return;
      const w = BW[i].slice(), jt = BJ[i].slice();
      // body weight raised to t of the total, the rest scaled down
      let slot = jt.findIndex((x, k) => x === bodyJ && w[k] > 0); if (slot < 0) { slot = w.indexOf(Math.min(...w)); jt[slot] = bodyJ; w[slot] = 0; }
      const others = w.reduce((s, x, k) => s + (k === slot ? 0 : x), 0), keep = (1 - t) * (others + w[slot]) ;
      const nw = w.map((x, k) => (k === slot ? 0 : others > 0 ? x * (keep * others / (others + w[slot]) || 0) / others : 0));
      nw[slot] = 1 - nw.reduce((s, x) => s + x, 0);
      for (let k = 0; k < 4; k++) { set(BX, i, k, jt[k]); set(BWX, i, k, nw[k]); BJ[i][k] = jt[k]; BW[i][k] = nw[k]; }
      n++;
    });
    console.log(file + ": front arms and hands re-weighted to the body: " + n + " vertices");
    // the claws at the top front corner of each wing (the wing's "thumb", above z 17, light blue tip) were weighted mostly to
    // the body, so they stayed put while the wing beat: they go wholly onto their wing joint, in every dragon primitive
    const wingJ = { L: jointNamesOf(j).indexOf("wingL"), R: jointNamesOf(j).indexOf("wingR") };
    let m = 0;
    for (const p of skinned) {
      const PX = A(p.attributes.POSITION), JX = A(p.attributes.JOINTS_0), WX = A(p.attributes.WEIGHTS_0);
      for (let i = 0; i < PX.a.count; i++) {
        const v = toNative([get(PX, i, 0), get(PX, i, 1), get(PX, i, 2)]), ax = Math.abs(v[0]);
        if (ax < 3.5 || ax > 8 || v[2] < 16.8) continue;
        const wj = v[0] > 0 ? wingJ.L : wingJ.R, t = Math.min(1, (v[2] - 16.8) / 0.4);
        const jt = [0, 1, 2, 3].map((k) => get(JX, i, k)), w = [0, 1, 2, 3].map((k) => get(WX, i, k));
        let slot = jt.findIndex((x, k) => x === wj && w[k] > 0); if (slot < 0) { slot = w.indexOf(Math.min(...w)); jt[slot] = wj; w[slot] = 0; }
        const nw = w.map((x, k) => (k === slot ? x + (1 - x) * t : x * (1 - t)));
        for (let k = 0; k < 4; k++) { set(JX, i, k, jt[k]); set(WX, i, k, nw[k]); }
        m++;
      }
    }
    console.log(file + ": wing-top claws re-weighted to their wing: " + m + " vertices");
  }
  const near = (v) => { let bi = -1, bd = Infinity; for (let i = 0; i < BP.length; i++) { const d = (BP[i][0] - v[0]) ** 2 + (BP[i][1] - v[1]) ** 2 + (BP[i][2] - v[2]) ** 2; if (d < bd) { bd = d; bi = i; } } return [bi, Math.sqrt(bd)]; };
  const jointNames = jointNamesOf(j);
  for (const p of partPrims) {
    const PX = A(p.attributes.POSITION), JX = A(p.attributes.JOINTS_0), WX = A(p.attributes.WEIGHTS_0), P = rows(PX), I = rows(A(p.indices)).map((x) => x[0]);
    const par = P.map((_, i) => i); const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }; const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    for (let t = 0; t < I.length; t += 3) { u(I[t], I[t + 1]); u(I[t], I[t + 2]); }
    const key = new Map(); P.forEach((v, i) => { const k = v.map((x) => x.toFixed(3)).join(","); if (key.has(k)) u(i, key.get(k)); else key.set(k, i); });
    const islands = new Map(); P.forEach((_, i) => { const r = f(i); if (!islands.has(r)) islands.set(r, []); islands.get(r).push(i); });
    for (const verts of islands.values()) {
      // the part's base: its vertex nearest to the body surface, and the body vertex there
      let best = null; for (const i of verts) { const [bi, d] = near(P[i]); if (!best || d < best.d) best = { bi, d }; }
      const jt = BJ[best.bi], wt = BW[best.bi], sum = wt.reduce((s, x) => s + x, 0) || 1;
      for (const i of verts) for (let k = 0; k < 4; k++) { set(JX, i, k, jt[k]); set(WX, i, k, wt[k] / sum); }
      const c = [0, 1, 2].map((k) => verts.reduce((s, i) => s + P[i][k], 0) / verts.length);
      console.log(file + ": part at " + c.map((x) => x.toFixed(1)).join(",") + " (" + verts.length + " verts, " + best.d.toFixed(2) + " from the surface) -> " +
        jt.map((x, k) => (wt[k] > 0 ? jointNames[x] + ":" + (wt[k] / sum).toFixed(2) : null)).filter(Boolean).join(" "));
    }
  }
  fs.writeFileSync(file, g);
}
for (const f of process.argv.slice(2)) fix(f);
