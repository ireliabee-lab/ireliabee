/**
 * Looks for the diary. A theme covers everything drawn on the canvas (paper,
 * ruling, ink, covers, fonts) and the interface around the book.
 *
 * Formatting is stored as meaning, not pixels: an entry saved with "Oxblood"
 * ink keeps that value, and each theme maps it to a colour that reads well on
 * its paper. Switching themes never changes what was written.
 */

export type ThemeId = 'classic' | 'light' | 'dark' | 'school' | 'parchment' | 'dotgrid' | 'clean' | 'cleandark';
export type ThemeChoice = ThemeId | 'auto';

export interface PageTheme {
  readonly id: ThemeId;
  /** Font family stack for all page text. */
  readonly family: string;
  /** Large decorative first letters for each entry. */
  readonly dropCaps: boolean;
  /**
   * The app's own look instead of a printed book's: section titles upright and
   * semibold on the left with a hairline under them, page numbers small and
   * upright (the Clean themes, owner 30 Sep 2026).
   */
  readonly plain?: boolean;
  readonly colors: {
    readonly paper: string;
    readonly ink: string;
    readonly inkSoft: string;
    readonly accent: string;
    readonly cloth: string;
    readonly gold: string;
    readonly goldLight: string;
    readonly endpaper: string;
    readonly edgeLight: string;
    readonly edgeDark: string;
    readonly selection: string;
  };
  readonly paper: {
    readonly rule: 'none' | 'ruled' | 'dots';
    readonly ruleColor: string;
    readonly margin?: string;
    /** Lamp-light glow and edge tint over the paper. */
    readonly glow: string;
    readonly shade: string;
    readonly grain: number;
    readonly gutter: number;
    readonly foxing?: boolean;
  };
  readonly cover: {
    readonly style: 'leather' | 'card' | 'cloth';
    readonly base: string;
    readonly light: string;
    readonly dark: string;
    readonly stitch: string;
    readonly emboss: string;
    readonly embossHighlight: string;
  };
  /** Display colours for stored ink and highlighter values on this paper. */
  readonly inkMap?: Readonly<Record<string, string>>;
  readonly highlightMap?: Readonly<Record<string, string>>;
}

export interface Theme extends PageTheme {
  readonly name: string;
  readonly description: string;
  readonly scheme: 'light' | 'dark';
  /** Interface colours as CSS custom properties. */
  readonly ui: Readonly<Record<string, string>>;
}

const SERIF = '"EB Garamond", Garamond, "Iowan Old Style", Georgia, serif';
/** The app's interface font, so a Clean page reads like the app's own cards. */
const APP_SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const SCHOOL_HAND = '"Patrick Hand", "Comic Neue", "Segoe Print", "Bradley Hand", cursive';
const JOURNAL_HAND = '"Kalam", "Segoe Print", "Bradley Hand", cursive';

/** The stored ink values (see diary/editor INK_COLORS). */
const INK = {
  ink: '#2C2521',
  oxblood: '#8A1F2D',
  indigo: '#2B3F8C',
  forest: '#2F6B3E',
  plum: '#6A2C70',
  sepia: '#8A5A2B',
};

