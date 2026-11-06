// The look per graphics level. The engine's level table (levelSettings()) owns
// shadows and their map size, AO, bloom, the grade and anti-aliasing; the
// game's art (materials, texture sizes, segments, grass, reflections, particles)
// stays the browser build's four presets (js/gfx.js TABLE / BUDGETS) keyed by the
// runtime's quality tier, with the particle multiplier scaled within the tier
// by the level's particle budget (at most 2×). The runtime owns the rest of the
// old Graphics panel: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout. The panel's
// per-effect overrides are not offered (Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  material: "lambert" | "standard" | "physical";
  /** Bark / ground-speckle texture size; the log-slice rings are 2×. */
  texture: number;
  segments: number; grass: number; particles: number;
}
interface Art {
  reflections: boolean;
  particles: "low" | "high";
  /** Canopy and grass wind, pond ripples, pollen drift. */
  animated: boolean;
  /** Tree count, grass tufts, ground / wood textures, hills, lily pads. */
  detailed: boolean;
}
export interface Look extends Art {
  preset: QualityTier;
  shadows: number; // the level's shadowMapSize, 0 = off
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  bloom: number | null; // the level's bloom resolution
  grade: boolean;
  antialias: AntialiasMode;
  budget: Budget;
}
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "low", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, segments: 0.5, grass: 0.5, particles: 0.75 },
  balanced: { material: "standard", texture: 128, segments: 0.75, grass: 0.6, particles: 1 },
  high: { material: "physical", texture: 256, segments: 1, grass: 1, particles: 1 },
  ultra: { material: "physical", texture: 512, segments: 1.5, grass: 1.6, particles: 1.5 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
const PARTICLE_MAX = 3;

export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize), particles: Math.min(PARTICLE_MAX, Math.round(b.particles * k * 100) / 100) },
  };
}
