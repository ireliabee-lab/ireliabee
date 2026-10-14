// @vitest-environment jsdom
import "../setup";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downscaleImage, MAX_PICTURE_SIDE } from '../../diary/pictures';

/** A real <img> (so canvas accepts it) that "loads" a 3000×2000 photo. */
function FakeImage(): HTMLImageElement {
  const img = document.createElement('img');
  Object.defineProperty(img, 'naturalWidth', { value: 3000 });
  Object.defineProperty(img, 'naturalHeight', { value: 2000 });
  Object.defineProperty(img, 'src', {
    set(v: string) {
      setTimeout(() => (v.includes('broken') ? img.onerror?.(new Event('error')) : img.onload?.(new Event('load'))), 0);
    },
  });
  return img;
}

afterEach(() => vi.unstubAllGlobals());

describe('downscaleImage', () => {
  it('shrinks photos to a storable size as JPEG', async () => {
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:photo', revokeObjectURL: vi.fn() });
    const pic = await downscaleImage(new Blob(['x']));
    expect(pic.w).toBe(MAX_PICTURE_SIDE);
    expect(pic.h).toBe(Math.round((2000 * MAX_PICTURE_SIDE) / 3000));
    expect(pic.src).toMatch(/^data:image/);
  });

  it('rejects files that aren’t images', async () => {
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:broken', revokeObjectURL: vi.fn() });
    await expect(downscaleImage(new Blob(['x']))).rejects.toThrow(/Unreadable/);
  });
});
