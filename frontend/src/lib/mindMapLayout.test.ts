import { describe, expect, it } from "vitest";
import { layoutMindMap, labelWidth, MAP_H, MAP_W, mindMapSvg } from "./mindMapLayout";
import type { MindMap } from "./reading";

const MAP: MindMap = {
  center: "Stuttering and stress",
  branches: ["Not the cause", "Symptoms may increase", "Anxiety association", "Coexisting anxiety disorders", "Stress from stuttering", "Sixth"].map((label, i) => ({
    label, note: "", pages: [1],
    children: i === 2 ? [{ label: "Exacerbation", note: "", pages: [] }, { label: "Social anxiety", note: "", pages: [] }] : [],
  })),
};

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

describe("layoutMindMap", () => {
  const placed = layoutMindMap(MAP);

  it("places every branch and leaf, leaves sharing their branch's colour", () => {
    expect(placed.filter(p => p.leaf < 0)).toHaveLength(6);
    const leaves = placed.filter(p => p.leaf >= 0);
    expect(leaves).toHaveLength(2);
    expect(leaves.every(l => l.color === placed.find(p => p.leaf < 0 && p.branch === l.branch)?.color)).toBe(true);
  });

  it("keeps ideas off the centre, off each other and inside the drawing", () => {
    const center = { x: 0, y: 0, w: labelWidth(MAP.center, 22), h: 60 };
    for (const p of placed) {
      expect(overlap(p, center)).toBe(false);
      expect(Math.abs(p.x) + p.w / 2).toBeLessThanOrEqual(MAP_W / 2);
      expect(Math.abs(p.y) + p.h / 2).toBeLessThanOrEqual(MAP_H / 2);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!)).toBe(false);
  });

  it("draws a still picture with every label, escaped", () => {
    const svg = mindMapSvg({ ...MAP, center: "A <b> & c" }, placed);
    expect(svg).toContain("A &lt;b&gt; &amp; c");
    expect(svg).toContain("Social anxiety");
    expect(svg).not.toContain("animation");
  });
});
