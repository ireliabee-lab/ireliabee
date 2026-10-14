"""
Post-session debrief: score the whole conversation, save the report with the
session, and export it as a PDF.

Works for live call sessions and mock interviews. Coach suggestions are left
out — the report judges only what was actually said.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from . import languages
from .core import sessions as sess

_TAG = re.compile(r"^\s*(\[[^\]]*\]\s*)+")


def _ensure_column():
    with sess._connect() as conn:
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN debrief_json TEXT")
        except Exception:
            pass


_ensure_column()


def transcript_lines(session_id: int) -> list[str]:
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT speaker, content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id",
            (session_id,),
        ).fetchall()
    lines = []
    for r in rows:
        text = _TAG.sub("", r["content"] or "").strip()
        if text:
            who = "Interviewer" if r["speaker"] == "interviewer" else "Candidate"
            lines.append(f"{who}: {text}")
    return lines


def load_debrief(session_id: int) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT debrief_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Session not found")
    return json.loads(row["debrief_json"]) if row["debrief_json"] else None


def _clamp(v) -> int:
    try:
        return max(1, min(10, int(round(float(v)))))
    except (TypeError, ValueError):
        return 0


async def generate_debrief(session_id: int, model: Optional[str], response_tone: Optional[str]) -> dict:
    # Imported here to avoid a router import cycle.
    from .routers.coach import RESPONSE_TONES, tone_block, _persona_block, _resolve_tone
    from .routers.mock import _ask_model, _candidate_context

    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(404, "Session not found")
    lines = transcript_lines(session_id)
    if not any(l.startswith("Candidate:") for l in lines):
        raise HTTPException(400, "No answers were recorded in this session")

    from .scenarios import scenario_from_tags
    from . import exams
    _, scenario = scenario_from_tags(row["tags"])
    exam = exams.exam_for(scenario.get("exam"))
    # Speaking tests (roadmap 2.3) also get whole-test band scores, from the transcript.
    exam_block = (
        "\n\nThis was a " + exam["name"] + " practice test. Also score the whole test:\n"
        + exams.rubric_block(exam, spoken=True)
        + "\nAdd to the JSON: \"bands\": {" + ", ".join(f'\"{k}\": <number or null>' for k, _, _ in exam["criteria"]) + "}"
    ) if exam else ""
    profile, context = _candidate_context(None)
    tone = _resolve_tone(response_tone)
    language = languages.output_for_session(session_id)
    name = profile.get("name") or "the candidate"
    system_prompt = f"""You are a fair, encouraging interview coach writing a debrief of a real or practice {scenario["event"]}.

CANDIDATE
{context}
{_persona_block(profile)}

Judge answers against {scenario["judge"]}, at this candidate's level.
Answers may be speech transcripts: ignore transcription glitches, but do note filler words,
rambling, and answers that never got to the point.

Return ONLY JSON, no prose:
{{"overall_score": <int 1-10>,
  "summary": "two or three honest sentences on how it went overall",
  "strengths": ["up to 4 specific things that landed well"],
  "improvements": ["up to 4 specific, actionable fixes"],
  "questions": [{{"question": "the interviewer's main question",
                  "answer_summary": "one sentence on what {name} said",
                  "score": <int 1-10>,
                  "verdict": "one sentence",
                  "improvements": ["up to 2 fixes"],
                  "better_answer": "a stronger first-person version, 100-180 words, only facts from the candidate context and their answer; [placeholders] for unknowns"}}],
  "questions_to_ask": ["up to 3 smart questions {name} should have asked the interviewer, tailored to this conversation"],
  "next_steps": ["up to 3 concrete things to do before the next interview or as follow-up"]}}
Include only real questions the candidate actually answered; skip greetings and small talk.{exam_block}

{tone_block(tone, language)}{languages.json_block(language)}"""
    from .core.providers import metering_context
    with metering_context("debrief", session_id):
        data = await _ask_model(model, system_prompt, "TRANSCRIPT\n" + "\n".join(lines))

    def strings(key, limit):
        return [str(s).strip() for s in data.get(key, []) if str(s).strip()][:limit]

    report = {
        "overall_score": _clamp(data.get("overall_score")),
        "summary": str(data.get("summary", "")).strip(),
        "strengths": strings("strengths", 4),
        "improvements": strings("improvements", 4),
        "questions": [
            {
                "question": str(q.get("question", "")).strip(),
                "answer_summary": str(q.get("answer_summary", "")).strip(),
                "score": _clamp(q.get("score")),
                "verdict": str(q.get("verdict", "")).strip(),
                "improvements": [str(s).strip() for s in q.get("improvements", []) if str(s).strip()][:2],
                "better_answer": str(q.get("better_answer", "")).strip(),
            }
            for q in data.get("questions", []) if str(q.get("question", "")).strip()
        ],
        "questions_to_ask": strings("questions_to_ask", 3),
        "next_steps": strings("next_steps", 3),
        **({"exam": {**exams.clean_bands(exam, data.get("bands") or {}, spoken=True), "name": exam["name"],
                     "scale": exam["scale"], "max": exam["max"],
                     "criteria": [{"key": k, "label": l} for k, l, _ in exam["criteria"]]}} if exam else {}),
        "response_tone": tone,
        "model": model or "",
        "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "session_title": row["title"],
    }
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET debrief_json = ? WHERE id = ?", (json.dumps(report), session_id))
    return report


# ── PDF export ────────────────────────────────────────────────────────────────

FONT_DIR = Path(__file__).resolve().parent / "fonts"

# Noto Sans (SIL Open Font License, fonts/OFL.txt) covers Latin, Greek and
# Cyrillic; the Arabic and Devanagari faces step in for those scripts.
_FONTS = {
    "noto": {"": "NotoSans-Regular.ttf", "B": "NotoSans-Bold.ttf", "I": "NotoSans-Italic.ttf"},
    # No italic cut of these scripts: italic lines use the upright face.
    "noto-arabic": {"": "NotoSansArabic-Regular.ttf", "B": "NotoSansArabic-Bold.ttf",
                    "I": "NotoSansArabic-Regular.ttf"},
    "noto-devanagari": {"": "NotoSansDevanagari-Regular.ttf", "B": "NotoSansDevanagari-Bold.ttf",
                        "I": "NotoSansDevanagari-Regular.ttf"},
}
_RTL = {"ar"}


def _pdf_text(text: str) -> str:
    return unicodedata.normalize("NFC", text or "")


def _new_pdf():
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    for family, styles in _FONTS.items():
        for style, file in styles.items():
            pdf.add_font(family, style, str(FONT_DIR / file))
    # Every fallback family has each style we use, so a fallback never
    # changes the line's style.
    pdf.set_fallback_fonts(["noto-arabic", "noto-devanagari"], exact_match=True)
    try:
        # Joins Arabic letters and Devanagari syllables, and lays out
        # right-to-left runs; needs uharfbuzz (bundled with the app).
        pdf.set_text_shaping(True)
    except Exception:
        pass
    return pdf


def export_pdf(session_id: int) -> Path:
    report = load_debrief(session_id)
    if not report:
        raise HTTPException(400, "Generate the debrief before exporting it")

    language = languages.output_for_session(session_id)
    align = "R" if language in _RTL else "L"
    pdf = _new_pdf()
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.set_margins(18, 18, 18)
    pdf.add_page()
    width = pdf.w - pdf.l_margin - pdf.r_margin

    def font(style, size):
        # fpdf2 2.8 leaves a fallback font (Arabic/Devanagari) active after a
        # line that ends in that script, then skips re-selecting an unchanged
        # font — the next text renders as garbage. A size change forces it out.
        pdf.set_font("noto", style, size + 0.01)
        pdf.set_font("noto", style, size)

    def heading(text, size=13, color=(79, 70, 229)):
        pdf.ln(3)
        font("B", size)
        pdf.set_text_color(*color)
        pdf.multi_cell(width, 7, _pdf_text(text), align=align, new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(30, 30, 40)

    def para(text, size=10.5, style=""):
        font(style, size)
        pdf.multi_cell(width, 5.8, _pdf_text(text), align=align, new_x="LMARGIN", new_y="NEXT")

    def bullets(items):
        # The bullet is its own cell so it sits at the line start on either
        # side, whatever the item's script and direction.
        for item in items:
            y = pdf.get_y()
            font("", 10.5)
            pdf.set_xy(pdf.l_margin + (width - 4 if align == "R" else 1), y)
            pdf.cell(4, 5.8, "•")
            pdf.set_xy(pdf.l_margin + (0 if align == "R" else 5), y)
            pdf.multi_cell(width - 5, 5.8, _pdf_text(item), align=align, new_x="LMARGIN", new_y="NEXT")

    font("B", 20)
    pdf.set_text_color(30, 30, 40)
    pdf.multi_cell(width, 9, "Interview debrief", new_x="LMARGIN", new_y="NEXT")
    font("", 10)
    pdf.set_text_color(110, 110, 125)
    generated = report.get("generated_at", "")[:16].replace("T", " ")
    pdf.multi_cell(width, 5, _pdf_text(f"{report.get('session_title', '')}  |  generated {generated} UTC"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(30, 30, 40)

    heading(f"Overall score: {report.get('overall_score', '-')}/10", size=15)
    para(report.get("summary", ""))

    if report.get("strengths"):
        heading("What landed", color=(22, 163, 74))
        bullets(report["strengths"])
    if report.get("improvements"):
        heading("Focus on next", color=(217, 119, 6))
        bullets(report["improvements"])

    for i, q in enumerate(report.get("questions", []), 1):
        heading(f"Q{i}  ({q.get('score', '-')}/10)  {q.get('question', '')}", size=11.5, color=(30, 30, 40))
        para(f"You said: {q.get('answer_summary', '')}", size=10, style="I")
        para(q.get("verdict", ""))
        if q.get("improvements"):
            bullets(q["improvements"])
        pdf.ln(1)
        para("Stronger answer:", size=10, style="B")
        para(q.get("better_answer", ""))

    if report.get("questions_to_ask"):
        heading("Questions you could have asked")
        bullets(report["questions_to_ask"])
    if report.get("next_steps"):
        heading("Next steps")
        bullets(report["next_steps"])

    folder = Path.home() / "Downloads"
    if not folder.is_dir():
        folder = Path.home()
    slug = re.sub(r"[^A-Za-z0-9]+", "-", report.get("session_title") or f"session-{session_id}").strip("-")[:60] or f"session-{session_id}"
    path = folder / f"Interview-debrief-{slug}-{session_id}.pdf"
    pdf.output(str(path))
    return path
