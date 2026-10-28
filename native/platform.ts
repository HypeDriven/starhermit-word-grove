// The game's data and the StarHermit platform on the runtime's modules (what
// js/platform.js and js/storage.js did over the JS SDK and localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the browser build's cloud document
//   { progress, boards } (js/storage.js progress and local boards); two
//   devices' saves merge on a conflict with mergeProgress / mergeBoards, as
//   the browser build merged after a refused write; the slot the browser
//   build wrote through the JS SDK (game:<slug>, the same document as JSON)
//   shows as foreign: it is merged in and replaced once;
// - the interrupted-round snapshot stays on the device (starhermit:storage
//   `storage`), as it stayed in localStorage;
// - the game's own options (camera sway, timer, submit on release,
//   left-handed controls, colour palette, haptics, captions) are engine
//   `settings` (synced with the account); the browser build's values in the
//   account's settings KV (main.js SYNCED_SETTINGS) are adopted unless set
//   here since, then its KV keys are removed (volumes, mute, graphics,
//   reduced motion, high contrast and text size are the runtime's Options);
// - the player, the invite link, the platform clock for the Daily, the
//   read-only high-score board, and posting a finished round's total through
//   score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the rank.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { DEFAULT_PROGRESS, DEFAULT_BOARDS, mergeProgress, mergeBoards } from "../js/storage.js";

export interface JourneyRec { score: number; stars: number; bestSec?: number; completedAt?: number }
export interface Progress {
  version: number; displayName: string; tutorialDone: boolean; journey: Record<string, JourneyRec>; flowers: number;
  totals: { words: number; bonus: number; invalid: number; sessions: number; playSec: number };
  mechanicsUsed: Record<string, boolean>; achievements: Record<string, number>; dailyDays: string[]; lastDaily: string | null;
  challengeBest: Record<string, { score: number; sec: number }>; selectedTheme: string; updatedAt: number;
}
export interface BoardEntry {
  name: string; score: number; completed: boolean; invalidCount: number; elapsedSec: number; sessionId: string; me?: boolean;
  [k: string]: unknown;
}
export interface Boards { version: number; boards: Record<string, { entries: BoardEntry[] }> }
interface Doc { progress: Progress; boards: Boards }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const mergeP = mergeProgress as unknown as (r: Progress | null, l: Progress | null) => Progress;
const mergeB = mergeBoards as unknown as (r: Boards | null, l: Boards | null) => Boards;
const fresh = (): Doc => ({ progress: clone(DEFAULT_PROGRESS as unknown as Progress), boards: clone(DEFAULT_BOARDS as unknown as Boards) });

// --- the save --------------------------------------------------------------------------------
let data: Doc = fresh();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** A stored document (this build's or the browser build's), filled with defaults. */
export function readDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Doc>;
  const base = fresh();
  const progress = r.progress && typeof r.progress === "object" ? { ...base.progress, ...clone(r.progress) } : base.progress;
  const boards = r.boards && typeof r.boards === "object" && r.boards.boards ? { ...base.boards, ...clone(r.boards) } : base.boards;
  return { progress, boards };
}
/** Both sides kept (js/storage.js mergeProgress / mergeBoards; `local` wins the device-owned fields). */
export function mergeDocs(remote: Doc | null, local: Doc | null): Doc {
  if (!remote) return local ?? fresh();
  if (!local) return remote;
  return { progress: mergeP(remote.progress, local.progress), boards: mergeB(remote.boards, local.boards) };
}
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
/** Same progress (ignoring updatedAt and key order). */
export function sameDoc(a: Doc, b: Doc): boolean {
  return canon({ ...a, progress: { ...a.progress, updatedAt: 0 } }) === canon({ ...b, progress: { ...b.progress, updatedAt: 0 } });
}

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(data as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
function adopt(other: Doc | null): boolean {
  if (!other) return false;
  const next = mergeDocs(other, data);
  if (sameDoc(next, data)) return false;
  data = next;
  return true;
}
saves.onConflict((mine, remote) => ({
  merged: mergeDocs(readDoc(remote.data), readDoc(mine?.data ?? null)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(readDoc(cur.data))) { write(); merged(); }
  }
});
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let doc: Doc | null = null;
  try { doc = old.text != null ? readDoc(JSON.parse(old.text)) : null; } catch { doc = null; }
  const grew = adopt(doc);
  write({ replaceForeign: true });
  if (grew) merged();
}
export function progress(): Progress { return data.progress; }
export function boards(): Boards { return data.boards; }
/** main.js saveProgress / saveBoards: stamp and save (debounced to the cloud by the runtime). */
export function save(): void { data.progress.updatedAt = Date.now(); write(); }
export function flush(): void { void saves.flush().catch(() => undefined); }
export function syncState(): "saving" | "synced" | "offline" | "local" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}

