// Word Grove — headless browser smoke test (dev tool, not shipped).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 8137;
const server = spawn('node', ['../server.js', String(PORT)], { cwd: new URL('.', import.meta.url).pathname, stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

let failed = 0;
const check = (cond, name) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failed++;
};

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

check(await page.isVisible('#screen-title'), 'title screen visible');
check(await page.isVisible('#btn-play'), 'play button visible');
const has3D = await page.evaluate(() => !!window.wordGrove.renderer && !window.wordGrove.renderer.failed);
console.log('  WebGL renderer active:', has3D);
await page.screenshot({ path: 'shot-title.png' });

// Start Learn (tutorial) via Play.
await page.click('#btn-play');
await page.waitForTimeout(1200);
check(await page.isVisible('#screen-game'), 'game screen visible');
check(await page.isVisible('#tutorial-bar'), 'tutorial bar visible');
const cellCount = await page.locator('.grid-cell:not(.empty)').count();
check(cellCount > 5, 'grid cells rendered: ' + cellCount);
const tileCount = await page.locator('.wheel-tile-btn').count();
check(tileCount >= 4 && tileCount <= 8, 'wheel tiles rendered: ' + tileCount);

// Advance tutorial welcome step.
await page.click('#tutorial-next');
// Make a selection (tutorial step: drag/select) — type first letter.
const targets = await page.evaluate(() => window.wordGrove.session.state.targets.slice());
const letters = await page.evaluate(() => window.wordGrove.session.state.letters.join(''));
console.log('  tutorial letters:', letters, 'targets:', targets.join(','));
await page.keyboard.type(targets[0][0]);
await page.waitForTimeout(200);

// Submit a word via keyboard (Backspace clears any partial selection).
async function submitWord(w) {
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.type(w);
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}
// walk tutorial: it needs select → word-target → invalid → shuffle → hint
await submitWord(targets[0]);
let hud = await page.textContent('#hud-progress');
check(/1\s*\/\s*\d+/.test(hud), 'target word planted, HUD progress: ' + hud.trim());

// Invalid word: search wheel-letter permutations for one the rules reject.
const invalidReason = await page.evaluate(() => {
  const app = window.wordGrove;
  const L = app.session.state.letters;
  for (const a of L) for (const b of L) for (const c of L) {
    if (a === b || b === c || a === c) continue;
    const w = a + b + c;
    const r = app.session.submitWord(w);
    if (!r.ok && r.reason === 'unknown-word') return w + ':' + r.reason;
    if (r.ok) app.session.undo();
  }
  return null;
});
await page.waitForTimeout(300);
const fb = await page.textContent('#word-feedback');
check(!!invalidReason && fb.length > 0, `invalid word feedback shown (${invalidReason}): ${fb.trim()}`);
await page.click('#btn-shuffle');
await page.waitForTimeout(300);
await page.click('#btn-hint');
await page.waitForTimeout(300);

// Finish the level.
for (const w of targets.slice(1)) await submitWord(w);
await page.waitForTimeout(2200);
check(await page.isVisible('#screen-results'), 'results screen visible');
const total = await page.textContent('#results-total');
check(Number(total) > 0, 'results total positive: ' + total);
await page.screenshot({ path: 'shot-results.png' });

// Journey map.
await page.click('#btn-results-home');
await page.waitForTimeout(400);
await page.click('#btn-journey');
await page.waitForTimeout(400);
const nodes = await page.locator('.level-node').count();
check(nodes === 48, 'journey map has 48 nodes: ' + nodes);
const unlocked = await page.locator('.level-node:not(.locked)').count();
check(unlocked >= 1, 'at least one unlocked stage: ' + unlocked);

// Daily round starts.
await page.click('[data-back]');
await page.click('#btn-daily');
await page.waitForTimeout(1000);
check(await page.isVisible('#screen-game'), 'daily round started');
const mode = await page.textContent('#hud-mode');
check(/daily/i.test(mode), 'daily mode label: ' + mode.trim());
await page.screenshot({ path: 'shot-daily.png' });

// Pause overlay + resume.
await page.click('#btn-pause');
check(await page.isVisible('#overlay-pause'), 'pause overlay opens');
await page.click('#btn-resume');
check(await page.isHidden('#overlay-pause'), 'resume closes pause');

// Settings overlay.
await page.click('#btn-pause');
await page.click('#btn-pause-settings');
check(await page.isVisible('#overlay-settings'), 'settings opens from pause');
await page.click('#btn-settings-close');
await page.click('#btn-resume');

// Persistence: progress saved.
const saved = await page.evaluate(() => !!localStorage.getItem('wordgrove:progress:v1'));
check(saved, 'progress persisted to localStorage');

check(errors.length === 0, 'no console errors' + (errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''));

await browser.close();
server.kill();
console.log(failed ? `\n${failed} FAILURES` : '\nALL SMOKE CHECKS PASSED');
process.exit(failed ? 1 : 0);
