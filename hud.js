// 2D overlay showing what the brain is doing: CX bump, AL glomeruli,
// KC sparse code, MBON valence, and the learned value of each species.

import { N_CX, N_GLOM, N_KC, CX_ANG } from './brain.js';

const C = {
  bg: 'rgba(20,12,28,0.82)', edge: '#4e4a4e', text: '#deeed6', dim: '#8595a1',
  gold: '#dad45e', green: '#6daa2c', red: '#d04648', blue: '#597dce', cyan: '#6dc2ca',
};
const W = 306;
const CONTENT_H = 592;

export class Hud {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.sim = sim;
    this.ctx = canvas.getContext('2d');
    this.visible = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.h = CONTENT_H;
    this.canvas.width = W * dpr;
    this.canvas.height = CONTENT_H * dpr;
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = CONTENT_H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Shrink rather than overflow on small windows, so the panel always fits.
    const scale = Math.max(0.5, Math.min(1,
      (window.innerHeight - 24) / CONTENT_H,
      (window.innerWidth * 0.46) / W));
    this.canvas.style.transformOrigin = 'top left';
    this.canvas.style.transform = `scale(${scale.toFixed(3)})`;
  }

  panel(x, y, w, h, title) {
    const g = this.ctx;
    g.fillStyle = C.bg;
    g.fillRect(x, y, w, h);
    g.strokeStyle = C.edge;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (title) {
      g.fillStyle = C.dim;
      g.font = '9px ui-monospace, Menlo, monospace';
      g.fillText(title, x + 7, y + 12);
    }
  }

  bars(x, y, w, h, values, color, peak) {
    const g = this.ctx;
    const n = values.length;
    const bw = w / n;
    const mx = peak || Math.max(1e-6, ...values);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, values[i]) / mx;
      g.fillStyle = color;
      g.fillRect(x + i * bw + 0.5, y + h - v * h, Math.max(1, bw - 1), v * h);
    }
    g.strokeStyle = C.edge;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  draw() {
    const g = this.ctx;
    const { sim } = this;
    const b = sim.brain;
    g.clearRect(0, 0, W, this.h);
    if (!this.visible) return;

    g.font = '10px ui-monospace, Menlo, monospace';
    g.textBaseline = 'alphabetic';

    // ---------------- status
    this.panel(6, 6, W - 12, 52, null);
    const beh = b.behavior;
    const behColor = { SEARCH: C.dim, TRACK: C.green, AVOID: C.red, FEED: C.gold }[beh];
    g.fillStyle = C.text;
    g.font = 'bold 13px ui-monospace, Menlo, monospace';
    g.fillText('FLY BRAIN', 14, 26);
    g.fillStyle = behColor;
    g.fillText(beh, 118, 26);
    g.font = '10px ui-monospace, Menlo, monospace';
    g.fillStyle = C.dim;
    g.fillText(`t=${sim.t.toFixed(0)}s  ${sim.fly.speed.toFixed(1)} u/s  odor ${b.odor.toFixed(3)}`, 14, 44);
    g.fillStyle = C.green;
    g.fillText(`nectar ${sim.stats.nectar}`, 196, 26);
    g.fillStyle = C.red;
    g.fillText(`toxin ${sim.stats.toxin}`, 196, 38);
    g.fillStyle = C.gold;
    g.fillText(`refused ${sim.stats.rejections}`, 196, 50);

    // ---------------- CX ring attractor
    const cy = 152, cx = 66;
    this.panel(6, 64, W - 12, 130, 'CENTRAL COMPLEX  ring attractor (32 E-PG)');
    const r = b.cx.r;
    let mx = 0;
    for (let i = 0; i < N_CX; i++) mx = Math.max(mx, r[i]);
    for (let i = 0; i < N_CX; i++) {
      const a = CX_ANG[i] - Math.PI / 2;
      const inner = 14, len = 30 * (r[i] / Math.max(mx, 1e-6));
      g.strokeStyle = r[i] > 0.05 * mx ? C.cyan : C.edge;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      g.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
      g.stroke();
    }
    // true body heading vs compass estimate
    const arrow = (ang, color, len) => {
      const a = ang - Math.PI / 2;
      g.strokeStyle = color; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke();
    };
    arrow(sim.fly.yaw, C.text, 12);
    arrow(sim.compassYaw, C.gold, 46);
    g.lineWidth = 1;
    g.fillStyle = C.dim;
    g.font = '9px ui-monospace, Menlo, monospace';
    const err = (sim.compassError * 180) / Math.PI;
    g.fillText(`body    ${((sim.fly.yaw * 180) / Math.PI).toFixed(0).padStart(4)}°`, 126, 104);
    g.fillStyle = C.gold;
    g.fillText(`compass ${((sim.compassYaw * 180) / Math.PI).toFixed(0).padStart(4)}°`, 126, 118);
    g.fillStyle = Math.abs(err) > 25 ? C.red : C.dim;
    g.fillText(`drift   ${err >= 0 ? '+' : ''}${err.toFixed(1)}°`, 126, 132);
    g.fillStyle = C.dim;
    g.fillText(`sharpness ${b.cx.sharpness.toFixed(1)}`, 126, 152);
    g.fillText(`ω ${((sim.fly.angVel * 180) / Math.PI).toFixed(0)}°/s`, 126, 166);
    g.fillText('dead reckoning only', 126, 184);

    // ---------------- antennal lobe
    this.panel(6, 200, W - 12, 58, 'ANTENNAL LOBE  16 PN, divisive normalization');
    this.bars(12, 218, 138, 32, Array.from(b.pnL), C.blue);
    this.bars(158, 218, 138, 32, Array.from(b.pnR), C.blue);
    g.fillStyle = C.dim;
    g.font = '9px ui-monospace, Menlo, monospace';
    g.fillText('L antenna', 12, 256);
    g.fillText('R antenna', 158, 256);

    // ---------------- Kenyon cell sparse code
    this.panel(6, 264, W - 12, 86, `MUSHROOM BODY  ${b.mb.nActive}/${N_KC} KC active (APL)`);
    const cols = 40, rows = N_KC / cols, ds = 6.8;
    let kmax = 0;
    for (let k = 0; k < N_KC; k++) kmax = Math.max(kmax, b.mb.kc[k]);
    for (let k = 0; k < N_KC; k++) {
      const cxk = 12 + (k % cols) * ds, cyk = 280 + ((k / cols) | 0) * (ds * 0.62);
      const v = b.mb.kc[k];
      if (v > 0) {
        g.fillStyle = C.gold;
        g.globalAlpha = 0.35 + 0.65 * (v / Math.max(kmax, 1e-6));
        g.fillRect(cxk, cyk, 4, 3);
        g.globalAlpha = 1;
      } else {
        g.fillStyle = '#2e2a36';
        g.fillRect(cxk, cyk, 4, 3);
      }
    }

    // ---------------- MBON valence
    this.panel(6, 356, W - 12, 56, 'MBON  approach − avoid = valence');
    const vx = 12, vw = W - 24;
    g.fillStyle = '#2e2a36';
    g.fillRect(vx, 374, vw, 12);
    const mid = vx + vw / 2;
    const val = Math.max(-1, Math.min(1, b.valence));
    g.fillStyle = val >= 0 ? C.green : C.red;
    g.fillRect(val >= 0 ? mid : mid + (val * vw) / 2, 374, (Math.abs(val) * vw) / 2, 12);
    g.strokeStyle = C.text;
    g.beginPath(); g.moveTo(mid, 371); g.lineTo(mid, 389); g.stroke();
    g.fillStyle = C.dim;
    g.font = '9px ui-monospace, Menlo, monospace';
    g.fillText(`approach ${b.mb.mbonApproach.toFixed(2)}`, 12, 402);
    g.fillText(`avoid ${b.mb.mbonAvoid.toFixed(2)}`, 112, 402);
    g.fillStyle = val >= 0 ? C.green : C.red;
    g.fillText(`valence ${b.valence >= 0 ? '+' : ''}${b.valence.toFixed(3)}`, 196, 402);

    // ---------------- learned species values
    this.panel(6, 418, W - 12, 106, 'LEARNED VALUE  (KC→MBON weights)');
    const sv = this.sim.speciesValence();
    sv.forEach((s, i) => {
      const y = 436 + i * 21;
      g.fillStyle = '#' + s.color.toString(16).padStart(6, '0');
      g.fillRect(12, y - 7, 9, 9);
      g.fillStyle = C.text;
      g.font = '9px ui-monospace, Menlo, monospace';
      g.fillText(s.name, 27, y + 1);
      g.fillStyle = s.payoff > 0 ? C.green : C.red;
      g.fillText(s.payoff > 0 ? 'nectar' : 'toxin', 84, y + 1);

      const bx = 136, bw2 = 150;
      g.fillStyle = '#2e2a36';
      g.fillRect(bx, y - 6, bw2, 8);
      const m2 = bx + bw2 / 2;
      const v2 = Math.max(-1, Math.min(1, s.valence));
      g.fillStyle = v2 >= 0 ? C.green : C.red;
      g.fillRect(v2 >= 0 ? m2 : m2 + (v2 * bw2) / 2, y - 6, (Math.abs(v2) * bw2) / 2, 8);
      g.strokeStyle = C.dim;
      g.beginPath(); g.moveTo(m2, y - 8); g.lineTo(m2, y + 4); g.stroke();
      const good = Math.sign(s.valence) === Math.sign(s.payoff) && Math.abs(s.valence) > 0.03;
      g.fillStyle = good ? C.green : C.dim;
      g.fillText(good ? '✓' : '?', bx + bw2 + 5, y + 1);
    });

    // ---------------- controls
    g.fillStyle = C.dim;
    g.font = '9px ui-monospace, Menlo, monospace';
    const keys = '[space] pause  [1/2/3] speed  [c] cam  [p] plumes  [f] flip world  [r] reset brain  [h] hud';
    let yy = 540;
    for (const line of keys.match(/.{1,44}(\s|$)/g)) { g.fillText(line.trim(), 10, yy); yy += 12; }
  }
}
