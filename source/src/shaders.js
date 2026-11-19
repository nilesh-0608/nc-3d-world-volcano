// ============================================================================
// WGSL sources
// ============================================================================

// height of the ash ceiling -- the smoke layer the plume spreads out under. The basin floor is at
// about -48; the camera can rise to +2.4, which is as high as the collision grid goes.
const CAN = -15;

// ---------------------------------------------------------------- the volcano's layout
// One cone with a crater lake, a breach in its rim, a lava gorge down the flank and a river across the basin floor
// to a pond. dens() (WGSL, below), the fragment shaders and lavaAt() (world.js) all read these, and none of them
// warps them, so the lava map lies exactly on the lava surface. Metres, world space.
const VENT = [0, 0];                         // centre of the cone (x, z)
const RIM_R = 17, RIM_Y = -6;                // crest of the crater rim: radius and height
const BASE_R = 60, BASE_Y = -49.5;           // where the flank meets the basin floor
const LAKE_R = 12.5, LAKE_Y = -19;           // the lava lake in the crater
const RIV_Y = -50.5;                         // lava level on the basin floor
const LVL_R0 = 13, LVL_R1 = 50;              // the lava falls from LAKE_Y to RIV_Y between these radii (the gorge)
const RIV_W0 = 2.6, RIV_W1 = 4;              // half-width of the flow: in the gorge, on the floor
const RIVER = [[7, 8], [24, 26], [40, 50], [36, 80], [10, 100], [-28, 104]]; // the flow's centre line (x, z)
const POND = [-28, 104, 9];                  // where it ends: x, z, radius
const CAP_HI = -1;                           // rock may rise this high over the cone (CAN - 5 everywhere else)
// a WGSL float literal; in brackets, because the minifier would join "a - -b" into "a--b"
const wf = (v) => '(' + v.toFixed(2) + ')';
const wv2 = (v) => `vec2f(${wf(v[0])}, ${wf(v[1])})`;
// shared by the density pass and the scene shaders (both define ss)
const W_VOLC = /*wgsl*/`
const VENT = ${wv2(VENT)};
const LAKE_Y = ${wf(LAKE_Y)};
const RIV_Y = ${wf(RIV_Y)};
const RIM_R = ${wf(RIM_R)};
const RIM_Y = ${wf(RIM_Y)};
// height of the lava surface in the column over xz: the lake inside the crater, the river outside the cone,
// the cascade down the gorge in between
fn lavaY(xz: vec2f) -> f32 { return mix(LAKE_Y, RIV_Y, ss(${wf(LVL_R0)}, ${wf(LVL_R1)}, length(xz - VENT))); }
`;

const W_NOISE = /*wgsl*/`
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn h31(p: vec3f) -> f32 { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h33(p: vec3f) -> vec3f { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
fn vn(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1., 0., 0.)), u.x), mix(h31(i + vec3f(0., 1., 0.)), h31(i + vec3f(1., 1., 0.)), u.x), u.y),
             mix(mix(h31(i + vec3f(0., 0., 1.)), h31(i + vec3f(1., 0., 1.)), u.x), mix(h31(i + vec3f(0., 1., 1.)), h31(i + vec3f(1., 1., 1.)), u.x), u.y), u.z);
}
fn fbm(p: vec3f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 31.7, 5.3); a *= .5; }
  return s / (1. - 2. * a);
}
fn wor(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); var d = 9.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { for (var z = -1; z <= 1; z++) {
    let o = vec3f(f32(x), f32(y), f32(z)); let r = o + h33(i + o) - f; d = min(d, dot(r, r));
  } } }
  return sqrt(d);
}
`;

// ---------------------------------------------------------------- terrain density (compute)
// one seg2 per stretch of the flow (built here: build.mjs cannot minify a template nested inside a WGSL one)
const W_RIVD = RIVER.slice(1).map((b, i) => 'e = min(e, seg2(p, ' + wv2(RIVER[i]) + ', ' + wv2(b) + '));').join(' ');
const W_DENS = W_NOISE + W_VOLC + /*wgsl*/`
struct U { n: vec4u, o: vec4f, c: vec4u };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> D: array<f32>;
@group(0) @binding(2) var<storage, read> P: array<vec4f>;
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
fn smin(a: f32, b: f32, k: f32) -> f32 { return -smax(-a, -b, k); }
fn seg2(p: vec2f, a: vec2f, b: vec2f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
fn seg3(p: vec3f, a: vec3f, b: vec3f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
// distance to the centre line of the lava flow
fn rivD(p: vec2f) -> f32 {
  var e = 1e4;
  ${W_RIVD}
  return e;
}
fn dens(p: vec3f) -> f32 {
  let w = vec3f(fbm(p * .04 + 11., 3), fbm(p * .04 + 47., 3), fbm(p * .04 + 83., 3)) - .5;
  let q = p + w * vec3f(15., 6., 15.);
  // basin floor: gentle rises and hollows around -48
  let g0 = -48. + 5. * (fbm(vec3f(q.xz * .011, 3.), 4) - .5) + 1.4 * (fbm(vec3f(q.xz * .07, 9.), 3) - .5);
  let tn = 3. * (fbm(vec3f(q.xz * .09, 2.), 3) - .5);
  var dm = -1e3; var de = 1e3;
  var k = 0u;
  for (var i = 0u; i < u.c.x; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    let yr = clamp((p.y - g0) / (b.y - g0), 0., 1.3);
    var e = seg2(q.xz, a.xy, a.zw) - b.x;
    e -= b.z * ss(.3, .92, yr) + 3. * (1. - yr) * (1. - yr) - b.w * ss(.0, .5, yr) * (1. - ss(.5, 1., yr));
    dm = smax(dm, smin(-e, b.y + tn - p.y, 3.), 2.5);
    de = min(de, e);
  }
  var clr = 0.;
  let kc = (u.c.x + u.c.y + u.c.z) * 2u;
  for (var i = 0u; i < u.c.w; i++) {
    let a = P[kc + i * 2u]; let b = P[kc + i * 2u + 1u];
    clr = max(clr, 1. - ss(0., b.y, seg2(q.xz, a.xy, a.zw) - b.x));
  }
  let rad = length(p.xz) + w.x * 14.;
  let n = fbm(vec3f(q.xz * .0125, 1.7), 4);
  let ring = ss(156., 172., rad);
  let plat = max(ss(.5, .565, n) * (1. - clr), ring);
  // low ash terraces out on the basin floor; the rim wall still closes the world (cut off under the ash ceiling below)
  let th = g0 + plat * mix(3. + 7. * fbm(vec3f(q.xz * .03, 5.), 2), 60., ring);
  var d = smax(g0 + 2.5 * ss(10., 0., de) - p.y, dm, 3.);
  d = smax(d, (th - p.y) * .7, 3.);
  // ---- the cone. vr0 is the true distance from the vent, vr the same with a ragged outline. Concave flank
  // (steepest at the rim), and inside the crest the top falls away towards the crater.
  let vr0 = length(p.xz - VENT);
  let vr = vr0 + (fbm(vec3f(p.xz * .045, 21.), 3) - .5) * 5.;
  let ct = clamp((vr - ${wf(RIM_R)}) / ${wf(BASE_R - RIM_R)}, 0., 1.);
  let ch = ${wf(BASE_Y)} + ${wf(RIM_Y - BASE_Y)} * pow(max(1. - ct, 1e-4), 1.4) - max(${wf(RIM_R)} - vr, 0.) * .5;
  d = smax(d, (ch - p.y) * .62, 3.);
  k = u.c.x * 2u;
  for (var i = 0u; i < u.c.y; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    var r = p + w * 3. - a.xyz;
    let cs = cos(a.w); let sn = sin(a.w);
    r = vec3f(cs * r.x + sn * r.z, r.y / b.z, -sn * r.x + cs * r.z);
    d = smax(d, b.y - length(vec2f(length(r.xy) - b.x, r.z)), 1.5);
  }
  let hg = p.y - g0;
  let rk = mix(.1, 1., ss(.8, 6., hg)); // soil on the floor is smooth, the outcrops keep their rock detail
  d += rk * ((.5 - wor(p * .17 + w * 2.)) * 3.4 + (.5 - wor(p * .41 + 7.)) * 1.3 + (fbm(p * .3, 3) - .5) * 2.2);
  d += rk * 2.2 * (abs(fract(p.y * .21 + w.y * 2.2) - .5) - .25);
  for (var i = 0u; i < u.c.z; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    d = smin(d, seg3(p + w * 2., a.xyz, b.xyz) - a.w, 2.);
  }
  // ---- crater, gorge and lava, cut AFTER the rock noise so the noise cannot dam the flow
  let lvl = lavaY(p.xz);
  let bn = fbm(p * .16 + 5., 3) - .5;
  // crater: widest a few metres above the lake, narrowing again under the rim, so the lip overhangs
  let rw = ${wf(LAKE_R + 1)} + 2.5 * ss(LAKE_Y, LAKE_Y + 5., p.y) - 2.5 * ss(${wf(RIM_Y - 5)}, ${wf(RIM_Y - 0.5)}, p.y) + bn * 2.4;
  d = smin(d, max(vr - rw, LAKE_Y + .25 - p.y), 1.2);
  // mk: metres inside the lava (> 0), the same field lavaAt() in world.js builds
  let wl = mix(${wf(RIV_W0)}, ${wf(RIV_W1)}, ss(40., 62., vr0));
  let mk = max(max(wl - rivD(p.xz), ${wf(LAKE_R)} - vr0), ${wf(POND[2])} - length(p.xz - ${wv2(POND)}));
  // the channel: banks lean back with height. cl is how far above the lava it is open: to the sky through the
  // rim and down the gorge, except between 30 and 40 m from the vent where the flank is left standing as a
  // natural bridge over the cascade, and only 5.5 m on the basin floor, so arches and ledges survive over the river
  let cl = 40. - 36.5 * ss(29., 31., vr0) * (1. - ss(39., 41., vr0)) - 34.5 * ss(58., 64., vr0);
  let bank = 1.2 + .45 * clamp(p.y - lvl, 0., 5.) + bn * 1.8;
  d = smin(d, max(max(0. - mk - bank, lvl - 1. - p.y), p.y - lvl - cl), 1.);
  // a rock shelf a hand above the lava along its edge, then the lava itself: a slab with a flat top at lvl
  d = max(d, max(min(min(lvl + .25 - p.y, mk + 2.5), 0. - mk), min(lvl - p.y, mk)));
  // nothing solid within 5 m of the ash ceiling or above it, so the camera rises through free air; only the
  // cone may go higher
  return min(d, mix(${wf(CAP_HI)}, ${wf(CAN - 5)}, ss(${wf(BASE_R - 6)}, ${wf(BASE_R + 6)}, vr0)) - p.y);
}
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= u.n.xyz)) { return; }
  var d = dens(u.o.xyz + vec3f(id) * u.o.w);
  if (id.x == 0u || id.z == 0u || id.x == u.n.x - 1u || id.z == u.n.z - 1u || id.y == u.n.y - 1u) { d = -1.; }
  D[id.x + u.n.x * (id.y + u.n.y * id.z)] = d;
}
`;

