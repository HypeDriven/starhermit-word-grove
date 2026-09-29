// Word Grove — Three.js presentation layer.
// The grove is the visual hero: a tranquil procedural scene where solved
// words grow flowers. The canvas is never the only UI — interaction happens
// through DOM controls aligned to projected scene anchors (see projectTile).
// Graphics quality (shadows, post-processing, IBL, particles, ambient motion,
// scene detail, render scale) comes from the pure model in gfx.js.

import * as THREE from '../vendor/three.module.min.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { makeRng } from './rng.js';
import { themeById } from './content.js';
import { detectPreset, resolve, describe, SHADOW_MAP } from './gfx.js';

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

// Scene radiance is authored at 1/EXPOSURE and the tone mapper scales it back,
// so ordinary sunlit surfaces stay under the bloom threshold and only emissive
// accents (fireflies, flower hearts, the selection path) and glossy highlights glow.
const EXPOSURE = 2.0;
const BLOOM_THRESHOLD = 0.9;

// Counts per tier (bounded by the performance budget).
const PARTICLES = {
  low: { burst: 80, fireflies: 24, pollen: 0 },
  high: { burst: 400, fireflies: 120, pollen: 70 },
};
const DETAIL = {
  plain: { trees: 5, blobs: 2, grass: 0, textures: false, hills: false, pads: 0 },
  detailed: { trees: 9, blobs: 3, grass: 260, textures: true, hills: true, pads: 3 },
};

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve contrast, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.035, 1.0, 0.965), smoothstep(0.2, 0.8, l));
      s = s * 0.975 + 0.018;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
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

const hex = (h) => '#' + h.toString(16).padStart(6, '0');

function canvasTexture(size, draw, { srgb = true, repeat = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat !== 1) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat, repeat); }
  return tex;
}

