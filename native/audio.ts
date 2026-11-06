// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus for every event audio.js mapped), the theme's ambience
// (rain: two seconds of noise through a 1800 Hz low-pass; birds, wind and
// crickets: the low sine pad through a 400 Hz low-pass with the old chirps —
// two-note bird calls every 2.5–6.5 s, cricket triple clicks every 4–8 s —
// placed in a 16 s loop) at the old ambience gain 0.5 × bus 0.7, and the
// adaptive music (the four four-second chords as sines at 0.05 + intensity ×
// 0.03; above intensity 0.4 the octave layer, above 0.7 the arpeggio note)
// on the old music bus × 0.5: the chord loop and the two upper layers are
// rendered once offline into clips (laid end to end in one context) and the
// layers fade in with the intensity. The runtime has no ambience bus, so the
// ambience plays on the music bus. Each theme's ambience renders once, when it
// is first wanted: at most five offline renders. The synthesized blips audio.js
// played while a sample loaded are not ported: a clip still loading is silent.
// The runtime's Options own the volumes, the mute and the voice limit; clips
// load at start.
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

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
export function play(ev: Sfx): void {
  const clip = clips.get(SAMPLES[ev]);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* the mixer is full this frame: skip it */ }
}

// ---- rendered loops ---------------------------------------------------------------------------
const RATE = 22050;
let seed = 0x6a7e;
const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
/** A blip (audio.js blip): attack 8 ms, exponential decay to `dur`. */
function addBlip(off: OfflineAudioContext, at: number, freq: number, dur: number, gain: number, wave: "sine" | "square" = "sine"): void {
  const osc = off.createOscillator();
  osc.type = wave;
  osc.frequency.value = freq;
  const g = off.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.008);
  g.gain.exponentialRampToValueAtTime(gain * 0.0001, at + dur);
  osc.connect(g); g.connect(off.destination);
  osc.start(at); osc.stop(at + dur);
}
function lowpass(off: OfflineAudioContext, freq: number): ReturnType<OfflineAudioContext["createBiquadFilter"]> {
  const lp = off.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = freq; lp.Q.value = 0; // Q 1 (0 dB), the old RBJ's
  lp.connect(off.destination);
  return lp;
}
/** The rendered loop after `settle` seconds, once the filter has settled on the periodic input. */
async function loopClip(off: OfflineAudioContext, settle: number): Promise<AudioClip> {
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(Math.round(settle * RATE))], RATE);
}
function renderAmbience(kind: string): Promise<AudioClip> {
  const settle = 1;
  if (kind === "rain") {
    const off = new OfflineAudioContext(1, (settle + 2) * RATE, RATE);
    const noise = off.createNoise({ color: "white", seed: 0x6a7e, seconds: 2 });
    noise.connect(lowpass(off, 1800));
    noise.start();
    return loopClip(off, settle);
  }
  const off = new OfflineAudioContext(1, (settle + 16) * RATE, RATE);
  const pad = off.createOscillator();
  pad.frequency.value = kind === "wind" ? 90 : 140; // whole cycles in the 16 s loop
  pad.connect(lowpass(off, 400));
  pad.start();
  if (kind === "birds") {
    for (let t = rand() * 2; t < 15.5; t += 2.5 + rand() * 4) {
      const base = 1800 + rand() * 1200;
      addBlip(off, settle + t, base, 0.09, 0.1);
      addBlip(off, settle + t + 0.1, base * 1.2, 0.07, 0.08);
    }
  } else if (kind === "crickets") {
    for (let t = rand() * 3; t < 15.5; t += 4 + rand() * 4) for (let i = 0; i < 3; i++) addBlip(off, settle + t + i * 0.05, 4200, 0.03, 0.03, "square");
  }
  return loopClip(off, settle);
}
const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
const LAYER_S = 16;
/** Three 16 s layers end to end in one context; 0: the chords; 1: the octave layer; 2: an arpeggio note per chord (audio.js startMusic). */
async function renderMusic(): Promise<AudioClip[]> {
  const off = new OfflineAudioContext(1, 3 * LAYER_S * RATE, RATE);
  CHORDS.forEach((chord, ci) => {
    const t0 = ci * 4;
    chord.forEach((f, i) => {
      addBlip(off, t0 + i * 0.02, f, 3.6, 0.05);
      addBlip(off, LAYER_S + t0 + 0.3 + i * 0.02, f * 2, 2, 0.02);
    });
    addBlip(off, 2 * LAYER_S + t0 + 2, chord[Math.floor(rand() * chord.length)]! * 2, 0.4, 0.03);
  });
  const r = (await off.startRendering()).getChannelData(0), n = LAYER_S * RATE;
  return [0, 1, 2].map((i) => createClip([r.slice(i * n, (i + 1) * n)], RATE));
}

/** Loads every clip and renders the music (from onStart). */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`));
  }
  renderMusic().then((c) => { music = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
}

const ambClips = new Map<string, AudioClip | null>(); // null: rendering (or failed)
let ambWant: string | null = null;
let ambKind = "";
let ambVoice: Sound | null = null;
/** audio.js startAmbience(kind) / stopAmbience (null). */
export function ambience(kind: string | null): void {
  ambWant = kind;
  if (!kind || ambClips.has(kind)) return;
  ambClips.set(kind, null);
  renderAmbience(kind).then((c) => { ambClips.set(kind, c); }, (e: unknown) => console.warn(`audio: ${String(e)}`));
}

let music: AudioClip[] = [];
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

/** Each frame: the loop voices once the mixer runs. */
export function update(): void {
  if (context.state !== "running") return;
  if (ambWant) {
    const clip = ambClips.get(ambWant);
    if (clip && ambKind !== ambWant) {
      try { ambVoice?.stop(); } catch { /* gone */ }
      ambKind = ambWant;
      try { ambVoice = playClip(clip, { bus: "music", gain: 0.5 * 0.7, loop: true }); } catch { ambVoice = null; ambKind = ""; }
    }
  } else if (ambVoice) {
    try { ambVoice.stop(); } catch { /* gone */ }
    ambVoice = null;
    ambKind = "";
  }
  music.forEach((clip, i) => {
    if (musicOn && !voices[i]) {
      try { voices[i] = playClip(clip, { bus: "music", gain: layerGain(i), loop: true }); } catch { voices[i] = null; }
    } else if (!musicOn && voices[i]) {
      try { voices[i]!.stop(); } catch { /* gone */ }
      voices[i] = null;
    }
  });
}
