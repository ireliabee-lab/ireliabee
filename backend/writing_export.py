"""
A piece of writing from Write as a PDF (docs/academic-writing.md, stage 6).

The app formats the citations and the reference list (frontend/src/lib/writingExport.ts) and sends
the finished document; this lays it out on A4 with the Noto fonts the debrief export uses, so
accented, Greek, Cyrillic, Arabic and Devanagari text all print.
"""
from __future__ import annotations

import types

from fastapi import HTTPException

from .debrief import _new_pdf, _pdf_text

MAX_PARAGRAPHS = 5000


def export_pdf(doc: dict) -> bytes:
    title = _pdf_text(str(doc.get("title") or "Untitled"))[:300]
    sections = doc.get("sections") or []
    references = [str(r) for r in (doc.get("references") or [])][:2000]
    if not isinstance(sections, list) or sum(len(s.get("paragraphs") or []) for s in sections if isinstance(s, dict)) > MAX_PARAGRAPHS:
        raise HTTPException(400, "This document is too long to export in one go.")
    headings = bool(doc.get("headings", True))
    hanging = bool(doc.get("hanging", True))
    leading = 1.9 if doc.get("doubleSpaced") else 1.5

    pdf = _new_pdf()
    pdf.set_auto_page_break(auto=True, margin=22)
    pdf.set_margins(25, 25, 25)

    def footer(self):
        self.set_y(-15)
        self.set_font("noto", "", 9)
        self.cell(0, 8, str(self.page_no()), align="C")
    pdf.footer = types.MethodType(footer, pdf)

    def font(style: str, size: float):
        # As in the debrief export: a size change forces fpdf2 off a fallback font.
        pdf.set_font("noto", style, size + 0.01)
        pdf.set_font("noto", style, size)

    size = 11.5
    line_h = size * 0.3528 * leading     # points to mm, times the line spacing
    width = pdf.w - pdf.l_margin - pdf.r_margin
    pdf.add_page()

    font("B", 16)
    pdf.multi_cell(width, 16 * 0.3528 * 1.4, title, align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    for s in sections:
        if not isinstance(s, dict):
            continue
        if headings and s.get("title"):
            pdf.ln(2)
            font("B", 12.5)
            pdf.multi_cell(width, 12.5 * 0.3528 * 1.5, _pdf_text(str(s["title"]))[:300], new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)
        font("", size)
        for para in s.get("paragraphs") or []:
            pdf.set_x(pdf.l_margin)
            pdf.multi_cell(width, line_h, _pdf_text(str(para)), align="J", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1.5)

    if references:
        pdf.add_page()
        font("B", 12.5)
        pdf.multi_cell(width, 12.5 * 0.3528 * 1.5, _pdf_text(str(doc.get("referencesTitle") or "References")), align="C", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)
        font("", size)
        indent = 10 if hanging else 0
        for ref in references:
            text = _pdf_text(ref)
            # A hanging indent: the first line at the margin, the rest indented, as reference lists are set.
            lines = pdf.multi_cell(width, line_h, text, dry_run=True, output="LINES")
            if indent and len(lines) > 1:
                pdf.multi_cell(width, line_h, lines[0], new_x="LMARGIN", new_y="NEXT")
                rest = " ".join(lines[1:])
                pdf.set_x(pdf.l_margin + indent)
                pdf.multi_cell(width - indent, line_h, rest, new_x="LMARGIN", new_y="NEXT")
            else:
                pdf.multi_cell(width, line_h, text, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1.5)
    return bytes(pdf.output())
