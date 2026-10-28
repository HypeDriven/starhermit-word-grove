// The look of the HUD, screens, sheets and toasts: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects, check boxes, text fields) take. The runtime's high
// contrast option is the old html.high-contrast token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  ink: "#24301f", "ink-soft": "#4a5a42", paper: "rgba(252, 250, 242, 0.94)", "paper-solid": "#fcfaf2", accent: "#3f7a3a", "accent-strong": "#2c5a28",
  "accent-warm": "#c9762e", danger: "#b04030", "focus-ring": "#ffb400", cell: "#fdfbf3", "cell-hidden": "#3a4a34", "cell-reveal": "#fff8dd", "cell-flash": "#ffe9a8",
  light: "#fdfbf3", "light-dim": "#e8e0c8", gold: "#ffd76a",
};
/** html.high-contrast. */
const CONTRAST: Tokens = {
  ink: "#000000", "ink-soft": "#111111", paper: "rgba(255, 255, 255, 0.98)", "paper-solid": "#ffffff", accent: "#005a00", "accent-strong": "#003d00",
  cell: "#ffffff", "cell-hidden": "#000000", "cell-reveal": "#ffff00", "cell-flash": "#ffff00", "focus-ring": "#0000ff",
};
let current: Tokens = { ...BASE };
let css: ui.CssStyles | null = null;
let key = "";
export function initStyles(): void {
  css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "serif" });
  key = "";
  applyTokens(false);
}
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key || !css) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens({ ...css.tokens, ...current });
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus-ring", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#9a9a88", radius: 4 } } },
    dialog: { background: "$paper-solid", radius: 14, padding: 20, parts: { backdrop: { background: "rgba(15, 25, 12, 0.55)" } } },
  });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: current.ink!, muted: current["ink-soft"]!, panel: current["paper-solid"]!, control: "#f1ede0", hovered: "#e6e1d0", pressed: "#d9d3c0",
    field: "#ffffff", accent: current.accent!, focus: current["focus-ring"]!, outline: "#b8b4a4",
  });
}
export function token(name: string): string { return current[name] ?? "#000000"; }
