// Word Grove — platform adapter: launch-token handshake (fragment first, query
// fallbacks for local dev), server-time sync, account nickname, cloud save,
// read-only leaderboards, and local-dev-only presence/telemetry. Everything
// degrades gracefully to fully-offline play; tokens are read from the launch
// URL and never persisted.

// The platform delivers the launch token in the URL fragment (#game_token=…);
// query params exist only as a local-dev convenience. Read once, then strip.
function readLaunchToken() {
  let token = null;
  if (location.hash.length > 1) {
    const frag = new URLSearchParams(location.hash.slice(1));
    token = frag.get('game_token');
    if (token) {
      const rest = location.hash.slice(1).split('&')
        .filter((p) => !p.startsWith('game_token=') && !p.startsWith('session_id='))
        .join('&');
      history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    }
  }
  if (!token) {
    const params = new URLSearchParams(location.search);
    token = params.get('launchToken') || params.get('token') || params.get('launch');
  }
  return token || null;
}

// Payload decode only (no signature verification; the host validates).
function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

const TOKEN_REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const TOKEN_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;

export class Platform {
  constructor() {
    this.launchToken = readLaunchToken();
    this.hosted = !!this.launchToken;
    const claims = this.launchToken ? decodeJwtPayload(this.launchToken) : null;
    this.userId = claims?.sub || null;      // JWT sub — never a username
    this.slug = claims?.game_scope || null; // per-game scope; never hard-coded
    this.nickname = null;                   // account nickname, hosted only
    this.profileCache = new Map();          // userId -> profile | null
    this.nicknameCache = new Map();         // userId -> display nickname
    this.timeOffsetMs = 0; // serverTime - clientTime
    this.timeSynced = false;
    this.telemetryConsent = false;
    this.sessionEvents = [];
    this.presenceTimer = null;
    this.refreshTimer = null;
    this.cloudTimer = null;
    this.cloudPending = null;
    this.syncState = 'offline'; // offline | saving | synced | error
    this.onSyncStatus = null;
    // server.js (the local dev server) speaks a legacy presence/telemetry
    // surface. It is only used for un-hosted local play; hosted StarHermit
    // exposes no such routes to launch tokens, so hosted mode never calls.
    this.localDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !this.hosted;
  }

  // Round-trip-adjusted time sync with the host; falls back to local clock.
  async syncTime() {
    if (!this.hosted) return false;
    try {
      const t0 = Date.now();
      const res = await this.api('/api/v1/time');
      const t1 = Date.now();
      if (res && typeof res.now === 'number') {
        this.timeOffsetMs = res.now - (t0 + t1) / 2;
        this.timeSynced = true;
        return true;
      }
    } catch { /* offline is fine */ }
    return false;
  }

