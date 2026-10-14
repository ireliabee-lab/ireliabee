/**
 * Pictures attached to the prompt box.
 *
 * The coach can already read a screenshot; this is the same road, walked from
 * the other end — a diagram, a whiteboard photo, a spec, a chart the other
 * person just shared — dropped, pasted or picked in the composer and sent with
 * whatever question is typed beside it.
 *
 * Big pictures are shrunk first. The vision models read about 1568 pixels on
 * the long edge and charge for what they are sent, so a 12-megapixel phone
 * photo costs several times what it needs to and answers no better.
 */

/** What the vision models actually accept. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The long edge the models read at full detail; past this is paid-for detail nobody sees. */
export const MAX_EDGE = 1568;

/** Refused before anything is uploaded, with the size said in the message. */
export const MAX_BYTES = 20 * 1024 * 1024;

export function isImage(file: { type?: string; name?: string }): boolean {
  if (file.type && IMAGE_TYPES.includes(file.type)) return true;
  // Some sources (a drag from a file manager, an old clipboard) hand over no
  // type at all; the name is then the only thing left to go on.
  return !file.type && /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
}

/** Fit a picture inside a square box, keeping its shape. Never enlarges. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A short "1.2 MB" for the chip under the composer. */
export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface Attached {
  file: File;
  /** For the thumbnail in the composer and in the transcript afterwards. */
  dataUrl: string;
}

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Prepare a picked picture: shrink it if it is larger than the models read,
 * and make a thumbnail to show beside the question.
 *
 * A picture that is already small enough is sent exactly as it arrived —
 * re-encoding it would only lose detail the model might have used.
 */
export async function prepare(file: File, maxEdge = MAX_EDGE): Promise<Attached> {
  const dataUrl = await readAsDataUrl(file);
  try {
    const bitmap = await createImageBitmap(file);
    const fitted = fitWithin(bitmap.width, bitmap.height, maxEdge);
    if (fitted.width === bitmap.width && fitted.height === bitmap.height) {
      bitmap.close?.();
      return { file, dataUrl };
    }
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { file, dataUrl };
    ctx.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
    bitmap.close?.();
    // PNG for anything that might be a screenshot of text, where JPEG's
    // ringing around letters is exactly what makes them hard to read.
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, type, 0.92));
    if (!blob) return { file, dataUrl };
    const name = file.name.replace(/\.[^.]+$/, "") + (type === "image/jpeg" ? ".jpg" : ".png");
    return { file: new File([blob], name, { type }), dataUrl: canvas.toDataURL(type, 0.8) };
  } catch {
    // No bitmap decoder (or a format this browser will not open): send what
    // was picked and let the backend say whether it can read it.
    return { file, dataUrl };
  }
}

/** The first picture in a drop or a paste, if there is one. */
export function pictureIn(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.files || [])) if (isImage(item)) return item;
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isImage(file)) return file;
  }
  return null;
}
