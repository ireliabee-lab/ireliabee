/**
 * The notebook in the book: turning a notebook's structured document into the
 * pages of the Nkɔmmɔ book engine and back.
 *
 * The notebook JSON stays the saved form (search, export, history, reading
 * notes and the Research term harvest all read it). Each section becomes one
 * book entry: its blocks become lines of rich text, one block per line, and a
 * side list (`meta`) remembers which block each line came from, so a line that
 * was only edited keeps its id, type and sources.
 *
 * Some of a block is drawn as ordinary text on the line: a label ("Decision:"),
 * a definition's term ("entropy — …"), a quote's speaker, an action's owner and
 * due date, and the source tag ("p. 12"). The meta records those exact strings,
 * so on the way back they are taken off again and only the block's own words
 * are saved. If the reader edits a label away, the words stay and nothing breaks.
 */
import { OBJECT_CHAR, imageIdOf, type Mark as BookMark, type ParaStyle } from "./book/rich";
import {
  BLOCK_PARAS, BOARD, type Block, type BlockPara, type BlockType, type BoardKey, type Formatting, type Ink, type InkColor, type Mark,
  type MarkColor, type NotebookDoc, type NotebookKind, type Section, type Span, newId,
} from "./notebook";

// ── Colours: Nkɔmmɔ's palette ↔ the notebook's saved colour names ─────────────

/** Nkɔmmɔ highlight values (diary/editor.ts HIGHLIGHTS) by notebook colour. */
export const HIGHLIGHT_VALUE: Record<MarkColor, string> = {
  yellow: "rgba(247, 214, 76, 0.55)",
  pink: "rgba(242, 140, 176, 0.5)",
  green: "rgba(140, 207, 130, 0.5)",
  blue: "rgba(130, 182, 235, 0.5)",
  orange: "rgba(245, 168, 92, 0.5)",
};
/** Nkɔmmɔ ink values (diary/editor.ts INK_COLORS) by notebook colour. Plain ink is no colour at all. */
export const INK_VALUE: Record<InkColor, string> = {
  red: "#8A1F2D",      // Oxblood
  blue: "#2B3F8C",     // Indigo
  green: "#2F6B3E",    // Forest
  purple: "#6A2C70",   // Plum
  orange: "#8A5A2B",   // Sepia
};
const byValue = <K extends string>(map: Record<K, string>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k])) as Record<string, K>;
const HIGHLIGHT_NAME = byValue(HIGHLIGHT_VALUE);
const INK_NAME = byValue(INK_VALUE);

// ── What a line is ────────────────────────────────────────────────────────────

/** What one line of an entry came from, and the decorations drawn around its words. */
export interface LineMeta {
  id: string;
  type: BlockType;
  src: number[];
  /** Text drawn before the block's words ("Decision: ", "entropy — "). */
  prefix: string;
  /** Text drawn after them (" — Dr. Patel", "  · p. 12"). */
  suffix: string;
  /** Everything else the block carried (term, speaker, owner, due, done, caption, rich), kept as it was. */
  rest: Partial<Block>;
  /** The source tag at the end of the line ("p. 12", "14:32"), which opens the source when tapped. */
  tag?: string;
}

/** A photo in an entry: a downscaled JPEG data URL and its size (as Nkɔmmɔ keeps them). */
export interface BookPicture { src: string; w: number; h: number }

/** One book entry: a section, the front page of a meeting, the summary, or Test yourself. */
export interface BookEntry {
  id: string;
  /** The heading drawn above the entry. */
  title: string;
  /** What the entry is, so it can be saved back to the right place. */
  role: "section" | "board" | "summary" | "cues";
  text: string;
  marks: BookMark[];
  paras: ParaStyle[];
  meta: (LineMeta | null)[];
  /** For sections: its own sources and title formatting, kept as they were. */
  section?: Omit<Section, "blocks" | "title">;
  /** Photos on this entry's lines, by id. */
  media?: Record<string, BookPicture>;
}

/** Labels drawn in front of a block's words, by type. */
export const LABEL: Partial<Record<BlockType, string>> = {
  example: "Example: ", exam: "Exam: ", question: "Question: ", unclear: "Check this: ",
  decision: "Decision: ", risk: "Risk: ", tutor: "Tutor note: ",
};
/** The line style a block type is drawn with when it has no saved style of its own. */
const TYPE_PARA: Record<BlockType, ParaStyle> = {
  point: "bullet", key: "key", definition: "normal", example: "normal", exam: "normal", question: "normal",
  quote: "quote", formula: "center", table: "table", unclear: "normal", decision: "normal", action: "check",
  risk: "normal", number: "normal", note: "normal", tutor: "quote", image: "normal",
};

