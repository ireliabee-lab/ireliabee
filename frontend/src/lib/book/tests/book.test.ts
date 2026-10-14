// @vitest-environment jsdom
import "./setup";
import { describe, expect, it } from 'vitest';
import { assemblePages } from '../book';
import type { PageContent } from '../typeset';

const text = (n: number): PageContent[] => Array.from({ length: n }, () => ({ lines: [] }));

describe('assemblePages', () => {
  it.each([1, 2, 5, 6])('produces an even page count for %i text pages', (n) => {
    const pages = assemblePages(text(n));
    expect(pages.length % 2).toBe(0);
    expect(pages[0]?.kind).toBe('cover');
    expect(pages[pages.length - 1]?.kind).toBe('back-cover');
    expect(pages[pages.length - 2]?.kind).toBe('endpaper');
    expect(pages.filter((p) => p.kind === 'text')).toHaveLength(n);
  });

});
