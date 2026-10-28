// Word Grove — local persistence: settings, progression, leaderboards.
// Documents are versioned and checksummed; conflicts are resolved by the
// caller (cloud sync keeps both snapshots and asks when neither descends).

import { checksum } from './rng.js';

const LS = (typeof localStorage !== 'undefined') ? localStorage : null;
const memory = new Map(); // fallback when storage is unavailable (private mode)

function rawGet(k) {
  try { return LS ? LS.getItem(k) : memory.get(k) ?? null; } catch { return memory.get(k) ?? null; }
}
function rawSet(k, v) {
  try { if (LS) LS.setItem(k, v); else memory.set(k, v); } catch { memory.set(k, v); }
}

function readDoc(key, defaults) {
  const raw = rawGet(key);
  if (!raw) return JSON.parse(JSON.stringify(defaults));
  try {
    const doc = JSON.parse(raw);
    if (doc.check !== checksum(doc.payload)) return JSON.parse(JSON.stringify(defaults));
    const data = JSON.parse(doc.payload);
    if (data.version > defaults.version) return JSON.parse(JSON.stringify(defaults));
    return migrateDoc(data, defaults);
  } catch {
    return JSON.parse(JSON.stringify(defaults));
  }
}

function writeDoc(key, data) {
  const payload = JSON.stringify(data);
  rawSet(key, JSON.stringify({ v: 1, check: checksum(payload), payload }));
}

function migrateDoc(data, defaults) {
  // Fill newly introduced fields; older versions upgrade in place.
  const merged = Object.assign(JSON.parse(JSON.stringify(defaults)), data);
  merged.version = defaults.version;
  return merged;
}

// -------------------------------------------------------------- settings ---

export const DEFAULT_SETTINGS = {
  version: 1,
  volumes: { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.8 },
  muted: false,
  // Graphics quality (see gfx.js): preset auto|low|balanced|high|ultra, render
  // scale, adaptive resolution, frame-rate readout and per-category overrides.
  graphics: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false },
  reducedMotion: false,
  highContrast: false,
  palette: 'default', // default | deuteranopia | protanopia | tritanopia
  textSize: 'normal', // normal | large | xlarge
  leftHanded: false,
  submitOnRelease: true, // hold-vs-toggle for word submit
  haptics: true,
  cameraSway: true,
  showTimer: true,
  tutorialSeen: false,
  analyticsConsent: false,
};

const SETTINGS_KEY = 'wordgrove:settings:v1';
export function loadSettings() {
  const s = readDoc(SETTINGS_KEY, DEFAULT_SETTINGS);
  if (!s.graphics || typeof s.graphics !== 'object') s.graphics = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.graphics));
  // Older saves stored a single quality tier; carry it over as a preset.
  if ('quality' in s) {
    const mapped = { high: 'high', medium: 'balanced', low: 'low' }[s.quality];
    if (mapped && s.graphics.preset === 'auto') s.graphics.preset = mapped;
    delete s.quality;
  }
  return s;
}
export function saveSettings(s) { writeDoc(SETTINGS_KEY, s); }

// ------------------------------------------------------------- progress ----

export const DEFAULT_PROGRESS = {
  version: 1,
  displayName: 'Gardener',
  tutorialDone: false,
  journey: {},          // index -> { score, stars, bestSec, completedAt }
  flowers: 0,           // total words found across all modes (cosmetic currency)
  totals: { words: 0, bonus: 0, invalid: 0, sessions: 0, playSec: 0 },
  mechanicsUsed: {},    // shuffle|hint|bonus|undo -> true
  achievements: {},     // key -> timestamp ms
  dailyDays: [],        // UTC dates completed
  lastDaily: null,
  challengeBest: {},    // challengeId -> { score, sec }
  selectedTheme: 'dawn',
  updatedAt: 0,
};

const PROGRESS_KEY = 'wordgrove:progress:v1';
export function loadProgress() { return readDoc(PROGRESS_KEY, DEFAULT_PROGRESS); }
export function saveProgress(p) { p.updatedAt = Date.now(); writeDoc(PROGRESS_KEY, p); }

