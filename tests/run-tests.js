// Word Grove — offline test suite (node tests/run-tests.js).
// Covers: every legal action, invalid-action reasons, scoring components,
// terminal states, serialization/migration, replay determinism (property),
// malformed-command fuzzing, golden sessions, and content validation.

import * as rules from '../js/rules.js';
import { createState, dispatch, serialize, deserialize, stateHash, legalActions, totalScore,
         scoreBreakdown, compareResults, TICK_MS } from '../js/rules.js';
import { layoutWords, subanagrams, letterCountsOf, canForm } from '../js/layout.js';
import { generateLevel, validateLevel, getJourneyLevel, getDailyLevel, getChallengeLevel,
         getTutorialLevel, journeyLevelCount, CHALLENGES, utcDateISO } from '../js/content.js';
import { verifyReplay } from '../js/session.js';
import { validateScoreSubmission } from '../server.js';
import { makeRng } from '../js/rng.js';
import { COMMON, VALID } from '../js/dictionary.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error('  FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(name) { console.log('\n== ' + name); }

function tinyLevel(overrides = {}) {
  return {
    mode: 'practice', levelId: 'test', contentVersion: 1, seed: 'test-seed',
    letters: 'plant', targets: ['plant', 'plan', 'ant'],
    constraints: { allowUndo: true, ...overrides },
  };
}

// ------------------------------------------------------------- layout ------
section('layout');
{
  const rng = makeRng('t1');
  const layout = layoutWords(['plant', 'plan', 'ant', 'tan'], rng);
  ok(layout, 'layout produces a placement');
  eq(layout.placements.length, 4, 'all words placed');
  // Greedy layout may legitimately fail on blocked sets; generator retries.
  eq(layoutWords(['plant', 'plan', 'ant', 'tan', 'nap'], makeRng('t1')), null, 'blocked set returns null');
  // Crossing consistency
  const occ = new Map();
  let conflict = false;
  for (const p of layout.placements) {
    for (let i = 0; i < p.word.length; i++) {
      const x = p.dir === 0 ? p.x + i : p.x, y = p.dir === 0 ? p.y : p.y + i;
      const k = x + ',' + y;
      if (occ.has(k) && occ.get(k) !== p.word[i]) conflict = true;
      occ.set(k, p.word[i]);
    }
  }
  ok(!conflict, 'no crossing conflicts');
  ok(canForm('plant', letterCountsOf('plant'.split(''))), 'canForm positive');
  ok(!canForm('plants', letterCountsOf('plant'.split(''))), 'canForm rejects reuse');
  const subs = subanagrams('plant'.split(''), COMMON, 3);
  ok(subs.includes('ant') && subs.includes('plan') && subs.includes('tap'), 'subanagrams found');
}

