// Word Grove — versioned content: levels, themes, tutorial, daily, challenges.
// All levels are generated deterministically from immutable seeds and then
// validated (legality, reachable goals, bounded size, no soft locks).
// The same validators run offline in tests/content validation.

import { makeRng, hashString } from './rng.js';
import { layoutWords, subanagrams, letterCountsOf, canForm } from './layout.js';
import { COMMON, TARGETS, VALID, COMMON_SET, TARGET_SET } from './dictionary.js';

export const CONTENT_VERSION = 1;

// ------------------------------------------------------------ generation ---

// The frequency corpus includes common words from other languages and bare
// plurals/abbreviations — fine as bonus words, poor as grid targets.
const NON_ENGLISH = new Set((
  'der die das und ich sie ist mit wir du ja nein nicht auch auf ein eine einem einen aber wie nur '
  + 'noch war hat bei zum zur vom aus nach wenn dann hier dort kann muss soll will sehr mehr '
  + 'le les des une est pas que qui dans sur avec pour plus son sa au aux ce il elle nous vous mais '
  + 'est un el los las una con por para del como su al lo es en de mi tu si no yo me te se per che '
  + 'non di il la una con del della hai sei sono era ci ne ma io lui lei noi voi loro questo questa '
  + 'derden het een van ik je dat niet ook aan voor met zijn maar nog wel'
  + 'derden het een van ik je dat niet ook aan voor met zijn maar nog wel '
  // Subtitle-corpus artifacts: names and fragments that read as non-words.
  + 'abe gus gras tha carl derek earl elsa emma fred henry hugh irene karen laura maria nancy '
  + 'olga oscar paula peter simon susan tracy victor walter wendy alice betty carol diana ellen '
  + 'fiona helen julia nina rita rosa vera tina kara lara anna mary john paul etc '
  // Contraction artifacts and slang that frequency lists rank highly.
  + 'ain ben bro takin don han yer tis hon'
).split(' ').filter(Boolean));

const RANK = new Map(COMMON.map((w, i) => [w, i]));
const TARGET_MAX_RANK = 12000;

function isSimplePlural(w) {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && COMMON_SET.has(w.slice(0, -1));
}

function targetQuality(w) {
  return TARGET_SET.has(w) && !NON_ENGLISH.has(w) && !isSimplePlural(w)
    && (RANK.get(w) ?? Infinity) < TARGET_MAX_RANK;
}

function anchorCandidates(wheelSize) {
  return TARGETS.filter((w) => w.length === wheelSize && new Set(w).size === wheelSize && targetQuality(w));
}

const anchorCache = new Map();
function getAnchors(wheelSize) {
  if (!anchorCache.has(wheelSize)) anchorCache.set(wheelSize, anchorCandidates(wheelSize));
  return anchorCache.get(wheelSize);
}

// params: { wheelSize, targetCount, minWordLen=3 }
// Returns level data or throws after exhausting attempts (validator catches).
export function generateLevel(seed, params) {
  const rng = makeRng('level:' + seed);
  const anchors = getAnchors(params.wheelSize);
  if (!anchors.length) throw new Error('no-anchors-' + params.wheelSize);
  const minLen = params.minWordLen ?? 3;

  for (let attempt = 0; attempt < 300; attempt++) {
    const anchor = anchors[rng.int(anchors.length)];
    const letters = rng.shuffle(anchor.split('')).join('');
    const subs = subanagrams(letters.split(''), TARGETS, minLen).filter(targetQuality);
    if (subs.length < params.targetCount + 2) continue;

    // Targets: the anchor pangram plus a length-varied mix of the rest.
    const others = rng.shuffle(subs.filter((w) => w !== anchor));
    others.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    const targets = [anchor];
    const buckets = new Map();
    for (const w of others) {
      if (!buckets.has(w.length)) buckets.set(w.length, []);
      buckets.get(w.length).push(w);
    }
    // Prefer the most frequent word in each length bucket.
    for (const bucket of buckets.values()) bucket.sort((a, b) => RANK.get(a) - RANK.get(b));
    const lens = [...buckets.keys()].sort((a, b) => a - b);
    let li = 0;
    while (targets.length < params.targetCount && lens.length) {
      const len = lens[li % lens.length];
      const bucket = buckets.get(len);
      if (bucket.length) targets.push(bucket.shift());
      else lens.splice(lens.indexOf(len), 1);
      li++;
      if (lens.length === 0) break;
    }
    if (targets.length < params.targetCount) continue;

    const layout = layoutWords(targets, rng.fork('layout'));
    if (!layout) continue;
    if (layout.width > 13 || layout.height > 13) continue;

    const bonusCount = subanagrams(letters.split(''), VALID, minLen).length - targets.length;
    const level = {
      version: CONTENT_VERSION,
      id: seed,
      seed,
      letters,
      targets: targets.sort(),
      grid: layout,
      bonusCount,
      params,
      par: targets.reduce((s, w) => s + 20 + 10 * w.length, 0) + 50 + 100 + 10 * targets.length,
    };
    return level;
  }
  throw new Error('generation-exhausted:' + seed);
}

