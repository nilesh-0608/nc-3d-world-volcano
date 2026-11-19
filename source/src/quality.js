// ============================================================================
// quality level, chosen before anything is built
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low. Medium and Low thin out the ember motes (MOTEN in main.js) and bake a smaller
// shadow map; Low also drops anti-aliasing, drops mesh anisotropy to 1, and takes one shadow tap instead of
// nine (LOW in shaders.js). THIN and RAYN are inherited from the forest and are not read anywhere any more --
// they are declared here and nothing else references them.
// localStorage.ncvo = "level,pixels,detail". ncvoLoad is set while the world is built: still set on the next
// visit means that load crashed the tab, so this one runs a level lower.
const mob = matchMedia('(pointer:coarse)').matches, mem = navigator.deviceMemory;
const keep = (k, v) => { try { localStorage[k] = v; } catch {} };
let SV = [], LV, bad;
try { SV = (localStorage.ncvo || '').split(','); bad = localStorage.ncvoLoad; } catch {}
LV = SV[0] ? +SV[0] : mob ? (mem > 7 ? 1 : 2) : mem <= 4 ? 2 : 0;
if (bad && LV < 2) { SV = [++LV]; keep('ncvo', LV); }
const THIN = 1 << LV, SHADOW = LV ? 2048 : 4096, AA = LV > 1 ? 1 : 4, WATER = LV > 1 ? 256 : 512, RAYN = LV > 1 ? 12 : 34;
