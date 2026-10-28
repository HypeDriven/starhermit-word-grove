// Typed views of the browser build's pure modules (js/content.js, rules.js,
// session.js), which the engine loads unchanged (tsconfig allowJs).
import * as content from "../js/content.js";
import * as rulesJs from "../js/rules.js";
import * as sessionJs from "../js/session.js";

export interface Placement { word: string; x: number; y: number; dir: number }
export interface Constraints {
  moveLimit?: number | null; timeLimitSec?: number | null; allowShuffle: boolean; allowHints: boolean; allowUndo: boolean; bonusAllowed: boolean;
}
export interface Challenge { id: string; label: string; kind: string; desc: string; wheelSize: number; targetCount: number }
export interface Level {
  version: number; id: string; seed: string; letters: string; targets: string[]; grid: { placements: Placement[]; width: number; height: number };
  bonusCount: number; par: number; mode: string; theme: string; constraints: Constraints; ranked?: boolean; ruleset?: string;
  journeyIndex?: number; grove?: number; mastery?: boolean; difficultyId?: string; challenge?: Challenge; chaseSeed?: string;
}
export interface State {
  status: "active" | "paused" | "complete" | "failed"; terminalReason: string | null; letters: string[]; targets: string[];
  found: Record<string, { kind: "target" | "bonus"; tick: number }>; revealed: Record<number, boolean[]>; constraints: Constraints & { moveLimit: number | null; timeLimitSec: number | null };
  submissions: number; elapsedTicks: number; tick: number;
}
export interface Legal {
  canSubmit: boolean; canShuffle: boolean; canHint: boolean; canUndo: boolean; canPause: boolean; canResume: boolean;
  remainingTargets: string[]; movesRemaining: number | null; timeRemainingSec: number | null;
}
export interface Summary {
  sessionId: string; levelId: string; mode: string; completed: boolean; terminalReason: string | null; score: number;
  breakdown: { key: string; label: string; value: number }[]; wordsFound: number; bonusFound: number; totalTargets: number;
  invalidCount: number; hintsUsed: number; shufflesUsed: number; elapsedSec: number; ranked: boolean; ruleset: string; contentVersion: number; seed: string;
}
export interface GridCell { x: number; y: number; letter: string; revealed: boolean; words: number[] }
export type SessionEvent = { type: string; word?: string; kind?: string; pangram?: boolean; reason?: string; letter?: string; status?: string; letters?: string };
export interface Session {
  level: Level; state: State; sessionId: string; bonusPool: string[];
  on(fn: (type: string, ev: SessionEvent) => void): () => void;
  advance(ms: number): void;
  submitWord(w: string): { ok: boolean }; shuffle(): unknown; hint(): unknown; undo(): unknown; pause(): unknown; resume(): unknown; abandon(): unknown;
  remainingBonus(): number; elapsedSec(): number; summary(): Summary; snapshot(): Snapshot;
  gridModel(): { cells: Map<string, GridCell>; width: number; height: number; placements: Placement[] };
}
export interface Snapshot { level: Level; savedAt: number; [k: string]: unknown }

export const Session = sessionJs.Session as unknown as {
  new (level: Level, opts?: { bonusPool?: string[]; sessionId?: string }): Session;
  restore(snap: Snapshot, opts?: { bonusPool?: string[] }): Session;
};
export const sessionSeedCode = sessionJs.sessionSeedCode as (seed: string) => string;
export const legalActions = rulesJs.legalActions as unknown as (s: State) => Legal;
export const totalScore = rulesJs.totalScore as unknown as (s: State) => number;
export const compareResults = rulesJs.compareResults as unknown as (a: unknown, b: unknown) => number;
export const C = content as unknown as {
  TUTORIAL_STEPS: { id: string; title: string; body: string; waitFor: string | null }[];
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
  THEMES: Record<string, { id: string; name: string; unlock: number; ambience: string }>;
  CHALLENGES: Challenge[];
  PRACTICE_DIFFICULTIES: { id: string; label: string; note: string }[];
  groves(): { index: number; name: string; theme: string }[];
  groveInfo(i: number): { index: number; name: string; theme: string };
  journeyLevelCount(): number;
  utcDateISO(now?: number): string;
  validateLevel(l: Level): string[];
  themeById(id: string): { id: string; name: string; ambience: string };
};
