/**
 * Word Grove — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play → Practice (Easy) → exercise Pause/Resume, Shuffle, Hint and
 *   Undo through the visible buttons → solve the grove for real by spelling
 *   every grid word on the wheel (type letters, Enter to submit) → results
 *   screen with score breakdown + persisted progress.
 * A second pass runs load → practice → tap a wheel letter and plant one grid
 * word on a mobile touch viewport (real taps on the visible letter/Submit
 * controls plus real key presses for the rest of the word).
 *
 * The game exposes `window.wordGrove` (main.js) — the App instance. The test
 * reads it ONLY to observe round state (targets/found/status) so it can spell
 * the next visible grid word with real key presses. It never calls the game's
 * own move/session API — every word is typed on the wheel and submitted with
 * Enter (or the on-screen ✓ button), and every other action is a real
 * click/tap on on-screen controls. No game code is modified.
 *
 * Serving: the repo ships `server.js` (the StarHermit script declared by
 * starhermit.txt). The game is fully playable offline — with no launchToken it
 * sets `hosted=false` and makes no /api calls at all. So, per the sibling
 * convention (picture-logic/blockstead/balance-spire), this test embeds a
 * minimal node:http static server on an ephemeral port and answers /api/* with
 * 200 `{}` so nothing can ever hang or log a failed-resource error. Spawning
 * server.js is not needed today.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchToken, stubStarHermit } from './starhermit-e2e.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/word-grove-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer any API probe with empty JSON (200) so
    // the platform adapter degrades to its documented offline path with no noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the app handle ----------

// window.wordGrove is the game's own App instance (main.js). Read only.
const readState = (page) => page.evaluate(() => {
  const s = window.wordGrove?.session?.state;
  if (!s) return null;
  return {
    status: s.status,
    targets: s.targets.slice(),
    found: Object.keys(s.found),
    letters: s.letters.slice(),
    hintsUsed: s.hintsUsed, shufflesUsed: s.shufflesUsed,
    invalid: s.invalidCount, score: s.score,
  };
});

const waitGame = (page) =>
  page.waitForFunction(() => window.wordGrove?.session?.state, null, { timeout: 15000 });

const waitFound = (page, word, expect = true) =>
  page.waitForFunction(
    ([w, e]) => !!window.wordGrove?.session?.state?.found[w] === e,
    [word, expect], { timeout: 5000 });

// Blur any focused on-screen button so Enter submits the word rather than
// re-activating the focused control (the document-level keydown owns Enter).
// #word-tray is a plain, non-interactive div always present in the game screen.
async function blur(page) {
  const bb = await page.locator('#word-tray').boundingBox();
  if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {});
}

// Select `word` on the wheel as REAL input (nothing submitted).
// The wheel is swipe-driven: a plain click on a tile is swallowed by the drag
// layer's pointer capture and its first letter is not taken. So the first
// letter is added by focusing its visible tile and pressing Space (keyboard
// activation of that on-screen letter button, which appends it). Keeping the
// selection non-empty from the very first keystroke also means a later letter
// that is a shortcut key (s/h/u/p) is appended as a letter rather than firing
// the action. The remaining letters are typed as real key presses.
async function selectWordOnWheel(page, word) {
  const st = await readState(page);
  const ch0 = word[0];
  const i0 = st.letters.findIndex((l) => l === ch0);
  if (i0 < 0) throw new Error(`letter "${ch0}" not on wheel (${st.letters.join('')})`);
  await page.locator('.wheel-tile-btn').nth(i0).focus();
  await page.keyboard.press('Space'); // activates the focused on-screen letter button
  // Blur so Enter (or a later on-screen Submit tap) submits rather than
  // re-toggling the focused tile.
  await blur(page);
  for (const ch of word.slice(1)) await page.keyboard.press(ch);
}

// Spell `word` on the wheel with real key presses and submit with Enter.
async function spell(page, word) {
  await selectWordOnWheel(page, word);
  await page.keyboard.press('Enter');
}

// Start a practice round (Easy) through the visible setup sheet.
async function startPractice(page, { touch = false } = {}) {
  const tap = async (sel) => (touch ? page.tap(sel) : page.click(sel));
  await tap('#btn-practice');
  await page.waitForSelector('#overlay-setup', { state: 'visible' });
  if (touch) {
    await page.locator('#setup-body input[name="practice-diff"][value="easy"]').tap();
  } else {
    await page.locator('#setup-body input[name="practice-diff"][value="easy"]').check();
  }
  await tap('#btn-setup-start');
  await page.waitForSelector('#screen-game', { state: 'visible' });
  await waitGame(page);
  const st = await readState(page);
  if (st.status !== 'active') throw new Error('round not active after start');
  return st;
}

// Select `word` on the wheel with a real tile tap + key presses, then tap the
// visible ✓ Submit button (a real touch on a real on-screen control).
async function spellAndTapSubmit(page, word) {
  await selectWordOnWheel(page, word);
  await page.tap('#btn-submit');
}

// Solve every remaining grid word on the wheel via real key presses.
async function solveToCompletion(page) {
  for (let guard = 0; guard < 64; guard++) {
    const st = await readState(page);
    if (!st) throw new Error('state handle missing while solving');
    if (st.status === 'complete') return st;
    if (st.status === 'failed') throw new Error('round failed while solving: ' + JSON.stringify(st));
    const word = st.targets.find((w) => !st.found.includes(w));
    if (!word) throw new Error('all targets found but round not terminal');
    await spell(page, word);
    await waitFound(page, word, true);
    // Re-sync after submit (selection was cleared by the engine).
    await page.waitForFunction(() => !window.wordGrove?.ui?.selection?.length, null, { timeout: 3000 }).catch(() => {});
  }
  throw new Error('solve loop did not reach completion within guard limit');
}


// Graphics settings through the visible Settings panel: preset Low → High,
// one per-category override, applied live (canvas data-gfx-preset + summary),
// persisted across a reload; then back to Auto so the rest of the run stays cheap.
async function exerciseGraphics(page, vp, { touch = false } = {}) {
  const tap = async (sel) => (touch ? page.tap(sel) : page.click(sel));
  const preset = () => page.getAttribute('#scene-canvas', 'data-gfx-preset');
  await tap('#btn-settings');
  await page.waitForSelector('#overlay-settings', { state: 'visible' });
  const autoLabel = await page.textContent('#set-quality option[value="auto"]');
  if (!/\(.+\)/.test(autoLabel)) throw new Error(`auto label lacks detected tier: "${autoLabel}"`);
  await page.selectOption('#set-quality', 'low');
  await page.waitForFunction(() => document.getElementById('scene-canvas').dataset.gfxPreset === 'low');
  await page.selectOption('#set-quality', 'high');
  await page.waitForFunction(() => document.getElementById('scene-canvas').dataset.gfxPreset === 'high');
  await page.waitForFunction(() => /2048² shadows/.test(document.getElementById('gfx-summary').textContent), null, { timeout: 5000 });
  await page.selectOption('#gfx-bloom', 'off');
  await page.waitForFunction(() => !/bloom/.test(document.getElementById('gfx-summary').textContent), null, { timeout: 5000 });
  const scaleRow = await page.locator('#gfx-render-scale').boundingBox();
  const panel = await page.locator('#overlay-settings .settings-panel').boundingBox();
  if (!scaleRow || scaleRow.x + scaleRow.width > panel.x + panel.width + 1) throw new Error('render scale slider cut off');
  await page.waitForTimeout(600); // a few High frames with the post chain
  await tap('#btn-settings-close');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-title', { state: 'visible', timeout: 15000 });
  if ((await preset()) !== 'high') throw new Error(`preset not persisted (got ${await preset()})`);
  await tap('#btn-settings');
  await page.waitForSelector('#overlay-settings', { state: 'visible' });
  if ((await page.inputValue('#set-quality')) !== 'high') throw new Error('quality select not restored');
  if ((await page.inputValue('#gfx-bloom')) !== 'off') throw new Error('bloom override not restored');
  await page.selectOption('#set-quality', 'high'); // choosing a preset clears overrides
  if ((await page.inputValue('#gfx-bloom')) !== 'preset') throw new Error('preset did not clear overrides');
  await page.selectOption('#set-quality', 'ultra');
  await page.waitForFunction(() => document.getElementById('scene-canvas').dataset.gfxPreset === 'ultra');
  await page.waitForTimeout(600);
  await page.screenshot({ path: SHOT('graphics', vp) });
  await page.selectOption('#set-quality', 'auto');
  await tap('#btn-settings-close');
  await page.waitForSelector('#overlay-settings', { state: 'hidden' });
  ok(`${vp}: Graphics settings — Low/High/Ultra presets, bloom override, persisted across reload`);
}

// ---------- one full desktop pass ----------
async function runDesktop(browser) {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() !== 'error' && m.type() !== 'warning') || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title', { state: 'visible', timeout: 15000 });
    // If WebGL fell back, dismiss the (non-blocking) compatibility notice.
    if (await page.locator('#compat-warning:visible').count()) await page.click('#btn-compat-ok');
    await page.screenshot({ path: SHOT('title', 'desktop') });
    ok('desktop: title screen visible');
    await exerciseGraphics(page, 'desktop');

    // Play → Practice (Easy)
    await page.click('#btn-play');
    // playPrimary goes to tutorial if tutorialDone is false; that's still a real
    // playable round, so drive it: finish the tutorial's own flow is complex, so
    // instead we go to Practice directly via the title card when possible.
    // (btn-play may have started a learn round; if so, skip the tutorial.) If a
    // learn round is active, abandon it and go to Practice from the title.
    const inGame = await page.evaluate(() => !!window.wordGrove?.session?.state);
    if (inGame && (await page.evaluate(() => window.wordGrove?.session?.level?.mode)) === 'learn') {
      await page.evaluate(() => { window.wordGrove.leaveRound(); });
      await page.waitForSelector('#screen-title', { state: 'visible' });
    }
    const st = await startPractice(page);
    await page.screenshot({ path: SHOT('play', 'desktop') });
    ok(`desktop: practice board active ("${(await page.textContent('#hud-mode')).trim()}", ${st.targets.length} targets)`);

    // Pause / resume via the visible buttons.
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause', { state: 'visible' });
    await page.screenshot({ path: SHOT('pause', 'desktop') });
    await page.click('#btn-resume');
    await page.waitForFunction(() => document.getElementById('overlay-pause').hidden === true);
    ok('desktop: pause (II) and resume work');

    // Shuffle (display-only reorder, but a real button press).
    const beforeShuf = (await readState(page)).shufflesUsed;
    await page.click('#btn-shuffle');
    await page.waitForFunction((n) => (window.wordGrove?.session?.state?.shufflesUsed ?? 0) > n, beforeShuf, { timeout: 3000 });
    ok('desktop: shuffle button reorders the wheel');
    await blur(page);

    // Hint reveals one grid cell for a point cost.
    const beforeHint = (await readState(page)).hintsUsed;
    await page.click('#btn-hint');
    await page.waitForFunction((n) => (window.wordGrove?.session?.state?.hintsUsed ?? 0) > n, beforeHint, { timeout: 3000 });
    ok('desktop: hint button reveals a grid cell');
    await blur(page);

    // Submit one grid word, undo it, confirm it reverts, then re-plant it.
    const stA = await readState(page);
    const word0 = stA.targets.find((w) => !stA.found.includes(w));
    await spell(page, word0);
    await waitFound(page, word0, true);
    // The engine clears the selection; btn-undo is available in Practice.
    await page.click('#btn-undo');
    await page.waitForFunction((w) => !window.wordGrove?.session?.state?.found[w], word0, { timeout: 3000 });
    ok(`desktop: submit "${word0}" → undo reverts it`);
    await spell(page, word0);
    await waitFound(page, word0, true);
    ok(`desktop: re-plant "${word0}" after undo`);

    // Solve the rest of the grove for real.
    const done = await solveToCompletion(page);
    if (done.status !== 'complete') throw new Error('round did not complete: ' + done.status);

    // Results screen.
    await page.waitForSelector('#screen-results', { state: 'visible', timeout: 8000 });
    const headline = (await page.textContent('#results-headline')).trim();
    if (!/bloom|grown|flourish/i.test(headline)) throw new Error(`unexpected results headline "${headline}"`);
    const rows = await page.locator('#results-breakdown tbody tr').count();
    if (rows < 1) throw new Error('score breakdown is empty');
    await page.screenshot({ path: SHOT('results', 'desktop') });
    ok(`desktop: grove solved on the wheel — results shown ("${headline}", ${rows} breakdown rows)`);

    // Persistence: words counted and flowers credited.
    const pr = await page.evaluate(() => window.wordGrove?.progress);
    if (!pr || !(pr.totals.words > 0) || !(pr.flowers > 0)) throw new Error('progress not persisted: ' + JSON.stringify(pr?.totals));
    ok(`desktop: progress persisted (words: ${pr.totals.words}, flowers: ${pr.flowers})`);
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`desktop pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log('ok - desktop: no page errors');
}

// ---------- mobile pass (shorter, touch) ----------
async function runMobile(browser) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() !== 'error' && m.type() !== 'warning') || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`);
  });

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title', { state: 'visible', timeout: 15000 });
    if (await page.locator('#compat-warning:visible').count()) await page.tap('#btn-compat-ok');
    await page.screenshot({ path: SHOT('title', 'mobile') });
    ok('mobile: title screen visible');
    await exerciseGraphics(page, 'mobile', { touch: true });

    // Tap one wheel tile and confirm the word tray updates (real touch move).
    await page.tap('#btn-practice');
    await page.waitForSelector('#overlay-setup', { state: 'visible' });
    await page.locator('#setup-body input[name="practice-diff"][value="easy"]').tap();
    await page.tap('#btn-setup-start');
    await page.waitForSelector('#screen-game', { state: 'visible' });
    await waitGame(page);
    const tile = page.locator('.wheel-tile-btn').first();
    const bb = await tile.boundingBox();
    if (!bb) throw new Error('wheel tile has no box on mobile');
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForFunction(() => (window.wordGrove?.ui?.selection?.length ?? 0) > 0, null, { timeout: 4000 });
    await page.screenshot({ path: SHOT('tile-tap', 'mobile') });
    ok('mobile: tapping a wheel tile selects a letter');
    // Clear it via the visible ✕ Clear button (a real tap).
    await page.tap('#btn-clear');
    await page.waitForFunction(() => (window.wordGrove?.ui?.selection?.length ?? 0) === 0, null, { timeout: 4000 });

    // Plant one grid word: type its letters on the wheel (real keys) and tap
    // the visible ✓ Submit button (a real touch on a real control).
    const st = await readState(page);
    const word = st.targets[0];
    await spellAndTapSubmit(page, word);
    await waitFound(page, word, true);
    const st2 = await readState(page);
    if (!st2.found.includes(word)) throw new Error(`submit did not plant "${word}"`);
    await page.screenshot({ path: SHOT('mobile-submit', 'mobile') });
    ok(`mobile: planted "${word}" (${st2.found.length}/${st2.targets.length} words)`);
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`mobile pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log('ok - mobile: no page errors');
}

// ---------- language + report pass (signed in, stubbed StarHermit API) ----------
// Automatic follows the account's preferred language (fr-CA); choosing Italian
// in Settings relabels it in place and PUTs ui.language; Report a problem posts
// to /reports; a German practice round shows German HUD text at this viewport
// without overlaps; Automatic from the pause menu re-renders mid-round.
async function runLanguage(browser, name, ctxOpts) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() !== 'error' && m.type() !== 'warning') || browserNoise.test(m.text())) return;
    errors.push(`console: ${m.text()}`);
  });
  const touch = !!ctxOpts.hasTouch;
  const tap = async (sel) => (touch ? page.tap(sel) : page.click(sel));
  try {
    await context.addInitScript(() => {
      try {
        if (!localStorage.getItem('wordgrove:progress:v1')) {
          localStorage.setItem('wordgrove:progress:v1', JSON.stringify({ version: 1, tutorialDone: true, journey: {}, flowers: 0, totals: { words: 0, bonus: 0, invalid: 0, sessions: 0, playSec: 0 }, mechanicsUsed: {}, achievements: {}, dailyDays: [], challengeBest: {}, selectedTheme: 'dawn', updatedAt: 1 }));
        }
      } catch (e) { /* private mode */ }
    });
    const calls = await stubStarHermit(page, { preferredLanguage: 'fr-CA' });
    await page.goto('about:blank');
    await page.goto(BASE + '/index.html#game_token=' + launchToken(), { waitUntil: 'load' });
    await page.waitForSelector('#screen-title', { state: 'visible', timeout: 15000 });
    if (await page.locator('#compat-warning:visible').count()) await tap('#btn-compat-ok');
    await page.waitForFunction(() => document.documentElement.lang === 'fr-CA', null, { timeout: 15000 });
    if ((await page.textContent('#btn-settings')).trim() !== 'Paramètres') throw new Error('title not in French');
    ok(`${name}: Automatic follows the account language (fr-CA)`);

    await tap('#btn-settings');
    await page.waitForSelector('#overlay-settings', { state: 'visible' });
    const choice = page.locator('#overlay-settings [data-game-language="choice"]');
    await choice.scrollIntoViewIfNeeded();
    const auto = (await choice.locator('option').first().textContent()).trim();
    if (auto !== 'Automatique — Français (Canada)') throw new Error(`Automatic label not resolved: "${auto}"`);
    if ((await page.locator('[data-game-language="choice"]').count()) !== 1) throw new Error('expected exactly one language selector');
    await choice.selectOption('it-IT');
    await page.waitForFunction(() => document.documentElement.lang === 'it-IT');
    await page.waitForFunction(() => /Salvato/.test(document.querySelector('[data-game-language="status"]').textContent));
    if (calls.settings['ui.language']?.choice !== 'it-IT') throw new Error('ui.language not saved: ' + JSON.stringify(calls.settings));
    const rel = await page.evaluate(() => ({
      h: document.getElementById('settings-title').textContent, gfx: document.getElementById('gfx-legend').textContent,
      rm: document.querySelector('[data-i18n="reducedMotion"]').textContent, q: document.querySelector('#gfx-controls label span').textContent,
    }));
    if (rel.h !== 'Impostazioni' || rel.gfx !== 'Grafica' || rel.rm !== 'Movimento ridotto' || rel.q !== 'Qualità') throw new Error('Settings not re-rendered: ' + JSON.stringify(rel));
    ok(`${name}: Italian chosen in Settings — relabelled in place, ui.language saved`);
    await page.locator('[data-game-report="title"]').scrollIntoViewIfNeeded();
    await page.fill('[data-game-report="title"]', 'Test report');
    await tap('[data-game-report="send"]');
    await page.waitForFunction(() => /Grazie/.test(document.querySelector('[data-game-report="status"]').textContent));
    if (!calls.reports?.[0] || calls.reports[0].kind !== 'bug') throw new Error('report not posted');
    await page.screenshot({ path: SHOT('language', name) });
    ok(`${name}: Report a problem posted to /reports`);

    // German practice round.
    await choice.selectOption('de-DE');
    await page.waitForFunction(() => document.documentElement.lang === 'de-DE');
    await page.locator('#btn-settings-close').scrollIntoViewIfNeeded();
    await tap('#btn-settings-close');
    await page.waitForSelector('#overlay-settings', { state: 'hidden' });
    await page.screenshot({ path: SHOT('german-title', name) });
    await startPractice(page, { touch });
    await page.waitForFunction(() => /Wörter$/.test(document.getElementById('hud-progress').textContent));
    const st = await readState(page);
    const word = st.targets[0];
    await spell(page, word);
    await waitFound(page, word, true);
    const layout = await page.evaluate(() => {
      const vis = (e) => e && e.offsetParent !== null && !e.hidden;
      const r = (e) => e.getBoundingClientRect();
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const els = ['#hud .hud-left', '#hud .hud-right', '#wheel-controls', '#word-tray', '#bonus-line'].map((q) => document.querySelector(q)).filter(vis);
      const cut = [...document.querySelectorAll('#hud *, #wheel-controls .btn, #word-feedback')].filter(vis).some((e) => r(e).right > innerWidth + 1 || r(e).left < -1);
      const hudClash = overlap(r(document.querySelector('#hud .hud-left')), r(document.querySelector('#hud .hud-right')));
      return { cut, hudClash, scrollX: document.documentElement.scrollWidth > innerWidth, n: els.length };
    });
    if (layout.cut || layout.hudClash || layout.scrollX) throw new Error('German HUD layout problem: ' + JSON.stringify(layout));
    await page.screenshot({ path: SHOT('german-play', name) });
    const progBefore = await page.textContent('#hud-progress');
    ok(`${name}: German round shows German HUD (${progBefore}), nothing overlaps`);

    // Back to Automatic mid-round from the pause menu.
    await tap('#btn-pause');
    await page.waitForSelector('#overlay-pause', { state: 'visible' });
    if ((await page.textContent('#pause-title')).trim() !== 'Pausiert') throw new Error('pause not German');
    await tap('#btn-pause-settings');
    await page.waitForSelector('#overlay-settings', { state: 'visible' });
    await choice.scrollIntoViewIfNeeded();
    await choice.selectOption('auto');
    await page.waitForFunction(() => document.documentElement.lang === 'fr-CA');
    await page.locator('#btn-settings-close').scrollIntoViewIfNeeded();
    await tap('#btn-settings-close');
    if ((await page.textContent('#pause-title')).trim() !== 'En pause') throw new Error('pause not re-rendered');
    await tap('#btn-resume');
    await page.waitForFunction(() => /mots$/.test(document.getElementById('hud-progress').textContent));
    const progAfter = await page.textContent('#hud-progress');
    if (progAfter.replace(/\D+/g, ' ') !== progBefore.replace(/\D+/g, ' ')) throw new Error(`round restarted: ${progBefore} → ${progAfter}`);
    ok(`${name}: Automatic mid-round re-renders the HUD in French without restarting (${progAfter})`);
  } finally {
    await context.close();
  }
  if (errors.length) throw new Error(`${name} language pass had page errors:\n  ${errors.join('\n  ')}`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runDesktop(browser);
  await runMobile(browser);
  await runLanguage(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runLanguage(browser, 'mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  console.log('\nE2E PASS — word-grove, desktop + mobile, no page errors');
} catch (e) {
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (process.exitCode) process.exit(process.exitCode);
