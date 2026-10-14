# Wordcraft content

Everything a learner sees in Wordcraft, as data. `backend/wordcraft.py` reads it;
`backend/tests/test_wordcraft_content.py` checks it. All lesson text, passages,
cards and exercises here are original, written for Wordcraft. Outside material
is linked, never copied.

## Files

- `realms.json` — the seven realms: name, CEFR level, goal, "I can" statements
  (our own wording, not CEFR descriptor text), grammar landmarks, the exit.
- `realm_0.json` … `realm_6.json` — one realm each: its cards, lessons and
  placement questions.

## realms.json

```json
{"realms": [{
  "id": 0, "name": "The Harbour", "cefr": "Pre-A1",
  "blurb": "One or two sentences of story: where you are on the map.",
  "goal": "What the realm is for, one sentence.",
  "can_do": ["I can …", "…"],            // 4–6, our own wording
  "landmarks": ["be", "this / that"],     // grammar met in this realm
  "exit": {"title": "…", "description": "…", "character": "wc_guide", "writing": false}
}]}
```

## realm_N.json

```json
{
  "realm": 1,
  "cards": [ CARD, … ],          // 30–48 per realm
  "lessons": [ LESSON, … ],      // exactly 6 per realm
  "placement": [ ITEM, … ]       // exactly 3 per realm
}
```

### CARD

```json
{"id": "r1-w-decide", "kind": "word", "text": "decide",
 "meaning": "to choose after thinking",
 "example": "We decided to take the early train.",
 "goes_with": ["decide to", "decide on", "hard to decide"],
 "note": "Say 'decide to do', not 'decide doing'.",
 "job": ""}
```

- `id`: `r<realm>-<w|p|s>-<slug>`, unique across all realms.
- `kind`: `word` | `phrase` | `pattern`. A pattern's `text` shows the frame
  with blanks, e.g. `Although ___, ___.`
- `job` (phrases): what it is for — `greeting`, `asking`, `clarifying`,
  `agreeing`, `disagreeing`, `softening`, `linking`, `thanking`, `apologising`,
  `opinion`, `structuring`, `persuading`, `other`.
- `meaning` in plain English, simpler than the word itself; `example` is a
  natural sentence at the realm's level.

### LESSON

```json
{
  "id": "r1-l1", "title": "…", "minutes": 25,
  "pillar": "words",                      // words | phrases | sentences | understanding | speaking | communicating
  "why": "One sentence: why this matters to someone who wants to communicate.",
  "rule": "Optional short explicit rule (2–4 sentences) for sentence lessons.",
  "cards": ["r1-w-…", "r1-p-…"],        // 4–8 of this realm's cards
  "passage": {
    "kind": "read",
    "title": "…",
    "text": "An original passage at the realm's level, 60–260 words, using the lesson's cards.",
    "links": [{"title": "…", "by": "BBC Learning English", "url": "https://…"}]   // 0–2, verified
  },
  "drills": [ DRILL, … ],                  // 5–8
  "write": {"prompt": "…", "min_words": 8},
  "speak": {"prompt": "…", "character": "wc_neighbour"},   // character optional ("" = speak alone)
  "check": "A question the learner answers out loud to test the lesson's point."
}
```

### DRILL (checked on the learner's computer)

Every drill has `hint` (a nudge, not the answer) and `why` (the rule or reason,
shown after answering).

```json
{"type": "choose", "prompt": "Which is polite?", "options": ["…", "…", "…"], "answer": 1, "hint": "…", "why": "…"}
{"type": "gap", "sentence": "She ___ a nurse.", "options": ["is", "are", "am"], "answer": 0, "hint": "…", "why": "…"}
{"type": "order", "answer": "Where do you live?", "hint": "…", "why": "…"}
{"type": "fix", "sentence": "He go to work by bus.", "answer": "He goes to work by bus.", "accept": [], "hint": "…", "why": "…"}
{"type": "join", "parts": ["I was tired.", "I finished the report."], "answers": ["I was tired, but I finished the report.", "Although I was tired, I finished the report."], "hint": "…", "why": "…"}
```

- `gap`: exactly one `___`.
- `order`: the app shuffles the words of `answer`; keep it 3–14 words.
- `fix`: one mistake that changes or blurs meaning. `accept` lists other
  correct versions.
- `join`: 1–4 `answers`, each a correct single sentence.
- Never treat a repeated sound, a pause or "um" as an error.

### ITEM (placement)

```json
{"id": "p1-1", "realm": 1, "type": "gap", "sentence": "There ___ two shops.", "options": ["is", "are", "be"], "answer": 1}
{"id": "p1-2", "realm": 1, "type": "choose", "prompt": "…", "options": ["…"], "answer": 0}
```

## Characters

`wc_guide`, `wc_shopkeeper`, `wc_neighbour`, `wc_colleague`, `wc_debater`,
`wc_interviewer`, `wc_audience` (practice partners in `backend/scenarios.py`).
The Editor reads writing and is not a practice partner.

## Links

Only link pages you opened and saw load. Allowed sites:
bbc.co.uk/learningenglish, learnenglish.britishcouncil.org,
learningenglish.voanews.com, wgtn.ac.nz (Paul Nation's resources),
cambridgeenglish.org, writeandimprove.com, oxfordlearnersdictionaries.com.
