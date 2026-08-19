// Word Grove — Three.js presentation layer.
// The grove is the visual hero: a tranquil procedural scene where solved
// words grow flowers. The canvas is never the only UI — interaction happens
// through DOM controls aligned to projected scene anchors (see projectTile).

import * as THREE from '../vendor/three.module.min.js';
import { makeRng, hashString } from './rng.js';
import { themeById } from './content.js';

// Authored camera framing constants (no magic offsets elsewhere).
export const FRAMING = {
  fov: 34,
  wheelRadius: 2.1,
  wheelY: 0.55,
  wheelZ: 1.5, // wheel sits in the lower half of the frame; grid owns the top
  camera: {
    landscape: { pos: [0, 5.2, 9.6], look: [0, 0.5, 0.9], fov: 34 },
    portrait: { pos: [0, 7.4, 14.2], look: [0, 0.1, 1.7], fov: 52 },
  },
  swayAmplitude: 0.08,
  swayPeriodSec: 11,
};

const QUALITY = {
  high: { dpr: 2, shadows: true, trees: 9, particles: 400, fireflies: 120 },
  medium: { dpr: 1.5, shadows: true, trees: 6, particles: 200, fireflies: 60 },
  low: { dpr: 1, shadows: false, trees: 4, particles: 80, fireflies: 0 },
};

// Critically damped spring (interruption-safe; no cumulative lerp).
function spring(current, target, velocity, smoothTime, dt) {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  velocity = (velocity - omega * temp) * exp;
  return [target + (change + temp) * exp, velocity];
}

