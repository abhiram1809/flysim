// World + body + sensorimotor loop. No graphics. This is the code the game
// actually runs; render.js only mirrors the state it produces.

import { FlyBrain, BEHAVIOR, N_GLOM, DT, wrapPi, antennalLobe } from './brain.js';

export const WORLD = 40;          // half-extent
export const PLUME_R = 4.0;       // odor falloff sigma; wide plumes = constant
                                  // mixtures = the MB never sees a clean odor
const DETECT = 0.04;              // ORN magnitude that counts as "smelling something"
const FEED_RADIUS = 1.25;
const CRUISE = 6.0, SURGE = 9.5, FLEE = 11.0;
const MAX_ANGVEL = 4.2;           // rad/s
const K_GRAD = 26.0;              // steering drive -> turn gain
const K_MENO = 2.6;               // compass hold gain in SEARCH
const AVOID_VALENCE = -0.08;      // below this the fly turns away and refuses to land
const CURIOSITY = 0.3;            // naive odors are mildly attractive, so the fly
                                  // explores instead of ignoring unknown flowers

// Four flower species over 16 glomeruli. Each has a private strong triple plus
// weak channels shared with others, so the MB has real discrimination work
// rather than a trivial one-hot task.
export const SPECIES = [
  { name: 'bluebell', color: 0x4878d0, odor: [1.0, 0.8, 0.5, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0.2] },
  { name: 'goldstar', color: 0xf0c040, odor: [0.2, 0, 0, 1.0, 0.8, 0.5, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0] },
  { name: 'redcap',   color: 0xd04040, odor: [0, 0, 0, 0.2, 0, 0, 1.0, 0.8, 0.5, 0, 0.3, 0, 0, 0, 0, 0.2] },
  { name: 'violet',   color: 0x9050c8, odor: [0, 0, 0.2, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.3, 1.0, 0.8, 0.5, 0] },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export class Sim {
  constructor({ seed = 11, nFlowers = 22, brainSeed = 7 } = {}) {
    this.rand = rng(seed);
    this.t = 0;
    this.brain = new FlyBrain(brainSeed);

    // two species reward, two punish
    this.payoff = [1, -1, 1, -1];

    this.flowers = [];
    for (let i = 0; i < nFlowers; i++) {
      let x, z, ok = false, tries = 0;
      while (!ok && tries++ < 200) {
        x = (this.rand() * 2 - 1) * (WORLD - 4);
        z = (this.rand() * 2 - 1) * (WORLD - 4);
        ok = this.flowers.every((f) => (f.x - x) ** 2 + (f.z - z) ** 2 > 81);
      }
      this.flowers.push({
        x, z, species: i % SPECIES.length,
        nectar: 1, cooldown: 0, scale: 0.8 + this.rand() * 0.5,
        phase: this.rand() * Math.PI * 2,
      });
    }

    this.fly = { x: 0, z: 0, y: 1.6, yaw: this.rand() * Math.PI * 2, speed: CRUISE, angVel: 0 };
    // The bump starts at an arbitrary column, so record the offset once and
    // compare against it later. Any growth in the difference is genuine
    // dead-reckoning drift.
    this.headingOffset = wrapPi(this.brain.heading - this.fly.yaw);
    this.goalHeading = this.brain.heading;
    this.saccadeIn = 1.5;
    this.escapeIn = 0;
    this.trackTime = 0;
    this.lastFlower = -1;

    this.ornL = new Float32Array(N_GLOM);
    this.ornR = new Float32Array(N_GLOM);
    this.stats = { nectar: 0, toxin: 0, rejections: 0, visits: [] };
    this.rejectDebounce = 0;
    this.events = [];
  }

  // ORN drive at a world point: every flower contributes its species odor
  // vector scaled by a Gaussian plume and by how much nectar is left.
  sampleOdor(x, z, out) {
    out.fill(0);
    for (const f of this.flowers) {
      const dx = x - f.x, dz = z - f.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > (PLUME_R * 3) ** 2) continue;
      const g = Math.exp(-d2 / (2 * PLUME_R * PLUME_R)) * (0.35 + 0.65 * f.nectar);
      const vec = SPECIES[f.species].odor;
      for (let i = 0; i < N_GLOM; i++) out[i] += g * vec[i];
    }
    for (let i = 0; i < N_GLOM; i++) out[i] = Math.max(0, out[i] + (this.rand() - 0.5) * 0.004);
    return out;
  }

  nearestFlower() {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.flowers.length; i++) {
      const f = this.flowers[i];
      const d2 = (f.x - this.fly.x) ** 2 + (f.z - this.fly.z) ** 2;
      if (d2 < bd) { bd = d2; best = i; }
    }
    return { idx: best, dist: Math.sqrt(bd) };
  }

  // One 5 ms neural + physics tick.
  step() {
    const { fly, brain } = this;
    const fwdX = Math.sin(fly.yaw), fwdZ = Math.cos(fly.yaw);
    const leftX = fwdZ, leftZ = -fwdX;

    const hx = fly.x + fwdX * 0.4, hz = fly.z + fwdZ * 0.4;
    this.sampleOdor(hx + leftX * 0.6, hz + leftZ * 0.6, this.ornL);
    this.sampleOdor(hx - leftX * 0.6, hz - leftZ * 0.6, this.ornR);

    const { valence, lateral, odor } = brain.sense(this.ornL, this.ornR);
    // A naive fly explores (CURIOSITY); a fly that has learned this odor is
    // bad gets a negative drive and steers down the gradient instead of up.
    const drive = valence < AVOID_VALENCE ? valence : Math.max(valence, CURIOSITY);
    const gradient = drive * lateral;

    for (const f of this.flowers) {
      if (f.nectar < 1) f.nectar = Math.min(1, f.nectar + 0.06 * DT);
      if (f.cooldown > 0) f.cooldown -= DT;
    }
    if (this.escapeIn > 0) this.escapeIn -= DT;
    if (this.rejectDebounce > 0) this.rejectDebounce -= DT;

    const near = this.nearestFlower();
    const nf = this.flowers[near.idx];

    let angVel = 0, targetSpeed = CRUISE, behavior;

    // The valence gate is what turns learning into behavior: a fly that has
    // learned an odor is toxic refuses to land, so it stops being punished.
    // Without this gate the fly eats whatever it collides with and the
    // mushroom body's output never reaches the motor system.
    const willLand = valence > AVOID_VALENCE;

    if (near.dist < FEED_RADIUS && nf.cooldown <= 0 && this.escapeIn <= 0 && willLand) {
      behavior = BEHAVIOR.FEED;
      targetSpeed = 0.6;
      this.trackTime = 0;
      const r = this.payoff[nf.species];
      brain.teach(r);
      nf.nectar = 0;
      nf.cooldown = 6;
      this.escapeIn = 0.9;
      this.lastFlower = near.idx;
      if (r > 0) this.stats.nectar++; else this.stats.toxin++;
      this.stats.visits.push({ t: this.t, species: nf.species, reward: r });
      this.events.push({ t: this.t, kind: r > 0 ? 'nectar' : 'toxin', species: nf.species, x: nf.x, z: nf.z });
    } else if (odor > DETECT && valence < AVOID_VALENCE && this.escapeIn <= 0) {
      if (near.dist < FEED_RADIUS * 2 && nf.cooldown <= 0 && this.rejectDebounce <= 0) {
        this.stats.rejections++;
        this.rejectDebounce = 2.0;
        this.events.push({ t: this.t, kind: 'reject', species: nf.species, x: nf.x, z: nf.z });
      }
      behavior = BEHAVIOR.AVOID;
      targetSpeed = FLEE;
      // run down the gradient, plus a steady bias so it commits to a turn
      angVel = -K_GRAD * gradient + (gradient >= 0 ? -1.1 : 1.1);
    } else if (odor > DETECT && this.escapeIn <= 0) {
      behavior = BEHAVIOR.TRACK;
      targetSpeed = SURGE;
      angVel = K_GRAD * gradient;
      // Two overlapping plumes form a saddle the surge controller can orbit
      // indefinitely, closing to ~1.9 units but never to FEED_RADIUS. Without
      // a give-up timer the fly stays in TRACK and never disperses again.
      this.trackTime += DT;
      if (this.trackTime > 12) { this.trackTime = 0; this.escapeIn = 2.5; }
    } else {
      behavior = BEHAVIOR.SEARCH;
      targetSpeed = CRUISE;
      this.trackTime = 0;
      // Menotaxis: hold a remembered compass heading. This is the CX earning
      // its keep -- straight dispersal flights instead of a random walk.
      this.saccadeIn -= DT;
      if (this.saccadeIn <= 0) {
        this.saccadeIn = 1.2 + this.rand() * 2.5;
        this.goalHeading = wrapPi(this.goalHeading + (this.rand() * 2 - 1) * 2.0);
      }
      angVel = K_MENO * wrapPi(this.goalHeading - brain.heading);
    }

    // steer away from the world edge
    const edge = 6;
    if (Math.abs(fly.x) > WORLD - edge || Math.abs(fly.z) > WORLD - edge) {
      const inward = Math.atan2(-fly.x, -fly.z);
      angVel += 3.0 * wrapPi(inward - fly.yaw);
      // goalHeading is compared against the compass, so it lives in compass
      // frame; inward is a body-frame bearing and needs the offset added.
      this.goalHeading = wrapPi(inward + this.headingOffset);
    }

    angVel = Math.max(-MAX_ANGVEL, Math.min(MAX_ANGVEL, angVel));
    fly.angVel = angVel;
    fly.speed += (targetSpeed - fly.speed) * Math.min(1, 6 * DT);
    fly.yaw = wrapPi(fly.yaw + angVel * DT);
    fly.x += Math.sin(fly.yaw) * fly.speed * DT;
    fly.z += Math.cos(fly.yaw) * fly.speed * DT;
    fly.x = Math.max(-WORLD, Math.min(WORLD, fly.x));
    fly.z = Math.max(-WORLD, Math.min(WORLD, fly.z));
    fly.y = 1.6 + 0.35 * Math.sin(this.t * 9.0);

    // The compass only ever sees the fly's own angular velocity -- it has no
    // access to true yaw. Drift is therefore real and accumulates.
    brain.stepCompass(angVel);

    this.brain.behavior = behavior;
    this.t += DT;
    return behavior;
  }

  // Learned valence per species, for the HUD and for tests.
  speciesValence() {
    const tmp = new Float32Array(N_GLOM);
    const pn = new Float32Array(N_GLOM);
    return SPECIES.map((s, i) => {
      for (let g = 0; g < N_GLOM; g++) tmp[g] = s.odor[g] * 0.8;
      antennalLobe(tmp, pn);
      return { name: s.name, color: s.color, payoff: this.payoff[i], valence: this.brain.mb.probe(pn) };
    });
  }

  resetBrain() {
    this.brain = new FlyBrain((this.rand() * 1e6) | 0);
    this.headingOffset = wrapPi(this.brain.heading - this.fly.yaw);
    this.stats = { nectar: 0, toxin: 0, rejections: 0, visits: [] };
    this.events.push({ t: this.t, kind: 'reset' });
  }

  get compassYaw() { return wrapPi(this.brain.heading - this.headingOffset); }
  get compassError() { return wrapPi(this.compassYaw - this.fly.yaw); }

  shufflePayoffs() {
    this.payoff = this.payoff.map((p) => -p);
    this.events.push({ t: this.t, kind: 'shuffle' });
  }
}
