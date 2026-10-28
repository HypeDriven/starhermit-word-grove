// Word Grove on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), the session
// (js/session.js), the content (js/content.js with the fixed levels in
// js/levels.js) and the dictionary are the browser build's; this module is
// what js/main.js and js/ui.js did around them: navigation between the
// screens (title, Journey, Challenges, Score chase, the round, results) and
// sheets (pause, settings, how to play, practice setup, gardener name),
// starting every mode (the grove prepared on a worker: native/gen.ts),
// spelling on the wheel by drag, tap, typed letters, keys and pads, submit,
// shuffle, hints, undo, the lesson bar, the session's events (sounds,
// feedback, the grid flash, flowers, captions and announcements), finishing
// a round (progress, stars, achievements, local boards, the high-score post
// and the Daily's platform board), the interrupted-round snapshot and the
// lifecycle (a hidden window pauses the round, as visibilitychange did).
// Screens are drawn by screens.ts (starhermit:ui), the grove by render.ts.
//
// Time: the session's fixed 10 Hz rules clock advances 1000/60 ms per
// runtime fixed step while the round screen shows (as ui.tick advanced it
// per frame), so rounds replay exactly; delays (feedback, toasts, the
// results after a round ends) run on the same fixed-step clock.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindings, onAction, onKey, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { C, Session, compareResults, legalActions, sessionSeedCode, type Level, type Session as Sess, type SessionEvent, type Summary } from "./game.ts";
import * as audio from "./audio.ts";
import * as gen from "./gen.ts";
import { S, T, TN, player as playerLabel } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "journey" | "challenges" | "chase" | "game" | "results";
export type Overlay = "pause" | "settings" | "help" | "setup" | "name" | null;
export interface Board { titleKey: string; entries: { name: string; score: number; elapsedSec?: number | null; me?: boolean }[]; casual: boolean }
export interface Results {
  summary: Summary; stars: number; achievements: string[]; board: Board | null; nextLabel: string | null; nextVars: Record<string, number> | null;
}
export const app = {
  screen: "title" as Screen,
  overlay: null as Overlay,
  openedFrame: 0,
  focusNext: null as string | null,
  session: null as Sess | null,
  level: null as Level | null,
  roundOpts: {} as { tutorial?: boolean },
  selection: [] as number[],
  cursor: -1,
  feedback: null as { text: string; kind: "good" | "error" | ""; until: number } | null,
  shakeUntil: 0,
  flash: { cells: new Set<string>(), until: 0 },
  tutorial: null as { step: number } | null,
  results: null as Results | null,
  resultsNext: null as { replay?: boolean; nextJourney?: number | null; nextAction?: string | null } | null,
  lb: null as { key: string; vars?: Record<string, number> } | null,
  toasts: [] as { text: string; gold: boolean; until: number }[],
  preparing: null as { since: number } | null,
  pausedByOverlay: false,
  chaseSeed: null as string | null,
  chaseText: "",
  nameText: "",
  practiceDiff: "medium",
};
let clockMs = 0;
export const nowMs = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ fixed-step timers
interface Timer { id: number; at: number; fn: () => void }
const timerList: Timer[] = [];
let timerId = 1;
export function after(ms: number, fn: () => void): number { const id = timerId++; timerList.push({ id, at: clockMs + ms, fn }); return id; }
function runTimers(): void {
  for (let guard = 0; guard < 32; guard++) {
    const i = timerList.findIndex((t) => t.at <= clockMs);
    if (i < 0) return;
    const [t] = timerList.splice(i, 1);
    t!.fn();
  }
}

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
export function announce(text: string): void { if (text) spoken.push(text); }
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).slice(-3).join(" ").slice(0, 400);
  try { ui.announce(text); } catch { /* busy */ }
}
/** ui.js toast (3.2 s, announced). */
export function toast(text: string, gold = false): void {
  app.toasts.push({ text, gold, until: clockMs + 3200 });
  if (app.toasts.length > 3) app.toasts.shift();
  announce(text);
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built. */
export function later(fn: () => void): void { pending.push(fn); }
export function sfx(ev: audio.Sfx): void {
  audio.play(ev);
  const cap = audio.CAPTIONS[ev];
  if (cap && platform.options.captions) announce(T(cap));
}
export function click(fn: () => void): () => void { return () => { sfx("ui"); fn(); }; }
export const reducedMotion = (): boolean => preferences().reducedMotion;
function haptic(ms: number): void { if (platform.options.haptics) { try { vibrate(ms); } catch { /* none */ } } }
export function todayISO(): string { return C.utcDateISO(platform.nowMs()); }
export function fmtTime(sec: number): string { return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`; }
const INVALID_KEYS: Record<string, string> = {
  "too-short": "inv_tooShort", "letters-unavailable": "inv_unavailable", "already-found": "inv_found", "unknown-word": "inv_unknown",
  "out-of-moves": "inv_moves", "not-active": "inv_inactive", "malformed-word": "inv_malformed",
};
const invalidText = (reason?: string): string => (reason && INVALID_KEYS[reason] ? T(INVALID_KEYS[reason]!) : T("invalidWord"));

// ------------------------------------------------------------------ screens and overlays
const FIRST_FOCUS: Partial<Record<Screen, string>> = { title: "btn-play", journey: "btn-back", challenges: "btn-back", chase: "chase-seed", results: "btn-results-next" };
export const touchFirst = (): boolean => frame().width / ui.preferences().scale < 600;
export function show(name: Screen): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = touchFirst() || name === "game" ? null : FIRST_FOCUS[name] ?? null;
  ui.setFocus(null);
  const key: Partial<Record<Screen, string>> = { journey: "journey", challenges: "challengesH", chase: "scoreChase", game: "play", results: "screenResults" };
  announce(key[name] ? T(key[name]!) : "Word Grove");
}
export function openOverlay(o: Exclude<Overlay, null>): void {
  if ((o === "settings" || o === "help") && app.session?.state.status === "active" && app.screen === "game") {
    app.session.pause();
    app.pausedByOverlay = true;
  }
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = touchFirst() ? null : "overlay-first";
  ui.setFocus(null);
}
/** ui.js closeOverlay: back to the pause sheet it came from, or resume the round it paused. */
export function closeOverlay(): void {
  const was = app.overlay;
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  if (was === "pause") return;
  if (returnToPause) { returnToPause = false; app.overlay = "pause"; return; }
  if (app.session?.state.status === "paused" && app.pausedByOverlay) { app.session.resume(); app.pausedByOverlay = false; }
}
let returnToPause = false;
export function pauseTo(o: "settings" | "help"): void { returnToPause = true; app.overlay = o; app.openedFrame = frame().frame; app.focusNext = touchFirst() ? null : "overlay-first"; }
export function pauseGame(): void {
  const s = app.session;
  if (!s || s.state.status !== "active" || app.screen !== "game") return;
  s.pause();
  openOverlay("pause");
}
export function resume(): void {
  app.overlay = null;
  returnToPause = false;
  app.openedFrame = frame().frame;
  if (app.session?.state.status === "paused") app.session.resume();
}
export function goBack(): void { show("title"); }

// ------------------------------------------------------------------ modes (main.js)
export function nextJourneyIndex(): number {
  const p = platform.progress();
  for (let i = 0; i < C.journeyLevelCount(); i++) if (!p.journey[i]) return i;
  return C.journeyLevelCount();
}
export function playPrimary(): void {
  if (!platform.progress().tutorialDone) startLearn();
  else {
    const next = nextJourneyIndex();
    if (next < C.journeyLevelCount()) startJourney(next); else startDaily();
  }
}
export function startLearn(): void { prepareRound("tutorial", undefined, undefined, { tutorial: true }); }
export function startJourney(i: number): void { prepareRound("journey", i); }
export function startDaily(): void { prepareRound("daily", todayISO()); }
export function startPractice(diff: string): void { app.practiceDiff = diff; prepareRound("practice", diff, "p" + Date.now().toString(36)); }
export function startChallenge(id: string): void { prepareRound("challenge", id); }
export function startChase(seedText: string | null): void {
  const seed = seedText || "chase-" + Math.random().toString(36).slice(2, 9);
  prepareRound("practice", "hard", "chase:" + seed, {}, (level) => {
    level.mode = "chase";
    level.chaseSeed = seed;
    level.ranked = false;
  }, () => {
    // the hash-based WG- code only names the board; the raw seed round-trips through the seed form
    toast(T("chaseToast", { seed }), true);
    app.chaseSeed = seed;
  });
}
let prepToken = 0;
function prepareRound(kind: gen.Kind, arg?: string | number, arg2?: string, opts: { tutorial?: boolean } = {}, adjust?: (l: Level) => void, then?: () => void): void {
  if (app.preparing) return;
  const token = ++prepToken;
  app.preparing = { since: clockMs };
  gen.prepare(kind, arg, arg2, (p, err) => {
    if (token !== prepToken) return;
    app.preparing = null;
    if (!p) { console.error(`grove preparation failed: ${err}`); toast(T("contentFailed")); return; }
    adjust?.(p.level);
    if (startRound(p.level, p.bonusPool, opts)) then?.();
  });
}
function startRound(level: Level, bonusPool: string[], opts: { tutorial?: boolean } = {}): boolean {
  const errors = C.validateLevel(level);
  if (errors.length) { console.error(`Defective content ${level.id}: ${errors.join(", ")}`); toast(T("contentFailed")); return false; }
  abandonSession();
  const s = new Session(level, { bonusPool });
  enterRound(s, level, opts);
  platform.clearSnapshot();
  return true;
}
let unsub: (() => void) | null = null;
function enterRound(s: Sess, level: Level, opts: { tutorial?: boolean }): void {
  app.session = s;
  app.level = level;
  app.roundOpts = opts;
  app.selection = [];
  app.cursor = -1;
  app.feedback = null;
  app.flash = { cells: new Set(), until: 0 };
  app.overlay = null;
  app.pausedByOverlay = false;
  returnToPause = false;
  unsub?.();
  unsub = s.on((type, ev) => onSessionEvent(s, type, ev));
  render.startRound(level.theme, s.state.letters, level.seed);
  audio.startMusic(true);
  audio.ambience(C.themeById(level.theme).ambience);
  app.tutorial = opts.tutorial ? { step: 0 } : null;
  show("game");
  announce(T("roundStarted", { mode: modeLabel(level), n: s.state.targets.length }));
}
function abandonSession(): void {
  const s = app.session;
  if (s && (s.state.status === "active" || s.state.status === "paused")) s.abandon();
}
export function restartRound(): void {
  const l = app.level;
  if (!l) return;
  if (l.mode === "chase" && l.chaseSeed) { const seed = l.chaseSeed; prepareRound("practice", "hard", "chase:" + seed, {}, (lv) => { lv.mode = "chase"; lv.chaseSeed = seed; lv.ranked = false; }); return; }
  const opts = app.roundOpts;
  const kind: gen.Kind = l.mode === "learn" ? "tutorial" : l.mode as gen.Kind;
  if (kind === "practice") { const parts = l.id.split(":"); prepareRound("practice", parts[1], parts.slice(2).join(":"), opts); return; }
  if (kind === "journey") prepareRound("journey", l.journeyIndex, undefined, opts);
  else if (kind === "daily") prepareRound("daily", l.id.slice(6), undefined, opts);
  else if (kind === "challenge") prepareRound("challenge", l.challenge!.id, undefined, opts);
  else prepareRound("tutorial", undefined, undefined, opts);
}
export function leaveRound(): void { app.overlay = null; abandonSession(); void finishRound(true); }
export function goHome(): void {
  unsub?.();
  unsub = null;
  app.session = null;
  app.tutorial = null;
  audio.startMusic(false);
  audio.ambience(null);
  render.resetGarden(platform.progress().selectedTheme);
  show("title");
}
export function resultsNext(): void {
  const ctx = app.resultsNext;
  const l = app.level;
  if (ctx?.replay) {
    if (l?.mode === "practice") startPractice(l.difficultyId || "medium");
    else if (l?.mode === "chase") startChase(null);
    else restartRound();
  } else if (ctx?.nextJourney != null) startJourney(ctx.nextJourney);
  else if (ctx?.nextAction === "daily") startDaily();
  else goHome();
}
export function cycleTheme(): void {
  const p = platform.progress();
  const owned = Object.values(C.THEMES).filter((t) => p.flowers >= t.unlock);
  const idx = owned.findIndex((t) => t.id === p.selectedTheme);
  const next = owned[(idx + 1) % owned.length]!;
  p.selectedTheme = next.id;
  platform.save();
  render.setTheme(next.id);
  const locked = Object.values(C.THEMES).find((t) => p.flowers < t.unlock);
  if (locked) toast(T("themeToast", { theme: themeText(next.id), next: themeText(locked.id), n: locked.unlock }));
}
export const themeText = (id: string): string => TN("themes", id, [C.THEMES[id]?.name ?? id]) as unknown as string;
export function modeLabel(level: Level): string {
  if (level.mode === "journey") return T("modeJourney", { n: (level.journeyIndex ?? 0) + 1 }) + (level.mastery ? " ✦" : "");
  if (level.mode === "daily") return T("modeDaily");
  if (level.mode === "practice") return T("practice");
  if (level.mode === "challenge") return T("modeChallenge", { name: TN("challenges", level.challenge!.id, [level.challenge!.label])[0]! });
  if (level.mode === "learn") return T("learn");
  if (level.mode === "chase") return T("scoreChase");
  return level.mode;
}

// ------------------------------------------------------------------ the wheel (ui.js selection)
export function currentWord(): string {
  const s = app.session;
  return s ? app.selection.map((i) => s.state.letters[i]).join("") : "";
}
function syncSelection(cursor: { x: number; z: number } | null = null): void { render.setSelection(app.selection, cursor); }
const active = (): boolean => !!app.session && app.session.state.status === "active" && app.screen === "game" && !app.overlay;
function beginSelection(i: number): void {
  app.selection = [i];
  updateTutorial("select");
  sfx("select");
  syncSelection();
}
function extendSelection(i: number): void {
  const sel = app.selection;
  if (sel.includes(i)) {
    if (sel.length > 1 && sel[sel.length - 2] === i) { sel.pop(); sfx("deselect"); syncSelection(); }
    return;
  }
  sel.push(i);
  sfx("select");
  syncSelection();
}
/** Buttons activated by keys / taps: append or backtrack (ui.js toggleTileKeyboard). */
export function toggleTile(i: number): void {
  if (!active()) return;
  const sel = app.selection;
  if (sel.includes(i)) { if (sel[sel.length - 1] === i) { sel.pop(); sfx("deselect"); } }
  else { sel.push(i); updateTutorial("select"); sfx("select"); }
  syncSelection();
}
export function removeLast(): void { if (app.selection.length) { app.selection.pop(); syncSelection(); } }
export function clearSelection(spoken = false): void {
  app.selection = [];
  syncSelection();
  if (spoken) announce(T("wordCleared"));
}
export function submitCurrent(): void {
  const w = currentWord();
  if (!w || !app.session) return;
  app.session.submitWord(w);
}
export function doShuffle(): void { if (app.session) app.session.shuffle(); }
export function doHint(): void { if (app.session) app.session.hint(); }
export function doUndo(): void { if (app.session) app.session.undo(); }
function feedback(text: string, kind: "good" | "error"): void { app.feedback = { text, kind, until: clockMs + 2600 }; }
function markMechanic(kind: string | null): void {
  if (!kind) return;
  const p = platform.progress();
  if (!p.mechanicsUsed[kind]) { p.mechanicsUsed[kind] = true; platform.save(); }
}
function flashWord(word: string): void {
  const s = app.session!;
  const p = s.level.grid.placements.find((pl) => pl.word === word);
  if (!p) return;
  const cells = new Set<string>();
  for (let i = 0; i < p.word.length; i++) cells.add(p.dir === 0 ? `${p.x + i},${p.y}` : `${p.x},${p.y + i}`);
  app.flash = { cells, until: clockMs + 900 };
  announce(T("placedOnGrid", { word }));
}

// ------------------------------------------------------------------ session events (ui.js onSessionEvent)
function onSessionEvent(s: Sess, type: string, ev: SessionEvent): void {
  if (app.session !== s) return;
  switch (type) {
    case "word": {
      clearSelection();
      if (ev.kind === "target") {
        sfx(ev.pangram ? "pangram" : "word-target");
        feedback(ev.pangram ? T("fullWheel", { n: 50 }) : T("planted", { word: ev.word! }), "good");
        flashWord(ev.word!);
        render.bloomWord("target", ev.word!);
        haptic(30);
      } else {
        sfx("word-bonus");
        feedback(T("bonusWord", { word: ev.word! }), "good");
        render.bloomWord("bonus", ev.word!);
        haptic(15);
      }
      markMechanic(ev.kind === "bonus" ? "bonus" : null);
      updateTutorial("word-" + ev.kind);
      break;
    }
    case "invalid":
      sfx("invalid");
      feedback(invalidText(ev.reason), "error");
      announce(invalidText(ev.reason));
      app.shakeUntil = clockMs + 300;
      clearSelection();
      haptic(40);
      updateTutorial("invalid");
      break;
    case "shuffle":
      sfx("shuffle");
      render.shuffleVisual(s.state.letters);
      markMechanic("shuffle");
      updateTutorial("shuffle");
      break;
    case "hint":
      sfx("hint");
      feedback(T("hintRevealed", { letter: (ev.letter ?? "").toUpperCase() }), "good");
      render.hintBloom();
      markMechanic("hint");
      updateTutorial("hint");
      break;
    case "undo":
      sfx("undo");
      markMechanic("undo");
      clearSelection();
      render.setLetters(s.state.letters);
      break;
    case "pause": sfx("pause"); break;
    case "resume": sfx("resume"); break;
    case "terminal":
      clearSelection();
      if (ev.status === "complete") { sfx("complete"); render.celebrate(); } else sfx("failed");
      after(1400, () => { if (app.session === s) void finishRound(); });
      break;
  }
}

// ------------------------------------------------------------------ the lesson bar (ui.js tutorial)
export function updateTutorial(eventName: string): void {
  const tu = app.tutorial;
  if (!tu) return;
  const st = C.TUTORIAL_STEPS[tu.step];
  if (st && st.waitFor === eventName) tu.step++;
  if (tu.step >= C.TUTORIAL_STEPS.length) app.tutorial = null;
}
export function advanceTutorial(): void {
  const tu = app.tutorial;
  if (!tu) return;
  tu.step++;
  if (tu.step >= C.TUTORIAL_STEPS.length) skipTutorial();
}
export function skipTutorial(): void {
  app.tutorial = null;
  platform.progress().tutorialDone = true;
  platform.save();
}

// ------------------------------------------------------------------ finishing a round (main.js finishRound)
const ACH = (): typeof C.ACHIEVEMENTS => C.ACHIEVEMENTS;
function unlock(key: string, list: string[]): void {
  const p = platform.progress();
  if (p.achievements[key]) return;
  p.achievements[key] = Date.now();
  list.push(key);
  sfx("achievement");
}
async function finishRound(left = false): Promise<void> {
  const session = app.session;
  if (!session) { goHome(); return; }
  const summary = session.summary();
  unsub?.();
  unsub = null;
  app.session = null;
  app.tutorial = null;
  platform.clearSnapshot();
  audio.ambience(null);
  const p = platform.progress();
  const unlocked: string[] = [];
  p.totals.sessions++;
  p.totals.words += summary.wordsFound + summary.bonusFound;
  p.totals.bonus += summary.bonusFound;
  p.totals.invalid += summary.invalidCount;
  p.totals.playSec += Math.round(summary.elapsedSec);
  p.flowers += summary.wordsFound + summary.bonusFound;
  let stars = 0;
  let nextJourney: number | null = null;
  let nextLabel: string | null = null;
  let nextVars: Record<string, number> | null = null;
  let board: Board | null = null;
  let dailyBoard = false;
  const level = session.level;
  if (summary.completed) {
    unlock("first-bloom", unlocked);
    if (summary.mode === "learn") { p.tutorialDone = true; unlock("quick-study", unlocked); nextLabel = "startJourney"; nextJourney = 0; }
    if (summary.mode === "journey") {
      const idx = level.journeyIndex!;
      stars = 1 + (summary.score >= level.par ? 1 : 0) + (summary.hintsUsed === 0 ? 1 : 0);
      const prev = p.journey[idx];
      if (!prev || summary.score > prev.score) p.journey[idx] = { score: summary.score, stars, bestSec: Math.round(summary.elapsedSec), completedAt: Date.now() };
      else if (stars > prev.stars) prev.stars = stars;
      const next = idx + 1;
      if (next < C.journeyLevelCount()) { nextJourney = next; nextLabel = "stageN"; nextVars = { n: next + 1 }; }
      else { unlock("grove-master", unlocked); nextLabel = "dailyGrove"; }
    }
    if (summary.mode === "daily") {
      const today = todayISO();
      if (!p.dailyDays.includes(today)) p.dailyDays.push(today);
      p.lastDaily = today;
      if (p.dailyDays.length >= 7) unlock("streak-7", unlocked);
      board = recordScore("daily:" + today, summary);
      dailyBoard = platform.signedIn();
    }
    if (summary.mode === "challenge") {
      const cid = level.challenge!.id;
      const best = p.challengeBest[cid];
      if (!best || summary.score > best.score) p.challengeBest[cid] = { score: summary.score, sec: Math.round(summary.elapsedSec) };
      unlock("challenge-clear", unlocked);
      board = recordScore("challenge:" + cid, summary);
    }
    if (summary.mode === "chase") board = recordScore("chase:" + sessionSeedCode("chase:" + level.chaseSeed), summary);
    if (summary.mode === "practice") nextLabel = "playAgain";
  }
  if (!left && !summary.completed) nextLabel = "tryAgain";
  const m = p.mechanicsUsed;
  if (m.shuffle && m.hint && m.bonus && m.undo) unlock("mechanic-mastery", unlocked);
  if (p.totals.words >= 1000) unlock("thousand-words", unlocked);
  platform.save();
  audio.startMusic(false);
  if (left && summary.terminalReason === "abandoned" && summary.wordsFound === 0) { goHome(); return; }
  const replay = nextLabel === "playAgain" || nextLabel === "tryAgain";
  app.resultsNext = replay ? { replay: true } : { nextJourney, nextAction: nextLabel === "dailyGrove" ? "daily" : null };
  app.results = { summary, stars, achievements: unlocked, board, nextLabel, nextVars };
  app.lb = null;
  show("results");
  announce(T("resultsAnnounce", { headline: resultsHeadline(summary), score: summary.score }));
  // signed in, every finished round except Learn lessons (and rounds left early) posts its total
  if (platform.signedIn() && summary.mode !== "learn" && !left && summary.terminalReason !== "abandoned") {
    const r = app.results;
    app.lb = { key: "lbPosting" };
    void platform.postScore(summary.score).then((res) => {
      if (app.results !== r) return;
      app.lb = !res.posted ? { key: "lbNotPosted" } : res.rank ? { key: "lbRank", vars: { rank: res.rank } } : { key: "lbPosted" };
    });
  }
  if (dailyBoard) {
    const r = app.results;
    void platform.topEntries(10).then((entries) => { if (entries && app.results === r) r.board = { titleKey: "boardHigh", entries, casual: false }; });
  }
  if (unlocked.length) {
    const names = unlocked.map((k) => { const a = ACH().find((x) => x.key === k); return a ? TN("achievements", k, [a.name])[0] : null; }).filter(Boolean);
    announce(T("achievementsUnlocked", { list: names.join(", ") }));
  }
}
export function resultsHeadline(s: Summary): string {
  return s.completed ? T(["head1", "head2", "head3"][s.sessionId.length % 3]!)
    : T(({ "time-expired": "headTime", "out-of-moves": "headMoves", abandoned: "headLeft" } as Record<string, string>)[s.terminalReason ?? ""] || "headOver");
}
function recordScore(boardId: string, summary: Summary): Board {
  const p = platform.progress();
  const entry: platform.BoardEntry = {
    name: platform.displayName() || p.displayName, score: summary.score, completed: summary.completed, invalidCount: summary.invalidCount,
    elapsedSec: Math.round(summary.elapsedSec), sessionId: summary.sessionId, ruleset: summary.ruleset, contentVersion: summary.contentVersion, seed: summary.seed,
    assists: { hints: summary.hintsUsed, shuffles: summary.shufflesUsed }, durationSec: Math.round(summary.elapsedSec), ts: Date.now(), me: true,
  };
  const boards = platform.boards();
  const b = boards.boards[boardId] = boards.boards[boardId] || { entries: [] };
  b.entries = b.entries.filter((e) => e.sessionId !== entry.sessionId);
  b.entries.push(entry);
  b.entries.sort(compareResults);
  b.entries = b.entries.slice(0, 50);
  b.entries.forEach((e) => { e.me = e.sessionId === entry.sessionId; });
  platform.save();
  return { titleKey: "boardLocal", entries: b.entries, casual: true };
}
export function chaseBoard(): Board | null {
  if (!app.chaseSeed) return null;
  const b = platform.boards().boards["chase:" + sessionSeedCode("chase:" + app.chaseSeed)];
  return b ? { titleKey: "boardChase", entries: b.entries, casual: true } : null;
}
export function lbLine(): string | null { return app.lb ? S(app.lb.key, app.lb.vars) : null; }

// ------------------------------------------------------------------ the snapshot (main.js persistSnapshot)
function persistSnapshot(): void {
  const s = app.session;
  if (s && (s.state.status === "active" || s.state.status === "paused")) {
    const snap = s.snapshot();
    (snap as Record<string, unknown>).tutorial = app.tutorial;
    platform.saveSnapshot(snap);
  }
}
function maybeResumeSnapshot(): void {
  const snap = platform.loadSnapshot() as (ReturnType<Sess["snapshot"]> & { tutorial?: { step: number } | null }) | null;
  if (!snap || !snap.level) return;
  if (Date.now() - snap.savedAt > 86400000) { platform.clearSnapshot(); return; }
  try {
    const s = Session.restore(snap);
    if (s.state.status !== "active" && s.state.status !== "paused") { platform.clearSnapshot(); return; }
    enterRound(s, snap.level, {});
    app.tutorial = snap.tutorial ?? null;
    if (s.state.status === "active") s.pause();
    toast(T("roundRestored"));
    app.overlay = "pause";
  } catch (e) {
    console.warn(`snapshot restore failed: ${String(e)}`);
    platform.clearSnapshot();
  }
}

// ------------------------------------------------------------------ account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("inviteCopied")); } catch { toast(S("inviteFailed", { link })); }
}
export function editName(): void {
  if (platform.signedIn()) { toast(T("hostedName")); return; }
  app.nameText = playerLabel(platform.progress().displayName);
  openOverlay("name");
}
export function saveName(): void {
  const name = app.nameText.trim();
  if (name && name !== playerLabel("Gardener")) { platform.progress().displayName = name.slice(0, 20); platform.save(); }
  closeOverlay();
}
export function profileName(): string { return platform.displayName() || playerLabel(platform.progress().displayName); }

// ------------------------------------------------------------------ keys and pads (ui.js onKeyDown, pollGamepad)
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→" };
export function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}
export function firstKey(action: string): string { const k = keysFor(action).split("/")[0] ?? ""; return k === "Escape" ? "Esc" : k; }
const LETTER_ACTIONS = ["shuffle", "hint", "undo", "pause"];
let lastKeyCode = "";
let lastKeyFrame = -1;
function boundLetter(code: string): boolean {
  try { return LETTER_ACTIONS.some((a) => bindings(a).some((b) => b.device === "keyboard" && b.code === code)); } catch { return false; }
}
onKey((e) => {
  if (!e.pressed) return;
  lastKeyCode = e.code;
  lastKeyFrame = frame().frame;
  if (!active() || ui.capturingKeys()) return;
  const m = /^Key([A-Z])$/.exec(e.code);
  if (!m) return;
  // action shortcuts share keys with letters: they act while no word is being spelled, else the key types its letter
  if (!app.selection.length && boundLetter(e.code)) return;
  const lower = m[1]!.toLowerCase();
  const s = app.session!;
  const idx = s.state.letters.findIndex((l, i) => l === lower && !app.selection.includes(i));
  if (idx >= 0) later(() => { if (!active()) return; ui.setFocus(null); app.selection.push(idx); updateTutorial("select"); sfx("select"); syncSelection(); });
});
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  if (app.overlay) {
    if (e.action === "cancel" && fresh()) later(() => { if (app.overlay === "pause") resume(); else closeOverlay(); });
    return;
  }
  if (app.screen !== "game") {
    if (e.action === "cancel" && fresh() && (app.screen === "journey" || app.screen === "challenges" || app.screen === "chase")) later(goBack);
    return;
  }
  if (!active()) return;
  const kb = e.source === "keyboard";
  const letterKey = kb && lastKeyFrame === frame().frame && /^Key[A-Z]$/.test(lastKeyCode);
  if (letterKey && LETTER_ACTIONS.includes(e.action) && app.selection.length) return; // typed its letter instead
  const n = app.session!.state.letters.length;
  switch (e.action) {
    case "shuffle": later(doShuffle); break;
    case "hint": later(doHint); break;
    case "undo": later(doUndo); break;
    case "pause": later(pauseGame); break;
    case "delete_letter": later(removeLast); break;
    // Enter on a focused button presses it; with nothing focused it submits
    case "submit": if (!kb || ui.focused() == null) later(submitCurrent); break;
    case "cancel": later(() => { if (app.selection.length) clearSelection(true); else pauseGame(); }); break;
    case "next_letter": ui.setFocus(null); later(() => { app.cursor = (app.cursor + 1 + n) % n; }); break;
    case "prev_letter": ui.setFocus(null); later(() => { app.cursor = app.cursor < 0 ? n - 1 : (app.cursor - 1 + n) % n; }); break;
    case "pick": if (ui.focused() == null) later(() => { if (app.cursor < 0) app.cursor = 0; toggleTile(app.cursor); }); break;
  }
});

// ------------------------------------------------------------------ pointer and touch on the wheel (ui.js drag)
interface Press { id: number; tile: number; moved: boolean; began: boolean }
let press: Press | null = null;
let lastTouch = -1e9;
const queue: { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number; captured: boolean }[] = [];
onTouch((e) => {
  lastTouch = clockMs;
  if (e.control || !e.primary) return;
  const kind = e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel";
  queue.push({ kind, x: e.x, y: e.y, id: e.id, captured: kind === "down" && ui.pointerCaptured() });
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  queue.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1, captured: e.pressed && ui.pointerCaptured() });
});
onPointerMove((x, y) => { if (clockMs - lastTouch < 600) return; if (press) queue.push({ kind: "move", x, y, id: -1, captured: false }); });
/** The tile under a window point (ui.js hitTile: 46 logical px from a projected centre). */
export function hitTile(x: number, y: number): number | null {
  const r = 46 * ui.preferences().scale;
  let best: number | null = null, bestD = r * r;
  for (let i = 0; i < render.tileCount(); i++) {
    const c = render.projectTile(i);
    if (!c) continue;
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function pointerInput(wasActive: boolean): void {
  for (const ev of queue.splice(0)) {
    if (ev.kind === "down") {
      press = null;
      if (ev.captured || !wasActive || !active()) continue;
      const hit = hitTile(ev.x, ev.y);
      if (hit == null) continue;
      ui.setFocus(null);
      press = { id: ev.id, tile: hit, moved: false, began: false };
      app.cursor = -1;
      // a press on a tile starts a word (the token lifts at once) when nothing is spelled; with a word
      // spelled a tap appends or backtracks (as a key press did) and a drag starts a new word
      if (!app.selection.length) { press.began = true; beginSelection(hit); }
      continue;
    }
    if (!press || press.id !== ev.id) continue;
    if (ev.kind === "move") {
      const hit = hitTile(ev.x, ev.y);
      if (!press.moved && hit != null && hit !== press.tile) {
        press.moved = true;
        if (!press.began) beginSelection(press.tile);
      }
      if (press.moved) {
        if (hit != null) extendSelection(hit);
        syncSelection(render.screenToWheel(ev.x, ev.y));
      }
    } else if (ev.kind === "up") {
      const p = press;
      press = null;
      if (!active()) continue;
      if (!p.moved) { if (!p.began) toggleTile(p.tile); continue; }
      syncSelection();
      if (platform.options.submitOnRelease && currentWord().length >= 3) submitCurrent();
      else if (currentWord().length < 3) clearSelection();
    } else { press = null; clearSelection(); }
  }
}
export function dragging(): boolean { return !!press?.moved; }

// ------------------------------------------------------------------ the clock and lifecycle
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  const s = app.session;
  if (s && app.screen === "game") {
    s.advance(1000 / 60);
    if (s.state.status === "active" || s.state.status === "paused") {
      const found = Object.values(s.state.found).filter((f) => f.kind === "target").length;
      audio.intensity(found / Math.max(1, s.state.targets.length));
    }
  }
  runTimers();
});
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function textColor(): string {
  const pal = platform.options.palette;
  if (pal === "deuteranopia" || pal === "protanopia") return "#1a237e";
  if (pal === "tritanopia") return "#4a148c";
  return ui.preferences().highContrast ? "#000000" : "#2e2418";
}
function applyOptions(): void {
  render.setOptions({ reducedMotion: preferences().reducedMotion, sway: platform.options.cameraSway, textColor: textColor() });
}
let snapTimer = 0;
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  gen.warm();
  applyLook();
  render.setActive(true);
  render.resetGarden(platform.progress().selectedTheme);
  applyOptions();
  show("title");
  maybeResumeSnapshot();
});
onPreferencesChange(() => applyOptions());
platform.onOptionsChange(applyOptions);
platform.onProgressMerged(() => { if (!app.session) render.setTheme(platform.progress().selectedTheme); });
onSessionEnded(() => toast(S("signedOut")));
onSuspend(() => {
  hidden = true;
  // backgrounding pauses the solo round; the pause sheet is the way back
  if (app.session?.state.status === "active" && app.screen === "game") pauseGame();
  persistSnapshot();
  platform.flush();
});
onResume(() => { hidden = false; });
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  applyOptions();
  audio.update();
  app.toasts = app.toasts.filter((t) => t.until > clockMs);
  if (app.feedback && app.feedback.until <= clockMs) app.feedback = null;
  if (clockMs - snapTimer > 5000) { snapTimer = clockMs; persistSnapshot(); }
});
onRender(() => {
  const wasActive = active();
  const f = frame();
  render.frame(frameDt, f.width, f.height);
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasActive);
  flushAnnouncements();
});
export function preparingShown(): boolean { return !!app.preparing && clockMs - app.preparing.since > 300; }
export { legalActions };
