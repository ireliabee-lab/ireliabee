import { GraduationCap, Users, BookOpen, Star, ListChecks, ShieldCheck } from "lucide-react";
import { DEFAULT_STYLE, type NotebookKind, type NotebookSummary } from "../../lib/notebook";
import { themeById } from "../../lib/book/themes";

const KIND_ICON: Record<NotebookKind, JSX.Element> = {
  lecture: <GraduationCap size={12} />, meeting: <Users size={12} />, reading: <BookOpen size={12} />,
};
const KIND_LABEL: Record<NotebookKind, string> = { lecture: "Lecture", meeting: "Meeting", reading: "Reading" };

/** The cover a notebook wears on the shelf: its paper's (Nkɔmmɔ theme) leather, cloth or card. */
function coverOf(item: NotebookSummary) {
  const paper = item.style?.paper ?? DEFAULT_STYLE[item.kind]?.paper ?? "classic";
  const dark = typeof window !== "undefined" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  return themeById(paper === "auto" ? (dark ? "dark" : "classic") : paper).cover;
}

/**
 * Whether a cover is light enough to need dark lettering. The cover text was always cream, which
 * on the Light and Clean white covers was cream on white: unreadable.
 */
export function lightCover(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1] as string, 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const luminance = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return luminance > 0.45;
}

/** "3 sections, 4 key points, 2 actions, updated 27 Sep": what a screen reader hears for a book. */
function spokenMeta(item: NotebookSummary): string {
  const unit = item.kind === "reading" ? "slide" : "section";
  const parts = [`${item.counts.sections} ${unit}${item.counts.sections === 1 ? "" : "s"}`];
  if (item.counts.key) parts.push(`${item.counts.key} key point${item.counts.key === 1 ? "" : "s"}`);
  if (item.counts.actions) parts.push(`${item.counts.actions} action${item.counts.actions === 1 ? "" : "s"}`);
  parts.push(`updated ${new Date(item.updated_at + "Z").toLocaleDateString([], { day: "numeric", month: "short" })}`);
  return parts.join(", ");
}

/**
 * Every notebook as a bound book standing on a shelf (A5 in
 * docs/notebook-book-and-deep-read.md): the cover is the notebook's own paper
 * theme, the spine side carries its kind, and the front its title. Each book is
 * a button, in reading order, so the keyboard and screen readers go shelf by
 * shelf, left to right.
 */
/** Smaller type for a title whose longest word would otherwise break in the middle. */
export function wordFit(title: string): string {
  const longest = Math.max(0, ...title.split(/\s+/).map(w => w.length));
  return longest >= 13 ? "longer-word" : longest >= 10 ? "long-word" : "";
}

export default function Shelf({ items, onOpen }: { items: NotebookSummary[]; onOpen: (id: number) => void }) {
  return (
    <ul className="nb-shelf" aria-label="Notebooks">
      {items.map(item => {
        const c = coverOf(item);
        const cov = item.coverage;
        return (
          <li key={item.id}>
            <button type="button" className={`nb-book nb-book-${c.style}${lightCover(c.base) ? " nb-book-light" : ""}`} onClick={() => onOpen(item.id)}
              aria-label={`${KIND_LABEL[item.kind]}: ${item.title}. ${spokenMeta(item)}`}
              style={{
                ["--cv-base" as string]: c.base, ["--cv-light" as string]: c.light, ["--cv-dark" as string]: c.dark,
                ["--cv-stitch" as string]: c.stitch, ["--cv-emboss" as string]: c.emboss, ["--cv-hi" as string]: c.embossHighlight,
              }}>
              <span className="nb-book-spine" aria-hidden="true" />
              <span className="nb-book-face" aria-hidden="true">
                <span className="nb-book-kind">{KIND_ICON[item.kind]} {KIND_LABEL[item.kind]}</span>
                <span className={`nb-book-title ${wordFit(item.title)}`}>{item.title || "Untitled"}</span>
                {item.kind === "reading" && item.scope?.label && <span className="nb-book-scope">{item.scope.label}</span>}
                <span className="nb-book-meta">
                  {item.kind === "reading" && cov?.required
                    ? <span><ShieldCheck size={10} /> {cov.covered}/{cov.required}</span>
                    : item.counts.key > 0 && <span><Star size={10} /> {item.counts.key}</span>}
                  {item.counts.actions > 0 && <span><ListChecks size={10} /> {item.counts.actions}</span>}
                  <span>{new Date(item.updated_at + "Z").toLocaleDateString([], { day: "numeric", month: "short" })}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
