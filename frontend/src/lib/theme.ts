/**
 * Colour themes and background patterns. Both are saved on this device and
 * applied to <html> before the first paint (main.tsx): the theme's palette as
 * CSS variables plus data-theme (for the few per-theme tweaks in index.css),
 * the pattern as the --pattern-img mask plus a strength.
 *
 * Palettes are inspired by stippled risograph prints: deep teal, mint,
 * apricot and off-white paper.
 */
import { patternUrl, type PatternStyle } from "./patterns";

export const THEMES = [
  { id: "paper",    label: "Paper",     hint: "Light — off-white and teal ink (default)", base: "#f7f7f2", raised: "#ffffff", accent: "#0f2a30", dots: "#e28046", light: true },
  { id: "dark",     label: "Dark",      hint: "Paper's dark twin — graphite, teal and apricot", base: "#121416", raised: "#1e2124", accent: "#5ebab8", dots: "#e28046" },
  { id: "midnight", label: "Midnight",  hint: "Indigo on ink — the original dark",  base: "#0a0c12", raised: "#1a1d27", accent: "#6366f1", dots: "#6366f1" },
  { id: "deepsea",  label: "Deep sea",  hint: "Dark teal with warm orange",    base: "#09262b", raised: "#123a41", accent: "#f29b5f", dots: "#f29b5f" },
  { id: "sage",     label: "Sage",      hint: "Forest green with fresh mint",  base: "#0c1e19", raised: "#173229", accent: "#95d1ab", dots: "#95d1ab" },
  { id: "ember",    label: "Ember",     hint: "Warm charcoal and apricot",     base: "#1a1310", raised: "#2b201b", accent: "#f29b5f", dots: "#f29b5f" },
  // Palettes picked from swatch sets: the darkest tone becomes the window, the
  // next the cards, and the brightest tone the accent that has to be read.
  { id: "mono",     label: "Mono",      hint: "Black through grey — nothing but contrast", base: "#0b0b0b", raised: "#1d1d1d", accent: "#c9c7c4", dots: "#787674" },
  { id: "harbour",  label: "Harbour",   hint: "Ink blue with desert sand",     base: "#0d1f2d", raised: "#1b3345", accent: "#e4c3ad", dots: "#9ea3b0" },
  { id: "orchid",   label: "Orchid",    hint: "Deep pine, dusty mauve, blossom", base: "#16231f", raised: "#293a3d", accent: "#d0a5c0", dots: "#8e7c93" },
  { id: "bordeaux", label: "Bordeaux",  hint: "Night bordeaux with tropical mint", base: "#2a0410", raised: "#4a051c", accent: "#52ffb8", dots: "#fab2ea" },
  { id: "celadon",  label: "Celadon",   hint: "Carbon black, olive and sea glass", base: "#14150f", raised: "#23261e", accent: "#aad2ba", dots: "#6b8f71" },
  { id: "velvet",   label: "Velvet",    hint: "Midnight violet with mauve",    base: "#1a0a24", raised: "#301545", accent: "#caa8f5", dots: "#b27c66" },
  { id: "mulberry", label: "Mulberry",  hint: "Coffee bean, mocha and petal",  base: "#241715", raised: "#3c2729", accent: "#d9b8c4", dots: "#957186" },
  { id: "almond",   label: "Almond",    hint: "Light — powder blush on warm white", base: "#fdf6f4", raised: "#ffffff", accent: "#8a5344", dots: "#d3ab9e", light: true },
  { id: "alabaster", label: "Alabaster", hint: "Light — silver and rosy granite", base: "#f3eff1", raised: "#ffffff", accent: "#544e52", dots: "#9a8f97", light: true },
  { id: "oat",      label: "Oat",       hint: "Light — pale oak, olive and mocha", base: "#f7f0f5", raised: "#ffffff", accent: "#52483f", dots: "#8f857d", light: true },
  { id: "periwinkle", label: "Periwinkle", hint: "Light — icy aqua with slate blue", base: "#eef8f4", raised: "#ffffff", accent: "#553fae", dots: "#7e78d2", light: true },
] as const;

/** Light palettes: the app's chrome changes with them (see :root[data-light] in index.css). */
export const isLight = (id: ThemeId) => THEMES.some(t => t.id === id && "light" in t && t.light);
export type ThemeId = (typeof THEMES)[number]["id"];