// --- the interrupted round (main.js saveLastSnapshot) ---------------------------------------
const SNAP = "last-session";
export function saveSnapshot(snap: unknown): void { try { storage.setJson(SNAP, clone(snap) as JsonValue); } catch (e) { console.warn(`snapshot: ${String(e)}`); } }
export function loadSnapshot(): unknown { try { return storage.getJson(SNAP) ?? null; } catch { return null; } }
export function clearSnapshot(): void { try { storage.remove(SNAP); } catch { /* none */ } }

// --- the game's options ----------------------------------------------------------------------
export type Palette = "default" | "deuteranopia" | "protanopia" | "tritanopia";
export interface Options {
  cameraSway: boolean; showTimer: boolean; submitOnRelease: boolean; leftHanded: boolean; palette: Palette; haptics: boolean; captions: boolean;
}
export const DEFAULT_OPTIONS: Options = {
  cameraSway: true, showTimer: true, submitOnRelease: true, leftHanded: false, palette: "default", haptics: true, captions: false,
};
const PALETTES: Palette[] = ["default", "deuteranopia", "protanopia", "tritanopia"];
/** The valid option values in `raw` (also the browser build's KV values). */
export function pickOptions(raw: Record<string, unknown>): Partial<Options> {
  const out: Partial<Options> = {};
  for (const k of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
    const v = raw[k];
    if (k === "palette") { if (PALETTES.includes(v as Palette)) out.palette = v as Palette; }
    else if (typeof v === "boolean") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
/** The browser build's settings KV keys this build owns or retires (main.js SYNCED_SETTINGS). */
export const LEGACY_KEYS = ["volumes", "muted", "graphics", "reducedMotion", "highContrast", "palette", "textSize", "leftHanded", "submitOnRelease",
  "haptics", "cameraSway", "showTimer", "analyticsConsent"];
const KEYS = Object.keys(DEFAULT_OPTIONS) as (keyof Options)[];
export const options: Options = { ...DEFAULT_OPTIONS };
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const kv: Record<string, unknown> = {};
  for (const k of keys) kv[k] = store.legacy(k);
  let changed = false;
  for (const [k, v] of Object.entries(pickOptions(kv))) {
    try {
      if (store.get(k) !== undefined) continue;
      store.set(k, v as JsonValue);
      (options as unknown as Record<string, unknown>)[k] = v;
      changed = true;
    } catch { /* keep the device's */ }
  }
  for (const k of keys) if (LEGACY_KEYS.includes(k)) store.removeLegacy(k);
  if (changed) optionsChanged();
}

export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = readDoc(cur?.data ?? null) ?? fresh();
  for (const k of KEYS) readOption(k);
  store.onChange((k) => {
    if (!(KEYS as string[]).includes(k)) return;
    readOption(k as keyof Options);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });
/** Now by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
/** main.js hostedDailyBoard: the platform board's top entries (signed in), or null. */
export async function topEntries(n: number): Promise<{ name: string; score: number; me: boolean }[] | null> {
  const me = player();
  if (!me) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: n });
    if (!r.items.length) return null;
    return r.items.map((e) => ({ name: e.displayName || e.username, score: e.score, me: e.userId === me.userId }));
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