/** A new line the reader wrote: what kind of block it is, from its style. */
export function typeForPara(para: ParaStyle, role: BookEntry["role"]): BlockType {
  if (para === "key") return "key";
  if (para === "check" || para === "checked") return role === "board" ? "action" : "point";
  if (para === "quote") return "quote";
  if (para === "center") return "formula";
  if (para === "table") return "table";
  if (para === "bullet" || para === "numbered") return "point";
  return "note";
}

// ── Formatting: spans on a block ↔ marks on a line ─────────────────────────────

type BoolType = "bold" | "italic" | "underline" | "strike";
const STYLE_OF: Record<"b" | "i" | "u" | "x", BoolType> = { b: "bold", i: "italic", u: "underline", x: "strike" };

/** A block's formatting as book marks, `at` characters into the line. */
function marksFromBlock(b: { text: string; marks?: Mark[]; fmt?: Formatting; ink?: Ink[] }, at: number): BookMark[] {
  const out: BookMark[] = [];
  const found = (sp: { s: number; e: number; q: string }) => b.text.slice(sp.s, sp.e) === sp.q;
  for (const m of b.marks ?? []) if (found(m) && HIGHLIGHT_VALUE[m.c]) out.push({ type: "highlight", start: at + m.s, end: at + m.e, value: HIGHLIGHT_VALUE[m.c] });
  for (const m of b.ink ?? []) if (found(m) && INK_VALUE[m.c]) out.push({ type: "color", start: at + m.s, end: at + m.e, value: INK_VALUE[m.c] });
  for (const key of Object.keys(STYLE_OF) as (keyof typeof STYLE_OF)[]) {
    for (const sp of b.fmt?.[key] ?? []) if (found(sp)) out.push({ type: STYLE_OF[key], start: at + sp.s, end: at + sp.e });
  }
  return out;
}

/** The marks that fall on characters from..to of a line, as a block's formatting over `text`. */
function blockFromMarks(marks: readonly BookMark[], from: number, to: number, text: string): Pick<Block, "marks" | "fmt" | "ink"> {
  const out: Pick<Block, "marks" | "fmt" | "ink"> = {};
  const clip = (m: BookMark) => ({ s: Math.max(m.start, from) - from, e: Math.min(m.end, to) - from });
  for (const m of marks) {
    if (m.end <= from || m.start >= to) continue;
    const { s, e } = clip(m);
    if (e <= s) continue;
    const q = text.slice(s, e);
    if (m.type === "highlight") {
      const c = HIGHLIGHT_NAME[m.value ?? ""];
      if (c) (out.marks ??= []).push({ s, e, c, q });
    } else if (m.type === "color") {
      const c = INK_NAME[m.value ?? ""];
      if (c) (out.ink ??= []).push({ s, e, c, q });
    } else {
      const key = (Object.keys(STYLE_OF) as (keyof typeof STYLE_OF)[]).find(k => STYLE_OF[k] === m.type);
      if (key) ((out.fmt ??= {})[key] ??= [] as Span[]).push({ s, e, q });
    }
  }
  return out;
}

// ── Blocks → lines ─────────────────────────────────────────────────────────────

interface Line { text: string; marks: BookMark[]; para: ParaStyle; meta: LineMeta | null }

/** How a block's sources read on the page, e.g. "p. 12" or "14:32"; empty for none. */
export type SourceLabel = (src: number[]) => string;

/** Formatting ranges kept inside the first `len` characters. */
function clipFmt<T>(fmt: T, len: number): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fmt as Record<string, unknown>)) {
    out[k] = Array.isArray(v)
      ? v.filter((r: { s?: number }) => typeof r?.s !== "number" || r.s < len)
        .map((r: { e?: number }) => (typeof r?.e === "number" && r.e > len ? { ...r, e: len } : r))
      : v;
  }
  return out as T;
}

