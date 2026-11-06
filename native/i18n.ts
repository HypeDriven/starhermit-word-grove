// Localization: assets/strings.json (generated from the browser build's tables:
// flat keys plus group.id keys for groves, themes, difficulties, challenges,
// tutorial and achievements, in the nine StarHermit locales) on the engine's
// strings, which follow the interface language the runtime reports (the
// player's choice in Options › Language, else the account's preferred language
// or the device's) and own the locale fallback and the account strings
// (`starhermit.*`). Every string is drawn through T() each frame, so a change
// shows on the next frame while the round keeps running.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

type Vars = Record<string, string | number>;
/** A string in the player's language, `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars): string { return strings.t(key, vars); }
/** Content text from a nested group (tutorial, challenges, achievements, …): [title, body] style arrays. */
export function TN(group: string, id: string | number, fallback: string[]): string[] {
  return fallback.map((text, i) => (strings.has(`${group}.${id}.${i}`) ? strings.t(`${group}.${id}.${i}`) : text));
}
/** The engine's account strings (signIn, invite, inviteCopied, inviteLink, signedOut, leaderboard…). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
const named = (key: string, fallback: string): string => (strings.has(key) ? strings.t(key) : fallback);
export const grove = (i: number, f: string): string => named(`groves.${i}`, f);
export const themeLabel = (id: string, f?: string): string => named(`themes.${id}`, f ?? id);
/** Built-in fallback names ('Player <id>', 'Gardener') are localized at render time. */
export function player(name: string | null): string {
  if (name == null || name === "Gardener") return T("defaultGardener");
  const m = /^Player (\S+)$/.exec(String(name));
  return m ? T("playerN", { id: m[1]! }) : String(name);
}
