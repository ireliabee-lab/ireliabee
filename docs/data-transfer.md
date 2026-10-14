# Data transfer — export & import

Sidebar → **Transfer**. Moves prep work between installs as one JSON file: your
profile, meeting plans, stories, practice history, CVs, documents and non-secret
preferences. Hand the file to someone else and they import it into their own
profile.

## What travels — and what doesn't

| Travels | Stays put |
|---|---|
| Profiles (name, background, strengths, context) | API keys (`~/.config/ireliabee/.env`) |
| Meeting plans (agenda, questions, traps, commitments, briefing) | Session transcripts and messages |
| Stories (the STAR bank), **except any marked private** | Meeting notes + confidence reports (derived from transcripts) |
| | **Stories you marked private** — they still coach you, but are never written to a transfer file |
| Practice history (explain-clearly drills) | Which profile / CV is *active* — that's local |
| CVs and documents (original bytes, base64 inside the JSON) | Plan research dumps (`raw_research_json` — bulky, rebuildable) |
| Preferences (provider + model choices) | |
| Research Track: your level and field packs, term cards with their review schedule, paper cards, lessons done, projects, writing sprints and skill evidence (mentor sign-offs included) | Links from paper cards and sprints to local files, notebooks and projects |
| Wordcraft: your realm and goal, cards with their review schedule, lessons done, exercise results, writing with the Editor's notes, daily sessions and streak, missions, "I can" ratings and placements | Nothing is left behind |

Notebooks don't travel either, so neither does Study mode: review questions and their
schedule, chapter questions and the review log stay with the notebooks they belong to. Talk
at work's scores (numbers only; what you said is never kept) stay on this computer too.

Transcripts are deliberately not transferable: they're a recording of a real
conversation and belong to the machine that made it.

## Bundle format

```jsonc
{
  "format": "ireliabee.transfer",   // rejected if this doesn't match
  "version": 1,                     // a newer version is refused with an "update the app" message
  "exported_at": "2026-09-18T10:00:00",
  "app_version": "0.4.0",
  "counts": { "plans": 3, "stories": 7 },
  "data": {
    "profiles": [{ "ref": 1, "name": "Ama", "...": "..." }],
    "plans":    [{ "profile_ref": 1, "title": "PhD call", "...": "..." }],
    "cvs":      [{ "name": "Main CV", "content_b64": "…" }]
  }
}
```

Database ids never travel. `ref` / `profile_ref` are bundle-local, and the
importer remaps them so nothing collides with rows already in the target
install.

## Private stories

A story can be flagged **private** in its editor. It still feeds the live coach, Practice and
debriefs exactly as before (so, like any story the coach uses, its text goes to the AI provider
with that request), but `_export_stories()` skips it, so it is never written to a transfer file. The Transfer screen's Stories count shows only what would actually travel;
`summary()` returns `stories_private` alongside it so the UI can say why the number is short.

Use it for anything you would not hand to another person with the file — a story about a
health condition, a dismissal, a grade and the reason behind it.

## Import rules

- **Duplicates** — by default an item whose name already exists is skipped
  (profiles by name, plans by title + counterparty, stories by title, files by
  name, practice attempts by topic + time). "Import as a second copy" turns
  that off.
- Database ids in a file are ignored, so a hand-edited or older file can't
  collide with rows already here.
- **Attach imported plans to** — pick one of your own profiles to pull someone
  else's plans into it, or keep the profile that came with the file.
- An imported profile is never made active, so importing can't hijack the
  coach's current context.
- Columns the local schema doesn't know (a bundle from a newer build) are
  dropped instead of failing the import.
- Preferences are filtered again on the way in: any key containing
  `key`/`token`/`secret`/`password` is discarded.
- Bundles are capped at 50 MB.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/transfer/summary` | Counts per section, for the checkboxes |
| `GET` | `/transfer/export?include=…&profile_id=…` | Downloads `ireliabee-export-<date>.json` |
| `POST` | `/transfer/inspect` (multipart `file`) | Preview a file's contents — writes nothing |
| `POST` | `/transfer/import` (multipart `file`, `include`, `duplicates`, `target_profile_id`) | Merge it in; returns a per-section report |

Code: `backend/transfer.py` (bundle build/parse/import), `backend/routers/transfer.py`
(HTTP), `frontend/src/components/TransferView.tsx` (UI). Tests:
`backend/tests/test_transfer.py`.
