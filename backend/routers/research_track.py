"""
Research Track — the ladder from newcomer to research scientist.

    GET    /research/                    the track (null before it starts) and the content's size
    POST   /research/start               start (or restart) the track: field, goal, hours, project brief
    PATCH  /research/track               change field, goal, hours or brief
    GET    /research/today               today's list
    GET    /research/session             today's guided session: its steps, which are done, the streak
    POST   /research/session/steps/{id}  finish a step (or save an exercise answer; done=false on a check = not yet)
    POST   /research/session/more        keep going: add the next lesson to today
    GET    /research/curriculum          every level, its lessons and which are done
    POST   /research/lessons/{id}        mark a lesson done (with the self-check answer) or not
    GET    /research/terms               the term bank (q=, tier=)
    POST   /research/terms               add your own term
    POST   /research/terms/harvest       pull terms your notes define into the bank
    GET    /research/review              cards due now and today's new ones
    POST   /research/review/{card}       grade a card: 0 again, 1 hard, 2 good, 3 easy
    GET    /research/papers              paper cards
    GET    /research/papers/sources      library files and reading notes without a card yet
    POST   /research/papers              a new paper card
    PATCH  /research/papers/{id}         change a card (only the fields sent)
    DELETE /research/papers/{id}         remove a card
    GET    /research/projects            proposals and replications (kind=), with the questions and milestones
    POST   /research/projects            a new proposal or replication
    PATCH  /research/projects/{id}       change a project (answers and steps merge key by key)
    DELETE /research/projects/{id}       remove a project
    POST   /research/sprints             record a writing sprint: minutes, words added, which project
    GET    /research/portfolio           everything made so far, as Markdown to share with a mentor
    GET    /research/packs               the field packs and which are on
    PUT    /research/packs               choose the field packs (their terms join the bank)
    GET    /research/meetings            terms used and overclaims in real sessions, read locally
    PUT    /research/mentor              the mentor's name and email
    GET    /research/signoffs            a mentor's sign-offs
    POST   /research/signoffs            record a sign-off: skills the mentor has seen
    GET    /research/panel               Supervisor and Journal Club rounds with their scores
    GET    /research/readiness           the six pillars, weakest skills and the exit test
    POST   /research/advance             move up a level once the exit test is passed
    GET    /research/milestones          milestones waiting to be celebrated, and all reached so far
    POST   /research/milestones/seen     the app has celebrated these
    GET    /research/activity/day/{d}     one day in full: steps, lessons, rounds
    GET    /research/activity            the day-by-day record: calendar, weekly lessons, streaks, levels

No route here calls the AI: flashcards are self-graded and the panel runs
through Practice.
"""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import research_track as research

router = APIRouter()


class StartBody(BaseModel):
    field: str
    goal: str = "curious"
    weekly_hours: int = 10
    brief: str = ""


class TrackBody(BaseModel):
    field: Optional[str] = None
    goal: Optional[str] = None
    weekly_hours: Optional[int] = None
    brief: Optional[str] = None


class LessonBody(BaseModel):
    done: bool = True
    answer: str = ""


class TermBody(BaseModel):
    term: str
    definition: str
    example: str = ""


class GradeBody(BaseModel):
    grade: int


class ProjectBody(BaseModel):
    kind: str
    title: str
    data: Optional[dict] = None


class ProjectPatch(BaseModel):
    title: Optional[str] = None
    data: Optional[dict] = None


class SprintBody(BaseModel):
    minutes: int
    words: int = 0
    project_id: Optional[int] = None


class PacksBody(BaseModel):
    packs: list[str]


class MentorBody(BaseModel):
    name: str
    email: str = ""


class SignOffBody(BaseModel):
    mentor: str
    level: int
    skills: list[str]
    note: str = ""


class PaperBody(BaseModel):
    title: str
    authors: str = ""
    document_id: Optional[int] = None
    notebook_id: Optional[int] = None


class PaperPatch(BaseModel):
    title: Optional[str] = None
    authors: Optional[str] = None
    question: Optional[str] = None
    method: Optional[str] = None
    result: Optional[str] = None
    limitation: Optional[str] = None
    critique: Optional[str] = None
    # `pass` is a Python keyword; the JSON field is still "pass".
    passes: Optional[int] = Field(None, alias="pass")


@router.get("/")
def get_track():
    c = research.content()
    return {"track": research.get_track(),
            "content": {"terms": len(c["terms"]), "levels": len(c["levels"]),
                        "skills": sum(len(p.get("skills", [])) for p in c["pillars"])}}


