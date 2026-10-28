/**
 * Word Grove localization core (pure: node tests and the engine client load
 * it unchanged). The engine client sets the language from the runtime's
 * interface language (native/i18n.ts → setLocale); every string is drawn
 * through t() each frame, so a change shows on the next frame.
 */

import { STRINGS } from './strings.js';

export const SUPPORTED = Object.keys(STRINGS);
let lang = 'en-US';
let dict = STRINGS[lang];
const listeners = new Set();

export function locale() {
  return lang;
}

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s);

/** Localized string for a flat key with {placeholders} filled from vars. */
export function t(key, vars) {
  return fill(dict?.[key] ?? STRINGS['en-US'][key] ?? key, vars);
}

/** Localized content text from a nested group (symbols, chapters, themes, …). */
export function tn(group, id, fallback) {
  const own = dict?.[group]?.[id];
  if (own != null) return own;
  const en = STRINGS['en-US'][group]?.[id];
  return en != null ? en : fallback;
}

/** fn(locale) runs after every language change. */
export function onLanguage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Switches the language (an unsupported tag falls back by language, then en-US); returns the tag in use. */
export function setLocale(next) {
  const tag = String(next || 'en-US');
  const base = tag.split('-')[0];
  lang = STRINGS[tag] ? tag : (SUPPORTED.find((l) => l.split('-')[0] === base) || 'en-US');
  dict = STRINGS[lang];
  for (const fn of listeners) {
    try { fn(lang); } catch (e) { console.error(e); }
  }
  return lang;
}

// ---------------------------------------------------------------------------
// Content display names (the authored English stays in content.js)
// ---------------------------------------------------------------------------

export const groveName = (index, fallback) => tn('groves', index, fallback);
export const themeName = (id, fallback) => tn('themes', id, fallback ?? id);

/** Built-in fallback names ('Player <id>', 'Gardener') are localized at render time. */
export function playerName(name) {
  if (name == null || name === 'Gardener') return t('defaultGardener');
  const m = /^Player (\S+)$/.exec(String(name));
  return m ? t('playerN', { id: m[1] }) : String(name);
}
