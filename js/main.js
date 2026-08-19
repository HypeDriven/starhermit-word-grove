// Word Grove — bootstrap: capability detection, module wiring, game-state
// machine (boot → title → mode-select → preparing → active ↔ paused →
// resolving → results → progression), and the render/tick loop.

import { loadSettings, saveSettings, loadProgress, saveProgress, loadBoards, saveBoards,
         saveLastSnapshot, loadLastSnapshot, clearLastSnapshot } from './storage.js';
import { AudioEngine } from './audio.js';
import { Platform } from './platform.js';
import { UI } from './ui.js';
import { Session, verifyReplay, sessionSeedCode, BUILD_VERSION } from './session.js';
import { getJourneyLevel, getDailyLevel, getPracticeLevel, getChallengeLevel, getTutorialLevel,
         journeyLevelCount, utcDateISO, THEMES, themeById, ACHIEVEMENTS, validateLevel } from './content.js';
import { compareResults } from './rules.js';
import { hashString } from './rng.js';

class App {
  constructor() {
    this.settings = loadSettings();
    this.progress = loadProgress();
    this.boards = loadBoards();
    this.platform = new Platform();
    this.platform.telemetryConsent = this.settings.analyticsConsent;
    this.audio = new AudioEngine(this.settings);
    this.session = null;
    this.renderer = null;
    this.ui = new UI(this);
    this.lastFrame = 0;
    this.hidden = false;
    this.resultsContext = null;
  }

