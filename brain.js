// Fly brain: antennal lobe -> mushroom body -> valence, plus a central-complex
// compass. Pure JS, no DOM, no three.js. Runs identically in Node and browser.
//
// Circuits, all at DT = 5 ms (200 Hz):
//   AL  divisive normalization (Olsen & Wilson 2010) -> concentration-invariant odor ID
//   MB  8 PN -> 400 KC sparse random -> APL winner-take-all -> 2 MBONs
//       KC->MBON synapses DEPRESS under DAN drive (anti-Hebbian, as in the fly)
//   CX  32-unit ring attractor, PEN derivative shift, gain calibrated at startup

export const DT = 0.005;

// ---------------------------------------------------------------- utilities
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

export const wrapPi = (a) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

// ------------------------------------------------------- antennal lobe (AL)
export const N_GLOM = 16;

// PN_i = ORN_i^1.5 / (sigma^1.5 + ORN_total^1.5)
// The shared denominator is the whole point: it divides out absolute
// concentration, so odor IDENTITY survives while the fly flies up a gradient.
const AL_SIGMA = 0.45;
const AL_EXP = 1.5;

export function antennalLobe(orn, out) {
  out = out || new Float32Array(N_GLOM);
  let total = 0;
  for (let i = 0; i < N_GLOM; i++) total += orn[i];
  const denom = Math.pow(AL_SIGMA, AL_EXP) + Math.pow(total, AL_EXP);
  for (let i = 0; i < N_GLOM; i++) out[i] = Math.pow(orn[i], AL_EXP) / denom;
  return out;
}

// ------------------------------------------------------ mushroom body (MB)
export const N_KC = 800;
// Claws must sample a SMALL fraction of glomeruli or every KC sees the same
// thing, all KC patterns overlap, and one punishment generalizes to every
// odor the fly knows. 4/16 = 25%; the fly runs ~7/50 = 14%.
const KC_CLAWS = 4;
const KC_SPARSITY = 0.05;  // fraction of KCs APL lets through
const N_WINNERS = Math.max(1, Math.round(N_KC * KC_SPARSITY));
const W_FLOOR = 0.05;      // depression-only weights must not die permanently

export class MushroomBody {
  constructor(seed = 7, learnRate = 0.4, forgetRate = 8e-5) {
    const rand = rng(seed);
    this.learnRate = learnRate;
    this.forgetRate = forgetRate;

    // sparse random PN->KC: claw indices and weights
    this.claw = new Int32Array(N_KC * KC_CLAWS);
    this.clawW = new Float32Array(N_KC * KC_CLAWS);
    for (let k = 0; k < N_KC; k++) {
      const picked = new Set();
      for (let c = 0; c < KC_CLAWS; c++) {
        let g;
        do { g = Math.floor(rand() * N_GLOM); } while (picked.has(g) && picked.size < N_GLOM);
        picked.add(g);
        this.claw[k * KC_CLAWS + c] = g;
        this.clawW[k * KC_CLAWS + c] = 0.6 + 0.8 * rand();
      }
    }

    this.kcRaw = new Float32Array(N_KC);
    this.kc = new Float32Array(N_KC);
    this._scratch = new Float32Array(N_KC);
    // KC->MBON. Both start at 1 so a naive fly is exactly indifferent.
    this.wApproach = new Float32Array(N_KC).fill(1);
    this.wAvoid = new Float32Array(N_KC).fill(1);
    this.mbonApproach = 0;
    this.mbonAvoid = 0;
    this.valence = 0;
    this.nActive = 0;
  }