/** Every palette sets the same variables, so switching never leaves one behind. */
const DARK_STATUS = { "--success": "#22c55e", "--warning": "#f59e0b" };
const DARK_TONES = {
  // Text tones for tags, badges and headers — bright enough on dark surfaces.
  "--tone-amber": "#fbbf24", "--tone-green": "#34d399", "--tone-blue": "#7dd3fc",
  "--tone-violet": "#c4b5fd", "--tone-red": "#fca5a5", "--yellow": "#f59e0b",
  "--card-shadow": "0 10px 34px rgba(0, 0, 0, 0.28)",
};
//: Tags, badges and headers on a pale ground: deep enough to read (WCAG AA).
const LIGHT_TONES = {
  "--success": "#15803d", "--warning": "#b45309",
  "--tone-amber": "#a15c07", "--tone-green": "#047857", "--tone-blue": "#0369a1",
  "--tone-violet": "#6d28d9", "--tone-red": "#b91c1c", "--yellow": "#a15c07",
};

/** One palette from the few colours that make it. The rest follows the same rules for every theme. */
function palette(spec: {
  base: string; raised: string; ink: string; accent: string; hover: string; onAccent: string;
  text: string; muted: string; dots: string; alpha?: string; highlight?: string; light?: boolean;
}): Record<string, string> {
  const rgb = (hex: string) => {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  };
  return {
    "--base-rgb": rgb(spec.base), "--raised-rgb": rgb(spec.raised), "--ink-rgb": rgb(spec.ink),
    "--accent-rgb": rgb(spec.accent), "--primary-hover": spec.hover, "--on-primary": spec.onAccent,
    "--text": spec.text, "--muted": spec.muted,
    "--pattern-rgb": rgb(spec.dots), "--pattern-alpha": spec.alpha ?? (spec.light ? "0.38" : "0.2"),
    "--surface": spec.light ? "rgba(255, 255, 255, 0.72)" : "rgba(var(--raised-rgb), 0.60)",
    "--highlight-rgb": rgb(spec.highlight ?? spec.dots),
    ...(spec.light
      ? { ...LIGHT_TONES, "--card-shadow": "0 6px 22px rgba(20, 18, 20, 0.10)" }
      : { ...DARK_STATUS, ...DARK_TONES }),
  };
}

