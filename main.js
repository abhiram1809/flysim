import { Sim } from './sim.js';
import { DT } from './brain.js';
import { View } from './render.js';
import { Hud } from './hud.js';

const sim = new Sim({ seed: 11, nFlowers: 22, brainSeed: 7 });
const view = new View(document.getElementById('gl'), sim);
const hud = new Hud(document.getElementById('hud'), sim);

const SPEEDS = [1, 4, 16, 50];
let speedIdx = 1;
let paused = false;
let acc = 0;
let last = performance.now();
let trailTick = 0;
const toast = document.getElementById('toast');

function say(msg) {
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(say._t);
  say._t = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
}

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') { paused = !paused; say(paused ? 'paused' : 'running'); e.preventDefault(); }
  else if (k >= '1' && k <= '4') { speedIdx = +k - 1; say(`${SPEEDS[speedIdx]}x speed`); }
  else if (k === 'c') { view.cameraMode = (view.cameraMode + 1) % 3; say(['chase cam', 'top-down', 'orbit'][view.cameraMode]); }
  else if (k === 'p') { view.showPlumes = !view.showPlumes; say(view.showPlumes ? 'odor plumes on' : 'odor plumes off'); }
  else if (k === 'h') { hud.visible = !hud.visible; }
  else if (k === 'f') { sim.shufflePayoffs(); view.clearMarkers(); say('world flipped — nectar and toxin swapped'); }
  else if (k === 'r') { sim.resetBrain(); view.clearMarkers(); say('brain reset — naive fly'); }
  else if (k === 'q') {
    const u = view.quadMat.uniforms.quantize;
    u.value = u.value > 0.5 ? 0 : 1;
    say(u.value > 0.5 ? '8-bit palette on' : '8-bit palette off (raw render)');
  }
});

window.__fly = { sim, view, hud };

function frame(now) {
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!paused) {
    acc += dtReal * SPEEDS[speedIdx];
    // Fixed 200 Hz neural step, decoupled from framerate. The circuits are
    // calibrated for DT, so a variable step would change the fly's behavior
    // whenever the framerate moved.
    let n = 0;
    const maxTicks = 400;
    while (acc >= DT && n < maxTicks) {
      sim.step();
      acc -= DT;
      n++;
      if (++trailTick % 8 === 0) view.pushTrail(sim.fly.x, sim.fly.y, sim.fly.z, sim.brain.behavior);
    }
    if (n >= maxTicks) acc = 0;
  }

  for (const ev of sim.events) {
    if (ev.kind === 'nectar' || ev.kind === 'toxin' || ev.kind === 'reject') view.addMarker(ev.kind, ev.x, ev.z);
  }
  sim.events.length = 0;

  view.update(dtReal);
  view.render();
  hud.draw();
  requestAnimationFrame(frame);
}

say('4x speed — watch LEARNED VALUE fill in. [f] flips the world.');
requestAnimationFrame(frame);