export const THEMES: readonly Theme[] = [
  {
    id: 'classic',
    name: 'Classic',
    description: 'Mulberry leather, cream paper',
    scheme: 'dark',
    family: SERIF,
    dropCaps: true,
    colors: {
      paper: '#F0E6D2',
      ink: '#2C2521',
      inkSoft: '#6E6258',
      accent: '#6B2530',
      cloth: '#5A1D26',
      gold: '#C9A45C',
      goldLight: '#EBD49A',
      endpaper: '#2D4841',
      edgeLight: '#E2D6BE',
      edgeDark: '#CBBC9E',
      selection: 'rgba(43, 63, 140, 0.2)',
    },
    paper: { rule: 'none', ruleColor: '', glow: 'rgba(255, 252, 242, 0.35)', shade: 'rgba(150, 120, 80, 0.10)', grain: 1, gutter: 1 },
    cover: {
      style: 'leather',
      base: '#4A2230',
      light: '#63303F',
      dark: '#2E121C',
      stitch: 'rgba(233, 205, 168, 0.55)',
      emboss: 'rgba(20, 4, 10, 0.55)',
      embossHighlight: 'rgba(255, 230, 215, 0.14)',
    },
    ui: {
      '--desk': '#1D1926',
      '--desk-deep': '#0E0C13',
      '--lamp': 'rgba(255, 196, 150, 0.11)',
      '--text': '#EEE4D7',
      '--text-soft': 'rgba(238, 228, 215, 0.64)',
      '--line': 'rgba(238, 228, 215, 0.2)',
      '--brass': '#C9A064',
      '--field': 'rgba(238, 228, 215, 0.06)',
      '--sheet': '#221D2B',
      '--warn': '#E39A8B',
      '--bar': 'rgba(238, 228, 215, 0.05)',
      '--strap-a': '#5E2B3B',
      '--strap-b': '#3A1622',
      '--on-brass': '#211722',
    },
  },
  {
    id: 'light',
    name: 'Light',
    description: 'Bright paper, linen cover',
    scheme: 'light',
    family: SERIF,
    dropCaps: true,
    colors: {
      paper: '#FBF8F1',
      ink: '#26221E',
      inkSoft: '#7A7068',
      accent: '#9B2C3A',
      cloth: '#D8D1C3',
      gold: '#8C6A37',
      goldLight: '#B8925A',
      endpaper: '#DCD5C7',
      edgeLight: '#F2EEE6',
      edgeDark: '#DAD3C6',
      selection: 'rgba(43, 63, 140, 0.16)',
    },
    paper: { rule: 'none', ruleColor: '', glow: 'rgba(255, 255, 255, 0.5)', shade: 'rgba(120, 110, 90, 0.06)', grain: 0.6, gutter: 0.7 },
    cover: {
      style: 'cloth',
      base: '#DCD5C8',
      light: '#ECE7DD',
      dark: '#BFB6A6',
      stitch: 'rgba(90, 70, 50, 0.35)',
      emboss: 'rgba(60, 45, 30, 0.5)',
      embossHighlight: 'rgba(255, 255, 255, 0.5)',
    },
    ui: {
      '--desk': '#F1ECE3',
      '--desk-deep': '#DED6C9',
      '--lamp': 'rgba(255, 255, 255, 0.6)',
      '--text': '#2A2521',
      '--text-soft': 'rgba(42, 37, 33, 0.62)',
      '--line': 'rgba(42, 37, 33, 0.18)',
      '--brass': '#8C6A37',
      '--field': 'rgba(42, 37, 33, 0.05)',
      '--sheet': '#FBF8F2',
      '--warn': '#A33A2C',
      '--bar': 'rgba(42, 37, 33, 0.05)',
      '--strap-a': '#CFC6B6',
      '--strap-b': '#B3A894',
      '--on-brass': '#FFFFFF',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Charcoal paper, light ink',
    scheme: 'dark',
    family: SERIF,
    dropCaps: true,
    colors: {
      paper: '#24222A',
      ink: '#E9E2D6',
      inkSoft: '#A39A8E',
      accent: '#E0897E',
      cloth: '#17161B',
      gold: '#9A8F80',
      goldLight: '#C8BEB0',
      endpaper: '#15141A',
      edgeLight: '#35323B',
      edgeDark: '#2A2830',
      selection: 'rgba(150, 175, 255, 0.28)',
    },
    paper: { rule: 'none', ruleColor: '', glow: 'rgba(255, 255, 255, 0.04)', shade: 'rgba(0, 0, 0, 0.25)', grain: 0.5, gutter: 1.4 },
    cover: {
      style: 'leather',
      base: '#1D1C22',
      light: '#2A2830',
      dark: '#0F0E12',
      stitch: 'rgba(200, 190, 175, 0.35)',
      emboss: 'rgba(0, 0, 0, 0.7)',
      embossHighlight: 'rgba(255, 255, 255, 0.08)',
    },
    inkMap: {
      [INK.ink]: '#E9E2D6',
      [INK.oxblood]: '#F08C8C',
      [INK.indigo]: '#9DB2FF',
      [INK.forest]: '#8FD19E',
      [INK.plum]: '#D9A2E0',
      [INK.sepia]: '#E0B585',
    },
    highlightMap: {
      'rgba(247, 214, 76, 0.55)': 'rgba(247, 214, 76, 0.32)',
      'rgba(242, 140, 176, 0.5)': 'rgba(242, 140, 176, 0.32)',
      'rgba(140, 207, 130, 0.5)': 'rgba(140, 207, 130, 0.3)',
      'rgba(130, 182, 235, 0.5)': 'rgba(130, 182, 235, 0.32)',
      'rgba(245, 168, 92, 0.5)': 'rgba(245, 168, 92, 0.32)',
    },
    ui: {
      '--desk': '#111015',
      '--desk-deep': '#050507',
      '--lamp': 'rgba(160, 170, 255, 0.05)',
      '--text': '#E6E0D6',
      '--text-soft': 'rgba(230, 224, 214, 0.6)',
      '--line': 'rgba(230, 224, 214, 0.16)',
      '--brass': '#C8BEB0',
      '--field': 'rgba(230, 224, 214, 0.06)',
      '--sheet': '#1C1B21',
      '--warn': '#F0A090',
      '--bar': 'rgba(230, 224, 214, 0.05)',
      '--strap-a': '#2C2A31',
      '--strap-b': '#15141A',
      '--on-brass': '#16151A',
    },
  },
  {
    id: 'school',
    name: 'Exercise book',
    description: 'Ruled lines, red margin',
    scheme: 'light',
    family: SCHOOL_HAND,
    dropCaps: false,
    colors: {
      paper: '#FDFDFA',
      ink: '#1F2A48',
      inkSoft: '#5E6882',
      accent: '#C0392B',
      cloth: '#2F63B5',
      gold: '#FFFFFF',
      goldLight: '#FFFFFF',
      endpaper: '#FDFDFA',
      edgeLight: '#F4F4F0',
      edgeDark: '#DEDFD8',
      selection: 'rgba(47, 99, 181, 0.18)',
    },
    paper: {
      rule: 'ruled',
      ruleColor: 'rgba(110, 160, 220, 0.55)',
      margin: 'rgba(214, 90, 90, 0.7)',
      glow: 'rgba(255, 255, 255, 0.3)',
      shade: 'rgba(90, 110, 140, 0.05)',
      grain: 0.4,
      gutter: 0.6,
    },
    cover: {
      style: 'card',
      base: '#2F63B5',
      light: '#3C74C9',
      dark: '#244E91',
      stitch: 'rgba(255, 255, 255, 0.0)',
      emboss: '#1F2A48',
      embossHighlight: '#FFFFFF',
    },
    ui: {
      '--desk': '#E9EEF5',
      '--desk-deep': '#CFD8E4',
      '--lamp': 'rgba(255, 255, 255, 0.55)',
      '--text': '#1F2A48',
      '--text-soft': 'rgba(31, 42, 72, 0.62)',
      '--line': 'rgba(31, 42, 72, 0.18)',
      '--brass': '#2F63B5',
      '--field': 'rgba(31, 42, 72, 0.05)',
      '--sheet': '#FFFFFF',
      '--warn': '#C0392B',
      '--bar': 'rgba(31, 42, 72, 0.05)',
      '--strap-a': '#2A5AA6',
      '--strap-b': '#1E447F',
      '--on-brass': '#FFFFFF',
    },
  },
  {
    id: 'parchment',
    name: 'Parchment',
    description: 'Aged paper, sepia ink',
    scheme: 'dark',
    family: SERIF,
    dropCaps: true,
    colors: {
      paper: '#E8D6B0',
      ink: '#3A2716',
      inkSoft: '#7A5E42',
      accent: '#7A3B1E',
      cloth: '#6F4A2A',
      gold: '#D2A962',
      goldLight: '#EBCB8C',
      endpaper: '#5B3A22',
      edgeLight: '#DCC79E',
      edgeDark: '#C3A97A',
      selection: 'rgba(122, 59, 30, 0.2)',
    },
    paper: {
      rule: 'none',
      ruleColor: '',
      glow: 'rgba(255, 240, 205, 0.3)',
      shade: 'rgba(120, 80, 30, 0.22)',
      grain: 1.6,
      gutter: 1.2,
      foxing: true,
    },
    cover: {
      style: 'leather',
      base: '#6F4A2A',
      light: '#8A5E38',
      dark: '#4A2F19',
      stitch: 'rgba(240, 215, 170, 0.5)',
      emboss: 'rgba(30, 15, 5, 0.55)',
      embossHighlight: 'rgba(255, 225, 180, 0.16)',
    },
    ui: {
      '--desk': '#2A1E15',
      '--desk-deep': '#130D09',
      '--lamp': 'rgba(255, 190, 120, 0.12)',
      '--text': '#F0E2C8',
      '--text-soft': 'rgba(240, 226, 200, 0.62)',
      '--line': 'rgba(240, 226, 200, 0.2)',
      '--brass': '#D2A962',
      '--field': 'rgba(240, 226, 200, 0.06)',
      '--sheet': '#2E2219',
      '--warn': '#EDA58C',
      '--bar': 'rgba(240, 226, 200, 0.05)',
      '--strap-a': '#7A5230',
      '--strap-b': '#523420',
      '--on-brass': '#21160E',
    },
  },
  {
    id: 'dotgrid',
    name: 'Dot grid',
    description: 'Bullet journal, handwriting',
    scheme: 'light',
    family: JOURNAL_HAND,
    dropCaps: false,
    colors: {
      paper: '#FAFAF6',
      ink: '#232323',
      inkSoft: '#6F6F6B',
      accent: '#1F7A74',
      cloth: '#232426',
      gold: '#B9B9B4',
      goldLight: '#E2E2DD',
      endpaper: '#232426',
      edgeLight: '#F0F0EB',
      edgeDark: '#DADAD4',
      selection: 'rgba(31, 122, 116, 0.18)',
    },
    paper: {
      rule: 'dots',
      ruleColor: 'rgba(40, 40, 40, 0.28)',
      glow: 'rgba(255, 255, 255, 0.35)',
      shade: 'rgba(0, 0, 0, 0.04)',
      grain: 0.3,
      gutter: 0.7,
    },
    cover: {
      style: 'cloth',
      base: '#232426',
      light: '#2E3033',
      dark: '#161719',
      stitch: 'rgba(255, 255, 255, 0)',
      emboss: 'rgba(0, 0, 0, 0.6)',
      embossHighlight: 'rgba(255, 255, 255, 0.12)',
    },
    ui: {
      '--desk': '#EDEDEA',
      '--desk-deep': '#D6D6D1',
      '--lamp': 'rgba(255, 255, 255, 0.6)',
      '--text': '#232323',
      '--text-soft': 'rgba(35, 35, 35, 0.6)',
      '--line': 'rgba(35, 35, 35, 0.16)',
      '--brass': '#1F7A74',
      '--field': 'rgba(35, 35, 35, 0.05)',
      '--sheet': '#FFFFFF',
      '--warn': '#B23A2A',
      '--bar': 'rgba(35, 35, 35, 0.05)',
      '--strap-a': '#3A3C40',
      '--strap-b': '#1E1F22',
      '--on-brass': '#FFFFFF',
    },
  },
  {
    id: 'clean',
    name: 'Clean white',
    description: 'Pure white, the app\'s own type',
    scheme: 'light',
    family: APP_SANS,
    dropCaps: false,
    plain: true,
    colors: {
      paper: '#FFFFFF',
      ink: '#1F2330',
      inkSoft: '#6B7080',
      accent: '#6366F1',
      cloth: '#E6E8EF',
      gold: '#6366F1',
      goldLight: '#8B8EF5',
      endpaper: '#F1F2F6',
      edgeLight: '#FFFFFF',
      edgeDark: '#E3E5EC',
      selection: 'rgba(99, 102, 241, 0.18)',
    },
    paper: { rule: 'none', ruleColor: '', glow: 'rgba(0, 0, 0, 0)', shade: 'rgba(20, 24, 40, 0.035)', grain: 0, gutter: 0.35 },
    cover: {
      style: 'cloth',
      base: '#E9EBF2',
      light: '#F6F7FA',
      dark: '#D5D8E2',
      stitch: 'rgba(99, 102, 241, 0.0)',
      emboss: 'rgba(31, 35, 48, 0.72)',
      embossHighlight: 'rgba(255, 255, 255, 0.7)',
    },
    ui: {
      '--desk': '#EEF0F5',
      '--desk-deep': '#DADDE6',
      '--lamp': 'rgba(255, 255, 255, 0.6)',
      '--text': '#1F2330',
      '--text-soft': 'rgba(31, 35, 48, 0.6)',
      '--line': 'rgba(31, 35, 48, 0.14)',
      '--brass': '#6366F1',
      '--field': 'rgba(31, 35, 48, 0.05)',
      '--sheet': '#FFFFFF',
      '--warn': '#B42318',
      '--bar': 'rgba(31, 35, 48, 0.05)',
      '--strap-a': '#D9DCE5',
      '--strap-b': '#C2C6D2',
      '--on-brass': '#FFFFFF',
    },
  },
  {
    id: 'cleandark',
    name: 'Clean dark',
    description: 'The app\'s dark cards, its own type',
    scheme: 'dark',
    family: APP_SANS,
    dropCaps: false,
    plain: true,
    colors: {
      paper: '#1A1D27',
      ink: '#E1E4ED',
      inkSoft: '#8B8FA3',
      accent: '#818CF8',
      cloth: '#0A0C12',
      gold: '#818CF8',
      goldLight: '#A5ADFB',
      endpaper: '#12141C',
      edgeLight: '#262A36',
      edgeDark: '#1F2230',
      selection: 'rgba(129, 140, 248, 0.3)',
    },
    paper: { rule: 'none', ruleColor: '', glow: 'rgba(0, 0, 0, 0)', shade: 'rgba(0, 0, 0, 0.18)', grain: 0, gutter: 0.6 },
    cover: {
      style: 'cloth',
      base: '#1A1D27',
      light: '#242836',
      dark: '#11131A',
      stitch: 'rgba(129, 140, 248, 0.0)',
      emboss: 'rgba(225, 228, 237, 0.85)',
      embossHighlight: 'rgba(0, 0, 0, 0.35)',
    },
    inkMap: {
      [INK.ink]: '#E1E4ED',
      [INK.oxblood]: '#F08C8C',
      [INK.indigo]: '#A5B4FC',
      [INK.forest]: '#86D19A',
      [INK.plum]: '#D9A2E0',
      [INK.sepia]: '#E0B585',
    },
    highlightMap: {
      'rgba(247, 214, 76, 0.55)': 'rgba(247, 214, 76, 0.3)',
      'rgba(242, 140, 176, 0.5)': 'rgba(242, 140, 176, 0.3)',
      'rgba(140, 207, 130, 0.5)': 'rgba(140, 207, 130, 0.28)',
      'rgba(130, 182, 235, 0.5)': 'rgba(130, 182, 235, 0.3)',
      'rgba(245, 168, 92, 0.5)': 'rgba(245, 168, 92, 0.3)',
    },
    ui: {
      '--desk': '#0A0C12',
      '--desk-deep': '#05060A',
      '--lamp': 'rgba(129, 140, 248, 0.04)',
      '--text': '#E1E4ED',
      '--text-soft': 'rgba(225, 228, 237, 0.6)',
      '--line': 'rgba(225, 228, 237, 0.13)',
      '--brass': '#818CF8',
      '--field': 'rgba(225, 228, 237, 0.06)',
      '--sheet': '#1A1D27',
      '--warn': '#F0A090',
      '--bar': 'rgba(225, 228, 237, 0.05)',
      '--strap-a': '#242836',
      '--strap-b': '#11131A',
      '--on-brass': '#0A0C12',
    },
  },
];

/** The Clean themes read best at the app's own small size. */
export const CLEAN_THEMES: readonly ThemeId[] = ['clean', 'cleandark'];

export const DEFAULT_THEME: ThemeId = 'classic';

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? (THEMES[0] as Theme);
}

