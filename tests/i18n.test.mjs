// Every string key the engine client draws (T("…") in native/*.ts) exists in all
// nine locales with the same {placeholders} as US English, every locale has
// exactly the US English keys, and every content name (groves, themes,
// difficulties, challenges, tutorial steps, achievements) is translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS } from '../js/strings.js';
import { THEMES, groves, CHALLENGES, PRACTICE_DIFFICULTIES, TUTORIAL_STEPS, ACHIEVEMENTS } from '../js/content.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const dir = new URL('../native/', import.meta.url);
const code = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
const en = STRINGS['en-US'];
const used = new Set();
for (const m of code.matchAll(/\bT\("([A-Za-z0-9_]+)"(?!\s*\+)/g)) used.add(m[1]);
// Keys reached through tables and prefixes.
for (const m of code.matchAll(/"((?:inv|cap|head|what|sync|board)[A-Z_]\w*)"/g)) used.add(m[1]);
for (const k of ['target', 'bonus', 'pangram', 'completion', 'timeBonus', 'moveBonus', 'hintPenalty']) used.add('row_' + k);
for (const k of ['startJourney', 'stageN', 'dailyGrove', 'playAgain', 'tryAgain', 'screenResults', 'play', 'challengesH', 'scoreChase', 'journey']) used.add(k);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine locales', () => assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort()));
test('every locale has exactly the US English keys', () => {
  for (const loc of LOCALES) assert.deepEqual(Object.keys(STRINGS[loc]).sort(), Object.keys(en).sort(), loc);
});
test('found the keys in the engine client', () => assert.ok(used.size > 120, String(used.size)));
for (const loc of LOCALES) {
  test(`${loc}: every used key, matching placeholders`, () => {
    const L = STRINGS[loc];
    assert.deepEqual([...used].filter((k) => typeof L[k] !== 'string'), []);
    for (const k of Object.keys(en)) if (typeof en[k] === 'string') assert.equal(vars(L[k]), vars(en[k]), `${loc}.${k}`);
  });
  test(`${loc}: every content name`, () => {
    const L = STRINGS[loc];
    for (const g of groves()) assert.ok(L.groves[g.index], `grove ${g.index}`);
    for (const id of Object.keys(THEMES)) assert.ok(L.themes[id], `theme ${id}`);
    for (const d of PRACTICE_DIFFICULTIES) assert.equal(L.difficulties[d.id]?.length, 2, `difficulty ${d.id}`);
    for (const c of CHALLENGES) assert.equal(L.challenges[c.id]?.length, 2, `challenge ${c.id}`);
    for (const st of TUTORIAL_STEPS) assert.equal(L.tutorial[st.id]?.length, 2, `tutorial ${st.id}`);
    for (const a of ACHIEVEMENTS) assert.equal(L.achievements[a.key]?.length, 2, `achievement ${a.key}`);
  });
}
test('English content strings match the authored data', () => {
  for (const g of groves()) assert.equal(en.groves[g.index], g.name);
  for (const [id, th] of Object.entries(THEMES)) assert.equal(en.themes[id], th.name);
  for (const d of PRACTICE_DIFFICULTIES) assert.deepEqual(en.difficulties[d.id], [d.label, d.note]);
  for (const c of CHALLENGES) assert.deepEqual(en.challenges[c.id], [c.label, c.desc]);
  for (const st of TUTORIAL_STEPS) assert.deepEqual(en.tutorial[st.id], [st.title, st.body]);
  for (const a of ACHIEVEMENTS) assert.deepEqual(en.achievements[a.key], [a.name, a.desc]);
});
test('non-English locales are translated', () => {
  for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
    const same = [...used].filter((k) => STRINGS[loc][k] === en[k]);
    assert.ok(same.length < 15, `${loc}: ${same.join(', ')}`);
  }
});
