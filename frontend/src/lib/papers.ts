/**
 * Find papers, in Write's Sources panel (backend/scholar.py, docs/write-citation-backbone.md).
 * OpenAlex and Semantic Scholar searched at once and merged; only the search words and filters
 * leave the computer. No AI.
 */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import type { Ref } from "./citations";

export interface Paper {
  id: string; doi: string; title: string; authors: string[]; year: number | null; venue: string; abstract: string;
  citations: number; open_access: boolean; oa_url: string; preprint: boolean; retracted: boolean; url: string;
  type: string; volume: string; issue: string; pages: string; sources: ("openalex" | "semantic_scholar")[];
  openalex_id: string; s2_id: string;
}
export type ProviderStatus = "ok" | "busy" | "down" | "offline";
export interface PaperSearch {
  query: string; results: Paper[]; total: number | null; notice: string; cached_at: string | null;
  providers: Record<"openalex" | "semantic_scholar", { status: ProviderStatus; count: number }>;
}
export interface PaperFilters {
  year_from?: number | null; year_to?: number | null; open_access?: boolean; min_citations?: number; preprints?: boolean; field?: string;
}

/** The fields a search can be narrowed to; the keys are backend/scholar.py's FIELDS. */
export const FIELDS: [string, string][] = [
  ["", "Any field"], ["psychology", "Psychology"], ["linguistics", "Linguistics and language"], ["medicine", "Medicine and health"],
  ["neuroscience", "Neuroscience"], ["education", "Education"], ["computer_science", "Computer science"],
  ["social_sciences", "Social sciences"], ["business", "Business and economics"], ["humanities", "Arts and humanities"],
  ["engineering", "Engineering"], ["mathematics", "Mathematics"], ["biology", "Biology"], ["environment", "Environmental science"],
  ["physics", "Physics and chemistry"],
];

export const PROVIDER_NAMES = { openalex: "OpenAlex", semantic_scholar: "Semantic Scholar" } as const;

export async function searchPapers(q: string, f: PaperFilters = {}): Promise<PaperSearch> {
  const params = new URLSearchParams({ q });
  if (f.year_from) params.set("year_from", String(f.year_from));
  if (f.year_to) params.set("year_to", String(f.year_to));
  if (f.open_access) params.set("open_access", "true");
  if (f.min_citations) params.set("min_citations", String(f.min_citations));
  if (f.preprints === false) params.set("preprints", "false");
  if (f.field) params.set("field", f.field);
  const res = await fetchApi(`/writing/papers/search?${params}`);
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

/** The same title however it is cased, spaced or punctuated, in any script (backend title_key). */
export function titleKey(title: string, year: number | null | undefined): string {
  const letters = (title || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return letters ? `${letters}|${year ?? ""}` : "";
}

function refYear(r: Ref): number | null {
  const parts = (r.item.issued as { "date-parts"?: number[][] } | undefined)?.["date-parts"];
  return parts?.[0]?.[0] ?? null;
}

/** The project's source this paper already is, if any: the same DOI, or the same title and year. */
export function addedAs(paper: Paper, refs: Ref[]): Ref | undefined {
  const doi = paper.doi.toLowerCase();
  if (doi) {
    const same = refs.find(r => r.doi && r.doi.toLowerCase() === doi);
    if (same) return same;
  }
  const key = titleKey(paper.title, paper.year);
  return key ? refs.find(r => (!r.doi || !doi) && titleKey(String(r.item.title ?? ""), refYear(r)) === key) : undefined;
}

/** "Kim, Lee and Park" or "Kim, Lee, Park et al." */
export function authorLine(authors: string[], max = 3): string {
  if (!authors.length) return "Unknown authors";
  if (authors.length <= max) return authors.length === 1 ? authors[0]! : `${authors.slice(0, -1).join(", ")} and ${authors[authors.length - 1]}`;
  return `${authors.slice(0, max).join(", ")} et al.`;
}

/** "About 3,561 matches; these are the 25 most relevant." when there are more than shown. */
export function moreLine(s: PaperSearch): string {
  if (s.total == null || s.total <= s.results.length) return "";
  return `About ${s.total.toLocaleString("en-GB")} matches; these are the ${s.results.length} most relevant. Narrow the search or add filters to see others.`;
}