// ------------------------------------------------------------- validator ---

export function validateLevel(level) {
  const errors = [];
  const counts = letterCountsOf(level.letters.split(''));
  if (level.letters.length < 4 || level.letters.length > 8) errors.push('wheel-size');
  if (!level.targets.length) errors.push('no-targets');
  for (const t of level.targets) {
    if (t.length < 3) errors.push('target-too-short:' + t);
    if (!canForm(t, counts)) errors.push('target-unformable:' + t);
    if (!TARGET_SET.has(t)) errors.push('target-not-common:' + t);
  }
  if (new Set(level.targets).size !== level.targets.length) errors.push('duplicate-targets');
  if (!level.targets.some((t) => t.length === level.letters.length)) errors.push('no-pangram-target');
  // Layout integrity: every placement present, crossings consistent.
  if (!level.grid || level.grid.placements.length !== level.targets.length) {
    errors.push('layout-incomplete');
  } else {
    const occ = new Map();
    for (const p of level.grid.placements) {
      for (let i = 0; i < p.word.length; i++) {
        const x = p.dir === 0 ? p.x + i : p.x;
        const y = p.dir === 0 ? p.y : p.y + i;
        const k = x + ',' + y;
        if (occ.has(k) && occ.get(k) !== p.word[i]) errors.push('layout-conflict:' + p.word);
        occ.set(k, p.word[i]);
      }
    }
    // Reachable goals: the stored grid is the proof of reachability — every
    // word after the first must cross at least one other word (connected grid).
    const cellOwners = new Map();
    level.grid.placements.forEach((p, pi) => {
      for (let i = 0; i < p.word.length; i++) {
        const x = p.dir === 0 ? p.x + i : p.x;
        const y = p.dir === 0 ? p.y : p.y + i;
        const k = x + ',' + y;
        if (!cellOwners.has(k)) cellOwners.set(k, []);
        cellOwners.get(k).push(pi);
      }
    });
    const crosses = new Set();
    for (const owners of cellOwners.values()) {
      if (owners.length > 1) owners.forEach((pi) => crosses.add(pi));
    }
    level.grid.placements.forEach((p, pi) => {
      if (pi > 0 && !crosses.has(pi)) errors.push('island-word:' + p.word);
    });
  }
  if (level.bonusCount < 0) errors.push('bonus-negative');
  return errors;
}

// ------------------------------------------------------------- journey -----

const GROVES = [
  { name: 'Seedling Grove', wheelSize: 5, base: 4, theme: 'dawn' },
  { name: 'Fern Hollow', wheelSize: 5, base: 5, theme: 'rain' },
  { name: 'Birch Rise', wheelSize: 6, base: 5, theme: 'dawn' },
  { name: 'Cedar Falls', wheelSize: 6, base: 6, theme: 'autumn' },
  { name: 'Moonlit Pines', wheelSize: 6, base: 7, theme: 'night' },
  { name: 'Elder Canopy', wheelSize: 7, base: 7, theme: 'dusk' },
];
const LEVELS_PER_GROVE = 8;

