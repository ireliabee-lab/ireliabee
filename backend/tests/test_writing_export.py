"""A piece of writing as a PDF (backend/writing_export.py). Written down first (CLAUDE.md, Testing,
rule 3), one test each:

1. Text in other scripts (accents, Greek, Arabic) fails to print, or prints as boxes.
2. Section headings appear in an essay, which runs as continuous prose; or disappear from a paper.
3. The reference list is lost, or printed under the wrong heading for the style.
4. A huge document stalls the app: refused.
"""
from backend.tests import _env  # noqa: F401

import io

import pytest
from fastapi import HTTPException
from pypdf import PdfReader

from backend import writing_export


def text_of(pdf: bytes) -> str:
    return "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)


DOC = {
    "title": "Speech timing and fluency", "headings": True, "hanging": True, "doubleSpaced": True,
    "sections": [{"title": "Introduction", "paragraphs": ["Timing matters (Kim, 2020).", "Café, Ελλάδα, Kraków."]},
                 {"title": "Methods", "paragraphs": ["Twelve adults took part."]}],
    "referencesTitle": "References",
    "references": ["Kim, J.-H. (2020). Timing in speech motor control. Journal of Fluency Disorders, 64, 1–12. "
                   "https://doi.org/10.1016/j.jfludis.2020.105763"],
}


def test_a_paper_prints_its_title_headings_text_and_references():
    pdf = writing_export.export_pdf(DOC)
    assert pdf[:5] == b"%PDF-"
    text = text_of(pdf)
    for part in ("Speech timing and fluency", "Introduction", "Methods", "Timing matters (Kim, 2020).",
                 "References", "Timing in speech motor control"):
        assert part in text, part
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 2   # the references start on their own page


def test_other_scripts_print():
    text = text_of(writing_export.export_pdf(DOC))
    assert "Café" in text and "Ελλάδα" in text and "Kraków" in text


def test_an_essay_runs_without_headings_and_mla_lists_works_cited():
    pdf = writing_export.export_pdf({**DOC, "headings": False, "referencesTitle": "Works Cited"})
    text = text_of(pdf)
    assert "Methods" not in text and "Twelve adults took part." in text
    assert "Works Cited" in text


def test_a_huge_document_is_refused():
    with pytest.raises(HTTPException):
        writing_export.export_pdf({**DOC, "sections": [{"title": "x", "paragraphs": ["p"] * (writing_export.MAX_PARAGRAPHS + 1)}]})
