"""
Idea boards: sticky notes on a cork wall.

The point of the feature is that nothing is lost while thinking, so most of
these are about a half-finished note surviving whatever happens next.
"""
import unittest
from unittest import mock

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import boards  # noqa: E402


class BoardTest(unittest.TestCase):
    def board(self, title="Ideas"):
        b = boards.create_board(title)
        self.addCleanup(lambda: boards.delete_board(b["id"]) if self.alive(b["id"]) else None)
        return b

    @staticmethod
    def alive(board_id):
        try:
            boards.get_board(board_id)
            return True
        except HTTPException:
            return False

    def test_a_new_board_is_empty_and_snaps_by_default(self):
        b = self.board("Dissertation")
        self.assertEqual(b["title"], "Dissertation")
        self.assertEqual(b["notes"], [])
        self.assertTrue(b["snap"])

    def test_a_board_without_a_title_still_has_one(self):
        self.assertEqual(self.board("   ")["title"], "Untitled board")

    def test_renaming_and_turning_snapping_off(self):
        b = self.board()
        self.assertEqual(boards.update_board(b["id"], title="Renamed")["title"], "Renamed")
        self.assertFalse(boards.update_board(b["id"], snap=False)["snap"])
        self.assertEqual(boards.get_board(b["id"])["title"], "Renamed", "snapping is not a rename")

    def test_the_list_says_how_many_notes_and_what_they_say(self):
        b = self.board("Launch")
        boards.add_note(b["id"], {"text": "Ask the tutor about scope"})
        boards.add_note(b["id"], {"text": "Book the lab"})
        row = [x for x in boards.list_boards() if x["id"] == b["id"]][0]
        self.assertEqual(row["notes"], 2)
        self.assertIn("Book the lab", row["preview"])

    def test_search_takes_wildcards_as_letters(self):
        # % and _ are LIKE wildcards: typed into the search box they are just characters.
        literal = self.board("Literal")
        boards.add_note(literal["id"], {"text": "100% sure about snake_case"})
        lookalike = self.board("Lookalike")                       # what a wildcard would also match
        boards.add_note(lookalike["id"], {"text": "100 out of 100 for snakeXcase"})
        for needle in ("100%", "snake_case"):
            found = [x["id"] for x in boards.list_boards(q=needle)]
            self.assertIn(literal["id"], found, needle)
            self.assertNotIn(lookalike["id"], found, f"{needle} was taken as a wildcard")

    def test_search_matches_capitals_in_any_language(self):
        b = self.board("Ideas")
        boards.add_note(b["id"], {"text": "Étude des délais — ЗАМЕТКА"})
        for needle in ("étude", "ÉTUDE", "заметка"):
            self.assertIn(b["id"], [x["id"] for x in boards.list_boards(q=needle)], needle)

    def test_search_finds_a_board_by_its_notes(self):
        b = self.board("Ideas")
        boards.add_note(b["id"], {"text": "Photosynthesis needs light"})
        self.assertIn(b["id"], [x["id"] for x in boards.list_boards(q="photosynth")])
        self.assertNotIn(b["id"], [x["id"] for x in boards.list_boards(q="mitochondria")])

    def test_deleting_a_board_takes_its_notes_with_it(self):
        b = self.board()
        boards.add_note(b["id"], {"text": "gone too"})
        boards.delete_board(b["id"])
        with self.assertRaises(HTTPException):
            boards.get_board(b["id"])

    def test_a_board_that_is_not_there(self):
        for call in (lambda: boards.get_board(999999),
                     lambda: boards.update_board(999999, title="x"),
                     lambda: boards.delete_board(999999),
                     lambda: boards.add_note(999999, {"text": "x"})):
            with self.assertRaises(HTTPException) as caught:
                call()
            self.assertEqual(caught.exception.status_code, 404)


