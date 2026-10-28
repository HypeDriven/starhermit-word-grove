// The cloud document merge the engine client uses (js/storage.js
// mergeProgress / mergeBoards, as native/platform.ts mergeDocs calls them):
// neither device's progress is lost, and an old SDK save reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROGRESS, mergeProgress, mergeBoards } from '../js/storage.js';

test('progress merges keep the better of both sides', () => {
  const a = { ...DEFAULT_PROGRESS, journey: { 0: { score: 300, stars: 2 } }, flowers: 10, achievements: { 'first-bloom': 5 }, dailyDays: ['2026-10-01'] };
  const b = { ...DEFAULT_PROGRESS, journey: { 0: { score: 200, stars: 3 }, 1: { score: 100, stars: 1 } }, flowers: 4, achievements: { 'first-bloom': 3 }, dailyDays: ['2026-10-02'], tutorialDone: true };
  const m = mergeProgress(a, b);
  assert.equal(m.journey[0].score, 300);
  assert.equal(m.journey[0].stars, 3);
  assert.ok(m.journey[1]);
  assert.equal(m.flowers, 10);
  assert.equal(m.achievements['first-bloom'], 3);
  assert.deepEqual(m.dailyDays, ['2026-10-01', '2026-10-02']);
  assert.equal(m.tutorialDone, true);
});
test('boards merge by session', () => {
  const r = { version: 1, boards: { 'daily:x': { entries: [{ sessionId: 'a', score: 5 }] } } };
  const l = { version: 1, boards: { 'daily:x': { entries: [{ sessionId: 'b', score: 9 }, { sessionId: 'a', score: 5 }] } } };
  assert.deepEqual(mergeBoards(r, l).boards['daily:x'].entries.map((e) => e.sessionId), ['b', 'a']);
});
