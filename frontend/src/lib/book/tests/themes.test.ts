// @vitest-environment jsdom
import "./setup";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPageTheme, COLORS, font, forgetImages, highlightColor, imageReady, inkColor, paintPage, pageTheme, registerImage } from '../pages';
import { DEFAULT_THEME, resolveTheme, themeById, THEMES, themeFonts } from '../themes';
import { sampleContent } from './helpers';

type Ev = { type: string; props: Record<string, unknown> };
/** Paints without the paper cache so the paper itself is drawn onto this context. */
const paint = (index = 4): Ev[] => {
  const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D & { __getEvents(): Ev[] };
  Object.defineProperty(ctx, 'getTransform', { value: undefined });
  paintPage(ctx, { kind: 'text', content: sampleContent(1) }, index);
  return ctx.__getEvents();
};

afterEach(() => applyPageTheme(themeById('classic')));

describe('themes', () => {
  it('offers several distinct looks with the classic one as default', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['classic', 'light', 'dark', 'school', 'parchment', 'dotgrid', 'clean', 'cleandark']);
    expect(DEFAULT_THEME).toBe('classic');
    expect(themeById('nope').id).toBe('classic');
    expect(new Set(THEMES.map((t) => t.colors.paper)).size).toBe(THEMES.length);
  });

  it('follows the system for Automatic', () => {
    expect(resolveTheme('auto', true).id).toBe('dark');
    expect(resolveTheme('auto', false).id).toBe('light');
    expect(resolveTheme(null, true).id).toBe('classic');
    expect(resolveTheme('school', true).id).toBe('school');
  });

  it('lists the fonts a theme needs', () => {
    expect(themeFonts(themeById('school'))[0]).toContain('Patrick Hand');
  });
});

describe('painting with a theme', () => {
  it('switches paper, ink and fonts', () => {
    applyPageTheme(themeById('dark'));
    expect(pageTheme().id).toBe('dark');
    expect(COLORS.paper).toBe('#24222A');
    expect(font(19)).toContain('EB Garamond');
    applyPageTheme(themeById('dotgrid'));
    expect(font(19)).toContain('Kalam');
  });

  it('maps stored ink and highlighter colours so they read on dark paper', () => {
    applyPageTheme(themeById('dark'));
    expect(inkColor('#8A1F2D')).toBe('#F08C8C');
    expect(inkColor(undefined)).toBe(COLORS.ink);
    expect(inkColor('#123456')).toBe('#123456');
    expect(highlightColor('rgba(247, 214, 76, 0.55)')).toBe('rgba(247, 214, 76, 0.32)');
    applyPageTheme(themeById('classic'));
    expect(inkColor('#8A1F2D')).toBe('#8A1F2D');
  });

  it('rules exercise-book paper with a margin, and dots the bullet journal', () => {
    const plain = paint().filter((e) => e.type === 'stroke').length;
    applyPageTheme(themeById('school'));
    const ruled = paint().filter((e) => e.type === 'stroke').length;
    expect(ruled).toBeGreaterThan(plain + 15);
    applyPageTheme(themeById('dotgrid'));
    expect(paint().filter((e) => e.type === 'arc').length).toBeGreaterThan(100);
    applyPageTheme(themeById('parchment'));
    expect(paint().filter((e) => e.type === 'createRadialGradient').length).toBeGreaterThan(20);
  });
});

describe('pictures', () => {
  it('registers a picture once and reports when it can be drawn', () => {
    const onReady = vi.fn();
    registerImage('p1', 'data:image/png;base64,AAAA', onReady);
    registerImage('p1', 'data:image/png;base64,AAAA', onReady);
    expect(imageReady('p1')).toBe(false);
    forgetImages();
    expect(imageReady('p1')).toBe(false);
  });
});
