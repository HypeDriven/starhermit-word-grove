// Word Grove — DOM shell: screens, wheel interaction, grid, HUD, overlays,
// settings, tutorial, results, accessibility mirror. UI state is separate
// from simulation state; all rules transitions go through the session.

import { TUTORIAL_STEPS, ACHIEVEMENTS, THEMES, groves, groveInfo, journeyLevelCount, CHALLENGES, PRACTICE_DIFFICULTIES } from './content.js';
import { legalActions, totalScore } from './rules.js';

const $ = (id) => document.getElementById(id);

const INVALID_TEXT = {
  'too-short': 'Words need at least 3 letters',
  'letters-unavailable': 'Those letters aren’t on the wheel',
  'already-found': 'Already found',
  'unknown-word': 'Not in the grove’s dictionary',
  'out-of-moves': 'No submissions left',
  'not-active': 'Round isn’t active',
  'malformed-word': 'Letters only',
};

export class UI {
  constructor(app) {
    this.app = app;
    this.session = null;
    this.selection = [];       // transient UI state: tile indices
    this.dragging = false;
    this.tileCenters = [];     // shared layout model (projected anchors)
    this.tileButtons = [];
    this.lastFocus = null;
    this.tutorial = null;      // { step }
    this.flashTimer = null;
    this.chaseSeed = null;
  }

  init() {
    const app = this.app;
    // Title
    $('btn-play').addEventListener('click', () => { app.audio.event('ui'); app.playPrimary(); });
    $('btn-daily').addEventListener('click', () => app.startDaily());
    $('btn-journey').addEventListener('click', () => { this.renderJourney(); this.showScreen('screen-journey'); });
    $('btn-practice').addEventListener('click', () => this.openPracticeSetup());
    $('btn-challenge').addEventListener('click', () => { this.renderChallenges(); this.showScreen('screen-challenges'); });
    $('btn-chase').addEventListener('click', () => { this.showScreen('screen-chase'); $('chase-seed').focus(); });
    $('btn-learn').addEventListener('click', () => app.startLearn());
    $('btn-settings').addEventListener('click', () => this.openSettings());
    $('btn-help').addEventListener('click', () => this.openHelp());
    $('btn-theme').addEventListener('click', () => app.cycleTheme());
    $('btn-profile-name').addEventListener('click', () => this.editProfileName());
    document.querySelectorAll('[data-back]').forEach((b) =>
      b.addEventListener('click', () => this.showScreen('screen-title')));

    // Chase
    $('chase-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const seed = $('chase-seed').value.trim();
      if (seed) app.startChase(seed);
    });
    $('btn-chase-random').addEventListener('click', () => app.startChase(null));

    // Game HUD
    $('btn-pause').addEventListener('click', () => this.pauseGame());
    $('btn-shuffle').addEventListener('click', () => this.doShuffle());
    $('btn-hint').addEventListener('click', () => this.doHint());
    $('btn-undo').addEventListener('click', () => this.doUndo());
    $('btn-clear').addEventListener('click', () => this.clearSelection(true));
    $('btn-submit').addEventListener('click', () => this.submitCurrent());

    // Pause overlay
    $('btn-resume').addEventListener('click', () => this.closePause(true));
    $('btn-pause-settings').addEventListener('click', () => this.openSettings());
    $('btn-pause-help').addEventListener('click', () => this.openHelp());
    $('btn-restart-level').addEventListener('click', () => { this.closeOverlay('overlay-pause'); this.app.restartRound(); });
    $('btn-leave').addEventListener('click', () => { this.closeOverlay('overlay-pause'); this.app.leaveRound(); });

    // Settings
    $('btn-settings-close').addEventListener('click', () => this.closeOverlay('overlay-settings'));
    $('btn-replay-tutorial').addEventListener('click', () => { this.closeOverlay('overlay-settings'); this.app.startLearn(); });
    this.bindSettings();

    // Help
    $('btn-help-close').addEventListener('click', () => this.closeOverlay('overlay-help'));

    // Results
    $('btn-results-retry').addEventListener('click', () => this.app.restartRound());
    $('btn-results-home').addEventListener('click', () => this.app.goHome());
    $('btn-results-next').addEventListener('click', () => this.app.resultsNext());

    // Setup sheet
    $('btn-setup-cancel').addEventListener('click', () => this.closeOverlay('overlay-setup'));

    // Compat
    $('btn-compat-ok').addEventListener('click', () => { $('compat-warning').hidden = true; });

    // Keyboard
    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Wheel layer drag handling (pointer capture; cancel-safe).
    const layer = $('wheel-layer');
    layer.addEventListener('pointermove', (e) => this.onDragMove(e));
    layer.addEventListener('pointerup', (e) => this.onDragEnd(e));
    layer.addEventListener('pointercancel', (e) => this.onDragCancel(e));
    layer.addEventListener('lostpointercapture', () => { if (this.dragging) this.onDragCancel(); });

