// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus for every event audio.js mapped), the theme's ambience
// (rain: two seconds of noise through a 1800 Hz low-pass; birds, wind and
// crickets: the low sine pad through a 400 Hz low-pass with the old chirps —
// two-note bird calls every 2.5–6.5 s, cricket triple clicks every 4–8 s —
// placed in a 16 s loop) at the old ambience gain 0.5 × bus 0.7, and the
// adaptive music (the four four-second chords as sines at 0.05 + intensity ×
// 0.03; above intensity 0.4 the octave layer, above 0.7 the arpeggio note)
// on the old music bus × 0.5: the chord loop and the two upper layers are
// rendered once into clips and the layers fade in with the intensity. The
// runtime has no ambience bus, so the ambience plays on the music bus. Loops
// are rendered in slices across frames (per-sample work is slow natively);
// the synthesized blips audio.js played while a sample loaded are not
// ported (a live synthesis graph makes clip loads fail on the web runtime):
// a clip still loading is silent. The runtime's Options own the volumes, the
// mute and the voice limit; clips load once the mixer runs, one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

export type Sfx = "select" | "deselect" | "invalid" | "word-bonus" | "word-target" | "pangram" | "shuffle" | "hint" | "undo" | "complete" | "failed"
  | "pause" | "resume" | "ui" | "achievement";
const SAMPLES: Record<Sfx, string> = {
  select: "letter-select", deselect: "letter-deselect", invalid: "word-rejected", "word-bonus": "bonus-word", "word-target": "word-planted",
  pangram: "full-wheel", shuffle: "wheel-shuffle", hint: "hint-reveal", undo: "move-undo", complete: "grove-complete", failed: "round-failed",
  pause: "game-pause", resume: "game-resume", ui: "ui-click", achievement: "achievement-unlock",
};
/** audio.js caption cues (strings.js cap_*). */
export const CAPTIONS: Partial<Record<Sfx, string>> = {
  invalid: "cap_invalid", "word-bonus": "cap_bonus", "word-target": "cap_target", pangram: "cap_pangram", shuffle: "cap_shuffle", hint: "cap_hint",
  complete: "cap_complete", failed: "cap_failed", achievement: "cap_achievement",
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
export function loadSfx(): void { wantClips = true; }
export function play(ev: Sfx): void {
  const name = SAMPLES[ev];
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); }
}

