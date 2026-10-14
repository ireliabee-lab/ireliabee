"""The book's look is saved with each notebook: paper theme, page colour and text size (owner, 27 Sep 2026)."""
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import notebook as nb  # noqa: E402
from backend.routers import notebook as router  # noqa: E402


class LookIsSaved(unittest.TestCase):
    def test_paper_page_colour_and_size_survive_a_save_through_the_route(self):
        made = nb.create_notebook("lecture", title="Look")
        body = router.UpdateBody(version=made["version"], style={
            "family": "serif", "size": "xl", "style": "regular", "list": "bullet", "paper": "parchment", "pageColor": "sky"})
        router.update(made["id"], body)
        style = nb.get_notebook(made["id"])["style"]
        self.assertEqual((style["paper"], style["pageColor"], style["size"]), ("parchment", "sky", "xl"))

    def test_an_unknown_page_colour_is_left_out(self):
        self.assertNotIn("pageColor", nb.clean_style({"pageColor": "tartan"}, "lecture"))


if __name__ == "__main__":
    unittest.main()
