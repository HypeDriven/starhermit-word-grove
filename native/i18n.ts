// Localization: the browser build's tables (js/strings.js, keyed; the nine
// StarHermit locales; the account strings in js/platform-i18n.js) in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replace the game's own
// Language setting (sh-language.js) and the DOM re-labelling: every string is
// drawn through T() each frame, so a change shows on the next frame while
// the round keeps running.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { setLocale, t, tn, groveName, themeName, playerName } from "../js/i18n.js";
import { platformStrings } from "../js/platform-i18n.js";

type Vars = Record<string, string | number>;
let current = "";
let pt: (k: string, v?: Vars) => string = platformStrings("en-US") as never;
function apply(tag: string): void {
  const next = (setLocale as (t: string) => string)(String(tag || "en-US"));
  if (next === current) return;
  current = next;
  pt = platformStrings(current) as never;
  ui.setLanguage(current);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

/** A string of js/strings.js in the player's language, `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars): string { return (t as (k: string, v?: Vars) => string)(key, vars); }
/** Content text from a nested group (tutorial, challenges, achievements, …): [title, body] style arrays. */
export function TN(group: string, id: string | number, fallback: string[]): string[] { return (tn as (g: string, i: string | number, f: string[]) => string[])(group, id, fallback); }
/** The account strings (signIn, invite, inviteCopied, inviteFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string { return pt(key, vars); }
export const grove = groveName as (i: number, f: string) => string;
export const themeLabel = themeName as (id: string, f?: string) => string;
export const player = playerName as (n: string | null) => string;
export function locale(): string { return current; }