// ---- rendered loops ---------------------------------------------------------------------------
const RATE = 22050;
const SINE = new Float32Array(4096);
for (let i = 0; i < SINE.length; i++) SINE[i] = Math.sin((i / SINE.length) * Math.PI * 2);
const sin = (phase: number): number => SINE[Math.floor((phase - Math.floor(phase)) * 4096) & 4095]!;
let seed = 0x6a7e;
const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
interface Job { data: Float32Array; pos: number; fill: (from: number, to: number) => void; post?: () => void; clip: AudioClip | null }
function lowpass(freq: number): (x: number) => number {
  const w0 = (2 * Math.PI * freq) / RATE, al = Math.sin(w0) / 2, cw = Math.cos(w0);
  const b0 = (1 - cw) / 2 / (1 + al), b1 = (1 - cw) / (1 + al), a1 = (-2 * cw) / (1 + al), a2 = (1 - al) / (1 + al);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
/** A blip (audio.js blip): attack 8 ms, exponential decay to `dur`. */
function addBlip(d: Float32Array, at: number, freq: number, dur: number, gain: number, wave: "sine" | "square" = "sine"): void {
  const start = Math.floor(at * RATE), n = Math.floor(dur * RATE), att = Math.floor(0.008 * RATE);
  const k = Math.exp(Math.log(0.0001) / Math.max(1, n - att));
  let env = 1, ph = 0;
  const step = freq / RATE;
  for (let i = 0; i < n; i++) {
    const e = i < att ? i / att : (env *= k);
    ph += step;
    const v = wave === "sine" ? sin(ph) : (ph - Math.floor(ph) < 0.5 ? 1 : -1);
    const j = (start + i) % d.length;
    d[j] = d[j]! + v * e * gain;
  }
}
function ambienceJob(kind: string): Job {
  if (kind === "rain") {
    const lp = lowpass(1800);
    for (let i = 0; i < 2000; i++) lp(rand() * 2 - 1);
    const data = new Float32Array(RATE * 2);
    return { data, pos: 0, clip: null, fill: (a, b) => { for (let i = a; i < b; i++) data[i] = lp(rand() * 2 - 1); }, post: () => seam(data, Math.round(RATE * 0.05)) };
  }
  const len = RATE * 16;
  const data = new Float32Array(len);
  const lp = lowpass(400);
  const f0 = kind === "wind" ? 90 : 140;
  for (let i = 0; i < 2000; i++) lp(sin((f0 * i) / RATE));
  return {
    data, pos: 0, clip: null,
    fill: (a, b) => { for (let i = a; i < b; i++) data[i] = lp(sin((f0 * i) / RATE)); },
    post: () => {
      if (kind === "birds") {
        for (let t = rand() * 2; t < 15.5; t += 2.5 + rand() * 4) {
          const base = 1800 + rand() * 1200;
          addBlip(data, t, base, 0.09, 0.1);
          addBlip(data, t + 0.1, base * 1.2, 0.07, 0.08);
        }
      } else if (kind === "crickets") {
        for (let t = rand() * 3; t < 15.5; t += 4 + rand() * 4) for (let i = 0; i < 3; i++) addBlip(data, t + i * 0.05, 4200, 0.03, 0.03, "square");
      }
    },
  };
}
function seam(d: Float32Array, f: number): void {
  for (let i = 0; i < f; i++) { const k = i / f; d[d.length - f + i] = d[d.length - f + i]! * (1 - k) + d[i]! * k; }
}
const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
/** layer 0: the chords; 1: the octave layer; 2: an arpeggio note per chord (audio.js startMusic). */
function musicJob(layer: number): Job {
  const data = new Float32Array(RATE * 16);
  return {
    data, pos: 0, clip: null,
    fill: (a, b) => { if (a === 0) data.fill(0); void b; },
    post: () => {
      CHORDS.forEach((chord, ci) => {
        const t0 = ci * 4;
        chord.forEach((f, i) => {
          if (layer === 0) addBlip(data, t0 + i * 0.02, f, 3.6, 0.05);
          if (layer === 1) addBlip(data, t0 + 0.3 + i * 0.02, f * 2, 2, 0.02);
        });
        if (layer === 2) addBlip(data, t0 + 2, chord[Math.floor(rand() * chord.length)]! * 2, 0.4, 0.03);
      });
    },
  };
}
function run(job: Job, budget: number): void {
  if (job.clip) return;
  const end = Math.min(job.data.length, job.pos + budget);
  job.fill(job.pos, end);
  job.pos = end;
  if (job.pos < job.data.length) return;
  job.post?.();
  try { job.clip = createClip([job.data], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); job.pos = 0; }
}

const ambJobs = new Map<string, Job>();
let ambWant: string | null = null;
let ambKind = "";
let ambVoice: Sound | null = null;
/** audio.js startAmbience(kind) / stopAmbience (null). */
export function ambience(kind: string | null): void { ambWant = kind; }

const music = [musicJob(0), musicJob(1), musicJob(2)];
const voices: (Sound | null)[] = [null, null, null];
let musicOn = false;
let level = 0;
const layerGain = (i: number): number => (i === 0 ? (0.05 + level * 0.03) / 0.05 : i === 1 ? (level > 0.4 ? 1 : 0) : level > 0.7 ? 1 : 0) * 0.5;
export function startMusic(on: boolean): void { musicOn = on; }
export function intensity(v: number): void {
  const next = Math.max(0, Math.min(1, v));
  if (Math.abs(next - level) < 0.01) return;
  level = next;
  voices.forEach((s, i) => { try { s?.fade(layerGain(i), 1.5); } catch { /* gone */ } });
}

/** Each frame: clips one at a time once the mixer runs, loop slices, the loop voices. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SAMPLES)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
  }
  if (ambWant) {
    let job = ambJobs.get(ambWant);
    if (!job) { job = ambienceJob(ambWant); ambJobs.set(ambWant, job); }
    run(job, 3000);
    if (job.clip && ambKind !== ambWant) {
      try { ambVoice?.stop(); } catch { /* gone */ }
      ambKind = ambWant;
      try { ambVoice = playClip(job.clip, { bus: "music", gain: 0.5 * 0.7, loop: true }); } catch { ambVoice = null; ambKind = ""; }
    }
  } else if (ambVoice) {
    try { ambVoice.stop(); } catch { /* gone */ }
    ambVoice = null;
    ambKind = "";
  }
  for (const j of music) if (!j.clip) { run(j, RATE * 16); break; }
  music.forEach((j, i) => {
    if (musicOn && j.clip && !voices[i] && music.every((m) => m.clip)) {
      try { voices[i] = playClip(j.clip, { bus: "music", gain: layerGain(i), loop: true }); } catch { voices[i] = null; }
    } else if (!musicOn && voices[i]) {
      try { voices[i]!.stop(); } catch { /* gone */ }
      voices[i] = null;
    }
  });
}
