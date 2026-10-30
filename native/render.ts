// The grove on starhermit:scene, as the browser build's js/render.js drew it
// with three.js r160: a tranquil procedural glade (sky dome, displaced
// vertex-coloured ground with grass speckle, a hazy ring of hills, seeded
// trees with tapered trunks and displaced canopies, rocks, a pond with a
// ripple normal map, a muddy bank and lily pads, instanced grass tufts),
// the log-slice wheel with its brass rim, the glazed letter tokens (lift,
// spring to slots, spin on shuffle, selection ring), the glowing selection
// path and cursor dot, flowers growing for every planted word (cheering on
// completion), leaf bursts, fireflies at dusk and night, drifting pollen by
// day, the gentle camera sway, and the camera fitted to the band the HUD,
// crossword and controls leave (view offset + a probe fit), as resize() did.
//
// Engine minor 24 has three r185's light units and shadows, and the page was
// r160 (physical lights since r155), so the page's own values stand: the key
// light theme.lightIntensity / EXPOSURE with its fitted shadow box (bias
// -0.0004, normal bias 0.02, PCF soft), the hemisphere 1.3 / EXPOSURE
// (0.55 / EXPOSURE with reflections on), ACES at exposure 2. Reflections as
// the page had them: its own sky dome, ground bounce and sun disc
// prefiltered with PMREMGenerator.fromScene(env, 0.02); r160 set that as
// scene.environment and scaled it by each material's envMapIntensity
// (0.3–1.0). The engine follows r163+ there (scene.environment ignores the
// per-material intensity), so each lit material gets the prefiltered sky as
// its own envMap at the page's intensity — the r160 result (engine answer
// in the port brief). The composer (GTAO → bloom 0.5 / 0.5 / 0.9 →
// OutputPass → the display-space grade and vignette → SMAA / FXAA or MSAA)
// is the runtime's renderer.ao / bloom / grade / antialias.
//
// Differences: the grass tufts' wind bend (an onBeforeCompile vertex patch)
// is an instance-matrix shear updated each frame; canvas painting runs on
// the engine's OffscreenCanvas with its serif face for the letters.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CanvasTexture, CatmullRomCurve3, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh,
  LinearFilter, LinearMipmapLinearFilter, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  PCFSoftShadowMap, PerspectiveCamera, Plane, PMREMGenerator, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping, RGBAFormat,
  RingGeometry, SphereGeometry, SRGBColorSpace, TorusGeometry, TubeGeometry, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { makeRng } from "../js/rng.js";
import { themeById } from "../js/content.js";
import type { Look, Budget } from "./quality.ts";

interface Rng { (): number; int(n: number): number; range(a: number, b: number): number; fork(l: string): Rng }
const rngOf = makeRng as unknown as (seed: string | number) => Rng;
export interface Theme {
  id: string; sky: number; horizon: number; fog: number; ground: number; trunk: number; foliage: number; foliageAlt: number;
  flower: number; flowerAlt: number; water: number; light: number; lightIntensity: number; ambient: number; ambience: string;
}
const themeOf = themeById as unknown as (id: string) => Theme;

export const FRAMING = {
  fov: 34, wheelRadius: 2.1, wheelY: 0.55, wheelZ: 1.5,
  camera: {
    landscape: { pos: [0, 5.2, 9.6], look: [0, 0.5, 0.9], fov: 34 },
    portrait: { pos: [0, 7.4, 14.2], look: [0, 0.1, 1.7], fov: 52 },
  },
  swayAmplitude: 0.08, swayPeriodSec: 11,
};
const EXPOSURE = 2.0;
const BLOOM_THRESHOLD = 0.9;
const INV = 1 / EXPOSURE;
const DETAIL = {
  plain: { trees: 5, blobs: 2, grass: 0, textures: false, hills: false, pads: 0 },
  detailed: { trees: 9, blobs: 3, grass: 260, textures: true, hills: true, pads: 3 },
};
type Detail = typeof DETAIL.plain;
const PARTICLES = { low: { burst: 80, fireflies: 24, pollen: 0 }, high: { burst: 400, fireflies: 120, pollen: 70 } };
type Ctx = OffscreenCanvasRenderingContext2D;

function spring(current: number, target: number, velocity: number, smoothTime: number, dt: number): [number, number] {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  velocity = (velocity - omega * temp) * exp;
  return [target + (change + temp) * exp, velocity];
}
const hex = (h: number): string => "#" + h.toString(16).padStart(6, "0");
const easeOutBack = (x: number): number => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

// ---------------------------------------------------------------- materials per budget
let B: Budget | null = null;
let envTex: Texture | null = null;
let reflections = false;
interface SurfParams {
  color?: number | Color; map?: Texture | null; emissive?: number; emissiveIntensity?: number; side?: typeof DoubleSide | typeof BackSide; transparent?: boolean; opacity?: number;
  vertexColors?: boolean; flatShading?: boolean; normalMap?: Texture | null; normalScale?: Vector2; polygonOffset?: boolean; polygonOffsetFactor?: number;
  roughness?: number; metalness?: number; envMapIntensity?: number;
}
interface SurfExtras { sheen?: number; sheenColor?: Color; sheenRoughness?: number; clearcoat?: number; clearcoatRoughness?: number }
const LAMBERT_KEYS = ["color", "map", "emissive", "emissiveIntensity", "side", "transparent", "opacity", "vertexColors", "flatShading", "normalMap",
  "normalScale", "polygonOffset", "polygonOffsetFactor"] as const;
function surf(params: SurfParams, extras?: SurfExtras): Material {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p[k] = v instanceof Color ? v.clone() : v;
  if (B!.material === "lambert") {
    const q: Record<string, unknown> = {};
    for (const k of LAMBERT_KEYS) if (p[k] !== undefined) q[k] = p[k];
    return new MeshLambertMaterial(q as never);
  }
  // r160: scene.environment × each material's envMapIntensity (see the header)
  if (reflections && envTex) { p.envMap = envTex; p.envMapIntensity = params.envMapIntensity ?? 1; }
  else delete p.envMapIntensity;
  if (B!.material === "physical" && extras) return new MeshPhysicalMaterial({ ...p, ...extras } as never);
  return new MeshStandardMaterial(p as never);
}
const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * B!.segments));

