import { describe, expect, it } from "vitest";
import { MAX_EDGE, fitWithin, isImage, pictureIn, sizeLabel } from "./image";

describe("What counts as a picture", () => {
  it("takes the formats the vision models read", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isImage({ type, name: "x" })).toBe(true);
    }
  });

  it("refuses what they cannot read", () => {
    expect(isImage({ type: "application/pdf", name: "spec.pdf" })).toBe(false);
    expect(isImage({ type: "image/tiff", name: "scan.tiff" })).toBe(false);
    expect(isImage({ type: "text/plain", name: "notes.txt" })).toBe(false);
  });

  it("falls back to the name when the source gives no type", () => {
    // A drag from a file manager, or an older clipboard.
    expect(isImage({ type: "", name: "whiteboard.JPG" })).toBe(true);
    expect(isImage({ type: "", name: "diagram.png" })).toBe(true);
    expect(isImage({ type: "", name: "notes.doc" })).toBe(false);
  });

  it("does not take a name's word over a type it knows is wrong", () => {
    expect(isImage({ type: "application/zip", name: "photos.png" })).toBe(false);
  });
});

describe("Shrinking to what the model reads", () => {
  it("leaves a picture that already fits exactly as it was", () => {
    expect(fitWithin(800, 600, MAX_EDGE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(MAX_EDGE, 400, MAX_EDGE)).toEqual({ width: MAX_EDGE, height: 400 });
  });

  it("brings a phone photo down by its long edge", () => {
    // 12 megapixels, landscape.
    expect(fitWithin(4032, 3024, MAX_EDGE)).toEqual({ width: 1568, height: 1176 });
  });

  it("works the same way up a tall picture", () => {
    expect(fitWithin(3024, 4032, MAX_EDGE)).toEqual({ width: 1176, height: 1568 });
  });

  it("keeps the shape of a very wide screenshot", () => {
    const { width, height } = fitWithin(3840, 1080, MAX_EDGE);
    expect(width).toBe(1568);
    expect(Math.abs(width / height - 3840 / 1080)).toBeLessThan(0.01);
  });

  it("never enlarges a small picture into a blurry big one", () => {
    expect(fitWithin(120, 80, MAX_EDGE)).toEqual({ width: 120, height: 80 });
  });

  it("survives a picture with no size at all", () => {
    expect(fitWithin(0, 0, MAX_EDGE)).toEqual({ width: 0, height: 0 });
  });
});

describe("Finding the picture in a drop or a paste", () => {
  const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
  const transfer = (files: File[], items: { kind: string; file: File | null }[] = []) => ({
    files,
    items: items.map(i => ({ kind: i.kind, getAsFile: () => i.file })),
  }) as unknown as DataTransfer;

  it("finds nothing in nothing", () => {
    expect(pictureIn(null)).toBeNull();
    expect(pictureIn(transfer([]))).toBeNull();
  });

  it("takes the picture out of a drop", () => {
    const png = file("diagram.png", "image/png");
    expect(pictureIn(transfer([png]))).toBe(png);
  });

  it("ignores what is dropped alongside it", () => {
    const png = file("diagram.png", "image/png");
    expect(pictureIn(transfer([file("spec.pdf", "application/pdf"), png]))).toBe(png);
  });

  it("takes a pasted screenshot, which arrives as an item rather than a file", () => {
    const shot = file("image.png", "image/png");
    expect(pictureIn(transfer([], [{ kind: "file", file: shot }]))).toBe(shot);
  });

  it("ignores pasted text", () => {
    expect(pictureIn(transfer([], [{ kind: "string", file: null }]))).toBeNull();
  });
});

describe("Saying how big it is", () => {
  it("reads in the units people use", () => {
    expect(sizeLabel(2_400_000)).toBe("2.3 MB");
    expect(sizeLabel(48_000)).toBe("47 KB");
    expect(sizeLabel(10)).toBe("1 KB");
  });
});
