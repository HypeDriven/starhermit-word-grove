// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame over the grove: the title (logo, Play,
// the six mode cards, Theme / Settings / Help / Sign in / Invite, the
// gardener line with the cloud status), Journey (six groves of eight stage
// nodes), Challenges, Score chase (seed field, Play seed, New random seed,
// the chase board), the round (the HUD with Pause, mode and progress, timer,
// tries and score chips; the lesson bar; the crossword grid; the current
// word, feedback, the wheel buttons Shuffle / Hint / Undo / Clear / Submit
// and the bonus line; named targets over the wheel's letters for screen
// readers and play scripts), the results panel, the sheets (pause,
// settings, how to play, practice setup, gardener name), the "Growing the
// grove…" line and the toasts. The old media queries are layouts picked by
// the window's logical size; the phone-landscape layout is HUD rail |
// lesson + grid column | wheel, as before.
import { frame, openMenu } from "starhermit:engine";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { C, legalActions, totalScore } from "./game.ts";
import { S, T, TN, grove, player as playerLabel } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  advanceTutorial, app, chaseBoard, clearSelection, click, closeOverlay, currentWord, cycleTheme, doHint, doShuffle, doUndo, editName, fmtTime, fresh,
  goBack, goHome, invite, keysFor, firstKey, later, lbLine, leaveRound, modeLabel, nextJourneyIndex, nowMs, openOverlay, pauseGame, pauseTo,
  playPrimary, preparingShown, profileName, restartRound, resultsHeadline, resultsNext, resume, saveName, show, signIn, skipTutorial, startChallenge,
  startChase, startDaily, startJourney, startLearn, startPractice, submitCurrent, themeText, todayISO, type Board,
} from "./main.ts";

