// Word Grove — audio: WebAudio buses, procedural transients, ambience, and
// adaptive music. No audio assets; every sound is synthesized. Pitch variants
// are seeded so replays sound consistent.

import { makeRng } from './rng.js';

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.started = false;
    this.ambienceNodes = [];
    this.musicNodes = [];
    this.musicLevel = 0; // 0..1 adaptive intensity
    this.rng = makeRng('audio:' + (settings.audioSeed || 'grove'));
    this.captionListener = null;
  }

  onCaption(fn) { this.captionListener = fn; }
  caption(text) { if (this.captionListener) this.captionListener(text); }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const mk = (name) => {
        const g = this.ctx.createGain();
        g.connect(this.master);
        this.buses[name] = g;
        return g;
      };
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      mk('music'); mk('effects'); mk('ambience'); mk('voice');
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const v = this.settings.volumes;
    const mute = this.settings.muted ? 0 : 1;
    this.master.gain.value = mute;
    this.buses.music.gain.value = v.music * 0.5;
    this.buses.effects.gain.value = v.effects;
    this.buses.ambience.gain.value = v.ambience * 0.7;
    this.buses.voice.gain.value = v.voice;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // ---------------------------------------------------- effect transients --

  blip(freq, dur, type = 'sine', gain = 0.2, bus = 'effects', when = 0) {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  noise(dur, freq, q, gain = 0.15, bus = 'effects', when = 0) {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime + when;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(t);
  }

  // Event mapping. Tier: ack < legal < combo < completion.
  event(name, detail = {}) {
    const v = 0.85 + this.rng() * 0.3; // seeded pitch variant
    switch (name) {
      case 'select':
        this.blip(340 * v * (1 + (detail.step || 0) * 0.06), 0.08, 'triangle', 0.12);
        break;
      case 'deselect': this.blip(240 * v, 0.06, 'triangle', 0.08); break;
      case 'invalid':
        this.blip(160, 0.18, 'sawtooth', 0.08);
        this.blip(120, 0.22, 'sawtooth', 0.06, 'effects', 0.05);
        this.caption('Word not accepted');
        break;
      case 'word-bonus':
        this.blip(420 * v, 0.12, 'sine', 0.14);
        this.blip(560 * v, 0.16, 'sine', 0.12, 'effects', 0.07);
        this.caption('Bonus word');
        break;
      case 'word-target': {
        const base = 392 * v;
        [0, 4, 7].forEach((st, i) => this.blip(base * Math.pow(2, st / 12), 0.22, 'sine', 0.14, 'effects', i * 0.07));
        this.noise(0.3, 2400, 1.2, 0.05, 'effects', 0.05);
        this.caption('Word planted');
        break;
      }
      case 'pangram': {
        const base = 440;
        [0, 4, 7, 12].forEach((st, i) => this.blip(base * Math.pow(2, st / 12), 0.3, 'triangle', 0.14, 'effects', i * 0.08));
        this.caption('Full wheel word');
        break;
      }
      case 'shuffle': this.noise(0.25, 1200, 0.8, 0.1); this.caption('Wheel shuffled'); break;
      case 'hint': this.blip(660, 0.2, 'sine', 0.12); this.blip(880, 0.25, 'sine', 0.1, 'effects', 0.1); this.caption('Hint revealed'); break;
      case 'undo': this.blip(300, 0.1, 'sine', 0.1); this.blip(220, 0.12, 'sine', 0.08, 'effects', 0.06); break;
      case 'complete': {
        const base = 523;
        [0, 4, 7, 12, 16].forEach((st, i) => this.blip(base * Math.pow(2, st / 12), 0.5, 'sine', 0.13, 'effects', i * 0.11));
        this.noise(0.8, 3200, 0.6, 0.05, 'effects', 0.2);
        this.caption('Level complete');
        break;
      }
      case 'failed': [220, 185, 147].forEach((f, i) => this.blip(f, 0.35, 'sine', 0.1, 'effects', i * 0.15)); this.caption('Round over'); break;
      case 'pause': this.blip(280, 0.08, 'sine', 0.08); break;
      case 'resume': this.blip(340, 0.08, 'sine', 0.08); break;
      case 'ui': this.blip(500 * v, 0.04, 'triangle', 0.06); break;
      case 'achievement': [523, 659, 784].forEach((f, i) => this.blip(f, 0.3, 'triangle', 0.1, 'effects', i * 0.09)); this.caption('Achievement unlocked'); break;
    }
  }

  // ---------------------------------------------------------------- ambience

  startAmbience(kind) {
    this.stopAmbience();
    if (!this.ensure()) return;
    const ctx = this.ctx;
    const mk = () => {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(this.buses.ambience);
      g.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 2);
      this.ambienceNodes.push(g);
      return g;
    };
    if (kind === 'rain') {
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800;
      src.connect(f); f.connect(mk()); src.start();
      this.ambienceNodes.push(src);
    } else {
      // birds / crickets / wind: slow modulated pad + chirp scheduling
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = kind === 'wind' ? 90 : 140;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
      o.connect(f); f.connect(mk()); o.start();
      this.ambienceNodes.push(o);
      if (kind === 'birds' || kind === 'crickets') {
        const chirp = () => {
          if (!this.ambienceNodes.length) return;
          if (kind === 'birds') {
            const base = 1800 + Math.random() * 1200;
            this.blip(base, 0.09, 'sine', 0.05, 'ambience');
            this.blip(base * 1.2, 0.07, 'sine', 0.04, 'ambience', 0.1);
          } else {
            for (let i = 0; i < 3; i++) this.blip(4200, 0.03, 'square', 0.015, 'ambience', i * 0.05);
          }
          this.ambTimer = setTimeout(chirp, (kind === 'birds' ? 2500 : 4000) + Math.random() * 4000);
        };
        chirp();
      }
    }
  }

  stopAmbience() {
    if (this.ambTimer) clearTimeout(this.ambTimer);
    for (const n of this.ambienceNodes) {
      try { n.stop ? n.stop() : n.disconnect(); } catch { /* already stopped */ }
    }
    this.ambienceNodes = [];
  }

  // ------------------------------------------------------------------ music

  startMusic() {
    if (this.musicTimer || !this.ensure()) return;
    const chords = [
      [261.6, 329.6, 392.0], [220.0, 261.6, 329.6],
      [174.6, 220.0, 261.6], [196.0, 246.9, 293.7],
    ];
    let step = 0;
    const playChord = () => {
      const chord = chords[step % chords.length];
      step++;
      const dur = 4;
      chord.forEach((f, i) => {
        this.blip(f, dur * 0.9, 'sine', 0.05 + this.musicLevel * 0.03, 'music', i * 0.02);
        if (this.musicLevel > 0.4) this.blip(f * 2, dur * 0.5, 'sine', 0.02, 'music', 0.3 + i * 0.02);
      });
      if (this.musicLevel > 0.7) {
        const arp = chord[Math.floor(Math.random() * chord.length)] * 2;
        this.blip(arp, 0.4, 'triangle', 0.03, 'music', 2);
      }
      this.musicTimer = setTimeout(playChord, dur * 1000);
    };
    playChord();
  }

  setMusicIntensity(level01) { this.musicLevel = Math.max(0, Math.min(1, level01)); }
  stopMusic() { if (this.musicTimer) clearTimeout(this.musicTimer); this.musicTimer = null; }

  stopAll() { this.stopAmbience(); this.stopMusic(); }
}