// -------------------------------------------------------- rules: submit ----
section('rules: submit');
{
  let s = createState(tinyLevel());
  eq(s.status, 'active', 'starts active');
  eq(s.tick, 0, 'tick starts at 0');

  let r = dispatch(s, { type: 'submit', word: 'ant' });
  ok(r.ok, 'target word accepted');
  eq(r.state.score.target, 20 + 30, 'target score = 20 + 10*len');
  ok(r.state.revealed[r.state.targets.indexOf('ant')].every(Boolean), 'placed word revealed');
  s = r.state;

  r = dispatch(s, { type: 'submit', word: 'lap' }); // valid, not a target
  ok(r.ok, 'bonus word accepted');
  eq(r.state.score.bonus, 15, 'bonus score = 5*len');
  s = r.state;

  r = dispatch(s, { type: 'submit', word: 'lap' });
  ok(!r.ok && r.reason === 'already-found', 'duplicate rejected');
  eq(r.state.duplicateCount, 1, 'duplicate counted');

  r = dispatch(s, { type: 'submit', word: 'lapt' }); // formable but not a word
  ok(!r.ok && r.reason === 'unknown-word', 'unknown word rejected');
  eq(r.state.invalidCount, 1, 'invalid counted');

  r = dispatch(s, { type: 'submit', word: 'go' });
  ok(!r.ok && r.reason === 'too-short', 'short word rejected');

  r = dispatch(s, { type: 'submit', word: 'plants' });
  ok(!r.ok && r.reason === 'letters-unavailable', 'letter reuse rejected');

  r = dispatch(s, { type: 'submit', word: 'p1ant' });
  ok(!r.ok && r.reason === 'malformed-word', 'malformed word rejected');

  r = dispatch(s, { type: 'submit', word: 'plan' });
  ok(r.ok, 'second target accepted');
  s = r.state;
  r = dispatch(s, { type: 'submit', word: 'plant' });
  ok(r.ok, 'pangram accepted');
  eq(r.state.score.pangram, 50, 'pangram bonus');
  eq(r.state.status, 'complete', 'completes when all targets found');
  eq(r.state.terminalReason, 'all-words', 'terminal reason all-words');
  ok(r.state.score.completion > 0, 'completion bonus');
  const total = totalScore(r.state);
  eq(total, r.state.score.target + r.state.score.bonus + r.state.score.pangram + r.state.score.completion, 'total = components');
  ok(scoreBreakdown(r.state).every((row) => row.value !== 0), 'breakdown omits zero rows');
}

// ------------------------------------------------- rules: shuffle/hint -----
section('rules: shuffle & hint');
{
  let s = createState(tinyLevel());
  const before = s.letters.join('');
  let r = dispatch(s, { type: 'shuffle' });
  ok(r.ok, 'shuffle ok');
  eq(r.state.letters.slice().sort().join(''), before.split('').sort().join(''), 'shuffle keeps letters');
  // Deterministic: same seed → same shuffle sequence.
  let s2 = createState(tinyLevel());
  let r2 = dispatch(s2, { type: 'shuffle' });
  eq(r.state.letters.join(''), r2.state.letters.join(''), 'shuffle deterministic');

  r = dispatch(r.state, { type: 'hint' });
  ok(r.ok, 'hint ok');
  eq(r.state.hintsUsed, 1, 'hint counted');
  eq(r.state.score.hintPenalty, 25, 'hint penalty');
  ok(Object.values(r.state.revealed).some((arr) => arr.some(Boolean)), 'hint reveals a cell');

  // Hint disabled
  s = createState(tinyLevel({ allowHints: false }));
  r = dispatch(s, { type: 'hint' });
  ok(!r.ok && r.reason === 'hints-disabled', 'hint disabled rejected');
  s = createState(tinyLevel({ allowShuffle: false }));
  r = dispatch(s, { type: 'shuffle' });
  ok(!r.ok && r.reason === 'shuffle-disabled', 'shuffle disabled rejected');
}

// --------------------------------------------------------- rules: undo -----
section('rules: undo');
{
  let s = createState(tinyLevel());
  let r = dispatch(s, { type: 'submit', word: 'ant' });
  ok(r.ok && r.state.undoStack.length === 1, 'submit pushes undo snapshot');
  r = dispatch(r.state, { type: 'undo' });
  ok(r.ok, 'undo ok');
  ok(!r.state.found['ant'], 'undo removes found word');
  eq(r.state.score.target, 0, 'undo restores score');
  r = dispatch(r.state, { type: 'undo' });
  ok(!r.ok && r.reason === 'nothing-to-undo', 'empty undo rejected');
  s = createState(tinyLevel({ allowUndo: false }));
  r = dispatch(s, { type: 'undo' });
  ok(!r.ok && r.reason === 'undo-disabled', 'undo disabled rejected');
}