export const PALETTES: Record<ThemeId, Record<string, string>> = {
  midnight: {
    "--base-rgb": "10, 12, 18", "--raised-rgb": "26, 29, 39", "--ink-rgb": "255, 255, 255",
    "--accent-rgb": "99, 102, 241", "--primary-hover": "#818cf8", "--on-primary": "#fff",
    "--text": "#e1e4ed", "--muted": "#8b8fa3", "--pattern-rgb": "99, 102, 241", "--pattern-alpha": "0.22",
    "--surface": "rgba(var(--raised-rgb), 0.60)", ...DARK_STATUS, ...DARK_TONES,
    "--highlight-rgb": "99, 102, 241",
  },
  deepsea: {
    "--base-rgb": "9, 38, 43", "--raised-rgb": "18, 58, 65", "--ink-rgb": "222, 244, 236",
    "--accent-rgb": "242, 155, 95", "--primary-hover": "#f7b98c", "--on-primary": "#0d2b30",
    "--text": "#e6f1ed", "--muted": "#86a6a3", "--pattern-rgb": "242, 155, 95", "--pattern-alpha": "0.2",
    "--surface": "rgba(var(--raised-rgb), 0.60)", ...DARK_STATUS, ...DARK_TONES,
    "--highlight-rgb": "242, 155, 95",
  },
  sage: {
    "--base-rgb": "12, 30, 25", "--raised-rgb": "23, 50, 41", "--ink-rgb": "226, 246, 234",
    "--accent-rgb": "149, 209, 171", "--primary-hover": "#b4e2c5", "--on-primary": "#0d2a22",
    "--text": "#e5f2eb", "--muted": "#8bada0", "--pattern-rgb": "149, 209, 171", "--pattern-alpha": "0.18",
    "--surface": "rgba(var(--raised-rgb), 0.60)", ...DARK_STATUS, ...DARK_TONES,
    "--highlight-rgb": "149, 209, 171",
  },
  ember: {
    "--base-rgb": "26, 19, 16", "--raised-rgb": "43, 32, 27", "--ink-rgb": "255, 238, 224",
    "--accent-rgb": "242, 155, 95", "--primary-hover": "#f6b385", "--on-primary": "#2a1a10",
    "--text": "#f4ebe3", "--muted": "#a8968a", "--pattern-rgb": "242, 155, 95", "--pattern-alpha": "0.2",
    "--surface": "rgba(var(--raised-rgb), 0.60)", ...DARK_STATUS, ...DARK_TONES,
    "--highlight-rgb": "242, 155, 95",
  },
  dark: {
    // Neutral graphite (no colour cast), the brand's teal lifted to read on dark, and Paper's apricot dots.
    "--base-rgb": "18, 20, 22", "--raised-rgb": "30, 33, 36", "--ink-rgb": "236, 242, 240",
    "--accent-rgb": "94, 186, 184", "--primary-hover": "#8fd3d1", "--on-primary": "#0b1f22",
    "--text": "#e6ebea", "--muted": "#8e9a99", "--pattern-rgb": "226, 128, 70", "--pattern-alpha": "0.2",
    "--surface": "rgba(var(--raised-rgb), 0.60)", ...DARK_STATUS, ...DARK_TONES,
    "--highlight-rgb": "226, 128, 70",
  },
  paper: {
    "--base-rgb": "247, 247, 242", "--raised-rgb": "255, 255, 255", "--ink-rgb": "15, 42, 48",
    "--accent-rgb": "15, 42, 48", "--primary-hover": "#2c6770", "--on-primary": "#f7f7f2",
    "--text": "#13262b", "--muted": "#5d7073", "--pattern-rgb": "226, 128, 70", "--pattern-alpha": "0.38",
    "--surface": "rgba(255, 255, 255, 0.72)", "--success": "#15803d", "--warning": "#b45309",
    // Deep tones so tags and headers read on off-white (WCAG AA against the paper).
    "--tone-amber": "#a15c07", "--tone-green": "#047857", "--tone-blue": "#0369a1",
    "--tone-violet": "#6d28d9", "--tone-red": "#b91c1c", "--yellow": "#a15c07",
    // Highlighted surfaces use the warm apricot of the dots: the near-black teal accent would tint them grey.
    "--highlight-rgb": "226, 128, 70",
    "--card-shadow": "0 6px 22px rgba(15, 42, 48, 0.09)",
  },

  // ── From the swatch sets ──────────────────────────────────────────────────
  mono: palette({
    base: "#0b0b0b", raised: "#1d1d1d", ink: "#f2f2f2", accent: "#c9c7c4", hover: "#e2e0dd",
    onAccent: "#141414", text: "#ececec", muted: "#9b9997", dots: "#787674", alpha: "0.24",
  }),
  harbour: palette({
    base: "#0d1f2d", raised: "#1b3345", ink: "#e7eef3", accent: "#e4c3ad", hover: "#f0d6c5",
    onAccent: "#16293a", text: "#e6edf2", muted: "#93a6b4", dots: "#9ea3b0",
  }),
  orchid: palette({
    base: "#16231f", raised: "#293a3d", ink: "#f0e6ee", accent: "#d0a5c0", hover: "#e3c0d6",
    onAccent: "#221a20", text: "#eee7ec", muted: "#9d95a3", dots: "#8e7c93",
  }),
  bordeaux: palette({
    base: "#2a0410", raised: "#4a051c", ink: "#ffe7f3", accent: "#52ffb8", hover: "#8effd1",
    onAccent: "#04281a", text: "#f7e2ea", muted: "#c090a3", dots: "#fab2ea", alpha: "0.18",
  }),
  celadon: palette({
    base: "#14150f", raised: "#23261e", ink: "#e9f6ee", accent: "#aad2ba", hover: "#c6e4d1",
    onAccent: "#122019", text: "#e7efe8", muted: "#93a596", dots: "#6b8f71",
  }),
  velvet: palette({
    base: "#1a0a24", raised: "#301545", ink: "#f1e6ff", accent: "#caa8f5", hover: "#ddc6fb",
    onAccent: "#1d0b2b", text: "#efe6f7", muted: "#a693b8", dots: "#b27c66",
  }),
  mulberry: palette({
    base: "#241715", raised: "#3c2729", ink: "#f7e9ee", accent: "#d9b8c4", hover: "#e9d0d9",
    onAccent: "#2a1a1d", text: "#f2e6e9", muted: "#ad9499", dots: "#957186",
  }),
  almond: palette({
    base: "#fdf6f4", raised: "#ffffff", ink: "#3b2a24", accent: "#8a5344", hover: "#6f4034",
    onAccent: "#fff8f5", text: "#33241f", muted: "#7a625a", dots: "#d3ab9e", light: true,
  }),
  alabaster: palette({
    base: "#f3eff1", raised: "#ffffff", ink: "#2e2a2c", accent: "#544e52", hover: "#3b3639",
    onAccent: "#f7f4f5", text: "#2b2729", muted: "#6d666a", dots: "#9a8f97", light: true,
  }),
  oat: palette({
    base: "#f7f0f5", raised: "#ffffff", ink: "#332b28", accent: "#52483f", hover: "#3a322c",
    onAccent: "#fbf6f2", text: "#2f2824", muted: "#6f645d", dots: "#8f857d", light: true,
  }),
  periwinkle: palette({
    base: "#eef8f4", raised: "#ffffff", ink: "#241d4a", accent: "#553fae", hover: "#43318b",
    onAccent: "#f6f3ff", text: "#231d42", muted: "#5f5b86", dots: "#7e78d2", light: true,
  }),
};

