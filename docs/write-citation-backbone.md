# Write: the citation backbone (release A)

Approved plan "Write: citation backbone", release A. It adds three things to Write
(docs/academic-writing.md):

1. **Find papers**: search scholarly literature from the Sources panel and add a result as a source.
2. **Cite as you write**: an `@` source picker in the editor and a live reference list.
3. **Citation cards**: what a citation points to, and warnings about weak sources.

**Release A uses no AI at all.** Nothing here is paid for in credits, and nothing here writes a
word of the student's text (the owner's rule of 12 October 2026: Write coaches, it never writes).

## What leaves the computer

Only the **search words** and the **filters** go to OpenAlex and Semantic Scholar, and only a
paper's **DOI** goes to doi.org / Crossref. Never a draft, a note, the task brief or a project
title. The Privacy Policy names each service (`website/public/privacy.html#write-papers`).

## 1. Find papers

`backend/scholar.py`, `GET /writing/papers/search`, the "Find papers" tab of the Sources panel.

- **OpenAlex** (`api.openalex.org/works?search=`), with `mailto=support@ireliabee.co.uk` for the
  polite pool. Abstracts come as an inverted index (word → positions) and are rebuilt in order.
- **Semantic Scholar** Graph API (`paper/search`), asked for title, authors, year, venue, abstract,
  citation count, external ids, open access and publication types.
- Both are asked at once. Results are merged by DOI, or by normalised title and year when a
  record has no DOI, and ranked by reciprocal rank fusion: each result scores `1/(10 + rank)` for
  each provider that returned it, so a paper both providers rank highly comes first.
- **Filters**: from year, to year, open access only, minimum citations, include preprints, field.
  Each provider is sent the filters it understands, and every filter is applied again to the
  merged list so the two providers' answers agree.
- **Cache**: each search (query plus filters) is kept in `scholar_cache` for 7 days. A search that
  one provider failed is kept for 1 hour only, so a short outage does not hide that provider's
  papers for a week. Entries older than 7 days are deleted when a new one is written.
- **Add**: a result with a DOI is looked up at doi.org (the same lookup as "By DOI", so the record
  is the publisher's); if that fails, or the result has no DOI, the source is built from the search
  record. Its abstract, citation count, open-access link, preprint flag and provider ids are kept
  with the source (`writing_refs.abstract`, `writing_refs.meta`) for the citation card.

### Failure modes (written before the code; one test each in `backend/tests/test_scholar.py`)

| # | What goes wrong | What the writer sees |
|---|---|---|
| 1 | One provider is down (timeout, connection refused, 5xx) | The other provider's results, with "Semantic Scholar didn't answer, so these are from OpenAlex only." Never a failed search. |
| 2 | One provider rate-limits us (HTTP 429). Semantic Scholar's shared, keyless pool does this often: it refused every request for minutes while this was built | The same as 1, saying the service is busy. |
| 3 | Both providers fail | One plain message: busy, or offline. If an older copy of the same search is cached, it is shown, dated. |
| 4 | Offline (no network at all) | "You seem to be offline. Finding papers needs the internet; your sources and draft are all here." |
| 5 | A result has no DOI | Merged by title and year instead; "Add" builds the source from the search record; adding it twice gives the one already there (title and year match). |
| 6 | The same paper from both providers, DOIs in different cases or as `https://doi.org/` links | One result, both providers named, the higher citation count and the longer abstract kept. |
| 7 | Adding a paper the project already has | "Already in your sources", never a second copy; the card shows "Added". |
| 8 | Non-Latin titles and names (Chinese, Arabic, Cyrillic) | Kept as written; merging by title keeps letters of every script; a one-word name is kept whole (an organisation, or a name in a script without spaces). |
| 9 | Huge result sets (thousands of matches) | The 25 most relevant, with "about 3,561 matches: narrow the search or add filters". Never paging through thousands. |
| 10 | Empty, one-letter or very long queries | Refused before any request: "Type at least 2 characters" / cut to 300 characters. |
| 11 | Punctuation the provider can't take (hyphens confuse Semantic Scholar's search) | Hyphens are sent to Semantic Scholar as spaces. |
| 12 | A retracted paper in the results | Flagged "Retracted" on its card (OpenAlex `is_retracted`). It can still be added: a review may need to cite it. |
| 13 | A preprint | Badged "Preprint"; left out when "Include preprints" is off. |
| 14 | A provider sends malformed JSON or an unexpected shape | Treated as that provider being down (1). |
| 15 | doi.org has no record for a result's DOI when adding | The source is built from the search record instead; nothing fails. |
| 16 | A missing year, venue or authors | Shown as missing ("n.d."), never invented. |

OpenAlex now reports a cost per request (`meta.cost_usd`) and gives keyless use a daily budget. A
writer searching by hand stays well inside it; if it runs out, OpenAlex fails as in 2 and Semantic
Scholar carries on. An API key for either provider is a later step, if usage needs it.
