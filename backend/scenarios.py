"""
Practice scenarios beyond job interviews. Mock interviews, voice calls and
debriefs read these so the AI plays the right counterpart and judges by the
right standard.
"""
from __future__ import annotations

SCENARIOS: dict[str, dict] = {
    "job": {
        "label": "Job interview",
        "counterpart": "interviewer",
        "event": "interview",
        "subject_default": "the target role",
        "setting": "an interview for {subject}",
        "questions": None,   # uses the Focus setting instead
        "judge": "what an interviewer would expect from someone at this candidate's level — not a senior expert",
    },
    "thesis": {
        "label": "Thesis defence / viva",
        "counterpart": "examiner",
        "event": "thesis defence",
        "subject_default": "their thesis",
        "setting": "a thesis or project defence (viva) on {subject}",
        "questions": (
            "examiner questions that probe the research question and why it matters, the choice of "
            "methods and their limitations, how results were validated, related work, and what the "
            "candidate would do differently or next. Mix clarifying questions with genuine challenges "
            "such as 'why not use X instead?'"
        ),
        "judge": (
            "what an examining committee expects: clear justification of choices, honest limitations, "
            "command of the literature, and calm handling of challenges"
        ),
    },
    "scholarship": {
        "label": "Scholarship / fellowship panel",
        "counterpart": "panel member",
        "event": "scholarship interview",
        "subject_default": "the scholarship",
        "setting": "a scholarship or fellowship panel interview for {subject}",
        "questions": (
            "panel questions about motivation, why this programme and host country, leadership and "
            "community impact with real examples, study and career plans, handling setbacks, and how "
            "the candidate will use the opportunity to give back at home"
        ),
        "judge": (
            "what a selection panel looks for: a clear purpose, evidence of impact and leadership, fit "
            "with the scholarship's mission, and a believable plan to give back"
        ),
    },
    "salary": {
        "label": "Salary negotiation",
        "counterpart": "hiring manager",
        "event": "salary negotiation",
        "subject_default": "the offer",
        "setting": "a salary and offer negotiation for {subject}",
        "questions": (
            "moments in a real offer negotiation, played as the hiring manager: presenting the offer, "
            "asking for their expectations, pushing back on budget, questioning their market data, "
            "offering non-salary items instead, and pressing for a quick decision. Be realistic and "
            "firm but fair, and only concede when the candidate makes a good case"
        ),
        "judge": (
            "negotiation skill: anchoring with a researched number, justifying it with value and market "
            "data, staying warm and calm, not accepting too early, and exploring the whole package"
        ),
    },
    "meeting": {
        "label": "Work meeting",
        "counterpart": "manager",
        "event": "work meeting",
        "subject_default": "their project",
        "setting": "a work meeting about {subject}",
        "questions": (
            "what a manager or stakeholder asks in this meeting: a status update, explaining a decision "
            "and its trade-offs, pushback on a missed deadline or risk, a request for resources, and "
            "agreeing next steps"
        ),
        "judge": (
            "clear, structured updates, owning problems without excuses, crisp asks, and agreed next steps"
        ),
    },
    "pitch": {
        "label": "Sales / investor pitch",
        "counterpart": "prospect or investor",
        "event": "pitch",
        "subject_default": "their product or idea",
        "setting": "a pitch of {subject} to a prospect or investor",
        "questions": (
            "the tough questions a prospect or investor asks: what problem this solves and for whom, "
            "why now, what makes it different from alternatives, traction and numbers, the business "
            "model, the risks, and 'why should I choose you?' Mix interest with real objections."
        ),
        "judge": (
            "a crisp value proposition, evidence over hype, handling objections calmly, and a clear ask"
        ),
    },
    "presentation": {
        "label": "Presentation to leadership",
        "counterpart": "senior stakeholder",
        "event": "presentation",
        "subject_default": "their update or proposal",
        "setting": "a presentation of {subject} to senior stakeholders",
        "questions": (
            "the probing questions leaders ask during a presentation: the headline and why it matters, "
            "the data behind it, trade-offs considered, cost and timeline, risks, and what decision or "
            "support is being asked for. Interrupt with clarifying and challenging questions."
        ),
        "judge": (
            "leading with the point, backing claims with data, handling interruptions, and a clear ask"
        ),
    },
    "difficult": {
        "label": "Difficult conversation",
        "counterpart": "the other person",
        "event": "difficult conversation",
        "subject_default": "the issue",
        "setting": "a difficult conversation about {subject} (feedback, conflict or a hard decision)",
        "questions": (
            "the emotional turns of a hard conversation, played as the other person: reacting to the "
            "message, pushing back, getting defensive or upset, and asking what happens next. Stay "
            "realistic — sometimes receptive, sometimes resistant."
        ),
        "judge": (
            "clear and kind framing, owning their part, listening, staying calm under pushback, and "
            "agreeing a concrete next step"
        ),
    },
    "speaking": {
        "label": "Public speaking / speech",
        "counterpart": "audience",
        "event": "talk",
        "subject_default": "their talk",
        "setting": "a public talk or speech on {subject}",
        "questions": (
            "audience-style prompts and, after the talk, the Q and A: questions that test whether the "
            "message was clear, ask for examples, and challenge a point. Also cue the speaker through "
            "opening, key points and close."
        ),
        "judge": (
            "a strong hook, a clear through-line, vivid examples, good pace, and confident handling of Q and A"
        ),
    },
    # ── Roadmap 2.4: students ───────────────────────────────────────────────
    "admission": {
        "label": "University admission interview",
        "counterpart": "admissions tutor",
        "event": "admission interview",
        "subject_default": "the course",
        "setting": "a university admission interview for {subject}",
        "questions": (
            "admissions-tutor questions: why this subject and why this university, what the applicant has "
            "read or done beyond the syllabus, a short problem or scenario to think through out loud, how "
            "they handle not knowing, and their plans. Follow up on anything they mention to see how they think"
        ),
        "judge": (
            "what admissions tutors look for: genuine curiosity for the subject, thinking out loud clearly, "
            "engaging with a problem rather than reciting, honesty about gaps, and a believable motivation"
        ),
    },
    "internship": {
        "label": "Internship / graduate scheme interview",
        "counterpart": "graduate recruiter",
        "event": "graduate interview",
        "subject_default": "the internship or graduate programme",
        "setting": "an interview for {subject}",
        "questions": (
            "graduate-recruiter questions: tell me about yourself, why this company and programme, "
            "competency questions answered from university, projects, part-time work or societies "
            "(teamwork, leadership, handling a setback, a time you learned fast), motivation for the field, "
            "and one question about commercial or industry awareness"
        ),
        "judge": (
            "what graduate recruiters expect from a student or new graduate: STAR-structured examples from "
            "any part of life, clear motivation for this employer, eagerness to learn, and basic awareness of "
            "the industry — not years of work experience"
        ),
    },
    "group": {
        "label": "Group discussion / assessment centre",
        "counterpart": "assessor",
        "event": "group exercise",
        "subject_default": "a case for the group to solve",
        "setting": "an assessment-centre group exercise on {subject}, where you play both the assessor and the other candidates",
        "questions": (
            "moments from a group exercise: set the case, then speak as other candidates who take over, go "
            "off-topic, disagree, stay quiet or rush to a vote, and ask the candidate to respond — plus a "
            "final 'summarise the group's recommendation' request from the assessor"
        ),
        "judge": (
            "what assessors score: contributing ideas with reasons, building on others, bringing quieter "
            "people in, keeping to time and the brief, handling disagreement calmly, and summarising — not "
            "who talks most"
        ),
    },
    # ── Roadmap 2.3: English speaking tests (structure and scoring in exams.py) ──
    "ielts": {
        "label": "IELTS Speaking",
        "counterpart": "IELTS examiner",
        "event": "IELTS speaking test",
        "subject_default": "",
        "setting": "an IELTS Speaking test",
        "questions": "the three parts of the IELTS Speaking test",
        "judge": "the IELTS Speaking band descriptors: fluency and coherence, lexical resource, grammatical range and accuracy",
        "exam": "ielts",
    },
    "toefl": {
        "label": "TOEFL-style speaking",
        "counterpart": "TOEFL examiner",
        "event": "TOEFL-style speaking test",
        "subject_default": "",
        "setting": "a TOEFL-style speaking test",
        "questions": "TOEFL-style independent and integrated speaking tasks",
        "judge": "TOEFL-style speaking rubrics: delivery, language use and topic development",
        "exam": "toefl",
    },
    # ── Roadmap 2.4: work ───────────────────────────────────────────────────
    "review": {
        "label": "Performance review",
        "counterpart": "manager",
        "event": "performance review",
        "subject_default": "the last review period",
        "setting": "a performance review covering {subject}",
        "questions": (
            "a manager running a review: ask for the highlights of the period and the evidence, raise one "
            "area that didn't go well, ask how they'd rate themselves and why, discuss goals for next "
            "period, and ask what support they need"
        ),
        "judge": (
            "a strong review conversation: results backed by specific evidence and impact, owning the weak "
            "spot without defensiveness, a fair self-rating, concrete goals, and clear asks for support"
        ),
    },
    "promotion": {
        "label": "Asking for a promotion",
        "counterpart": "manager",
        "event": "promotion conversation",
        "subject_default": "the next level",
        "setting": "a conversation where the candidate asks their manager for a promotion to {subject}",
        "questions": (
            "a manager's realistic reactions to a promotion ask: ask what's changed since their last "
            "review, probe whether they already work at the next level with examples, raise a gap or a "
            "budget/timing constraint, and ask what they'd do if the answer is 'not yet'"
        ),
        "judge": (
            "making a strong case: evidence of already working at the next level, impact tied to team "
            "goals, calm handling of 'not yet' by agreeing concrete criteria and a timeline"
        ),
    },
    "feedback": {
        "label": "Giving feedback",
        "counterpart": "team member",
        "event": "feedback conversation",
        "subject_default": "a piece of work",
        "setting": "a conversation where the candidate gives feedback to a colleague about {subject}",
        "questions": (
            "reactions a colleague might have when receiving feedback: ask for specifics, get defensive, "
            "explain a reason the candidate didn't know about, agree too quickly, or ask what good looks "
            "like — so the candidate practises staying clear and kind"
        ),
        "judge": (
            "good feedback: specific behaviour and its impact rather than personality, a clear ask for the "
            "future, listening and adjusting to the other side, and ending with an agreed next step"
        ),
    },
    "one_on_one": {
        "label": "1:1 with your manager",
        "counterpart": "manager",
        "event": "one-to-one",
        "subject_default": "this week's 1:1",
        "setting": "a one-to-one with a manager about {subject}",
        "questions": (
            "a manager's 1:1 questions: what's on your mind, progress and blockers, a direct question "
            "about a slipping piece of work, how things are going with the team, and what you want to grow "
            "into"
        ),
        "judge": (
            "a useful 1:1: brings their own agenda, is honest about blockers with a proposed fix, asks for "
            "specific help or feedback, and connects day-to-day work to growth goals"
        ),
    },
    "support": {
        "label": "Customer / support call",
        "counterpart": "customer",
        "event": "customer call",
        "subject_default": "a problem with the product",
        "setting": "a customer or support call about {subject}",
        "questions": (
            "a realistic customer: explain the problem vaguely at first, get frustrated, ask for a refund "
            "or escalation, push back on a workaround, and ask when it will be fixed"
        ),
        "judge": (
            "strong customer handling: acknowledging the problem and the feeling, asking questions to "
            "understand it, a clear next step with a timeline, never promising what can't be kept, and a "
            "calm tone throughout"
        ),
    },
    # Research Track's practice panel: the people a new researcher has to convince.
    "supervisor": {
        "label": "Supervisor meeting",
        "counterpart": "research supervisor",
        "event": "supervision meeting",
        "subject_default": "their research project",
        "setting": "a one-to-one meeting with a research supervisor about {subject}",
        "questions": (
            "questions a demanding but supportive research supervisor asks a new student in a weekly "
            "meeting: what exactly they did since last time and why, how the research question is "
            "defined, which papers it builds on, why this method rather than an alternative, what a "
            "result means and how sure they are, what could be wrong, and the next concrete step. Ask "
            "them to define key terms they use, and ask one question that checks they understand how "
            "research works in general, such as peer review, replication or what counts as a contribution"
        ),
        "judge": (
            "what a supervisor expects from a new research student: research terms used precisely, "
            "claims no stronger than the evidence, honest uncertainty with a way to find out, and a "
            "clear next step"
        ),
    },
    "journal_club": {
        "label": "Journal club",
        "counterpart": "journal club member",
        "event": "journal club",
        "subject_default": "the paper they presented",
        "setting": "a lab journal club where the student has just presented {subject}",
        "questions": (
            "questions lab members ask at a journal club: what question the paper asks and why it "
            "matters, how the study was designed, the main result with its size and uncertainty, what "
            "the figures actually show, hidden assumptions and weak baselines or controls, whether the "
            "conclusions go beyond the evidence, how it relates to other work, and what study should "
            "come next"
        ),
        "judge": (
            "what a journal club expects: an accurate summary, a correct reading of the methods and "
            "results, at least one real limitation, conclusions no stronger than the evidence, and "
            "field terms used correctly"
        ),
    },
    "proposal": {
        "label": "Proposal defence",
        "counterpart": "proposal panel member",
        "event": "proposal defence",
        "subject_default": "their research proposal",
        "setting": "a research proposal defence on {subject}",
        "questions": (
            "the eight questions of DARPA's Heilmeier Catechism, asked in turn by a panel reviewing a research "
            "proposal: what are you trying to do, with no jargon; how is it done today and what are the limits; "
            "what is new in your approach and why will it succeed; who cares and what difference will it make; "
            "what are the risks; how much will it cost; how long will it take; and what are the mid-term and "
            "final exams to check for success. Follow a vague answer with one sharper question, such as asking "
            "for the hypothesis that could turn out false or for the single result that would count as failure"
        ),
        "judge": (
            "what a proposal panel expects: a specific, answerable question in plain words, a real gap in current "
            "work, a hypothesis that could be wrong, honest risks, and a realistic plan with checkpoints"
        ),
    },
    "reviewer": {
        "label": "Reviewer 2",
        "counterpart": "reviewer",
        "event": "peer review of a study design",
        "subject_default": "their study or replication",
        "setting": "a sceptical expert reviewer questioning the design of {subject}",
        "questions": (
            "the objections a careful, sceptical peer reviewer raises about a study design or a replication: "
            "whether the design can support the claim, how each construct is measured and whether the measure "
            "is valid and reliable, confounds and alternative explanations, the baseline or control, how the "
            "sample size was chosen and whether the study has the power to find the effect, what was "
            "preregistered and what was decided after seeing the data, whether the analysis and data can be "
            "reproduced, ethics and consent, and any claim that goes further than the evidence"
        ),
        "judge": (
            "what a careful reviewer accepts: a design that fits the claim, justified measures, confounds named "
            "and handled, a stated basis for the sample size, honest limits, and a reproducible, preregistered plan"
        ),
    },
    "audience": {
        "label": "Conference audience",
        "counterpart": "audience member",
        "event": "conference talk",
        "subject_default": "their research talk",
        "setting": "the question time after a 10-minute conference talk on {subject}",
        "questions": (
            "questions from a mixed conference audience after a research talk: a short clarifying question, "
            "a sceptical 'so what?' about why the result matters, a methods challenge, a question from someone in "
            "a neighbouring field who missed the jargon, a question outside the speaker's area, and one long, "
            "rambling or hostile question the speaker has to handle politely and briefly"
        ),
        "judge": (
            "what a good conference audience rewards: short, clear answers that restate the question, answer what "
            "can be answered, admit what cannot, stay calm under hostile questions, and never claim more than the "
            "evidence shows"
        ),
    },
    "committee": {
        "label": "Viva committee",
        "counterpart": "examiner",
        "event": "viva",
        "subject_default": "their research project",
        "setting": "a long oral examination by a three-person committee on {subject}",
        "questions": (
            "the questions of a thorough viva by three examiners taking turns: the research question and why it "
            "matters, how it builds on and differs from existing work, every design and method choice and its "
            "alternatives, threats to validity and how they were handled, what the results do and do not show, "
            "alternative explanations, limitations, what the candidate would do differently, and what comes next. "
            "Mix open questions with close challenges on specific details"
        ),
        "judge": (
            "what an examining committee expects of an independent researcher: command of the work and the field, "
            "justified choices, honest limits, calm handling of critique, and a clear view of the next contribution"
        ),
    },
    "professor": {
        "label": "Call with a professor",
        "counterpart": "professor",
        "event": "short call with a professor the student emailed",
        "subject_default": "joining their group",
        "setting": "a 10-minute video call with a busy professor about {subject}, after the student emailed them",
        "questions": (
            "what a busy professor asks a prospective student or collaborator on a short call: why their group in "
            "particular, what the student has already done that shows they can do research, what they have read of "
            "the professor's work and what they think of it, the question they want to work on, what they need "
            "(supervision, funding, a project), and whether they know how the application or funding works"
        ),
        "judge": (
            "what a professor looks for: a specific reason for choosing them, evidence of real research work, "
            "genuine engagement with their papers, a clear, realistic ask, and brevity"
        ),
    },
    "wc_guide": {
        "label": "Wordcraft: the Guide",
        "counterpart": "English tutor",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "a relaxed practice chat between an English learner and their friendly tutor, the Guide, about {subject}",
        "questions": (
            "simple, friendly questions a patient tutor asks a learner at their level: who they are, their day, their family and work, what they like, and one question that invites them to use today's words; if they seem stuck, rephrase more simply"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "wc_shopkeeper": {
        "label": "Wordcraft: the Shopkeeper",
        "counterpart": "market shopkeeper",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "a busy market stall where the learner wants to buy {subject}",
        "questions": (
            "what a shopkeeper says and asks at a market stall: what they want, how many, sizes and colours, prices and change, what else they need, and one small problem to sort out (something is sold out, or the price is different)"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "wc_neighbour": {
        "label": "Wordcraft: the Neighbour",
        "counterpart": "new neighbour",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "a chat on the street with a curious new neighbour about {subject}",
        "questions": (
            "what a friendly new neighbour asks: where they are from, what they did last weekend, their plans, their work or studies, the area, and an invitation to something; ask about the past and the future"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "wc_colleague": {
        "label": "Wordcraft: the Colleague",
        "counterpart": "work colleague",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "a short talk at work with a colleague who needs something done, about {subject}",
        "questions": (
            "what a colleague asks at work: what the problem is, what has happened so far, what the learner thinks and why, what they need, and what the next step is; ask one polite indirect question"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "wc_debater": {
        "label": "Wordcraft: the Debater",
        "counterpart": "debater",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "a friendly debate in which the other person takes the opposite side on {subject}",
        "questions": (
            "what a polite but determined debater does: asks for the learner's view and reasons, gives a strong opposing argument, asks for evidence, and invites them to answer an objection and weigh advantages and disadvantages"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "wc_interviewer": {
        "label": "Wordcraft: the Interviewer",
        "counterpart": "interviewer",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "a job interview for {subject}",
        "questions": (
            "what an interviewer asks: why this role, a time they solved a problem (with evidence), a mistake and what they learned, how sure they are about a claim, and one hard follow-up question"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "wc_audience": {
        "label": "Wordcraft: the Audience",
        "counterpart": "audience member",
        "event": "Wordcraft practice",
        "subject_default": "everyday life",
        "setting": "question time after the learner's short talk on {subject}",
        "questions": (
            "questions an audience asks after a talk: the main message in one sentence, the evidence, a sceptical question, a question from someone new to the topic that needs a simple explanation, and what they want the audience to do"
        ),
        "judge": (
            "whether the learner's message landed at their level: the content answers the question, the ideas are in a sensible order, and the listener could understand it. Never count pauses, repeated sounds, fillers, pace or accent against them; only mistakes that blur the meaning matter"
        ),
    },
    "custom": {
        "label": "Custom scenario",
        "counterpart": "the other party",
        "event": "conversation",
        "subject_default": "the conversation",
        "setting": "a {subject}",
        "questions": (
            "questions that fit the situation the user described in the details, played as the other "
            "party in that conversation, from warm-up to the harder moments"
        ),
        "judge": (
            "clear, confident, well-structured responses appropriate to the situation the user described"
        ),
    },
}

DEFAULT_SCENARIO = "job"


def get_scenario(scenario_id: str | None) -> tuple[str, dict]:
    sid = scenario_id if scenario_id in SCENARIOS else DEFAULT_SCENARIO
    return sid, SCENARIOS[sid]


def scenario_from_tags(tags: str | None) -> tuple[str, dict]:
    for tag in (tags or "").split(","):
        if tag.strip() in SCENARIOS and tag.strip() != DEFAULT_SCENARIO:
            return get_scenario(tag.strip())
    return get_scenario(None)
