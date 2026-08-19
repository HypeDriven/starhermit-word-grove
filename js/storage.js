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
  if (!raw) return structuredClone(defaults);
  try {
    const doc = JSON.parse(raw);
    if (doc.check !== checksum(doc.payload)) return structuredClone(defaults);
    const data = JSON.parse(doc.payload);
    if (data.version > defaults.version) return structuredClone(defaults);
    return migrateDoc(data, defaults);
  } catch {
    return structuredClone(defaults);
  }
}

function writeDoc(key, data) {
  const payload = JSON.stringify(data);
  rawSet(key, JSON.stringify({ v: 1, check: checksum(payload), payload }));
}

function migrateDoc(data, defaults) {
  // Fill newly introduced fields; older versions upgrade in place.
  const merged = Object.assign(structuredClone(defaults), data);
  merged.version = defaults.version;
  return merged;
}

// -------------------------------------------------------------- settings ---

export const DEFAULT_SETTINGS = {
  version: 1,
  volumes: { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.8 },
  muted: false,
  quality: 'auto', // auto | high | medium | low
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
  bindings: {
    submit: 'Enter', cancel: 'Escape', shuffle: 's', hint: 'h',
    undo: 'u', pause: 'p', deleteLetter: 'Backspace', cameraReset: 'c',
  },
};

const SETTINGS_KEY = 'wordgrove:settings:v1';
export function loadSettings() { return readDoc(SETTINGS_KEY, DEFAULT_SETTINGS); }
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

// Cloud-save conflict handling: keep both snapshots, prefer strict descendant.
export function resolveProgressConflict(local, remote) {
  if (!remote) return { winner: local, conflict: false };
  if (!local) return { winner: remote, conflict: false };
  if (remote.updatedAt > local.updatedAt && (remote.flowers ?? 0) >= (local.flowers ?? 0)
    && Object.keys(remote.journey).length >= Object.keys(local.journey).length) {
    return { winner: remote, conflict: false }; // remote is a descendant
  }
  if (local.updatedAt >= remote.updatedAt && (local.flowers ?? 0) >= (remote.flowers ?? 0)) {
    return { winner: local, conflict: false };
  }
  return { winner: null, conflict: true, local, remote }; // caller must ask the player
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