// ---------------------------------------------------------------- fullscreen helpers
const W_FS = /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// rock detail texture (tileable): rg = slope, b = height, a = mottling
// tileable noise (period `per` cells): value noise, fbm, worley
const W_PER = /*wgsl*/`
fn hp(p: vec2f, per: f32) -> f32 { return h31(vec3f(p - per * floor(p / per), per)); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
fn tw(p: vec2f, per: f32) -> vec3f {
  let i = floor(p); let f = fract(p); var d = vec2f(9.); var id = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let o = vec2f(f32(x), f32(y)); let c = i + o; let cw = c - per * floor(c / per);
    let hh = h33(vec3f(cw, per)); let r = o + hh.xy - f; let l = dot(r, r);
    if (l < d.x) { d.y = d.x; d.x = l; id = hh.z; } else if (l < d.y) { d.y = l; }
  } }
  return vec3f(sqrt(d), id);
}
`;
const W_DETAIL = W_NOISE + W_FS + W_PER + /*wgsl*/`
fn H(uv: vec2f) -> f32 {
  let wq = uv + .11 * (vec2f(tf(uv, 3., 4), tf(uv + .5, 3., 4)) - .5);
  let f = tf(wq, 3., 8);
  let r1 = 1. - abs(tf(wq + 1.7, 5., 6) * 2. - 1.);
  let cr = min(abs(tf(wq + 4.1, 4., 5) * 2. - 1.) * 7., 1.);
  let cr2 = min(abs(tf(wq.yx + 2.3, 9., 4) * 2. - 1.) * 9., 1.);
  let pt = tw(wq * 29., 29.);
  let pit = (1. - ss(.0, .34, pt.x)) * step(.62, pt.z);
  return f * .50 + r1 * r1 * .24 + cr * cr2 * .26 - pit * .07;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 1024.; let e = 1. / 1024.;
  let h = H(uv);
  let gx = H(uv + vec2f(e, 0.)) - H(uv - vec2f(e, 0.)); let gy = H(uv + vec2f(0., e)) - H(uv - vec2f(0., e));
  let s = clamp(vec2f(gx, gy) * 1024. * .5 * .075, vec2f(-1.), vec2f(1.));
  return vec4f(-s * .5 + .5, h, tf(uv + 3.7, 3., 5));
}
`;