  // pn -> sparse KC code -> two opposing MBONs. Returns valence in [-1, 1].
  forward(pn) {
    const { kcRaw, kc, claw, clawW } = this;
    for (let k = 0; k < N_KC; k++) {
      let s = 0;
      const base = k * KC_CLAWS;
      for (let c = 0; c < KC_CLAWS; c++) s += clawW[base + c] * pn[claw[base + c]];
      kcRaw[k] = s;
    }

    // APL: global feedback inhibition, implemented as keep-top-N. This is the
    // fly's sparsening step and it is what makes odors linearly separable.
    this._scratch.set(kcRaw);
    this._scratch.sort();
    const thresh = this._scratch[N_KC - N_WINNERS];

    let sum = 0, n = 0;
    for (let k = 0; k < N_KC; k++) {
      const v = kcRaw[k] - thresh;
      kc[k] = v > 0 ? v : 0;
      if (v > 0) { sum += kc[k]; n++; }
    }
    this.nActive = n;

    if (sum <= 1e-9) {
      this.mbonApproach = this.mbonAvoid = this.valence = 0;
      return 0;
    }
    let a = 0, v = 0;
    for (let k = 0; k < N_KC; k++) {
      if (kc[k] > 0) { a += kc[k] * this.wApproach[k]; v += kc[k] * this.wAvoid[k]; }
    }
    this.mbonApproach = a / sum;
    this.mbonAvoid = v / sum;
    this.valence = this.mbonApproach - this.mbonAvoid;
    return this.valence;
  }

  // DAN-gated depression of whichever MBON pathway the outcome contradicts.
  // Reward depresses the avoidance channel; punishment depresses approach.
  // Depression-only is how the real circuit works -- there is no potentiation.
  teach(reinforcement) {
    const w = reinforcement > 0 ? this.wAvoid : this.wApproach;
    const lr = this.learnRate * Math.min(1, Math.abs(reinforcement));
    const { kc } = this;
    let peak = 0;
    for (let k = 0; k < N_KC; k++) if (kc[k] > peak) peak = kc[k];
    if (peak <= 0) return;
    for (let k = 0; k < N_KC; k++) {
      if (kc[k] > 0) w[k] = Math.max(W_FLOOR, w[k] * (1 - lr * (kc[k] / peak)));
    }
  }

  // Slow drift back to baseline: extinction. Lets the fly re-learn if the
  // world changes, and stops depression-only weights from dying permanently.
  forget() {
    const f = this.forgetRate;
    for (let k = 0; k < N_KC; k++) {
      this.wApproach[k] += f * (1 - this.wApproach[k]);
      this.wAvoid[k] += f * (1 - this.wAvoid[k]);
    }
  }

  // Read valence for an arbitrary odor without disturbing live KC state.
  probe(pn) {
    const saveKc = Float32Array.from(this.kc);
    const saveN = this.nActive;
    const a = this.mbonApproach, v = this.mbonAvoid, val = this.valence;
    const out = this.forward(pn);
    this.kc.set(saveKc);
    this.nActive = saveN;
    this.mbonApproach = a; this.mbonAvoid = v; this.valence = val;
    return out;
  }
}

// ------------------------------------------------- central complex (CX) ring
export const N_CX = 32;
const W_EXC = 2.5, W_INH = 0.12, SIGMA = 1.0, TONIC = 0.2, TAU = 0.05, CAP = 60;

export const CX_ANG = new Float32Array(N_CX);
for (let i = 0; i < N_CX; i++) CX_ANG[i] = (2 * Math.PI * i) / N_CX;

const CX_W = new Float32Array(N_CX * N_CX);
for (let i = 0; i < N_CX; i++) {
  for (let j = 0; j < N_CX; j++) {
    const raw = Math.abs(i - j);
    const d = Math.min(raw, N_CX - raw);
    CX_W[i * N_CX + j] = W_EXC * Math.exp(-(d * d) / (2 * SIGMA * SIGMA)) - W_INH;
  }
}

export class HeadingCircuit {
  constructor(gain) {
    this.gain = gain;
    this.r = new Float32Array(N_CX);
    this.r[0] = 1;
    this._next = new Float32Array(N_CX);
  }