class NoteTest(BoardTest):
    def setUp(self):
        self.b = self.board("Notes")

    def add(self, **note):
        return boards.add_note(self.b["id"], note)

    def test_a_new_note_lands_where_it_was_dropped(self):
        n = self.add(text="Try the cheaper model first", x=320, y=180, colour="green", pin="red")
        self.assertEqual((n["x"], n["y"], n["colour"], n["pin"]), (320, 180, "green", "red"))
        self.assertEqual((n["w"], n["h"]), boards.NOTE_SIZE, "a default size, so it can be written on")

    def test_an_unknown_colour_or_pin_falls_back(self):
        n = self.add(text="x", colour="chartreuse", pin="tartan")
        self.assertEqual((n["colour"], n["pin"]), (boards.COLOURS[0], boards.PINS[0]))

    def test_a_note_cannot_be_dragged_off_the_wall_or_shrunk_away(self):
        n = self.add(text="x", x=-500, y=99999, w=5, h=5000)
        self.assertEqual((n["x"], n["y"]), (0, boards.WALL))
        self.assertEqual((n["w"], n["h"]), (boards.NOTE_MIN, boards.NOTE_MAX))

    def test_nonsense_coordinates_keep_the_note_where_it_was(self):
        n = self.add(text="x", x=100, y=100)
        moved = boards.update_note(self.b["id"], n["id"], {"x": float("nan"), "y": "over there"})
        self.assertEqual((moved["x"], moved["y"]), (100, 100))

    def test_typing_does_not_move_a_note_and_moving_does_not_retype_it(self):
        n = self.add(text="first thought", x=40, y=60)
        typed = boards.update_note(self.b["id"], n["id"], {"text": "first thought, refined"})
        self.assertEqual((typed["x"], typed["y"]), (40, 60))
        dragged = boards.update_note(self.b["id"], n["id"], {"x": 500, "y": 300})
        self.assertEqual(dragged["text"], "first thought, refined")

    def test_a_note_keeps_the_whitespace_it_was_written_with(self):
        # Autosave runs mid-sentence: trimming pulls the words back under the cursor,
        # and a list written with line breaks must stay a list.
        typed = "Milk\nBread\n\n  - and the thing I keep forgetting  "
        n = self.add(text=typed)
        self.assertEqual(n["text"], typed)
        self.assertEqual(boards.update_note(self.b["id"], n["id"], {"text": "half a thought "})["text"],
                         "half a thought ", "the space after a word being typed is the user's")
        self.assertEqual(boards.get_board(self.b["id"])["notes"][0]["text"], "half a thought ")

    def test_a_board_name_is_still_tidied(self):
        self.assertEqual(boards.create_board("  Spaced out  ")["title"], "Spaced out")

    def test_a_note_can_be_emptied_without_disappearing(self):
        n = self.add(text="never mind")
        self.assertEqual(boards.update_note(self.b["id"], n["id"], {"text": ""})["text"], "")

    def test_picking_a_note_up_puts_it_in_front(self):
        first, second = self.add(text="one"), self.add(text="two")
        self.assertLess(first["z"], second["z"])
        raised = boards.update_note(self.b["id"], first["id"], {"front": True})
        self.assertGreater(raised["z"], second["z"])
        again = boards.update_note(self.b["id"], raised["id"], {"front": True})
        self.assertEqual(again["z"], raised["z"], "already on top: nothing to do")

    def test_several_notes_move_in_one_go(self):
        a, b = self.add(text="a", x=0, y=0), self.add(text="b", x=0, y=0)
        moved = boards.move_notes(self.b["id"], [{"id": a["id"], "x": 100, "y": 20},
                                                 {"id": b["id"], "x": 200, "y": 40},
                                                 {"id": 999999, "x": 1, "y": 1}])
        self.assertEqual(sorted((m["x"], m["y"]) for m in moved), [(100, 20), (200, 40)])

    def test_notes_from_another_board_are_left_alone(self):
        other = self.board("Other")
        mine = self.add(text="mine", x=10, y=10)
        with self.assertRaises(HTTPException):
            boards.update_note(other["id"], mine["id"], {"x": 900})
        with self.assertRaises(HTTPException):
            boards.delete_note(other["id"], mine["id"])
        self.assertEqual(boards.get_board(self.b["id"])["notes"][0]["x"], 10)

    def test_a_note_can_be_turned_on_its_pin(self):
        n = self.add(text="at an angle", rot=-7.5)
        self.assertEqual(n["rot"], -7.5)
        self.assertEqual(boards.update_note(self.b["id"], n["id"], {"rot": 400})["rot"], boards.ROT_MAX)
        self.assertEqual(boards.update_note(self.b["id"], n["id"], {"rot": -400})["rot"], -boards.ROT_MAX)
        straight = boards.update_note(self.b["id"], n["id"], {"rot": 0})
        self.assertEqual(straight["rot"], 0)
        self.assertEqual(boards.update_note(self.b["id"], n["id"], {"text": "still straight"})["rot"], 0,
                         "typing does not turn a note")

    def test_taking_a_note_down(self):
        n = self.add(text="done with this")
        boards.delete_note(self.b["id"], n["id"])
        self.assertEqual(boards.get_board(self.b["id"])["notes"], [])

    def test_a_board_holds_only_so_many(self):
        with mock.patch.dict(boards.LIMITS, {"notes": 2}):
            self.add(text="one")
            self.add(text="two")
            with self.assertRaises(HTTPException) as caught:
                self.add(text="three")
            self.assertEqual(caught.exception.status_code, 400)
            self.assertIn("full", str(caught.exception.detail).lower())

    def test_long_notes_are_capped(self):
        self.assertEqual(len(self.add(text="x" * 10000)["text"]), boards.LIMITS["text"])

    def test_the_board_knows_when_it_was_last_touched(self):
        before = boards.get_board(self.b["id"])["updated_at"]
        with mock.patch.object(boards, "_now", return_value="2099-01-01T00:00:00"):
            self.add(text="later")
        self.assertNotEqual(boards.get_board(self.b["id"])["updated_at"], before)


if __name__ == "__main__":
    unittest.main()
