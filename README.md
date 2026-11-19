# nc-3d-world-volcano

**An active volcano you can fly through, in one 66 KB HTML file.**

A basalt cone with a breached crater rim, a lava lake standing in the crater, a cascade down the
gorge with a rock bridge left standing over it, and a lava river running out across the basin
floor to a pond. No images, no 3D models, no sound files — the whole world, and the whole
soundscape, is generated from mathematics when the page opens.

## Try it

**[Open the volcano →](https://nilesh-0608.github.io/nc-3d-world-volcano/)**

Or run it offline:

1. Download [`index.html`](index.html).
2. Open it in **Chrome** or **Edge** on a desktop computer.
3. Wait a few seconds while the world is built, then press **Begin survey**.

Nothing to install, and it works offline. It needs a browser with **WebGPU**, and graphics
acceleration must be enabled — in Chrome that is `chrome://settings/system` → *Use graphics
acceleration when available*.

## Controls

| | Keyboard & mouse |
|---|---|
| Look around | Move the mouse |
| Move | `W` `A` `S` `D` |
| Down / up | `Q` / `E` |
| Faster | Hold `Shift` |
| Jump to a viewpoint | `1` to `6` |
| Day / night | `N` |
| Menu | `Esc` |
| Sound on / off | `M` |
| Performance stats | `H` |
| Detail level | **Low**, **Medium** or **High** in the menu |

Start at viewpoint `4` — the highest the camera goes, out on the breach side. The whole cone, the
lit notch in its rim, the gorge and the river coming towards you, and the plume standing over the
crater are all in that one frame. Then take `3`, which puts you inside the crater just under the
rim, over the lava lake itself.

## What's in there

- **A cone with a breached crater rim** — the lava lake drains out through the notch, down a
  gorge in the flank, and across the basin floor. The whole landform is one signed distance
  field, so the breach, the gorge and the overhanging crater lip are real geometry, not decals.
- **A 25 m lava lake** in the crater, mostly dark crust with bright seams where the plates part.
  Standing lava skins over and flowing lava does not, so the lake and the pond are modelled at 45%
  of the river's heat — which is also what keeps the light they throw in check.
- **A cascade down the gorge**, with a **natural rock bridge** left standing over it — the flank
  between 30 and 40 m from the vent is deliberately not cut through.
- **A lava river** across the basin floor, ending in a pond.
- **Light that comes from the ground.** The lava is the light source, so the exposure closes as
  you descend towards the basin and opens in the dim ash above — the inverse of the usual
  arrangement, and the thing the rest of the look is built around.
- **Basalt columns, rock spires and spatter cones** — 230, 90 and 60 of them, gathered along the
  river and around the pond where they are lit from below and read against the glow.
- **Ember motes** rising on the heat, and a **smoke plume** over the crater, lit from inside it so
  the cone always has a crater to be seen by.
- **Day and night** on one key.
- **A synthesized soundscape** — a rumble bed, a sub-bass tremor, the roar and hiss of the lava
  rising as you approach it and thinning as you climb, crackle off the cooling crust, and distant
  booms. All Web Audio, no files.

## How it works

- The terrain is a signed density field evaluated on the GPU over 21 million voxels
  (512 × 80 × 512), then meshed with surface nets — which is what allows the breached rim, the
  overhanging crater lip and the bridge over the gorge rather than a heightmap.
- Everything is drawn with **WebGPU** directly. No game engine, no 3D library.
- A ground map baked at startup carries the ash cover, the lava's heat and the light it throws, so
  the glow on the rock, the colour of the crust and the light reaching the columns all come from
  one source and cannot drift apart.
- Columns, spires and spatter cones are scattered by rejection-sampling the terrain's own vertices,
  so every one lands on the surface without a raycast. Candidates are rejected where the ground is
  too steep, inside or beside the lava, and mostly where no lava light reaches — which is why they
  gather along the river and round the pond. Spatter cones are then laid along the surface normal;
  columns and spires stand upright with a degree or two of lean.
- Ember motes rise in closed form: each one runs its own loop up from the lava level in its own
  column, wanders sideways on a sine pair and cools as it climbs. Nothing is simulated per frame.
- The sound is a fixed Web Audio graph built once on the first input and driven by a 10 Hz timer
  rather than the frame loop; the timer only moves gains, filter frequencies and envelopes on
  nodes that already exist, so it never creates a node after startup.
- It holds its frame rate by trading resolution first — down to half the pixel budget — then draw
  distance for the columns and rocks, then the rest of the pixels, and it climbs back the same way.
  At 1440×900 on an RTX 4060 Ti the median frame time is **5.6 ms**. That measurement is
  refresh-capped, so it is a floor, not a ceiling.

## Build it yourself

The readable source is in [`source`](source). You need [Node.js](https://nodejs.org) 18+:

```bash
cd source
npm install
npm run build
```

This writes a new `index.html` next to this README. `npm run build:readable` writes an
unminified version. `npm run build:dev` writes `dev.html` with two extra tools: `F` flies the
camera along a scripted path, and `B` runs that flight as a benchmark.

The six source files are concatenated in a fixed order into one async IIFE and injected into
`source/template.html`. There are no imports and no exports — it is all **one shared scope**.

| File | What's inside |
|---|---|
| [`source/src/world.js`](source/src/world.js) | The world: the lava's layout, the ground map, the columns and spires. **Start here.** |
| [`source/src/shaders.js`](source/src/shaders.js) | The look: the landform's density field, smoke, lava, the plume, day/night (WGSL) |
| [`source/src/main.js`](source/src/main.js) | Renderer, camera, collision, controls, viewpoints |
| [`source/src/math.js`](source/src/math.js) | Noise, random numbers, surface nets, mesh helpers |
| [`source/src/quality.js`](source/src/quality.js) | The detail level, chosen before anything is built |
| [`source/src/audio.js`](source/src/audio.js) | The soundscape |
| [`source/template.html`](source/template.html) | The page around the scene |

## Credit

Built on **[Abyssal Garden](https://github.com/Noniv/abyssal-garden)** by **Maksymilian
Dendura**, MIT licensed — an underwater scene with the same single-file, fully-procedural
constraints. The parts that originate there and are still doing the work here are the **WebGPU
renderer**, the **adaptive-resolution controller** that trades resolution for frame rate, the
**surface-nets terrain** mesher, the **brick-sparse SDF collision field**, and the **build
pipeline** that folds six source files into one HTML page. This project would have been weeks
longer without them.

Forked directly from its sibling **[nc-3d-world-amazon](https://github.com/nilesh-0608/nc-3d-world-amazon)**,
which is where the ocean→land translation was done; this is that codebase pointed at a volcano.

Going from a rainforest to a volcano inverted the one thing the forest had kept from the ocean:
the light. In both of those it arrives from above and you lose it as you descend. Here it rises
from the lava on the floor, which means the exposure closes on the way down instead of opening,
and the ambient term is driven by a baked ground map rather than by a sky. The smoke is still
thickest at the floor and still thins with height, exactly as the haze did — so descending now
costs you clarity and gains you light, where in the forest it cost you both.

## License

[MIT](LICENSE), same as its parent.