function blockLines(b: Block, sourceLabel: SourceLabel, media: Record<string, BookPicture>, onBoard = false): Line[] {
  const { id, type, src, text: stored, marks, fmt: storedFmt, ink, para, image, w, h, ...rest } = b;
  // Written without spaces, "(p.12)", so the typesetter never breaks a tag across two lines.
  const label = src.length ? sourceLabel(src).replace(/\s+/g, "") : "";
  const tag = label ? `(${label})` : "";
  const suffixTag = tag ? ` ${tag}` : "";
  // Repair a note saved with its own source tag (and a deleted picture's mark) inside the text,
  // which would otherwise show the tag twice.
  const repaired = stored.replace(/￼+$/u, "");
  const text = suffixTag && repaired.endsWith(suffixTag) ? repaired.slice(0, -suffixTag.length) : repaired;
  const fmt = text === stored || !storedFmt ? storedFmt : clipFmt(storedFmt, text.length);
  if (type === "image") {
    if (!image) return [];
    media[id] = { src: image, w: w ?? 400, h: h ?? 300 };
    return [{ text: OBJECT_CHAR, marks: [], para: `image:${id}`, meta: { id, type, src, prefix: "", suffix: "", rest: { ...rest, text } } }];
  }
  if (type === "table") {
    const rows = b.rows ?? [];
    return rows.map((row, r) => ({
      text: row.map(c => c.replace(/[\t\n]/g, " ")).join("\t"),
      marks: [],
      para: "table" as ParaStyle,
      meta: r === 0 ? { id, type, src, prefix: "", suffix: "", rest } : null,
    }));
  }
  // On a meeting's front page the column heading already says what a line is.
  let prefix = onBoard ? "" : LABEL[type] ?? "";
  if ((type === "definition" || type === "number") && b.term) prefix = `${b.term} — `;
  let suffix = "";
  if (type === "quote" && b.speaker) suffix = ` — ${b.speaker}`;
  if (type === "action") {
    const who = b.owner && b.owner !== "Not agreed" ? b.owner : "";
    const bits = [who, b.due ? `by ${b.due}` : ""].filter(Boolean).join(", ");
    if (bits) suffix = ` — ${bits}`;
  }
  suffix += suffixTag;
  const lineMarks = marksFromBlock({ text, marks, fmt, ink }, prefix.length);
  if (prefix && (type === "definition" || type === "number")) lineMarks.unshift({ type: "bold", start: 0, end: prefix.length - 3 });
  else if (prefix) lineMarks.unshift({ type: "italic", start: 0, end: prefix.length - 1 });
  if (suffix) lineMarks.push({ type: "italic", start: prefix.length + text.length, end: prefix.length + text.length + suffix.length });
  // The source tag is written in its own ink, so it reads as something to open, apart from the
  // note and from glossary terms (accent ink). Display only: lineToBlock keeps the note's own marks.
  if (tag) {
    const end = prefix.length + text.length + suffix.length;
    lineMarks.push({ type: "color", start: end - tag.length, end, value: INK_VALUE.blue });
  }
  const style: ParaStyle = para === "blank" || para === "divider"
    ? (para === "divider" ? "divider" : "normal")
    : type === "action" ? (b.done ? "checked" : "check")
      : (para ?? TYPE_PARA[type]);
  const line = para === "blank" || para === "divider" ? "" : prefix + text + suffix;
  return [{ text: line, marks: line ? lineMarks : [], para: style, meta: { id, type, src, prefix, suffix, rest, ...(tag ? { tag } : {}) } }];
}

function toEntry(id: string, title: string, role: BookEntry["role"], lines: Line[], section?: BookEntry["section"],
  media?: Record<string, BookPicture>): BookEntry {
  if (!lines.length) lines = [{ text: "", marks: [], para: "normal", meta: null }];
  const marks: BookMark[] = [];
  let at = 0;
  for (const l of lines) {
    for (const m of l.marks) marks.push({ ...m, start: m.start + at, end: m.end + at });
    at += l.text.length + 1;
  }
  return {
    id, title, role, text: lines.map(l => l.text).join("\n"), marks, paras: lines.map(l => l.para), meta: lines.map(l => l.meta),
    ...(section ? { section } : {}),
    ...(media && Object.keys(media).length ? { media } : {}),
  };
}

