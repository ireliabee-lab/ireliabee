import type { Picture } from './entries';

/** Longest side of a stored photo, in pixels. */
export const MAX_PICTURE_SIDE = 1000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Unreadable image'));
    img.src = src;
  });
}

/**
 * Shrinks a photo to at most MAX_PICTURE_SIDE on its longest side and
 * re-encodes it as JPEG, so a diary full of photos stays small enough to
 * encrypt and keep on the device. Browsers apply the camera's rotation.
 */
export async function downscaleImage(file: Blob, max = MAX_PICTURE_SIDE, quality = 0.82): Promise<Picture> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.fillStyle = '#FFFFFF'; // transparent PNGs get a white background
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { src: canvas.toDataURL('image/jpeg', quality), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}