// ------------------------------------------------------------------ layout helpers
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; portrait: boolean; short: boolean; phone: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, ox: sa.left, oy: sa.top, portrait: lh >= lw, short: lh <= 500 && lw > lh, phone: lw < 600 };
}
function tw(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (tw(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; width?: number; height?: number;
  lines?: { text: string; cls: string }[]; content?: () => void; silent?: boolean;
}
const padX: Record<string, number> = { btn: 39.2, "btn-primary": 39.2, "btn-ghost": 39.2, "btn-ghost-light": 39.2, "btn-big": 99, "card-btn": 32.8, "wheel-btn": 4, "wheel-submit": 4, "btn-pause": 4, "link-btn": 0 };
function btnWidth(b: Btn): number { return Math.max(44, tw(b.text, b.style ?? "btn", "button") + 2); }
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const inner = (b.width ?? btnWidth(b)) - (padX[style] ?? 40) - 4;
  if (b.content) opts.content = b.content;
  else if (b.lines) { const lines = b.lines; opts.content = () => { for (const l of lines) para(l.text, inner, l.cls); }; }
  else if (b.width != null && btnWidth(b) > b.width) opts.content = () => { ui.style(style === "btn-primary" || style === "btn-big" ? "wrap-light" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  const name = b.name ?? (b.lines ? b.lines.map((l) => l.text).join(". ") : b.text);
  if (ui.style(style, s).id(b.id).button(name, opts) && fresh()) later(b.silent ? b.act : click(b.act));
}
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? btnWidth(b));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function gridOf<X>(label: string, items: X[], width: number, cols: number, gap: number, cell: (item: X, w: number, i: number) => void): void {
  const cw = (width - gap * (cols - 1)) / cols;
  ui.column(label, () => {
    for (let r = 0; r * cols < items.length; r++) {
      ui.row(`${label}-r${r}`, () => {
        for (let c = 0; c < cols && r * cols + c < items.length; c++) {
          const i = r * cols + c;
          ui.column(`${label}-c${i}`, () => cell(items[i]!, cw, i), { width: cw, align: "stretch" });
        }
      }, { spacing: gap, width, align: "stretch" });
    }
  }, { spacing: gap, width });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen === "game") game(L);
  else if (app.screen === "title") title(L);
  else if (app.screen === "results") results(L);
  else page(L);
  if (app.overlay) overlay(L);
  if (preparingShown()) {
    ui.place("thinking", { anchor: "center" }, () => ui.row("thinking-row", () => ui.style("toast-text").label(T("preparing")), { style: "toast" }));
  }
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen's scrolling column (the .screen sections), centred, at most `max` wide. */
function scroller(L: Layout, label: string, max: number, build: (w: number) => void, top = 12): void {
  const w = Math.min(max, L.lw - 32);
  ui.place(label, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.scrollArea(`${label}-scroll`, { width: L.lw, height: L.lh }, () => {
      ui.column(`${label}-col`, () => build(w), { width: L.lw, align: "center", spacing: 14, padding: { top, bottom: 30 } });
    }, app.openedFrame + 6 > frame().frame ? { scrollTo: { top: 0 } } : undefined);
  });
}

// ------------------------------------------------------------------ title (index.html #screen-title)
function title(L: Layout): void {
  const p = platform.progress();
  const nextIdx = nextJourneyIndex();
  const done = nextIdx >= C.journeyLevelCount();
  const g = Math.floor(nextIdx / 8);
  const compact = L.short || L.lw < 420;
  scroller(L, "title", 680, (w) => {
    ui.column("hero", () => {
      ui.row("logo", () => {
        ui.style(compact ? "logo-s" : "logo").label("Word ");
        ui.style(compact ? "logo-gold-s" : "logo-gold").label("Grove");
      }, { align: "end" });
      ui.style("tagline").label(T("tagline"));
    }, { align: "center", spacing: 2 });
    button({ id: "btn-play", style: "btn-big", text: done ? T("playDaily") : nextIdx === 0 && !p.tutorialDone ? T("learnAndPlay") : T("continueJourney"), act: playPrimary });
    const cards = [
      { id: "btn-daily", t: T("daily"), s: p.lastDaily === todayISO() ? T("doneToday") : T("dailySub"), act: startDaily },
      { id: "btn-journey", t: T("journey"), s: done ? T("allGrovesDone") : T("groveStage", { grove: grove(g, C.groveInfo(g).name), n: (nextIdx % 8) + 1 }), act: () => show("journey") },
      { id: "btn-practice", t: T("practice"), s: T("practiceSub"), act: () => openOverlay("setup") },
      { id: "btn-challenge", t: T("challenge"), s: T("challengeSub"), act: () => show("challenges") },
      { id: "btn-chase", t: T("scoreChase"), s: T("chaseSub"), act: () => { show("chase"); app.focusNext = "chase-seed"; } },
      { id: "btn-learn", t: T("learn"), s: p.tutorialDone ? T("replayLessons") : T("startHere"), act: startLearn },
    ];
    const gw = Math.min(620, w);
    const cols = gw >= 470 || L.short ? 3 : 2;
    gridOf("title-grid", cards, gw, cols, 10, (c, cw) => button({ id: c.id, style: "card-btn", text: c.t, width: cw, act: c.act, lines: [{ text: c.t, cls: "card-title" }, { text: c.s, cls: "card-sub" }] }));
    const foot: Btn[] = [
      { id: "btn-theme", style: "btn-ghost-light", text: `${T("themeLabel")} ${themeText(p.selectedTheme)}`, act: cycleTheme },
      { id: "btn-settings", style: "btn-ghost-light", text: T("settings"), act: () => openOverlay("settings") },
      { id: "btn-help", style: "btn-ghost-light", text: T("help"), act: () => openOverlay("help") },
    ];
    if (!platform.signedIn()) foot.push({ id: "btn-signin", style: "btn-ghost-light", text: S("signIn"), act: signIn });
    if (platform.inviteLink()) foot.push({ id: "btn-invite", style: "btn-ghost-light", text: S("invite"), act: invite });
    flow("title-footer", foot, w, 6);
    const sync = platform.syncState();
    ui.row("profile-line", () => {
      ui.style("light-dim").label(T("gardenerLabel"));
      button({ id: "btn-profile-name", style: "link-btn", text: profileName(), act: editName });
      ui.style("light-dim").label(`· ${p.flowers} ${T("bloomsLabel")}`);
      if (sync !== "local") ui.style("light-dim").label(T(sync === "saving" ? "syncSaving" : sync === "offline" ? "syncError" : "syncSynced"));
    }, { spacing: 6, align: "center" });
  }, L.short ? 8 : Math.max(12, L.lh * 0.12));
}

// ------------------------------------------------------------------ Journey, Challenges, Score chase
function head(label: string, text: string, w: number): void {
  ui.row(label, () => {
    button({ id: "btn-back", style: "btn", text: T("back"), act: goBack });
    ui.style("h2-light").label(text);
  }, { spacing: 12, width: w, align: "center" });
}
function page(L: Layout): void {
  if (app.screen === "journey") scroller(L, "journey", 680, (w) => journey(w));
  else if (app.screen === "challenges") scroller(L, "challenges", 680, (w) => challenges(w));
  else if (app.screen === "chase") scroller(L, "chase", 460, (w) => chase(w));
}
function journey(w: number): void {
  head("journey-head", T("journey"), w);
  const nextIdx = nextJourneyIndex();
  const p = platform.progress();
  for (const g of C.groves()) {
    ui.column(`grove-${g.index}`, () => {
      const done = Object.keys(p.journey).filter((i) => Math.floor(Number(i) / 8) === g.index).length;
      ui.row(`grove-h-${g.index}`, () => {
        ui.style("h3").label(grove(g.index, g.name));
        ui.spacer();
        ui.style("h3-small").label(T("groveDone", { done, theme: themeText(g.theme) }));
      }, { width: w - 28, align: "center" });
      const gap = 8;
      const nw = Math.min(56, Math.floor((w - 28 - gap * 7) / 8));
      ui.row(`grove-n-${g.index}`, () => {
        for (let s = 0; s < 8; s++) {
          const idx = g.index * 8 + s;
          const rec = p.journey[idx];
          const locked = idx > nextIdx;
          const cls = idx === nextIdx ? "node-current" : s === 7 ? "node-mastery" : "node";
          const name = T("stageN", { n: idx + 1 }) + (s === 7 ? T("masteryTag") : "") + (rec ? T("starsTag", { n: rec.stars }) : "") + (locked ? T("lockedTag") : "");
          const stars = rec ? "★".repeat(rec.stars) : s === 7 ? "✦" : "";
          button({
            id: `stage-${idx}`, style: cls, text: String(idx + 1), name, width: nw, height: nw, disabled: locked, act: () => startJourney(idx),
            content: () => ui.column(`sn-${idx}`, () => { ui.style("node-num").label(String(idx + 1)); if (stars) ui.style("node-stars").label(stars); }, { align: "center", spacing: 0 }),
          });
        }
      }, { spacing: gap, width: w - 28 });
    }, { style: "card", width: w, spacing: 8 });
  }
}
function challenges(w: number): void {
  head("ch-head", T("challengesH"), w);
  const p = platform.progress();
  for (const c of C.CHALLENGES) {
    const [label, desc] = TN("challenges", c.id, [c.label, c.desc]);
    const best = p.challengeBest[c.id];
    ui.row(`ch-${c.id}`, () => {
      const bw = Math.max(64, tw(T("play"), "btn-primary", "button") + 4);
      const inner = w - 32 - bw - 12 - (best ? 80 : 0);
      ui.column(`ch-t-${c.id}`, () => { para(label!, inner, "text-b"); para(desc!, inner, "dim"); }, { width: inner, spacing: 2 });
      if (best) ui.style("best").label(T("bestN", { n: best.score }));
      button({ id: `play-${c.id}`, style: "btn-primary", text: T("play"), name: `${T("play")} ${label}`, act: () => startChallenge(c.id) });
    }, { style: "card", width: w, spacing: 12, align: "center" });
  }
}
function chase(w: number): void {
  head("chase-head", T("scoreChase"), w);
  ui.column("chase-panel", () => {
    const inner = w - 44;
    para(T("chaseText"), inner, "text");
    ui.style("text-b").label(T("seedCode"));
    const v = ui.style("field").id("chase-seed").textField("chase-seed", app.chaseText, { width: inner, maxChars: 24, placeholder: T("seedPlaceholder") });
    if (v !== app.chaseText) app.chaseText = v;
    const play = (): void => { const s = app.chaseText.trim(); if (s) startChase(s); };
    if (ui.submitted(T("seedCode")) || ui.submitted("chase-seed")) later(play);
    button({ id: "btn-chase-play", style: "btn-primary", text: T("playSeed"), act: play, disabled: !app.chaseText.trim() });
    button({ id: "btn-chase-random", style: "btn", text: T("newSeed"), act: () => startChase(null) });
    const b = chaseBoard();
    if (b) boardView("chase-board", b, inner);
  }, { style: "panel", width: w, spacing: 10 });
}

// ------------------------------------------------------------------ the round (index.html #screen-game)
function cellSize(L: Layout, cols: number, rows: number): number {
  const avail = Math.min(L.lw * 0.92, L.lh * (L.lh < 500 ? 0.5 : 0.42), 520);
  return Math.max(16, Math.min(44, Math.floor(avail / Math.max(cols, rows)) - 4));
}
function game(L: Layout): void {
  const s = app.session;
  if (!s) return;
  const st = s.state;
  const leg = legalActions(st);
  const sc = L.sc;
  const found = Object.values(st.found).filter((f) => f.kind === "target").length;
  const landscape = L.short;
  const side = 12;
  // ---- HUD
  const mode = modeLabel(s.level).toUpperCase();
  const progress = T("wordsProgress", { found, total: st.targets.length });
  let timerText = "", timerWarn = false;
  if (platform.options.showTimer) {
    let sec: number;
    if (leg.timeRemainingSec !== null) { sec = leg.timeRemainingSec; timerWarn = sec <= 30 && st.status === "active"; } else sec = s.elapsedSec();
    timerText = fmtTime(sec);
  }
  const moves = leg.movesRemaining !== null ? T("tries", { n: leg.movesRemaining }) : "";
  const chip = (id: string, text: string, warn: boolean, bold = false): void => {
    ui.row(id, () => ui.style(warn ? "chip-warn-text" : bold ? "chip-text-b" : "chip-text").label(text), { style: warn ? "chip-warn" : "chip", align: "center" });
  };
  const pauseBtn = (): void => button({ id: "btn-pause", style: "btn-pause", text: "II", name: T("pause"), act: pauseGame, width: 44, height: 44,
    content: () => ui.style("btn-label-c").label("II") });
  const chips = (): void => {
    if (timerText) chip("hud-timer", timerText, timerWarn);
    if (moves) chip("hud-moves", moves, (leg.movesRemaining ?? 9) <= 2);
    chip("hud-score", String(totalScore(st)), false, true);
  };
  let hudBottom = 0;
  let leftEdge = 0;
  const hudW = landscape ? Math.min(170, L.lw * 0.22) : L.lw - 2 * side;
  if (landscape) {
    const r = ui.place("hud", { anchor: "top-start", x: side, y: 8 }, () => ui.column("hud-col", () => {
      pauseBtn();
      para(mode, hudW, "hud-mode");
      ui.style("hud-progress").label(progress);
      ui.column("hud-chips", chips, { spacing: 6 });
    }, { spacing: 6, width: hudW }));
    leftEdge = r.x + r.width;
  } else {
    const r = ui.place("hud", { anchor: "top-start", x: side, y: 8 }, () => ui.row("hud-row", () => {
      pauseBtn();
      const chipsW = (timerText ? tw(timerText, "chip-text") + 28 : 0) + (moves ? tw(moves, "chip-text") + 28 : 0) + tw(String(totalScore(st)), "chip-text-b") + 28 + 16;
      const objW = Math.max(60, hudW - 44 - 16 - chipsW);
      ui.column("hud-obj", () => { para(mode, objW, "hud-mode"); ui.style("hud-progress").label(progress); }, { width: objW, spacing: 0 });
      ui.row("hud-chips", chips, { spacing: 8, align: "center" });
    }, { spacing: 8, width: hudW, align: "center" }));
    hudBottom = r.y + r.height;
  }
  // ---- the lesson bar and the crossword grid
  const model = s.gridModel();
  const cell = cellSize(L, model.width, model.height);
  const gap = cell < 26 ? 3 : 4;
  const gridW = model.width * cell + (model.width - 1) * gap + 20;
  const gridH = model.height * cell + (model.height - 1) * gap + 20;
  const colX = landscape ? leftEdge / sc + 12 : 0;
  const colW = landscape ? Math.min(Math.max(gridW, 280), L.lw * 0.42) : Math.min(560, L.lw - 2 * side);
  const tu = app.tutorial;
  const stack = ui.place("stack", landscape ? { anchor: "top-start", x: colX * sc / sc, y: 8 } : { anchor: "top", y: hudBottom / sc + 8 }, () => ui.column("stack-col", () => {
    if (tu) tutorialBar(tu.step, colW, landscape);
    gridView(model, cell, gap, gridW, gridH);
  }, { spacing: 8, width: colW, align: landscape ? "start" : "center" }));
  // ---- the wheel's tray and controls (bottom)
  const word = currentWord().toUpperCase();
  const fb = app.feedback;
  const bonusFound = Object.values(st.found).filter((f) => f.kind === "bonus").length;
  const bonus = bonusFound ? (bonusFound === 1 ? T("bonusLineOne", { left: s.remainingBonus() }) : T("bonusLineN", { n: bonusFound, left: s.remainingBonus() })) : "";
  const shake = !render && app.shakeUntil > nowMs() ? 0 : 0;
  void shake;
  const ctrls: Btn[] = [
    { id: "btn-shuffle", style: "wheel-btn", text: "⟳", name: `${T("whatShuffle")} (${keysFor("shuffle")})`, act: () => { ui.setFocus(null); doShuffle(); }, disabled: !leg.canShuffle, width: 52, height: 52,
      content: () => wheelFace("⟳", firstKey("shuffle"), false) },
    { id: "btn-hint", style: "wheel-btn", text: "💡", name: `${T("whatHint")} (${keysFor("hint")})`, act: () => { ui.setFocus(null); doHint(); }, disabled: !leg.canHint, width: 52, height: 52,
      content: () => wheelFace("💡", firstKey("hint"), false) },
  ];
  if (st.constraints.allowUndo) ctrls.push({ id: "btn-undo", style: "wheel-btn", text: "↩", name: `${T("whatUndo")} (${keysFor("undo")})`, act: () => { ui.setFocus(null); doUndo(); }, disabled: !leg.canUndo, width: 52, height: 52,
    content: () => wheelFace("↩", firstKey("undo"), false) });
  ctrls.push({ id: "btn-clear", style: "wheel-btn", text: "✕", name: `${T("whatClear")} (${keysFor("cancel")})`, act: () => { ui.setFocus(null); clearSelection(true); }, width: 52, height: 52,
    content: () => wheelFace("✕", firstKey("cancel"), false) });
  ctrls.push({ id: "btn-submit", style: "wheel-submit", text: "✓", name: `${T("whatSubmit")} (${keysFor("submit")})`, act: () => { ui.setFocus(null); submitCurrent(); }, disabled: !leg.canSubmit, width: 52, height: 52,
    content: () => wheelFace("✓", "⏎", true) });
  if (platform.options.leftHanded) ctrls.reverse();
  const wheelX = landscape ? (stack.x + stack.width) / sc : 0;
  const wheelW = L.lw - wheelX;
  const tray = ui.place("tray", landscape ? { anchor: "bottom-start", x: wheelX, y: 6 } : { anchor: "bottom", y: 6 }, () => ui.column("tray-col", () => {
    const shaking = app.shakeUntil > nowMs() && !ui.preferences().reducedMotion;
    ui.row("current-row", () => ui.style(word ? "current-word" : "current-empty").id("current-word").label(word || "···"), { width: wheelW, justify: "center", padding: shaking ? { start: 12 } : undefined });
    ui.row("feedback-row", () => ui.style(fb ? (fb.kind === "good" ? "feedback-good" : "feedback-error") : "feedback").label(fb ? fb.text : " "), { width: wheelW, justify: "center" });
    ui.row("wheel-controls", () => { for (const b of ctrls) button(b); }, { spacing: 10, justify: "center", width: wheelW });
    if (bonus) para(bonus, wheelW - 24, "bonus-line");
  }, { spacing: 4, width: wheelW, align: "center" }));
  // ---- the band the wheel is framed in (ui.js syncSafeBand): below the HUD / lesson / grid, above the controls
  const topPx = landscape ? 0 : stack.y + stack.height;
  const controlsTop = tray.y + tray.height - (52 + 4 + (bonus ? 20 : 0)) * sc;
  render.setSafeBand(topPx, frame().height - controlsTop + 12 * sc, landscape ? stack.x + stack.width : 0, 0);
  // ---- named targets over the wheel's letters (the old wheel-tile buttons' accessibility layer)
  const n = render.tileCount();
  for (let i = 0; i < n; i++) {
    const c = render.projectTile(i);
    if (!c) continue;
    const r = 30 * sc;
    const letter = (st.letters[i] ?? "").toUpperCase();
    const sel = app.selection.includes(i) ? " ✓" : "";
    ui.target(`${T("letterAria", { letter })}${sel}`, { x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r }, { role: "button" });
    if (app.cursor === i && !app.overlay) draw.strokeCircle(c.x, c.y, 34 * sc, "#ffb400", 3);
  }
}
function wheelFace(glyph: string, key: string, light: boolean): void {
  ui.column("wf", () => {
    ui.style(light ? "glyph-light" : "glyph").label(glyph);
    if (key) ui.style(light ? "kbd-light" : "kbd").label(key);
  }, { align: "center", spacing: 0 });
}
function tutorialBar(step: number, w: number, landscape: boolean): void {
  const stp = C.TUTORIAL_STEPS[step];
  if (!stp) return;
  const [ttl, body] = TN("tutorial", stp.id, [stp.title, stp.body]);
  const nextText = stp.waitFor ? T("waitingForYou") : step === C.TUTORIAL_STEPS.length - 1 ? T("playBang") : T("next");
  ui.column("tutorial-bar", () => {
    const inner = w - 28;
    para(T("stepTitle", { n: step + 1, total: C.TUTORIAL_STEPS.length, title: ttl! }), inner, "text-b", "tutorial-title");
    para(body!, inner, "dim", "tutorial-body");
    flow("tutorial-btns", [
      { id: "tutorial-next", style: "btn-primary", text: nextText, disabled: !!stp.waitFor, act: () => { ui.setFocus(null); advanceTutorial(); } },
      { id: "tutorial-skip", style: "btn-ghost", text: T("skipTutorial"), act: () => { ui.setFocus(null); skipTutorial(); } },
    ], inner, 10, landscape ? "start" : "start");
  }, { style: "tutorial", width: w, spacing: 4 });
}
function gridView(model: ReturnType<NonNullable<typeof app.session>["gridModel"]>, cell: number, gap: number, w: number, h: number): void {
  const s = app.session!;
  const flashing = app.flash.until > nowMs();
  const cells = [...model.cells.values()];
  const reveal = cells.filter((c) => c.revealed).length;
  ui.widget(T("gridAria") + `: ${reveal}/${cells.length}`, {
    role: "image", size: { width: w, height: h },
    draw: (rect, state) => {
      const k = state.scale;
      draw.box(rect.x, rect.y, rect.width, rect.height, "grid-wrap");
      for (const c of cells) {
        const x = rect.x + (10 + c.x * (cell + gap)) * k, y = rect.y + (10 + c.y * (cell + gap)) * k;
        const foundWord = c.words.some((pi) => s.state.found[model.placements[pi]!.word]);
        const cls = !c.revealed ? "cell-hidden" : flashing && app.flash.cells.has(`${c.x},${c.y}`) ? "cell-flash" : foundWord ? "cell-revealed" : "cell-hinted";
        draw.box(x, y, cell * k, cell * k, cls);
        if (c.revealed) {
          const fs = Math.max(10, cell * 0.5) * k;
          draw.text(c.letter.toUpperCase(), x + (cell * k) / 2, y + (cell * k - fs) / 2, { size: fs, font: "serif", weight: "bold", align: "center", color: state.highContrast ? "#000000" : foundWord ? "#24301f" : "#4a5a42" });
        }
      }
    },
  });
}

// ------------------------------------------------------------------ results (index.html #screen-results)
function results(L: Layout): void {
  const r = app.results;
  if (!r) return;
  const sm = r.summary;
  scroller(L, "results", 520, (w) => {
    ui.column("results-panel", () => {
      const inner = w - 44;
      ui.row("rh", () => para(resultsHeadline(sm), inner, "h2", "results-headline"), { width: inner, justify: "center" });
      ui.row("rs", () => para(sm.completed ? T("resultsDone", { words: sm.wordsFound, bonus: sm.bonusFound, time: fmtTime(sm.elapsedSec) })
        : T("resultsPartial", { found: sm.wordsFound, total: sm.totalTargets }), inner, "dim"), { width: inner, justify: "center" });
      if (sm.mode === "journey" && sm.completed) ui.row("stars", () => ui.style("stars").label("★".repeat(r.stars) + "☆".repeat(3 - r.stars)), { width: inner, justify: "center" });
      const tw2 = Math.min(340, inner);
      ui.column("breakdown", () => {
        for (const row of sm.breakdown) {
          ui.row(`bd-${row.key}`, () => {
            ui.style("td").label(T("row_" + row.key));
            ui.spacer();
            ui.style(row.value < 0 ? "td-neg" : "td-num").label(`${row.value > 0 ? "+" : ""}${row.value}`);
          }, { width: tw2 });
        }
        ui.row("bd-total", () => { ui.style("td-total").label(T("total")); ui.spacer(); ui.style("td-total").id("results-total").label(String(sm.score)); }, { width: tw2, style: "row-line" });
      }, { width: tw2, spacing: 4 });
      if (r.achievements.length) {
        ui.row("achievements", () => {
          for (const key of r.achievements) {
            const def = C.ACHIEVEMENTS.find((a) => a.key === key);
            if (!def) continue;
            const [name] = TN("achievements", key, [def.name, def.desc]);
            ui.row(`ach-${key}`, () => ui.style("ach-text").label(`🏆 ${name}`), { style: "ach-chip" });
          }
        }, { spacing: 8, justify: "center", width: inner });
      }
      const lb = lbLine();
      if (lb) ui.row("results-lb", () => para(lb, inner, "dim"), { width: inner, justify: "center" });
      if (r.board) boardView("results-board", r.board, inner);
      const btns: Btn[] = [];
      if (r.nextLabel) btns.push({ id: "btn-results-next", style: "btn-primary", text: T(r.nextLabel, r.nextVars ?? undefined), act: resultsNext });
      btns.push({ id: "btn-results-retry", style: "btn", text: T("retry"), act: restartRound });
      btns.push({ id: "btn-results-home", style: "btn-ghost", text: T("home"), act: goHome });
      flow("results-actions", btns, inner, 10);
    }, { style: "panel", width: w, spacing: 10, align: "center" });
  }, 12);
  if (!r.nextLabel && app.focusNext === "btn-results-next") app.focusNext = "btn-results-retry";
}
function boardView(label: string, b: Board, w: number): void {
  ui.column(label, () => {
    ui.style("text-b").label(T(b.titleKey || "boardLocal"));
    if (!b.entries.length) { para(T("noEntries"), w, "fine"); return; }
    const cols = [28, w - 28 - 70 - 70, 70, 70];
    const rowOf = (id: string, cells: string[], cls: string, me = false): void => {
      ui.row(id, () => cells.forEach((c, i) => ui.row(`${id}-${i}`, () => ui.style(cls).label(c), { width: cols[i]!, justify: i === 3 ? "end" : "start" })), { width: w, style: me ? "row-me" : undefined });
    };
    rowOf(`${label}-h`, ["#", T("colGardener"), T("colTime"), T("colScore")], "bd-h");
    b.entries.slice(0, 10).forEach((e, i) => rowOf(`${label}-${i}`, [String(i + 1), playerLabel(e.name), e.elapsedSec != null ? fmtTime(e.elapsedSec) : "—", String(e.score)], e.me ? "bd-me" : "bd", !!e.me));
    if (b.casual) para(T("casualNote"), w, "fine");
  }, { width: w, spacing: 3 });
}

// ------------------------------------------------------------------ sheets (index.html .overlay)
function overlay(L: Layout): void {
  const o = app.overlay!;
  const w = Math.min(o === "help" ? 640 : 560, L.lw - 24);
  const maxH = L.lh - 24;
  let closed = false;
  ui.style("panel").dialog(`overlay-${o}`, "", true, () => {
    const inner = w - 44;
    const scroll = (build: () => void, h: number): void => {
      ui.scrollArea(`${o}-scroll`, { width: inner + 12, height: Math.max(80, h) }, () => ui.column(`${o}-body`, build, { width: inner, spacing: 8 }),
        app.openedFrame + 6 > frame().frame ? { scrollTo: { top: 0 } } : undefined);
    };
    if (o === "pause") {
      ui.style("h2").label(T("paused"));
      const list: [string, string, string, () => void][] = [
        ["overlay-first", "btn-primary", T("resume"), resume],
        ["btn-pause-settings", "btn", T("settings"), () => pauseTo("settings")],
        ["btn-pause-help", "btn", T("help"), () => pauseTo("help")],
        ["btn-restart-level", "btn", T("restartLevel"), () => { app.overlay = null; restartRound(); }],
        ["btn-leave", "btn-ghost", T("leaveRound"), leaveRound],
      ];
      for (const [id, st, text, act] of list) button({ id, style: st, text, act, width: inner });
    } else if (o === "settings") {
      ui.style("h2").label(T("settings"));
      scroll(() => settingsBody(inner), Math.min(520, maxH - 150));
      button({ id: "btn-settings-close", style: "btn-primary", text: T("done"), act: closeOverlay, width: inner });
    } else if (o === "help") {
      ui.style("h2").label(T("howToPlay"));
      scroll(() => {
        const rules: [string, string][] = [["ruleConnect", "ruleConnectText"], ["ruleFill", "ruleFillText"], ["ruleBonus", "ruleBonusText"],
          ["ruleShuffle", "ruleShuffleText"], ["ruleScoring", "ruleScoringText"], ["ruleFair", "ruleFairText"]];
        gridOf("help-cards", rules, inner, inner >= 460 ? 2 : 1, 10, ([h, p], cw) => ui.column(`rc-${h}`, () => {
          para(T(h), cw - 28, "text-b");
          para(T(p), cw - 28, "dim");
        }, { style: "rule-card", width: cw, spacing: 4 }));
        para(keyHelp(), inner, "fine", "help-keys");
        para(T("gamepadHelp"), inner, "fine");
      }, Math.min(560, maxH - 150));
      button({ id: "overlay-first", style: "btn-primary", text: T("close"), act: closeOverlay, width: inner });
    } else if (o === "setup") {
      ui.style("h2").label(T("practice"));
      para(T("practiceText"), inner, "text");
      for (const d of C.PRACTICE_DIFFICULTIES) {
        const [label, note] = TN("difficulties", d.id, [d.label, d.note]);
        const on = app.practiceDiff === d.id;
        button({ id: d.id === "easy" ? "overlay-first-x" : `diff-${d.id}`, style: on ? "btn-primary" : "btn", text: `${label} — ${note}`, name: `${label} — ${note}`, width: inner, act: () => { app.practiceDiff = d.id; } });
      }
      flow("setup-actions", [
        { id: "overlay-first", style: "btn-primary", text: T("start"), act: () => { app.overlay = null; startPractice(app.practiceDiff); } },
        { id: "btn-setup-cancel", style: "btn-ghost", text: T("cancel"), act: closeOverlay },
      ], inner, 10);
    } else if (o === "name") {
      para(T("promptName"), inner, "text-b");
      const v = ui.style("field").id("overlay-first").textField("name-field", app.nameText, { width: inner, maxChars: 20 });
      if (v !== app.nameText) app.nameText = v;
      if (ui.submitted(T("promptName")) || ui.submitted("name-field")) later(saveName);
      flow("name-actions", [
        { id: "btn-name-save", style: "btn-primary", text: T("save"), act: saveName },
        { id: "btn-name-cancel", style: "btn-ghost", text: T("cancel"), act: closeOverlay },
      ], inner, 10);
    }
    if (ui.back() && fresh()) closed = true;
  });
  if (closed) later(() => { if (app.overlay === "pause") resume(); else closeOverlay(); });
}
function check(id: string, label: string, on: boolean, set: (v: boolean) => void, w: number): void {
  ui.row(id, () => {
    if (ui.id(id + "-box").checkbox(label, on) !== on && fresh()) later(() => set(!on));
  }, { width: w });
}
function settingsBody(w: number): void {
  const o = platform.options;
  const set = <K extends keyof platform.Options>(k: K) => (v: platform.Options[K]): void => platform.setOption(k, v);
  ui.column("set-runtime", () => {
    ui.style("text-b").label(T("audio"));
    button({ id: "overlay-first", style: "btn", text: T("moreOptions"), act: () => openMenu(), width: w - 28 });
    check("set-captions", T("captions"), o.captions, set("captions"), w - 28);
  }, { style: "fieldset", width: w, spacing: 6 });
  ui.column("set-gfx", () => {
    check("set-camera-sway", T("cameraSway"), o.cameraSway, set("cameraSway"), w - 28);
    check("set-timer", T("showTimer"), o.showTimer, set("showTimer"), w - 28);
  }, { style: "fieldset", width: w, spacing: 6 });
  ui.column("set-a11y", () => {
    ui.style("text-b").label(T("accessibility"));
    const pals: platform.Palette[] = ["default", "deuteranopia", "protanopia", "tritanopia"];
    const names = [T("palDefault"), T("palDeut"), T("palProt"), T("palTrit")];
    ui.row("pal-row", () => {
      ui.style("text").label(T("colorPalette"));
      ui.spacer();
      const i = ui.id("set-palette").select(T("colorPalette"), Math.max(0, pals.indexOf(o.palette)), names);
      if (pals[i] !== o.palette && fresh()) later(() => platform.setOption("palette", pals[i]!));
    }, { width: w - 28, align: "center" });
    check("set-left-handed", T("leftHanded"), o.leftHanded, set("leftHanded"), w - 28);
    check("set-submit-release", T("submitRelease"), o.submitOnRelease, set("submitOnRelease"), w - 28);
    check("set-haptics", T("haptics"), o.haptics, set("haptics"), w - 28);
  }, { style: "fieldset", width: w, spacing: 6 });
  ui.column("set-game", () => {
    ui.style("text-b").label(T("game"));
    button({ id: "btn-replay-tutorial", style: "btn", text: T("replayTutorial"), act: () => { app.overlay = null; startLearn(); } });
    para(keyHelp(), w - 28, "fine");
    para(T("gamepadHelp"), w - 28, "fine");
  }, { style: "fieldset", width: w, spacing: 6 });
}
function keyHelp(): string {
  return T("keysHelp", {
    submit: keysFor("submit"), remove: keysFor("delete_letter"), shuffle: keysFor("shuffle"), hint: keysFor("hint"), undo: keysFor("undo"),
    pause: keysFor("pause"), cancel: keysFor("cancel"),
  });
}

// ------------------------------------------------------------------ toasts
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const w = Math.min(520, L.lw * 0.92);
  ui.place("toasts", { anchor: "top", y: 60 }, () => ui.column("toast-col", () => {
    app.toasts.forEach((t, i) => ui.row(`toast-${i}`, () => para(t.text, w - 40, "toast-text"), { style: t.gold ? "toast-gold" : "toast" }));
  }, { spacing: 8, align: "center" }));
}