  // angVel rad/s. cue is an optional N_CX allocentric landmark drive.
  step(angVel, cue = null, cueGain = 0) {
    const { r, _next } = this;
    let sum = 0;
    for (let i = 0; i < N_CX; i++) {
      let rec = 0;
      const row = i * N_CX;
      for (let j = 0; j < N_CX; j++) rec += CX_W[row + j] * r[j];
      // PEN derivative shift: the +/-1 column anatomical offset is what turns
      // angular velocity into bump motion.
      const shift = this.gain * angVel * (r[(i - 1 + N_CX) % N_CX] - r[(i + 1) % N_CX]);
      let drive = rec + shift + TONIC;
      if (cue) drive += cueGain * cue[i];
      const v = r[i] + (DT / TAU) * (-r[i] + (drive > 0 ? drive : 0));
      _next[i] = v;
      sum += v;
    }
    const scale = sum > CAP ? CAP / sum : 1;
    for (let i = 0; i < N_CX; i++) r[i] = _next[i] * scale;
    return r;
  }

  settle(n = 300) { for (let i = 0; i < n; i++) this.step(0); return this; }

  get heading() {
    let s = 0, c = 0;
    for (let i = 0; i < N_CX; i++) { s += this.r[i] * Math.sin(CX_ANG[i]); c += this.r[i] * Math.cos(CX_ANG[i]); }
    let h = Math.atan2(s, c) % (2 * Math.PI);
    return h < 0 ? h + 2 * Math.PI : h;
  }

  get sharpness() {
    let mx = 0, sum = 0;
    for (let i = 0; i < N_CX; i++) { if (this.r[i] > mx) mx = this.r[i]; sum += this.r[i]; }
    return mx / Math.max(sum / N_CX, 1e-9);
  }
}

// Bump velocity is linear in (gain x angular velocity) over the useful range,
// so calibration is one probe run and one division. Bisection is a trap here:
// an unlucky bracket contains no solution.
export function calibrateGain() {
  const probeGain = 0.5, probeAv = Math.PI / 2;
  const cx = new HeadingCircuit(probeGain).settle();
  let prev = cx.heading, total = 0, at200 = 0;
  for (let k = 0; k < 700; k++) {
    cx.step(probeAv);
    const h = cx.heading;
    total += wrapPi(h - prev);
    prev = h;
    if (k === 199) at200 = total;
  }
  const measured = (total - at200) / (500 * DT);
  return probeGain * (probeAv / measured);
}

// ------------------------------------------------------------- whole brain
export const BEHAVIOR = { SEARCH: 'SEARCH', TRACK: 'TRACK', AVOID: 'AVOID', FEED: 'FEED' };

export class FlyBrain {
  constructor(seed = 7) {
    this.gain = calibrateGain();
    this.cx = new HeadingCircuit(this.gain).settle();
    this.mb = new MushroomBody(seed);
    this.pnL = new Float32Array(N_GLOM);
    this.pnR = new Float32Array(N_GLOM);
    this.pnMean = new Float32Array(N_GLOM);
    this.valence = 0;
    this.gradient = 0;
    this.odor = 0;
    this.behavior = BEHAVIOR.SEARCH;
  }

  // ornL / ornR: per-glomerulus ORN drive at the left and right antenna.
  // Returns { valence, gradient, odor } -- everything the motor layer needs.
  sense(ornL, ornR) {
    antennalLobe(ornL, this.pnL);
    antennalLobe(ornR, this.pnR);
    for (let i = 0; i < N_GLOM; i++) this.pnMean[i] = 0.5 * (this.pnL[i] + this.pnR[i]);

    let magL = 0, magR = 0;
    for (let i = 0; i < N_GLOM; i++) { magL += ornL[i]; magR += ornR[i]; }
    this.odor = 0.5 * (magL + magR);

    // One MB evaluation gives odor identity -> valence. Direction comes from
    // the left/right intensity comparison, normalized so steering gain does
    // not explode as the fly closes on the source.
    this.valence = this.mb.forward(this.pnMean);
    this.lateral = (magL - magR) / (magL + magR + 1e-6);
    this.gradient = this.valence * this.lateral;
    this.mb.forget();
    return { valence: this.valence, lateral: this.lateral, odor: this.odor };
  }

  teach(reinforcement) { this.mb.teach(reinforcement); }

  stepCompass(angVel, cue = null, cueGain = 0) { this.cx.step(angVel, cue, cueGain); }

  get heading() { return this.cx.heading; }
}