function journeyParams(index) {
  const grove = Math.floor(index / LEVELS_PER_GROVE);
  const step = index % LEVELS_PER_GROVE;
  const g = GROVES[grove];
  const mastery = step === LEVELS_PER_GROVE - 1;
  return {
    wheelSize: mastery ? Math.min(7, g.wheelSize + 1) : g.wheelSize,
    targetCount: g.base + Math.floor(step / 2) + (mastery ? 2 : 0),
    mastery,
    grove,
    step,
    theme: g.theme,
  };
}

export function journeyLevelCount() {
  return GROVES.length * LEVELS_PER_GROVE;
}

export function groveInfo(groveIndex) {
  return { index: groveIndex, name: GROVES[groveIndex].name, theme: GROVES[groveIndex].theme };
}

export function groves() {
  return GROVES.map((g, i) => ({ index: i, name: g.name, theme: g.theme }));
}

const levelCache = new Map();

export function getJourneyLevel(index) {
  const key = 'journey:' + index;
  if (levelCache.has(key)) return levelCache.get(key);
  const p = journeyParams(index);
  const level = generateLevel('journey-' + index, p);
  level.id = 'journey-' + index;
  level.journeyIndex = index;
  level.grove = p.grove;
  level.mastery = p.mastery;
  level.theme = p.theme;
  level.mode = 'journey';
  level.constraints = { allowShuffle: true, allowHints: true, allowUndo: false, bonusAllowed: true };
  level.tutorialFlags = index === 0 ? { firstLevel: true } : {};
  levelCache.set(key, level);
  return level;
}

// ---------------------------------------------------------------- daily ----

export function dailySeedFor(dateISO) {
  return 'daily:' + dateISO; // dateISO = YYYY-MM-DD (UTC)
}

export function getDailyLevel(dateISO) {
  const key = 'daily:' + dateISO;
  if (levelCache.has(key)) return levelCache.get(key);
  const day = Math.floor(Date.parse(dateISO + 'T00:00:00Z') / 86400000);
  const cycle = day % 4; // rotates difficulty through the week
  const params = [
    { wheelSize: 5, targetCount: 5 },
    { wheelSize: 6, targetCount: 6 },
    { wheelSize: 6, targetCount: 7 },
    { wheelSize: 7, targetCount: 8 },
  ][cycle];
  const level = generateLevel(key, params);
  level.id = key;
  level.mode = 'daily';
  level.theme = ['dawn', 'rain', 'autumn', 'night'][cycle];
  level.constraints = { allowShuffle: true, allowHints: true, allowUndo: false, bonusAllowed: true };
  level.ranked = true;
  level.ruleset = 'daily-v1';
  levelCache.set(key, level);
  return level;
}

export function utcDateISO(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// ------------------------------------------------------------- practice ----

export const PRACTICE_DIFFICULTIES = [
  { id: 'easy', label: 'Easy', params: { wheelSize: 5, targetCount: 4 }, note: '5 letters, small grid' },
  { id: 'medium', label: 'Medium', params: { wheelSize: 6, targetCount: 6 }, note: '6 letters, medium grid' },
  { id: 'hard', label: 'Hard', params: { wheelSize: 6, targetCount: 8 }, note: '6 letters, dense grid' },
  { id: 'expert', label: 'Expert', params: { wheelSize: 7, targetCount: 9 }, note: '7 letters, large grid' },
];

export function getPracticeLevel(difficultyId, seed) {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.id === difficultyId) || PRACTICE_DIFFICULTIES[0];
  const key = 'practice:' + d.id + ':' + seed;
  if (levelCache.has(key)) return levelCache.get(key);
  const level = generateLevel(key, d.params);
  level.id = key;
  level.mode = 'practice';
  level.difficultyId = d.id;
  level.theme = 'dawn';
  level.constraints = { allowShuffle: true, allowHints: true, allowUndo: true, bonusAllowed: true };
  level.ranked = false;
  levelCache.set(key, level);
  return level;
}

// ------------------------------------------------------------ challenges ---

