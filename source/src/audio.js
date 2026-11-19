// ============================================================================
// audio: procedural volcanic ambience (no sample files)
// ============================================================================
// A fixed Web Audio graph, built on the first click / key / touch and driven by a 10 Hz timer, not the frame loop.
// Layers: a deep rumble bed, a sub-bass tremor under it, the roar and hiss of the lava (both louder the nearer
// the camera is to it and the lower it is in the basin), crackle off the cooling crust, and distant booms.
// Everything is noise and oscillators: no sample files, and nothing is created after the graph is built -- the
// timer only moves gains, filter frequencies and envelopes on nodes that already exist.
// This file shares one scope with the renderer, so a throw here would take the scene down and not just the
// sound. Every entry point therefore swallows its own errors, and the graph is built inside a try as well.
let AC, OUT, muted = false;
const VOL = 0.78; // master level, ahead of the limiter
function mkSound(ac) {
  const sr = ac.sampleRate;
  // node of class C with options o, connected to every node / param in `to`; sources start at once
  const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, G(depth, to));
  const noise = (secs, f) => { const n = sr * secs | 0, b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); f(b.getChannelData(0), n); f(b.getChannelData(1), n); return b; };
  // seamless brown noise loop (the end cross-fades into the start)
  const nb = noise(11, (d, n) => { for (let i = 0, b = 0; i < n + 4096; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; if (i < n) d[i] = b * 3.5; else { const k = (i - n) / 4096; d[i - n] = d[i - n] * k + b * 3.5 * (1 - k); } } });
  // reverb impulse: 5 s of noise that fades out and gets darker. A crater is a hard, enclosing room, so the
  // booms and the crackle are the only things sent to it in any quantity.
  const ir = noise(5, (d, n) => { for (let i = 0, b = 0; i < n; i++) { const t = i / sr; b += (rnd() * 2 - 1 - b) * (0.04 + 0.5 * exp(-t * 2)); d[i] = b * (1 - exp(-t * 30)) * exp(-t * 1.5) * (1 - i / n); } });

  const lim = N(DynamicsCompressorNode, { threshold: -6, knee: 6, ratio: 20, attack: 0.003, release: 0.3 }, ac.destination);
  const out = OUT = G(0, lim), wet = N(ConvolverNode, { buffer: ir }, out);
  const src = (playbackRate, ...to) => N(AudioBufferSourceNode, { buffer: nb, loop: true, playbackRate }, ...to);
  // rumble: the bed the whole scene sits on, always there, breathing on two slow LFOs
  const rum = G(0.34, out); src(1, BQ('lowpass', 150, 0.7, rum)); lfo(0.07, 0.11, rum.gain); lfo(0.113, 0.08, rum.gain);
  // tremor: two pairs of detuned low sines. The pairs beat against each other every few seconds, which is what
  // makes the ground feel like it is moving rather than just being loud.
  const sub = G(1, out);
  [29, 43.5].forEach((f, i) => { const g = G(0.055 - i * 0.022, sub); N(OscillatorNode, { frequency: f }, g); N(OscillatorNode, { frequency: f + rr(0.05, 0.15) }, g); });
  // the lava itself, in two bands off the same noise played at different speeds so the loops never line up:
  // roar is the body of the flow, hiss the gas coming off the crust. Both follow the camera (see the timer).
  const roar = G(0, out), roarM = G(1, roar), roarF = BQ('bandpass', 420, 0.8, roarM);
  src(0.71, roarF); lfo(0.047, 0.26, roarM.gain); lfo(0.083, 0.19, roarM.gain);
  const hiss = G(0, out), hissM = G(1, hiss), hissF = BQ('bandpass', 2400, 0.55, hissM);
  src(1.31, hissF); lfo(0.067, 0.22, hissM.gain); lfo(0.104, 0.16, hissM.gain);
  // pooled voices for the things that happen rather than hold: each is its own noise source through its own
  // filter and envelope, all built once here. The timer opens an envelope; it never makes a node.
  const pool = (n, send, type, frequency, Q) => Array.from({ length: n }, () => {
    const p = N(StereoPannerNode, {}, out, G(send, wet)), g = G(0, p), f = BQ(type, frequency, Q, g);
    src(rr(0.8, 1.25), f);
    return { p, g, f };
  });
  const crk = pool(6, 0.25, 'bandpass', 1500, 2.2); // crust crackle: short, bright, close
  const bom = pool(2, 1.6, 'lowpass', 90, 0.8);     // distant booms: long, dark, drenched in the crater
  // one hit on a voice: the filter moves to f, the level rises to vol over att, then decays with time constant
  // tau. Linear ramps and setTargetAtTime only -- an exponential ramp to zero throws, and these all end at zero.
  const hit = (vs, t, f, vol, att, tau, pan) => {
    const v = vs.shift(); vs.push(v);
    v.p.pan.setValueAtTime(pan, t);
    v.f.frequency.setValueAtTime(f, t);
    const g = v.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t); g.linearRampToValueAtTime(vol, t + att); g.setTargetAtTime(0, t + att, tau);
  };
  let lt = ac.currentTime, tC = lt + 1, tB = lt + 9;
  out.gain.setTargetAtTime(VOL, lt, 1);
  return () => {
    const now = ac.currentTime, t = now + 0.05;
    if (now <= lt) return;
    lt = now;
    // how near the camera is to lava, and how high it is. lavaAt (world.js) is metres inside the lava (> 0) and
    // metres outside it (< 0); it is pure arithmetic over the river, the lake and the pond, so it is safe to call
    // every tick. Guarded, because a non-finite value reaching an AudioParam throws.
    let d = -1e3, y = -48;
    const cx = F[CX], cy = F[CY], cz = F[CZ];
    if (isFinite(cx) && isFinite(cy) && isFinite(cz)) {
      y = cy;
      const a = lavaAt(cx, cz);
      if (isFinite(a)) d = a;
    }
    // near: 1 standing over the lava, 0 about 30 m clear of it. hi: 0 on the basin floor, 1 at the camera ceiling.
    // Climbing out of the basin thins the lava down without silencing it, so height reads as distance.
    const near = clamp(1 + d / 30, 0, 1), hi = clamp((y + 48) / 50, 0, 1), prox = near * (1 - 0.6 * hi);
    roar.gain.setTargetAtTime(0.09 + 0.2 * prox, t, 0.5);
    roarF.frequency.setValueAtTime(360 + 220 * prox, t);
    hiss.gain.setTargetAtTime(0.03 + 0.13 * prox, t, 0.4);
    hissF.frequency.setValueAtTime(1800 + 1700 * near, t);
    // crackle: a burst of 1-4 pops, closer together and louder the nearer the lava is
    if (t > tC) {
      let tt = t;
      for (let n = 1 + (rnd() * rnd() * 4 | 0); n--;) {
        hit(crk, tt, rr(700, 3200), rr(0.05, 0.16) * (0.25 + 0.75 * prox), 0.004, rr(0.02, 0.07), rr(-0.8, 0.8));
        tt += rr(0.02, 0.13);
      }
      tC = tt + rr(0.25, 2.2) * (1.6 - prox);
    }
    // a boom from the vent, now and then, sometimes answered by a second one
    if (t > tB) {
      let tt = t;
      for (let n = rnd() < 0.3 ? 2 : 1; n--;) {
        hit(bom, tt, rr(55, 110), rr(0.5, 1), 0.05, rr(0.45, 0.9), rr(-0.5, 0.5));
        tt += rr(0.7, 1.6);
      }
      tB = tt + rr(14, 42);
    }
  };
}
// called on every click / key / touch: builds the graph once and resumes it when the browser allows.
// A failure here must cost the sound and nothing else, so it is reported once and then the timer stops --
// swallowing it silently ten times a second would hide the one thing worth knowing about.
function sound() {
  try {
    if (!AC) {
      AC = new AudioContext({ latencyHint: 'playback' });
      const t = mkSound(AC);
      const id = setInterval(() => {
        try { t(); } catch (e) { clearInterval(id); console.warn('audio: the ambience timer stopped', e); }
      }, 100);
    }
    if (AC.state === 'suspended' && !document.hidden) { const p = AC.resume(); if (p && p.catch) p.catch(() => 0); }
  } catch (e) {
    // OUT doubles as the sentinel: 0 is falsy, so mute() keeps no-opping and this only warns once.
    if (OUT === undefined) { OUT = 0; console.warn('audio: no sound this session', e); }
  }
}
// M. A no-op until the graph exists, so an early key press or a failed build cannot throw on OUT.
const mute = () => { try { if (!OUT) return; muted = !muted; OUT.gain.setTargetAtTime(muted ? 0 : VOL, AC.currentTime, 0.08); } catch {} };
document.addEventListener('visibilitychange', () => { try { if (AC) { const p = document.hidden ? AC.suspend() : AC.resume(); if (p && p.catch) p.catch(() => 0); } } catch {} });
