// Word Grove — rules engine. Pure, deterministic, rendering-independent.
// All state transitions happen through dispatch(); UI, hints, and tutorials
// query legality through legalActions() — the same API used by play.

import { hashString, hashState } from './rng.js';
import { letterCountsOf, canForm } from './layout.js';
import { isValidWord } from './dictionary.js';

export const RULES_VERSION = 1;
export const TICK_MS = 100; // fixed simulation step: 10 Hz

// ---------------------------------------------------------------- state ----

export function createState(config) {
  const letters = config.letters.split('');
  const state = {
    version: RULES_VERSION,
    mode: config.mode,
    levelId: config.levelId,
    contentVersion: config.contentVersion,
    seed: config.seed,
    tick: 0,
    status: 'active', // active | paused | complete | failed
    terminalReason: null,
    letters,
    targets: config.targets.slice(),
    found: {},            // word -> { kind: 'target'|'bonus', tick }
    revealed: {},         // placementIndex -> array of bools (letter revealed)
    hintedCells: [],      // ["pi:i"] revealed via hints (for scoring transparency)
    constraints: {
      moveLimit: config.constraints?.moveLimit ?? null,
      timeLimitSec: config.constraints?.timeLimitSec ?? null,
      allowShuffle: config.constraints?.allowShuffle !== false,
      allowHints: config.constraints?.allowHints !== false,
      allowUndo: config.constraints?.allowUndo === true,
      bonusAllowed: config.constraints?.bonusAllowed !== false,
    },
    ranked: !!config.ranked,
    score: { target: 0, bonus: 0, pangram: 0, completion: 0, timeBonus: 0, moveBonus: 0, hintPenalty: 0 },
    invalidCount: 0,
    duplicateCount: 0,
    submissions: 0,
    hintsUsed: 0,
    shufflesUsed: 0,
    elapsedTicks: 0,
    rngA: hashString('rules:' + config.seed) >>> 0, // rules random stream state
    undoStack: [],
    log: [], // applied command summaries (replay envelope input log)
    lastError: null,
  };
  for (let i = 0; i < config.targets.length; i++) {
    state.revealed[i] = new Array(config.targets[i].length).fill(false);
  }
  return state;
}

