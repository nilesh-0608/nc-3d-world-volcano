// ============================================================================
// world layout + procedural content generation (load-time only)
// ============================================================================
// The landform itself -- cone, crater, gorge, river -- is laid out in shaders.js (VENT .. POND) and built in dens().
// Here: the smaller rock dressed around it, the surface-nets mesh, the volumes and maps the shaders read, the props.

// rock outcrops on the basin floor, overhanging at the top: ax, az, bx, bz, radius, top, overhang, waist.
// Kept off the cone (60 m around the vent) and off the river, and near enough to the lava to catch its light.
const MESAS = [
  [66, 44, 72, 34, 7, -35, 2.5, 1.5], [60, 96, 64, 106, 8, -33, 2.5, 2], [-4, 126, 8, 130, 7, -36, 2, 1.5],
  [-56, 82, -62, 94, 8, -34, 3, 2], [-84, -30, -78, -42, 9, -31, 3, 2], [30, -88, 42, -92, 8, -34, 2, 1.5],
  [92, -30, 98, -18, 7, -35, 2, 1.5],
];
// a ring of rock standing in the ground, half buried: x, y, z, yaw, ring radius, thickness, height stretch.
// One, astride the river between its third and fourth points, turned so the flow runs through it.
const ARCHES = [[23, RIV_Y - 1, 90, 0.915, 11.5, 2.5, 1]];
// carved tunnels (a capsule: ax, ay, az, radius, bx, by, bz): none
const HOLES = [];
// regions kept free of terraces (along the river and around the viewpoints): ax, az, bx, bz, radius, softness
const CLEARS = [
  [40, 50, 36, 80, 15, 8], [36, 80, 10, 100, 15, 8], [10, 100, -28, 104, 15, 8], [-28, 104, -44, 114, 16, 8],
  [46, 70, 48, 38, 14, 8], [2, 108, 12, 100, 14, 8],
];
// the ocean's purple grotto zone is switched off by being parked far outside the world; main.js still reads
// PURPLE for its zone blend, which therefore always evaluates to 0
const PURPLE = [1e5, 1e5];
function primBuffer() {
  const a = [];
  for (const m of MESAS) a.push(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
  for (const m of ARCHES) a.push(m[0], m[1], m[2], m[3], m[4], m[5], m[6], 0);
  for (const m of HOLES) a.push(m[0], m[1], m[2], m[3], m[4], m[5], m[6], 0);
  for (const m of CLEARS) a.push(m[0], m[1], m[2], m[3], m[4], m[5], 0, 0);
  return new Float32Array(a);
}

// ---------------------------------------------------------------- terrain mesh from the density grid
function buildTerrain(D) {
  const sn = surfaceNets(D, NX, NY, NZ), nv = sn.nv, gp = sn.pos;
  const smp = sampler3(D, NX, NY, NZ);
  const vb = new ArrayBuffer(nv * 16), vf = new Float32Array(vb), v8 = new Int8Array(vb);
  const wp = new Float32Array(nv * 3), wn = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const x = gp[k * 3], y = gp[k * 3 + 1], z = gp[k * 3 + 2], e = 0.8;
    let nx = smp(x - e, y, z) - smp(x + e, y, z), ny = smp(x, y - e, z) - smp(x, y + e, z), nz = smp(x, y, z - e) - smp(x, y, z + e);
    const l = hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const X = OX + x * VS, Y = OY + y * VS, Z = OZ + z * VS;
    wp[k * 3] = vf[k * 4] = X; wp[k * 3 + 1] = vf[k * 4 + 1] = Y; wp[k * 3 + 2] = vf[k * 4 + 2] = Z;
    wn[k * 3] = nx; wn[k * 3 + 1] = ny; wn[k * 3 + 2] = nz;
    v8[k * 16 + 12] = round(nx * 127); v8[k * 16 + 13] = round(ny * 127); v8[k * 16 + 14] = round(nz * 127); v8[k * 16 + 15] = 127;
  }
  // bucket quads into the XZ culling grid
  const nq = sn.ni / 6, key = new Uint8Array(nq), cnt = new Uint32Array(CELLS * CELLS + 1);
  const lo = new Float32Array(CELLS * CELLS).fill(1e9), hi = new Float32Array(CELLS * CELLS).fill(-1e9);
  for (let q = 0; q < nq; q++) {
    const a = sn.idx[q * 6] * 3;
    const c = clamp(floor((wp[a] - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((wp[a + 2] - OZ) / CELLW), 0, CELLS - 1);
    key[q] = c; cnt[c + 1]++;
    for (let j = 0; j < 6; j++) { const y = wp[sn.idx[q * 6 + j] * 3 + 1]; if (y < lo[c]) lo[c] = y; if (y > hi[c]) hi[c] = y; }
  }
  for (let c = 0; c < CELLS * CELLS; c++) cnt[c + 1] += cnt[c];
  const ib = new Uint32Array(sn.ni), fill = cnt.slice();
  for (let q = 0; q < nq; q++) { const o = fill[key[q]]++ * 6; for (let j = 0; j < 6; j++) ib[o + j] = sn.idx[q * 6 + j]; }
  return { vb, ib, nv, wp, wn, smp, start: cnt, lo, hi };
}

// ---------------------------------------------------------------- surface queries + the volumes the shaders read
function makeWorld(D, T, flyPts, POSES) {
  const gi = (x, y, z) => x + NX * (y + NY * z);

  // --- height of the ground under (x, z), for the preset viewpoints
  const fl = [];
  const floorsAt = (x, z) => {
    const ix = clamp(round((x - OX) / VS), 1, NX - 2), iz = clamp(round((z - OZ) / VS), 1, NZ - 2);
    fl.length = 0; let ceil = 3;
    for (let gy = NY - 2; gy >= 0; gy--) {
      const d = D[gi(ix, gy, iz)], da = D[gi(ix, gy + 1, iz)];
      if (da <= 0 && d > 0) { const y = OY + (gy + d / (d - da)) * VS; fl.push(y, min(ceil, CAN) - y); } else if (da > 0 && d <= 0) ceil = OY + (gy + 0.5) * VS;
    }
    return fl;
  };
  const gy = (x, z) => { const f = floorsAt(x, z); return f.length ? f[f.length - 2] : -48; };

  // --- half-res volume: r = openness (terrain), g = skylight. With nothing overhead the sky is open everywhere above,
  // so the g channel is pure sky occlusion by the terrain itself.
  const hx = NX / 2, hy = NY / 2, hz = NZ / 2;
  const volD = new Uint8Array(hx * hy * hz * 2), yc = floor((CAN - 1.5 - OY) / (2 * VS));
  let Lp = new Float32Array(hx * hz).fill(1), Ln = new Float32Array(hx * hz); const tmp = new Float32Array(hx * hz);
  for (let y = hy - 1; y >= 0; y--) {
    const below = y < yc;
    if (below) for (let z = 0; z < hz; z++) for (let x = 0; x < hx; x++) { const i = x + hx * z; tmp[i] = (Lp[x > 0 ? i - 1 : i] + 2 * Lp[i] + Lp[x < hx - 1 ? i + 1 : i]) * 0.25; }
    for (let z = 0; z < hz; z++) for (let x = 0; x < hx; x++) {
      const i = x + hx * z, g0 = gi(x * 2, y * 2, z * 2), o = x + hx * (y + hy * z);
      const d = (D[g0] + D[g0 + 1] + D[g0 + NX] + D[g0 + NX + 1] + D[g0 + NX * NY] + D[g0 + NX * NY + 1] + D[g0 + NX * NY + NX] + D[g0 + NX * NY + NX + 1]) * 0.125;
      volD[o * 2] = clamp(0.5 - d / 12, 0, 1) * 255;
      if (!below) { volD[o * 2 + 1] = 255; continue; }
      const b = (tmp[z > 0 ? i - hx : i] + 2 * tmp[i] + tmp[z < hz - 1 ? i + hx : i]) * 0.25;
      Ln[i] = b * clamp(0.5 - d / 1.5, 0, 1);
      volD[o * 2 + 1] = min(1, b) * 255;
    }
    if (below) { const t = Lp; Lp = Ln; Ln = t; }
  }

  // --- ground map: r ash dust cover, g the heat of the lava (0 at its edge and outside it: see heatAt), b the light
  // the lava throws on this spot (square root of it, for 8-bit precision in the dark end), a cooled crust plates
  const ashAt = (x, z) => sstep(0.46, 0.62, fbm(x * 0.045, 7, z * 0.045, 3));
  const gm = new Uint8Array(GM * GM * 4), prox = lavaLight();
  for (let j = 0; j < GM; j++) for (let i = 0; i < GM; i++) {
    const x = (i + 0.5) / GM * 384 - 192, z = (j + 0.5) / GM * 384 - 192, o = (i + GM * j) * 4;
    gm[o] = ashAt(x, z) * 255; gm[o + 1] = heatAt(x, z) * 255;
    gm[o + 2] = sqrt(prox[i + GM * j]) * 255; gm[o + 3] = sstep(0.5, 0.66, fbm(x * 0.04, 3, z * 0.04, 3)) * 255;
  }
  // the same light, for the prop scatter (nearest texel)
  const lightAt = (x, z) => prox[clamp(floor((x + 192) / 384 * GM), 0, GM - 1) + GM * clamp(floor((z + 192) / 384 * GM), 0, GM - 1)];

  return { gy, volD, gm, props: buildProps(), solids: scatterProps(T, flyPts, lightAt) };
}

// ---------------------------------------------------------------- the lava: where it is, and the light it throws
// Mirrors mk in dens() (shaders.js), term for term: metres inside the lava (> 0), metres outside it (< 0).
const GM = 512;        // the ground map is GM x GM texels over the 384 m world
const LAVA_CORE = 3;   // metres in from the edge at which the lava is at its full heat
// Heat of the lava where it stands still, as a share of the flowing river's (1). Standing lava skins over: the lake
// and the pond are mostly dark plates with bright seams, which is also what keeps their total light, and with it
// the bloom, from washing out the crust. VENT_R: radius of the upwelling at the vent, the one white-hot spot in the lake.
const LAKE_HEAT = 0.45, POND_HEAT = 0.45, VENT_R = 5;
const segD = (px, pz, a, b) => {
  const bx = b[0] - a[0], bz = b[1] - a[1], h = clamp(((px - a[0]) * bx + (pz - a[1]) * bz) / max(bx * bx + bz * bz, 1e-4), 0, 1);
  return hypot(px - a[0] - bx * h, pz - a[1] - bz * h);
};
const lavaAt = (x, z) => {
  const vr = hypot(x - VENT[0], z - VENT[1]);
  let e = 1e4;
  for (let i = 1; i < RIVER.length; i++) e = min(e, segD(x, z, RIVER[i - 1], RIVER[i]));
  return max(mix(RIV_W0, RIV_W1, sstep(40, 62, vr)) - e, LAKE_R - vr, POND[2] - hypot(x - POND[0], z - POND[1]));
};
// what the shader turns into a temperature: 0 at the lava's edge, rising over LAVA_CORE metres to 1 in the river,
// to LAKE_HEAT / POND_HEAT where it stands, and back to 1 over the vent
const heatAt = (x, z) => {
  const vr = hypot(x - VENT[0], z - VENT[1]);
  let f = mix(1, mix(LAKE_HEAT, 1, sstep(VENT_R, VENT_R * 0.4, vr)), sstep(-1, 2, LAKE_R - vr));
  f = mix(f, POND_HEAT, sstep(-1, 2, POND[2] - hypot(x - POND[0], z - POND[1])));
  return clamp(lavaAt(x, z) / LAVA_CORE, 0, 1) * f;
};
// three box blurs of radius r texels in each direction: close to a Gaussian of sigma = sqrt(r * (r + 1)) texels
function blur(a, r) {
  const t = new Float32Array(GM * GM), k = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let d = 0; d < 2; d++) {
      const src = d ? t : a, dst = d ? a : t, st = d ? GM : 1, ln = d ? 1 : GM;
      for (let l = 0; l < GM; l++) {
        const o = l * ln; let s = 0;
        for (let i = -r; i <= r; i++) s += src[o + clamp(i, 0, GM - 1) * st];
        for (let i = 0; i < GM; i++) { dst[o + i * st] = s * k; s += src[o + min(i + r + 1, GM - 1) * st] - src[o + max(i - r, 0) * st]; }
      }
    }
  }
  return a;
}
// LIGHT_S0 / LIGHT_S1: reach (Gaussian sigma, metres) of the tight glow at the lava's edge and of the wide one that
// carries across the floor. LIGHT_K0 / LIGHT_K1: their weights. The light falls off with distance from actual lava
// and does not fill the basin: see the table in the report for the values it reaches.
const LIGHT_S0 = 3, LIGHT_S1 = 12, LIGHT_K0 = 1.2, LIGHT_K1 = 2.2;
function lavaLight() {
  const a = new Float32Array(GM * GM), b = new Float32Array(GM * GM), tx = GM / 384;
  for (let j = 0; j < GM; j++) for (let i = 0; i < GM; i++) a[i + GM * j] = b[i + GM * j] = lavaAt((i + 0.5) / GM * 384 - 192, (j + 0.5) / GM * 384 - 192) > 0 ? 1 : 0;
  // box radius for a sigma: r (r + 1) = sigma^2
  const rad = (sg) => max(1, round(sqrt(sg * sg * tx * tx + 0.25) - 0.5));
  blur(a, rad(LIGHT_S0)); blur(b, rad(LIGHT_S1));
  for (let i = 0; i < a.length; i++) a[i] = min(1, a[i] * LIGHT_K0 + b[i] * LIGHT_K1);
  return a;
}