function letterTexture(letter, opts = {}) {
  const tex = canvasTexture(256, (g, size) => {
    g.fillStyle = opts.color || '#2e2418';
    g.font = `700 ${size * 0.52}px Georgia, 'Times New Roman', serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(letter.toUpperCase(), size / 2, size * 0.54);
  });
  tex.anisotropy = 4;
  return tex;
}

// Soft round sprite shared by particles, fireflies and pollen.
function glowSprite() {
  return canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
}

// Cut-log slice for the wheel's top face: growth rings around the pith.
function ringsTexture(theme) {
  const base = new THREE.Color(theme.trunk).lerp(new THREE.Color(0xc9a070), 0.4);
  const dark = new THREE.Color(theme.trunk).lerp(new THREE.Color(0x000000), 0.1);
  const rng = makeRng('rings:' + theme.id);
  return canvasTexture(512, (g, s) => {
    g.fillStyle = '#' + base.getHexString(); g.fillRect(0, 0, s, s);
    g.translate(s / 2, s / 2);
    for (let r = 6; r < s / 2; r += 5 + rng() * 9) {
      g.beginPath();
      for (let a = 0; a <= 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        const rr = r * (1 + 0.025 * Math.sin(t * 3 + r * 0.05) + 0.015 * Math.sin(t * 7 + r));
        a ? g.lineTo(Math.cos(t) * rr, Math.sin(t) * rr) : g.moveTo(Math.cos(t) * rr, Math.sin(t) * rr);
      }
      g.strokeStyle = `rgba(${dark.r * 255 | 0},${dark.g * 255 | 0},${dark.b * 255 | 0},${0.12 + rng() * 0.22})`;
      g.lineWidth = 1 + rng() * 2.2;
      g.stroke();
    }
    // Bark lip around the edge.
    g.beginPath(); g.arc(0, 0, s / 2 - 8, 0, Math.PI * 2);
    g.strokeStyle = '#' + dark.getHexString(); g.lineWidth = 16; g.stroke();
  });
}

function barkTexture(theme) {
  const rng = makeRng('bark:' + theme.id);
  const c = new THREE.Color(theme.trunk);
  return canvasTexture(256, (g, s) => {
    g.fillStyle = hex(theme.trunk); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const x = rng() * s, w = 1 + rng() * 4, k = 0.6 + rng() * 0.6;
      g.fillStyle = `rgba(${Math.min(255, c.r * 255 * k) | 0},${Math.min(255, c.g * 255 * k) | 0},${Math.min(255, c.b * 255 * k) | 0},0.55)`;
      g.fillRect(x, 0, w, s);
    }
  });
}

// Linear grey speckle that multiplies the ground's vertex colours.
function groundDetailTexture() {
  const rng = makeRng('ground-detail');
  return canvasTexture(256, (g, s) => {
    g.fillStyle = 'rgb(236,236,236)'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = 200 + (rng() * 55 | 0);
      g.fillStyle = `rgb(${v},${v},${v})`;
      const x = rng() * s, y = rng() * s;
      g.fillRect(x, y, 1 + rng() * 2, 2 + rng() * 5); // blade-ish flecks
    }
  }, { srgb: false, repeat: 9 });
}

// Tangent-space ripple normal map for the pond.
function rippleNormalTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const h = (x, y) => Math.sin((x + y * 0.3) * 0.2) * 0.5 + Math.sin((y - x * 0.4) * 0.27) * 0.35 + Math.sin(Math.hypot(x - 64, y - 64) * 0.35) * 0.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
      const n = new THREE.Vector3(-dx, -dy, 2).normalize();
      const i = (y * size + x) * 4;
      img.data[i] = (n.x * 0.5 + 0.5) * 255; img.data[i + 1] = (n.y * 0.5 + 0.5) * 255; img.data[i + 2] = (n.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

// Smooth position-based noise (identical for coincident vertices, so the
// displaced canopy never cracks along face seams).
function posNoise(v, seed) {
  return Math.sin(v.x * 5.1 + seed) * Math.cos(v.y * 4.3 + seed * 0.7) * 0.22
    + Math.sin(v.z * 6.7 + v.x * 2.1 + seed * 1.3) * 0.07;
}

// Procedural tree: tapered, bent trunk + displaced canopy blobs. Authored,
// seeded, inspectable — not primitive placeholders.
function makeTree(rng, theme, detail, mats) {
  const group = new THREE.Group();
  const height = rng.range(2.6, 4.2);
  const bend = rng.range(-0.25, 0.25);
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector3(bend * t * t * height, t * height, Math.sin(t * 3) * 0.06));
  }
  const trunkGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.14, detail.textures ? 7 : 5, false);
  // Taper towards the crown.
  const tp = trunkGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) / height, k = 1 - 0.45 * y;
    const cx = bend * y * y * height;
    tp.setX(i, cx + (tp.getX(i) - cx) * k); tp.setZ(i, tp.getZ(i) * k);
  }
  trunkGeo.computeVertexNormals();
  const trunk = new THREE.Mesh(trunkGeo, mats.trunk);
  trunk.castShadow = true;
  group.add(trunk);

  const canopy = new THREE.Group();
  for (let b = 0; b < detail.blobs; b++) {
    const r = rng.range(0.7, 1.25);
    const geo = new THREE.IcosahedronGeometry(r, detail.textures ? 2 : 1);
    const pos = geo.attributes.position;
    const seed = rng.range(0, 10);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(1 + posNoise(v, seed));
      pos.setXYZ(i, v.x, v.y * 0.82, v.z);
    }
    geo.computeVertexNormals();
    const blob = new THREE.Mesh(geo, b % 2 ? mats.foliageAlt : mats.foliage);
    blob.position.set(bend * height + rng.range(-0.5, 0.5), height + rng.range(-0.3, 0.6), rng.range(-0.5, 0.5));
    blob.castShadow = true;
    canopy.add(blob);
  }
  group.add(canopy);
  group.userData.canopy = canopy;
  group.userData.phase = rng.range(0, Math.PI * 2);
  return group;
}

function makeRock(rng, mat) {
  const geo = new THREE.IcosahedronGeometry(rng.range(0.18, 0.42), 0);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const s = rng.range(0, 10);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + posNoise(v.clone().multiplyScalar(3), s));
    pos.setXYZ(i, v.x, v.y * 0.6, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// A flower: bent stem + petal ring + glowing heart. Grows when a word is planted.
function makeFlower(rng, theme, big) {
  const group = new THREE.Group();
  const h = big ? rng.range(0.9, 1.3) : rng.range(0.35, 0.55);
  const sway = rng.range(-0.3, 0.3);
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(sway * 0.3, h * 0.5, 0), new THREE.Vector3(sway, h, 0)];
  const stem = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, big ? 0.03 : 0.018, 5, false),
    new THREE.MeshStandardMaterial({ color: 0x3f6b35, roughness: 0.8, envMapIntensity: 0.4 })
  );
  stem.castShadow = true;
  group.add(stem);
  // A pair of leaves on the stem.
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f8a3e, roughness: 0.7, side: THREE.DoubleSide, envMapIntensity: 0.4 });
  for (let i = 0; i < 2; i++) {
    const leaf = new THREE.Mesh(new THREE.CircleGeometry(big ? 0.11 : 0.06, 7), leafMat);
    leaf.scale.set(0.5, 1.4, 1);
    leaf.position.set(sway * 0.3 + (i ? 0.05 : -0.05), h * (0.3 + i * 0.15), 0);
    leaf.rotation.set(-0.9, 0, i ? -1.0 : 1.0);
    group.add(leaf);
  }
  const head = new THREE.Group();
  head.position.set(sway, h, 0);
  const petals = big ? 6 + rng.int(3) : 5;
  const petalColor = rng() < 0.5 ? theme.flower : theme.flowerAlt;
  const petalMat = new THREE.MeshPhysicalMaterial({
    color: petalColor, roughness: 0.5, sheen: 0.6, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5,
    side: THREE.DoubleSide, envMapIntensity: 0.6,
  });
  for (let i = 0; i < petals; i++) {
    const p = new THREE.Mesh(new THREE.CircleGeometry(big ? 0.16 : 0.08, 8), petalMat);
    const a = (i / petals) * Math.PI * 2;
    p.position.set(Math.cos(a) * (big ? 0.16 : 0.09), 0, Math.sin(a) * (big ? 0.16 : 0.09));
    p.rotation.set(-Math.PI / 2 + 0.5, 0, -a + Math.PI / 2);
    p.scale.set(1, 1.6, 1);
    p.castShadow = true;
    head.add(p);
  }
  const center = new THREE.Mesh(
    new THREE.SphereGeometry(big ? 0.09 : 0.05, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xf2d544, roughness: 0.5, emissive: 0xffc830, emissiveIntensity: big ? 0.9 : 0.6 })
  );
  head.add(center);
  group.add(head);
  group.userData.head = head;
  group.userData.height = h;
  return group;
}

function gpuName(gl) {
  try {
    // Firefox already reports the real renderer and warns about the debug extension.
    if (!/firefox/i.test(navigator.userAgent)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
    return String(gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; }
}

function isTouchDevice() {
  try {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
  } catch { return false; }
}

function disposeObject(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const k of ['map', 'normalMap', 'alphaMap', 'roughnessMap']) if (m[k]) m[k].dispose();
      m.dispose();
    }
  });
}

export class GroveRenderer {
  constructor(canvas, { settings, theme: themeId, seed }) {
    this.canvas = canvas;
    this.settings = settings;
    this.theme = themeById(themeId);
    this.visualRng = makeRng('visual:' + seed);
    this.tiles = [];
    this.flowers = [];
    this.trees = [];
    this.time = 0;
    this.swayT = 0;
    this.selectedSet = new Set();
    this.disposed = false;
    this.failed = false;
    this.adaptiveScale = 1;
    this.frames = [];
    this.fps = 0;
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    } catch (e) {
      this.failed = true;
      return;
    }
    this.gpu = gpuName(this.renderer.getContext());
    this.detected = detectPreset(this.gpu, isTouchDevice());
    this.g = resolve(settings.graphics, this.detected);
    this.q = this.g;

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.sprite = glowSprite();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.postKey = null; this.rebuild(); });

    this.buildAll();
    this.applyGraphics(true);
    this.resize();
  }

  // Legacy accessor (dev smoke scripts): the resolved graphics tiers.
  qualityTier() { return this.q; }

  // ------------------------------------------------------ graphics settings

  /** Apply saved graphics settings live (no reload). */
  setGraphics(saved) {
    const json = JSON.stringify(saved || {});
    if (json === this.gfxJson || this.failed) return;
    this.gfxJson = json;
    const prev = this.g;
    this.g = resolve(saved, this.detected);
    this.q = this.g;
    if (prev.detail !== this.g.detail || prev.particles !== this.g.particles) this.rebuild();
    this.applyGraphics(false, prev);
  }

  applyGraphics(initial, prev = {}) {
    const g = this.g;
    if (initial) this.gfxJson = JSON.stringify(this.settings.graphics || {});
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.environment = g.reflections === 'on' ? this.envMap : null;
    this.hemi.intensity = (g.reflections === 'on' ? 0.55 : 1.3) / EXPOSURE;
    for (const t of this.tiles) t.blob.visible = size === 0;
    // Shadow-map and environment state are compiled into the shaders.
    if (initial || prev.shadows !== g.shadows || prev.reflections !== g.reflections) {
      this.scene.traverse((o) => {
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) m.needsUpdate = true;
      });
    }
    this.adaptiveScale = 1;
    this.frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this.fpsVisible(g.showFps);
    this.canvas.dataset.gfxPreset = g.preset;
    this.canvas.dataset.gfxAuto = g.auto ? 'true' : 'false';
    document.documentElement.dataset.gfxPreset = g.preset;
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo(t) {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || '',
      detected: this.detected,
      resolved: this.g,
      summary: describe(this.g, px, t),
      pixels: px,
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  reducedMotion() {
    if (this.settings.reducedMotion) return true;
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  // ----------------------------------------------------------- building ---

  buildAll() {
    this.buildEnvMap();
    this.buildEnvironment();
    this.buildWheelBase();
    this.buildParticles();
  }

  rebuild() {
    // Rebuild GPU resources from retained CPU descriptors (letters, flowers).
    const letters = this.tiles.map((t) => t.letter);
    for (const t of this.tiles) this.scene.remove(t.group);
    for (const f of this.flowers) this.scene.remove(f);
    for (const t of this.tiles) disposeObject(t.group);
    this.tiles = [];
    disposeObject(this.scene);
    this.scene.clear();
    this.envRT?.dispose();
    this.trees = [];
    this.fireflies = null;
    this.pollen = null;
    this.buildAll();
    for (const f of this.flowers) this.scene.add(f);
    if (letters.length) this.setLetters(letters);
    if (this.g) this.applyGraphics(false, {});
    this.resize();
  }

  setTheme(themeId) {
    this.theme = themeById(themeId);
    this.rebuild();
  }

  skyTexture() {
    const t = this.theme;
    return canvasTexture(256, (g, s) => {
      const grad = g.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0, hex(t.sky));
      grad.addColorStop(0.55, hex(t.sky));
      grad.addColorStop(0.8, hex(new THREE.Color(t.sky).lerp(new THREE.Color(t.horizon), 0.6).getHex()));
      grad.addColorStop(1, hex(t.horizon));
      g.fillStyle = grad; g.fillRect(0, 0, s, s);
    });
  }

  // Image-based lighting from the theme's own sky: gradient dome, ground
  // bounce and a sun disc, prefiltered once per theme.
  buildEnvMap() {
    const t = this.theme;
    const env = new THREE.Scene();
    const skyTex = this.skyTexture();
    const inv = 1 / EXPOSURE; // same radiance scale as the visible scene
    const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, color: new THREE.Color(inv, inv, inv) }));
    env.add(dome);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(9.9, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(t.ground).multiplyScalar(0.6 * inv) }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.4;
    env.add(floor);
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(t.light).multiplyScalar(4 * inv) }));
    sun.position.set(4, 10, 8).normalize().multiplyScalar(8.5);
    env.add(sun);
    this.envRT = this.pmrem.fromScene(env, 0.02);
    this.envMap = this.envRT.texture;
    disposeObject(env);
  }

  buildEnvironment() {
    const t = this.theme;
    const rng = this.visualRng.fork('env');
    const detail = DETAIL[this.g.detail];
    const inv = 1 / EXPOSURE;

    this.scene.fog = new THREE.Fog(t.fog, 14, 34);

    // Sky dome: canvas gradient on an inverted sphere.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(45, 24, 12),
      new THREE.MeshBasicMaterial({ map: this.skyTexture(), side: THREE.BackSide, fog: false, color: new THREE.Color(inv, inv, inv) })
    );
    sky.raycast = () => {};
    this.scene.add(sky);

    // Lights: one dominant key with a shadow box fitted to the play area, soft sky fill.
    const key = new THREE.DirectionalLight(t.light, t.lightIntensity * inv);
    key.position.set(4, 10, 8); // frontal key: tree shadows fall away from camera
    key.target.position.set(0, 0, 0);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.fitShadow(key);
    this.scene.add(key, key.target);
    this.key = key;
    this.hemi = new THREE.HemisphereLight(t.ambient, t.ground, 1.3 * inv);
    this.scene.add(this.hemi);

    // Ground: displaced disc with vertex colour variation (+ grass speckle when detailed).
    const groundGeo = new THREE.CircleGeometry(26, detail.textures ? 96 : 48, 0, Math.PI * 2);
    groundGeo.rotateX(-Math.PI / 2);
    const gpos = groundGeo.attributes.position;
    const colors = new Float32Array(gpos.count * 3);
    const base = new THREE.Color(t.ground);
    const boost = detail.textures ? 1.1 : 1;
    for (let i = 0; i < gpos.count; i++) {
      const x = gpos.getX(i), z = gpos.getZ(i);
      const d = Math.hypot(x, z);
      gpos.setY(i, d > 5 ? (Math.sin(x * 0.7) * Math.cos(z * 0.6)) * 0.25 * Math.min(1, (d - 5) / 4) : 0);
      const shade = (0.85 + 0.3 * Math.sin(x * 1.7 + z * 2.3)) * boost;
      colors[i * 3] = base.r * shade; colors[i * 3 + 1] = base.g * shade; colors[i * 3 + 2] = base.b * shade;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, envMapIntensity: 0.35, map: detail.textures ? groundDetailTexture() : null,
    }));
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Distant hills: a hazy ring that gives the grove a horizon.
    if (detail.hills) {
      const hillGeo = new THREE.CylinderGeometry(23, 23, 1, 72, 1, true);
      const hp = hillGeo.attributes.position;
      for (let i = 0; i < hp.count; i++) {
        if (hp.getY(i) > 0) {
          const a = Math.atan2(hp.getZ(i), hp.getX(i));
          hp.setY(i, 1.3 + 1.0 * Math.sin(a * 3 + 1) + 0.6 * Math.sin(a * 7 + 2) + 0.3 * Math.sin(a * 13));
        } else hp.setY(i, -0.5);
      }
      hillGeo.computeVertexNormals();
      const hills = new THREE.Mesh(hillGeo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(t.foliage).multiplyScalar(0.8), roughness: 1, side: THREE.BackSide, envMapIntensity: 0.3,
      }));
      hills.raycast = () => {};
      this.scene.add(hills);
    }

    // Shared materials for trees and rocks.
    const mats = {
      trunk: new THREE.MeshStandardMaterial({ color: t.trunk, roughness: 0.95, map: detail.textures ? barkTexture(t) : null, envMapIntensity: 0.3 }),
      foliage: new THREE.MeshStandardMaterial({ color: t.foliage, roughness: 0.85, flatShading: true, envMapIntensity: 0.45 }),
      foliageAlt: new THREE.MeshStandardMaterial({ color: t.foliageAlt, roughness: 0.85, flatShading: true, envMapIntensity: 0.45 }),
      rock: new THREE.MeshStandardMaterial({ color: 0x8a8d84, roughness: 0.9, flatShading: true, envMapIntensity: 0.5 }),
    };
    if (detail.textures) mats.trunk.color.set(0xffffff);

    // Tree ring.
    for (let i = 0; i < detail.trees; i++) {
      const a = (i / detail.trees) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = rng.range(9, 15);
      const tree = makeTree(rng, t, detail, mats);
      // Keep trees behind the playfield, never between camera and wheel.
      tree.position.set(Math.cos(a) * r, 0, -Math.abs(Math.sin(a) * r) - 2);
      tree.rotation.y = rng.range(0, Math.PI * 2);
      const s = rng.range(0.8, 1.4);
      tree.scale.set(s, s, s);
      tree.traverse((o) => { o.raycast = () => {}; });
      this.scene.add(tree);
      this.trees.push(tree);
    }
    // Rocks and a small pond.
    for (let i = 0; i < 5; i++) {
      const rock = makeRock(rng, mats.rock);
      const a = rng.range(0, Math.PI * 2);
      rock.position.set(Math.cos(a) * rng.range(4, 7), 0.05, Math.sin(a) * rng.range(3, 6) - 1);
      this.scene.add(rock);
    }
    const pondPos = new THREE.Vector3(-3.9, 0.08, 0.6);
    this.pondNormal = detail.textures ? rippleNormalTexture() : null;
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 32),
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(t.water).multiplyScalar(0.55), roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
        normalMap: this.pondNormal, normalScale: new THREE.Vector2(0.18, 0.18), envMapIntensity: 0.9,
        polygonOffset: true, polygonOffsetFactor: -2,
      })
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.copy(pondPos);
    pond.receiveShadow = true;
    this.scene.add(pond);
    // Muddy bank ring so the pond sits in the ground rather than on it.
    const bank = new THREE.Mesh(
      new THREE.RingGeometry(1.36, 1.62, 32),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(t.ground).multiplyScalar(0.6), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, envMapIntensity: 0.3 })
    );
    bank.rotation.x = -Math.PI / 2;
    bank.position.copy(pondPos).y -= 0.005;
    bank.receiveShadow = true;
    this.scene.add(bank);
    const padMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.foliageAlt).multiplyScalar(0.9), roughness: 0.6, side: THREE.DoubleSide, envMapIntensity: 0.6 });
    this.pads = [];
    for (let i = 0; i < detail.pads; i++) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(rng.range(0.14, 0.22), 14, 0.35, Math.PI * 2 - 0.35), padMat);
      pad.rotation.set(-Math.PI / 2, 0, rng.range(0, Math.PI * 2));
      const a = rng.range(0, Math.PI * 2), rr = rng.range(0.3, 0.95);
      pad.position.set(pondPos.x + Math.cos(a) * rr, pondPos.y + 0.012, pondPos.z + Math.sin(a) * rr);
      pad.userData.phase = rng.range(0, 6);
      pad.receiveShadow = true;
      this.scene.add(pad);
      this.pads.push(pad);
    }

    // Grass tufts (instanced), kept off the wheel and the pond.
    this.grass = null;
    if (detail.grass) {
      const blade = new THREE.ConeGeometry(0.035, 0.32, 3, 1, true);
      blade.translate(0, 0.16, 0);
      const parts = [];
      for (let k = 0; k < 3; k++) {
        const b = blade.clone();
        b.rotateZ((k - 1) * 0.35);
        b.translate((k - 1) * 0.05, 0, (k % 2) * 0.03);
        parts.push(b);
      }
      const tuft = mergeGeometries(parts);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.foliageAlt).lerp(new THREE.Color(t.ground), 0.3), roughness: 0.9, envMapIntensity: 0.4 });
      this.windUniform = { value: 0 };
      this.timeUniform = { value: 0 };
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uWind = this.windUniform;
        sh.uniforms.uTime = this.timeUniform;
        sh.vertexShader = 'uniform float uWind; uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float bend = position.y * position.y * 1.6 * uWind;
            transformed.x += sin(uTime * 1.6 + ip.x * 0.7 + ip.z * 0.5) * 0.09 * bend;
            transformed.z += cos(uTime * 1.2 + ip.z * 0.8) * 0.05 * bend;
          #endif`);
      };
      const n = detail.grass;
      const inst = new THREE.InstancedMesh(tuft, mat, n);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      let placed = 0;
      for (let tries = 0; placed < n && tries < n * 6; tries++) {
        const x = rng.range(-12, 12), z = rng.range(-10, 7.5);
        if (Math.hypot(x, z - FRAMING.wheelZ) < FRAMING.wheelRadius + 1.1) continue;
        if (Math.hypot(x - pondPos.x, z - pondPos.z) < 1.75) continue;
        p.set(x, 0, z);
        q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
        const s = rng.range(0.7, 1.4);
        sc.set(s, s * rng.range(0.8, 1.3), s);
        m4.compose(p, q, sc);
        inst.setMatrixAt(placed++, m4);
      }
      inst.count = placed;
      inst.receiveShadow = true;
      inst.raycast = () => {};
      this.scene.add(inst);
      this.grass = inst;
    }

    // Fireflies (dusk/night) and drifting pollen (daylight): cosmetic sprites.
    const pc = PARTICLES[this.g.particles];
    const night = t.id === 'night' || t.id === 'dusk';
    if (night && pc.fireflies) this.fireflies = this.makeDrift(rng, pc.fireflies, new THREE.Color(0xd8f090).multiplyScalar(3.2 * inv * 2), 0.14, 0.95, [0.3, 3.5]);
    if (!night && pc.pollen) this.pollen = this.makeDrift(rng, pc.pollen, new THREE.Color(0xfff1c8).multiplyScalar(0.9), 0.06, 0.55, [0.4, 3.2]);
  }

  makeDrift(rng, n, color, size, opacity, [y0, y1]) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const seeds = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rng.range(-10, 10);
      pos[i * 3 + 1] = rng.range(y0, y1);
      pos[i * 3 + 2] = rng.range(-8, 6);
      seeds[i * 2] = rng.range(0, 100);
      seeds[i * 2 + 1] = rng.range(0.3, 1);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color, size, map: this.sprite, transparent: true, opacity, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    pts.userData.seeds = seeds;
    pts.raycast = () => {}; // cosmetic: never intercept picking
    this.scene.add(pts);
    return pts;
  }

  // Fit the key light's orthographic shadow box to the play area (wheel,
  // flowers, rocks, pond) in light space so the map's texels are spent there.
  fitShadow(light) {
    const lightDir = light.position.clone().sub(light.target.position).normalize();
    const view = new THREE.Matrix4().lookAt(lightDir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = min.clone().negate();
    const v = new THREE.Vector3();
    for (const x of [-7.5, 7.5]) for (const y of [0, 2.2]) for (const z of [-3.5, 6]) {
      v.set(x, y, z).applyMatrix4(inv);
      min.min(v); max.max(v);
    }
    const cam = light.shadow.camera;
    cam.left = min.x - 0.3; cam.right = max.x + 0.3;
    cam.bottom = min.y - 0.3; cam.top = max.y + 0.3;
    cam.near = 0.5; cam.far = 40;
    light.position.copy(lightDir.multiplyScalar(18));
    cam.updateProjectionMatrix();
  }

  buildWheelBase() {
    const t = this.theme;
    const detail = DETAIL[this.g.detail];
    const inv = 1 / EXPOSURE;
    // Grounded log slice under the letter tiles.
    const sideMat = new THREE.MeshStandardMaterial({ color: detail.textures ? 0xffffff : t.trunk, map: detail.textures ? barkTexture(t) : null, roughness: 0.9, envMapIntensity: 0.4 });
    const topMat = detail.textures
      ? new THREE.MeshPhysicalMaterial({ map: ringsTexture(t), roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.45, envMapIntensity: 0.6 })
      : new THREE.MeshStandardMaterial({ color: t.trunk, roughness: 0.85 });
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(FRAMING.wheelRadius + 0.55, FRAMING.wheelRadius + 0.7, 0.18, 48),
      [sideMat, topMat, sideMat]
    );
    base.position.set(0, 0.09, FRAMING.wheelZ);
    base.receiveShadow = true;
    base.castShadow = true;
    this.scene.add(base);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(FRAMING.wheelRadius + 0.62, 0.05, 10, 64),
      new THREE.MeshStandardMaterial({ color: 0xb08a4e, roughness: 0.35, metalness: 0.7, envMapIntensity: 1.0 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 0.19, FRAMING.wheelZ);
    rim.castShadow = true;
    this.scene.add(rim);

    // Selection path segments (pooled cylinders), slightly over-bright so they glow with bloom.
    this.pathSegments = [];
    const segMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9a8).multiplyScalar(2.4 * inv), transparent: true, opacity: 0.9 });
    for (let i = 0; i < 7; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 8), segMat);
      seg.visible = false;
      seg.raycast = () => {};
      this.scene.add(seg);
      this.pathSegments.push(seg);
    }
    this.cursorDot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), segMat.clone());
    this.cursorDot.visible = false;
    this.cursorDot.raycast = () => {};
    this.scene.add(this.cursorDot);
  }

  buildParticles() {
    // Pooled burst particles (leaf-green); bounded by tier.
    const n = PARTICLES[this.g.particles].burst;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3).fill(-10);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.burstVel = new Float32Array(n * 3);
    this.burstLife = new Float32Array(n);
    this.burstCount = n;
    this.burst = new THREE.Points(geo, new THREE.PointsMaterial({
      color: this.burstColor(0xa8d878), size: 0.13, map: this.sprite, transparent: true, opacity: 0.95,
      depthWrite: false, sizeAttenuation: true,
    }));
    this.burst.raycast = () => {};
    this.burst.frustumCulled = false;
    this.scene.add(this.burst);
  }

  burstColor(h) { return new THREE.Color(h).multiplyScalar(1.6 / EXPOSURE); }

  // ------------------------------------------------------------ letters ---

  setLetters(letters) {
    for (const t of this.tiles) { this.scene.remove(t.group); disposeObject(t.group); }
    const inv = 1 / EXPOSURE;
    const shadowsOff = SHADOW_MAP[this.g.shadows] === 0;
    this.tiles = letters.map((letter) => {
      const group = new THREE.Group();
      // Glazed ceramic token: clearcoat over a warm cream body.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.46, 0.22, 32),
        new THREE.MeshPhysicalMaterial({ color: 0xf3e6c8, roughness: 0.5, clearcoat: 0.7, clearcoatRoughness: 0.28, envMapIntensity: 0.6 })
      );
      body.castShadow = true;
      body.position.y = 0.11;
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.4, 32),
        new THREE.MeshBasicMaterial({ map: letterTexture(letter, this.textColors()), transparent: true, color: new THREE.Color(inv, inv, inv) })
      );
      face.rotation.x = -Math.PI / 2;
      face.position.y = 0.225;
      const marker = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.035, 8, 40),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd76a).multiplyScalar(1.8 * inv), transparent: true, opacity: 0 })
      );
      marker.rotation.x = Math.PI / 2;
      marker.position.y = 0.02;
      marker.raycast = () => {};
      // Soft contact shadow on the log when shadow maps are off.
      const blob = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 24),
        new THREE.MeshBasicMaterial({ map: this.sprite, color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.raycast = () => {};
      blob.visible = shadowsOff;
      group.add(body, face, marker, blob);
      this.scene.add(group);
      return { letter, group, body, face, marker, blob, lift: 0, liftVel: 0, spin: 0, spinTarget: 0 };
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
    for (const f of this.flowers) { this.scene.remove(f); disposeObject(f); }
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
    if (!this.reducedMotion()) this.spawnBurst(flower.position, big ? 40 : 18);
  }

  hintBloom() {
    // Small pollen puff above the wheel.
    if (!this.reducedMotion()) this.spawnBurst(new THREE.Vector3(0, 1.5, 0), 10, 0xffe9a8);
  }

  celebrate() {
    if (!this.reducedMotion()) {
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
    this.burst.material.color.copy(this.burstColor(color || 0xa8d878));
    posAttr.needsUpdate = true;
  }

  // ---------------------------------------------------------------- loop ---

  // CSS-pixel band of the canvas the wheel may use (between the crossword /
  // tutorial stack above and the word controls below). Set from the UI.
  setSafeBand(top, bottom, left, right) {
    this.safeBand = { top: top || 0, bottom: bottom || 0, left: left || 0, right: right || 0 };
    this.resize();
  }

  resize() {
    if (this.failed) return;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.applySize(w, h);
    const portrait = h > w;
    const cfg = portrait ? FRAMING.camera.portrait : FRAMING.camera.landscape;
    this.camera.fov = cfg.fov;
    // Frame the wheel inside the band not covered by DOM chrome (view offset),
    // then pull the authored camera back along its axis until the whole
    // wheel (plus a letter's worth of margin) fits that band.
    const band = this.safeBand || { top: 0, bottom: 0, left: 0, right: 0 };
    const top = Math.min(band.top, h * 0.6), bottom = Math.min(band.bottom, h * 0.35);
    const left = Math.min(band.left || 0, w * 0.5), right = Math.min(band.right || 0, w * 0.5);
    const sh = Math.max(1, h - top - bottom), sw = Math.max(1, w - left - right);
    if (sh < h * 0.3 || sw < w * 0.35) { this.camera.aspect = w / h; this.camera.clearViewOffset(); }
    else { this.camera.aspect = sw / sh; this.camera.setViewOffset(sw, sh, -left, -top, w, h); }
    this.camera.updateProjectionMatrix();
    const look = new THREE.Vector3(...cfg.look);
    const base = new THREE.Vector3(...cfg.pos);
    const dir = base.clone().sub(look).normalize();
    const r = FRAMING.wheelRadius + 0.55;
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, FRAMING.wheelY, FRAMING.wheelZ + Math.sin(a) * r));
      pts.push(new THREE.Vector3(Math.cos(a) * r, FRAMING.wheelY + 0.5, FRAMING.wheelZ + Math.sin(a) * r));
    }
    const probe = new THREE.PerspectiveCamera(this.camera.fov, this.camera.aspect, 0.1, 200);
    const v = new THREE.Vector3();
    const d0 = base.distanceTo(look);
    let d = d0 * 0.45;
    for (let i = 0; i < 14; i++) {
      probe.position.copy(look).addScaledVector(dir, d);
      probe.lookAt(look); probe.updateMatrixWorld(); probe.updateProjectionMatrix();
      let over = 0;
      for (const q of pts) { v.copy(q).project(probe); over = Math.max(over, Math.abs(v.x) / 0.95, Math.abs(v.y) / 0.9); }
      if (over <= 1) break;
      d *= Math.min(1.6, over + 0.02);
    }
    this.camBase = look.clone().addScaledVector(dir, d);
    this.camLook = look;
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camLook);
  }

  // Pixel ratio = min(dpr, preset cap) × render scale × adaptive scale.
  applySize(w, h, force = false) {
    const ratio = Math.min(3, Math.min(window.devicePixelRatio || 1, this.g.dprCap) * this.g.scale * this.adaptiveScale);
    if (force || w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
  }

  postKey_() {
    const g = this.g;
    const needs = g.post || g.antialias === 'msaa';
    return needs && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, this.size[0], this.size[1], this.pixelRatio].join('|') : 'none';
  }

  buildPost() {
    const g = this.g;
    this.composer?.dispose();
    this.composer = null;
    if (this.postKey === 'none') return;
    const [w, h] = this.size;
    const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0 });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = g.ao === 'high' ? 0.85 : 0.7;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive accents and glossy highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.5, BLOOM_THRESHOLD));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
      this.postKey = 'none';
    }
  }

  // Adaptive resolution: average ~90 frames, step down when slow, back up when fast.
  adapt(dtMs) {
    const f = this.frames;
    f.push(dtMs);
    if (f.length < 90) return;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.g.adaptive) { this.adaptiveScale = 1; return; }
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
  }

  renderFrame() {
    this.applySize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1);
    const key = this.postKey_();
    if (key !== this.postKey) {
      this.postKey = key;
      this.buildPost();
    }
    if (this.composer) {
      try { this.composer.render(); return; } catch {
        this.postFailed = true;
        this.composer = null;
        this.postKey = 'none';
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  update(dtMs) {
    if (this.failed || this.contextLost) return;
    const dt = Math.min(dtMs, 100) / 1000;
    this.time += dt;
    this.adapt(dtMs);
    const rm = this.reducedMotion();
    const ambient = !rm && this.g.background === 'animated';

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
      t.body.material.emissive.setHex(sel ? 0x33280a : 0x000000);
      if (t.blob.visible) {
        const groupY = FRAMING.wheelY + t.lift;
        t.blob.position.y = 0.186 - groupY;
        const s = 1 + t.lift * 0.8;
        t.blob.scale.set(s, s, 1);
        t.blob.material.opacity = 0.38 / (1 + t.lift * 2.5);
      }
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

    // Ambient scene motion: canopy wind, grass, pond ripples, lily pads.
    if (this.windUniform) {
      this.windUniform.value = ambient ? 1 : 0;
      if (ambient) this.timeUniform.value = this.time;
    }
    if (ambient) {
      for (const tree of this.trees) {
        const ph = tree.userData.phase;
        tree.userData.canopy.rotation.z = Math.sin(this.time * 0.7 + ph) * 0.018;
        tree.userData.canopy.rotation.x = Math.sin(this.time * 0.5 + ph * 1.3) * 0.012;
      }
      if (this.pondNormal) { this.pondNormal.offset.x = this.time * 0.02; this.pondNormal.offset.y = this.time * 0.013; }
      for (const pad of this.pads) pad.rotation.z += Math.sin(this.time * 0.4 + pad.userData.phase) * 0.0006;
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
      if (this.fireflies) this.drift(this.fireflies, 1);
      if (this.pollen && ambient) this.drift(this.pollen, 0.5);
      if (this.fireflies) this.fireflies.material.opacity = 0.75 + 0.25 * Math.sin(this.time * 2.3);
    }

    this.renderFrame();
  }

  drift(points, k) {
    const fp = points.geometry.attributes.position;
    const seeds = points.userData.seeds;
    for (let i = 0; i < fp.count; i++) {
      const s = seeds[i * 2], sp = seeds[i * 2 + 1];
      fp.setX(i, fp.getX(i) + Math.sin(this.time * sp + s) * 0.004 * k);
      fp.setY(i, fp.getY(i) + Math.cos(this.time * sp * 0.7 + s) * 0.003 * k);
    }
    fp.needsUpdate = true;
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
    this.renderFrame();
  }

  dispose() {
    this.disposed = true;
    disposeObject(this.scene);
    this.composer?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.renderer.dispose();
  }
}

// Minimal merge for same-layout non-indexed/indexed geometries (position, normal, uv).
function mergeGeometries(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const size = parts[0].attributes[name].itemSize;
    const total = parts.reduce((n, g) => n + g.attributes[name].count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, off); off += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
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
