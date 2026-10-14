/**
 * Citations in Write: markers in the draft, formatted in the project's style by citeproc-js with the
 * Citation Style Language's own styles (assets/csl, ATTRIBUTION.md). Loaded only when formatting.
 *
 * In the draft a citation is a marker the writer can read: [@lecun2015], [@lecun2015, p. 12] or
 * several at once, [@lecun2015; @kim2020]. Numbered styles (IEEE, Vancouver) number sources in the
 * order they are first cited across the whole document, so a document is formatted in one go.
 */

export interface CslItem { [field: string]: unknown; title?: string }
/** What a search or a check knows about a source, beyond its citation (backend/writing_refs.py meta). */
export interface RefMeta {
  citations?: number; open_access?: boolean; oa_url?: string; preprint?: boolean; retracted?: boolean; venue?: string;
  openalex_id?: string; s2_id?: string; found_by?: string[]; searched_at?: string;
}
export interface Ref {
  id: number; key: string; item: CslItem; doi: string; document_id: number | null; note: string;
  /** The abstract, when the source came from Find papers. */
  abstract?: string; meta?: RefMeta;
}

export interface CiteItem { key: string; locator?: string; label?: string }
export interface Marker { start: number; end: number; items: CiteItem[] }

const MARKER = /\[(@[^\]\n]{1,400})\]/g;
const LABELS: [RegExp, string][] = [
  [/^(?:pp?\.|pages?)\s*/i, "page"], [/^(?:ch\.|chap\.|chapter)\s*/i, "chapter"], [/^(?:para\.|paras?\.|¶)\s*/i, "paragraph"],
  [/^(?:sec\.|section|§)\s*/i, "section"], [/^(?:fig\.|figure)\s*/i, "figure"], [/^(?:vol\.|volume)\s*/i, "volume"],
];

/** Every citation marker in a text, with its sources and any page or other locator. */
export function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(MARKER)) {
    const items: CiteItem[] = [];
    for (const part of (m[1] as string).split(";")) {
      const one = /^\s*@([\w:.#$%&+?<>~/-]+)\s*(?:,\s*(.+?))?\s*$/.exec(part);
      if (!one) { items.length = 0; break; }
      const item: CiteItem = { key: one[1] as string };
      const loc = one[2]?.trim();
      if (loc) {
        const found = LABELS.find(([re]) => re.test(loc));
        item.label = found ? found[1] : "page";
        item.locator = found ? loc.replace(found[0], "").trim() : loc;
      }
      items.push(item);
    }
    if (items.length) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, items });
  }
  return out;
}

/** The marker for one source, as the Cite button inserts it. */
export function markerFor(key: string, page?: string): string {
  return page?.trim() ? `[@${key}, p. ${page.trim()}]` : `[@${key}]`;
}

/**
 * The text with a citation marker inserted at the cursor, and where the cursor goes after it. Right
 * after a sentence's full stop (or a closing quote after it) the marker goes inside the sentence, as
 * citations do: "… well [@x]." A space separates it from the word before.
 */
export function insertCitation(text: string, caret: number, marker: string): { text: string; caret: number } {
  let at = Math.max(0, Math.min(caret, text.length));
  const head = text.slice(0, at).trimEnd();
  const end = /[.!?]["'”’)\]]*$/.exec(head);
  if (end && head.length > end[0].length) at = head.length - end[0].length;
  const before = text.slice(0, at), after = text.slice(at);
  const glue = before && !/\s$/.test(before) ? " " : "";
  return { text: before + glue + marker + after, caret: before.length + glue.length + marker.length };
}

// ── Formatting ──────────────────────────────────────────────────────────────────

type Engine = {
  setOutputFormat(f: string): void; updateItems(ids: string[]): void;
  makeCitationCluster(items: { id: string; locator?: string; label?: string }[]): string;
  makeBibliography(): [unknown, string[]] | false;
};

const STYLE_FILES: Record<string, () => Promise<{ default: string }>> = {
  apa: () => import("../assets/csl/apa.csl?raw"),
  harvard: () => import("../assets/csl/harvard-cite-them-right.csl?raw"),
  ieee: () => import("../assets/csl/ieee.csl?raw"),
  vancouver: () => import("../assets/csl/vancouver.csl?raw"),
  mla: () => import("../assets/csl/modern-language-association.csl?raw"),
  chicago: () => import("../assets/csl/chicago-author-date.csl?raw"),
};
const LOCALE: Record<string, string> = { harvard: "en-GB", vancouver: "en-GB" };

let loaded: Promise<{ CSL: { Engine: new (sys: object, style: string, lang?: string) => Engine }; locales: Record<string, string> }> | null = null;
function engineKit() {
  loaded ??= Promise.all([
    import("citeproc"),
    import("../assets/csl/locales-en-GB.xml?raw"),
    import("../assets/csl/locales-en-US.xml?raw"),
  ]).then(([csl, gb, us]) => ({
    CSL: ((csl as unknown as { default?: unknown }).default ?? csl) as never,
    locales: { "en-GB": gb.default, "en-US": us.default },
  }));
  return loaded;
}

export interface FormattedDocument {
  /** Each text with its markers replaced by formatted citations. */
  texts: string[];
  /** The reference list, in the style's order, one entry per source cited (or every source, if none is). */
  bibliography: string[];
  /** Keys cited in the text that the project has no source for. */
  unknown: string[];
  /** Sources the project has that the text never cites. */
  uncited: string[];
}

/** Format a whole document's texts and its reference list in a style. */
export async function formatDocument(texts: string[], refs: Ref[], style: string): Promise<FormattedDocument> {
  const { CSL, locales } = await engineKit();
  const xml = (await (STYLE_FILES[style] ?? STYLE_FILES.apa)()).default;
  const items: Record<string, CslItem> = {};
  for (const r of refs) items[r.key] = { ...r.item, id: r.key };
  const lang = LOCALE[style] ?? "en-US";
  const engine = new CSL.Engine({
    retrieveLocale: (l: string) => locales[l] ?? locales[lang] ?? locales["en-US"],
    retrieveItem: (id: string) => items[id],
  }, xml, lang);
  engine.setOutputFormat("text");

  const markers = texts.map(findMarkers);
  const order: string[] = [];
  const unknown = new Set<string>();
  for (const ms of markers) for (const m of ms) for (const it of m.items) {
    if (!items[it.key]) unknown.add(it.key);
    else if (!order.includes(it.key)) order.push(it.key);
  }
  const uncited = refs.map(r => r.key).filter(k => !order.includes(k));
  engine.updateItems(order.length ? order : refs.map(r => r.key));

  const formatted = texts.map((text, i) => {
    let out = "", at = 0;
    for (const m of markers[i] ?? []) {
      out += text.slice(at, m.start);
      const known = m.items.filter(it => items[it.key]);
      out += known.length
        ? engine.makeCitationCluster(known.map(it => ({ id: it.key, ...(it.locator ? { locator: it.locator, label: it.label } : {}) })))
        : text.slice(m.start, m.end);
      at = m.end;
    }
    return out + text.slice(at);
  });
  const bib = engine.makeBibliography();
  return {
    texts: formatted,
    bibliography: bib ? bib[1].map(e => e.trim()) : [],
    unknown: [...unknown],
    uncited,
  };
}