export const PATTERNS: { id: PatternStyle | "none"; label: string; hint: string }[] = [
  { id: "flow",     label: "Flow",     hint: "Dots following a current" },
  { id: "clusters", label: "Clusters", hint: "Dense blobs, scattered edges" },
  { id: "drift",    label: "Drift",    hint: "Sparse dots along arcs" },
  { id: "none",     label: "None",     hint: "Plain backgrounds" },
];
export type PatternId = (typeof PATTERNS)[number]["id"];

export const STRENGTHS = [
  { id: "subtle", label: "Subtle", scale: 1 },
  { id: "bold",   label: "Bold",   scale: 1.9 },
] as const;
export type StrengthId = (typeof STRENGTHS)[number]["id"];

/** A saved choice: a theme, or "auto" to follow the system's light/dark setting (Paper ↔ Dark). */
export type ThemeChoice = ThemeId | "auto";
export const AUTO_THEME = { id: "auto" as const, label: "Match system", hint: "Paper by day, Dark at night — follows your system setting" };

export function prefersDark(): boolean {
  try { return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches; }
  catch { return false; }
}

export function resolveTheme(choice: ThemeChoice, dark: boolean = prefersDark()): ThemeId {
  return choice === "auto" ? (dark ? "dark" : "paper") : choice;
}

export interface Look { theme: ThemeChoice; pattern: PatternId; strength: StrengthId; }
const DEFAULT: Look = { theme: "paper", pattern: "flow", strength: "subtle" };
const KEY = "look";

export function getLook(): Look {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      theme: v.theme === "auto" || THEMES.some(t => t.id === v.theme) ? v.theme : DEFAULT.theme,
      pattern: PATTERNS.some(p => p.id === v.pattern) ? v.pattern : DEFAULT.pattern,
      strength: STRENGTHS.some(s => s.id === v.strength) ? v.strength : DEFAULT.strength,
    };
  } catch { return DEFAULT; }
}

let watchingSystem = false;

export function applyLook(look: Look = getLook()) {
  const root = document.documentElement;
  const theme = resolveTheme(look.theme);
  root.dataset.theme = theme;
  root.dataset.themeChoice = look.theme;
  // Light palettes need the light chrome (shadows, sidebar, inputs): index.css keys it on this.
  root.toggleAttribute("data-light", isLight(theme));
  for (const [k, v] of Object.entries(PALETTES[theme])) root.style.setProperty(k, v);
  // Follow the system switching between light and dark while "Match system" is chosen.
  if (!watchingSystem && typeof window !== "undefined" && window.matchMedia) {
    watchingSystem = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (getLook().theme === "auto") applyLook();
    });
  }
  root.dataset.pattern = look.pattern;
  root.style.setProperty("--pattern-img", look.pattern === "none" ? "none" : patternUrl(look.pattern));
  root.style.setProperty("--pattern-strength", String(STRENGTHS.find(s => s.id === look.strength)?.scale ?? 1));
}

export function setLook(change: Partial<Look>) {
  const next = { ...getLook(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  applyLook(next);
  window.dispatchEvent(new CustomEvent("look", { detail: next }));
  return next;
}
