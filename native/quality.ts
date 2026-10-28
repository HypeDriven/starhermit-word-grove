// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality);
// the particle multiplier scales within the tier with the level
// (frame().levelIndex, at most 2×), as gfx.js scaled it by its hardware
// level. The runtime owns the rest of the old Graphics panel: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution,
// the frame-rate limit and readout. The panel's per-effect overrides are not
// offered (Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  material: "lambert" | "standard" | "physical";
  /** Bark / ground-speckle texture size; the log-slice rings are 2×. */
  texture: number;
  segments: number; grass: number; particles: number; bloomRes: number; aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Canopy and grass wind, pond ripples, pollen drift. */
  animated: boolean;
  /** Tree count, grass tufts, ground / wood textures, hills, lily pads. */
  detailed: boolean;
  budget: Budget;
}
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "low", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, segments: 0.5, grass: 0.5, particles: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 128, segments: 0.75, grass: 0.6, particles: 1, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, segments: 1, grass: 1, particles: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, segments: 1.5, grass: 1.6, particles: 1.5, bloomRes: 1, aoRes: 1 },
};
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
const PARTICLE_MAX = 3;

export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b: Budget = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.5, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k * 100) / 100);
  return { preset, ...TABLE[preset], budget: b };
}