// ---------------------------------------------- rules: terminal states -----
section('rules: terminal states');
{
  // Move limit
  let s = createState(tinyLevel({ moveLimit: 2, allowUndo: false }));
  let r = dispatch(s, { type: 'submit', word: 'ant' });
  r = dispatch(r.state, { type: 'submit', word: 'plan' });
  eq(r.state.status, 'failed', 'move limit failure');
  eq(r.state.terminalReason, 'out-of-moves', 'out-of-moves reason');
  r = dispatch(r.state, { type: 'submit', word: 'plant' });
  ok(!r.ok && r.reason === 'not-active', 'no submissions after terminal');

  // Time limit
  s = createState(tinyLevel({ timeLimitSec: 1 }));
  for (let i = 0; i < 12; i++) s = dispatch(s, { type: 'tick' }).state;
  eq(s.status, 'failed', 'time limit failure');
  eq(s.terminalReason, 'time-expired', 'time-expired reason');

  // Abandon
  s = createState(tinyLevel());
  s = dispatch(s, { type: 'abandon' }).state;
  eq(s.status, 'failed', 'abandon fails round');
  eq(s.terminalReason, 'abandoned', 'abandoned reason');

  // Pause/resume gates tick
  s = createState(tinyLevel());
  s = dispatch(s, { type: 'pause' }).state;
  eq(s.status, 'paused', 'paused');
  const t0 = s.elapsedTicks;
  s = dispatch(s, { type: 'tick' }).state;
  eq(s.elapsedTicks, t0, 'clock stops while paused');
  s = dispatch(s, { type: 'resume' }).state;
  s = dispatch(s, { type: 'tick' }).state;
  eq(s.elapsedTicks, t0 + 1, 'clock resumes');

  // legalActions gating
  s = createState(tinyLevel({ moveLimit: 1 }));
  s = dispatch(s, { type: 'submit', word: 'zzz' }).state; // invalid: doesn't consume
  const leg = legalActions(s);
  eq(leg.movesRemaining, 1, 'invalid does not consume moves');
  ok(leg.canSubmit && leg.canShuffle && leg.canHint, 'legal actions available');
}

// ------------------------------------------------- serialization/migration -
section('serialization');
{
  let s = createState(tinyLevel());
  s = dispatch(s, { type: 'submit', word: 'ant' }).state;
  s = dispatch(s, { type: 'shuffle' }).state;
  const restored = deserialize(serialize(s));
  eq(stateHash(restored), stateHash(s), 'serialize round-trip preserves hash');
  const migrated = deserialize(JSON.stringify({ ...s, version: 0 }));
  eq(migrated.version, rules.RULES_VERSION, 'migration upgrades version');
  let threw = false;
  try { deserialize(JSON.stringify({ ...s, version: 999 })); } catch { threw = true; }
  ok(threw, 'future version rejected');
}

// ------------------------------------------------ replay determinism -------
section('replay determinism (property)');
{
  const rng = makeRng('prop');
  for (let trial = 0; trial < 12; trial++) {
    const level = getJourneyLevel(trial % 8);
    const runOnce = () => {
      let s = createState({
        mode: level.mode, levelId: level.id, contentVersion: level.version,
        seed: level.seed, letters: level.letters, targets: level.targets,
        constraints: level.constraints,
      });
      const commands = [];
      const r2 = makeRng('cmds-' + trial);
      const pool = [...level.targets.slice(0, 3), 'zzq', level.targets[0]];
      for (const w of pool) commands.push({ type: 'submit', word: w });
      commands.push({ type: 'shuffle' }, { type: 'hint' });
      for (let i = 0; i < 30; i++) commands.push({ type: 'tick' });
      for (const c of commands) s = dispatch(s, c).state;
      return stateHash(s);
    };
    eq(runOnce(), runOnce(), `same seed + commands → same hash (trial ${trial})`);
  }
}