  async boot() {
    this.ui.init();
    this.ui.applySettings();

    // Renderer (WebGL may be unavailable → DOM fallback, game still playable).
    const canvas = document.getElementById('scene-canvas');
    try {
      const { GroveRenderer, webglAvailable } = await import('./render.js');
      if (webglAvailable()) {
        this.renderer = new GroveRenderer(canvas, {
          settings: this.settings,
          theme: this.progress.selectedTheme,
          seed: 'title-grove',
        });
        if (this.renderer.failed) this.renderer = null;
      }
    } catch (err) {
      console.warn('3D unavailable:', err);
      this.renderer = null;
    }
    if (!this.renderer) {
      document.body.classList.add('no-webgl');
      document.getElementById('compat-warning').hidden = false;
    }

    this.audio.onCaption((t) => this.ui.caption(t));
    await this.platform.syncTime();
    this.platform.activityStart();
    this.platform.startPresence();
    window.addEventListener('beforeunload', () => this.platform.activityEnd());

    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (this.hidden) {
        this.audio.suspend();
        // Backgrounding pauses the solo simulation.
        if (this.session?.state.status === 'active') {
          this.session.pause();
          this.ui.pausedByOverlay = true;
        }
        this.persistSnapshot();
      } else {
        this.audio.resume();
        this.lastFrame = performance.now();
      }
    });

    // Persist the in-progress round periodically so a crash can resume it.
    setInterval(() => this.persistSnapshot(), 5000);

    this.platform.track('start', { build: BUILD_VERSION });
    this.ui.refreshTitle();
    this.ui.showScreen('screen-title');
    this.maybeResumeSnapshot();
    this.loop(performance.now());
  }

  todayISO() { return utcDateISO(this.platform.now()); }

  // ------------------------------------------------------------- loop -----

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    if (this.hidden) return; // zero rendering while backgrounded
    const dt = Math.min(now - this.lastFrame || 16, 100);
    this.lastFrame = now;
    this.ui.tick(dt);
    if (this.session) {
      const s = this.session.state;
      const found = Object.values(s.found).filter((f) => f.kind === 'target').length;
      this.audio.setMusicIntensity(found / Math.max(1, s.targets.length));
    }
    this.renderer?.update(dt);
  }

  // -------------------------------------------------------- round control -

  startRound(level, opts = {}) {
    // Offline content validation: defective content never reaches play.
    const errors = validateLevel(level);
    if (errors.length) {
      console.error('Defective content', level.id, errors);
      this.ui.toast('This content failed validation and is excluded from play.');
      this.platform.track('error', { category: 'content-validation' });
      return;
    }
    if (this.session && (this.session.state.status === 'active' || this.session.state.status === 'paused')) {
      this.session.abandon();
    }
    this.session = new Session(level);
    this.roundStartOpts = opts;
    this.currentLevel = level;
    this.audio.ensure();
    this.audio.event('ui');
    if (this.renderer) {
      this.renderer.setTheme(level.theme);
      this.renderer.resetGarden();
      this.renderer.setLetters(level.letters.split(''));
      this.renderer.visualRng = this.renderer.visualRng.fork(level.seed);
    }
    this.audio.startMusic();
    this.audio.startAmbience(themeById(level.theme).ambience);
    this.ui.enterGame(this.session, { tutorial: opts.tutorial });
    this.platform.track('start', { mode: level.mode });
    clearLastSnapshot();
  }

  abandonSession() {
    if (this.session && (this.session.state.status === 'active' || this.session.state.status === 'paused')) {
      this.session.abandon();
    }
  }

  restartRound() {
    if (!this.currentLevel) return;
    this.platform.track('retry', { mode: this.currentLevel.mode });
    this.startRound(this.currentLevel, this.roundStartOpts);
  }

  leaveRound() {
    this.abandonSession();
    this.finishRound(true);
  }

  goHome() {
    this.session = null;
    this.audio.stopAll();
    if (this.renderer) {
      this.renderer.setTheme(this.progress.selectedTheme);
      this.renderer.resetGarden();
    }
    this.ui.refreshTitle();
    this.ui.showScreen('screen-title');
  }

  resultsNext() {
    const ctx = this.resultsContext;
    if (ctx?.replay) {
      // Practice and chase replays get a fresh grove; others replay the same one.
      if (this.currentLevel?.mode === 'practice') this.startPractice(this.currentLevel.difficultyId || 'medium');
      else if (this.currentLevel?.mode === 'chase') this.startChase(null);
      else this.restartRound();
    }
    else if (ctx?.nextJourney != null) this.startJourney(ctx.nextJourney);
    else if (ctx?.nextAction === 'daily') this.startDaily();
    else this.goHome();
  }

  // --------------------------------------------------------------- modes ---

  playPrimary() {
    if (!this.progress.tutorialDone) this.startLearn();
    else {
      const next = this.nextJourneyIndex();
      if (next < journeyLevelCount()) this.startJourney(next);
      else this.startDaily();
    }
  }

  startLearn() {
    this.startRound(getTutorialLevel(), { tutorial: true });
  }

  startJourney(index) {
    this.startRound(getJourneyLevel(index));
  }

  startDaily() {
    this.startRound(getDailyLevel(this.todayISO()));
  }

  startPractice(difficulty) {
    const seed = 'p' + Date.now().toString(36);
    this.startRound(getPracticeLevel(difficulty, seed));
  }

  startChallenge(id) {
    this.startRound(getChallengeLevel(id));
  }

  startChase(seedText) {
    const seed = seedText || ('chase-' + Math.random().toString(36).slice(2, 9));
    const level = getPracticeLevel('hard', 'chase:' + seed);
    level.mode = 'chase';
    level.chaseSeed = seed;
    level.ranked = false;
    this.startRound(level);
    this.ui.toast(`Seed code: ${sessionSeedCode('chase:' + seed)} — share it to compare`, true);
    this.chaseSeed = seed;
  }

  cycleTheme() {
    const owned = Object.values(THEMES).filter((t) => this.progress.flowers >= t.unlock);
    const idx = owned.findIndex((t) => t.id === this.progress.selectedTheme);
    const next = owned[(idx + 1) % owned.length];
    this.progress.selectedTheme = next.id;
    this.saveProgress();
    this.renderer?.setTheme(next.id);
    this.audio.event('ui');
    this.ui.refreshTitle();
    const locked = Object.values(THEMES).find((t) => this.progress.flowers < t.unlock);
    if (locked) this.ui.toast(`${next.name} theme · next theme “${locked.name}” at ${locked.unlock} blooms`);
  }

  nextJourneyIndex() {
    for (let i = 0; i < journeyLevelCount(); i++) {
      if (!this.progress.journey[i]) return i;
    }
    return journeyLevelCount();
  }

  // ------------------------------------------------------------- finish ----

  finishRound(left = false) {
    const session = this.session;
    if (!session) { this.goHome(); return; }
    const summary = session.summary();
    this.session = null;
    clearLastSnapshot();
    this.audio.stopAmbience();
    this.platform.track('round-end', { mode: summary.mode, completed: summary.completed, score: summary.score });

    const p = this.progress;
    const unlocked = [];
    p.totals.sessions++;
    p.totals.words += summary.wordsFound + summary.bonusFound;
    p.totals.bonus += summary.bonusFound;
    p.totals.invalid += summary.invalidCount;
    p.totals.playSec += Math.round(summary.elapsedSec);
    p.flowers += summary.wordsFound + summary.bonusFound;

    let stars = 0;
    let nextJourney = null;
    let nextLabel = null;
    let board = null;

    if (summary.completed) {
      this.unlock('first-bloom', unlocked);
      if (summary.mode === 'learn') {
        p.tutorialDone = true;
        this.unlock('quick-study', unlocked);
        nextLabel = 'Start journey';
        nextJourney = 0;
      }
      if (summary.mode === 'journey') {
        const idx = session.level.journeyIndex;
        stars = 1 + (summary.score >= session.level.par ? 1 : 0) + (summary.hintsUsed === 0 ? 1 : 0);
        const prev = p.journey[idx];
        if (!prev || summary.score > prev.score) {
          p.journey[idx] = { score: summary.score, stars, bestSec: Math.round(summary.elapsedSec), completedAt: Date.now() };
        } else if (stars > prev.stars) prev.stars = stars;
        const next = idx + 1;
        if (next < journeyLevelCount()) { nextJourney = next; nextLabel = `Stage ${next + 1}`; }
        else { this.unlock('grove-master', unlocked); nextLabel = 'Daily grove'; }
      }
      if (summary.mode === 'daily') {
        const today = this.todayISO();
        if (!p.dailyDays.includes(today)) p.dailyDays.push(today);
        p.lastDaily = today;
        if (p.dailyDays.length >= 7) this.unlock('streak-7', unlocked);
        board = this.recordScore('daily:' + today, summary);
        this.submitHostedScore('daily:' + today, summary);
      }
      if (summary.mode === 'challenge') {
        const cid = session.level.challenge.id;
        const best = p.challengeBest[cid];
        if (!best || summary.score > best.score) p.challengeBest[cid] = { score: summary.score, sec: Math.round(summary.elapsedSec) };
        this.unlock('challenge-clear', unlocked);
        board = this.recordScore('challenge:' + cid, summary);
      }
      if (summary.mode === 'chase') {
        board = this.recordScore('chase:' + sessionSeedCode('chase:' + session.level.chaseSeed), summary);
      }
      if (summary.mode === 'practice') nextLabel = 'Play again';
    }
    if (!left && !summary.completed) nextLabel = 'Try again';

    // Mechanic mastery & long-term goals.
    const m = p.mechanicsUsed;
    if (m.shuffle && m.hint && m.bonus && m.undo) this.unlock('mechanic-mastery', unlocked);
    if (p.totals.words >= 1000) this.unlock('thousand-words', unlocked);

    this.saveProgress();
    this.audio.stopMusic();

    if (left && summary.terminalReason === 'abandoned' && summary.wordsFound === 0) {
      this.goHome();
      return;
    }
    const replay = nextLabel === 'Play again' || nextLabel === 'Try again';
    this.resultsContext = replay ? { replay: true } : { nextJourney, nextAction: nextLabel === 'Daily grove' ? 'daily' : null };
    this.ui.showResults(summary, { stars, achievements: unlocked, board, nextLabel });
    for (const key of unlocked) this.ui.toast(`Achievement: ${ACHIEVEMENTS.find((a) => a.key === key)?.name}`, true);
  }

  unlock(key, unlockedList) {
    if (this.progress.achievements[key]) return; // idempotent
    this.progress.achievements[key] = Date.now();
    unlockedList.push(key);
    this.audio.event('achievement');
  }

  markMechanic(kind) {
    if (!kind) return;
    if (!this.progress.mechanicsUsed[kind]) {
      this.progress.mechanicsUsed[kind] = true;
      this.saveProgress();
    }
  }

  // ---------------------------------------------------------- leaderboards -

  recordScore(boardId, summary) {
    const entry = {
      name: this.progress.displayName,
      score: summary.score,
      completed: summary.completed,
      invalidCount: summary.invalidCount,
      elapsedSec: Math.round(summary.elapsedSec),
      sessionId: summary.sessionId,
      ruleset: summary.ruleset,
      contentVersion: summary.contentVersion,
      seed: summary.seed,
      assists: { hints: summary.hintsUsed, shuffles: summary.shufflesUsed },
      durationSec: Math.round(summary.elapsedSec),
      ts: Date.now(),
      me: true,
    };
    const boards = this.boards;
    const b = boards.boards[boardId] = boards.boards[boardId] || { entries: [] };
    b.entries = b.entries.filter((e) => e.sessionId !== entry.sessionId);
    b.entries.push(entry);
    b.entries.sort(compareResults);
    b.entries = b.entries.slice(0, 50);
    b.entries.forEach((e) => { e.me = e.sessionId === entry.sessionId; });
    saveBoards(boards);
    return { title: 'Local board', entries: b.entries, casual: !this.platform.hosted };
  }

  async submitHostedScore(boardId, summary) {
    if (!this.platform.hosted) return;
    const res = await this.platform.submitScore({
      board: boardId,
      score: summary.score,
      ruleset: summary.ruleset,
      contentVersion: summary.contentVersion,
      seed: summary.seed,
      assists: { hints: summary.hintsUsed },
      durationSec: Math.round(summary.elapsedSec),
      replay: summary.replay,
    });
    if (res?.error) this.ui.toast('Score saved locally — server unreachable (casual board)');
  }

  getChaseBoard() {
    if (!this.chaseSeed) return null;
    const b = this.boards.boards['chase:' + sessionSeedCode('chase:' + this.chaseSeed)];
    return b ? { title: 'Score chase board', entries: b.entries, casual: true } : null;
  }

  // ------------------------------------------------------------- snapshot --

  persistSnapshot() {
    if (this.session && (this.session.state.status === 'active' || this.session.state.status === 'paused')) {
      saveLastSnapshot(this.session.snapshot());
    }
  }

  maybeResumeSnapshot() {
    const snap = loadLastSnapshot();
    if (!snap) return;
    // Only offer rounds that ended mid-play within the last day.
    if (Date.now() - snap.savedAt > 86400000) { clearLastSnapshot(); return; }
    try {
      const session = Session.restore(snap);
      if (session.state.status !== 'active' && session.state.status !== 'paused') { clearLastSnapshot(); return; }
      this.session = session;
      this.currentLevel = snap.level;
      this.roundStartOpts = {};
      if (this.renderer) {
        this.renderer.setTheme(snap.level.theme);
        this.renderer.resetGarden();
        this.renderer.setLetters(session.state.letters);
      }
      this.ui.enterGame(session, { tutorial: false });
      if (session.state.status === 'active') { session.pause(); }
      this.ui.toast('Round restored — press resume when ready');
      this.ui.openOverlay('overlay-pause');
    } catch (e) {
      console.warn('snapshot restore failed', e);
      clearLastSnapshot();
    }
  }

  haptic(pattern) {
    if (this.settings.haptics && navigator.vibrate) navigator.vibrate(pattern);
  }

  saveSettings() { saveSettings(this.settings); }
  saveProgress() { saveProgress(this.progress); }
}

const app = new App();
app.boot();
window.wordGrove = app; // inspectable for tests/debug