/** "auto" follows the system's light or dark setting. */
export function resolveTheme(choice: string | null | undefined, prefersDark: boolean): Theme {
  if (choice === 'auto') return themeById(prefersDark ? 'dark' : 'light');
  return themeById(choice ?? DEFAULT_THEME);
}

/** The fonts a theme needs loaded before measuring text. */
export function themeFonts(theme: PageTheme, size = 19): string[] {
  const family = theme.family;
  return [`${size}px ${family}`, `italic ${size}px ${family}`, `600 ${size}px ${family}`, `500 104px ${family}`];
}

/**
 * Page colours a notebook can put over its theme's paper (owner, 27 Sep 2026).
 * Each brings the ink that reads on it, so a dark page gets light writing.
 */
export interface PageColor { readonly id: string; readonly name: string; readonly paper: string; readonly ink: string; readonly inkSoft: string }
export const PAGE_COLORS: readonly PageColor[] = [
  { id: 'white', name: 'White', paper: '#FFFFFF', ink: '#23201C', inkSoft: '#6A645C' },
  { id: 'cream', name: 'Cream', paper: '#F6EEDB', ink: '#2C2521', inkSoft: '#6E6258' },
  { id: 'sage', name: 'Sage', paper: '#E4EEE2', ink: '#1F2A22', inkSoft: '#5A6A5C' },
  { id: 'sky', name: 'Sky', paper: '#E2ECF6', ink: '#1C2533', inkSoft: '#56627A' },
  { id: 'blush', name: 'Blush', paper: '#F6E4E6', ink: '#2E2024', inkSoft: '#72585E' },
  { id: 'sand', name: 'Sand', paper: '#EDE3CF', ink: '#2E271E', inkSoft: '#6F6452' },
  { id: 'slate', name: 'Slate', paper: '#2B2F36', ink: '#E9E6DF', inkSoft: '#A7A39A' },
  { id: 'night', name: 'Night', paper: '#16181D', ink: '#E6E1D6', inkSoft: '#9C978C' },
];

/** A theme with a page colour over its paper (and that colour's ink); the theme as it is without one. */
export function withPageColor(theme: Theme, id: string | null | undefined): Theme {
  const c = PAGE_COLORS.find((p) => p.id === id);
  if (!c) return theme;
  return {
    ...theme,
    colors: { ...theme.colors, paper: c.paper, ink: c.ink, inkSoft: c.inkSoft, edgeLight: c.paper, edgeDark: c.inkSoft },
    // A flat colour is the point: no ruling glow tinting it back to the theme's paper.
    paper: { ...theme.paper, glow: 'rgba(0, 0, 0, 0)', shade: 'rgba(0, 0, 0, 0.06)' },
  };
}