// blit / mip / bloom chain
const W_BLIT = W_FS + /*wgsl*/`
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
fn kar(c: vec3f) -> vec4f { let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// INHERITED, AND NOW DEAD: an animated tiling texture (r = holes, g = noise, ba = surface slope) that the forest
// sampled along the sun for sky holes and dappled floor light. tW (binding 5) is declared and bound but sampled
// nowhere, yet this pass and its five mips are still built and still drawn every frame. It is left in place
// deliberately: deleting it means editing the shared bind group layout, which is not worth the risk for the
// handful of microseconds it costs on a 256- or 512-pixel target.
const W_WATER = W_NOISE + W_FS + W_PER + /*wgsl*/`
@group(0) @binding(0) var<uniform> tm: vec4f;
fn lh(uv: vec2f) -> f32 { return tf(uv, 6., 4) * .6 + (1. - min(tw(uv * 14., 14.).x, 1.)) * .4; }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let u0 = fc.xy / ${WATER}.; let t = tm.x;
  // the crown layer sways a little as a whole (whole periods, so the texture still tiles)
  let uv = u0 + .003 * vec2f(sin(t * .6 + u0.y * 12.566371), cos(t * .45 + u0.x * 18.849556));
  let wq = uv + .04 * (vec2f(tf(uv, 4., 3), tf(uv + .5, 4., 3)) - .5);
  // holes: ragged blobs around some of the worley cell centres (HOLE_P of the cells, HOLE_R of a cell wide)
  let w = tw(wq * 8., 8.);
  let hole = (1. - ss(.15, .33, w.x + (tf(wq + 1.3, 16., 3) - .5) * .25)) * step(w.z, .42);
  let e = 1. / ${WATER}.;
  let s = vec2f(lh(uv + vec2f(e, 0.)) - lh(uv - vec2f(e, 0.)), lh(uv + vec2f(0., e)) - lh(uv - vec2f(0., e))) * (.03 / e);
  return vec4f(hole, tf(uv + 2.3, 8., 4), clamp(s, vec2f(-2.), vec2f(2.)));
}
`;

// ---------------------------------------------------------------- shared scene code
const S_G = W_VOLC + /*wgsl*/`
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, sun: vec4f, res: vec4f, mis: vec4f };
// ---- volcanic palette + smoke: everything worth tuning is here
const CAN = ${CAN.toFixed(1)};               // height of the ash ceiling the plume spreads out under
const FLR = -48.;                            // nominal basin floor: the haze is densest on it     
const HZ0 = .035;                            // smoke extinction per metre at the floor (computed: see the report)
const HZB = .024;                            // how fast the smoke thins with height (1/m). Was .018: the floor is as thick as before, the air at rim height a third clearer, so the cone can be seen from above
const FARD = 130.;                           // geometry fades into the smoke by here
// every light has a day (_D) and a night (_N) value; g.mis.w (0 day .. 1 night, eased in main.js) blends them, so the
// N key changes colours and intensities only: the sun direction, the shadow map and the world stay as they are
const HAZE_LO_D = vec3f(.105, .080, .070);   // smoke on the floor AWAY from lava: cold grey-brown ash, no glow of its own
const HAZE_LO_N = vec3f(.062, .046, .042);
const HAZE_GLOW = vec3f(.60, .13, .020);     // what the lava adds to the smoke over it (times the baked lava light)
const PLUME = 2.5;                           // extra glow in the column of smoke standing over the crater, in units of HAZE_GLOW
const HAZE_MID_D = vec3f(.085, .058, .052);  // mid basin: the glow has died out, warm grey ash
const HAZE_MID_N = vec3f(.048, .032, .032);
const HAZE_HI_D = vec3f(.075, .070, .068);   // the ash ceiling overhead: dim, not bright
const HAZE_HI_N = vec3f(.030, .029, .032);
const SKYC_D = vec3f(.052, .048, .054);      // zenith: ash, barely lighter than the ceiling
const SKYC_N = vec3f(.010, .011, .016);
const SUNC_D = vec3f(.11, .092, .075);       // only a smear of daylight gets through the ash
const SUNC_N = vec3f(.022, .028, .045);
const SHAFT_D = vec3f(1., .9, .6);           // tint of the light shafts
const SHAFT_N = vec3f(.4, .55, .95);
const RAYK_D = 4.5;                          // strength of the light shafts
const RAYK_N = 2.5;
const AMB_LO_D = vec3f(.055, .048, .050);    // ash light from above, inside the basin
const AMB_LO_N = vec3f(.020, .020, .026);
const AMB_HI_D = vec3f(.090, .084, .088);    // ash light from above, out of the smoke
const AMB_HI_N = vec3f(.032, .032, .042);
const MOON = vec3f(5., 5.6, 6.5);            // disc of the moon (the disc of the sun is 30 x SUNC_D)
// ---- THE INVERSION: the lava is the emitter, and the only warm light in the scene.
// The temperature ramp, coolest to hottest. All HDR: exposure in the basin is .34, so the bloom chain and the
// tone curve get red at 1x, orange at 2x, and yellow and white far over 1 in every channel they need.
const LAVA_K0 = vec3f(.55, .018, .0);        // .18  the last glow under black crust: deep red
const LAVA_K1 = vec3f(2.2, .10, .004);       // .38  red
const LAVA_C = vec3f(6.0, .60, .02);         // .58  orange -- the colour of the flow (was the one flat emissive colour)
const LAVA_K3 = vec3f(9., 2.8, .16);         // .80  yellow
const LAVA_K4 = vec3f(12., 8.5, 3.2);        // 1.   white-hot core (was 18 14 7: it clipped to flat white over the lake)
fn lavaCol(t: f32) -> vec3f {
  var c = LAVA_K0 * ss(.03, .18, t);
  c = mix(c, LAVA_K1, ss(.18, .38, t));
  c = mix(c, LAVA_C, ss(.38, .58, t));
  c = mix(c, LAVA_K3, ss(.58, .80, t));
  return mix(c, LAVA_K4, ss(.80, 1., t));
}
const LAVA_AMB = vec3f(1.25, .36, .075);     // colour of the light the lava throws on rock
const LAVA_H = 22.;                          // metres above the lava surface over which that light dies away
// A crack is where the rock's own detail height is LOW. Monotone on purpose: a level-set band around a fixed
// value both floods up close (31% of texels at +-.075) and vanishes at distance, because the detail height's
// mean (0.594, measured) lies outside any narrow band and the mips average towards it. Measured coverage of
// this form: 6.3% of texels at full strength, 28% partial.
const LAVA_V0 = .38;                         // detail height at or below which a crack is fully open
const LAVA_V1 = .52;                         // ... and above which there is no crack at all
const LAVA_CRK0 = .25;                       // baked lava light at which the rock beside the flow starts to crack open
const LAVA_CRK1 = .70;                       // ... and at which the cracks are fully lit
// the three ways the lava reaches a surface. NEAR and UP are scaled by the baked lava light (ground map b, 1 on
// the bank, a third at 10 m, nothing by 35 m), so they fall off with distance from actual lava. FILL is all
// that reaches rock away from it, and it is small on purpose: cold basalt has to be near-black.
const LAVA_FILL = .35;                       // basin-wide warm fill: all the lava you cannot see
const LAVA_NEAR = 12.;                       // rock facing the lava, at its edge (level ground beside it gets half)
const LAVA_UP = 9.;                          // the bounce from directly below: this is what lights overhangs
// The grazing-angle sheen below is the one term NOT multiplied by albedo, so it scales with the full lava
// ambient. At the engine's original .6 it reached twice the diffuse term and washed the lit floor up to
// crack brightness. Solved down to .3. Raise it and the floor turns into a mirror at grazing angles.
const LAVA_SHEEN = .3;
fn ngt() -> f32 { return g.mis.w; }
fn hazeLo() -> vec3f { return mix(HAZE_LO_D, HAZE_LO_N, ngt()); }
fn hazeMid() -> vec3f { return mix(HAZE_MID_D, HAZE_MID_N, ngt()); }
fn hazeHi() -> vec3f { return mix(HAZE_HI_D, HAZE_HI_N, ngt()); }
fn skyc() -> vec3f { return mix(SKYC_D, SKYC_N, ngt()); }
fn sunc() -> vec3f { return mix(SUNC_D, SUNC_N, ngt()); }
fn shaftc() -> vec3f { return mix(SHAFT_D, SHAFT_N, ngt()); }
fn rayk() -> f32 { return mix(RAYK_D, RAYK_N, ngt()); }
fn ambLo() -> vec3f { return mix(AMB_LO_D, AMB_LO_N, ngt()); }
fn ambHi() -> vec3f { return mix(AMB_HI_D, AMB_HI_N, ngt()); }
const TAU = 6.2831853;
const LOW = ${LV > 1};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn hs(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(40.)), 1.); }
// 0 inside the basin, 1 out of the smoke
fn hk(y: f32) -> f32 { return ss(CAN - 3., CAN + 1., y); }
// 1 at the level of the lava in this column, 0 LAVA_H metres above it
fn gk(p: vec3f) -> f32 { return ss(LAVA_H, -2., p.y - lavaY(p.xz)); }
// haze density at height y, and its optical depth along a ray (closed form of the exponential profile)
fn hzd(y: f32) -> f32 { return HZ0 * exp(-HZB * (clamp(y, -60., 40.) - FLR)); }
fn hzt(ro: vec3f, rd: vec3f, d: f32) -> f32 {
  let x = clamp(HZB * rd.y * d, -6., 80.);
  var f = 1. - .5 * x;
  if (abs(x) > .01) { f = (1. - exp(-x)) / x; }
  return hzd(ro.y) * d * f;
}
fn hazeCol(y: f32) -> vec3f { return mix(mix(hazeLo(), hazeMid(), ss(FLR, CAN - 2., y)), hazeHi(), ss(CAN - 1., CAN + 5., y)); }
fn skyCol(rd: vec3f, sun: vec3f) -> vec3f {
  let mu = max(dot(rd, sun), 0.);
  return mix(hazeHi() * 1.5, skyc() * 1.5, pow(sat(rd.y), .45)) + sunc() * pow(mu, 14.) * .3 + mix(SUNC_D * 30., MOON, ngt()) * pow(mu, 1200.);
}
`;

const S_B = S_G + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tW: texture_2d<f32>;
@group(0) @binding(6) var tD: texture_2d<f32>;
@group(0) @binding(7) var tV: texture_3d<f32>;
@group(0) @binding(8) var tM: texture_2d<f32>;
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z - .0007); }
fn shadow1(p: vec3f) -> f32 { let s = shUV(p); return textureSampleCompareLevel(tSh, sS, s.xy, s.z); }
fn shadow4(p: vec3f) -> f32 {
  let s = shUV(p); let e = 1.8 / ${SHADOW}.;
  return (textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, -e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, -e), s.z)
        + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, e), s.z)) * .25;
}
fn shadow9(p: vec3f) -> f32 {
  if (LOW) { return shadow1(p); }
  let s = shUV(p); let e = 2.1 / ${SHADOW}.; var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return a / 9.;
}
// r = openness (terrain), g = skylight: sky occlusion by the terrain itself, with nothing overhead to filter it
fn vol(p: vec3f) -> vec4f { return textureSampleLevel(tV, sC, (p - vec3f(-192., -56., -192.)) / vec3f(384., 60., 384.), 0.); }
// The forest's canopy mask and dappled floor light are gone: the sun is unoccluded by anything but geometry.
// caus() and sunE() below are therefore neutralised stubs, not dead code -- both are still called from W_SOLID,
// they just return a constant now. Same for zone() further down, and for PURPLE in world.js, which is parked
// far outside the world so main.js's zone blend always comes out 0.
fn caus(p: vec3f, d: f32) -> vec3f { return vec3f(1.); }
fn sunE(y: f32, z: f32) -> vec3f { return sunc(); }
// INVERTED. The light rises from the lava and dies with height and with distance. Three terms:
//   fill  basin-wide, orientation-free -- the lava you cannot see from here. Small.
//   near  the lava beside you, scaled by lv and by how the surface faces it
//   up    the bounce from below, dn * dn, scaled by lv: this is the term that lights overhangs and undersides
// lv is the baked lava light at p (0..1). ld.xy is the horizontal direction towards the lava (the uphill
// direction of that light) and ld.z how far to trust it (0 on the lava itself, where there is no direction).
// The near term is directional: rock facing the lava gets all of it, level ground half, rock facing away none --
// so the far side of the crater rim stays dark though it is as close to the lake as the near side.
fn amb(p: vec3f, n: vec3f, lv: f32, ld: vec3f) -> vec3f {
  let dn = sat(.5 - .5 * n.y);
  let up = sat(.5 + .5 * n.y);
  let gl = gk(p);  // named gl, not g: g is the uniform
  let face = mix(1., sat(.5 + .7 * dot(n.xz, ld.xy)), ld.z);
  let lava = LAVA_AMB * gl * (LAVA_FILL + lv * (LAVA_NEAR * face + LAVA_UP * dn * dn));
  let ash = mix(ambLo(), ambHi(), hk(p.y)) * (.35 + .65 * up * up);
  return lava + ash + vec3f(.003, .0025, .002);
}
fn zone(p: vec3f) -> f32 { return 0.; }
fn side(p: vec3f, n: vec3f, open: f32, z: f32) -> vec3f {
  return (LAVA_AMB * LAVA_FILL * .5 * gk(p) + mix(ambLo(), ambHi(), hk(p.y)) * .4) * open * (1. - abs(n.y)) * .5;
}
// the lava light at a point in the air: the ground map's b channel (square root stored), dying with height
fn glowAt(q: vec3f) -> f32 {
  let m = textureSampleLevel(tM, sC, q.xz / 384. + .5, 0.).b;
  // the plume: the smoke over the crater, lit from inside it. It starts at the rim and fades out 35 m up, so it
  // stands behind the near rim from any side and gives the cone a crater to be seen by.
  // A column of constant radius and constant strength projects to parallel vertical edges -- it reads as a
  // rectangle, not smoke. So the radius widens as it rises, the strength dissipates with height, the radial
  // falloff is wide rather than a hard wall, and two cheap sine terms break the outline. No fbm: glowAt runs
  // inside the fog tap loop, six times per ray.
  let hN = sat((q.y - (RIM_Y - 5.)) / 42.);
  let d = length(q.xz - VENT);
  let rad = RIM_R * (.5 + 1.9 * hN) * (1. + .22 * sin(q.y * .21 + d * .12) + .15 * sin(q.y * .37 - 2.1));
  let pl = PLUME * (1. - .55 * hN) * ss(rad, rad * .25, d) * ss(RIM_Y - 5., RIM_Y + 3., q.y) * ss(RIM_Y + 42., RIM_Y + 6., q.y);
  return m * m * ss(LAVA_H, 0., q.y - lavaY(q.xz)) + pl;
}
// What the lava adds to the smoke along a ray of length d. Six taps at the middles of the stretches 0-8, 8-18,
// 18-35, 35-58, 58-88 and 88-120 m, each weighted by the share of the in-scatter that comes from its stretch at
// the floor's extinction (HZ0 = .035 / m: .24 .22 .24 .16 .09 .03); the last two are raised a little, because a
// ray that climbs runs through thinner smoke and sees further -- that is what carries the glow over the crater
// down to a viewer on the basin floor.
fn hazeGlow(ro: vec3f, rd: vec3f, d: f32) -> vec3f {
  return HAZE_GLOW * (.24 * glowAt(ro + rd * min(d, 4.)) + .22 * glowAt(ro + rd * min(d, 13.)) + .24 * glowAt(ro + rd * min(d, 26.))
    + .16 * glowAt(ro + rd * min(d, 46.)) + .11 * glowAt(ro + rd * min(d, 72.)) + .06 * glowAt(ro + rd * min(d, 104.)));
}
// height haze: transmittance from the closed-form optical depth, in-scatter in the colour of the layer the ray runs through
fn fogD(c: vec3f, wp: vec3f, far: f32) -> vec3f {
  let v = wp - g.cam.xyz; let d = max(length(v), 1e-3); let rd = v / d;
  let T = exp(-hzt(g.cam.xyz, rd, d)) * ss(far, far * .8, d);
  let hm = g.cam.y + rd.y * min(d, mix(22., 70., sat(-rd.y * 3.)));
  // the smoke has a cold colour of its own (hazeCol) and glows only where the ray passes over lava (hazeGlow)
  let hc = hazeCol(hm) + hazeGlow(g.cam.xyz, rd, d);
  return c * T + hc * (1. - T);
}
fn fog(c: vec3f, wp: vec3f, z: f32) -> vec3f { return fogD(c, wp, FARD); }
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;

// ---------------------------------------------------------------- solid meshes (terrain, rocks, set pieces, basalt columns, spires, spatter cones)
const W_SOLID = S_B + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) on: vec3f,
  @location(4) @interpolate(flat) m: vec4f, @location(5) @interpolate(flat) q: vec4f, @location(6) ao: f32 };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  var sc = i.a.w;
  if (i.c.x < 1.5 && i.c.z > 1.5 && g.res.x > 0.) { sc *= 1. - ss(i.c.z * .7, i.c.z, distance(i.a.xyz, g.cam.xyz) / g.mis.z); }
  // Inherited distance fade for the props. With the current instance data it never fires: scatterProps (world.js)
  // writes c = (1, rnd(), 1, 0) for every column, spire and cone, and the terrain's identity instance has c.x = 0,
  // so neither this test nor the one above it is ever true. Left alone rather than cut: it costs two compares.
  if (i.c.x > 1.5 && g.res.x > 0.) { sc *= 1. - ss(FARD * .8, FARD, distance(i.a.xyz, g.cam.xyz)); }
  var w = i.a.xyz + qrot(i.b, i.p * sc);
  w.y += sin(g.cam.w * .3 + i.c.y * 40.) * i.c.w;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.b, i.n.xyz); o.op = i.p * i.a.w + i.c.y * 37.; o.on = i.n.xyz;
  o.m = i.c; o.q = i.b; o.ao = i.n.w;
  return o;
}
struct TP { h: f32, c: f32, n: vec3f };
fn tri(p: vec3f, n: vec3f, s: f32) -> TP {
  var w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  let x = textureSample(tD, sR, p.zy * s); let y = textureSample(tD, sR, p.xz * s); let z = textureSample(tD, sR, p.xy * s);
  var o: TP;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  let a = x.rg * 2. - 1.; let b = y.rg * 2. - 1.; let c = z.rg * 2. - 1.;
  o.n = vec3f(0., a.y, a.x) * w.x + vec3f(b.x, 0., b.y) * w.y + vec3f(c.x, c.y, 0.) * w.z;
  return o;
}
@fragment fn fs(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let mat = i32(i.m.x + .5); let sd = i.m.y; let fl_ = select(-1., 1., ff);
  let on = normalize(i.on) * fl_; let n0 = normalize(i.n) * fl_;
  let dist = length(i.wp - g.cam.xyz);
  let ts = select(1., i.m.z, mat >= 2);
  let A = tri(i.op, on, .1 * ts); let B = tri(i.op, on, .43 * ts); let C = tri(i.op, on, 1.9 * ts); let F = tri(i.op, on, 6.7 * ts); let fk = ss(10., 1.5, dist) * f32(mat <= 1);
  let Wd = textureSample(tD, sR, vec2f(i.op.x * .06, (i.op.y + i.op.z) * .7));
  let big = textureSample(tD, sR, i.op.xz * .013 + i.op.y * .021).a;
  let big2 = textureSample(tD, sR, i.op.zx * .031 + i.op.y * .043 + .37).a;
  var sgro = 0.;
  let sk = textureSample(tD, sR, vec2f((i.op.x + i.op.z) * .33, i.op.y * .035));
  let sk2 = textureSample(tD, sR, vec2f((i.op.x - i.op.z) * 1.1, i.op.y * .11));
  let gm = textureSample(tM, sC, i.wp.xz / 384. + .5);
  let hl = i.wp.y - lavaY(i.wp.xz);            // height above the lava surface in this column
  let ca = caus(i.wp, dist);
  let hgt = A.h * .5 + B.h * .35 + C.h * .15;
  var bump = 1.7; var gloss = .1; var alb = vec3f(0.); var emi = vec3f(0.); var vao = 1.; var flu = 0.;
  let flt = ss(.72, .93, n0.y);
  if (mat <= 1) {
    // basalt (columns, spires, cones, the basin walls): near-black beds with a rusty scoria band
    let st = i.op.y * .55 + A.h * 1.6 + big * 5. + big2 * 3.;
    let bed = hs(floor(st)); let sf = fract(st);
    alb = mix(vec3f(.025, .023, .024), vec3f(.085, .072, .066), sat(A.c * 1.5 - .25));
    alb = mix(alb, mix(vec3f(.075, .040, .022), vec3f(.045, .042, .040), bed), ss(.42, .66, big) * .7);
    alb *= mix(.72, 1.15, bed) * (1. - .45 * ss(.12, .0, sf) * (1. - abs(on.y)));
    alb = mix(alb, vec3f(.11, .105, .10) * (.5 + .7 * C.h), ss(.60, .70, B.c * .6 + C.c * .5) * .45);
    alb *= (.22 + 1.3 * hgt) * mix(1., .62 + .76 * F.h, fk);
    sgro = -ss(.14, .0, sf) * (1. - abs(on.y)) * 1.2;
    if (mat == 0) {
      // basin floor on the level parts: cooled crust plates (gm.a) under a grey ash dusting (gm.r)
      var fo = mix(vec3f(.020, .017, .016), vec3f(.055, .044, .038), B.h);
      fo = mix(fo, mix(vec3f(.070, .036, .018), vec3f(.095, .058, .026), C.c) * (.5 + .8 * C.h), ss(.30, .52, B.c * .6 + big2 * .5));
      fo = mix(fo, vec3f(.090, .084, .080) * (.5 + .9 * B.h), sat(gm.r * 1.2 - .45 + (B.c - .5) * 1.2) * .55);
      fo = mix(fo, vec3f(.014, .012, .012), gm.a * .6 * ss(.55, .35, A.h));
      alb = mix(alb, fo * (.55 + .7 * hgt) * mix(1., .62 + .76 * F.h, fk), flt);
      gloss = mix(gloss, .22, flt * gm.a * ss(.55, .35, A.h));
    }
    // rock darkens with height above the lava in its column: the mesas and the basin wall end as silhouettes
    // against the ash sky, while the cone, whose lava climbs with it, keeps its colour to the rim
    alb *= mix(1., .3, ss(5., 26., hl));
  }
  // --- the lava light at this spot, and which way it comes from (two more taps of the ground map, 2 m off)
  let lvf = gm.b * gm.b;
  let lg = vec2f(textureSample(tM, sC, i.wp.xz / 384. + .5 + vec2f(2. / 384., 0.)).b, textureSample(tM, sC, i.wp.xz / 384. + .5 + vec2f(0., 2. / 384.)).b) - gm.b;
  let lgl = length(lg);
  let ld = vec3f(lg / max(lgl, 1e-4), sat(lgl * 40.));
  // --- molten lava: the flat slab dens() fills the crater and the channel with. gm.g is its heat: 0 at its edge,
  // 1 in the core of the river, about a half where it stands in the lake and the pond (heatAt in world.js).
  // hl gates it to the lava surface itself, so rock bridging the flow does not glow.
  let onl = ss(.02, .12, gm.g) * ss(.9, .45, hl) * f32(mat == 0);
  // two layers of the detail height drifting against each other: where the sum is high the surface has crusted
  let hn = textureSample(tD, sR, i.wp.xz * .085 + g.cam.w * vec2f(.0040, .0065)).b * .6 + textureSample(tD, sR, i.wp.zx * .27 - g.cam.w * vec2f(.0070, .0030)).b * .4;
  let crust = ss(.50, .70, hn) * mix(1.2, .85, gm.g);
  let pul = .78 + .22 * sin(g.cam.w * .85 + big * 21. + big2 * 9.);
  // temperature: white-hot only in the core of the flow and over the vent, crusting over towards the banks and
  // where the lava stands; the crust is split by hot cracks (they lift it, they do not add to open lava)
  let tl = sat(gm.g * 1.25 + .1 - crust * (1. - .4 * (1. - ss(LAVA_V0, LAVA_V1, C.h)))) * onl * (.86 + .14 * pul);
  // --- glowing cracks in the rock beside the lava: the veins are the lows of the detail texture's own height,
  // so they follow the rock. Only close to the flow, near its level and on near-level rock; cooler than the flow.
  let vein = (1. - ss(LAVA_V0, LAVA_V1, B.h)) * .8 + (1. - ss(LAVA_V0, LAVA_V1, C.h)) * .55;
  let crk = sat(ss(LAVA_CRK0, LAVA_CRK1, lvf) * vein) * ss(8., 2., hl) * ss(.42, .80, n0.y) * f32(mat == 0) * (1. - onl);
  emi = lavaCol(tl) + lavaCol(.2 + .42 * crk) * crk * pul;
  // the crust itself is black: almost no albedo, and (below) no sheen, or the lava's own light would paint it red
  alb = mix(alb, vec3f(.004, .003, .003), onl) * (1. - .75 * crk);
  let rip = 0.;
  let N = normalize(qrot(i.q, normalize(on + (A.n * .85 + B.n * .65 + C.n * .45 * ss(60., 12., dist) + F.n * .5 * fk) * bump + vec3f(.8, sgro, .35) * vec3f(rip, 1., rip))));
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let v1 = vol(i.wp + n0 * 1.5); let v2 = vol(i.wp + n0 * 4.5);
  let ao = (sat((v1.r - .5) * 8.) * .55 + sat((v2.r - .5) * 2.7) * .45) * vao * ss(.12, .6, hgt);
  let z = zone(i.wp);
  let E = sunE(i.wp.y, z) * shadow9(i.wp + n0 * .35);
  let ndl = sat(dot(N, L));
  let am = (amb(i.wp, N, lvf, ld) + side(i.wp, N, sat((v2.r - .5) * 2.7), z)) * ao;
  // ca comes from caus(), which is stubbed to a constant 1: the sun reaches everything geometry does not shadow
  let dl = E * ndl * (.012 + mix(vec3f(.12), ca, ss(.1, .45, dot(n0, L))) * 1.6);
  var c = alb * (dl + am) + emi + alb * flu * dot(dl + am, vec3f(.1, .5, .5));
  let H = normalize(V + L);
  c += E * ca * pow(sat(dot(N, H)), mix(10., 70., gloss)) * gloss * ndl * 1.8;
  c += (amb(i.wp, reflect(-V, N), lvf, ld) + side(i.wp, reflect(-V, N), sat((v2.r - .5) * 2.7), z)) * ao * (.08 + gloss) * LAVA_SHEEN * (1. - onl) * pow(1. - sat(dot(N, V)), 2.5);
  return fin(fog(c, i.wp, z));
}
`;


