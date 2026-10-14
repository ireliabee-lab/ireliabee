"""Debrief PDFs keep every session language readable (no '?' for Arabic or Hindi)."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import debrief, languages  # noqa: E402

SAMPLES = {
    "en": ("Interview at Acme", "You explained the migration clearly and kept to time."),
    "fr": ("Entretien chez Société Générale", "Vous avez expliqué la migration clairement — très bien « structuré »."),
    "ar": ("مقابلة عمل", "شرحت عملية الترحيل بوضوح والتزمت بالوقت."),
    "hi": ("साक्षात्कार", "आपने माइग्रेशन को स्पष्ट रूप से समझाया और समय का ध्यान रखा।"),
}


def _report(title: str, text: str) -> dict:
    return {
        "session_title": title, "generated_at": "2026-09-19T10:00:00", "overall_score": 7,
        "summary": text, "strengths": [text], "improvements": [text],
        "questions": [{"question": text, "score": 6, "answer_summary": text, "verdict": text,
                       "improvements": [text], "better_answer": text}],
        "questions_to_ask": [text], "next_steps": [text],
    }


class DebriefPdfTest(unittest.TestCase):
    def setUp(self):
        self._home = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(Path, "home", return_value=Path(self._home.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._home.cleanup)

    def _export(self, language: str) -> Path:
        title, text = SAMPLES[language]
        sid = sess.create_session(title, "tech-interview")
        languages.set_for_session(sid, language)
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET debrief_json = ? WHERE id = ?", (json.dumps(_report(title, text)), sid))
        return debrief.export_pdf(sid)

    def _fonts(self, path: Path) -> set[str]:
        from pypdf import PdfReader
        names = set()
        for page in PdfReader(str(path)).pages:
            for font in page["/Resources"]["/Font"].values():
                names.add(str(font.get_object()["/BaseFont"]))
        return names

    def test_every_language_exports(self):
        for language in SAMPLES:
            with self.subTest(language=language):
                path = self._export(language)
                self.assertTrue(path.is_file())
                self.assertGreater(path.stat().st_size, 1000)
                self.assertTrue(path.name.endswith(".pdf"))

    def test_latin_text_survives(self):
        from pypdf import PdfReader
        text = "".join(p.extract_text() for p in PdfReader(str(self._export("fr"))).pages)
        self.assertIn("Société", text)
        self.assertIn("expliqué", text)

    def test_scripts_use_their_own_font(self):
        self.assertTrue(any("NotoSansArabic" in f for f in self._fonts(self._export("ar"))))
        self.assertTrue(any("NotoSansDevanagari" in f for f in self._fonts(self._export("hi"))))

    def test_non_latin_title_still_names_the_file(self):
        self.assertRegex(self._export("ar").name, r"^Interview-debrief-session-\d+-\d+\.pdf$")


if __name__ == "__main__":
    unittest.main()