// Rules-internal deterministic stream (serializable: state lives in state.rngA).
function nextRandom(state) {
  let a = state.rngA | 0;
  a = (a + 0x6d2b79f5) | 0;
  state.rngA = a >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------- legality ----

// The single legal-action query used by play, hints, and tutorials.
export function legalActions(state) {
  const active = state.status === 'active';
  const c = state.constraints;
  const remainingTargets = state.targets.filter((w) => !state.found[w]);
  return {
    canSubmit: active && (!c.moveLimit || state.submissions < c.moveLimit),
    canShuffle: active && c.allowShuffle,
    canHint: active && c.allowHints && remainingTargets.length > 0 && hasHiddenCell(state),
    canUndo: active && c.allowUndo && state.undoStack.length > 0,
    canPause: active,
    canResume: state.status === 'paused',
    remainingTargets,
    movesRemaining: c.moveLimit ? c.moveLimit - state.submissions : null,
    timeRemainingSec: c.timeLimitSec ? Math.max(0, c.timeLimitSec - elapsedSeconds(state)) : null,
  };
}

function hasHiddenCell(state) {
  return state.targets.some((w, i) => !state.found[w] && state.revealed[i].some((r) => !r));
}

export function elapsedSeconds(state) {
  return (state.elapsedTicks * TICK_MS) / 1000;
}

export function totalScore(state) {
  const s = state.score;
  return Math.max(0, s.target + s.bonus + s.pangram + s.completion + s.timeBonus + s.moveBonus - s.hintPenalty);
}

export function scoreBreakdown(state) {
  const s = state.score;
  return [
    { key: 'target', label: 'Words placed', value: s.target },
    { key: 'bonus', label: 'Bonus words', value: s.bonus },
    { key: 'pangram', label: 'Full-wheel words', value: s.pangram },
    { key: 'completion', label: 'Completion', value: s.completion },
    { key: 'timeBonus', label: 'Speed bonus', value: s.timeBonus },
    { key: 'moveBonus', label: 'Moves spared', value: s.moveBonus },
    { key: 'hintPenalty', label: 'Hint cost', value: -s.hintPenalty },
  ].filter((row) => row.value !== 0);
}

// Ordered tie-break comparison for leaderboards. Returns negative if a wins.
export function compareResults(a, b) {
  if (a.completed !== b.completed) return a.completed ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.invalidCount !== b.invalidCount) return a.invalidCount - b.invalidCount;
  if (a.elapsedSec !== b.elapsedSec) return a.elapsedSec - b.elapsedSec;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

// ------------------------------------------------------------ dispatch -----

let cmdCounter = 0;
export function makeCommandId(sessionId, tick) {
  return `${sessionId}:${tick}:${cmdCounter++}`;
}

// Returns { state, ok, reason?, events: [] }. Input state is not mutated.
export function dispatch(prevState, cmd) {
  const state = structuredClone(prevState);
  state.lastError = null;
  const events = [];
  const fail = (reason) => {
    state.lastError = reason;
    events.push({ type: 'invalid', reason });
    return { state, ok: false, reason, events };
  };

  // Idempotent duplicate rejection by command id.
  if (cmd.id && state.log.some((e) => e.id === cmd.id)) {
    return { state, ok: true, reason: 'duplicate-ignored', events: [{ type: 'duplicate', id: cmd.id }] };
  }

  const pushUndo = () => {
    if (state.constraints.allowUndo && cmd.type !== 'undo') {
      state.undoStack.push(JSON.stringify(snapshotForUndo(prevState)));
      if (state.undoStack.length > 50) state.undoStack.shift();
    }
  };

  const record = () => {
    state.log.push({ id: cmd.id ?? null, type: cmd.type, tick: cmd.tick ?? state.tick, word: cmd.word ?? undefined });
    if (state.log.length > 2000) state.log.shift();
  };

  switch (cmd.type) {
    case 'tick': {
      if (state.status !== 'active') return { state, ok: true, events };
      state.tick += 1;
      state.elapsedTicks += 1;
      const c = state.constraints;
      if (c.timeLimitSec && elapsedSeconds(state) >= c.timeLimitSec) {
        terminate(state, state.targets.every((w) => state.found[w]) ? 'complete' : 'failed',
          state.targets.every((w) => state.found[w]) ? 'all-words' : 'time-expired', events);
      }
      record();
      return { state, ok: true, events };
    }

    case 'submit': {
      if (state.status !== 'active') return fail('not-active');
      const word = String(cmd.word || '').toLowerCase().trim();
      if (!word || !/^[a-z]+$/.test(word)) return fail('malformed-word');
      if (word.length < 3) { state.invalidCount++; record(); return fail('too-short'); }
      if (state.constraints.moveLimit && state.submissions >= state.constraints.moveLimit) return fail('out-of-moves');
      const counts = letterCountsOf(state.letters);
      if (!canForm(word, counts)) { state.invalidCount++; record(); return fail('letters-unavailable'); }
      if (state.found[word]) { state.duplicateCount++; record(); return fail('already-found'); }

      const ti = state.targets.indexOf(word);
      if (ti >= 0) {
        pushUndo();
        state.submissions++;
        state.found[word] = { kind: 'target', tick: state.tick };
        state.revealed[ti] = state.revealed[ti].map(() => true);
        state.score.target += 20 + 10 * word.length;
        let pangram = false;
        if (word.length === state.letters.length) { state.score.pangram += 50; pangram = true; }
        events.push({ type: 'word', word, kind: 'target', pangram, placement: ti });
        if (state.targets.every((w) => state.found[w])) {
          state.score.completion += 100 + 10 * state.targets.length;
          if (state.constraints.moveLimit) {
            state.score.moveBonus += Math.max(0, state.constraints.moveLimit - state.submissions) * 15;
          }
          if (state.constraints.timeLimitSec) {
            state.score.timeBonus += Math.max(0, Math.round((state.constraints.timeLimitSec - elapsedSeconds(state)) * 2));
          }
          terminate(state, 'complete', 'all-words', events);
        }
      } else if (state.constraints.bonusAllowed && isValidWord(word)) {
        pushUndo();
        state.submissions++;
        state.found[word] = { kind: 'bonus', tick: state.tick };
        state.score.bonus += 5 * word.length;
        events.push({ type: 'word', word, kind: 'bonus' });
      } else {
        state.invalidCount++;
        record();
        return fail('unknown-word');
      }
      if (state.constraints.moveLimit && state.submissions >= state.constraints.moveLimit && state.status === 'active') {
        terminate(state, 'failed', 'out-of-moves', events);
      }
      record();
      return { state, ok: true, events };
    }

    case 'shuffle': {
      if (state.status !== 'active') return fail('not-active');
      if (!state.constraints.allowShuffle) return fail('shuffle-disabled');
      pushUndo();
      // Display-only: deterministic reorder from the rules stream.
      const arr = state.letters.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(nextRandom(state) * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      state.letters = arr;
      state.shufflesUsed++;
      events.push({ type: 'shuffle', letters: arr.join('') });
      record();
      return { state, ok: true, events };
    }

    case 'hint': {
      if (state.status !== 'active') return fail('not-active');
      if (!state.constraints.allowHints) return fail('hints-disabled');
      const hidden = [];
      state.targets.forEach((w, i) => {
        if (state.found[w]) return;
        state.revealed[i].forEach((r, j) => { if (!r) hidden.push([i, j]); });
      });
      if (!hidden.length) return fail('nothing-to-hint');
      pushUndo();
      const [pi, ci] = hidden[Math.floor(nextRandom(state) * hidden.length)];
      state.revealed[pi][ci] = true;
      state.hintedCells.push(pi + ':' + ci);
      state.hintsUsed++;
      state.score.hintPenalty += 25;
      events.push({ type: 'hint', placement: pi, cell: ci, letter: state.targets[pi][ci] });
      record();
      return { state, ok: true, events };
    }

    case 'undo': {
      if (state.status !== 'active') return fail('not-active');
      if (!state.constraints.allowUndo) return fail('undo-disabled');
      if (!state.undoStack.length) return fail('nothing-to-undo');
      const snap = JSON.parse(state.undoStack.pop());
      const restored = Object.assign(structuredClone(state), snap);
      restored.log = state.log;
      restored.log.push({ id: cmd.id ?? null, type: 'undo', tick: state.tick });
      restored.lastError = null;
      events.push({ type: 'undo' });
      return { state: restored, ok: true, events };
    }

    case 'pause': {
      if (state.status !== 'active') return fail('not-active');
      state.status = 'paused';
      events.push({ type: 'pause' });
      record();
      return { state, ok: true, events };
    }

    case 'resume': {
      if (state.status !== 'paused') return fail('not-paused');
      state.status = 'active';
      events.push({ type: 'resume' });
      record();
      return { state, ok: true, events };
    }

    case 'abandon': {
      if (state.status === 'complete' || state.status === 'failed') return fail('already-terminal');
      terminate(state, 'failed', 'abandoned', events);
      record();
      return { state, ok: true, events };
    }

    default:
      return fail('unknown-command');
  }
}

function snapshotForUndo(state) {
  const s = structuredClone(state);
  s.undoStack = [];
  s.log = [];
  return s;
}

function terminate(state, status, reason, events) {
  state.status = status;
  state.terminalReason = reason;
  events.push({ type: 'terminal', status, reason, score: totalScore(state) });
}

// ------------------------------------------------------ serialization ------

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : json;
  return migrate(state);
}

export function migrate(state) {
  if (state.version > RULES_VERSION) throw new Error('future-version');
  // v1 is current; migration steps for older versions would be applied here.
  state.version = RULES_VERSION;
  return state;
}

export function stateHash(state) {
  // Hash only rules-relevant fields (not undo stack/log) for replay checks.
  const { undoStack, log, ...core } = state;
  return hashState(core);
}
