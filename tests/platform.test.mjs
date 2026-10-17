// Platform adapter + canonical StarHermit SDK with a stubbed fetch and a fake
// launch fragment: token read, profile name, cloud save in game:<slug>,
// settings KV patch, control overrides — and zero fetches standalone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Platform } from '../js/platform.js';
import { mergeProgress, mergeBoards, DEFAULT_PROGRESS } from '../js/storage.js';

const SDK_SRC = fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
function loadSdk() {
  const m = { exports: {} };
  new Function('module', 'exports', SDK_SRC)(m, m.exports);
  return m.exports;
}
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SLUG = 'grove-test';
const USER = 'abcdef12-3456-7890-abcd-ef1234567890';
const JWT = 'x.' + b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.y';
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };

function fakeWindow(hash) {
  return {
    location: { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' },
    history: { state: null, replaceState(_s, _t, url) { this.url = url; } },
  };
}
function stubServer() {
  const calls = [];
  const state = { save: null, etag: null, version: 0, settings: {} };
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization });
    if (url === '/api/v1/time') return json({ now: Date.now() });
    if (url === `/api/v1/users/${USER}/profile`) return json({ nickname: 'Gardener Gil' });
    if (url.startsWith('/api/v1/me/cloud-saves/')) {
      // Versioned slot: conditional writes (If-Match / If-None-Match) answer 412 on a stale version.
      if (url.endsWith('/info')) return json(state.save ? { exists: true, etag: state.etag } : { exists: false });
      if (method === 'PUT') {
        const h = init.headers || {};
        if ((h['If-Match'] && h['If-Match'] !== state.etag) || (h['If-None-Match'] === '*' && state.save)) {
          return new Response(JSON.stringify({ error: 'precondition_failed', etag: state.etag }), { status: 412, headers: { 'content-type': 'application/json' } });
        }
        state.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        state.etag = '"v' + ++state.version + '"';
        return json({ etag: state.etag });
      }
      return state.save ? new Response(state.save) : new Response(null, { status: 404 });
    }
    if (url === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') Object.assign(state.settings, JSON.parse(init.body).settings);
      return json({ settings: state.settings });
    }
    if (url === `/api/v1/games/${SLUG}/controls`) return json({ actions: [{ action: 'shuffle', codes: ['KeyX'] }] });
    return new Response(null, { status: 404 });
  };
  return { fetch, calls, state };
}

test('hosted: token, profile, cloud save game:<slug>, settings, controls', async () => {
  const srv = stubServer();
  const win = fakeWindow('#game_token=' + JWT);
  const sh = loadSdk().create({ window: win, fetch: srv.fetch, ...noTimers });
  sh.init();
  assert.equal(sh.token, JWT);
  assert.equal(win.history.url, '/');
  const p = new Platform(sh);
  assert.ok(p.hosted);
  assert.equal(p.slug, SLUG);
  await p.loadIdentity();
  assert.equal(p.nickname, 'Gardener Gil');

  p.queueCloudSave({ progress: { flowers: 12 }, boards: { boards: {} } });
  await p.flushCloudSave();
  const put = srv.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG));
  assert.equal((await p.loadCloudSave()).progress.flowers, 12);
  assert.equal(p.syncState, 'synced');

  p.patchSettings({ textSize: 'large' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(srv.state.settings, { textSize: 'large' });
  assert.equal((await p.getSettings()).textSize, 'large');
  assert.deepEqual(await p.loadBindings({ shuffle: ['KeyS'], hint: ['KeyH'] }), { shuffle: ['KeyX'], hint: ['KeyH'] });
  assert.match(p.inviteLink(), new RegExp(`/game-invite/${USER}/${SLUG}$`));
  assert.ok(srv.calls.every((c) => c.auth === 'Bearer ' + JWT));

  let seen = null;
  p.onAuthChange = (v) => { seen = v; };
  sh.signOut('expired');
  assert.equal(seen, false);
  assert.equal(p.hosted, false);
});

test('standalone: no token means no fetch at all', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow(''), fetch: srv.fetch });
  sh.init();
  const p = new Platform(sh);
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), false);
  assert.equal(await p.syncTime(), false);
  await p.loadIdentity();
  p.queueCloudSave({ progress: {} });
  await p.flushCloudSave();
  p.patchSettings({ muted: true });
  assert.deepEqual(await p.getSettings(), {});
  assert.equal(await p.loadCloudSave(), null);
  assert.equal((await p.fetchLeaderboard()).error, 'offline');
  await p.loadBindings({ hint: ['KeyH'] });
  p.telemetryConsent = true;
  p.track('start');
  assert.equal(srv.calls.length, 0);
});

