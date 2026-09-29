// Word Grove — graphics quality model: presets, per-category overrides, GPU
// detection and a cost summary. Pure (no three.js) so the settings panel, the
// renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'], // sky image-based lighting on tiles, pond and wood
  particles: ['low', 'high'], // burst pool size, fireflies, drifting pollen
  background: ['static', 'animated'], // canopy/grass wind, pond ripples, pollen drift
  detail: ['plain', 'detailed'], // tree count, grass tufts, ground/wood textures
};

// Each preset: tiers, a device-pixel-ratio cap and a render scale multiplier.
const TABLE = {
  low: { dprCap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { dprCap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'low', background: 'animated', detail: 'detailed' },
  high: { dprCap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { dprCap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

/** Best preset for this GPU (unmasked renderer string). `mobile` caps it at balanced. */
export function detectPreset(gpu, mobile = false) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    dprCap: row.dprCap,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; MSAA alone uses the canvas.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override (keeps scale/adaptive/fps). */
export function choosePreset(saved, preset) {
  const s = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short cost summary. `t` optionally translates the fixed words. */
export function describe(r, pixels, t = (k, d) => d) {
  const parts = [
    r.shadows === 'off' ? t('noShadows', 'no shadows') : `${SHADOW_MAP[r.shadows]}² ${t('shadows', 'shadows')}`,
    r.ao === 'off' ? null : t('ao', 'ambient occlusion'),
    r.bloom === 'on' ? t('bloom', 'bloom') : null,
    r.reflections === 'on' ? t('reflections', 'reflections') : null,
    r.antialias === 'off' ? t('noAA', 'no anti-aliasing') : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