// ---------------------------------------------------------------- canvas textures (render.js painting)
function canvasTexture(size: number, draw: (g: Ctx, size: number) => void, { srgb = true, repeat = 1, px = size } = {}): Texture {
  const c = new OffscreenCanvas(px, px);
  const g = c.getContext("2d");
  if (px !== size) g.scale(px / size, px / size);
  draw(g, size);
  const tex = new CanvasTexture(c);
  if (srgb) tex.colorSpace = SRGBColorSpace;
  if (repeat !== 1) { tex.wrapS = tex.wrapT = RepeatWrapping; tex.repeat.set(repeat, repeat); }
  return tex;
}
const letterCache = new Map<string, Texture>();
function letterTexture(letter: string, color: string): Texture {
  const k = letter + color;
  let t = letterCache.get(k);
  if (t) return t;
  t = canvasTexture(256, (g, size) => {
    g.fillStyle = color;
    g.font = `700 ${size * 0.52}px serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(letter.toUpperCase(), size / 2, size * 0.54);
  });
  t.anisotropy = 4;
  letterCache.set(k, t);
  return t;
}
let spriteTex: Texture | null = null;
function glowSprite(): Texture {
  if (spriteTex) return spriteTex;
  spriteTex = canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.35, "rgba(255,255,255,0.75)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  return spriteTex;
}
function ringsTexture(t: Theme): Texture {
  const base = new Color(t.trunk).lerp(new Color(0xc9a070), 0.4);
  const dark = new Color(t.trunk).lerp(new Color(0x000000), 0.1);
  const rng = rngOf("rings:" + t.id);
  return canvasTexture(512, (g, s) => {
    g.fillStyle = hex(base.getHex()); g.fillRect(0, 0, s, s);
    g.translate(s / 2, s / 2);
    for (let r = 6; r < s / 2; r += 5 + rng() * 9) {
      g.beginPath();
      for (let a = 0; a <= 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        const rr = r * (1 + 0.025 * Math.sin(th * 3 + r * 0.05) + 0.015 * Math.sin(th * 7 + r));
        if (a) g.lineTo(Math.cos(th) * rr, Math.sin(th) * rr); else g.moveTo(Math.cos(th) * rr, Math.sin(th) * rr);
      }
      g.strokeStyle = `rgba(${(dark.r * 255) | 0},${(dark.g * 255) | 0},${(dark.b * 255) | 0},${0.12 + rng() * 0.22})`;
      g.lineWidth = 1 + rng() * 2.2;
      g.stroke();
    }
    g.beginPath(); g.arc(0, 0, s / 2 - 8, 0, Math.PI * 2);
    g.strokeStyle = hex(dark.getHex()); g.lineWidth = 16; g.stroke();
  }, { px: B!.texture * 2 });
}
function barkTexture(t: Theme): Texture {
  const rng = rngOf("bark:" + t.id);
  const c = new Color(t.trunk);
  return canvasTexture(256, (g, s) => {
    g.fillStyle = hex(t.trunk); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const x = rng() * s, w = 1 + rng() * 4, k = 0.6 + rng() * 0.6;
      g.fillStyle = `rgba(${Math.min(255, c.r * 255 * k) | 0},${Math.min(255, c.g * 255 * k) | 0},${Math.min(255, c.b * 255 * k) | 0},0.55)`;
      g.fillRect(x, 0, w, s);
    }
  }, { px: B!.texture });
}
function groundDetailTexture(): Texture {
  const rng = rngOf("ground-detail");
  return canvasTexture(256, (g, s) => {
    g.fillStyle = "rgb(236,236,236)"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = 200 + ((rng() * 55) | 0);
      g.fillStyle = `rgb(${v},${v},${v})`;
      const x = rng() * s, y = rng() * s;
      g.fillRect(x, y, 1 + rng() * 2, 2 + rng() * 5);
    }
  }, { srgb: false, repeat: 9, px: B!.texture });
}
let rippleTex: Texture | null = null;
function rippleNormalTexture(): Texture {
  if (rippleTex) return rippleTex;
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const h = (x: number, y: number): number => Math.sin((x + y * 0.3) * 0.2) * 0.5 + Math.sin((y - x * 0.4) * 0.27) * 0.35 + Math.sin(Math.hypot(x - 64, y - 64) * 0.35) * 0.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
      const l = Math.hypot(dx, dy, 2);
      const i = (y * size + x) * 4;
      data[i] = ((-dx / l) * 0.5 + 0.5) * 255; data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255; data[i + 2] = ((2 / l) * 0.5 + 0.5) * 255; data[i + 3] = 255;
    }
  }
  // the page painted it with putImageData (row 0 at the top): flip for the texture's bottom-up rows
  const flipped = new Uint8Array(data.length);
  for (let y = 0; y < size; y++) flipped.set(data.subarray(y * size * 4, (y + 1) * size * 4), (size - 1 - y) * size * 4);
  const tex = new DataTexture(flipped, size, size, RGBAFormat);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  rippleTex = tex;
  return tex;
}

// ---------------------------------------------------------------- props (render.js makeTree / makeRock / makeFlower)
function posNoise(v: Vector3, seed: number): number {
  return Math.sin(v.x * 5.1 + seed) * Math.cos(v.y * 4.3 + seed * 0.7) * 0.22 + Math.sin(v.z * 6.7 + v.x * 2.1 + seed * 1.3) * 0.07;
}
interface Mats { trunk: Material; foliage: Material; foliageAlt: Material; rock: Material }
function makeTree(rng: Rng, detail: Detail, mats: Mats): Group {
  const group = new Group();
  const height = rng.range(2.6, 4.2);
  const bend = rng.range(-0.25, 0.25);
  const pts: Vector3[] = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new Vector3(bend * t * t * height, t * height, Math.sin(t * 3) * 0.06)); }
  const trunkGeo = new TubeGeometry(new CatmullRomCurve3(pts), 8, 0.14, detail.textures ? 7 : 5, false);
  const tp = trunkGeo.attributes.position as BufferAttribute;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) / height, k = 1 - 0.45 * y;
    const cx = bend * y * y * height;
    tp.setX(i, cx + (tp.getX(i) - cx) * k); tp.setZ(i, tp.getZ(i) * k);
  }
  tp.needsUpdate = true;
  trunkGeo.computeVertexNormals();
  const trunk = new Mesh(trunkGeo, mats.trunk);
  trunk.castShadow = true;
  group.add(trunk);
  const canopy = new Group();
  for (let b = 0; b < detail.blobs; b++) {
    const r = rng.range(0.7, 1.25);
    const geo = new IcosahedronGeometry(r, detail.textures ? 2 : 1);
    const pos = geo.attributes.position as BufferAttribute;
    const sd = rng.range(0, 10);
    const v = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(1 + posNoise(v, sd));
      pos.setXYZ(i, v.x, v.y * 0.82, v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const blob = new Mesh(geo, b % 2 ? mats.foliageAlt : mats.foliage);
    blob.position.set(bend * height + rng.range(-0.5, 0.5), height + rng.range(-0.3, 0.6), rng.range(-0.5, 0.5));
    blob.castShadow = true;
    canopy.add(blob);
  }
  group.add(canopy);
  group.userData.canopy = canopy;
  group.userData.phase = rng.range(0, Math.PI * 2);
  return group;
}
function makeRock(rng: Rng, mat: Material): Mesh {
  const geo = new IcosahedronGeometry(rng.range(0.18, 0.42), 0);
  const pos = geo.attributes.position as BufferAttribute;
  const v = new Vector3();
  const s = rng.range(0, 10);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + posNoise(v.clone().multiplyScalar(3), s));
    pos.setXYZ(i, v.x, v.y * 0.6, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const m = new Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function makeFlower(rng: Rng, t: Theme, big: boolean): Group {
  const group = new Group();
  const h = big ? rng.range(0.9, 1.3) : rng.range(0.35, 0.55);
  const sway = rng.range(-0.3, 0.3);
  const pts = [new Vector3(0, 0, 0), new Vector3(sway * 0.3, h * 0.5, 0), new Vector3(sway, h, 0)];
  const stem = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 6, big ? 0.03 : 0.018, 5, false), surf({ color: 0x3f6b35, roughness: 0.8, envMapIntensity: 0.4 }));
  stem.castShadow = true;
  group.add(stem);
  const leafMat = surf({ color: 0x4f8a3e, roughness: 0.7, side: DoubleSide, envMapIntensity: 0.4 });
  for (let i = 0; i < 2; i++) {
    const leaf = new Mesh(new CircleGeometry(big ? 0.11 : 0.06, 7), leafMat);
    leaf.scale.set(0.5, 1.4, 1);
    leaf.position.set(sway * 0.3 + (i ? 0.05 : -0.05), h * (0.3 + i * 0.15), 0);
    leaf.rotation.set(-0.9, 0, i ? -1.0 : 1.0);
    group.add(leaf);
  }
  const head = new Group();
  head.position.set(sway, h, 0);
  const petals = big ? 6 + rng.int(3) : 5;
  const petalColor = rng() < 0.5 ? t.flower : t.flowerAlt;
  const petalMat = surf({ color: petalColor, roughness: 0.5, side: DoubleSide, envMapIntensity: 0.6 }, { sheen: 0.6, sheenColor: new Color(0xffffff), sheenRoughness: 0.5 });
  for (let i = 0; i < petals; i++) {
    const p = new Mesh(new CircleGeometry(big ? 0.16 : 0.08, 8), petalMat);
    const a = (i / petals) * Math.PI * 2;
    p.position.set(Math.cos(a) * (big ? 0.16 : 0.09), 0, Math.sin(a) * (big ? 0.16 : 0.09));
    p.rotation.set(-Math.PI / 2 + 0.5, 0, -a + Math.PI / 2);
    p.scale.set(1, 1.6, 1);
    p.castShadow = true;
    head.add(p);
  }
  const center = new Mesh(new SphereGeometry(big ? 0.09 : 0.05, seg(12, 6), seg(8, 4)),
    surf({ color: 0xf2d544, roughness: 0.5, emissive: 0xffc830, emissiveIntensity: big ? 0.9 : 0.6 }));
  head.add(center);
  group.add(head);
  group.userData.head = head;
  return group;
}
function mergeGeometries(geos: BufferGeometry[]): BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const size = (parts[0]!.attributes[name] as BufferAttribute).itemSize;
    const total = parts.reduce((n, g) => n + (g.attributes[name] as BufferAttribute).count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const g of parts) { const a = (g.attributes[name] as BufferAttribute).array as Float32Array; arr.set(a, off); off += a.length; }
    out.setAttribute(name, new BufferAttribute(arr, size));
  }
  return out;
}

// ---------------------------------------------------------------- the scene
const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
renderer.shadowMap.type = PCFSoftShadowMap;

interface Tile {
  letter: string; group: Group; body: Mesh; face: Mesh; marker: Mesh; blob: Mesh; lift: number; liftVel: number; spin: number; spinTarget: number;
  x: number; z: number; vx: number; vz: number; targetX: number; targetZ: number;
}
let look: Look | null = null;
let theme: Theme = themeOf("dawn");
let visualRng: Rng = rngOf("visual:title-grove");
let root: Group | null = null;
let key: DirectionalLight | null = null;
let hemi: HemisphereLight | null = null;
let tiles: Tile[] = [];
let letters: string[] = [];
let flowers: { word: string; big: boolean }[] = [];
let flowerObjs: Group[] = [];
let trees: Group[] = [];
let pads: Mesh[] = [];
let pondNormal: Texture | null = null;
let grass: { mesh: InstancedMesh; base: Matrix4[] } | null = null;
let fireflies: Points | null = null;
let pollen: Points | null = null;
let pathSegments: Mesh[] = [];
let cursorDot: Mesh | null = null;
let burst: { pts: Points; pos: Float32Array; vel: Float32Array; life: Float32Array; count: number } | null = null;
let selectedSet = new Set<number>();
let selection: number[] = [];
let cursorWorld: { x: number; z: number } | null = null;
let time = 0;
let swayT = 0;
let reduced = false;
let swayOn = true;
let textColor = "#2e2418";
let band = { top: 0, bottom: 0, left: 0, right: 0 };
let win = { w: 0, h: 0 };
let camBase = new Vector3(0, 5.2, 9.6);
let camLook = new Vector3(0, 0.5, 0.9);
let fitKey = "";
let built = false;

function particleCounts(): { burst: number; fireflies: number; pollen: number } {
  const pc = PARTICLES[look!.particles], k = look!.budget.particles;
  return { burst: Math.round(pc.burst * k), fireflies: Math.round(pc.fireflies * k), pollen: Math.round(pc.pollen * k) };
}

function buildEnvMap(): void {
  envTex = null;
  if (!look!.reflections) return;
  try {
    const env = new Group();
    const skyTex = skyTexture();
    env.add(new Mesh(new SphereGeometry(10, 32, 16), new MeshBasicMaterial({ map: skyTex, side: BackSide, color: new Color(INV, INV, INV) })));
    const floor = new Mesh(new CircleGeometry(9.9, 32), new MeshBasicMaterial({ color: new Color(theme.ground).multiplyScalar(0.6 * INV) }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.4;
    env.add(floor);
    const sun = new Mesh(new SphereGeometry(0.9, 16, 8), new MeshBasicMaterial({ color: new Color(theme.light).multiplyScalar(4 * INV) }));
    sun.position.set(4, 10, 8).normalize().multiplyScalar(8.5);
    env.add(sun);
    envTex = new PMREMGenerator(renderer).fromScene(env, 0.02).texture;
  } catch (e) { console.warn(`environment: ${String(e)}`); envTex = null; }
}
function skyTexture(): Texture {
  const t = theme;
  return canvasTexture(256, (g, s) => {
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, hex(t.sky));
    grad.addColorStop(0.55, hex(t.sky));
    grad.addColorStop(0.8, hex(new Color(t.sky).lerp(new Color(t.horizon), 0.6).getHex()));
    grad.addColorStop(1, hex(t.horizon));
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
  });
}
/** render.js turned picking off on cosmetic objects; the engine's picks here are ray–plane only. */
function noPick(_o: Object3D): void { /* nothing to do */ }

function fitShadow(light: DirectionalLight): void {
  const lightDir = light.position.clone().sub(light.target.position).normalize();
  const view = new Matrix4().lookAt(lightDir, new Vector3(0, 0, 0), new Vector3(0, 1, 0));
  const inv = view.clone().invert();
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  for (const x of [-7.5, 7.5]) for (const y of [0, 2.2]) for (const z of [-3.5, 6]) { v.set(x, y, z).applyMatrix4(inv); min.min(v); max.max(v); }
  const cam = light.shadow.camera as unknown as { left: number; right: number; top: number; bottom: number; near: number; far: number; updateProjectionMatrix(): void };
  cam.left = min.x - 0.3; cam.right = max.x + 0.3;
  cam.bottom = min.y - 0.3; cam.top = max.y + 0.3;
  cam.near = 0.5; cam.far = 40;
  light.position.copy(lightDir.multiplyScalar(18));
  cam.updateProjectionMatrix();
}

function buildEnvironment(g: Group): void {
  const t = theme;
  const rng = visualRng.fork("env");
  const detail = look!.detailed ? DETAIL.detailed : DETAIL.plain;
  scene.fog = new Fog(t.fog, 14, 34);
  const sky = new Mesh(new SphereGeometry(45, 24, 12), new MeshBasicMaterial({ map: skyTexture(), side: BackSide, fog: false, color: new Color(INV, INV, INV) }));
  noPick(sky);
  g.add(sky);
  key = new DirectionalLight(t.light, t.lightIntensity * INV);
  key.position.set(4, 10, 8);
  key.target.position.set(0, 0, 0);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  fitShadow(key);
  g.add(key, key.target);
  hemi = new HemisphereLight(t.ambient, t.ground, (look!.reflections ? 0.55 : 1.3) * INV);
  g.add(hemi);
  const shadows = look!.shadows;
  renderer.shadowMap.enabled = shadows > 0;
  key.castShadow = shadows > 0;
  if (shadows > 0) key.shadow.mapSize = shadows;

  const groundGeo = new CircleGeometry(26, seg(detail.textures ? 96 : 48, 24), 0, Math.PI * 2);
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.attributes.position as BufferAttribute;
  const colors = new Float32Array(gpos.count * 3);
  const base = new Color(t.ground);
  const boost = detail.textures ? 1.1 : 1;
  for (let i = 0; i < gpos.count; i++) {
    const x = gpos.getX(i), z = gpos.getZ(i);
    const d = Math.hypot(x, z);
    gpos.setY(i, d > 5 ? Math.sin(x * 0.7) * Math.cos(z * 0.6) * 0.25 * Math.min(1, (d - 5) / 4) : 0);
    const shade = (0.85 + 0.3 * Math.sin(x * 1.7 + z * 2.3)) * boost;
    colors[i * 3] = base.r * shade; colors[i * 3 + 1] = base.g * shade; colors[i * 3 + 2] = base.b * shade;
  }
  gpos.needsUpdate = true;
  groundGeo.setAttribute("color", new BufferAttribute(colors, 3));
  groundGeo.computeVertexNormals();
  const ground = new Mesh(groundGeo, surf({ vertexColors: true, roughness: 1, envMapIntensity: 0.35, map: detail.textures ? groundDetailTexture() : null }));
  ground.receiveShadow = true;
  g.add(ground);

  if (detail.hills) {
    const hillGeo = new CylinderGeometry(23, 23, 1, seg(72, 36), 1, true);
    const hp = hillGeo.attributes.position as BufferAttribute;
    for (let i = 0; i < hp.count; i++) {
      if (hp.getY(i) > 0) {
        const a = Math.atan2(hp.getZ(i), hp.getX(i));
        hp.setY(i, 1.3 + 1.0 * Math.sin(a * 3 + 1) + 0.6 * Math.sin(a * 7 + 2) + 0.3 * Math.sin(a * 13));
      } else hp.setY(i, -0.5);
    }
    hp.needsUpdate = true;
    hillGeo.computeVertexNormals();
    const hills = new Mesh(hillGeo, surf({ color: new Color(t.foliage).multiplyScalar(0.8), roughness: 1, side: BackSide, envMapIntensity: 0.3 }));
    noPick(hills);
    g.add(hills);
  }
  const mats: Mats = {
    trunk: surf({ color: detail.textures ? 0xffffff : t.trunk, roughness: 0.95, map: detail.textures ? barkTexture(t) : null, envMapIntensity: 0.3 }),
    foliage: surf({ color: t.foliage, roughness: 0.85, flatShading: true, envMapIntensity: 0.45 }),
    foliageAlt: surf({ color: t.foliageAlt, roughness: 0.85, flatShading: true, envMapIntensity: 0.45 }),
    rock: surf({ color: 0x8a8d84, roughness: 0.9, flatShading: true, envMapIntensity: 0.5 }),
  };
  trees = [];
  for (let i = 0; i < detail.trees; i++) {
    const a = (i / detail.trees) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const r = rng.range(9, 15);
    const tree = makeTree(rng, detail, mats);
    tree.position.set(Math.cos(a) * r, 0, -Math.abs(Math.sin(a) * r) - 2);
    tree.rotation.y = rng.range(0, Math.PI * 2);
    const s = rng.range(0.8, 1.4);
    tree.scale.set(s, s, s);
    noPick(tree);
    g.add(tree);
    trees.push(tree);
  }
  for (let i = 0; i < 5; i++) {
    const rock = makeRock(rng, mats.rock);
    const a = rng.range(0, Math.PI * 2);
    rock.position.set(Math.cos(a) * rng.range(4, 7), 0.05, Math.sin(a) * rng.range(3, 6) - 1);
    g.add(rock);
  }
  const pondPos = new Vector3(-3.9, 0.08, 0.6);
  pondNormal = detail.textures ? rippleNormalTexture() : null;
  const pond = new Mesh(new CircleGeometry(1.4, seg(32, 16)), surf({
    color: new Color(t.water).multiplyScalar(0.55), roughness: 0.12, metalness: 0, normalMap: pondNormal, normalScale: new Vector2(0.18, 0.18),
    envMapIntensity: 0.9, polygonOffset: true, polygonOffsetFactor: -2,
  }, { clearcoat: 1, clearcoatRoughness: 0.05 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.copy(pondPos);
  pond.receiveShadow = true;
  g.add(pond);
  const bank = new Mesh(new RingGeometry(1.36, 1.62, seg(32, 16)),
    surf({ color: new Color(t.ground).multiplyScalar(0.6), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, envMapIntensity: 0.3 }));
  bank.rotation.x = -Math.PI / 2;
  bank.position.copy(pondPos);
  bank.position.y -= 0.005;
  bank.receiveShadow = true;
  g.add(bank);
  const padMat = surf({ color: new Color(t.foliageAlt).multiplyScalar(0.9), roughness: 0.6, side: DoubleSide, envMapIntensity: 0.6 });
  pads = [];
  for (let i = 0; i < detail.pads; i++) {
    const pad = new Mesh(new CircleGeometry(rng.range(0.14, 0.22), 14, 0.35, Math.PI * 2 - 0.35), padMat);
    pad.rotation.set(-Math.PI / 2, 0, rng.range(0, Math.PI * 2));
    const a = rng.range(0, Math.PI * 2), rr = rng.range(0.3, 0.95);
    pad.position.set(pondPos.x + Math.cos(a) * rr, pondPos.y + 0.012, pondPos.z + Math.sin(a) * rr);
    pad.userData.phase = rng.range(0, 6);
    pad.receiveShadow = true;
    g.add(pad);
    pads.push(pad);
  }
  grass = null;
  if (detail.grass) {
    const blade = new ConeGeometry(0.035, 0.32, 3, 1, true);
    blade.translate(0, 0.16, 0);
    const parts: BufferGeometry[] = [];
    for (let k = 0; k < 3; k++) {
      const b = blade.clone();
      b.rotateZ((k - 1) * 0.35);
      b.translate((k - 1) * 0.05, 0, (k % 2) * 0.03);
      parts.push(b);
    }
    const tuft = mergeGeometries(parts);
    const mat = surf({ color: new Color(t.foliageAlt).lerp(new Color(t.ground), 0.3), roughness: 0.9, envMapIntensity: 0.4 });
    const n = Math.round(detail.grass * look!.budget.grass);
    const inst = new InstancedMesh(tuft, mat, Math.max(1, n));
    const m4 = new Matrix4(), q = new Quaternion(), sc = new Vector3(), p = new Vector3();
    const up = new Vector3(0, 1, 0);
    const baseMats: Matrix4[] = [];
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
      baseMats.push(m4.clone());
    }
    inst.count = placed;
    inst.receiveShadow = true;
    noPick(inst);
    g.add(inst);
    grass = { mesh: inst, base: baseMats };
  }
  const pc = particleCounts();
  const night = t.id === "night" || t.id === "dusk";
  fireflies = pollen = null;
  if (night && pc.fireflies) fireflies = makeDrift(g, rng, pc.fireflies, new Color(0xd8f090).multiplyScalar(3.2 * INV * 2), 0.14, 0.95, [0.3, 3.5]);
  if (!night && pc.pollen) pollen = makeDrift(g, rng, pc.pollen, new Color(0xfff1c8).multiplyScalar(0.9), 0.06, 0.55, [0.4, 3.2]);
}
function makeDrift(g: Group, rng: Rng, n: number, color: Color, size: number, opacity: number, [y0, y1]: [number, number]): Points {
  const geo = new BufferGeometry();
  const pos = new Float32Array(n * 3);
  const seeds = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = rng.range(-10, 10); pos[i * 3 + 1] = rng.range(y0, y1); pos[i * 3 + 2] = rng.range(-8, 6);
    seeds[i * 2] = rng.range(0, 100); seeds[i * 2 + 1] = rng.range(0.3, 1);
  }
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const pts = new Points(geo, new PointsMaterial({ color, size, map: glowSprite(), transparent: true, opacity, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }));
  pts.userData.seeds = seeds;
  noPick(pts);
  g.add(pts);
  return pts;
}
function buildWheelBase(g: Group): void {
  const t = theme;
  const detail = look!.detailed ? DETAIL.detailed : DETAIL.plain;
  const sideMat = surf({ color: detail.textures ? 0xffffff : t.trunk, map: detail.textures ? barkTexture(t) : null, roughness: 0.9, envMapIntensity: 0.4 });
  const topMat = detail.textures
    ? surf({ map: ringsTexture(t), roughness: 0.55, envMapIntensity: 0.6 }, { clearcoat: 0.35, clearcoatRoughness: 0.45 })
    : surf({ color: t.trunk, roughness: 0.85 });
  const base = new Mesh(new CylinderGeometry(FRAMING.wheelRadius + 0.55, FRAMING.wheelRadius + 0.7, 0.18, seg(48, 24)), [sideMat, topMat, sideMat] as never);
  base.position.set(0, 0.09, FRAMING.wheelZ);
  base.receiveShadow = true;
  base.castShadow = true;
  g.add(base);
  const rim = new Mesh(new TorusGeometry(FRAMING.wheelRadius + 0.62, 0.05, seg(10, 5), seg(64, 32)), surf({ color: 0xb08a4e, roughness: 0.35, metalness: 0.7, envMapIntensity: 1.0 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, 0.19, FRAMING.wheelZ);
  rim.castShadow = true;
  g.add(rim);
  pathSegments = [];
  for (let i = 0; i < 7; i++) {
    const segMat = new MeshBasicMaterial({ color: new Color(0xffe9a8).multiplyScalar(2.4 * INV), transparent: true, opacity: 0.9 });
    const s = new Mesh(new CylinderGeometry(0.045, 0.045, 1, 8), segMat);
    s.visible = false;
    noPick(s);
    g.add(s);
    pathSegments.push(s);
  }
  cursorDot = new Mesh(new SphereGeometry(0.07, 12, 8), new MeshBasicMaterial({ color: new Color(0xffe9a8).multiplyScalar(2.4 * INV), transparent: true, opacity: 0.9 }));
  cursorDot.visible = false;
  noPick(cursorDot);
  g.add(cursorDot);
}
function buildParticles(g: Group): void {
  const n = Math.max(1, particleCounts().burst);
  const geo = new BufferGeometry();
  const pos = new Float32Array(n * 3).fill(-10);
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const pts = new Points(geo, new PointsMaterial({ color: burstColor(0xa8d878), size: 0.13, map: glowSprite(), transparent: true, opacity: 0.95, depthWrite: false, sizeAttenuation: true }));
  pts.frustumCulled = false;
  noPick(pts);
  g.add(pts);
  burst = { pts, pos, vel: new Float32Array(n * 3), life: new Float32Array(n), count: n };
}
const burstColor = (h: number): Color => new Color(h).multiplyScalar(1.6 / EXPOSURE);

/** Rebuilds the whole grove from what it shows (theme, letters, flowers) — render.js rebuild(). */
function rebuild(): void {
  if (!look) return;
  if (root) scene.remove(root);
  B = look.budget;
  reflections = look.reflections;
  buildEnvMap();
  const g = new Group();
  buildEnvironment(g);
  buildWheelBase(g);
  buildParticles(g);
  scene.add(g);
  root = g;
  built = true;
  tiles = [];
  if (letters.length) setLetters(letters, true);
  const fl = flowers;
  flowers = [];
  flowerObjs = [];
  for (const f of fl) bloomWord(f.big ? "target" : "bonus", f.word, true);
}

// ---------------------------------------------------------------- the public API
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  // three r160 page: r160 UnrealBloom at the page's strength
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.5, radius: 0.5, threshold: BLOOM_THRESHOLD, resolution: next.budget.bloomRes } : null;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.45, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: next.ao === "high" ? 16 : 8,
    resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8 },
  };
  // GradeShader after OutputPass (display space): a 0.18 S-curve, saturation 1.1, cool shadows / warm highlights by a
  // smoothstep of luma 0.2–0.8, lifted × 0.975 + 0.018, the 0.2 vignette from 0.38 to 0.9 (x stretched 1.1)
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.1, split: [0.2, 0.8], shadows: [0.97, 0.99, 1.04], highlights: [1.035, 1.0, 0.965],
    levels: [0.975, 0.018],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  rebuild();
}
export function setTheme(id: string): void {
  const next = themeOf(id);
  if (next.id === theme.id && built) return;
  theme = next;
  rebuild();
}
export function themeId(): string { return theme.id; }
/** A new round: the theme, the letters and a fresh garden (render.js setTheme + resetGarden + setLetters). */
export function startRound(themeName: string, ls: string[], seed: string): void {
  theme = themeOf(themeName);
  visualRng = rngOf("visual:title-grove").fork(seed);
  flowers = [];
  letters = ls.slice();
  selection = [];
  selectedSet = new Set();
  rebuild();
}
export function resetGarden(themeName: string): void {
  theme = themeOf(themeName);
  flowers = [];
  letters = [];
  selection = [];
  selectedSet = new Set();
  visualRng = rngOf("visual:title-grove");
  rebuild();
}
export function setOptions(o: { reducedMotion: boolean; sway: boolean; textColor: string }): void {
  reduced = o.reducedMotion;
  swayOn = o.sway;
  if (o.textColor !== textColor) {
    textColor = o.textColor;
    if (letters.length && built) setLetters(letters, true);
  }
}
export function setLetters(ls: string[], snap = false): void {
  if (!root || !look) { letters = ls.slice(); return; }
  // a shuffle keeps each letter's token and moves it (render.js rebuilt the tokens; same look)
  const prev = tiles;
  for (const t of prev) root.remove(t.group);
  letters = ls.slice();
  const shadowsOff = look.shadows === 0;
  tiles = letters.map((letter) => {
    const group = new Group();
    const body = new Mesh(new CylinderGeometry(0.42, 0.46, 0.22, seg(32, 16)),
      surf({ color: 0xf3e6c8, roughness: 0.5, envMapIntensity: 0.6 }, { clearcoat: 0.7, clearcoatRoughness: 0.28 }));
    body.castShadow = true;
    body.position.y = 0.11;
    const face = new Mesh(new CircleGeometry(0.4, 32), new MeshBasicMaterial({ map: letterTexture(letter, textColor), transparent: true, color: new Color(INV, INV, INV) }));
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.225;
    const marker = new Mesh(new TorusGeometry(0.5, 0.035, seg(8, 4), seg(40, 20)),
      new MeshBasicMaterial({ color: new Color(0xffd76a).multiplyScalar(1.8 * INV), transparent: true, opacity: 0 }));
    marker.rotation.x = Math.PI / 2;
    marker.position.y = 0.02;
    const blob = new Mesh(new CircleGeometry(0.55, 24), new MeshBasicMaterial({ map: glowSprite(), color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2;
    blob.visible = shadowsOff;
    group.add(body, face, marker, blob);
    noPick(group);
    root!.add(group);
    return { letter, group, body, face, marker, blob, lift: 0, liftVel: 0, spin: 0, spinTarget: 0, x: 0, z: 0, vx: 0, vz: 0, targetX: 0, targetZ: 0 };
  });
  layoutTiles(true);
  if (!snap && prev.length === tiles.length) {
    // start each token from where the same letter sat, so it glides to its new slot
    const used = new Set<number>();
    tiles.forEach((t) => {
      const j = prev.findIndex((p, k) => !used.has(k) && p.letter === t.letter);
      if (j < 0) return;
      used.add(j);
      const p = prev[j]!;
      t.x = p.x; t.z = p.z; t.spin = p.spin; t.spinTarget = p.spinTarget;
      t.group.position.set(t.x, FRAMING.wheelY, t.z);
    });
  }
  setSelection(selection, cursorWorld);
}
function layoutTiles(snap: boolean): void {
  const n = tiles.length;
  tiles.forEach((t, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    t.targetX = Math.cos(a) * FRAMING.wheelRadius;
    t.targetZ = Math.sin(a) * FRAMING.wheelRadius + FRAMING.wheelZ;
    if (snap) { t.group.position.set(t.targetX, FRAMING.wheelY, t.targetZ); t.x = t.targetX; t.z = t.targetZ; t.vx = 0; t.vz = 0; }
  });
}
export function shuffleVisual(ls: string[]): void {
  setLetters(ls);
  for (const t of tiles) t.spinTarget += Math.PI * 2;
}
const up = new Vector3(0, 1, 0);
export function setSelection(indices: number[], cursor: { x: number; z: number } | null): void {
  selection = indices.slice();
  cursorWorld = cursor;
  selectedSet = new Set(indices);
  const pts = indices.map((i) => tiles[i]).filter((t): t is Tile => !!t);
  pathSegments.forEach((s, i) => {
    if (i < pts.length - 1) {
      const a = pts[i]!.group.position, b = pts[i + 1]!.group.position;
      s.position.set((a.x + b.x) / 2, FRAMING.wheelY + 0.3, (a.z + b.z) / 2);
      const dir = new Vector3().subVectors(b, a);
      s.scale.set(1, Math.max(0.001, dir.length()), 1);
      s.quaternion.setFromUnitVectors(up, dir.normalize());
      s.visible = true;
    } else s.visible = false;
  });
  if (!cursorDot) return;
  if (cursor && pts.length) {
    cursorDot.visible = true;
    cursorDot.position.set(cursor.x, FRAMING.wheelY + 0.3, cursor.z);
    const last = pts[pts.length - 1]!.group.position;
    const s = pathSegments[pts.length - 1];
    if (s) {
      const dir = new Vector3(cursor.x - last.x, 0, cursor.z - last.z);
      if (dir.length() > 0.05) {
        s.visible = true;
        s.position.set((cursor.x + last.x) / 2, FRAMING.wheelY + 0.3, (cursor.z + last.z) / 2);
        s.scale.set(1, dir.length(), 1);
        s.quaternion.setFromUnitVectors(up, dir.normalize());
      }
    }
  } else cursorDot.visible = false;
}
export function bloomWord(kind: string, word: string, instant = false): void {
  if (!root) return;
  const rng = rngOf("flower:" + word + ":" + flowers.length);
  const big = kind === "target";
  const flower = makeFlower(rng, theme, big);
  const idx = flowers.length;
  const a = -Math.PI * 0.15 - (idx % 5) * 0.5 + (idx >= 5 ? -0.25 : 0);
  const r = 4.2 + (idx % 3) * 0.9 + rng.range(-0.3, 0.3);
  const side = idx % 2 === 0 ? 1 : -1;
  flower.position.set(Math.cos(a) * r * side * 0.9, 0, 2.2 + Math.sin(a * 2) * 1.2 + (idx >= 5 ? -2.2 : 0));
  flower.userData.grow = instant ? 1 : 0;
  flower.scale.setScalar(instant ? 1 : 0.01);
  flower.userData.rngPhase = rng.range(0, Math.PI * 2);
  noPick(flower);
  root.add(flower);
  flowers.push({ word, big });
  flowerObjs.push(flower);
  if (!instant && !reduced) spawnBurst(flower.position, big ? 40 : 18);
}
export function hintBloom(): void { if (!reduced) spawnBurst(new Vector3(0, 1.5, 0), 10, 0xffe9a8); }
export function celebrate(): void {
  if (!reduced) for (let i = 0; i < 4; i++) spawnBurst(new Vector3((i - 1.5) * 1.5, 1.2, 0), 40, i % 2 ? 0xffe9a8 : 0xa8d878);
  for (const f of flowerObjs) f.userData.cheer = 1;
}
function spawnBurst(origin: Vector3, count: number, color: number | null = null): void {
  const b = burst;
  if (!b) return;
  let placed = 0;
  for (let i = 0; i < b.count && placed < count; i++) {
    if (b.life[i]! > 0) continue;
    b.life[i] = 1 + Math.random() * 0.8;
    b.pos[i * 3] = origin.x; b.pos[i * 3 + 1] = origin.y + 0.3; b.pos[i * 3 + 2] = origin.z;
    const a = Math.random() * Math.PI * 2;
    const v = 1 + Math.random() * 2;
    b.vel[i * 3] = Math.cos(a) * v; b.vel[i * 3 + 1] = 1.5 + Math.random() * 2; b.vel[i * 3 + 2] = Math.sin(a) * v;
    placed++;
  }
  (b.pts.material as PointsMaterial).color.copy(burstColor(color || 0xa8d878));
  (b.pts.geometry.attributes.position as BufferAttribute).needsUpdate = true;
}

// ---------------------------------------------------------------- the camera fit (render.js resize)
/** The window-pixel band of the window the wheel may use (between the crossword stack and the controls). */
export function setSafeBand(top: number, bottom: number, left: number, right: number): void {
  band = { top: Math.max(0, top), bottom: Math.max(0, bottom), left: Math.max(0, left), right: Math.max(0, right) };
}
function fitCamera(w: number, h: number): void {
  const portrait = h > w;
  const cfg = portrait ? FRAMING.camera.portrait : FRAMING.camera.landscape;
  camera.fov = cfg.fov;
  const top = Math.min(band.top, h * 0.6), bottom = Math.min(band.bottom, h * 0.35);
  const left = Math.min(band.left, w * 0.5), right = Math.min(band.right, w * 0.5);
  const sh = Math.max(1, h - top - bottom), sw = Math.max(1, w - left - right);
  if (sh < h * 0.3 || sw < w * 0.35) { camera.aspect = w / h; camera.clearViewOffset(); }
  else { camera.aspect = sw / sh; camera.setViewOffset(sw, sh, -left, -top, w, h); }
  camera.updateProjectionMatrix();
  const lk = new Vector3(cfg.look[0], cfg.look[1], cfg.look[2]);
  const base = new Vector3(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
  const dir = base.clone().sub(lk).normalize();
  const r = FRAMING.wheelRadius + 0.55;
  const pts: Vector3[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * r, FRAMING.wheelY, FRAMING.wheelZ + Math.sin(a) * r));
    pts.push(new Vector3(Math.cos(a) * r, FRAMING.wheelY + 0.5, FRAMING.wheelZ + Math.sin(a) * r));
  }
  const probe = new PerspectiveCamera(camera.fov, camera.aspect, 0.1, 200);
  const v = new Vector3();
  let d = base.distanceTo(lk) * 0.45;
  for (let i = 0; i < 14; i++) {
    probe.position.copy(lk).addScaledVector(dir, d);
    probe.lookAt(lk); probe.updateMatrixWorld(); probe.updateProjectionMatrix();
    let over = 0;
    for (const q of pts) { v.copy(q).project(probe); over = Math.max(over, Math.abs(v.x) / 0.95, Math.abs(v.y) / 0.9); }
    if (over <= 1) break;
    d *= Math.min(1.6, over + 0.02);
  }
  camBase = lk.clone().addScaledVector(dir, d);
  camLook = lk;
  camera.position.copy(camBase);
  camera.lookAt(camLook);
}

// ---------------------------------------------------------------- each frame (render.js update)
const shear = new Matrix4();
const m4 = new Matrix4();
export function frame(dtS: number, w: number, h: number): void {
  if (!look || !built) return;
  const dt = Math.min(dtS, 0.1);
  time += dt;
  if (w > 0 && h > 0) {
    const k = `${w}x${h}:${band.top | 0},${band.bottom | 0},${band.left | 0},${band.right | 0}`;
    if (k !== fitKey) { fitKey = k; win = { w, h }; fitCamera(w, h); }
  }
  const ambient = !reduced && look.animated;
  if (!reduced && swayOn) {
    swayT += dt;
    const a = FRAMING.swayAmplitude;
    const p = (swayT / FRAMING.swayPeriodSec) * Math.PI * 2;
    camera.position.set(camBase.x + Math.sin(p) * a, camBase.y + Math.sin(p * 0.7 + 1) * a * 0.5, camBase.z);
  } else camera.position.copy(camBase);
  camera.lookAt(camLook);

  tiles.forEach((t, i) => {
    const sel = selectedSet.has(i);
    [t.lift, t.liftVel] = spring(t.lift, sel ? 0.32 : 0, t.liftVel, 0.12, dt);
    [t.x, t.vx] = spring(t.x, t.targetX, t.vx, 0.25, dt);
    [t.z, t.vz] = spring(t.z, t.targetZ, t.vz, 0.25, dt);
    t.group.position.set(t.x, FRAMING.wheelY + t.lift, t.z);
    t.spin = t.spin + (t.spinTarget - t.spin) * Math.min(1, dt * 8);
    t.body.rotation.y = t.spin;
    const mm = t.marker.material as MeshBasicMaterial;
    mm.opacity += ((sel ? 0.95 : 0) - mm.opacity) * Math.min(1, dt * 12);
    const bm = t.body.material as MeshStandardMaterial;
    if (bm.emissive) bm.emissive.setHex(sel ? 0x33280a : 0x000000);
    if (t.blob.visible) {
      t.blob.position.y = 0.186 - (FRAMING.wheelY + t.lift);
      const s = 1 + t.lift * 0.8;
      t.blob.scale.set(s, s, 1);
      (t.blob.material as MeshBasicMaterial).opacity = 0.38 / (1 + t.lift * 2.5);
    }
  });
  if (selection.length) setSelection(selection, cursorWorld);

  for (const f of flowerObjs) {
    const u = f.userData as { grow: number; rngPhase: number; cheer?: number; head: Group };
    if (u.grow < 1) {
      u.grow = Math.min(1, u.grow + dt * (reduced ? 4 : 1.4));
      const s = reduced ? (u.grow >= 1 ? 1 : 0.01) : easeOutBack(u.grow);
      f.scale.setScalar(Math.max(0.01, s));
    } else if (!reduced) {
      f.rotation.z = Math.sin(time * 1.1 + u.rngPhase) * 0.05 * (u.cheer ? 3 : 1);
      if (u.cheer) {
        u.cheer = Math.max(0, u.cheer - dt * 0.5);
        u.head.rotation.y += dt * 6 * u.cheer;
      }
    }
  }
  if (ambient) {
    for (const tree of trees) {
      const ph = tree.userData.phase as number, c = tree.userData.canopy as Group;
      c.rotation.z = Math.sin(time * 0.7 + ph) * 0.018;
      c.rotation.x = Math.sin(time * 0.5 + ph * 1.3) * 0.012;
    }
    if (pondNormal) { pondNormal.offset.x = time * 0.02; pondNormal.offset.y = time * 0.013; }
    for (const pad of pads) pad.rotation.z += Math.sin(time * 0.4 + (pad.userData.phase as number)) * 0.0006;
    if (grass) {
      // the tufts' wind: a shear of the blade by its height (the old vertex patch bent by height²)
      const gm = grass.mesh;
      for (let i = 0; i < grass.base.length; i++) {
        const b = grass.base[i]!;
        const e = b.elements;
        const ix = e[12]!, iz = e[14]!;
        const sx = Math.sin(time * 1.6 + ix * 0.7 + iz * 0.5) * 0.09 * 0.5;
        const sz = Math.cos(time * 1.2 + iz * 0.8) * 0.05 * 0.5;
        shear.set(1, sx, 0, 0, 0, 1, 0, 0, 0, sz, 1, 0, 0, 0, 0, 1);
        m4.multiplyMatrices(b, shear);
        gm.setMatrixAt(i, m4);
      }
      gm.instanceMatrix.needsUpdate = true;
    }
  }
  if (!reduced && burst) {
    const b = burst;
    let any = false;
    for (let i = 0; i < b.count; i++) {
      if (b.life[i]! <= 0) continue;
      any = true;
      b.life[i] = b.life[i]! - dt;
      b.vel[i * 3 + 1] = b.vel[i * 3 + 1]! - 4 * dt;
      b.pos[i * 3] = b.pos[i * 3]! + b.vel[i * 3]! * dt;
      b.pos[i * 3 + 1] = Math.max(0.02, b.pos[i * 3 + 1]! + b.vel[i * 3 + 1]! * dt);
      b.pos[i * 3 + 2] = b.pos[i * 3 + 2]! + b.vel[i * 3 + 2]! * dt;
      if (b.life[i]! <= 0) { b.pos[i * 3] = 0; b.pos[i * 3 + 1] = -10; b.pos[i * 3 + 2] = 0; }
    }
    if (any) (b.pts.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    if (fireflies) drift(fireflies, 1);
    if (pollen && ambient) drift(pollen, 0.5);
    if (fireflies) (fireflies.material as PointsMaterial).opacity = 0.75 + 0.25 * Math.sin(time * 2.3);
  }
}
function drift(points: Points, k: number): void {
  const fp = points.geometry.attributes.position as BufferAttribute;
  const arr = fp.array as Float32Array;
  const seeds = points.userData.seeds as Float32Array;
  for (let i = 0; i < fp.count; i++) {
    const s = seeds[i * 2]!, sp = seeds[i * 2 + 1]!;
    arr[i * 3] = arr[i * 3]! + Math.sin(time * sp + s) * 0.004 * k;
    arr[i * 3 + 1] = arr[i * 3 + 1]! + Math.cos(time * sp * 0.7 + s) * 0.003 * k;
  }
  fp.needsUpdate = true;
}

// ---------------------------------------------------------------- the shared layout model
const pv = new Vector3();
/** A tile's window-pixel centre (render.js projectTile). */
export function projectTile(i: number): { x: number; y: number } | null {
  const t = tiles[i];
  if (!t || !win.w) return null;
  camera.updateMatrixWorld();
  pv.copy(t.group.position).project(camera);
  return { x: (pv.x * 0.5 + 0.5) * win.w, y: (-pv.y * 0.5 + 0.5) * win.h };
}
export function tileCount(): number { return tiles.length; }
const raycaster = new Raycaster();
const ndc = new Vector2();
const wheelPlane = new Plane(new Vector3(0, 1, 0), -FRAMING.wheelY);
/** A window point on the wheel plane (the drag cursor). */
export function screenToWheel(x: number, y: number): { x: number; z: number } | null {
  if (!win.w) return null;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  const out = new Vector3();
  return raycaster.ray.intersectPlane(wheelPlane, out) ? { x: out.x, z: out.z } : null;
}
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }
