"""
English speaking-test practice (roadmap 2.3): IELTS Speaking and TOEFL-style
speaking tasks, run in the exam's own structure and scored band-style.

Honesty rules:
  * Pronunciation (IELTS) and delivery (TOEFL) are about how you sound. From
    typed answers they can't be judged at all, and from a speech transcript
    only pace and flow show — so pronunciation is never scored, TOEFL
    delivery only in voice mode, and the overall is taken over what was
    actually assessed. The UI says so.
  * TOEFL's official speaking format has changed over time; this is
    "TOEFL-style" practice with the classic independent and integrated
    tasks, not a claim to mirror the current test.
"""
from __future__ import annotations

import math
from typing import Optional

EXAMS: dict[str, dict] = {
    "ielts": {
        "name": "IELTS Speaking",
        "scale": "band",
        "max": 9,
        # Level anchors (paraphrased from the public band descriptors) so scores are calibrated across the scale.
        "anchors": [
            "9 — expert: fluent, precise and natural throughout, errors are rare slips",
            "8 — very good: fluent with only occasional hesitation, wide vocabulary, mostly error-free complex sentences",
            "7 — good: speaks at length easily, some flexible and less common vocabulary, a range of structures with some errors",
            "6 — competent: can keep going but with some hesitation or repetition, enough vocabulary to discuss topics, "
            "a mix of simple and complex sentences, errors that rarely block meaning",
            "5 — modest: keeps going only with repetition, slow speech or self-correction, limited vocabulary, "
            "basic sentences fairly accurate, complex ones often wrong",
            "4 — limited: short answers with frequent pauses, basic vocabulary and simple sentences, "
            "frequent errors that sometimes cause misunderstanding — but ideas are communicated",
            "3 — extremely limited: long pauses, simple memorised phrases, little communication beyond them",
            "2 — intermittent: little more than isolated words",
        ],
        "criteria": [
            ("fluency", "Fluency & coherence", "speaks at length without noticeable effort, links ideas logically, little hesitation or self-correction"),
            ("vocabulary", "Lexical resource", "wide, precise vocabulary including less common words and idiomatic language, paraphrases well"),
            ("grammar", "Grammatical range & accuracy", "a range of complex structures used flexibly, mostly error-free sentences"),
            ("pronunciation", "Pronunciation", "clear, easy to understand, natural stress and intonation"),
        ],
        "sound_only": {"pronunciation"},      # never judged from text
        "structure": [
            {"part": "Part 1", "count": 4, "prep": 0, "speak": 30,
             "brief": "introduction and interview on familiar topics (home, work or studies, hobbies, daily life), short natural questions"},
            {"part": "Part 2", "count": 1, "prep": 60, "speak": 120,
             "brief": "a cue card: 'Describe …' followed by 'You should say:' and three or four bullet points, ending 'and explain …'"},
            {"part": "Part 3", "count": 3, "prep": 0, "speak": 60,
             "brief": "a two-way discussion of more abstract, general questions linked to the Part 2 topic (compare, evaluate, speculate)"},
        ],
    },
    "toefl": {
        "name": "TOEFL-style speaking",
        "scale": "task",
        "max": 4,
        "anchors": [
            "4 — fulfils the task: sustained, well-developed, clear, with minor lapses only",
            "3 — addresses the task well but development, fluency or accuracy has noticeable lapses",
            "2 — addresses the task but with limited development and frequent problems that obscure meaning at times",
            "1 — very limited content or mostly unclear, or barely related to the task",
            "0 — no attempt or off-topic",
        ],
        "criteria": [
            ("delivery", "Delivery", "clear, fluid speech at a natural pace, with few pauses or hesitations"),
            ("language_use", "Language use", "effective, accurate grammar and vocabulary, with some complex structures"),
            ("topic_development", "Topic development", "a clear main idea, well-supported and connected reasons and examples"),
        ],
        "sound_only": set(),
        "flow_from_speech": {"delivery"},     # pace and flow only, and only when spoken
        "structure": [
            {"part": "Independent", "count": 2, "prep": 15, "speak": 45,
             "brief": "state and support an opinion or preference on a familiar topic ('Some people think … Which do you prefer and why?')"},
            {"part": "Campus situation", "count": 1, "prep": 30, "speak": 60,
             "brief": "a short campus announcement or proposal (give its text in the question) and two students' opposing views; ask the candidate to explain one student's opinion and reasons"},
            {"part": "Academic", "count": 1, "prep": 30, "speak": 60,
             "brief": "a short academic passage defining a concept (give its text in the question) and ask the candidate to explain the concept with an example of their own"},
        ],
    },
}