export const CHALLENGES = [
  { id: 'thrifty-1', label: 'Thrifty Sprout', kind: 'moveLimit', wheelSize: 5, targetCount: 5, slack: 3, desc: 'Finish with at most 3 wasted submissions.' },
  { id: 'thrifty-2', label: 'Thrifty Oak', kind: 'moveLimit', wheelSize: 6, targetCount: 7, slack: 4, desc: 'Bigger grid, at most 4 wasted submissions.' },
  { id: 'swift-1', label: 'Swift Breeze', kind: 'timeLimit', wheelSize: 5, targetCount: 5, seconds: 120, desc: 'Complete the grid in 2 minutes.' },
  { id: 'swift-2', label: 'Swift Storm', kind: 'timeLimit', wheelSize: 6, targetCount: 7, seconds: 180, desc: 'Complete the grid in 3 minutes.' },
  { id: 'still-1', label: 'Still Water', kind: 'noShuffle', wheelSize: 6, targetCount: 6, desc: 'No shuffling — the wheel stays as it is.' },
  { id: 'bare-1', label: 'Bare Branches', kind: 'noHints', wheelSize: 6, targetCount: 7, desc: 'No hints available.' },
  { id: 'ascetic-1', label: 'Ascetic Grove', kind: 'ascetic', wheelSize: 7, targetCount: 8, seconds: 300, slack: 5, desc: 'Time limit, move limit, no hints, no shuffle.' },
  { id: 'twin-1', label: 'Twin Blooms', kind: 'moveLimit', wheelSize: 7, targetCount: 9, slack: 6, desc: 'Large wheel with a tight move budget.' },
  { id: 'dawn-1', label: 'First Light', kind: 'timeLimit', wheelSize: 7, targetCount: 8, seconds: 240, desc: 'Seven letters against the sunrise clock.' },
];

export function getChallengeLevel(id) {
  const c = CHALLENGES.find((x) => x.id === id);
  if (!c) throw new Error('unknown-challenge:' + id);
  const key = 'challenge:' + id;
  if (levelCache.has(key)) return levelCache.get(key);
  const level = generateLevel(key, { wheelSize: c.wheelSize, targetCount: c.targetCount });
  level.id = key;
  level.mode = 'challenge';
  level.challenge = c;
  level.theme = 'dusk';
  const base = { allowShuffle: true, allowHints: true, allowUndo: false, bonusAllowed: true };
  if (c.kind === 'moveLimit') base.moveLimit = level.targets.length + c.slack;
  if (c.kind === 'timeLimit') base.timeLimitSec = c.seconds;
  if (c.kind === 'noShuffle') base.allowShuffle = false;
  if (c.kind === 'noHints') base.allowHints = false;
  if (c.kind === 'ascetic') {
    base.allowShuffle = false; base.allowHints = false;
    base.timeLimitSec = c.seconds; base.moveLimit = level.targets.length + c.slack;
  }
  level.constraints = base;
  level.ranked = true;
  level.ruleset = 'challenge-v1';
  levelCache.set(key, level);
  return level;
}

// --------------------------------------------------------------- tutorial --

export function getTutorialLevel() {
  const key = 'tutorial';
  if (levelCache.has(key)) return levelCache.get(key);
  const level = generateLevel('tutorial-grove', { wheelSize: 5, targetCount: 4 });
  level.id = 'tutorial';
  level.mode = 'learn';
  level.theme = 'dawn';
  level.constraints = { allowShuffle: true, allowHints: true, allowUndo: true, bonusAllowed: true };
  levelCache.set(key, level);
  return level;
}

// Tutorial steps: each requires the player to perform the action.
// `check` names a session event the step waits for.
export const TUTORIAL_STEPS = [
  { id: 'welcome', title: 'Welcome to the Grove', body: 'Words grow here. Letters sit on the wheel below — connect them to spell words.', waitFor: null },
  { id: 'drag', title: 'Connect letters', body: 'Drag across letters on the wheel (or press letter keys) to spell a word. Letters can’t be reused within a word.', waitFor: 'select' },
  { id: 'submit', title: 'Plant a word', body: 'Spell one of the hidden grid words and release (or press Enter) to plant it in the grove.', waitFor: 'word-target' },
  { id: 'invalid', title: 'Not every word grows', body: 'Try a word that isn’t in the dictionary to see feedback. Real words you find that aren’t on the grid become bonus words.', waitFor: 'invalid' },
  { id: 'shuffle', title: 'Shuffle', body: 'Shuffling only changes how the wheel looks — never which letters you have. Try it.', waitFor: 'shuffle' },
  { id: 'hint', title: 'Hints', body: 'Stuck? A hint reveals one letter on the grid. It costs a few points.', waitFor: 'hint' },
  { id: 'finish', title: 'Grow the grove', body: 'Find every grid word to finish the level. Bonus words add points and flowers. Off you go!', waitFor: null },
];