/** The whole notebook as book entries, in reading order. */
export function docToEntries(doc: NotebookDoc, kind: NotebookKind, sourceLabel: SourceLabel = () => ""): BookEntry[] {
  const out: BookEntry[] = [];
  if (kind === "meeting") {
    const lines: Line[] = [];
    for (const col of BOARD) {
      const items = doc.board[col.key];
      if (!items.length) continue;
      if (lines.length) lines.push({ text: "", marks: [], para: "normal", meta: null });
      lines.push({ text: col.label, marks: [{ type: "bold", start: 0, end: col.label.length }], para: "normal", meta: null });
      for (const b of items) lines.push(...blockLines(b, sourceLabel, {}, true));
    }
    out.push(toEntry("board", "At a glance", "board", lines));
  }
  for (const sec of doc.sections) {
    const { blocks, title, ...rest } = sec;
    const media: Record<string, BookPicture> = {};
    out.push(toEntry(sec.id, title, "section", blocks.flatMap(b => blockLines(b, sourceLabel, media)), rest, media));
  }
  if (doc.summary || kind !== "meeting") {
    // The summary is one text: its formatting runs across its lines.
    const all = marksFromBlock({ text: doc.summary, ...(doc.rich?.summary ?? {}) }, 0);
    let at = 0;
    out.push(toEntry("summary", "Summary", "summary", doc.summary.split("\n").map(t => {
      const from = at;
      at += t.length + 1;
      return {
        text: t, para: "normal" as ParaStyle, meta: null,
        marks: all.filter(m => m.end > from && m.start < from + t.length)
          .map(m => ({ ...m, start: Math.max(m.start, from) - from, end: Math.min(m.end, from + t.length) - from })),
      };
    })));
  }
  if (doc.cues.length || kind !== "meeting") {
    out.push(toEntry("cues", "Test yourself", "cues",
      doc.cues.map((t, i) => ({ text: t, marks: marksFromBlock({ text: t, ...(doc.rich?.[`cue:${i}`] ?? {}) }, 0), para: "numbered" as ParaStyle, meta: null }))));
  }
  return out;
}

// ── Lines → blocks ─────────────────────────────────────────────────────────────

/** The lines of an entry, each with its text, marks and style. */
function splitLines(e: Pick<BookEntry, "text" | "marks" | "paras" | "meta">): (Line & { start: number })[] {
  const out: (Line & { start: number })[] = [];
  let start = 0;
  e.text.split("\n").forEach((text, i) => {
    const end = start + text.length;
    const marks = e.marks.filter(m => m.end > start && m.start < end)
      .map(m => ({ ...m, start: Math.max(m.start, start) - start, end: Math.min(m.end, end) - start }));
    out.push({ text, marks, para: e.paras[i] ?? "normal", meta: e.meta[i] ?? null, start });
    start = end + 1;
  });
  return out;
}

function lineToBlock(l: Line, role: BookEntry["role"], media?: Record<string, BookPicture>): Block | null {
  const meta = l.meta;
  const picture = imageIdOf(l.para);
  if (picture) {
    const pic = media?.[picture];
    if (!pic) return null;
    return { id: meta?.id ?? picture, type: "image", text: "", src: meta?.src ?? [], ...(meta?.rest ?? {}), image: pic.src, w: pic.w, h: pic.h };
  }
  let text = l.text;
  let from = 0;
  const prefix = meta?.prefix ?? "";
  const suffix = meta?.suffix ?? "";
  if (prefix && text.startsWith(prefix)) { from = prefix.length; text = text.slice(from); }
  // A picture deleted next to this line can leave its object mark behind; it means nothing in text.
  text = text.replace(/￼+$/u, "");
  if (suffix && text.endsWith(suffix)) text = text.slice(0, text.length - suffix.length);
  let type: BlockType = meta ? (meta.type === "table" ? "note" : meta.type) : typeForPara(l.para, role);
  // Plain notes follow their line: star a point and it becomes a key point, and back.
  if (meta && (type === "point" || type === "key" || type === "note")) {
    if (l.para === "key") type = "key";
    else if (type === "key") type = l.para === "normal" ? "note" : "point";
  }
  const block: Block = { id: meta?.id ?? newId(), type, text, src: meta?.src ?? [], ...(meta?.rest ?? {}) };
  Object.assign(block, blockFromMarks(l.marks, from, from + text.length, text));
  if (type === "action") block.done = l.para === "checked";
  const para: BlockPara | undefined =
    l.para === "divider" ? "divider"
      : !text.trim() ? "blank"
        : (BLOCK_PARAS as readonly string[]).includes(l.para) && l.para !== TYPE_PARA[type] && !(type === "action" && (l.para === "check" || l.para === "checked"))
          ? l.para as BlockPara : undefined;
  if (para) block.para = para;
  return block;
}

/** Table lines back into one table block. */
function tableBlock(rows: Line[]): Block {
  const meta = rows[0]?.meta;
  return {
    id: meta?.id ?? newId(), type: "table", text: "", src: meta?.src ?? [], ...(meta?.rest ?? {}),
    rows: rows.map(r => r.text.split("\t")),
  };
}