def exam_for(scenario_id: Optional[str]) -> Optional[dict]:
    return EXAMS.get(scenario_id or "")


def assessed(exam: dict, spoken: bool) -> list[str]:
    """Criteria that can honestly be judged from what we have."""
    out = []
    for key, _, _ in exam["criteria"]:
        if key in exam.get("sound_only", set()):
            continue
        if key in exam.get("flow_from_speech", set()) and not spoken:
            continue
        out.append(key)
    return out


def ielts_round(mean: float) -> float:
    """IELTS overall: average rounded to the nearest half band; .25 and .75 round up."""
    return math.floor(mean * 2 + 0.5) / 2


def clean_bands(exam: dict, raw: dict, spoken: bool) -> dict:
    """Clamp the model's scores, drop what can't be judged, and compute the overall."""
    keep = assessed(exam, spoken)
    top = exam["max"]
    bands: dict[str, Optional[float]] = {}
    for key, _, _ in exam["criteria"]:
        v = (raw or {}).get(key)
        if key not in keep or v is None:
            bands[key] = None
            continue
        try:
            bands[key] = float(max(0, min(top, round(float(v)))))
        except (TypeError, ValueError):
            bands[key] = None
    scored = [v for v in bands.values() if v is not None]
    mean = sum(scored) / len(scored) if scored else 0.0
    if exam["scale"] == "band":
        overall = ielts_round(mean) if scored else None
        out_of_ten = round(overall / 9 * 10) if overall is not None else 0
        scaled = None
    else:
        overall = round(mean, 1) if scored else None
        out_of_ten = round(mean / 4 * 10) if scored else 0
        scaled = round(mean / 4 * 30) if scored else None
    return {"bands": bands, "overall": overall, "scaled": scaled, "score": max(1, out_of_ten) if scored else 0,
            "not_assessed": [k for k, _, _ in exam["criteria"] if bands[k] is None]}


def rubric_block(exam: dict, spoken: bool) -> str:
    keep = assessed(exam, spoken)
    top = exam["max"]
    lines = [f"Score like a trained {exam['name']} examiner, on the official-style 0-{top} scale for each criterion "
             f"({'whole bands' if exam['scale'] == 'band' else 'whole points'}).",
             "Levels, overall:"]
    lines += [f"  {a}" for a in exam.get("anchors", [])]
    lines.append("What the top of the scale sounds like for each criterion:")
    for key, label, top_desc in exam["criteria"]:
        if key in keep:
            lines.append(f"  - {key} ({label}): {top_desc}")
    skipped = [label for key, label, _ in exam["criteria"] if key not in keep]
    if skipped:
        lines.append(f"Do NOT score {', '.join(skipped)} — it can't be judged from {'a transcript' if spoken else 'typed text'}; "
                     "return null for it.")
    lines.append("Be calibrated — neither generous nor harsh: score each criterion on its own evidence. A short or "
                 "underdeveloped answer lowers fluency/coherence and development, but vocabulary and grammar are judged "
                 "on the language actually used: full, understandable sentences are never band 2-3.")
    return "\n".join(lines)


def questions_prompt(exam: dict, topic: str, context: str) -> str:
    parts = "\n".join(
        f"- {p['part']}: {p['count']} question(s) — {p['brief']}. prep_seconds={p['prep']}, speak_seconds={p['speak']}."
        for p in exam["structure"]
    )
    return f"""You are an experienced {exam['name']} examiner writing one realistic practice test.

CANDIDATE (for level only — the test is about everyday and general topics, not their CV)
{context[:1500]}

{f"Preferred topic area: {topic}. Use it for Part 2/3 or the main tasks if it suits the format." if topic else "Pick varied, everyday topics."}

Write the test in this exact structure and order:
{parts}

Phrase every question exactly as the examiner would say it. For a cue card, put the whole card in the
question text, with the bullet points on new lines starting "- ".

Return ONLY JSON, no prose:
{{"questions": [{{"part": "Part 1", "question": "...", "prep_seconds": 0, "speak_seconds": 30, "looking_for": "one sentence on what a high score needs here"}}]}}"""


def examiner_voice_prompt(exam: dict) -> str:
    """How to run the test over a voice call."""
    parts = "\n".join(f"- {p['part']}: {p['count']} question(s) — {p['brief']}" for p in exam["structure"])
    return f"""Run it exactly like a real {exam['name']} test, in this order:
{parts}
- Say which part you're starting. For a part with preparation time, read the task, say how long they have
  to prepare and to speak, and wait for them to say they're ready.
- Stay neutral like a real examiner: no feedback, no teaching, no helping with words."""