// ------------------------------------------------------------ achievements -

export const ACHIEVEMENTS = [
  { key: 'first-bloom', name: 'First Bloom', desc: 'Complete your first level.' },
  { key: 'quick-study', name: 'Quick Study', desc: 'Finish the tutorial.' },
  { key: 'mechanic-mastery', name: 'Mechanic Mastery', desc: 'Use shuffle, a hint, find a bonus word, and undo — across any sessions.' },
  { key: 'streak-7', name: 'Seven Sunrises', desc: 'Complete daily challenges on 7 different days.' },
  { key: 'grove-master', name: 'Grove Master', desc: 'Complete every Journey stage.' },
  { key: 'thousand-words', name: 'Thousand Words', desc: 'Find 1,000 words in total. Any mode, any pace.' },
  { key: 'challenge-clear', name: 'Against the Wind', desc: 'Complete any Challenge stage.' },
];

// ---------------------------------------------------------------- themes ---

export const THEMES = {
  dawn: {
    id: 'dawn', name: 'Dawn', unlock: 0,
    sky: 0xbfd9e8, horizon: 0xf6d9b8, fog: 0xd8e4e0,
    ground: 0x5c7a4a, trunk: 0x6b4a35, foliage: 0x4e7a3a, foliageAlt: 0x6f9a4a,
    flower: 0xe86a92, flowerAlt: 0xf2b544, water: 0x7fb8c9,
    light: 0xfff2dd, lightIntensity: 2.6, ambient: 0x9db8c9, ambience: 'birds',
  },
  rain: {
    id: 'rain', name: 'Rain', unlock: 30,
    sky: 0x8fa5b5, horizon: 0xb8c8d0, fog: 0xa8bcc4,
    ground: 0x4a6342, trunk: 0x5a4030, foliage: 0x3f6b45, foliageAlt: 0x557d50,
    flower: 0x7ab8e8, flowerAlt: 0xa8d8f0, water: 0x6a98b8,
    light: 0xe8f0f8, lightIntensity: 1.8, ambient: 0x8aa0b0, ambience: 'rain',
  },
  autumn: {
    id: 'autumn', name: 'Autumn', unlock: 80,
    sky: 0xd8c8a8, horizon: 0xf0c890, fog: 0xd8c0a0,
    ground: 0x7a5a35, trunk: 0x5a3a28, foliage: 0xc87830, foliageAlt: 0xd8a040,
    flower: 0xd84830, flowerAlt: 0xf0a030, water: 0x98a8a0,
    light: 0xffe0b0, lightIntensity: 2.4, ambient: 0xc0a888, ambience: 'wind',
  },
  dusk: {
    id: 'dusk', name: 'Dusk', unlock: 150,
    sky: 0x585088, horizon: 0xe89878, fog: 0x887090,
    ground: 0x4a4a38, trunk: 0x483028, foliage: 0x3a5a40, foliageAlt: 0x506848,
    flower: 0xc858a8, flowerAlt: 0xf08060, water: 0x606088,
    light: 0xffc890, lightIntensity: 2.0, ambient: 0x706880, ambience: 'crickets',
  },
  night: {
    id: 'night', name: 'Night', unlock: 250,
    sky: 0x1c2438, horizon: 0x3a4060, fog: 0x283048,
    ground: 0x2a3528, trunk: 0x38281f, foliage: 0x2a4838, foliageAlt: 0x3a5845,
    flower: 0x88c8f0, flowerAlt: 0xc8b8f0, water: 0x38486a,
    light: 0xa8c0e8, lightIntensity: 1.4, ambient: 0x405070, ambience: 'crickets',
  },
};

export function themeById(id) {
  return THEMES[id] || THEMES.dawn;
}
