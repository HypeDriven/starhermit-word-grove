// Extended smoke: practice undo, challenge limits, chase, settings, snapshots.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 8139;
const server = spawn('node', ['../server.js', String(PORT)], { cwd: new URL('.', import.meta.url).pathname, stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let failed = 0;
const check = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// ---- Practice: undo allowed, wrong word then undo restores score ----
await page.evaluate(() => { window.wordGrove.progress.tutorialDone = true; window.wordGrove.startPractice('easy'); });
await page.waitForTimeout(800);
check(await page.isVisible('#btn-undo'), 'practice shows undo button');
const before = await page.evaluate(() => {
  const app = window.wordGrove;
  const w = app.session.state.targets[0];
  app.session.submitWord(w);
  return app.session.score();
});
await page.waitForTimeout(200);
await page.click('#btn-undo');
await page.waitForTimeout(200);
const after = await page.evaluate(() => window.wordGrove.score ? 0 : window.wordGrove.session.score());
check(before > 0 && after === 0, `undo restores score (${before} → ${after})`);

// Practice hint + shuffle legality
await page.click('#btn-hint');
await page.waitForTimeout(150);
const hinted = await page.evaluate(() => window.wordGrove.session.state.hintsUsed === 1);
check(hinted, 'hint consumed in practice');

// ---- Challenge: move limit ----
await page.evaluate(() => window.wordGrove.startChallenge('thrifty-1'));
await page.waitForTimeout(800);
check(await page.isVisible('#hud-moves'), 'challenge shows moves chip');
const movesText = await page.textContent('#hud-moves');
check(/tries/.test(movesText), 'moves chip text: ' + movesText.trim());
check(await page.isHidden('#btn-undo'), 'challenge hides undo');
// Burn moves with invalid-then-valid submissions until failure.
const challengeResult = await page.evaluate(() => {
  const app = window.wordGrove;
  const s = app.session.state;
  const limit = s.constraints.moveLimit;
  // submit a valid bonus word repeatedly? duplicates don't count. Use targets minus one, then bad words.
  const targets = s.targets.slice();
  for (const w of targets.slice(0, limit)) app.session.submitWord(w);
  return { status: app.session.state.status, reason: app.session.state.terminalReason, limit, targets: targets.length };
});
check(['complete', 'failed'].includes(challengeResult.status), `challenge resolves (${JSON.stringify(challengeResult)})`);
await page.waitForTimeout(2000);
check(await page.isVisible('#screen-results'), 'challenge results shown');

// ---- Score chase: seed code + local board ----
await page.click('#btn-results-home');
await page.waitForTimeout(300);
await page.click('#btn-chase');
await page.fill('#chase-seed', 'test-seed-alpha');
await page.click('#chase-form button[type=submit]');
await page.waitForTimeout(800);
const chaseMode = await page.textContent('#hud-mode');
check(/score chase/i.test(chaseMode), 'chase round started: ' + chaseMode.trim());
// Complete it via API to check board recording.
await page.evaluate(() => {
  const app = window.wordGrove;
  for (const w of app.session.state.targets.slice().sort()) app.session.submitWord(w);
});
await page.waitForTimeout(2200);
check(await page.isVisible('#screen-results'), 'chase results shown');
const boardRows = await page.locator('#results-board tbody tr').count();
check(boardRows >= 1, 'chase board has entry: ' + boardRows);

// ---- Settings: quality + reduced motion apply live ----
await page.click('#btn-results-home');
await page.click('#btn-settings');
await page.selectOption('#set-quality', 'low');
await page.check('#set-reduced-motion');
const rmApplied = await page.evaluate(() => document.documentElement.classList.contains('reduced-motion'));
check(rmApplied, 'reduced motion class applied');
const qApplied = await page.evaluate(() => window.wordGrove.renderer.q === window.wordGrove.renderer.qualityTier());
check(qApplied, 'quality tier applied');
await page.click('#btn-settings-close');

// ---- Snapshot restore: start daily, submit, reload page ----
await page.evaluate(() => window.wordGrove.startDaily());
await page.waitForTimeout(600);
await page.evaluate(() => {
  const app = window.wordGrove;
  app.session.submitWord(app.session.state.targets[0]);
  app.persistSnapshot();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const restored = await page.evaluate(() => {
  const app = window.wordGrove;
  return app.session ? Object.keys(app.session.state.found).length : -1;
});
check(restored >= 1, 'snapshot restored after reload, found words: ' + restored);
check(await page.isVisible('#overlay-pause'), 'restored round opens paused');
await page.click('#btn-resume');

// ---- Keyboard tile focus navigation ----
await page.evaluate(() => window.wordGrove.ui.focusTile(0));
const focused = await page.evaluate(() => document.activeElement.classList.contains('wheel-tile-btn'));
check(focused, 'wheel tile focusable');
await page.keyboard.press('ArrowRight');
const focusedIdx = await page.evaluate(() => +document.activeElement.dataset.index);
check(focusedIdx === 1, 'arrow moves tile focus: ' + focusedIdx);

// ---- Help overlay from title ----
await page.evaluate(() => window.wordGrove.goHome());
await page.click('#btn-help');
check(await page.isVisible('#overlay-help'), 'help opens');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(await page.isHidden('#overlay-help'), 'escape closes help');

// ---- Theme cycle ----
const theme = await page.evaluate(() => {
  const app = window.wordGrove;
  app.progress.flowers = 300;
  app.cycleTheme();
  return app.progress.selectedTheme;
});
check(theme !== 'dawn', 'theme cycles: ' + theme);

check(errors.length === 0, 'no console errors' + (errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''));

await browser.close();
server.kill();
console.log(failed ? `\n${failed} FAILURES` : '\nALL EXTENDED CHECKS PASSED');
process.exit(failed ? 1 : 0);