    window.addEventListener('resize', () => this.onResize());
  }

  // ------------------------------------------------------------ screens ---

  showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
    this.currentScreen = id;
    if (id === 'screen-chase') this.renderChaseBoard(this.app.getChaseBoard());
    const focusTarget = document.querySelector(`#${id} .btn-primary`) || document.querySelector(`#${id} button`);
    if (focusTarget && id !== 'screen-game') setTimeout(() => focusTarget.focus(), 30);
    this.announce(document.querySelector(`#${id}`)?.dataset.title || '', false);
  }

  refreshTitle() {
    const p = this.app.progress;
    $('flowers-count').textContent = p.flowers;
    $('btn-profile-name').textContent = p.displayName;
    const nextIdx = this.app.nextJourneyIndex();
    $('journey-sub').textContent = nextIdx >= journeyLevelCount()
      ? 'All groves complete ✓'
      : `${groveInfo(Math.floor(nextIdx / 8)).name} · stage ${(nextIdx % 8) + 1}`;
    $('learn-sub').textContent = p.tutorialDone ? 'Replay lessons' : 'Start here';
    $('btn-play').textContent = nextIdx >= journeyLevelCount() ? 'Play daily' : (nextIdx === 0 && !p.tutorialDone ? 'Learn & play' : 'Continue journey');
    $('theme-name').textContent = THEMES[this.app.progress.selectedTheme]?.name || 'Dawn';
    const dailyDone = p.lastDaily === this.app.todayISO();
    $('daily-sub').textContent = dailyDone ? 'Done today ✓' : 'One grove per day';
  }

  editProfileName() {
    const name = prompt('Gardener name (shown on local boards):', this.app.progress.displayName);
    if (name && name.trim()) {
      this.app.progress.displayName = name.trim().slice(0, 20);
      this.app.saveProgress();
      this.refreshTitle();
    }
  }

  // ------------------------------------------------------------- journey --

  renderJourney() {
    const map = $('journey-map');
    map.innerHTML = '';
    const nextIdx = this.app.nextJourneyIndex();
    groves().forEach((g) => {
      const block = document.createElement('div');
      block.className = 'grove-block';
      const done = Object.keys(this.app.progress.journey).filter((i) => Math.floor(i / 8) === g.index).length;
      block.innerHTML = `<h3>${g.name} <small>${done}/8 · ${THEMES[g.theme].name}</small></h3>`;
      const row = document.createElement('div');
      row.className = 'grove-levels';
      row.setAttribute('role', 'list');
      for (let s = 0; s < 8; s++) {
        const idx = g.index * 8 + s;
        const rec = this.app.progress.journey[idx];
        const locked = idx > nextIdx;
        const btn = document.createElement('button');
        btn.className = 'btn level-node' + (locked ? ' locked' : '') + (idx === nextIdx ? ' current' : '') + (s === 7 ? ' mastery' : '');
        btn.disabled = locked;
        btn.setAttribute('role', 'listitem');
        btn.setAttribute('aria-label', `Stage ${idx + 1}${s === 7 ? ' (mastery)' : ''}${rec ? `, ${rec.stars} stars` : ''}${locked ? ', locked' : ''}`);
        btn.innerHTML = `<span>${idx + 1}</span><span class="node-stars">${rec ? '★'.repeat(rec.stars) : s === 7 ? '✦' : ''}</span>`;
        btn.addEventListener('click', () => this.app.startJourney(idx));
        row.appendChild(btn);
      }
      block.appendChild(row);
      map.appendChild(block);
    });
  }

  renderChallenges() {
    const list = $('challenge-list');
    list.innerHTML = '';
    CHALLENGES.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'challenge-card';
      card.setAttribute('role', 'listitem');
      const best = this.app.progress.challengeBest[c.id];
      card.innerHTML = `<div><strong>${c.label}</strong><p class="desc">${c.desc}</p></div>
        <div class="best">${best ? `Best ${best.score}` : ''}</div>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Play';
      btn.addEventListener('click', () => this.app.startChallenge(c.id));
      card.appendChild(btn);
      list.appendChild(card);
    });
  }

  openPracticeSetup() {
    const body = $('setup-body');
    body.innerHTML = '<p>Unranked. Undo is allowed. Nothing here affects leaderboards.</p>';
    PRACTICE_DIFFICULTIES.forEach((d) => {
      const label = document.createElement('label');
      label.className = 'check-row';
      label.innerHTML = `<input type="radio" name="practice-diff" value="${d.id}" ${d.id === 'medium' ? 'checked' : ''}> ${d.label} — <span class="fine">${d.note}</span>`;
      body.appendChild(label);
    });
    $('setup-title').textContent = 'Practice';
    const start = $('btn-setup-start');
    start.onclick = () => {
      const diff = body.querySelector('input[name=practice-diff]:checked')?.value || 'medium';
      this.closeOverlay('overlay-setup');
      this.app.startPractice(diff);
    };
    this.openOverlay('overlay-setup');
  }

  // ----------------------------------------------------------- game start -

  enterGame(session, { tutorial = false } = {}) {
    this.session = session;
    this.selection = [];
    this.dragging = false;
    this.unsub?.();
    this.unsub = session.on((type, ev) => this.onSessionEvent(type, ev));
    this.showScreen('screen-game');
    this.buildGrid();
    this.buildWheel();
    this.updateHUD();
    this.updateWordTray();
    $('hud-mode').textContent = this.modeLabel(session.level);
    $('btn-undo').hidden = !session.state.constraints.allowUndo;
    $('bonus-line').textContent = '';
    if (tutorial) this.startTutorial(); else this.stopTutorial();
    this.announce(`${this.modeLabel(session.level)} started. ${session.state.targets.length} words to find.`, false);
  }

  modeLabel(level) {
    if (level.mode === 'journey') return `Journey · stage ${level.journeyIndex + 1}${level.mastery ? ' ✦' : ''}`;
    if (level.mode === 'daily') return 'Daily grove';
    if (level.mode === 'practice') return 'Practice';
    if (level.mode === 'challenge') return `Challenge · ${level.challenge.label}`;
    if (level.mode === 'learn') return 'Learn';
    if (level.mode === 'chase') return 'Score chase';
    return level.mode;
  }

  onSessionEvent(type, ev) {
    const app = this.app;
    switch (type) {
      case 'word': {
        this.clearSelection(false);
        if (ev.kind === 'target') {
          app.audio.event(ev.pangram ? 'pangram' : 'word-target');
          this.feedback(ev.pangram ? `Full wheel! +${50}` : `“${ev.word}” planted!`, 'good');
          this.updateGrid(ev.placement);
          app.renderer?.bloomWord('target', ev.word);
          app.haptic(30);
        } else {
          app.audio.event('word-bonus');
          this.feedback(`Bonus word “${ev.word}”`, 'good');
          app.renderer?.bloomWord('bonus', ev.word);
          app.haptic(15);
        }
        app.markMechanic(ev.kind === 'bonus' ? 'bonus' : null);
        this.updateHUD();
        this.updateTutorial('word-' + ev.kind);
        break;
      }
      case 'invalid': {
        app.audio.event('invalid');
        this.feedback(INVALID_TEXT[ev.reason] || ev.reason, 'error');
        this.announce(INVALID_TEXT[ev.reason] || 'Invalid word', true);
        this.shakeTray();
        this.clearSelection(false);
        app.haptic([20, 40, 20]);
        this.updateTutorial('invalid');
        this.updateHUD();
        break;
      }
      case 'shuffle': {
        app.audio.event('shuffle');
        this.buildWheel();
        app.markMechanic('shuffle');
        this.updateTutorial('shuffle');
        break;
      }
      case 'hint': {
        app.audio.event('hint');
        this.feedback(`Hint: revealed “${ev.letter.toUpperCase()}”`, 'good');
        this.updateGrid();
        app.renderer?.hintBloom();
        app.markMechanic('hint');
        this.updateTutorial('hint');
        this.updateHUD();
        break;
      }
      case 'undo':
        app.audio.event('undo');
        app.markMechanic('undo');
        this.buildWheel();
        this.updateGrid();
        this.updateHUD();
        break;
      case 'pause': app.audio.event('pause'); break;
      case 'resume': app.audio.event('resume'); break;
      case 'terminal': {
        this.clearSelection(false);
        if (ev.status === 'complete') {
          app.audio.event('complete');
          app.renderer?.celebrate();
        } else app.audio.event('failed');
        this.updateHUD();
        // Guard against stale timers when the round was replaced meanwhile.
        const sess = this.session;
        setTimeout(() => { if (this.app.session === sess) this.app.finishRound(); }, 1400);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- grid ---

  buildGrid() {
    const wrap = $('grid-wrap');
    wrap.innerHTML = '';
    const model = this.session.gridModel();
    this.gridModel = model;
    const cols = model.width, rows = model.height;
    const avail = Math.min(window.innerWidth * 0.92, window.innerHeight * (window.innerHeight < 500 ? 0.5 : 0.42), 520);
    const cell = Math.max(16, Math.min(44, Math.floor(avail / Math.max(cols, rows)) - 4));
    wrap.style.setProperty('--cell-size', cell + 'px');
    wrap.style.gridTemplateColumns = `repeat(${cols}, var(--cell-size))`;
    this.gridCells = new Map();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = document.createElement('div');
        const cell = model.cells.get(x + ',' + y);
        d.className = 'grid-cell ' + (cell ? 'hidden-letter' : 'empty');
        if (cell) {
          d.dataset.x = x; d.dataset.y = y;
          this.gridCells.set(x + ',' + y, d);
        }
        wrap.appendChild(d);
      }
    }
    this.updateGrid();
  }

  updateGrid(flashPlacement = null) {
    const model = this.session.gridModel();
    const hinted = new Set(this.session.state.hintedCells);
    for (const [k, d] of this.gridCells) {
      const cell = model.cells.get(k);
      const foundWord = cell.words.some((pi) => this.session.state.found[model.placements[pi].word]);
      const wasHinted = cell.words.some((pi) => {
        const idx = cell.words.indexOf(pi);
        return hinted.has(pi + ':' + this.cellLetterIndex(model.placements[pi], cell));
      });
      d.classList.remove('hidden-letter', 'revealed', 'hinted', 'flash');
      if (cell.revealed) {
        d.textContent = cell.letter.toUpperCase();
        d.classList.add(foundWord ? 'revealed' : 'hinted');
      } else {
        d.textContent = '';
        d.classList.add('hidden-letter');
      }
    }
    if (flashPlacement !== null && flashPlacement !== undefined) {
      const p = model.placements[flashPlacement];
      for (let i = 0; i < p.word.length; i++) {
        const x = p.dir === 0 ? p.x + i : p.x;
        const y = p.dir === 0 ? p.y : p.y + i;
        this.gridCells.get(x + ',' + y)?.classList.add('flash');
      }
    }
    const target = this.session.state.targets[flashPlacement];
    if (target) this.announce(`“${target}” placed on the grid.`, false);
  }

  cellLetterIndex(placement, cell) {
    return placement.dir === 0 ? cell.x - placement.x : cell.y - placement.y;
  }

  // ---------------------------------------------------------------- wheel --

  buildWheel() {
    const layer = $('wheel-layer');
    layer.querySelectorAll('.wheel-tile-btn').forEach((b) => b.remove());
    this.tileButtons = this.session.state.letters.map((letter, i) => {
      const b = document.createElement('button');
      b.className = 'wheel-tile-btn';
      b.textContent = letter.toUpperCase();
      b.dataset.index = i;
      b.setAttribute('aria-label', `Letter ${letter.toUpperCase()}`);
      b.addEventListener('pointerdown', (e) => this.onTileDown(e, i));
      b.addEventListener('click', (e) => { /* keyboard activation */ if (!this.dragged) this.toggleTileKeyboard(i); });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); this.focusTile((i + 1) % this.tileButtons.length); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this.focusTile((i - 1 + this.tileButtons.length) % this.tileButtons.length); }
      });
      layer.appendChild(b);
      return b;
    });
    this.refreshWheelPositions();
    this.app.renderer?.setLetters(this.session.state.letters);
  }

  focusTile(i) { this.tileButtons[i]?.focus(); }

  refreshWheelPositions() {
    const n = this.session ? this.session.state.letters.length : 0;
    if (!n) return;
    this.tileCenters = this.tileButtons.map((b, i) => {
      let p = this.app.renderer?.projectTile(i);
      if (!p) p = this.fallbackTilePosition(i, n);
      b.style.transform = `translate(${p.x}px, ${p.y}px)`;
      return p;
    });
  }

  fallbackTilePosition(i, n) {
    const w = window.innerWidth, h = window.innerHeight;
    const r = Math.min(w, h) * 0.26;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { x: w / 2 + Math.cos(a) * r, y: h * 0.66 + Math.sin(a) * r * 0.8 };
  }

  onTileDown(e, i) {
    if (!this.session || this.session.state.status !== 'active') return;
    e.preventDefault();
    this.app.audio.ensure();
    this.dragging = true;
    this.dragged = false;
    $('wheel-layer').setPointerCapture?.(e.pointerId);
    this.beginSelection(i);
  }

  beginSelection(i) {
    this.selection = [i];
    this.updateTutorial('select');
    this.app.audio.event('select', { step: 0 });
    this.updateSelectionVisuals();
  }

  onDragMove(e) {
    if (!this.dragging || !this.session) return;
    this.refreshWheelPositions();
    const hit = this.hitTile(e.clientX, e.clientY);
    if (hit !== null) this.extendSelection(hit);
    const world = this.app.renderer?.screenToWheel(e.clientX, e.clientY);
    this.app.renderer?.setSelection(this.selection, world);
  }

  hitTile(x, y) {
    let best = null, bestD = 46 * 46;
    this.tileCenters.forEach((c, i) => {
      if (!c) return;
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  extendSelection(i) {
    const sel = this.selection;
    if (sel.includes(i)) {
      // Backtrack: dragging onto the previous letter pops the last one.
      if (sel.length > 1 && sel[sel.length - 2] === i) {
        sel.pop();
        this.app.audio.event('deselect');
        this.updateSelectionVisuals();
      }
      return;
    }
    sel.push(i);
    this.dragged = true;
    this.app.audio.event('select', { step: sel.length });
    this.updateSelectionVisuals();
  }

  onDragEnd() {
    if (!this.dragging) return;
    this.dragging = false;
    const submit = this.app.settings.submitOnRelease;
    setTimeout(() => { this.dragged = false; }, 50);
    if (submit && this.currentWord().length >= 3) this.submitCurrent();
    else if (this.currentWord().length < 3) this.clearSelection(false);
  }

  onDragCancel() {
    this.dragging = false;
    this.clearSelection(false);
  }

  toggleTileKeyboard(i) {
    // Buttons activated via keyboard/AT: append or backtrack.
    if (!this.session || this.session.state.status !== 'active') return;
    this.app.audio.ensure();
    if (this.selection.includes(i)) {
      if (this.selection[this.selection.length - 1] === i) this.selection.pop();
    } else {
      this.selection.push(i);
      this.updateTutorial('select');
      this.app.audio.event('select', { step: this.selection.length });
    }
    this.updateSelectionVisuals();
  }

  currentWord() {
    return this.selection.map((i) => this.session.state.letters[i]).join('');
  }

  updateSelectionVisuals() {
    this.tileButtons.forEach((b, i) => b.classList.toggle('selected', this.selection.includes(i)));
    this.app.renderer?.setSelection(this.selection, null);
    this.updateWordTray();
  }

  updateWordTray() {
    $('current-word').textContent = this.currentWord();
  }

  clearSelection(announceIt) {
    this.selection = [];
    this.updateSelectionVisuals();
    if (announceIt) this.announce('Word cleared', false);
  }

  submitCurrent() {
    const word = this.currentWord();
    if (!word) return;
    this.app.audio.ensure();
    this.session.submitWord(word);
  }

  doShuffle() {
    if (!this.session) return;
    this.app.audio.ensure();
    this.session.shuffle();
  }

  doHint() {
    if (!this.session) return;
    this.app.audio.ensure();
    this.session.hint();
  }

  doUndo() {
    if (!this.session) return;
    this.session.undo();
  }

  feedback(text, kind) {
    const el = $('word-feedback');
    el.textContent = text;
    el.className = kind || '';
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 2600);
  }

  shakeTray() {
    const tray = $('word-tray');
    tray.classList.remove('shake');
    void tray.offsetWidth;
    tray.classList.add('shake');
  }

  // ------------------------------------------------------------------ HUD --

  updateHUD() {
    if (!this.session) return;
    const s = this.session.state;
    const found = Object.values(s.found).filter((f) => f.kind === 'target').length;
    $('hud-progress').textContent = `${found} / ${s.targets.length} words`;
    $('hud-score').textContent = totalScore(s);
    const bonus = this.session.remainingBonus();
    const bonusFound = Object.values(s.found).filter((f) => f.kind === 'bonus').length;
    $('bonus-line').textContent = bonusFound ? `${bonusFound} bonus word${bonusFound > 1 ? 's' : ''} found · ${bonus} still hiding` : '';
    const leg = legalActions(s);
    $('btn-shuffle').disabled = !leg.canShuffle;
    $('btn-hint').disabled = !leg.canHint;
    $('btn-undo').disabled = !leg.canUndo;
    $('btn-submit').disabled = !leg.canSubmit;
    const moves = $('hud-moves');
    if (leg.movesRemaining !== null) {
      moves.hidden = false;
      moves.textContent = `${leg.movesRemaining} tries`;
      moves.classList.toggle('warning', leg.movesRemaining <= 2);
    } else moves.hidden = true;
    this.updateTimer();
  }

  updateTimer() {
    if (!this.session) return;
    const s = this.session.state;
    const leg = legalActions(s);
    const el = $('hud-timer');
    if (!this.app.settings.showTimer) { el.hidden = true; return; }
    el.hidden = false;
    let sec;
    if (leg.timeRemainingSec !== null) {
      sec = leg.timeRemainingSec;
      el.classList.toggle('warning', sec <= 30 && s.status === 'active');
      el.title = 'Time remaining';
    } else {
      sec = this.session.elapsedSec();
      el.classList.remove('warning');
      el.title = 'Elapsed time';
    }
    el.textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  }

  // Frame tick from the main loop.
  tick(dtMs) {
    this.pollGamepad();
    if (this.session && this.currentScreen === 'screen-game') {
      this.session.advance(dtMs);
      this.updateTimer();
      this.refreshWheelPositions();
    }
  }

  // --------------------------------------------------------------- gamepad -
  // Standard mapping: dpad/stick = focus letters, A = pick, B = remove,
  // X = shuffle, Y = hint, RB = submit, Start = pause/resume.
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && [...pads].find((p) => p && p.connected);
    if (!pad) { this.padPrev = null; return; }
    const pressed = pad.buttons.map((b) => b.pressed);
    const edge = (i) => pressed[i] && !this.padPrev?.[i];
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    const stickNav = (Math.abs(ax) > 0.6 || Math.abs(ay) > 0.6);
    const now = performance.now();

    if (this.currentScreen === 'screen-game' && this.session) {
      const n = this.tileButtons.length;
      if (n) {
        if (this.padFocus == null) this.padFocus = 0;
        const nav = (d) => {
          this.padFocus = (this.padFocus + d + n) % n;
          this.focusTile(this.padFocus);
        };
        if (edge(15) || edge(13)) nav(1);
        if (edge(14) || edge(12)) nav(-1);
        if (stickNav && (!this.padStickAt || now - this.padStickAt > 220)) {
          nav(ax > 0.6 || ay > 0.6 ? 1 : -1);
          this.padStickAt = now;
        }
        if (edge(0)) { this.app.audio.ensure(); this.toggleTileKeyboard(this.padFocus); }
        if (edge(1)) { this.selection.pop(); this.updateSelectionVisuals(); }
        if (edge(2)) this.doShuffle();
        if (edge(3)) this.doHint();
        if (edge(5)) this.submitCurrent();
      }
      if (edge(9)) {
        if (this.session.state.status === 'active') this.pauseGame();
        else this.closePause(true);
      }
    } else if (edge(9) && this.anyOverlayOpen()) {
      this.closePause(true);
    }
    this.padPrev = pressed;
  }

  // -------------------------------------------------------------- tutorial -

  startTutorial() {
    this.tutorial = { step: 0 };
    $('tutorial-bar').hidden = false;
    this.renderTutorialStep();
  }

  stopTutorial() {
    this.tutorial = null;
    $('tutorial-bar').hidden = true;
  }

  renderTutorialStep() {
    const st = TUTORIAL_STEPS[this.tutorial.step];
    if (!st) { this.stopTutorial(); return; }
    $('tutorial-title').textContent = `${this.tutorial.step + 1}/${TUTORIAL_STEPS.length} · ${st.title}`;
    $('tutorial-body').textContent = st.body;
    $('tutorial-next').textContent = st.waitFor ? 'Waiting for you…' : (this.tutorial.step === TUTORIAL_STEPS.length - 1 ? 'Play!' : 'Next');
    $('tutorial-next').disabled = !!st.waitFor;
    $('tutorial-next').onclick = () => this.advanceTutorial();
    $('tutorial-skip').onclick = () => { this.stopTutorial(); this.app.progress.tutorialDone = true; this.app.saveProgress(); };
    this.app.platform.track('tutorial-step', { step: st.id });
  }

  updateTutorial(eventName) {
    if (!this.tutorial) return;
    const st = TUTORIAL_STEPS[this.tutorial.step];
    if (st && st.waitFor === eventName) {
      this.tutorial.step++;
      this.renderTutorialStep();
    }
  }

  advanceTutorial() {
    if (!this.tutorial) return;
    this.tutorial.step++;
    if (this.tutorial.step >= TUTORIAL_STEPS.length) {
      this.stopTutorial();
      this.app.progress.tutorialDone = true;
      this.app.saveProgress();
    } else this.renderTutorialStep();
  }

  // -------------------------------------------------------------- overlays -

  openOverlay(id) {
    this.lastFocus = document.activeElement;
    $(id).hidden = false;
    const first = $(id).querySelector('.btn-primary, button');
    setTimeout(() => first?.focus(), 30);
  }

  closeOverlay(id) {
    $(id).hidden = true;
    if (this.lastFocus) { this.lastFocus.focus?.(); this.lastFocus = null; }
    // Returning to an active round: resume if we paused for the overlay.
    if (id === 'overlay-pause') return;
    if (!this.anyOverlayOpen() && this.session?.state.status === 'paused' && this.pausedByOverlay) {
      this.session.resume();
      this.pausedByOverlay = false;
    }
  }

  anyOverlayOpen() {
    return [...document.querySelectorAll('.overlay')].some((o) => !o.hidden);
  }

  pauseGame() {
    if (!this.session || this.session.state.status !== 'active') return;
    this.session.pause();
    this.openOverlay('overlay-pause');
  }

  closePause(resume) {
    this.closeOverlay('overlay-pause');
    if (resume && this.session?.state.status === 'paused') this.session.resume();
  }

  openSettings() {
    if (this.session?.state.status === 'active' && this.currentScreen === 'screen-game') {
      this.session.pause();
      this.pausedByOverlay = true;
    }
    this.syncSettingsForm();
    this.openOverlay('overlay-settings');
  }

  openHelp() {
    if (this.session?.state.status === 'active' && this.currentScreen === 'screen-game') {
      this.session.pause();
      this.pausedByOverlay = true;
    }
    this.openOverlay('overlay-help');
  }

  // -------------------------------------------------------------- settings -

  bindSettings() {
    const app = this.app;
    const s = () => app.settings;
    const bind = (id, get, set) => {
      const el = $(id);
      el.addEventListener('change', () => { set(el); app.saveSettings(); this.applySettings(); });
      el._sync = get;
    };
    bind('vol-music', () => s().volumes.music, (el) => { s().volumes.music = +el.value; });
    bind('vol-effects', () => s().volumes.effects, (el) => { s().volumes.effects = +el.value; });
    bind('vol-ambience', () => s().volumes.ambience, (el) => { s().volumes.ambience = +el.value; });
    bind('vol-voice', () => s().volumes.voice, (el) => { s().volumes.voice = +el.value; });
    bind('set-muted', () => s().muted, (el) => { s().muted = el.checked; });
    bind('set-captions', () => s().captions, (el) => { s().captions = el.checked; });
    bind('set-quality', () => s().quality, (el) => { s().quality = el.value; });
    bind('set-reduced-motion', () => s().reducedMotion, (el) => { s().reducedMotion = el.checked; });
    bind('set-camera-sway', () => s().cameraSway, (el) => { s().cameraSway = el.checked; });
    bind('set-timer', () => s().showTimer, (el) => { s().showTimer = el.checked; });
    bind('set-high-contrast', () => s().highContrast, (el) => { s().highContrast = el.checked; });
    bind('set-palette', () => s().palette, (el) => { s().palette = el.value; });
    bind('set-text-size', () => s().textSize, (el) => { s().textSize = el.value; });
    bind('set-left-handed', () => s().leftHanded, (el) => { s().leftHanded = el.checked; });
    bind('set-submit-release', () => s().submitOnRelease, (el) => { s().submitOnRelease = el.checked; });
    bind('set-haptics', () => s().haptics, (el) => { s().haptics = el.checked; });
    bind('set-analytics', () => s().analyticsConsent, (el) => { s().analyticsConsent = el.checked; });
  }

  syncSettingsForm() {
    ['vol-music', 'vol-effects', 'vol-ambience', 'vol-voice', 'set-muted', 'set-captions', 'set-quality',
      'set-reduced-motion', 'set-camera-sway', 'set-timer', 'set-high-contrast', 'set-palette',
      'set-text-size', 'set-left-handed', 'set-submit-release', 'set-haptics', 'set-analytics'].forEach((id) => {
      const el = $(id);
      if (!el?._sync) return;
      const v = el._sync();
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
    });
  }

  applySettings() {
    const s = this.app.settings;
    const html = document.documentElement;
    html.classList.toggle('reduced-motion', s.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
    html.classList.toggle('high-contrast', s.highContrast);
    html.classList.toggle('text-large', s.textSize === 'large');
    html.classList.toggle('text-xlarge', s.textSize === 'xlarge');
    html.classList.toggle('left-handed', s.leftHanded);
    this.app.audio.applyVolumes();
    this.app.platform.telemetryConsent = s.analyticsConsent;
    this.app.renderer?.setQuality(s.quality);
    if (this.session) {
      this.app.renderer?.setLetters(this.session.state.letters);
      this.updateTimer();
    }
    this.app.platform.track('settings-change', {});
  }

  // -------------------------------------------------------------- keyboard -

  onKeyDown(e) {
    // Overlay handling first.
    if (this.anyOverlayOpen()) {
      if (e.key === 'Escape') {
        const open = [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).pop();
        if (open) {
          if (open.id === 'overlay-pause') this.closePause(true);
          else this.closeOverlay(open.id);
          e.preventDefault();
        }
      }
      return;
    }
    if (this.currentScreen !== 'screen-game' || !this.session) return;
    if (e.target.matches('input, select, textarea')) return;
    const b = this.app.settings.bindings;
    const key = e.key;
    if (/^[a-zA-Z]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lower = key.toLowerCase();
      if (lower === b.shuffle && !this.selection.length) { this.doShuffle(); return; }
      if (lower === b.hint && !this.selection.length) { this.doHint(); return; }
      if (lower === b.undo && !this.selection.length) { this.doUndo(); return; }
      if (lower === b.pause && !this.selection.length) { this.pauseGame(); return; }
      // Type a letter: append the first unused tile carrying it.
      const idx = this.session.state.letters.findIndex((l, i) => l === lower && !this.selection.includes(i));
      if (idx >= 0) {
        this.app.audio.ensure();
        this.selection.push(idx);
        this.updateTutorial('select');
        this.app.audio.event('select', { step: this.selection.length });
        this.updateSelectionVisuals();
      }
      return;
    }
    if (key === b.deleteLetter || key === 'Backspace') {
      this.selection.pop();
      this.updateSelectionVisuals();
      e.preventDefault();
    } else if (key === b.submit || key === 'Enter') {
      this.submitCurrent();
      e.preventDefault();
    } else if (key === b.cancel || key === 'Escape') {
      if (this.selection.length) this.clearSelection(true);
      else this.pauseGame();
      e.preventDefault();
    }
  }

  // --------------------------------------------------------------- results -

  showResults(summary, extras) {
    this.showScreen('screen-results');
    $('results-headline').textContent = summary.completed
      ? ['Grove in full bloom!', 'Beautifully grown!', 'A flourishing grove!'][summary.sessionId.length % 3]
      : ({ 'time-expired': 'The sun set on this grove', 'out-of-moves': 'No tries remaining', 'abandoned': 'Round left early' }[summary.terminalReason] || 'Round over');
    $('results-sub').textContent = summary.completed
      ? `${summary.wordsFound} words planted · ${summary.bonusFound} bonus · ${this.fmtTime(summary.elapsedSec)}`
      : `${summary.wordsFound} of ${summary.totalTargets} words found`;

    // Stars (journey)
    const stars = extras?.stars ?? 0;
    $('results-stars').textContent = summary.mode === 'journey' && summary.completed ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '';

    // Breakdown
    const tbody = $('results-breakdown').querySelector('tbody');
    tbody.innerHTML = '';
    summary.breakdown.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th scope="row">${row.label}</th><td class="${row.value < 0 ? 'negative' : ''}">${row.value > 0 ? '+' : ''}${row.value}</td>`;
      tbody.appendChild(tr);
    });
    $('results-total').textContent = summary.score;

    // Achievements unlocked this round
    const ach = $('results-achievements');
    ach.innerHTML = '';
    (extras?.achievements || []).forEach((key) => {
      const def = ACHIEVEMENTS.find((a) => a.key === key);
      if (!def) return;
      const chip = document.createElement('span');
      chip.className = 'achievement-chip';
      chip.textContent = `🏆 ${def.name}`;
      chip.title = def.desc;
      ach.appendChild(chip);
    });

    // Leaderboard
    const boardEl = $('results-board');
    boardEl.innerHTML = '';
    if (extras?.board) this.renderBoard(boardEl, extras.board);

    // Next action
    const next = $('btn-results-next');
    if (extras?.nextLabel) { next.hidden = false; next.textContent = extras.nextLabel; }
    else next.hidden = true;

    this.announce(`${$('results-headline').textContent}. Score ${summary.score}.`, true);
  }

  renderBoard(el, board) {
    const h = document.createElement('h3');
    h.textContent = board.title;
    el.appendChild(h);
    if (!board.entries.length) {
      const p = document.createElement('p');
      p.className = 'casual-note';
      p.textContent = 'No entries yet — yours is the first.';
      el.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>#</th><th>Gardener</th><th>Time</th><th>Score</th></tr></thead>';
    const tbody = document.createElement('tbody');
    board.entries.slice(0, 10).forEach((e, i) => {
      const tr = document.createElement('tr');
      if (e.me) tr.className = 'me';
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(e.name)}</td><td>${this.fmtTime(e.elapsedSec)}</td><td>${e.score}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.appendChild(table);
    if (board.casual) {
      const p = document.createElement('p');
      p.className = 'casual-note';
      p.textContent = 'Casual board — server validation unavailable offline.';
      el.appendChild(p);
    }
  }

  renderChaseBoard(board) {
    const el = $('chase-board');
    el.innerHTML = '';
    if (board) this.renderBoard(el, board);
  }

  fmtTime(sec) {
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  }

  // ----------------------------------------------------------- accessibility

  announce(msg, assertive) {
    $(assertive ? 'live-assertive' : 'live-polite').textContent = '';
    setTimeout(() => { $(assertive ? 'live-assertive' : 'live-polite').textContent = msg; }, 30);
  }

  caption(text) {
    if (!this.app.settings.captions) return;
    $('captions').textContent = text;
  }

  toast(text, gold = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (gold ? ' gold' : '');
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3200);
    this.announce(text, false);
  }

  onResize() {
    this.app.renderer?.resize();
    if (this.session && this.currentScreen === 'screen-game') {
      this.buildGrid();
      this.refreshWheelPositions();
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
