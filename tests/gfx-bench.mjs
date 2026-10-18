// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Expert practice (7-letter wheel, 9 grid words) and keeps playing like a keyboard player — the
// first letter through its on-screen wheel tile, the rest as key presses, Enter to plant the word, with
// a Shuffle now and then — so tiles lift and spin, the selection path glows, flowers grow, bursts fly
// and the grove sways. The words are read from the round like the Hint button does; a finished round
// is retried from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#btn-settings', { state: 'visible', timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#overlay-settings', { state: 'visible' });
  await page.locator('#set-quality').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.getElementById('scene-canvas').dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForSelector('#overlay-settings', { state: 'hidden' });
}

const state = (page) => page.evaluate(() => {
  const s = window.wordGrove?.session?.state;
  if (!s) return null;
  return { status: s.status, targets: s.targets.slice(), found: Object.keys(s.found), letters: s.letters.slice() };
});

async function blur(page) {
  const bb = await page.locator('#word-tray').boundingBox();
  if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {});
}

async function step(page, n) {
  const st = await state(page);
  if (!st) return;
  if (st.status !== 'active') {
    if (await page.locator('#btn-results-retry').isVisible()) {
      await page.click('#btn-results-retry');
      await page.waitForFunction(() => window.wordGrove?.session?.state?.status === 'active', null, { timeout: 15000 });
    }
    return;
  }
  if (n % 5 === 4) { await page.click('#btn-shuffle'); return; }
  const word = st.targets.find((w) => !st.found.includes(w));
  if (!word) return;
  const i0 = st.letters.indexOf(word[0]);
  if (i0 < 0) return;
  await page.locator('.wheel-tile-btn').nth(i0).focus();
  await page.keyboard.press('Space');
  await blur(page);
  for (const ch of word.slice(1)) { await page.keyboard.press(ch); await page.waitForTimeout(80); }
  await page.keyboard.press('Enter');
}

export async function start(page) {
  await page.click('#btn-practice');
  await page.waitForSelector('#overlay-setup', { state: 'visible' });
  await page.locator('#setup-body input[name="practice-diff"][value="expert"]').check();
  await page.click('#btn-setup-start');
  await page.waitForSelector('#screen-game', { state: 'visible' });
  await page.waitForFunction(() => window.wordGrove?.session?.state?.status === 'active', null, { timeout: 15000 });
  let open = true, n = 0;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page, n++); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error('hook:', e.message.split('\n')[0]); }
      await new Promise((r) => setTimeout(r, 700));
    }
  })();
  await page.waitForTimeout(1500);
}
