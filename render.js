// three.js view of the sim. Renders the scene into a small offscreen target,
// then upscales through a palette-quantizing dither shader for the 8-bit look.

import * as THREE from './vendor/three.module.js';
import { WORLD, PLUME_R, SPECIES } from './sim.js';
import { wrapPi } from './brain.js';

// 16 colors, chosen for THIS scene rather than borrowed. A general-purpose
// retro palette (DB16) only has two greens, so Lambert-shaded grass has
// nowhere to land and the whole ground collapses to one flat block. Four
// green levels give the terrain real shading; the four flower hues are exact
// matches so petals never drift to a neighbouring color.
const SKY = 0x6ec0e0;
const PALETTE = [
  0x101018, 0x3a3a48, 0x6b4a2a, 0xd8a060,   // ink, shadow, earth, tan
  0x2c5a1e, 0x3f7a28, 0x5ea832, 0x8fd04a,   // grass: dark -> highlight
  0x4a90c0, SKY, 0xa8b0b8, 0xf0f4e0,        // sky deep/light, grey, white
  0x4878d0, 0xf0c040, 0xd04648, 0x9050c8,   // bluebell, goldstar, redcap, violet
];

// Trail colors, one palette entry per behaviour state. Vertex colors are read
// as already being in the linear working space, so these have to be converted
// from the sRGB hex or they land on the wrong palette entry after quantization
// (grey #a8b0b8 was arriving as tan).
const BEH_COLOR = Object.fromEntries(
  Object.entries({ SEARCH: 0xa8b0b8, TRACK: 0x8fd04a, AVOID: 0xd04648, FEED: 0xf0c040 })
    .map(([k, hex]) => { const c = new THREE.Color(hex); return [k, [c.r, c.g, c.b]]; })
);

const PIXEL_H = 200;   // internal render height; width follows aspect

const QUAD_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Linear -> sRGB, 4x4 Bayer dither, then snap to the nearest palette entry.
// The dither is what stops large gradients (sky, ground) from banding into
// flat blocks once the palette is only 16 colors wide.
const QUAD_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec3 palette[16];
uniform vec2 resolution;
uniform float ditherAmt;
uniform float quantize;

float bayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = y * 4 + x;
  float m[16];
  m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
  m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
  m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
  m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
  for (int k = 0; k < 16; k++) { if (k == i) return m[k] / 16.0 - 0.5; }
  return 0.0;
}

