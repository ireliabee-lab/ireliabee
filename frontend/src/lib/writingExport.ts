/**
 * Exporting a piece of writing from Write (docs/academic-writing.md, stage 6): the finished document
 * with its citations formatted and its reference list, as Word (.docx, built here with the docx
 * library), PDF (made by the backend, backend/writing_export.py) or Markdown.
 */
import { formatDocument, type Ref } from "./citations";

export interface ExportSection { title: string; paragraphs: string[] }
export interface ExportDocument {
  title: string;
  /** Essays and reflections run as continuous prose; other kinds keep their section headings. */
  headings: boolean;
  sections: ExportSection[];
  referencesTitle: string;
  references: string[];
  /** Author-date lists hang their second lines; numbered lists (IEEE, Vancouver) don't. */
  hanging: boolean;
  /** APA and MLA papers are double-spaced; the rest use 1.5. */
  doubleSpaced: boolean;
  /** Keys cited in the text that have no source: they stay visible in the export, and are reported. */
  unknown: string[];
}

const NUMBERED = new Set(["ieee", "vancouver"]);
const DOUBLE = new Set(["apa", "mla"]);

/** The paragraphs of a text: blank lines or single line breaks start a new one. */
export const paragraphsOf = (text: string) => text.split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);

export async function buildDocument(p: {
  title: string; style: string; sections: { title: string; body: string }[];
}, refs: Ref[], headings: boolean): Promise<ExportDocument> {
  const written = p.sections.filter(s => s.body.trim());
  const doc = await formatDocument(written.map(s => s.body), refs, p.style);
  return {
    title: p.title.trim() || "Untitled",
    headings,
    sections: written.map((s, i) => ({ title: s.title, paragraphs: paragraphsOf(doc.texts[i] ?? "") })),
    referencesTitle: p.style === "mla" ? "Works Cited" : "References",
    // Only what is cited: with no source cited, formatDocument lists them all, which would credit
    // sources the text never uses.
    references: refs.length - doc.uncited.length > 0 ? doc.bibliography : [],
    hanging: !NUMBERED.has(p.style),
    doubleSpaced: DOUBLE.has(p.style),
    unknown: doc.unknown,
  };
}

export function toMarkdown(d: ExportDocument): string {
  const out = [`# ${d.title}`, ""];
  for (const s of d.sections) {
    if (d.headings) out.push(`## ${s.title}`, "");
    for (const para of s.paragraphs) out.push(para, "");
  }
  if (d.references.length) {
    out.push(`## ${d.referencesTitle}`, "");
    for (const r of d.references) out.push(r, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function toDocx(d: ExportDocument): Promise<Blob> {
  const { AlignmentType, Document, Header, Packer, PageNumber, Paragraph, TextRun } = await import("docx");
  const line = d.doubleSpaced ? 480 : 360;   // twips: double or 1.5 line spacing
  const font = "Times New Roman";
  const size = 24;                             // half-points: 12 pt
  const body = (text: string) => new Paragraph({
    children: [new TextRun({ text, font, size })],
    spacing: { line, after: 0 }, indent: { firstLine: 720 },
  });
  const heading = (text: string) => new Paragraph({
    children: [new TextRun({ text, font, size, bold: true })],
    alignment: AlignmentType.CENTER, spacing: { line, before: 240, after: 0 },
  });
  const children = [
    new Paragraph({ children: [new TextRun({ text: d.title, font, size: 28, bold: true })], alignment: AlignmentType.CENTER, spacing: { line, after: 240 } }),
  ];
  for (const s of d.sections) {
    if (d.headings) children.push(heading(s.title));
    for (const para of s.paragraphs) children.push(body(para));
  }
  if (d.references.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: d.referencesTitle, font, size, bold: true })], alignment: AlignmentType.CENTER, pageBreakBefore: true, spacing: { line, after: 0 } }));
    for (const r of d.references) {
      children.push(new Paragraph({
        children: [new TextRun({ text: r, font, size })], spacing: { line, after: 0 },
        indent: d.hanging ? { left: 720, hanging: 720 } : undefined,
      }));
    }
  }
  const doc = new Document({
    creator: "iReliabee Write", title: d.title,
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], font, size })] })] }) },
      children,
    }],
  });
  return Packer.toBlob(doc);
}

/** A file name from the title: letters, numbers, spaces and dashes only. */
export function fileName(title: string, ext: string): string {
  const base = title.normalize("NFKD").replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || "writing"}.${ext}`;
}