function roundedRectTexture(letter, opts = {}) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.fillStyle = opts.color || '#2e2418';
  g.font = `700 ${size * 0.52}px Georgia, 'Times New Roman', serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter.toUpperCase(), size / 2, size * 0.54);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Procedural tree: tapered, bent trunk + displaced canopy blobs. Authored,
// seeded, inspectable — not primitive placeholders.
function makeTree(rng, theme, highDetail) {
  const group = new THREE.Group();
  const height = rng.range(2.6, 4.2);
  const bend = rng.range(-0.25, 0.25);
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector3(bend * t * t * height, t * height, Math.sin(t * 3) * 0.06));
  }
  const trunkGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.14, highDetail ? 7 : 5, false);
  const trunk = new THREE.Mesh(trunkGeo, new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 0.95, flatShading: true }));
  trunk.castShadow = true;
  group.add(trunk);

  const blobs = highDetail ? 3 : 2;
  for (let b = 0; b < blobs; b++) {
    const r = rng.range(0.7, 1.25);
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      const n = 1 + 0.22 * Math.sin(v.x * 5.1 + b) * Math.cos(v.y * 4.3) + rng.range(-0.06, 0.06);
      v.multiplyScalar(n);
      pos.setXYZ(i, v.x, v.y * 0.82, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: b % 2 ? theme.foliageAlt : theme.foliage, roughness: 0.9, flatShading: true,
    });
    const blob = new THREE.Mesh(geo, mat);
    blob.position.set(bend * height + rng.range(-0.5, 0.5), height + rng.range(-0.3, 0.6), rng.range(-0.5, 0.5));
    blob.castShadow = true;
    group.add(blob);
  }
  return group;
}

function makeRock(rng, theme) {
  const geo = new THREE.IcosahedronGeometry(rng.range(0.18, 0.42), 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + rng.range(-0.25, 0.25));
    pos.setXYZ(i, v.x, v.y * 0.6, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a8d84, roughness: 1, flatShading: true }));
  m.castShadow = true;
  return m;
}

// A flower: bent stem + petal ring + center. Grows when a word is planted.
function makeFlower(rng, theme, big) {
  const group = new THREE.Group();
  const h = big ? rng.range(0.9, 1.3) : rng.range(0.35, 0.55);
  const sway = rng.range(-0.3, 0.3);
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(sway * 0.3, h * 0.5, 0), new THREE.Vector3(sway, h, 0)];
  const stem = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, big ? 0.03 : 0.018, 5, false),
    new THREE.MeshStandardMaterial({ color: 0x3f6b35, roughness: 0.9 })
  );
  group.add(stem);
  const head = new THREE.Group();
  head.position.set(sway, h, 0);
  const petals = big ? 6 + rng.int(3) : 5;
  const petalColor = rng() < 0.5 ? theme.flower : theme.flowerAlt;
  const petalMat = new THREE.MeshStandardMaterial({ color: petalColor, roughness: 0.6, side: THREE.DoubleSide });
  for (let i = 0; i < petals; i++) {
    const p = new THREE.Mesh(new THREE.CircleGeometry(big ? 0.16 : 0.08, 6), petalMat);
    const a = (i / petals) * Math.PI * 2;
    p.position.set(Math.cos(a) * (big ? 0.16 : 0.09), 0, Math.sin(a) * (big ? 0.16 : 0.09));
    p.rotation.set(-Math.PI / 2 + 0.5, 0, -a + Math.PI / 2);
    p.scale.set(1, 1.6, 1);
    head.add(p);
  }
  const center = new THREE.Mesh(
    new THREE.SphereGeometry(big ? 0.09 : 0.05, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xf2d544, roughness: 0.5, emissive: 0x332200 })
  );
  head.add(center);
  group.add(head);
  group.userData.head = head;
  group.userData.height = h;
  return group;
}

export class GroveRenderer {
  constructor(canvas, { settings, theme: themeId, seed }) {
    this.canvas = canvas;
    this.settings = settings;
    this.theme = themeById(themeId);
    this.visualRng = makeRng('visual:' + seed);
    this.tiles = [];
    this.flowers = [];
    this.pendingBursts = [];
    this.time = 0;
    this.swayT = 0;
    this.selectedSet = new Set();
    this.disposed = false;
    this.failed = false;

    const q = this.qualityTier();
    this.q = q;

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.dpr > 1, powerPreference: 'default' });
    } catch (e) {
      this.failed = true;
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(this.theme.fog, 14, 34);
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.rebuild(); });

    this.buildEnvironment();
    this.buildWheelBase();
    this.buildParticles();
    this.resize();
  }

  qualityTier() {
    const pref = this.settings.quality;
    if (pref !== 'auto') return QUALITY[pref] || QUALITY.medium;
    const mobile = /Mobi|Android/i.test(navigator.userAgent);
    const mem = navigator.deviceMemory || 4;
    return mobile || mem <= 4 ? QUALITY.low : QUALITY.high;
  }

  setQuality(tierId) {
    this.settings.quality = tierId;
    const q = this.qualityTier();
    this.q = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.renderer.shadowMap.enabled = q.shadows;
    this.rebuild();
  }

  rebuild() {
    // Rebuild GPU resources from retained CPU descriptors.
    const tiles = this.tiles.map((t) => t.letter);
    this.scene.clear();
    this.tiles = [];
    this.flowers = [];
    this.buildEnvironment();
    this.buildWheelBase();
    this.buildParticles();
    if (tiles.length) this.setLetters(tiles);
    this.resize();
  }

  setTheme(themeId) {
    this.theme = themeById(themeId);
    this.rebuild();
  }

  buildEnvironment() {
    const t = this.theme;
    const rng = this.visualRng.fork('env');

    // Sky dome: canvas gradient on an inverted sphere (no post-processing).
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 4; skyCanvas.height = 256;
    const sg = skyCanvas.getContext('2d');
    const grad = sg.createLinearGradient(0, 0, 0, 256);
    const c = (hex) => '#' + hex.toString(16).padStart(6, '0');
    grad.addColorStop(0, c(t.sky));
    grad.addColorStop(0.62, c(t.sky));
    grad.addColorStop(1, c(t.horizon));
    sg.fillStyle = grad; sg.fillRect(0, 0, 4, 256);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(45, 24, 12),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    this.scene.add(sky);

    // Lights: one dominant key, soft environment fill.
    const key = new THREE.DirectionalLight(t.light, t.lightIntensity);
    key.position.set(4, 10, 8); // frontal key: tree shadows fall away from camera
    key.castShadow = this.q.shadows;
    if (this.q.shadows) {
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -8; key.shadow.camera.right = 8;
      key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
      key.shadow.bias = -0.0005;
    }
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(t.ambient, t.ground, 1.3));

    // Ground: displaced disc with vertex color variation.
    const groundGeo = new THREE.CircleGeometry(26, 48, 0, Math.PI * 2);
    groundGeo.rotateX(-Math.PI / 2);
    const gpos = groundGeo.attributes.position;
    const colors = new Float32Array(gpos.count * 3);
    const base = new THREE.Color(t.ground);
    for (let i = 0; i < gpos.count; i++) {
      const x = gpos.getX(i), z = gpos.getZ(i);
      const d = Math.hypot(x, z);
      gpos.setY(i, d > 5 ? (Math.sin(x * 0.7) * Math.cos(z * 0.6)) * 0.25 * Math.min(1, (d - 5) / 4) : 0);
      const shade = 0.85 + 0.3 * Math.sin(x * 1.7 + z * 2.3);
      colors[i * 3] = base.r * shade; colors[i * 3 + 1] = base.g * shade; colors[i * 3 + 2] = base.b * shade;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Tree ring.
    const treeCount = this.q.trees;
    for (let i = 0; i < treeCount; i++) {
      const a = (i / treeCount) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = rng.range(9, 15);
      const tree = makeTree(rng, t, this.q === QUALITY.high);
      // Keep trees behind the playfield, never between camera and wheel.
      tree.position.set(Math.cos(a) * r, 0, -Math.abs(Math.sin(a) * r) - 2);
      tree.rotation.y = rng.range(0, Math.PI * 2);
      const s = rng.range(0.8, 1.4);
      tree.scale.set(s, s, s);
      this.scene.add(tree);
    }
    // Rocks and a small pond.
    for (let i = 0; i < 5; i++) {
      const rock = makeRock(rng, t);
      const a = rng.range(0, Math.PI * 2);
      rock.position.set(Math.cos(a) * rng.range(4, 7), 0.05, Math.sin(a) * rng.range(3, 6) - 1);
      this.scene.add(rock);
    }
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 20),
      new THREE.MeshStandardMaterial({ color: t.water, roughness: 0.15, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(-3.9, 0.08, 0.6);
    this.scene.add(pond);

    // Fireflies (dusk/night tiers).
    if (this.q.fireflies > 0 && (t.id === 'night' || t.id === 'dusk')) {
      const n = this.q.fireflies;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      this.fireflySeeds = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = rng.range(-10, 10);
        pos[i * 3 + 1] = rng.range(0.3, 3.5);
        pos[i * 3 + 2] = rng.range(-8, 6);
        this.fireflySeeds[i * 2] = rng.range(0, 100);
        this.fireflySeeds[i * 2 + 1] = rng.range(0.3, 1);
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.fireflies = new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0xd8f090, size: 0.06, transparent: true, opacity: 0.9, sizeAttenuation: true,
      }));
      this.fireflies.raycast = () => {}; // cosmetic: never intercept picking
      this.scene.add(this.fireflies);
    }
  }

  buildWheelBase() {
    // Grounded wooden disc under the letter tiles.
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(FRAMING.wheelRadius + 0.55, FRAMING.wheelRadius + 0.7, 0.18, 40),
      new THREE.MeshStandardMaterial({ color: this.theme.trunk, roughness: 0.85 })
    );
    base.position.set(0, 0.09, FRAMING.wheelZ);
    base.receiveShadow = true;
    this.scene.add(base);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(FRAMING.wheelRadius + 0.62, 0.05, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.7 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 0.19, FRAMING.wheelZ);
    this.scene.add(rim);

    // Selection path segments (pooled cylinders).
    this.pathSegments = [];
    const segMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 7; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 6), segMat);
      seg.visible = false;
      seg.raycast = () => {};
      this.scene.add(seg);
      this.pathSegments.push(seg);
    }
    this.cursorDot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), segMat.clone());
    this.cursorDot.visible = false;
    this.cursorDot.raycast = () => {};
    this.scene.add(this.cursorDot);
  }

  buildParticles() {
    // Pooled burst particles (leaf-green); bounded by tier.
    const n = this.q.particles;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.burstVel = new Float32Array(n * 3);
    this.burstLife = new Float32Array(n);
    this.burstCount = n;
    this.burst = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xa8d878, size: 0.09, transparent: true, opacity: 0.95, sizeAttenuation: true,
    }));
    this.burst.raycast = () => {};
    this.burst.frustumCulled = false;
    this.scene.add(this.burst);
  }

  // ------------------------------------------------------------ letters ---

  setLetters(letters) {
    for (const t of this.tiles) { this.scene.remove(t.group); disposeTile(t); }
    this.tiles = letters.map((letter, i) => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.46, 0.22, 24),
        new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 0.55 })
      );
      body.castShadow = true;
      body.position.y = 0.11;
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.4, 24),
        new THREE.MeshBasicMaterial({ map: roundedRectTexture(letter, this.textColors()), transparent: true })
      );
      face.rotation.x = -Math.PI / 2;
      face.position.y = 0.225;
      const marker = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.035, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0 })
      );
      marker.rotation.x = Math.PI / 2;
      marker.position.y = 0.02;
      marker.raycast = () => {};
      group.add(body, face, marker);
      this.scene.add(group);
      return { letter, group, body, face, marker, lift: 0, liftVel: 0, spin: 0, spinTarget: 0 };
    });
    this.layoutTiles(true);
  }

  textColors() {
    const palette = this.settings.palette;
    if (palette === 'deuteranopia' || palette === 'protanopia') return { color: '#1a237e' };
    if (palette === 'tritanopia') return { color: '#4a148c' };
    return { color: this.settings.highContrast ? '#000000' : '#2e2418' };
  }

  layoutTiles(snap = false) {
    const n = this.tiles.length;
    if (!n) return;
    this.tiles.forEach((t, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      t.targetX = Math.cos(a) * FRAMING.wheelRadius;
      t.targetZ = Math.sin(a) * FRAMING.wheelRadius + FRAMING.wheelZ;
      if (snap) {
        t.group.position.set(t.targetX, FRAMING.wheelY, t.targetZ);
        t.x = t.targetX; t.z = t.targetZ;
        t.vx = 0; t.vz = 0;
      }
    });
  }

  shuffleVisual() {
    // Tiles spin as they move to their new slots.
    for (const t of this.tiles) t.spinTarget += Math.PI * 2;
  }

  setSelection(indices, cursorWorld = null) {
    this.selectedSet = new Set(indices);
    // Path segments between consecutive selected tiles.
    const pts = indices.map((i) => this.tiles[i]).filter(Boolean);
    this.pathSegments.forEach((seg, i) => {
      if (i < pts.length - 1) {
        const a = pts[i].group.position, b = pts[i + 1].group.position;
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        seg.position.set(mid.x, FRAMING.wheelY + 0.3, mid.z);
        const dir = new THREE.Vector3().subVectors(b, a);
        seg.scale.set(1, dir.length(), 1);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        seg.visible = true;
      } else seg.visible = false;
    });
    if (cursorWorld && pts.length) {
      this.cursorDot.visible = true;
      this.cursorDot.position.set(cursorWorld.x, FRAMING.wheelY + 0.3, cursorWorld.z);
      const last = pts[pts.length - 1].group.position;
      const seg = this.pathSegments[pts.length - 1];
      if (seg) {
        const dir = new THREE.Vector3(cursorWorld.x - last.x, 0, cursorWorld.z - last.z);
        if (dir.length() > 0.05) {
          seg.visible = true;
          seg.position.set((cursorWorld.x + last.x) / 2, FRAMING.wheelY + 0.3, (cursorWorld.z + last.z) / 2);
          seg.scale.set(1, dir.length(), 1);
          seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        }
      }
    } else this.cursorDot.visible = false;
  }

  // ------------------------------------------------------------- events ---

  resetGarden() {
    for (const f of this.flowers) this.scene.remove(f);
    this.flowers = [];
    for (let i = 0; i < this.burstCount; i++) this.burstLife[i] = 0;
    this.setSelection([]);
  }

  bloomWord(kind, label) {
    const rng = makeRng('flower:' + label + ':' + this.flowers.length);
    const big = kind === 'target';
    const flower = makeFlower(rng, this.theme, big);
    const idx = this.flowers.length;
    // Deterministic slots around the wheel, alternating sides.
    const a = -Math.PI * 0.15 - (idx % 5) * 0.5 + (idx >= 5 ? -0.25 : 0);
    const r = 4.2 + (idx % 3) * 0.9 + rng.range(-0.3, 0.3);
    const side = idx % 2 === 0 ? 1 : -1;
    flower.position.set(Math.cos(a) * r * side * 0.9, 0, 2.2 + Math.sin(a * 2) * 1.2 + (idx >= 5 ? -2.2 : 0));
    flower.scale.setScalar(0.01);
    flower.userData.grow = 0;
    flower.userData.rngPhase = rng.range(0, Math.PI * 2);
    this.scene.add(flower);
    this.flowers.push(flower);
    if (!this.settings.reducedMotion) this.spawnBurst(flower.position, big ? 40 : 18);
  }

  hintBloom() {
    // Small pollen puff above the wheel.
    if (!this.settings.reducedMotion) this.spawnBurst(new THREE.Vector3(0, 1.5, 0), 10, 0xffe9a8);
  }

  celebrate() {
    if (!this.settings.reducedMotion) {
      for (let i = 0; i < 4; i++) {
        this.spawnBurst(new THREE.Vector3((i - 1.5) * 1.5, 1.2, 0), 40, i % 2 ? 0xffe9a8 : 0xa8d878);
      }
    }
    for (const f of this.flowers) f.userData.cheer = 1;
  }

  spawnBurst(origin, count, color = null) {
    const posAttr = this.burst.geometry.attributes.position;
    let placed = 0;
    for (let i = 0; i < this.burstCount && placed < count; i++) {
      if (this.burstLife[i] > 0) continue;
      this.burstLife[i] = 1 + Math.random() * 0.8;
      posAttr.setXYZ(i, origin.x, origin.y + 0.3, origin.z);
      const a = Math.random() * Math.PI * 2;
      const v = 1 + Math.random() * 2;
      this.burstVel[i * 3] = Math.cos(a) * v;
      this.burstVel[i * 3 + 1] = 1.5 + Math.random() * 2;
      this.burstVel[i * 3 + 2] = Math.sin(a) * v;
      placed++;
    }
    if (color) this.burst.material.color.setHex(color);
    posAttr.needsUpdate = true;
  }

  // ---------------------------------------------------------------- loop ---

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = h > w;
    const cfg = portrait ? FRAMING.camera.portrait : FRAMING.camera.landscape;
    this.camera.fov = cfg.fov;
    this.camera.updateProjectionMatrix();
    this.camBase = new THREE.Vector3(...cfg.pos);
    this.camLook = new THREE.Vector3(...cfg.look);
  }

  update(dtMs) {
    if (this.failed || this.contextLost) return;
    const dt = Math.min(dtMs, 100) / 1000;
    this.time += dt;
    const rm = this.settings.reducedMotion;

    // Camera: authored position + gentle sway (never cumulative lerp).
    if (!rm && this.settings.cameraSway !== false) {
      this.swayT += dt;
      const a = FRAMING.swayAmplitude;
      const p = (this.swayT / FRAMING.swayPeriodSec) * Math.PI * 2;
      this.camera.position.set(
        this.camBase.x + Math.sin(p) * a,
        this.camBase.y + Math.sin(p * 0.7 + 1) * a * 0.5,
        this.camBase.z
      );
    } else {
      this.camera.position.copy(this.camBase);
    }
    this.camera.lookAt(this.camLook);

    // Tiles: spring to slots, lift when selected.
    this.tiles.forEach((t, i) => {
      const sel = this.selectedSet.has(i);
      const targetLift = sel ? 0.32 : 0;
      [t.lift, t.liftVel] = spring(t.lift, targetLift, t.liftVel, 0.12, dt);
      if (t.x === undefined) { t.x = t.targetX; t.z = t.targetZ; t.vx = 0; t.vz = 0; }
      [t.x, t.vx] = spring(t.x, t.targetX, t.vx, 0.25, dt);
      [t.z, t.vz] = spring(t.z, t.targetZ, t.vz, 0.25, dt);
      t.group.position.set(t.x, FRAMING.wheelY + t.lift, t.z);
      t.spin = t.spin + (t.spinTarget - t.spin) * Math.min(1, dt * 8);
      t.body.rotation.y = t.spin;
      t.marker.material.opacity += ((sel ? 0.95 : 0) - t.marker.material.opacity) * Math.min(1, dt * 12);
      t.body.material.emissive = t.body.material.emissive || new THREE.Color(0);
      t.body.material.emissive.setHex(sel ? 0x332a08 : 0x000000);
    });

    // Flowers grow, then sway gently.
    for (const f of this.flowers) {
      if (f.userData.grow < 1) {
        f.userData.grow = Math.min(1, f.userData.grow + dt * (rm ? 4 : 1.4));
        const s = rm ? (f.userData.grow >= 1 ? 1 : 0.01) : easeOutBack(f.userData.grow);
        f.scale.setScalar(Math.max(0.01, s));
      } else if (!rm) {
        const ph = f.userData.rngPhase;
        f.rotation.z = Math.sin(this.time * 1.1 + ph) * 0.05 * (f.userData.cheer ? 3 : 1);
        if (f.userData.cheer) {
          f.userData.cheer = Math.max(0, f.userData.cheer - dt * 0.5);
          f.userData.head.rotation.y += dt * 6 * f.userData.cheer;
        }
      }
    }

    // Particles.
    if (!rm) {
      const posAttr = this.burst.geometry.attributes.position;
      let any = false;
      for (let i = 0; i < this.burstCount; i++) {
        if (this.burstLife[i] <= 0) continue;
        any = true;
        this.burstLife[i] -= dt;
        this.burstVel[i * 3 + 1] -= 4 * dt;
        posAttr.setXYZ(i,
          posAttr.getX(i) + this.burstVel[i * 3] * dt,
          Math.max(0.02, posAttr.getY(i) + this.burstVel[i * 3 + 1] * dt),
          posAttr.getZ(i) + this.burstVel[i * 3 + 2] * dt);
        if (this.burstLife[i] <= 0) posAttr.setXYZ(i, 0, -10, 0);
      }
      if (any) posAttr.needsUpdate = true;
      if (this.fireflies) {
        const fp = this.fireflies.geometry.attributes.position;
        for (let i = 0; i < fp.count; i++) {
          const s = this.fireflySeeds[i * 2], sp = this.fireflySeeds[i * 2 + 1];
          fp.setX(i, fp.getX(i) + Math.sin(this.time * sp + s) * 0.004);
          fp.setY(i, fp.getY(i) + Math.cos(this.time * sp * 0.7 + s) * 0.003);
        }
        fp.needsUpdate = true;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  // World → CSS pixel position of a tile (single shared layout model so DOM
  // labels/controls align exactly with the 3D wheel).
  projectTile(i) {
    const t = this.tiles[i];
    if (!t) return null;
    const v = t.group.position.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
  }

  screenToWheel(clientX, clientY) {
    // Map screen point onto the wheel plane (y = wheelY) for drag cursor.
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FRAMING.wheelY);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? { x: out.x, z: out.z } : null;
  }

  settle() {
    // Skip/fast-forward: land every object in its exact deterministic end state.
    for (const t of this.tiles) {
      t.group.position.set(t.targetX, FRAMING.wheelY + (this.selectedSet.has(this.tiles.indexOf(t)) ? 0.32 : 0), t.targetZ);
      t.spin = t.spinTarget;
    }
    for (const f of this.flowers) { f.userData.grow = 1; f.scale.setScalar(1); }
    for (let i = 0; i < this.burstCount; i++) this.burstLife[i] = 0;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
    this.renderer.dispose();
  }
}

function disposeTile(t) {
  t.body.geometry.dispose(); t.body.material.dispose();
  t.face.geometry.dispose(); t.face.material.map.dispose(); t.face.material.dispose();
  t.marker.geometry.dispose(); t.marker.material.dispose();
}

function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