@router.post("/start")
def start(body: StartBody):
    return research.start_track(body.field, body.goal, body.weekly_hours, body.brief)


@router.patch("/track")
def patch_track(body: TrackBody):
    return research.update_track({k: v for k, v in body.model_dump().items() if v is not None})


@router.get("/today")
def today():
    return research.today()


class StepBody(BaseModel):
    answer: Optional[str] = None
    done: bool = True


@router.get("/session")
def session():
    return research.session()


@router.post("/session/steps/{step_id}")
def session_step(step_id: str, body: StepBody):
    return research.session_step(step_id, body.answer, body.done)


@router.post("/session/more")
def session_more():
    return research.session_more()


@router.get("/curriculum")
def curriculum():
    return research.curriculum()


@router.post("/lessons/{lesson_id}")
def lesson(lesson_id: str, body: LessonBody):
    return research.mark_lesson(lesson_id, body.answer, body.done)


@router.get("/terms")
def terms(q: str = "", tier: str = ""):
    return {"terms": research.list_terms(q, tier), "stats": research.term_stats()}


@router.post("/terms")
def add_term(body: TermBody):
    return research.add_term(body.term, body.definition, body.example)


@router.post("/terms/harvest")
def harvest():
    return {"added": research.harvest_terms()}


@router.get("/review")
def review_queue():
    return research.review_queue()


@router.post("/review/{card_id}")
def review(card_id: int, body: GradeBody):
    return research.review(card_id, body.grade)


@router.get("/papers")
def papers():
    return research.list_papers()


@router.get("/papers/sources")
def paper_sources():
    return research.paper_sources()


@router.post("/papers")
def add_paper(body: PaperBody):
    return research.add_paper(body.title, body.document_id, body.notebook_id, body.authors)


@router.patch("/papers/{paper_id}")
def patch_paper(paper_id: int, body: PaperPatch):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if "passes" in fields:
        fields["pass"] = fields.pop("passes")
    return research.update_paper(paper_id, fields)


@router.delete("/papers/{paper_id}")
def delete_paper(paper_id: int):
    research.delete_paper(paper_id)
    return {"ok": True}


@router.get("/projects")
def projects(kind: str = ""):
    return {"projects": research.list_projects(kind),
            "heilmeier": [{"id": qid, "question": q} for qid, q in research.HEILMEIER],
            "answer_min": research.ANSWER_MIN,
            "steps": [{"id": sid, "label": label} for sid, label in research.REPLICATION_STEPS],
            "kinds": {kind: [{"id": f[0], "label": f[1], **({"options": list(f[2])} if isinstance(f[2], tuple)
                                                         else {"hint": f[2], "rows": f[3], "min": f[4]})}
                             for f in fields] for kind, fields in research.FLAT_KINDS.items()},
            "sprints": research.sprint_stats()}


@router.post("/projects")
def add_project(body: ProjectBody):
    return research.create_project(body.kind, body.title, body.data)


@router.patch("/projects/{project_id}")
def patch_project(project_id: int, body: ProjectPatch):
    return research.update_project(project_id, body.title, body.data)


@router.delete("/projects/{project_id}")
def delete_project(project_id: int):
    research.delete_project(project_id)
    return {"ok": True}


@router.post("/sprints")
def add_sprint(body: SprintBody):
    return research.add_sprint(body.minutes, body.words, body.project_id)


@router.get("/portfolio")
def portfolio():
    return {"markdown": research.portfolio()}


@router.get("/packs")
def packs():
    return {"packs": research.pack_list()}


@router.put("/packs")
def set_packs(body: PacksBody):
    return research.set_packs(body.packs)


@router.get("/meetings")
def meetings():
    return research.meeting_report()


@router.put("/mentor")
def set_mentor(body: MentorBody):
    return research.set_mentor(body.name, body.email)


@router.get("/signoffs")
def signoffs():
    return research.sign_offs()


@router.post("/signoffs")
def sign_off(body: SignOffBody):
    return research.sign_off(body.mentor, body.level, body.skills, body.note)


@router.get("/panel")
def panel():
    return research.panel_sessions()


@router.get("/readiness")
def readiness():
    return research.readiness()


@router.post("/advance")
def advance():
    return research.advance()


class SeenBody(BaseModel):
    keys: list[str] = []


@router.get("/milestones")
def milestones():
    return research.milestones()


@router.post("/milestones/seen")
def milestones_seen(body: SeenBody):
    return research.milestones_seen(body.keys)


@router.get("/activity")
def activity():
    return research.activity()


@router.get("/activity/day/{day}")
def activity_day(day: str):
    return research.activity_day(day)
