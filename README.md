# flysim

A foraging simulation driven by a real fly connectome model — antennal lobe,
mushroom body, and central-complex compass — not a scripted AI. The brain
runs at a fixed 200 Hz regardless of framerate; the graphics are just two
different windows onto the same numbers.

Fly smells 4 flower species through 16 glomeruli, tries to fly up the
gradient of whichever one smells best, and learns from experience: two
species are rewarding, two are toxic, and after a few bad landings the
mushroom body suppresses approach to the toxic ones on its own.

Inspired by the [Fruit Fly Brain Observatory](https://www.fruitflybrain.org/),
which lets you explore and simulate real Drosophila connectome data in 3D.
This project takes that same idea — real fly circuitry, not a scripted
AI — and shrinks it down to a small, dependency-free JS sim you can run and
poke at in a browser.

## Run it

**Full build** (three.js, chase/top-down/orbit camera, 8-bit dither shader):

```
python3 -m http.server 8777
# open http://localhost:8777/index.html
```

Needs a server because it's ES modules loading `vendor/three.module.js`.

**Standalone build** (`mini.html`): zero dependencies, zero network
requests, one file. `open mini.html` works directly from disk — no server.
Same brain/sim code, a hand-rolled software 3D renderer instead of three.js,
and a `MAP → CHASE → POV` view toggle.

**Headless brain tests**:

```
node test_brain.js
```

Validates the compass gain calibration, ring-attractor drift/tracking, and
runs a scripted foraging episode to check learning actually changes behavior.

## Controls

| Key | Effect |
|---|---|
| space | pause |
| 1–4 | speed (1x / 4x / 16x / 50x) |
| c | cycle camera (`index.html`: chase / top-down / orbit) |
| v | cycle view (`mini.html`: map / chase / pov) |
| p | toggle odor plumes |
| f | flip world (swap nectar ↔ toxin) |
| r | reset brain (back to naive) |
| h | toggle HUD |
| q | toggle 8-bit palette (`index.html` only) |

## How it works

```
sim.js        world + body + the sensorimotor loop (no graphics)
brain.js      AL -> MB -> CX circuits (pure JS, runs identically in Node)
render.js     three.js scene, mirrors sim state, never drives it
hud.js        text overlay (behavior, learned valences, compass drift)
main.js       fixed-timestep loop wiring sim -> render -> hud
mini.html     the whole stack in one file, plus a software 3D renderer
test_brain.js headless numeric checks on the circuits
```

The render layer only *reads* `Sim` — it never calls anything that would
perturb its RNG stream, since one stray `rand()` call there would reshuffle
every flower position.

**Antennal lobe**: divisive normalization, `PN = ORN^1.5 / (σ^1.5 +
Σ ORN^1.5)`. Concentration cancels out of the shared denominator, so odor
*identity* is what survives — the fly can climb a gradient without the
signal saturating.

**Mushroom body**: 16 PN → 800 Kenyon cells (4 random claws each) → APL
top-40 winner-take-all → two opposing MBONs. Learning is depression-only:
a dopamine (DAN) signal on a bad landing weakens the KC→MBON synapses that
just fired, exactly the sign fly learning actually has. There is no
strengthening step — the fly starts naive-curious and only ever learns to
avoid.

**Central complex**: a 32-unit ring attractor doing dead reckoning from
angular velocity alone. It has no ground truth heading, so it drifts —
that drift is real and is tracked in the HUD, not a bug.

**Behavior loop** (`sim.js`): `SEARCH` (menotaxis — hold a remembered
heading) → `TRACK` (surge up a gradient once odor is detected) → `FEED` or
`AVOID`, gated by learned valence. A fly that has learned an odor is toxic
refuses to land on it, which is what turns learning into an observable
behavior change rather than a number nobody acts on.
