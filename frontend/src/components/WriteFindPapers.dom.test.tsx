// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../test/dom";
import { FindPapers } from "./WriteFindPapers";
import { searchPapers, type Paper, type PaperSearch } from "../lib/papers";
import { writingApi } from "../lib/writing";
import type { Ref } from "../lib/citations";

// Written down first (docs/write-citation-backbone.md, "Find papers"): what the writer sees when a
// provider is missing, when there are thousands of matches, when a paper is a preprint or retracted,
// when it is already a source, and that nothing is sent until they press Search.

vi.mock("../lib/papers", async importOriginal => ({ ...(await importOriginal<typeof import("../lib/papers")>()), searchPapers: vi.fn() }));
vi.mock("../lib/writing", () => ({ writingApi: { addRef: vi.fn() } }));
vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const paper = (over: Partial<Paper>): Paper => ({
  id: "doi:10.1/x", doi: "10.1/x", title: "A paper", authors: ["Ji-Hoon Kim"], year: 2020, venue: "A Journal", abstract: "",
  citations: 0, open_access: false, oa_url: "", preprint: false, retracted: false, url: "", type: "article", volume: "", issue: "",
  pages: "", sources: ["openalex"], openalex_id: "W1", s2_id: "", ...over,
});
const VARIABILITY = paper({
  id: "doi:10.1044/2020_ajslp-20-00112", doi: "10.1044/2020_ajslp-20-00112", title: "Variability of Stuttering: Behavior and Impact",
  authors: ["Seth E. Tichenor", "J. Scott Yaruss"], year: 2020, venue: "American Journal of Speech-Language Pathology", citations: 102,
  open_access: true, abstract: "Purpose It has long been known that stuttering behaviors vary across time and situation.",
  sources: ["openalex", "semantic_scholar"],
});
const PREPRINT = paper({ id: "doi:10.48550/arxiv.2211.09731", doi: "10.48550/arxiv.2211.09731", title: "Stutter-TTS", venue: "arXiv", preprint: true, year: 2022, citations: 2 });
const RETRACTED = paper({ id: "openalex:W9", doi: "", title: "A withdrawn study", retracted: true, year: 2012 });
const RESULT: PaperSearch = {
  query: "situational variability stuttering adults", results: [VARIABILITY, PREPRINT, RETRACTED], total: 3561,
  notice: "Semantic Scholar is busy right now, so these results are from OpenAlex only.", cached_at: null,
  providers: { openalex: { status: "ok", count: 25 }, semantic_scholar: { status: "busy", count: 0 } },
};
const ref = (over: Partial<Ref>): Ref => ({ id: 1, key: "tichenor2020", item: { title: "Variability of Stuttering: Behavior and Impact" }, doi: "", document_id: null, note: "", ...over });

beforeEach(() => {
  vi.mocked(searchPapers).mockReset().mockResolvedValue(RESULT);
  vi.mocked(writingApi.addRef).mockReset();
});

async function find(user = userEvent.setup()) {
  await user.type(screen.getByLabelText("Search for papers"), "situational variability stuttering adults");
  await user.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Variability of Stuttering: Behavior and Impact");
  return user;
}

