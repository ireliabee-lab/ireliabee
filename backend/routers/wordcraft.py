"""
Wordcraft — English from first words to expert communicator.

    GET    /wordcraft/                     the track (null before it starts) and the realms' sizes
    GET    /wordcraft/placement            the placement questions (no answers)
    POST   /wordcraft/placement            score the answers: the realm to start in
    POST   /wordcraft/start                start (or restart) at a realm
    PATCH  /wordcraft/track                change the goal, or show pace and fillers
    GET    /wordcraft/session              today's guided session
    POST   /wordcraft/session/steps/{id}   finish a step (exercise results, writing, "not yet")
    POST   /wordcraft/session/more         keep going: the next lesson
    GET    /wordcraft/curriculum           every realm and its lessons
    GET    /wordcraft/lessons/{id}         one lesson in full, to practise any time
    POST   /wordcraft/lessons/{id}         mark a lesson done or not
    POST   /wordcraft/lessons/{id}/drills  record exercise results outside the session
    GET    /wordcraft/cards                the cards (q=, kind=, realm=)
    POST   /wordcraft/cards                add your own word or phrase
    GET    /wordcraft/review               cards due now and today's new ones
    POST   /wordcraft/review/{card}        grade a card: 0 again … 3 easy
    POST   /wordcraft/writing/check        the Editor's notes on a piece of writing (one AI call)
    GET    /wordcraft/writing              writing and the Editor's notes so far
    GET    /wordcraft/characters/{id}      the brief a character gets for a practice round
    GET    /wordcraft/mission              this week's mission and its progress
    POST   /wordcraft/mission/done         say you did this week's mission
    GET    /wordcraft/exit                 the current realm's exit and how far along it is
    POST   /wordcraft/advance              open the next realm once the exit is passed
    GET    /wordcraft/progress             trends, skills, "I can" ratings
    PUT    /wordcraft/cando/{realm}        rate the realm's "I can" statements (1-4 each)
    GET    /wordcraft/milestones           milestones waiting to be celebrated, and all reached so far
    POST   /wordcraft/milestones/seen      the app has celebrated these
    GET    /wordcraft/activity/day/{d}     one day in full: steps, lessons, rounds, writing
    GET    /wordcraft/activity             the day-by-day record: calendar, weekly lessons and accuracy, realms

Only /writing/check calls the AI; characters run through Practice.
"""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .. import wordcraft as wc

router = APIRouter()


class PlacementBody(BaseModel):
    answers: dict[str, int]


class StartBody(BaseModel):
    realm: int = 0
    goal: str = "everyday"


class TrackBody(BaseModel):
    goal: Optional[str] = None
    show_pace: Optional[bool] = None


class StepBody(BaseModel):
    answer: Optional[str] = None
    done: bool = True
    results: Optional[list[bool]] = None


class LessonBody(BaseModel):
    done: bool = True
    answer: str = ""


class DrillsBody(BaseModel):
    results: list[bool]


class CardBody(BaseModel):
    text: str
    meaning: str
    example: str = ""
    kind: str = "word"


class GradeBody(BaseModel):
    grade: int


class WritingBody(BaseModel):
    text: str
    lesson_id: str = ""
    prompt: str = ""
    model: Optional[str] = None


class CandoBody(BaseModel):
    ratings: list[int]


@router.get("/")
def get_track():
    realms = wc.content()["realms"]
    return {"track": wc.get_track(),
            "content": {"realms": len(realms), "lessons": sum(len(r["lessons"]) for r in realms),
                        "cards": sum(len(r["cards"]) for r in realms)}}


@router.get("/placement")
def placement():
    return {"items": wc.placement_items()}


@router.post("/placement")
def place(body: PlacementBody):
    return wc.place(body.answers)


@router.post("/start")
def start(body: StartBody):
    return wc.start(body.realm, body.goal)


@router.patch("/track")
def patch_track(body: TrackBody):
    return wc.update_track({k: v for k, v in body.model_dump().items() if v is not None})


@router.get("/session")
def session():
    return wc.session()


@router.post("/session/steps/{step_id}")
def session_step(step_id: str, body: StepBody):
    return wc.session_step(step_id, body.answer, body.done, body.results)


@router.post("/session/more")
def session_more():
    return wc.session_more()


@router.get("/curriculum")
def curriculum():
    return wc.curriculum()


@router.get("/lessons/{lesson_id}")
def lesson(lesson_id: str):
    return wc.lesson_detail(lesson_id)


@router.post("/lessons/{lesson_id}")
def mark_lesson(lesson_id: str, body: LessonBody):
    return wc.mark_lesson(lesson_id, body.answer, body.done)


@router.post("/lessons/{lesson_id}/drills")
def drills(lesson_id: str, body: DrillsBody):
    return {"score": wc.record_drills(lesson_id, body.results)}


@router.get("/cards")
def cards(q: str = "", kind: str = "", realm: Optional[int] = None):
    return {"cards": wc.list_cards(q, kind, realm), "stats": wc.card_stats()}


@router.post("/cards")
def add_card(body: CardBody):
    return wc.add_card(body.text, body.meaning, body.example, body.kind)


@router.get("/review")
def review_queue():
    return wc.review_queue()


@router.post("/review/{card_id}")
def review(card_id: int, body: GradeBody):
    return wc.review(card_id, body.grade)


@router.post("/writing/check")
async def check_writing(body: WritingBody):
    return await wc.check_writing(body.text, body.lesson_id, body.prompt, body.model)


@router.get("/writing")
def writing():
    return wc.list_writing()


@router.get("/characters/{character}")
def character(character: str, lesson_id: str = ""):
    return wc.character_brief(character, lesson_id)


@router.get("/mission")
def mission():
    return wc.mission()


@router.post("/mission/done")
def mission_done():
    return wc.finish_mission()


@router.get("/exit")
def exit_status():
    track = wc._need_track()
    return wc.exit_status(track["realm"])


@router.post("/advance")
def advance():
    return wc.advance()


@router.get("/progress")
def progress():
    return wc.progress()


@router.put("/cando/{realm}")
def cando(realm: int, body: CandoBody):
    return wc.rate_cando(realm, body.ratings)


class SeenBody(BaseModel):
    keys: list[str] = []


@router.get("/milestones")
def milestones():
    return wc.milestones()


@router.post("/milestones/seen")
def milestones_seen(body: SeenBody):
    return wc.milestones_seen(body.keys)


@router.get("/activity")
def activity():
    return wc.activity()


@router.get("/activity/day/{day}")
def activity_day(day: str):
    return wc.activity_day(day)
