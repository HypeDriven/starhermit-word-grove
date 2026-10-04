// Platform adapter + canonical StarHermit SDK with a stubbed fetch and a fake
// launch fragment: token read, profile name, cloud save in game:<slug>,
// settings KV patch, control overrides — and zero fetches standalone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Platform } from '../js/platform.js';

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
  const state = { save: null, settings: {} };
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization });
    if (url === '/api/v1/time') return json({ now: Date.now() });
    if (url === `/api/v1/users/${USER}/profile`) return json({ nickname: 'Gardener Gil' });
    if (url.startsWith('/api/v1/me/cloud-saves/')) {
      if (method === 'PUT') {
        state.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        return new Response(null, { status: 204 });
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