// Typing into rendered inputs is slow when the whole suite runs at once.
describe("Find papers", { timeout: 20_000 }, () => {
  it("sends nothing until Search, then shows each result with what a writer needs to judge it", async () => {
    render(<FindPapers projectId={7} refs={[]} onAdded={vi.fn()} />);
    expect(searchPapers).not.toHaveBeenCalled();
    await find();
    expect(searchPapers).toHaveBeenCalledWith("situational variability stuttering adults", expect.objectContaining({ preprints: true }));
    const card = screen.getByRole("article", { name: "Variability of Stuttering: Behavior and Impact" });
    expect(within(card).getByText("Seth E. Tichenor and J. Scott Yaruss")).toBeTruthy();
    expect(within(card).getByText(/American Journal of Speech-Language Pathology/)).toBeTruthy();
    expect(within(card).getByText("2020")).toBeTruthy();
    expect(within(card).getByText("102 citations")).toBeTruthy();
    expect(within(card).getByText("Open access")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Stutter-TTS" })).getByText("Preprint")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "A withdrawn study" })).getByText("Retracted")).toBeTruthy();
  });

  it("says which provider is missing and how many matches there are", async () => {
    render(<FindPapers projectId={7} refs={[]} onAdded={vi.fn()} />);
    await find();
    expect(screen.getByText(/Semantic Scholar is busy right now/)).toBeTruthy();
    expect(screen.getByText(/About 3,561 matches; these are the 3 most relevant/)).toBeTruthy();
  });

  it("opens an abstract on request", async () => {
    render(<FindPapers projectId={7} refs={[]} onAdded={vi.fn()} />);
    const user = await find();
    const card = screen.getByRole("article", { name: "Variability of Stuttering: Behavior and Impact" });
    expect(within(card).queryByText(/stuttering behaviors vary/)).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Abstract" }));
    expect(within(card).getByText(/stuttering behaviors vary/)).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Stutter-TTS" })).queryByRole("button", { name: "Abstract" })).toBeNull();
  });

  it("adds a result as a source and then shows it as added", async () => {
    const added = { ...ref({ id: 5, doi: VARIABILITY.doi }), existing: false };
    vi.mocked(writingApi.addRef).mockResolvedValue(added);
    const onAdded = vi.fn();
    const { rerender } = render(<FindPapers projectId={7} refs={[]} onAdded={onAdded} />);
    const user = await find();
    const card = screen.getByRole("article", { name: "Variability of Stuttering: Behavior and Impact" });
    await user.click(within(card).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added));
    expect(writingApi.addRef).toHaveBeenCalledWith(7, { paper: VARIABILITY });
    rerender(<FindPapers projectId={7} refs={[added]} onAdded={onAdded} />);
    expect(within(card).getByRole("button", { name: "Added" })).toHaveProperty("disabled", true);
  });

  it("knows a paper is already a source by its title and year when the source has no DOI", async () => {
    render(<FindPapers projectId={7} refs={[ref({ item: { title: "variability of stuttering — behavior and impact", issued: { "date-parts": [[2020]] } } })]} onAdded={vi.fn()} />);
    await find();
    const card = screen.getByRole("article", { name: "Variability of Stuttering: Behavior and Impact" });
    expect(within(card).getByRole("button", { name: "Added" })).toBeTruthy();
  });

  it("sends the filters the writer chose", async () => {
    render(<FindPapers projectId={7} refs={[]} onAdded={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.type(screen.getByLabelText("From year"), "2010");
    await user.type(screen.getByLabelText("To year"), "2024");
    await user.click(screen.getByLabelText("Open access only"));
    await user.click(screen.getByLabelText("Include preprints"));
    await user.type(screen.getByLabelText("At least this many citations"), "10");
    await user.selectOptions(screen.getByLabelText("Field"), "psychology");
    await find(user);
    expect(searchPapers).toHaveBeenCalledWith("situational variability stuttering adults",
      { year_from: 2010, year_to: 2024, open_access: true, min_citations: 10, preprints: false, field: "psychology" });
  });

  it("shows a failed search as a plain sentence, and keeps what was typed", async () => {
    vi.mocked(searchPapers).mockRejectedValue(new Error("You seem to be offline. Finding papers needs the internet; your sources and draft are all here."));
    render(<FindPapers projectId={7} refs={[]} onAdded={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search for papers"), "stuttering");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/You seem to be offline/)).toBeTruthy();
    expect((screen.getByLabelText("Search for papers") as HTMLInputElement).value).toBe("stuttering");
  });

  it("says when nothing matched", async () => {
    vi.mocked(searchPapers).mockResolvedValue({ ...RESULT, results: [], total: 0, notice: "" });
    render(<FindPapers projectId={7} refs={[]} onAdded={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search for papers"), "zzzz qqqq");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/No papers matched/)).toBeTruthy();
  });
});