// Cloud-save merge (boot load and after a refused conditional write): keep
// the better of both sides so no device's progress is lost — best score and
// stars per journey stage, unions of achievements (earliest time), mechanics,
// daily days, larger totals/flowers, best per challenge; the theme, name and
// tutorial flag follow this device (`local`) unless it has none.
export function mergeProgress(remote, local) {
  if (!remote) return local;
  if (!local) return remote;
  const out = { ...DEFAULT_PROGRESS, ...remote, ...local };
  const journey = { ...(remote.journey || {}) };
  for (const [i, l] of Object.entries(local.journey || {})) {
    const r = journey[i];
    if (!r) { journey[i] = l; continue; }
    const best = (l.score ?? 0) >= (r.score ?? 0) ? l : r;
    journey[i] = { ...best, stars: Math.max(l.stars ?? 0, r.stars ?? 0), bestSec: Math.min(l.bestSec ?? Infinity, r.bestSec ?? Infinity) };
    if (!Number.isFinite(journey[i].bestSec)) delete journey[i].bestSec;
  }
  out.journey = journey;
  out.flowers = Math.max(remote.flowers ?? 0, local.flowers ?? 0);
  out.totals = {};
  for (const k of new Set([...Object.keys(remote.totals || {}), ...Object.keys(local.totals || {})])) {
    out.totals[k] = Math.max(remote.totals?.[k] ?? 0, local.totals?.[k] ?? 0);
  }
  out.mechanicsUsed = { ...(remote.mechanicsUsed || {}), ...(local.mechanicsUsed || {}) };
  out.achievements = { ...(remote.achievements || {}) };
  for (const [k, v] of Object.entries(local.achievements || {})) out.achievements[k] = k in out.achievements ? Math.min(out.achievements[k], v) : v;
  out.dailyDays = [...new Set([...(remote.dailyDays || []), ...(local.dailyDays || [])])].sort();
  out.lastDaily = [remote.lastDaily, local.lastDaily].filter(Boolean).sort().pop() || null;
  out.challengeBest = { ...(remote.challengeBest || {}) };
  for (const [id, l] of Object.entries(local.challengeBest || {})) {
    const r = out.challengeBest[id];
    out.challengeBest[id] = !r || (l.score ?? 0) > (r.score ?? 0) ? l : r;
  }
  out.tutorialDone = !!(remote.tutorialDone || local.tutorialDone);
  out.updatedAt = Math.max(remote.updatedAt ?? 0, local.updatedAt ?? 0);
  return out;
}

/** Local boards: union per board, one entry per session, best first (50). */
export function mergeBoards(remote, local) {
  const out = { ...DEFAULT_BOARDS, ...remote, ...local, boards: {} };
  const ids = new Set([...Object.keys(remote?.boards || {}), ...Object.keys(local?.boards || {})]);
  for (const id of ids) {
    const seen = new Set();
    const entries = [...(local?.boards?.[id]?.entries || []), ...(remote?.boards?.[id]?.entries || [])]
      .filter((e) => { const k = e.sessionId ?? JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 50);
    out.boards[id] = { ...(remote?.boards?.[id] || {}), ...(local?.boards?.[id] || {}), entries };
  }
  return out;
}

// ----------------------------------------------------------- leaderboards --

const BOARDS_KEY = 'wordgrove:boards:v1';
export const DEFAULT_BOARDS = { version: 1, boards: {} };
export function loadBoards() { return readDoc(BOARDS_KEY, DEFAULT_BOARDS); }
export function saveBoards(b) { writeDoc(BOARDS_KEY, b); }

// ------------------------------------------------------------ last state ---

const SNAPSHOT_KEY = 'wordgrove:last-session:v1';
export function saveLastSnapshot(snap) { rawSet(SNAPSHOT_KEY, JSON.stringify(snap)); }
export function loadLastSnapshot() {
  try { const r = rawGet(SNAPSHOT_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
export function clearLastSnapshot() { try { LS ? LS.removeItem(SNAPSHOT_KEY) : memory.delete(SNAPSHOT_KEY); } catch { /* ignore */ } }