// ------------------------------------------------------------ fuzz ---------
section('fuzz malformed commands');
{
  const rng = makeRng('fuzz');
  const level = getJourneyLevel(0);
  for (let trial = 0; trial < 500; trial++) {
    let s = createState({
      mode: 'practice', levelId: 'f', contentVersion: 1, seed: 'fuzz-' + trial,
      letters: level.letters, targets: level.targets, constraints: {},
    });
    const garbage = [
      { type: 'submit', word: rng() < 0.5 ? String.fromCharCode(...Array.from({ length: rng.int(10) }, () => 97 + rng.int(26))) : null },
      { type: 'submit', word: 12345 },
      { type: 'submit', word: '!!!' },
      { type: 'nonsense' },
      { type: 'shuffle' }, { type: 'hint' }, { type: 'undo' },
      { type: 'pause' }, { type: 'resume' }, { type: 'tick' },
      {}, { type: null }, { type: 'submit' },
    ];
    for (let i = 0; i < 40; i++) {
      const cmd = garbage[rng.int(garbage.length)];
      const r = dispatch(s, cmd);
      ok(Number.isFinite(totalScore(r.state)), `score finite (trial ${trial}, step ${i})`);
      ok(r.state.tick >= s.tick || cmd.type !== 'tick', 'tick monotone');
      s = r.state;
      if (failed > 20) break;
    }
    if (failed > 20) break;
  }
  ok(failed === 0, 'fuzz completed without failures');
}

// ------------------------------------------------------ golden sessions ----
section('golden sessions');
{
  // Scripted easy session: complete journey level 0 with no hints.
  const level = getJourneyLevel(0);
  let s = createState({
    mode: level.mode, levelId: level.id, contentVersion: level.version,
    seed: level.seed, letters: level.letters, targets: level.targets, constraints: level.constraints,
  });
  const cmds = [];
  for (const w of level.targets.slice().sort()) { cmds.push({ type: 'submit', word: w }); }
  for (let i = 0; i < 50; i++) cmds.push({ type: 'tick' });
  for (const c of cmds) s = dispatch(s, c).state;
  eq(s.status, 'complete', 'golden easy completes');
  eq(s.terminalReason, 'all-words', 'golden easy reason');
  eq(stateHash(s), '39969f08', 'golden easy hash pinned');
  eq(totalScore(s), 420, 'golden easy score pinned');

  // Interrupted/resumed session: pause mid-way, resume, finish.
  let s2 = createState({
    mode: level.mode, levelId: level.id, contentVersion: level.version,
    seed: level.seed, letters: level.letters, targets: level.targets, constraints: level.constraints,
  });
  s2 = dispatch(s2, { type: 'submit', word: level.targets[0] }).state;
  s2 = dispatch(s2, { type: 'pause' }).state;
  const snap = serialize(s2);
  s2 = deserialize(snap); // "reload"
  s2 = dispatch(s2, { type: 'resume' }).state;
  for (const w of level.targets.slice(1)) s2 = dispatch(s2, { type: 'submit', word: w }).state;
  eq(s2.status, 'complete', 'resumed session completes');

  // Move-limit golden: exact moves, win on last submission.
  const ch = getChallengeLevel(CHALLENGES[0].id);
  let s3 = createState({
    mode: 'challenge', levelId: ch.id, contentVersion: ch.version, seed: ch.seed,
    letters: ch.letters, targets: ch.targets, constraints: ch.constraints,
  });
  for (const w of ch.targets.slice().sort()) s3 = dispatch(s3, { type: 'submit', word: w }).state;
  eq(s3.status, 'complete', 'challenge completable within move limit');
  ok(s3.score.moveBonus > 0, 'move bonus awarded');
  eq(stateHash(s3), '9c70c10c', 'golden challenge hash pinned');
  eq(totalScore(s3), 535, 'golden challenge score pinned');
}

