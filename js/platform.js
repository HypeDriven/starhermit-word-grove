// Word Grove — platform adapter: host handshake, server-time sync, presence,
// telemetry consent, and hosted API calls. Everything degrades gracefully to
// fully-offline play; tokens are read from the launch URL and never persisted.

export class Platform {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('launchToken') || null;
    this.hosted = !!this.launchToken;
    this.timeOffsetMs = 0; // serverTime - clientTime
    this.timeSynced = false;
    this.telemetryConsent = false;
    this.sessionEvents = [];
    this.presenceTimer = null;
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

  async getProfile() {
    if (!this.hosted) return null;
    const p = await this.api('/api/v1/profile');
    return p && !p.error ? p : null;
  }

  // Throttled presence heartbeat while actively playing.
  startPresence() {
    if (!this.hosted || this.presenceTimer) return;
    const beat = () => this.api('/api/v1/presence', { method: 'POST', body: '{}' });
    beat();
    this.presenceTimer = setInterval(beat, 60000);
  }
  stopPresence() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  activityStart() { if (this.hosted) this.api('/api/v1/activity/start', { method: 'POST', body: '{}' }); }
  activityEnd() { if (this.hosted) this.api('/api/v1/activity/end', { method: 'POST', body: '{}' }); }

  // Anonymous funnel events only: start, tutorial step, round end, retry,
  // settings change, error category. No raw text, no pointer trails.
  track(event, detail = {}) {
    if (!this.telemetryConsent) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this.sessionEvents.push({ event, detail, t: Date.now() });
    if (this.hosted) {
      this.api('/api/v1/telemetry', {
        method: 'POST',
        body: JSON.stringify({ event, detail }),
      });
    }
  }

  async submitScore(payload) {
    if (!this.hosted) return { error: 'offline', casual: true };
    return this.api('/api/v1/scores', { method: 'POST', body: JSON.stringify(payload) });
  }

  async fetchBoard(boardId, scope = 'global') {
    if (!this.hosted) return { error: 'offline', casual: true, entries: [] };
    return this.api(`/api/v1/boards/${encodeURIComponent(boardId)}?scope=${scope}`);
  }
}
