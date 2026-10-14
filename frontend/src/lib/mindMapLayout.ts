import type { MindMap, MindNode } from "./reading";

/** The drawing's own coordinates: the centre idea sits at (0, 0). */
export const MAP_W = 1240;
export const MAP_H = 720;

/** One colour per branch, readable on both a light and a dark ground. */
export const BRANCH_COLORS = ["#E0663F", "#2F9E8F", "#7B61D1", "#D79A1E", "#3C82D6", "#C2477E"];

export interface PlacedNode {
  node: MindNode;
  /** Branch index, so a leaf shares its branch's colour and path. */
  branch: number;
  /** -1 for a branch, else the leaf's index under it. */
  leaf: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The curve drawn to it from its parent. */
  path: string;
  color: string;
}

/** Roughly how wide a label is drawn, for its rounded box (no DOM needed). */
export function labelWidth(label: string, size: number): number {
  return Math.round(label.length * size * 0.56 + size * 1.9);
}

/** A soft curve from (x1, y1) to (x2, y2) that leaves the start along the line from the centre. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/**
 * Where every idea goes: branches evenly round the centre, each branch's
 * details fanned out beyond it, so nothing overlaps the centre or each other.
 */
export function layoutMindMap(map: MindMap): PlacedNode[] {
  const n = map.branches.length;
  const out: PlacedNode[] = [];
  const r1 = 270;
  const r2 = 470;
  // Start a little above the right-hand side, so two branches sit left and right, not top and bottom.
  const start = -Math.PI / 2 + Math.PI / n;
  map.branches.forEach((b, i) => {
    const angle = start + (i * 2 * Math.PI) / n;
    const color = BRANCH_COLORS[i % BRANCH_COLORS.length] as string;
    const bx = Math.cos(angle) * r1 * 1.12;
    const by = Math.sin(angle) * r1 * 0.8;
    const bw = labelWidth(b.label, 17);
    out.push({ node: b, branch: i, leaf: -1, x: bx, y: by, w: bw, h: 40, path: curve(0, 0, bx, by), color });
    const kids = b.children ?? [];
    const spread = Math.min((2 * Math.PI) / n * 0.8, 0.32 * kids.length);
    kids.forEach((c, k) => {
      const a = kids.length === 1 ? angle : angle - spread / 2 + (spread * k) / (kids.length - 1);
      const cx = Math.cos(a) * r2;
      const cy = Math.sin(a) * r2 * 0.66;
      out.push({ node: c, branch: i, leaf: k, x: cx, y: cy, w: labelWidth(c.label, 13.5), h: 30, path: curve(bx, by, cx, cy), color });
    });
  });
  return out;
}

/** The finished map as a stand-alone picture (no motion), for keeping in the notebook. */
/** `background`: false leaves it see-through, so it sits on the book's own paper. */
export function mindMapSvg(map: MindMap, placed: PlacedNode[], paper = "#FFFDF8", ink = "#2A2622", background = true): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const font = "font-family='Segoe UI, Helvetica, Arial, sans-serif'";
  const cw = labelWidth(map.center, 22);
  const parts = [
    `<svg xmlns='http://www.w3.org/2000/svg' width='${MAP_W * 2}' height='${MAP_H * 2}' viewBox='${-MAP_W / 2} ${-MAP_H / 2} ${MAP_W} ${MAP_H}'>`,
  ];
  if (background) parts.push(`<rect x='${-MAP_W / 2}' y='${-MAP_H / 2}' width='${MAP_W}' height='${MAP_H}' fill='${paper}'/>`);
  for (const p of placed) {
    parts.push(`<path d='${p.path}' fill='none' stroke='${p.color}' stroke-width='${p.leaf < 0 ? 5 : 2.5}' stroke-linecap='round' opacity='${p.leaf < 0 ? 0.9 : 0.65}'/>`);
  }
  for (const p of placed) {
    const big = p.leaf < 0;
    parts.push(`<rect x='${p.x - p.w / 2}' y='${p.y - p.h / 2}' width='${p.w}' height='${p.h}' rx='${p.h / 2}' fill='${big ? p.color : paper}' stroke='${p.color}' stroke-width='2'/>`);
    parts.push(`<text x='${p.x}' y='${p.y}' ${font} font-size='${big ? 17 : 13.5}' font-weight='${big ? 600 : 500}' fill='${big ? "#FFFFFF" : ink}' text-anchor='middle' dominant-baseline='central'>${esc(p.node.label)}</text>`);
  }
  parts.push(`<rect x='${-cw / 2}' y='-30' width='${cw}' height='60' rx='30' fill='${ink}'/>`);
  parts.push(`<text x='0' y='0' ${font} font-size='22' font-weight='700' fill='${paper}' text-anchor='middle' dominant-baseline='central'>${esc(map.center)}</text>`);
  parts.push("</svg>");
  return parts.join("");
}