// -------------------------------------------------- content validation -----
section('content validation');
{
  let bad = 0;
  for (let i = 0; i < journeyLevelCount(); i++) {
    const level = getJourneyLevel(i);
    const errors = validateLevel(level);
    if (errors.length) { bad++; console.error(`  journey ${i}:`, errors.join(',')); }
  }
  eq(bad, 0, `all ${journeyLevelCount()} journey levels valid`);

  bad = 0;
  for (let d = 0; d < 14; d++) {
    const iso = utcDateISO(Date.UTC(2026, 0, 1) + d * 86400000);
    const errors = validateLevel(getDailyLevel(iso));
    if (errors.length) { bad++; console.error(`  daily ${iso}:`, errors.join(',')); }
  }
  eq(bad, 0, 'daily levels valid for 14 days');

  bad = 0;
  for (const c of CHALLENGES) {
    const errors = validateLevel(getChallengeLevel(c.id));
    if (errors.length) { bad++; console.error(`  challenge ${c.id}:`, errors.join(',')); }
  }
  eq(bad, 0, 'all challenges valid');
  eq(validateLevel(getTutorialLevel()).length, 0, 'tutorial level valid');

  // Difficulty curve: target counts non-decreasing across groves on average.
  const counts = Array.from({ length: journeyLevelCount() }, (_, i) => getJourneyLevel(i).targets.length);
  ok(counts[0] <= counts[counts.length - 1], 'difficulty grows across journey');
  ok(counts.every((c) => c >= 4 && c <= 12), 'target counts bounded');
}

// ------------------------------------------------ server-side validation ---
section('authoritative score validation');
{
  const iso = '2026-08-19';
  const level = getDailyLevel(iso);
  const mkState = () => createState({
    mode: level.mode, levelId: level.id, contentVersion: level.version,
    seed: level.seed, letters: level.letters, targets: level.targets,
    constraints: level.constraints, ranked: !!level.ranked,
  });
  let s = mkState();
  const commands = [];
  for (const w of level.targets.slice().sort()) commands.push({ type: 'submit', word: w });
  for (const c of commands) s = dispatch(s, c).state;
  const replay = {
    schema: 1, build: 'test', contentVersion: level.version, seed: level.seed,
    initialHash: stateHash(mkState()),
    commands,
    terminal: { status: 'complete', reason: 'all-words', score: totalScore(s), finalHash: stateHash(s) },
  };
  const v = verifyReplay(level, replay);
  ok(v.ok, 'replay verifies');
  const sub = validateScoreSubmission({ seed: level.seed, replay, score: totalScore(s), contentVersion: level.version });
  ok(sub.ok, 'server accepts valid submission');
  const bad = validateScoreSubmission({ seed: level.seed, replay, score: totalScore(s) + 100, contentVersion: level.version });
  ok(!bad.ok && bad.error === 'score-mismatch', 'server rejects inflated score');
  const stale = validateScoreSubmission({ seed: level.seed, replay, score: totalScore(s), contentVersion: 999 });
  ok(!stale.ok && stale.error === 'stale-version', 'server rejects stale version');
  const impossible = validateScoreSubmission({ seed: level.seed, replay, score: -5, contentVersion: level.version });
  ok(!impossible.ok, 'server rejects impossible score');
}

// -------------------------------------------------------------- tiebreak ---
section('tie-break ordering');
{
  const a = { completed: true, score: 100, invalidCount: 2, elapsedSec: 60, sessionId: 'b' };
  const b = { completed: true, score: 100, invalidCount: 2, elapsedSec: 60, sessionId: 'a' };
  ok(compareResults(a, b) > 0, 'session id breaks exact ties');
  ok(compareResults({ ...a, invalidCount: 1 }, b) < 0, 'fewer invalid wins');
  ok(compareResults({ ...a, elapsedSec: 50 }, b) < 0, 'faster wins');
  ok(compareResults({ ...a, score: 200 }, b) < 0, 'higher score wins');
  ok(compareResults({ ...a, completed: false }, b) > 0, 'completion wins');
}

// ---------------------------------------------------------------- summary --
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' - ' + f)); }
process.exit(failed ? 1 : 0);