  now() { return Date.now() + this.timeOffsetMs; }

  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.launchToken) headers['Authorization'] = 'Bearer ' + this.launchToken;
    let attempt = 0;
    while (attempt < 3) {
      try {
        const res = await fetch(path, { ...opts, headers });
        if (res.status === 429) {
          const wait = Math.min(4000, 500 * Math.pow(2, attempt++));
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          // Structured {"error": "..."} responses are recoverable UI states.
          return { error: body?.error || ('http-' + res.status) };
        }
        return body;
      } catch {
        attempt++;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    return { error: 'offline' };
  }

  // Scoped launch tokens may re-mint themselves; swap the new one in and keep
  // the Bearer header (and any WS query) on the fresh token.
  scheduleTokenRefresh() {
    if (!this.hosted || !this.slug) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshToken(), TOKEN_REFRESH_MS);
  }

  async refreshToken() {
    const res = await this.api(`/api/v1/games/${encodeURIComponent(this.slug)}/launch-token`, { method: 'POST', body: '{}' });
    if (res && !res.error && typeof res.token === 'string' && res.token) {
      this.launchToken = res.token;
      this.scheduleTokenRefresh();
    } else {
      this.refreshTimer = setTimeout(() => this.refreshToken(), TOKEN_RETRY_MS);
    }
  }

  // Account profile. Launch tokens are game-scoped: GET /api/v1/me is off
  // limits, so identity comes from the per-user profile route.
  async getProfile(userId) {
    if (!this.hosted || !userId) return null;
    if (this.profileCache.has(userId)) return this.profileCache.get(userId);
    const p = await this.api(`/api/v1/users/${encodeURIComponent(userId)}/profile`);
    const profile = p && !p.error ? p : null;
    this.profileCache.set(userId, profile);
    return profile;
  }

  async nicknameFor(userId) {
    if (this.nicknameCache.has(userId)) return this.nicknameCache.get(userId);
    const p = await this.getProfile(userId);
    const nick = (p && p.nickname) || ('Player ' + String(userId).slice(0, 8));
    this.nicknameCache.set(userId, nick);
    return nick;
  }

  async loadIdentity() {
    if (!this.hosted || !this.userId) return;
    const p = await this.getProfile(this.userId);
    this.nickname = (p && p.nickname) || ('Player ' + this.userId.slice(0, 8));
  }

  // ------------------------------------------------------------ cloud save --

  setSyncStatus(state) {
    this.syncState = state;
    this.onSyncStatus?.(state);
  }

  cloudPath() {
    return `/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`;
  }

  // Remote-first load: the cloud slot is a mirror of the localStorage cache,
  // and on conflict the remote copy wins.
  async loadCloudSave() {
    if (!this.hosted || !this.slug) return null;
    this.setSyncStatus('saving');
    try {
      const res = await fetch(this.cloudPath(), {
        headers: { Authorization: 'Bearer ' + this.launchToken },
      });
      if (res.status === 404) { this.setSyncStatus('synced'); return null; }
      if (!res.ok) { this.setSyncStatus('error'); return null; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const data = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
      this.setSyncStatus('synced');
      return data;
    } catch {
      this.setSyncStatus('error');
      return null;
    }
  }

  queueCloudSave(data) {
    if (!this.hosted || !this.slug) return;
    this.cloudPending = data;
    this.setSyncStatus('saving');
    clearTimeout(this.cloudTimer);
    this.cloudTimer = setTimeout(() => this.flushCloudSave(), CLOUD_DEBOUNCE_MS);
  }

  async flushCloudSave() {
    clearTimeout(this.cloudTimer);
    if (!this.hosted || !this.cloudPending) return;
    const data = this.cloudPending;
    this.cloudPending = null;
    this.setSyncStatus('saving');
    try {
      const json = new TextEncoder().encode(JSON.stringify(data));
      const body = JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', json)) });
      const res = await fetch(this.cloudPath(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.launchToken },
        body,
        keepalive: true, // small payload; survives the pagehide flush
      });
      this.setSyncStatus(res.ok ? 'synced' : 'error');
      if (!res.ok) this.cloudPending = this.cloudPending || data; // retry on next change
    } catch {
      this.setSyncStatus('error');
      this.cloudPending = this.cloudPending || data;
    }
  }

  attachCloudFlush() {
    if (!this.hosted) return;
    window.addEventListener('pagehide', () => this.flushCloudSave());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushCloudSave(); });
  }

  // ---------------------------------------------------------- leaderboards --

  // Clients never submit scores; the host's script owns the board. Read the
  // game record for its leaderboard id, then page the entries and resolve
  // user ids to nicknames.
  async fetchLeaderboard({ friendsOnly = false, page = 1, pageSize = 10 } = {}) {
    if (!this.hosted || !this.slug) return { error: 'offline', entries: [] };
    const info = await this.api(`/api/v1/games/${encodeURIComponent(this.slug)}`);
    if (info?.error) return { error: info.error, entries: [] };
    if (!info?.leaderboardId) return { error: 'no-leaderboard', entries: [] };
    const q = new URLSearchParams({ friendsOnly: String(friendsOnly), page: String(page), pageSize: String(pageSize) });
    const res = await this.api(`/api/v1/leaderboards/${encodeURIComponent(info.leaderboardId)}/entries?${q}`);
    if (res?.error) return { error: res.error, entries: [] };
    const rows = Array.isArray(res?.entries) ? res.entries : [];
    const entries = [];
    for (const e of rows) {
      const userId = e.userId || e.user_id || null;
      const elapsed = e.elapsedSec ?? e.durationSec ?? null;
      entries.push({
        name: userId ? await this.nicknameFor(userId) : String(e.name || 'Player'),
        score: typeof e.score === 'number' ? e.score : 0,
        elapsedSec: typeof elapsed === 'number' ? elapsed : null,
        me: !!userId && userId === this.userId,
      });
    }
    return { entries, me: info.me || null };
  }

  // Throttled presence heartbeat while actively playing. Local dev only: the
  // hosted platform exposes no per-game presence route to launch tokens.
  startPresence() {
    if (!this.localDev || this.presenceTimer) return;
    const beat = () => this.api('/api/v1/presence', { method: 'POST', body: '{}' });
    beat();
    this.presenceTimer = setInterval(beat, 60000);
  }
  stopPresence() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  activityStart() { if (this.localDev) this.api('/api/v1/activity/start', { method: 'POST', body: '{}' }); }
  activityEnd() { if (this.localDev) this.api('/api/v1/activity/end', { method: 'POST', body: '{}' }); }

  // Anonymous funnel events only: start, tutorial step, round end, retry,
  // settings change, error category. No raw text, no pointer trails.
  track(event, detail = {}) {
    if (!this.telemetryConsent) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this.sessionEvents.push({ event, detail, t: Date.now() });
    if (this.localDev) {
      this.api('/api/v1/telemetry', {
        method: 'POST',
        body: JSON.stringify({ event, detail }),
      });
    }
  }
}
