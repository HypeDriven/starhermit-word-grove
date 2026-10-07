// Word Grove — platform adapter over the canonical StarHermit SDK
// (`starhermit-sdk.js`, global `StarHermit`, initialised from index.html
// before any module runs). Hosted = the SDK holds a launch token: account
// nickname, cloud save in `game:<slug>`, settings KV, control bindings,
// invite link and the read-only leaderboard. Without a token the game is
// fully offline and makes no network calls; tokens are never persisted.

export class Platform {
  constructor(sh = globalThis.StarHermit || null) {
    this.sh = sh;
    this.hosted = !!(sh && sh.token);
    this.userId = this.hosted ? sh.userId : null; // JWT sub — never a username
    this.slug = sh ? sh.slug : null;              // per-game scope; never hard-coded
    this.nickname = null;                         // account nickname, hosted only
    this.timeOffsetMs = 0; // serverTime - clientTime
    this.timeSynced = false;
    this.telemetryConsent = false;
    this.sessionEvents = []; // anonymous funnel events, kept in memory only
    this.syncState = 'offline'; // offline | saving | synced | error
    this.onSyncStatus = null;
    this.onAuthChange = null; // (signedIn) => void
    if (sh) {
      sh.on('saved', (ok) => this.hosted && this.setSyncStatus(ok ? 'synced' : 'error'));
      sh.on('auth', (e) => {
        if (e && e.signedIn) return;
        this.hosted = false;
        this.setSyncStatus('offline');
        this.onAuthChange?.(false);
      });
    }
  }

  // Round-trip-adjusted time sync with the host; falls back to local clock.
  async syncTime() {
    if (!this.hosted) return false;
    try {
      const t0 = Date.now();
      const res = await this.sh.api('/api/v1/time');
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

  // Renewal is the SDK's job (kept for the boot sequence).
  scheduleTokenRefresh() {}

  // ------------------------------------------------- identity & sign-in --

  async getProfile(userId) {
    if (!this.hosted || !userId) return null;
    return this.sh.profile(userId);
  }

  async nicknameFor(userId) {
    const p = await this.getProfile(userId);
    return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
  }

  async loadIdentity() {
    if (!this.hosted || !this.userId) return;
    this.nickname = await this.nicknameFor(this.userId);
  }

  canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
  signIn() { return !!(this.sh && this.sh.signIn()); }
  inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }

  // ------------------------------------------------ settings & controls --

  async getSettings() { return this.hosted ? this.sh.getSettings() : {}; }
  patchSettings(obj) { if (this.hosted) this.sh.patchSettings(obj); }
  async loadBindings(defaults) {
    if (this.hosted) return this.sh.loadBindings(defaults);
    return Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.slice()]));
  }

  // ------------------------------------------------------------ cloud save --

  setSyncStatus(state) {
    this.syncState = state;
    this.onSyncStatus?.(state);
  }

  // Remote-first load: the cloud slot mirrors the localStorage cache, and on
  // conflict the remote copy wins (see App.applyCloudSave).
  async loadCloudSave() {
    if (!this.hosted) return null;
    this.setSyncStatus('saving');
    const data = await this.sh.loadJSON();
    this.setSyncStatus('synced');
    return data;
  }

  queueCloudSave(data) {
    if (!this.hosted) return;
    this.setSyncStatus('saving');
    this.sh.saveJSON(data, 2000);
  }

  flushCloudSave() {
    if (!this.hosted) return Promise.resolve(false);
    return this.sh.flushSave(true);
  }

  attachCloudFlush() {
    if (!this.hosted) return;
    window.addEventListener('pagehide', () => this.flushCloudSave());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushCloudSave(); });
  }

  // ---------------------------------------------------------- leaderboards --

  // Post a finished round's total to the `high-score` board (score-script.js)
  // via StarHermit.submitScores; resolves {posted, rank} — the player's rank on
  // that board, or null. Signed out: no request.
  async postHighScore(total) {
    if (!this.hosted) return { posted: false, rank: null };
    try {
      const keys = await this.sh.submitScores({ 'high-score': total });
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await this.sh.leaderboard('high-score', { pageSize: 100 });
        const me = ((r && r.items) || []).find((i) => i.userId === this.sh.userId);
        return { posted: true, rank: me ? me.rank : null };
      } catch { return { posted: true, rank: null }; }
    } catch { return { posted: false, rank: null }; }
  }

  // Read the game's default platform board (the high-score board) and resolve
  // user ids to nicknames.
  async fetchLeaderboard({ friendsOnly = false, page = 1, pageSize = 10 } = {}) {
    if (!this.hosted) return { error: 'offline', entries: [] };
    const res = await this.sh.leaderboard(null, { page, pageSize, scope: friendsOnly ? 'friends' : undefined });
    if (!res.board) return { error: 'no-leaderboard', entries: [] };
    const entries = [];
    for (const e of res.items || []) {
      const userId = e.userId || null;
      const elapsed = e.elapsedSec ?? e.durationSec ?? null;
      entries.push({
        name: e.nickname || (userId ? await this.nicknameFor(userId) : String(e.name || 'Player')),
        score: typeof e.score === 'number' ? e.score : 0,
        elapsedSec: typeof elapsed === 'number' ? elapsed : null,
        me: !!userId && userId === this.userId,
      });
    }
    return { entries, me: res.me || null };
  }

  // Presence/activity have no route reachable by a launch token, and offline
  // play makes no network calls, so these are deliberate no-ops.
  startPresence() {}
  stopPresence() {}
  activityStart() {}
  activityEnd() {}

  // Anonymous funnel events only: start, tutorial step, round end, retry,
  // settings change, error category. Kept in memory (consent-gated).
  track(event, detail = {}) {
    if (!this.telemetryConsent) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this.sessionEvents.push({ event, detail, t: Date.now() });
  }
}
