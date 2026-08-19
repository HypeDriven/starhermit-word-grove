// Word Grove — session controller. Owns the fixed-step clock, routes player
// intents through the rules engine, records the replay envelope, and produces
// end-of-round summaries. Rendering consumes immutable snapshots + events.

import * as rules from './rules.js';
import { hashState, hashString } from './rng.js';
import { subanagrams } from './layout.js';
import { VALID } from './dictionary.js';

export const BUILD_VERSION = '1.0.0';
export const REPLAY_SCHEMA = 1;

export class Session {
  constructor(level, opts = {}) {
    this.level = level;
    this.sessionId = opts.sessionId || ('s' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    this.state = rules.createState({
      mode: level.mode,
      levelId: level.id,
      contentVersion: level.version,
      seed: level.seed,
      letters: level.letters,
      targets: level.targets,
      constraints: level.constraints,
      ranked: !!level.ranked,
    });
    this.listeners = new Set();
    this.accumulator = 0;
    this.lastStepAt = 0;
    this.replay = {
      schema: REPLAY_SCHEMA,
      build: BUILD_VERSION,
      contentVersion: level.version,
      ruleset: level.ruleset || 'local-v1',
      seed: level.seed,
      initialHash: rules.stateHash(this.state),
      startedAt: Date.now(),
      commands: [],
      stateHashes: [],
      terminal: null,
    };
    this.bonusPool = subanagrams(level.letters.split(''), VALID, 3)
      .filter((w) => !level.targets.includes(w));
    this.assistsUsed = { hints: 0, shuffles: 0, undos: 0 };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, payload) { for (const fn of this.listeners) fn(type, payload); }

  // Fixed-step advance; called from the render loop with real dt in ms.
  advance(dtMs) {
    if (this.state.status !== 'active') return;
    this.accumulator = Math.min(this.accumulator + dtMs, 1000); // clamp spiral of death
    while (this.accumulator >= rules.TICK_MS) {
      this.accumulator -= rules.TICK_MS;
      this.apply({ type: 'tick' }, true);
      if (this.state.status !== 'active') break;
    }
  }

  apply(cmd, silent = false) {
    cmd.id = cmd.id || rules.makeCommandId(this.sessionId, this.state.tick);
    const { state, ok, reason, events } = rules.dispatch(this.state, cmd);
    this.state = state;
    this.replay.commands.push({ id: cmd.id, type: cmd.type, tick: cmd.tick ?? state.tick, word: cmd.word });
    if (this.replay.commands.length % 20 === 0) {
      this.replay.stateHashes.push({ n: this.replay.commands.length, hash: rules.stateHash(state) });
    }
    for (const ev of events) {
      if (ev.type === 'terminal') {
        this.replay.terminal = {
          status: ev.status, reason: ev.reason, score: ev.score,
          finalHash: rules.stateHash(state),
        };
      }
      if (ev.type === 'hint') this.assistsUsed.hints++;
      if (ev.type === 'shuffle') this.assistsUsed.shuffles++;
      if (ev.type === 'undo') this.assistsUsed.undos++;
      if (!silent || ev.type !== 'tick') this.emit(ev.type, ev);
    }
    if (!ok && !silent) this.emit('rejected', { reason });
    return { ok, reason, events };
  }

  // Player intents -----------------------------------------------------------
  submitWord(word) { return this.apply({ type: 'submit', word }); }
  shuffle() { return this.apply({ type: 'shuffle' }); }
  hint() { return this.apply({ type: 'hint' }); }
  undo() { return this.apply({ type: 'undo' }); }
  pause() { return this.apply({ type: 'pause' }); }
  resume() { return this.apply({ type: 'resume' }); }
  abandon() { return this.apply({ type: 'abandon' }); }

  legality() { return rules.legalActions(this.state); }
  score() { return rules.totalScore(this.state); }
  breakdown() { return rules.scoreBreakdown(this.state); }
  elapsedSec() { return rules.elapsedSeconds(this.state); }

  remainingBonus() {
    return this.bonusPool.filter((w) => !this.state.found[w]).length;
  }

  // Grid view model for renderers (DOM or canvas). ---------------------------
  gridModel() {
    const g = this.level.grid;
    const cells = new Map();
    this.level.grid.placements.forEach((p, pi) => {
      const wordFound = !!this.state.found[p.word];
      for (let i = 0; i < p.word.length; i++) {
        const x = p.dir === 0 ? p.x + i : p.x;
        const y = p.dir === 0 ? p.y : p.y + i;
        const k = x + ',' + y;
        let cell = cells.get(k);
        if (!cell) { cell = { x, y, letter: p.word[i], revealed: false, words: [] }; cells.set(k, cell); }
        cell.words.push(pi);
        if (wordFound || this.state.revealed[pi][i]) cell.revealed = true;
      }
    });
    return { cells, width: g.width, height: g.height, placements: g.placements };
  }

  summary() {
    const s = this.state;
    const completed = s.status === 'complete';
    return {
      sessionId: this.sessionId,
      levelId: s.levelId,
      mode: s.mode,
      completed,
      terminalReason: s.terminalReason,
      score: rules.totalScore(s),
      breakdown: rules.scoreBreakdown(s),
      wordsFound: Object.values(s.found).filter((f) => f.kind === 'target').length,
      bonusFound: Object.values(s.found).filter((f) => f.kind === 'bonus').length,
      totalTargets: s.targets.length,
      invalidCount: s.invalidCount,
      duplicateCount: s.duplicateCount,
      hintsUsed: s.hintsUsed,
      shufflesUsed: s.shufflesUsed,
      elapsedSec: rules.elapsedSeconds(s),
      movesRemaining: s.constraints.moveLimit ? s.constraints.moveLimit - s.submissions : null,
      replay: this.replay,
      ranked: s.ranked,
      ruleset: this.replay.ruleset,
      contentVersion: s.contentVersion,
      seed: s.seed,
    };
  }

  snapshot() {
    return {
      level: this.level,
      stateJson: rules.serialize(this.state),
      replay: this.replay,
      sessionId: this.sessionId,
      assistsUsed: this.assistsUsed,
      savedAt: Date.now(),
    };
  }

  static restore(snap) {
    const s = new Session(snap.level, { sessionId: snap.sessionId });
    s.state = rules.deserialize(snap.stateJson);
    s.replay = snap.replay;
    s.assistsUsed = snap.assistsUsed || s.assistsUsed;
    return s;
  }
}

// Replay a recorded envelope against the rules engine; used by tests and by
// the authoritative validation script (server.js).
export function verifyReplay(level, replay) {
  let state = rules.createState({
    mode: level.mode, levelId: level.id, contentVersion: level.version,
    seed: level.seed, letters: level.letters, targets: level.targets,
    constraints: level.constraints, ranked: !!level.ranked,
  });
  if (rules.stateHash(state) !== replay.initialHash) return { ok: false, reason: 'initial-hash-mismatch' };
  for (const cmd of replay.commands) {
    const { state: next, ok } = rules.dispatch(state, cmd);
    if (!ok && cmd.type !== 'tick' && !['too-short', 'letters-unavailable', 'already-found', 'unknown-word'].includes(next.lastError)) {
      // Invalid player inputs are legitimate log entries; engine-level rejections are not.
    }
    state = next;
  }
  const finalHash = rules.stateHash(state);
  if (replay.terminal && replay.terminal.finalHash !== finalHash) {
    return { ok: false, reason: 'final-hash-mismatch' };
  }
  return { ok: true, score: rules.totalScore(state), finalHash };
}

export function sessionSeedCode(seed) {
  // Short shareable code for score-chase seeds.
  return 'WG-' + hashString(seed).toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
}