test('save conflict: a stale write raises onConflict; reload + merge + save lands', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  sh.init();
  const p = new Platform(sh);
  assert.equal(await p.loadCloudSave(), null);
  const other = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  other.init();
  await other.loadJSON();
  assert.equal(await other.writeSave(JSON.stringify({ progress: { ...DEFAULT_PROGRESS, journey: { 1: { score: 300, stars: 2 } }, flowers: 9 } })), true);
  let mine = { progress: { ...DEFAULT_PROGRESS, journey: { 0: { score: 500, stars: 3 } }, flowers: 4 } };
  let conflicts = 0;
  p.onConflict = async () => {
    conflicts++;
    const latest = await p.loadCloudSave();
    mine = { progress: mergeProgress(latest.progress, mine.progress) };
    p.queueCloudSave(mine);
    await p.sh.flushSave();
  };
  p.queueCloudSave(mine);
  await sh.flushSave();
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  assert.equal(conflicts, 1);
  const back = await sh.loadJSON();
  assert.deepEqual(Object.keys(back.progress.journey).sort(), ['0', '1']);
  assert.equal(back.progress.flowers, 9);
});

test('mergeProgress / mergeBoards keep both devices\' progress', () => {
  const remote = { ...DEFAULT_PROGRESS, journey: { 0: { score: 100, stars: 1, bestSec: 90 }, 2: { score: 50, stars: 1 } }, flowers: 20,
    totals: { words: 30, bonus: 2, invalid: 1, sessions: 3, playSec: 100 }, achievements: { 'first-bloom': 10 }, dailyDays: ['2026-10-01'],
    challengeBest: { 'swift-1': { score: 400 } }, mechanicsUsed: { hint: true }, updatedAt: 5, selectedTheme: 'rain' };
  const local = { ...DEFAULT_PROGRESS, journey: { 0: { score: 80, stars: 3, bestSec: 60 }, 1: { score: 70, stars: 2 } }, flowers: 12,
    totals: { words: 40, bonus: 1, invalid: 0, sessions: 2, playSec: 50 }, achievements: { 'first-bloom': 4, 'quick-study': 6 }, dailyDays: ['2026-10-02'],
    challengeBest: { 'swift-1': { score: 300 }, 'bare-1': { score: 90 } }, mechanicsUsed: { shuffle: true }, updatedAt: 3, selectedTheme: 'dawn', tutorialDone: true };
  const m = mergeProgress(remote, local);
  assert.deepEqual(Object.keys(m.journey).sort(), ['0', '1', '2']);
  assert.equal(m.journey[0].score, 100);
  assert.equal(m.journey[0].stars, 3);
  assert.equal(m.journey[0].bestSec, 60);
  assert.equal(m.flowers, 20);
  assert.deepEqual(m.totals, { words: 40, bonus: 2, invalid: 1, sessions: 3, playSec: 100 });
  assert.deepEqual(m.achievements, { 'first-bloom': 4, 'quick-study': 6 });
  assert.deepEqual(m.dailyDays, ['2026-10-01', '2026-10-02']);
  assert.deepEqual(m.challengeBest, { 'swift-1': { score: 400 }, 'bare-1': { score: 90 } });
  assert.deepEqual(m.mechanicsUsed, { hint: true, shuffle: true });
  assert.equal(m.selectedTheme, 'dawn');
  assert.equal(m.tutorialDone, true);
  const b = mergeBoards({ version: 1, boards: { d: { entries: [{ sessionId: 'a', score: 3 }] } } },
    { version: 1, boards: { d: { entries: [{ sessionId: 'b', score: 7 }, { sessionId: 'a', score: 3 }] } } });
  assert.deepEqual(b.boards.d.entries.map((e) => e.sessionId), ['b', 'a']);
});

test('hosted domain without a token offers sign-in (UUID host)', () => {
  const srv = stubServer();
  const win = fakeWindow('');
  win.location.hostname = '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com';
  win.location.origin = 'https://' + win.location.hostname;
  const sh = loadSdk().create({ window: win, fetch: srv.fetch, ...noTimers });
  sh.init();
  const p = new Platform(sh);
  assert.equal(p.canSignIn(), true);
  assert.equal(srv.calls.length, 0);
});
