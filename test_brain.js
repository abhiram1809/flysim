// Headless validation of the circuits and of closed-loop foraging.
// Run: node test_brain.js
import { HeadingCircuit, calibrateGain, MushroomBody, antennalLobe, N_GLOM, DT, wrapPi } from './brain.js';
import { Sim, SPECIES } from './sim.js';

const deg = (r) => (r * 180) / Math.PI;

console.log('=== 1. CX gain calibration (JS port) ===');
const GAIN = calibrateGain();
console.log(`   calibrated GAIN = ${GAIN.toFixed(4)}  (python reference: 0.1958)`);

function track(cx, av, steps) {
  let prev = cx.heading, total = 0;
  for (let k = 0; k < steps; k++) { cx.step(av); total += wrapPi(cx.heading - prev); prev = cx.heading; }
  return total;
}

console.log('\n=== 2. CX bump stability + integration ===');
{
  const cx = new HeadingCircuit(GAIN).settle();
  const h0 = cx.heading;
  for (let i = 0; i < 2000; i++) cx.step(0);
  console.log(`   idle drift ${Math.abs(deg(wrapPi(cx.heading - h0))).toFixed(3)} deg / 10 s ` +
              `| sharpness ${cx.sharpness.toFixed(1)}`);
  let worst = 0;
  for (const rate of [15, 45, 90, 180, -120, 270, -360]) {
    const c = new HeadingCircuit(GAIN).settle();
    const est = deg(track(c, (rate * Math.PI) / 180, 400));
    const truth = rate * 2;
    const pct = (Math.abs(truth - est) / Math.abs(truth)) * 100;
    worst = Math.max(worst, pct);
    console.log(`   ${String(rate).padStart(5)} deg/s x2s -> true ${truth.toFixed(1).padStart(8)}  est ${est.toFixed(1).padStart(8)}  err ${pct.toFixed(1)}%`);
  }
  console.log(`   worst-case gain error: ${worst.toFixed(1)}%`);
}

console.log('\n=== 3. AL divisive normalization: is odor identity concentration-invariant? ===');
{
  const base = Float32Array.from(SPECIES[0].odor);
  const ref = antennalLobe(base.map((v) => v * 1.0), new Float32Array(N_GLOM));
  const refNorm = Math.hypot(...ref);
  for (const c of [0.1, 0.3, 1.0, 3.0, 10.0]) {
    const pn = antennalLobe(base.map((v) => v * c), new Float32Array(N_GLOM));
    const n = Math.hypot(...pn);
    let dot = 0;
    for (let i = 0; i < N_GLOM; i++) dot += (pn[i] / n) * (ref[i] / refNorm);
    let tot = 0; for (let i = 0; i < N_GLOM; i++) tot += pn[i];
    console.log(`   conc x${String(c).padStart(4)} -> PN total ${tot.toFixed(3)}  cosine-similarity to reference ${dot.toFixed(4)}`);
  }
  console.log('   (cosine ~1.0 across 100x concentration = identity preserved, magnitude discarded)');
}

console.log('\n=== 4. MB discrimination: reward species 0, punish species 2 ===');
{
  const mb = new MushroomBody(7);
  const pns = SPECIES.map((s) => antennalLobe(Float32Array.from(s.odor).map((v) => v * 0.8), new Float32Array(N_GLOM)));
  const show = (label) => {
    const v = pns.map((p, i) => `${SPECIES[i].name}=${mb.probe(p).toFixed(3).padStart(6)}`).join('  ');
    console.log(`   ${label.padEnd(14)} ${v}`);
  };
  // KC code overlap diagnoses generalization. If patterns overlap heavily,
  // punishing one odor poisons all the others.
  const sets = pns.map((p) => { mb.forward(p); const s = new Set(); for (let k = 0; k < mb.kc.length; k++) if (mb.kc[k] > 0) s.add(k); return s; });
  mb.forward(pns[0]);
  console.log(`   KCs active per odor: ${mb.nActive}/800 (APL target 40)`);
  console.log('   KC-code overlap (Jaccard) between species:');
  for (let i = 0; i < 4; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      let inter = 0;
      for (const k of sets[i]) if (sets[j].has(k)) inter++;
      row.push((inter / (sets[i].size + sets[j].size - inter)).toFixed(2));
    }
    console.log(`     ${SPECIES[i].name.padEnd(9)} ${row.join('  ')}`);
  }
  show('naive');
  for (let trial = 0; trial < 6; trial++) { mb.forward(pns[0]); mb.teach(+1); mb.forward(pns[2]); mb.teach(-1); }
  show('after 6x');
  for (let trial = 0; trial < 14; trial++) { mb.forward(pns[0]); mb.teach(+1); mb.forward(pns[2]); mb.teach(-1); }
  show('after 20x');
  console.log('   (species 0 should go positive, species 2 negative, 1 and 3 stay near 0)');
}

