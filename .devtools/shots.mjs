// Quick visual iteration: capture game screens in several viewports.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 8138;
const server = spawn('node', ['../server.js', String(PORT)], { cwd: new URL('.', import.meta.url).pathname, stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

async function shot(name, viewport, actions) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (actions) await actions(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: name });
  if (errors.length) console.log(name, 'PAGE ERRORS:', errors.join(' | '));
  await page.close();
  console.log('captured', name);
}

// Desktop game view (journey stage 2, mid-round with one word planted).
await shot('v-desktop.png', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => {
    const app = window.wordGrove;
    app.progress.tutorialDone = true;
    app.startJourney(1);
    const t = app.session.state.targets;
    setTimeout(() => app.session.submitWord(t[0]), 800);
  });
  await page.waitForTimeout(1800);
});

// Portrait mobile.
await shot('v-portrait.png', { width: 390, height: 844 }, async (page) => {
  await page.evaluate(() => { const app = window.wordGrove; app.progress.tutorialDone = true; app.startJourney(2); });
  await page.waitForTimeout(1200);
});

// Landscape mobile.
await shot('v-landscape.png', { width: 844, height: 390 }, async (page) => {
  await page.evaluate(() => { const app = window.wordGrove; app.progress.tutorialDone = true; app.startJourney(2); });
  await page.waitForTimeout(1200);
});

// Night theme title.
await shot('v-night.png', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => { const app = window.wordGrove; app.progress.flowers = 300; app.progress.selectedTheme = 'night'; app.renderer?.setTheme('night'); });
  await page.waitForTimeout(800);
});

await browser.close();
server.kill();
