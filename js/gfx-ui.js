// Word Grove — Graphics section of the Settings panel. Builds its controls
// from the pure quality model (gfx.js) so labels, presets and the renderer agree.

import { PRESETS, CATEGORIES, presetTier, choosePreset, resolve, describe, detectPreset } from './gfx.js';
import { gfxStrings, pickLocale } from './gfx-i18n.js';

const fill = (s, tier) => s.replace('{tier}', tier);

export class GraphicsPanel {
  constructor(app) {
    this.app = app;
    this.locale = pickLocale(navigator.language);
    this.t = gfxStrings(this.locale);
    this.root = document.getElementById('gfx-controls');
    this.timer = null;
  }

  get saved() {
    const s = this.app.settings;
    if (!s.graphics || typeof s.graphics !== 'object') s.graphics = { preset: 'auto' };
    return s.graphics;
  }

  detected() {
    return this.app.renderer?.detected || detectPreset('', false);
  }

  build() {
    const t = this.t;
    document.getElementById('gfx-legend').textContent = t.graphics;
    const tier = (k) => t.tier[k] || k;
    const row = (label, control, cls = 'select-row') => `<label class="${cls}">${label} ${control}</label>`;
    let html = row(`<span>${t.quality}</span>`,
      `<select id="set-quality" data-gfx="preset"><option value="auto"></option>${PRESETS.map((p) => `<option value="${p}">${tier(p)}</option>`).join('')}</select>`);
    html += `<label class="slider-row gfx-scale-row"><span>${t.renderScale}</span>
      <span class="gfx-scale"><input type="range" id="gfx-render-scale" data-gfx="render_scale" min="50" max="200" step="5">
      <output id="gfx-render-scale-value" for="gfx-render-scale">100%</output></span></label>`;
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      html += row(`<span>${t.cat[cat]}</span>`,
        `<select id="gfx-${cat}" data-gfx="${cat}"><option value="preset"></option>${tiers.map((v) => `<option value="${v}">${tier(v)}</option>`).join('')}</select>`);
    }
    html += `<label class="check-row"><input type="checkbox" id="gfx-adaptive" data-gfx="adaptive"> ${t.adaptive}</label>`;
    html += `<label class="check-row"><input type="checkbox" id="gfx-show-fps" data-gfx="show_fps"> ${t.showFps}</label>`;
    html += `<p class="fine gfx-summary" id="gfx-summary" aria-live="polite"></p>`;
    html += `<p class="fine gfx-note" id="gfx-post-note" hidden>${t.postFailed}</p>`;
    this.root.innerHTML = html;
    this.root.lang = this.locale;

    this.root.addEventListener('change', (e) => this.onChange(e.target));
    const scale = document.getElementById('gfx-render-scale');
    scale.addEventListener('input', () => { document.getElementById('gfx-render-scale-value').textContent = `${scale.value}%`; });
    this.sync();
  }

  onChange(el) {
    const key = el.dataset.gfx;
    if (!key) return;
    let g = this.saved;
    if (key === 'preset') g = choosePreset(g, el.value);
    else if (key === 'render_scale') g.render_scale = Math.max(0.5, Math.min(2, Number(el.value) / 100));
    else if (key === 'adaptive' || key === 'show_fps') g[key] = el.checked;
    else if (el.value === 'preset') delete g[key];
    else g[key] = el.value;
    this.app.settings.graphics = g;
    this.app.saveSettings();
    this.app.renderer?.setGraphics(g);
    this.sync();
    this.app.platform?.track('settings-change', {});
  }

  /** Refresh every control from the saved settings and the resolved tiers. */
  sync() {
    if (!this.root.firstChild) return;
    const t = this.t;
    const g = this.saved;
    const det = this.detected();
    const r = resolve(g, det);
    const tier = (k) => t.tier[k] || k;
    const q = document.getElementById('set-quality');
    q.options[0].textContent = fill(t.auto, tier(det));
    q.value = PRESETS.includes(g.preset) ? g.preset : 'auto';
    const pct = Math.round((Number(g.render_scale) || 1) * 100);
    document.getElementById('gfx-render-scale').value = String(pct);
    document.getElementById('gfx-render-scale-value').textContent = `${pct}%`;
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const sel = document.getElementById(`gfx-${cat}`);
      sel.options[0].textContent = fill(t.fromPreset, tier(presetTier(r.preset, cat)));
      sel.value = tiers.includes(g[cat]) ? g[cat] : 'preset';
    }
    document.getElementById('gfx-adaptive').checked = g.adaptive !== false;
    document.getElementById('gfx-show-fps').checked = !!g.show_fps;
    this.refreshSummary();
  }

  refreshSummary() {
    const el = document.getElementById('gfx-summary');
    if (!el) return;
    const tr = (k, d) => this.t.sum[k] || d;
    const rd = this.app.renderer;
    const r = resolve(this.saved, this.detected());
    let text;
    if (rd?.graphicsInfo) {
      const info = rd.graphicsInfo(tr);
      text = `${info.gpu || this.t.unknownGpu} · ${info.summary}`;
      document.getElementById('gfx-post-note').hidden = !info.postFailed;
    } else {
      text = `${this.t.unknownGpu} · ${describe(r, null, tr)}`;
    }
    el.textContent = text;
    el.dataset.preset = r.preset;
  }

  /** While the panel is open, keep the summary current (adaptive scale, resize). */
  opened() {
    this.sync();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (document.getElementById('overlay-settings')?.hidden) { clearInterval(this.timer); this.timer = null; return; }
      this.refreshSummary();
    }, 700);
  }
}