console.log('\n=== 5. Closed-loop foraging: does the fly get better at this? ===');
{
  const sim = new Sim({ seed: 11, brainSeed: 7 });
  const WINDOW = 60;
  const stepsPerWindow = Math.round(WINDOW / DT);
  let prevN = 0, prevT = 0;
  const rows = [];
  for (let w = 0; w < 6; w++) {
    for (let i = 0; i < stepsPerWindow; i++) sim.step();
    const n = sim.stats.nectar - prevN, t = sim.stats.toxin - prevT;
    prevN = sim.stats.nectar; prevT = sim.stats.toxin;
    rows.push({ w, n, t });
    const pct = n + t > 0 ? ((n / (n + t)) * 100).toFixed(0) : '--';
    console.log(`   ${String(w * WINDOW).padStart(3)}-${String((w + 1) * WINDOW).padStart(3)}s  nectar ${String(n).padStart(3)}  toxin ${String(t).padStart(3)}  refused ${String(sim.stats.rejections).padStart(3)}  -> ${String(pct).padStart(3)}% good`);
  }
  console.log('\n   learned valence per species:');
  for (const s of sim.speciesValence()) {
    const tag = s.payoff > 0 ? 'NECTAR' : 'TOXIN ';
    const ok = Math.sign(s.valence) === Math.sign(s.payoff) ? 'correct' : 'WRONG';
    console.log(`     ${s.name.padEnd(9)} ${tag} true  valence ${s.valence.toFixed(3).padStart(7)}  ${ok}`);
  }
  const first = rows[0], last = rows[rows.length - 1];
  const r0 = first.n / Math.max(1, first.n + first.t), r1 = last.n / Math.max(1, last.n + last.t);
  console.log(`\n   good-choice rate: ${(r0 * 100).toFixed(0)}% in first minute -> ${(r1 * 100).toFixed(0)}% in last minute`);

  console.log('\n=== 6. Re-learning after the world flips (payoffs inverted) ===');
  sim.shufflePayoffs();
  let pn2 = sim.stats.nectar, pt2 = sim.stats.toxin;
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < stepsPerWindow; i++) sim.step();
    const n = sim.stats.nectar - pn2, t = sim.stats.toxin - pt2;
    pn2 = sim.stats.nectar; pt2 = sim.stats.toxin;
    const pct = n + t > 0 ? ((n / (n + t)) * 100).toFixed(0) : '--';
    console.log(`   +${String((w + 1) * WINDOW).padStart(3)}s after flip  nectar ${String(n).padStart(3)}  toxin ${String(t).padStart(3)}  -> ${String(pct).padStart(3)}% good`);
  }
  for (const s of sim.speciesValence()) {
    const ok = Math.sign(s.valence) === Math.sign(s.payoff) ? 'correct' : 'not yet';
    console.log(`     ${s.name.padEnd(9)} now ${(s.payoff > 0 ? 'NECTAR' : 'TOXIN ')}  valence ${s.valence.toFixed(3).padStart(7)}  ${ok}`);
  }
}

console.log('\n=== 7. Cost ===');
{
  const sim = new Sim({ seed: 3 });
  for (let i = 0; i < 500; i++) sim.step();
  const t0 = process.hrtime.bigint();
  const N = 40000;
  for (let i = 0; i < N; i++) sim.step();
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`   ${us.toFixed(1)} us per 5 ms tick -> ${(1e6 / us).toFixed(0)} ticks/s`);
  console.log(`   200 Hz costs ${((us * 200) / 1000).toFixed(3)} ms per second of game time (${((us * 200) / 1000 / 10).toFixed(4)}% of one core)`);
}
