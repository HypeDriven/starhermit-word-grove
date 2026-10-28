// The fixed-content table (js/levels.js) is exactly what generateLevel makes
// (tools/gen-levels.mjs), every fixed level validates, and generated groves
// (Daily, Practice) validate too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED } from '../js/levels.js';
import { fixedSources, generateLevel, validateLevel, getJourneyLevel, getDailyLevel, getPracticeLevel, getChallengeLevel, getTutorialLevel, CHALLENGES } from '../js/content.js';

test('js/levels.js matches generateLevel', () => {
  for (const [key, seed, params] of fixedSources()) assert.deepEqual(FIXED[key], JSON.parse(JSON.stringify(generateLevel(seed, params))), key);
  assert.equal(Object.keys(FIXED).length, fixedSources().length);
});
test('fixed and generated levels validate', () => {
  for (let i = 0; i < 48; i++) assert.deepEqual(validateLevel(getJourneyLevel(i)), [], `journey ${i}`);
  for (const c of CHALLENGES) assert.deepEqual(validateLevel(getChallengeLevel(c.id)), [], c.id);
  assert.deepEqual(validateLevel(getTutorialLevel()), []);
  assert.deepEqual(validateLevel(getDailyLevel('2026-10-28')), []);
  assert.deepEqual(validateLevel(getPracticeLevel('expert', 'x')), []);
});
