// Word Grove — unit tests for the graphics quality model (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES } from '../js/gfx.js';
import { GFX_LOCALES, gfxStrings, pickLocale } from '../js/gfx-i18n.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 640'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('touch/mobile devices cap Auto at balanced', () => {
  assert.equal(detectPreset('Apple M1', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({ preset: 'auto' }, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.shadows, 'off');
  assert.equal(a.post, false, 'Low renders without a post chain');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
  assert.equal(resolve(null, undefined).preset, 'balanced');
});

test('resolve: per-category overrides and invalid values', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus', detail: 'detailed' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off', 'invalid tier falls back to the preset');
  assert.equal(r.detail, 'detailed');
  assert.equal(r.post, true, 'bloom override turns the post chain on');
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').renderScale, 0.5);
  assert.equal(resolve({ preset: 'high', render_scale: 'x' }, 'low').renderScale, 1);
  assert.equal(resolve({ preset: 'ultra' }, 'low').scale, 1.25);
  assert.equal(resolve({ preset: 'low' }, 'low').dprCap, 1);
});

test('adaptive defaults on, frame-rate readout defaults off', () => {
  const r = resolve({}, 'balanced');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  assert.equal(resolve({ adaptive: false, show_fps: true }, 'balanced').adaptive, false);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const s = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'ultra');
  assert.equal(s.preset, 'ultra');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(s[cat], undefined, cat);
  assert.equal(s.render_scale, 1.5);
  assert.equal(s.adaptive, false);
  assert.equal(s.show_fps, true);
  assert.equal(choosePreset({}, 'nonsense').preset, 'auto');
});

test('every preset defines every category with a legal tier', () => {
  for (const p of PRESETS) {
    for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('describe summarises cost and pixels', () => {
  const text = describe(resolve({ preset: 'high' }, 'low'), [1920, 1080]);
  assert.match(text, /2048² shadows/);
  assert.match(text, /1920×1080 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows/);
});

test('graphics strings exist for every required locale', () => {
  const required = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = gfxStrings('en-US');
  for (const l of required) {
    assert.ok(GFX_LOCALES.includes(l), l);
    const s = gfxStrings(l);
    for (const k of Object.keys(en)) assert.ok(s[k], `${l}.${k}`);
    for (const k of Object.keys(en.cat)) assert.ok(s.cat[k], `${l}.cat.${k}`);
    for (const k of Object.keys(en.tier)) assert.ok(s.tier[k], `${l}.tier.${k}`);
    assert.match(s.auto, /\{tier\}/);
    assert.match(s.fromPreset, /\{tier\}/);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