// ---------------------------------------------------------------- vertical columns: basalt columns, rock spires, spatter cones
// one shared vertex/index buffer; `parts` indexes into it (i0 = first index, v0 = base vertex, n = index count)
function mergeMeshes(ms) {
  let nv = 0, ni = 0;
  for (const m of ms) { nv += m.nv; ni += m.ib.length; }
  const vb = new Uint8Array(nv * 16), ib = new Uint32Array(ni), parts = [];
  let vo = 0, io = 0;
  for (const m of ms) {
    vb.set(new Uint8Array(m.vb), vo * 16); ib.set(m.ib, io);
    parts.push({ i0: io, v0: vo, n: m.ib.length });
    vo += m.nv; io += m.ib.length;
  }
  return { vb, ib, parts };
}
// COL_H / SPIRE_H / CONE_R: the meshes are built at these sizes and then scaled per instance
const COL_H = 6.5, SPIRE_H = 9, CONE_R = 2.8;
function buildProps() {
  rseed(41);
  // a basalt column: a hexagonal prism, sunk a little into the ground and leaning by a degree or two
  const col = new Mesh();
  {
    const lx = rr(-0.1, 0.1), lz = rr(-0.1, 0.1), pts = [];
    for (let k = 0; k <= 5; k++) { const t = k / 5; pts.push([lx * t * COL_H, -1.2 + t * (COL_H + 1.2), lz * t * COL_H]); }
    col.tube(pts, (k) => 0.62 * (1 - 0.07 * k / 5), 6, true);
  }
  // a rock spire: a tapered five-sided needle
  const spire = new Mesh();
  {
    const pts = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([rr(-0.25, 0.25) * t, -1.4 + t * (SPIRE_H + 1.4), rr(-0.25, 0.25) * t]); }
    spire.tube(pts, (k) => 0.95 * pow(1 - k / 6, 0.75) + 0.05, 5, true);
  }
  // a spatter cone: wide, low, hollow-looking lip
  const cone = new Mesh();
  {
    const pts = [];
    for (let k = 0; k <= 4; k++) { const t = k / 4; pts.push([0, -0.6 + t * 3.2, 0]); }
    cone.tube(pts, (k) => CONE_R * (1 - 0.78 * k / 4), 7, true);
  }
  return mergeMeshes([col.build(), spire.build(), cone.build()]);
}
// N_COL / N_SPIRE / N_CONE: instance counts. CLEAR_R: metres kept free around the camera path and the viewpoints.
// DARK_KEEP: share of the candidates kept where no lava light reaches; where it does, all are kept, so the columns
// gather along the river and round the pond, where they are lit from below and seen against the glow.
const N_COL = 230, N_SPIRE = 90, N_CONE = 60, CLEAR_R = 6, DARK_KEEP = 0.03;
// instance stride is 12 floats, unchanged: pos.xyz + uniform scale | quaternion | mat, seed, lod, bob
function scatterProps(T, flyPts, lightAt) {
  rseed(57);
  const inst = [], draws = [];
  const pickV = () => ((rnd() * T.nv) | 0) * 3;
  const far = (x, y, z) => {
    for (const p of flyPts) { const dx = x - p[0], dz = z - p[2]; if (dx * dx + dz * dz < CLEAR_R * CLEAR_R) return false; }
    return true;
  };
  // part 0 columns (upright, any yaw), 1 spires (upright), 2 cones (laid on the surface normal)
  const SPEC = [[N_COL, 0.55, 0.55, 1.7], [N_SPIRE, 0.5, 0.45, 1.25], [N_CONE, 0.72, 0.5, 1.4]];
  for (let part = 0; part < 3; part++) {
    const [n, minUp, s0, s1] = SPEC[part], first = inst.length / 12;
    let placed = 0;
    for (let tries = 0; tries < n * 90 && placed < n; tries++) {
      const k = pickV(), x = T.wp[k], y = T.wp[k + 1], z = T.wp[k + 2];
      if (T.wn[k + 1] < minUp || y > -24 || !far(x, y, z)) continue;
      // not in the lava or on the shelf beside it, and mostly where its light falls
      if (lavaAt(x, z) > -3 || rnd() > DARK_KEEP + lightAt(x, z)) continue;
      const q = part === 2 ? qMul(qAxis(0, 1, 0, rr(0, TAU)), qFromY(T.wn[k], T.wn[k + 1], T.wn[k + 2]))
        : qMul(qAxis(0, 1, 0, rr(0, TAU)), qAxis(1, 0, 0, rr(-0.09, 0.09)));
      inst.push(x, y, z, rr(s0, s1), q[0], q[1], q[2], q[3], 1, rnd(), 1, 0);
      placed++;
    }
    draws.push({ part, first, count: placed });
  }
  return { data: new Float32Array(inst), draws };
}