/** An entry's lines back into blocks. A heading line starts a new section (returned in `more`). */
export function entryToBlocks(e: BookEntry): { blocks: Block[]; more: { title: string; blocks: Block[] }[] } {
  const lines = splitLines(e);
  const groups: { title: string; blocks: Block[] }[] = [{ title: "", blocks: [] }];
  let column: BlockType = "decision";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.para === "heading" && e.role === "section") { groups.push({ title: l.text.trim() || "New section", blocks: [] }); continue; }
    if (l.para === "table") {
      const rows = [l];
      while (lines[i + 1]?.para === "table" && !lines[i + 1].meta) rows.push(lines[++i]);
      groups[groups.length - 1].blocks.push(tableBlock(rows));
      continue;
    }
    if (e.role === "board" && !l.meta) {
      // The front page: a column's heading says what the new lines under it are.
      const col = BOARD.find(c => c.label === l.text.trim());
      if (col) { column = col.type; continue; }
      if (!l.text.trim()) continue;
      const nb = lineToBlock(l, e.role, e.media);
      if (nb) groups[groups.length - 1].blocks.push({ ...nb, type: column, ...(column === "action" ? { owner: "", due: "", done: l.para === "checked" } : {}) });
      continue;
    }
    if (e.role === "board" && l.meta) column = l.meta.type;
    const b = lineToBlock(l, e.role, e.media);
    if (b) groups[groups.length - 1].blocks.push(b);
  }
  // Blank lines at the very end are just where the cursor was.
  for (const g of groups) while (g.blocks.length && g.blocks[g.blocks.length - 1].para === "blank") g.blocks.pop();
  const [first, ...more] = groups;
  return { blocks: first.blocks, more };
}

/** The notebook document with the book's entries written back into it. */
export function entriesToDoc(doc: NotebookDoc, entries: BookEntry[]): NotebookDoc {
  const sections: Section[] = [];
  const board: Record<BoardKey, Block[]> = { decisions: [], actions: [], questions: [], risks: [], numbers: [] };
  let summary = doc.summary;
  let cues = doc.cues;
  let rich = doc.rich;
  for (const e of entries) {
    if (e.role === "summary") {
      summary = e.text.replace(/\n+$/, "");
      rich = withTextRich(rich, "summary", blockFromMarks(e.marks, 0, summary.length, summary));
      continue;
    }
    if (e.role === "cues") {
      const kept = splitLines(e).filter(l => l.text.trim());
      cues = kept.map(l => l.text.trim());
      rich = Object.fromEntries(Object.entries(rich ?? {}).filter(([k]) => !k.startsWith("cue:")));
      kept.forEach((l, i) => {
        const lead = l.text.length - l.text.trimStart().length;
        rich = withTextRich(rich, `cue:${i}`, blockFromMarks(l.marks, lead, lead + cues[i].length, cues[i]));
      });
      continue;
    }
    const { blocks, more } = entryToBlocks(e);
    if (e.role === "board") {
      for (const b of blocks) {
        const col = BOARD.find(c => c.type === b.type);
        if (col) board[col.key].push(b);
      }
      continue;
    }
    const kept = doc.sections.find(s => s.id === e.id);
    sections.push({ ...(e.section ?? { id: e.id, src: [] }), ...(kept?.rich ? { rich: kept.rich } : {}), id: e.id, title: e.title, blocks });
    for (const m of more) sections.push({ id: newId(), title: m.title, src: [], blocks: m.blocks });
  }
  const out: NotebookDoc = { ...doc, sections, board: entries.some(e => e.role === "board") ? board : doc.board, summary, cues };
  if (rich && Object.keys(rich).length) out.rich = rich; else delete out.rich;
  return out;
}

/** The document's formatting map with one text's formatting set (or dropped when it has none). */
function withTextRich(rich: NotebookDoc["rich"], key: string, r: Pick<Block, "marks" | "fmt" | "ink">): NotebookDoc["rich"] {
  const next = { ...(rich ?? {}) };
  if (r.marks?.length || r.ink?.length || (r.fmt && Object.keys(r.fmt).length)) next[key] = r;
  else delete next[key];
  return next;
}

// ── Keeping lines tied to their blocks while the reader types ────────────────

/**
 * The line metadata after an edit from `before` to `after`. Unchanged lines at
 * the start and end keep theirs; in the changed stretch, lines keep theirs in
 * order (so pressing Enter splits a line into the old block and a new one, and
 * joining two lines keeps the first), and any extra lines are new.
 */
export function remapMeta(before: string, after: string, meta: readonly (LineMeta | null)[]): (LineMeta | null)[] {
  const a = before.split("\n"), b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldMid = meta.slice(p, a.length - s);
  const newCount = b.length - p - s;
  const mid = Array.from({ length: newCount }, (_, i) => oldMid[i] ?? null);
  return [...meta.slice(0, p), ...mid, ...meta.slice(a.length - s)];
}