// ---------------------------------------------------------------- sky backdrop seen through the haze
const W_SURF = S_B + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f };
// behind everything: the sky seen through the smoke (bright above the ash ceiling, smoke-coloured below)
@vertex fn vsB(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = g.cam.xyz + g.fwd.xyz + g.right.xyz * (p.x * g.right.w) + g.up.xyz * (p.y * g.up.w);
  o.cp = vec4f(p, 1e-7, 1.);
  return o;
}
// ---- stars: everything worth tuning is here
const ST_N = 90.;                            // grid cells from the zenith to the horizon (about 25000 cells in the sky)
const ST_FILL = .16;                         // share of the cells that hold a star
const ST_GAIN = 5.;                          // brightest star (HDR); most are far dimmer
const ST_PX = 1.3;                           // smallest radius in pixels, so a star never falls between them
fn h22(p: vec2f) -> vec2f { var q = fract(p.xyx * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
// One hashed point per cell of a stereographic map of the upper hemisphere (conformal: stars stay round, and
// 1 + rd.y >= 1 so nothing divides by zero). rd.y > 0 only.
fn stars(rd: vec3f) -> vec3f {
  let k = ST_N / (1. + rd.y);
  let p = rd.xz * k; let c = floor(p);
  let h = h22(c); let h2 = h22(c + 71.3);
  if (h2.x > ST_FILL) { return vec3f(0.); }
  // radius: at least ST_PX pixels of the render target (g.up.w = tan of half the view, g.res.w = 1 / height)
  let r = min(max(.0011, ST_PX * 2. * g.up.w * g.res.w) * k, .15);
  let v = (p - c - (.15 + .7 * h)) / r;
  let b = h2.x / ST_FILL;
  let tw = .75 + .25 * sin(g.cam.w * (1.5 + 4. * h2.y) + h.x * 90.);
  return mix(vec3f(.65, .78, 1.), vec3f(1., .9, .72), h.y) * (ST_GAIN * (.06 + .94 * b * b * b * b) * tw * exp(0. - dot(v, v) * 2.5) * ss(0., .1, rd.y));
}
@fragment fn fsB(i: VO) -> @location(0) vec4f {
  let rd = normalize(i.wp - g.cam.xyz);
  let T = exp(-hzt(g.cam.xyz, rd, 900.));
  let hm = g.cam.y + rd.y * mix(22., 70., sat(-rd.y * 3.));
  let hc = hazeCol(hm) + hazeGlow(g.cam.xyz, rd, 900.);  // as in fogD
  var sk = skyCol(rd, g.sun.xyz);
  // night only, and only above the horizon: by day this costs one branch
  if (ngt() > 0. && rd.y > 0.) { sk += stars(rd) * ngt() * ngt(); }
  return fin(sk * T + hc * (1. - T));
}
`;


// ---------------------------------------------------------------- embers and ash motes, rising
// Fully procedural from @builtin(instance_index): no instance buffer, no vertex layout, nothing for main.js to keep
// in sync. Camera-relative: the field wraps around the camera in XZ, so a constant count covers any view.
// Additive, depth-tested but not depth-writing, so rock in front still hides them.
const W_MOTE = S_B + /*wgsl*/`
// ---- embers: everything worth tuning is here
const M_BOX = 112.;                          // width of the wrapping field in metres
const M_H = 46.;                             // how high an ember climbs before it is reborn at the floor
const M_UP = 2.2;                            // climb speed (m/s)
const M_R = .055;                            // ember radius in metres
const M_PX = 1.1;                            // smallest radius in pixels, so a distant ember never flickers out
const M_WOB = 2.6;                           // sideways wander by the top of the climb (m)
const M_C = vec3f(7.5, 1.55, .16);           // ember colour (HDR: the bloom chain picks it up)
const M_ASH = vec3f(.30, .27, .26);          // the dull ash flakes mixed in among them
const M_COLD = .06;                          // how much of an ember's heat is left where no lava light reaches
fn mh3(n: f32) -> vec3f { var p = fract(vec3f(n) * vec3f(.1031, .1030, .0973)); p += dot(p, p.yzx + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
struct MO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) wp: vec3f, @location(2) @interpolate(flat) col: vec3f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MO {
  var o: MO;
  let f = f32(ii);
  let a = mh3(f + 1.5); let b = mh3(f * 1.37 + 91.3);
  // wrap the mote's fixed grid position into the box centred on the camera
  let bx = (a.x - .5) * M_BOX; let bz = (a.y - .5) * M_BOX;
  let px = bx - M_BOX * floor((bx - g.cam.x) / M_BOX + .5);
  let pz = bz - M_BOX * floor((bz - g.cam.z) / M_BOX + .5);
  // rise: each mote runs its own loop up through M_H and starts again at the level of the lava in its column
  // (the lake in the crater, the river on the floor)
  let t = fract(g.cam.w * M_UP * (.7 + .6 * b.x) / M_H + a.z);
  let y = lavaY(vec2f(px, pz)) - 1.5 + a.z * 4. + t * M_H;
  // the baked lava light under the mote: embers are thrown up by lava, so away from it only ash flakes rise
  let src = textureSampleLevel(tM, sC, vec2f(px, pz) / 384. + .5, 0.).b;
  let wob = vec2f(sin(g.cam.w * .7 + f * 2.1), cos(g.cam.w * .55 + f * 3.3)) * (M_WOB * t);
  let wp = vec3f(px + wob.x, y, pz + wob.y);
  // ash flakes are the dim majority; embers are the hot minority, and they cool as they climb
  let ash = step(.34, b.y);
  let hot = (1. - t) * (1. - t) * (.35 + .65 * b.z) * (.6 + .4 * sin(g.cam.w * (7. + 11. * b.z) + f)) * (M_COLD + (1. - M_COLD) * src * src);
  o.col = mix(M_C * max(hot, 0.), M_ASH * (.25 + .75 * b.z), ash);
  let d = max(distance(wp, g.cam.xyz), .05);
  let r = max(M_R * (.55 + .9 * b.x), M_PX * 2. * g.up.w * g.res.w * d);
  let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.;
  o.wp = wp;
  o.uv = q;
  o.cp = g.vp * vec4f(wp + (g.right.xyz * q.x + g.up.xyz * q.y) * r, 1.);
  return o;
}
@fragment fn fs(i: MO) -> @location(0) vec4f {
  let d2 = dot(i.uv, i.uv);
  if (d2 > 1.) { discard; }
  let v = i.wp - g.cam.xyz; let d = max(length(v), 1e-3);
  // the smoke between the camera and the mote eats it, the same way geometry fades
  let T = exp(0. - hzt(g.cam.xyz, v / d, d)) * ss(FARD, FARD * .7, d);
  return fin(i.col * (exp(0. - d2 * 3.4) * T));
}
`;

// ---------------------------------------------------------------- final composite
const W_POST = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
const BLOOM_MIX = .025;                      // share of the picture replaced by the bloom
const BLOOM_ADD = .012;                      // bloom added on top
fn tmap(x: vec3f) -> vec3f { return sat3((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14)); }
fn sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.), vec3f(1.)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let uv = fc.xy * g.res.zw;
  var c = textureLoad(tS, px, 0).rgb;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  // bl is the SUM of the six bloom levels, so a wide even field of radiance L adds 6 L times these weights. They
  // were .06 and .03 (+54% of L) when the lava was hairline cracks; with a river and a lake in frame that buried
  // the black crust and every silhouette in front of the lava. Now +22%.
  c = mix(c, bl, BLOOM_MIX) + bl * BLOOM_ADD;
  c *= g.mis.x;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .55;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .55);
  c *= l / max(l0, 1e-4);
  c = mix(c, vec3f(l), ss(.55, 1., l) * .1);
  // the lift under black: was (.008, .002, 0), a red floor of sRGB .11 under every pixel
  c = mix(vec3f(l), c, .93) + mix(vec3f(.0035, .002, .0015), vec3f(.001, .002, .004), g.mis.w);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;

// ---------------------------------------------------------------- the rift: a doorway that leads to the forest
// It was a seam of light on a camera-facing quad; it is now a door standing at RIFT (THE DOOR, below), and through
// its opening the other world is seen. RIFT and the three numbers under it are what main.js navigates by.
// On the east bank of the river, 19 m ahead of viewpoint 1 (the start) and to the right of its line of sight:
// 7 m clear of the lava, on the strip CLEARS keeps free of terraces, 17 m from the nearest outcrop.
// main.js stands it on the ground under it (RIFT[1]) and only then compiles this, which is why it is a function.
const RIFT = [51, -44.4, 52];              // centre: x, y (set at load: the ground + RIFT_UP), z
const RIFT_UP = 3.6;                         // height of the centre above the ground: of the trigger volume, that is
const RIFT_HW = 2.6, RIFT_HH = 5;            // RIFT_HH: half-height of the trigger volume (m). RIFT_HW: unused since the door
const rfN = (v) => '(' + v.toFixed(2) + ')'; // a WGSL float literal, in brackets: the minifier would join "a - -b"
const rfV = (v) => '(' + v.toFixed(5) + ')'; // the same, fine enough for a unit vector
// THE DOOR: what is drawn at RIFT. A flat rectangular opening standing on the ground, fixed in the world (it does
// not turn to the camera): DOOR_HW x DOOR_H is the opening, and its normal points from RIFT at DOOR_AT, which is
// viewpoint 1, so the visitor who starts there sees it square on. It can be walked round, and is a way through
// from both faces. RIFT_HW, RIFT_HH and RIFT_UP above are no longer drawn: they are the trigger volume and the
// arrival height main.js uses, and stay as they were.
const DOOR_HW = 2, DOOR_H = 6.6;             // half-width and height of the opening (m)
const DOOR_SINK = .6;                        // how far the quad goes on below the ground, so no slope shows under it
const DOOR_AT = [47, 71];                    // x, z of the point the door faces: viewpoint 1 (POSES[0] in main.js)
const doorN = () => { const x = DOOR_AT[0] - RIFT[0], z = DOOR_AT[1] - RIFT[2], l = Math.hypot(x, z) || 1; return [x / l, z / l]; };
// One draw of 4 instances, no vertex or instance buffer: instance 0 is the opening, 1-3 are the two jambs and the
// lintel, each a thin strip turned to the camera about its own axis -- so the door is still a line of light when it
// is seen edge-on and the opening has no width at all. Alpha-blended (premultiplied) and depth-WRITING: it is a
// window, not a light. What the opening shows is the other world, built from nothing but the view ray:
//   the ray from the eye through the fragment is taken into the door's own frame (x along the door, y up, z into
//   it) and traced into an imaginary space behind the opening. Every part of that space is found by intersecting
//   the ray with something: the far background with nothing (direction alone, like a sky), the floor with the plane
//   y = 0, each row of silhouettes with a plane z = its depth. A point at depth z is seen at o + k z, where o is
//   the fragment's place in the opening and k the slope of the ray, so near rows slide across the opening faster
//   than far ones as the eye moves, and the far background only turns: the parallax of a real window.
// Everything moves as a closed form of g.cam.w, so the CPU does nothing per frame.
const W_RIFT = () => S_B + /*wgsl*/`
const RF_B = vec3f(${rfN(RIFT[0])}, ${rfN(RIFT[1] - RIFT_UP)}, ${rfN(RIFT[2])});   // middle of the threshold, on the ground
const RF_N = vec3f(${rfV(doorN()[0])}, 0., ${rfV(doorN()[1])});                    // the way the door faces
const RF_R = vec3f(${rfV(doorN()[1])}, 0., ${rfV(-doorN()[0])});                   // along the door
const RF_HW = ${rfN(DOOR_HW)};
const RF_H = ${rfN(DOOR_H)};
const RF_SINK = ${rfN(DOOR_SINK)};
const RF_RIMW = .07;                         // half-width of the edge strips (m); never under 1.5 pixels
const RF_SOLID = 1.;                         // opacity of the view in the opening: under 1 the real scene shows through it
const RF_HAZE = .25;                         // share of the host world's haze the door suffers (1 = like a lit surface)
fn rfh(n: f32) -> f32 { return fract(sin(n * 127.1 + 3.7) * 43758.5453); }
fn rfh2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn rfvn(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(rfh2(i), rfh2(i + vec2f(1., 0.)), u.x), mix(rfh2(i + vec2f(0., 1.)), rfh2(i + vec2f(1., 1.)), u.x), u.y);
}
fn rffb(p: vec2f) -> f32 { return .55 * rfvn(p) + .3 * rfvn(p * 2.1 + 7.) + .15 * rfvn(p * 4.3 + 19.); }
// sparks or pollen on the plane at depth z: one point to a cell, drifting by dv, each with its own twinkle
fn rfDot(o: vec2f, k: vec2f, m: vec3f, z: f32, sc: f32, dv: vec2f, r: f32) -> f32 {
  let p = (o + k * z) * sc + dv;
  let id = floor(p); let f = fract(p) - .5;
  let q = f - (vec2f(rfh2(id), rfh2(id + 5.3)) - .5) * .7;
  let aa = m.z * (m.y + z / m.x) * sc;
  let tw = .5 + .5 * sin(g.cam.w * (1. + 2. * rfh2(id + 9.1)) + 6.28 * rfh2(id + 2.7));
  return (1. - ss(r, r + aa + .004, length(q))) * tw * step(.45, rfh2(id + 1.9)) * min(1., r / (aa + 1e-4));
}
// ---- the other side: the rainforest. Green light filtered by the canopy, trunks going back into the haze, a shaft
// of sun, a dim floor. No orange anywhere: against the lava it is the one cool, dark, green thing in the basin.
const RF_RIM = vec3f(.42, .8, .5);           // the edge strips: pale leaf green, under 1: an edge, not a light
const RF_HZ = vec3f(.19, .32, .11);          // the haze every distance fades into
const RF_FD = .05;                           // its extinction per metre
// one row of trees on the plane at depth z, laid over c. m = (ray z, eye-to-door distance, angle of a pixel)
fn rfRow(c: vec3f, o: vec2f, k: vec2f, m: vec3f, z: f32, sd: f32) -> vec3f {
  let p = o + k * z;
  if (p.y < 0.) { return c; }
  let aa = m.z * (m.y + z / m.x) / m.x + .002;
  let sp = 2.3 + 1.6 * rfh(sd);
  let u = p.x / sp + sd * 13.7;
  let id = floor(u);
  let h = rfh(id * 1.31 + sd * 57.);
  // the trunk: 30 to 90 cm through, flaring into buttresses at the foot
  let r = (.15 + .3 * rfh(id + sd * 91.)) * (1. + .9 * exp(-p.y * 1.1));
  let cx = (fract(u) - .5 - (h - .5) * .4) * sp;
  let tm = step(.3, h) * (1. - ss(r - aa, r + aa, abs(cx)));
  let sh = .5 + .5 * clamp(cx / r, -1., 1.);
  var col = mix(vec3f(.012, .016, .008), vec3f(.075, .105, .035), sh * sh) * (.7 + .3 * ss(0., 6., p.y));
  // undergrowth along its foot: a ragged line of fern
  let bh = .3 + .9 * rfvn(vec2f(p.x * .9 + sd * 31., sd)) + .25 * rfvn(vec2f(p.x * 4.1, sd + 3.));
  let bm = 1. - ss(bh - aa - .03, bh + aa + .03, p.y);
  col = mix(col, vec3f(.02, .05, .012) * (.5 + .9 * sat(p.y / bh)), bm);
  return mix(c, mix(RF_HZ, col, exp(-RF_FD * z / m.x)), max(tm, bm));
}
fn rfIn(o: vec2f, k: vec2f, ez: f32, dc: f32, t: f32) -> vec3f {
  let m = vec3f(ez, dc, 2. * g.up.w / max(g.res.y, 1.));
  // FAR, by direction alone: the haze, brightest a little above eye level, with the ghosts of the furthest trunks
  var c = RF_HZ * (.5 + .8 * exp(-abs(k.y - .12) * 3.5));
  c *= 1. - .3 * ss(.5, .72, rfvn(vec2f(k.x * 34., 2.))) * ss(.9, .1, abs(k.y));
  if (k.y > .001) {
    // the canopy: a ceiling 13 m up, dark leaves with holes of sky in them that drift a little
    let zc = min((13. - o.y) / k.y, 300.);
    let cp = vec2f(o.x + k.x * zc, zc);
    let hole = ss(.56, .7, rffb(cp * .22 + vec2f(.03 * t, 0.)));
    let leaf = vec3f(.018, .05, .014) * (.5 + rfvn(cp * 1.3));
    c = mix(c, mix(leaf, vec3f(.8, 1.1, .5), hole), exp(-RF_FD * .7 * zc / ez));
  } else if (k.y < -.001) {
    // the floor: litter and moss, flecks of sun, and the pool of light where the shaft lands
    let zf = min(o.y / (-k.y), 300.);
    let fp = vec2f(o.x + k.x * zf, zf);
    var fc = mix(vec3f(.014, .02, .009), vec3f(.035, .06, .02), rffb(fp * .35));
    fc += vec3f(.42, .45, .18) * ss(.62, .8, rffb(fp * .5 + 11.));
    let dq = fp - vec2f(1.2, 9.);
    fc += vec3f(1., .95, .5) * exp(-dot(dq, dq) / 2.2);
    c = mix(c, fc, exp(-RF_FD * zf / ez));
  }
  c = rfRow(c, o, k, m, 34., 5.);
  c = rfRow(c, o, k, m, 22., 4.);
  c = rfRow(c, o, k, m, 14., 3.);
  // the shaft of sun: a slanting slab of lit haze 9 m in, between the rows, breathing
  let ps = o + k * 9.;
  let b = ps.x - 1.2 + ps.y * .32;
  let sI = exp(-b * b / .8) * ss(-.3, .6, ps.y) * (.75 + .25 * sin(t * .6 + ps.y * .7)) * (.65 + .35 * rfvn(vec2f(b * 3., ps.y * .4 - t * .15)));
  c += vec3f(.7, .66, .34) * sI * exp(-RF_FD * 9. / ez);
  c = rfRow(c, o, k, m, 8., 2.);
  c += vec3f(.5, .6, .3) * rfDot(o, k, m, 6., 1.3, vec2f(.15 * sin(t * .3), .05 * t), .03) * exp(-RF_FD * 6. / ez);
  c = rfRow(c, o, k, m, 4.5, 1.);
  return c;
}
struct RFO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) wp: vec3f, @location(2) @interpolate(flat) k: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RFO {
  var o: RFO;
  let q = vec2f(f32(vi & 1u), f32(vi >> 1u));
  var wp: vec3f;
  if (ii == 0u) {
    // the opening: fixed in the world. uv = metres along the door and above the ground
    let l = vec2f((q.x * 2. - 1.) * RF_HW, mix(-RF_SINK, RF_H, q.y));
    wp = RF_B + RF_R * l.x + vec3f(0., l.y, 0.);
    o.uv = l; o.k = 0.;
  } else {
    // a jamb (1, 2) or the lintel (3): a strip along the segment a-b, turned to the camera about that segment
    var a = vec2f(-RF_HW, -RF_SINK); var b = vec2f(-RF_HW, RF_H);
    if (ii == 2u) { a.x = RF_HW; b.x = RF_HW; }
    if (ii == 3u) { a.y = RF_H; b.x = RF_HW; }
    let wa = RF_B + RF_R * a.x + vec3f(0., a.y, 0.);
    let wb = RF_B + RF_R * b.x + vec3f(0., b.y, 0.);
    let ax = normalize(wb - wa);
    let p = mix(wa, wb, q.y);
    let tc = g.cam.xyz - p; let dc = max(length(tc), 1e-3); let to = tc / dc;
    let hw = max(RF_RIMW, dc * 3. * g.up.w / max(g.res.y, 1.));
    let cr = cross(ax, to); let sd = cr / max(length(cr), 1e-4);
    // 8 cm towards the eye: in front of the opening it frames, which has written its depth
    wp = p + ax * ((q.y * 2. - 1.) * hw) + sd * ((q.x * 2. - 1.) * hw) + to * min(.08, dc * .3);
    o.uv = vec2f(q.x * 2. - 1., q.y); o.k = 1.;
  }
  o.wp = wp;
  o.cp = g.vp * vec4f(wp, 1.);
  return o;
}
@fragment fn fs(i: RFO) -> @location(0) vec4f {
  let v = i.wp - g.cam.xyz; let d = max(length(v), 1e-3); let rd = v / d;
  var c = RF_RIM; var a = 1.;
  if (i.k > .5) {
    // the edge: brightest along its middle, gone at its sides
    a = 1. - i.uv.x * i.uv.x; a *= a;
  } else {
    // which face is the eye on? Seen from behind, the door's frame is turned half round, so both faces are ways in
    let s = select(-1., 1., dot(g.cam.xyz - RF_B, RF_N) >= 0.);
    // the view ray in the door's frame, z into the door. Never quite along the door: at a grazing angle the
    // path to every depth is long, and the haze of the other world takes it all
    let ez = max(-s * dot(rd, RF_N), .04);
    let k = vec2f(s * dot(rd, RF_R), rd.y) / ez;
    c = rfIn(vec2f(s * i.uv.x, max(i.uv.y, 0.)), k, ez, d, g.cam.w);
    // the reveal: the view darkens into the frame, which gives the opening an edge of its own
    c *= .6 + .4 * ss(0., .45, min(RF_HW - abs(i.uv.x), RF_H - i.uv.y));
    a = RF_SOLID;
  }
  // the haze of THIS world between the eye and the door: part of it close by, all of it far off
  c = mix(c, fogD(c, i.wp, FARD), mix(RF_HAZE, 1., ss(40., 110., d)));
  c = min(max(c, vec3f(0.)), vec3f(40.));
  return vec4f(c * a, a);
}
`;