void main() {
  vec3 lin = texture2D(tDiffuse, vUv).rgb;
  vec3 c = pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2));
  if (quantize < 0.5) { gl_FragColor = vec4(c, 1.0); return; }
  c += bayer(vUv * resolution) * ditherAmt;
  c = clamp(c, 0.0, 1.0);

  float bestD = 1e9;
  vec3 best = palette[0];
  for (int i = 0; i < 16; i++) {
    vec3 d = c - palette[i];
    float dist = dot(d, d);
    if (dist < bestD) { bestD = dist; best = palette[i]; }
  }
  gl_FragColor = vec4(best, 1.0);
}
`;

function grassTexture(maxAniso) {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#3f7a28';
  g.fillRect(0, 0, S, S);
  // Only palette-exact greens, and sparse: anything denser reads as static
  // once the whole frame is quantized to 16 colors.
  for (let i = 0; i < 150; i++) {
    g.fillStyle = i % 3 === 0 ? '#5ea832' : '#2c5a1e';
    g.fillRect((Math.random() * S) | 0, (Math.random() * S) | 0, 2, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  // Mipmaps are essential here. A repeating texture viewed at a grazing angle
  // with NearestFilter aliases into crawling noise, which the palette pass
  // then amplifies into full-contrast speckle.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAniso;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  return tex;
}

export class View {
  constructor(canvas, sim) {
    this.sim = sim;
    this.cameraMode = 0;
    this.showPlumes = false;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);

    this.scene = new THREE.Scene();
    const sky = new THREE.Color(SKY);
    this.scene.background = sky;
    // A flat plane runs to the horizon, so a huge share of screen area is
    // "far". Fog has to start beyond the whole arena (radius ~57) or it eats
    // the grass and greys out the world.
    this.scene.fog = new THREE.Fog(sky, 125, 300);

    this.scene.add(new THREE.HemisphereLight(0xf0f4e0, 0x2c5a1e, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(40, 70, 25);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD * 9, WORLD * 9),
      new THREE.MeshLambertMaterial({ map: grassTexture(this.renderer.capabilities.getMaxAnisotropy()) })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    this.flowerGroups = sim.flowers.map((f) => this.buildFlower(f));
    this.fly = this.buildFly();
    this.scene.add(this.fly.group);

    this.markers = [];
    this.markerPool = [];
    this.trail = this.buildTrail();

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);
    this.camRig = new THREE.Vector3(0, 6, -10);
    this.camLook = new THREE.Vector3();
    this.camYaw = 0;

    // offscreen low-res target + fullscreen quad
    this.rt = new THREE.WebGLRenderTarget(320, PIXEL_H, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.Camera();
    this.quadMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        // Vector3, NOT Color. THREE.Color assumes a hex literal is sRGB and
        // converts it into the linear working space, which would leave the
        // palette linear while the pixels being matched are sRGB-encoded --
        // every green then snaps to the nearest linear grey.
        palette: {
          value: PALETTE.map((h) => new THREE.Vector3(
            ((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255)),
        },
        resolution: { value: new THREE.Vector2(320, PIXEL_H) },
        ditherAmt: { value: 0.03 },
        quantize: { value: 1 },
      },
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildFlower(f) {
    const g = new THREE.Group();
    const sp = SPECIES[f.species];
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.1, 2.2, 5),
      new THREE.MeshLambertMaterial({ color: 0x2c5a1e, flatShading: true })
    );
    stem.position.y = 1.1;
    g.add(stem);

    // Flat hex petals read clearly from the top-down camera, where a sphere
    // of radius 0.85 is only a few pixels across. Unlit on purpose: Lambert
    // shading scales the hue below its exact palette entry, so a lit blue
    // petal quantizes to the dark shadow color and species become
    // indistinguishable -- which defeats the point of watching what it eats.
    const petals = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 6),
      new THREE.MeshBasicMaterial({ color: sp.color, side: THREE.DoubleSide })
    );
    petals.rotation.x = -Math.PI / 2;
    petals.position.y = 2.28;
    g.add(petals);

    const head = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.7, 0),
      new THREE.MeshBasicMaterial({ color: sp.color })
    );
    head.position.y = 2.35;
    g.add(head);

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshBasicMaterial({ color: 0xf0c040 })
    );
    core.position.y = 2.35;
    g.add(core);

    const plume = new THREE.Mesh(
      new THREE.SphereGeometry(PLUME_R, 10, 8),
      new THREE.MeshBasicMaterial({
        color: sp.color, transparent: true, opacity: 0.13,
        depthWrite: false, side: THREE.BackSide,
      })
    );
    plume.position.y = 2.0;
    plume.visible = false;
    g.add(plume);

    g.position.set(f.x, 0, f.z);
    g.scale.setScalar(f.scale);
    this.scene.add(g);
    return { group: g, head, core, plume, stem, petals };
  }

  buildFly() {
    const group = new THREE.Group();
    const body = new THREE.MeshLambertMaterial({ color: 0x3a3a48, flatShading: true });
    const thorax = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), body);
    group.add(thorax);
    const abdomen = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), body);
    abdomen.position.set(0, -0.03, -0.4);
    abdomen.scale.set(1, 0.85, 1.5);
    group.add(abdomen);
    const head = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.2, 0),
      new THREE.MeshLambertMaterial({ color: 0xd04648, flatShading: true })
    );
    head.position.set(0, 0.05, 0.34);
    group.add(head);

    const wingMat = new THREE.MeshBasicMaterial({
      color: 0xf0f4e0, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false,
    });
    const wings = [-1, 1].map((s) => {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.2), wingMat);
      w.position.set(s * 0.3, 0.14, -0.1);
      w.rotation.y = s * 0.3;
      group.add(w);
      return w;
    });

    // a small cone showing where the CX thinks north is
    const compass = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.5, 4),
      new THREE.MeshBasicMaterial({ color: 0xf0c040 })
    );
    compass.position.y = 0.85;
    compass.rotation.x = Math.PI / 2;
    group.add(compass);

    return { group, wings, compass, head };
  }

  buildTrail() {
    const MAX = 900;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    line.frustumCulled = false;
    this.scene.add(line);
    return { line, geo, pos, col, n: 0, max: MAX };
  }

  pushTrail(x, y, z, behavior) {
    const t = this.trail;
    const c = BEH_COLOR[behavior] || BEH_COLOR.SEARCH;
    if (t.n >= t.max) {
      t.pos.copyWithin(0, 3);
      t.col.copyWithin(0, 3);
      t.n = t.max - 1;
    }
    const i = t.n * 3;
    t.pos[i] = x; t.pos[i + 1] = y; t.pos[i + 2] = z;
    t.col[i] = c[0]; t.col[i + 1] = c[1]; t.col[i + 2] = c[2];
    t.n++;
    t.geo.attributes.position.needsUpdate = true;
    t.geo.attributes.color.needsUpdate = true;
    t.geo.setDrawRange(0, t.n);
  }

  // Persistent ground dots recording what happened where.
  addMarker(kind, x, z) {
    const color = kind === 'nectar' ? 0x5ea832 : kind === 'toxin' ? 0xd04648 : 0xf0c040;
    let m = this.markerPool.pop();
    if (!m) {
      m = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      );
      m.rotation.x = -Math.PI / 2;
      this.scene.add(m);
    }
    m.material.color.setHex(color);
    m.visible = true;
    m.position.set(x, 0.05, z);
    m.scale.setScalar(kind === 'reject' ? 0.7 : 1.0);
    this.markers.push(m);
    if (this.markers.length > 160) {
      const old = this.markers.shift();
      old.visible = false;
      this.markerPool.push(old);
    }
  }

  clearMarkers() {
    for (const m of this.markers) { m.visible = false; this.markerPool.push(m); }
    this.markers.length = 0;
    this.trail.n = 0;
    this.trail.geo.setDrawRange(0, 0);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const pw = Math.max(80, Math.round((PIXEL_H * w) / h));
    this.rt.setSize(pw, PIXEL_H);
    this.quadMat.uniforms.resolution.value.set(pw, PIXEL_H);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dtReal) {
    const { sim } = this;
    const f = sim.fly;

    this.fly.group.position.set(f.x, f.y, f.z);
    this.fly.group.rotation.y = f.yaw;
    const flap = Math.sin(performance.now() * 0.06) * 0.65;
    this.fly.wings[0].rotation.z = flap;
    this.fly.wings[1].rotation.z = -flap;
    // compass cone points where the CX bump says, not where the body points
    this.fly.compass.rotation.z = -(sim.brain.heading - f.yaw);

    for (let i = 0; i < sim.flowers.length; i++) {
      const fl = sim.flowers[i], gv = this.flowerGroups[i];
      const s = 0.45 + 0.55 * fl.nectar;
      gv.head.scale.setScalar(s);
      gv.core.visible = fl.nectar > 0.5;
      gv.plume.visible = this.showPlumes;
      gv.group.rotation.y = Math.sin(sim.t * 0.7 + fl.phase) * 0.12;
    }

    this.updateCamera(dtReal);
  }

  updateCamera(dtReal) {
    const f = this.sim.fly;
    const k = Math.min(1, dtReal * 4.5);
    if (this.cameraMode === 0) {
      // Smooth the heading and derive both points from it, rather than
      // lerping two independent world points: the fly saccades hard enough
      // that separate lerps let the look target drift back toward the camera,
      // collapsing the 10-unit baseline and pitching the view into the dirt.
      this.camYaw += wrapPi(f.yaw - this.camYaw) * k;
      const s = Math.sin(this.camYaw), c = Math.cos(this.camYaw);
      this.camRig.lerp(new THREE.Vector3(f.x - s * 7, f.y + 2.4, f.z - c * 7), k);
      this.camera.position.copy(this.camRig);
      this.camera.lookAt(f.x + s * 5, f.y + 1.2, f.z + c * 5);
    } else if (this.cameraMode === 1) {
      // High enough to frame the whole arena, so you can watch the fly work
      // the flower field rather than a patch of grass.
      this.camera.position.set(f.x * 0.3, 108, f.z * 0.3 + 0.01);
      this.camera.lookAt(f.x * 0.3, 0, f.z * 0.3);
    } else {
      const a = this.sim.t * 0.12;
      this.camera.position.set(Math.sin(a) * 78, 52, Math.cos(a) * 78);
      this.camera.lookAt(0, 0, 0);
    }
  }

  render() {
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }
}
