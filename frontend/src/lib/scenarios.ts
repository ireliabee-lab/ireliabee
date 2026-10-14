// Practice scenarios beyond job interviews. Mirrors backend/scenarios.py.

export interface Scenario {
  id: string;
  label: string;
  hint: string;
  template: string | null;       // live-coach template; null = infer from the role
  subjectLabel: string;
  subjectPlaceholder: string;
  detailsLabel: string;
  detailsPlaceholder: string;
  counterpart: string;
  title: string;
  group: ScenarioGroup;
}

/** Scenario groups for the picker; order is adjusted for the user's persona. */
export type ScenarioGroup = "apply" | "research" | "wordcraft" | "exam" | "work" | "speak";
export const SCENARIO_GROUPS: { id: ScenarioGroup; label: string }[] = [
  { id: "apply", label: "Interviews & applications" },
  { id: "research", label: "Research" },
  { id: "wordcraft", label: "Wordcraft characters" },
  { id: "exam",  label: "English speaking tests" },
  { id: "work",  label: "Work" },
  { id: "speak", label: "Speaking & other" },
];

/** Speaking tests run in the exam's own structure and are scored band-style (roadmap 2.3). */
export const isExam = (id: string) => id === "ielts" || id === "toefl";

export const SCENARIOS: Scenario[] = [
  {
    id: "wc_guide", group: "wordcraft", label: "The Guide", hint: "A patient tutor for any level",
    template: null, counterpart: "Guide", title: "Wordcraft Guide practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "wc_shopkeeper", group: "wordcraft", label: "The Shopkeeper", hint: "Buying things at the market",
    template: null, counterpart: "Shopkeeper", title: "Wordcraft Shopkeeper practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "wc_neighbour", group: "wordcraft", label: "The Neighbour", hint: "Small talk about your life and plans",
    template: null, counterpart: "Neighbour", title: "Wordcraft Neighbour practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "wc_colleague", group: "wordcraft", label: "The Colleague", hint: "Problems and next steps at work",
    template: null, counterpart: "Colleague", title: "Wordcraft Colleague practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "wc_debater", group: "wordcraft", label: "The Debater", hint: "Opinions, reasons and objections",
    template: null, counterpart: "Debater", title: "Wordcraft Debater practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "wc_interviewer", group: "wordcraft", label: "The Interviewer", hint: "A job interview with evidence",
    template: null, counterpart: "Interviewer", title: "Wordcraft Interviewer practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "wc_audience", group: "wordcraft", label: "The Audience", hint: "Questions after your talk",
    template: null, counterpart: "Audience", title: "Wordcraft Audience practice",
    subjectLabel: "Topic", subjectPlaceholder: "e.g. your weekend, your job, a trip",
    detailsLabel: "Your level and words to use (optional)", detailsPlaceholder: "Wordcraft fills this in for you",
  },
  {
    id: "supervisor", group: "research", label: "Supervisor meeting", hint: "Weekly one-to-one on your research",
    template: "academic-phd", counterpart: "Supervisor", title: "Mock supervisor meeting",
    subjectLabel: "Your research project", subjectPlaceholder: "e.g. Surprisal and disfluency in conversational speech",
    detailsLabel: "What you did since last time (optional)", detailsPlaceholder: "Progress, what broke, what you plan next, so the supervisor can dig in",
  },
  {
    id: "proposal", group: "research", label: "Proposal defence", hint: "The eight Heilmeier questions, asked live",
    template: "academic-phd", counterpart: "Proposal panel", title: "Mock proposal defence",
    subjectLabel: "Your research question", subjectPlaceholder: "e.g. Does word surprisal predict stuttering in conversation?",
    detailsLabel: "Your one-page proposal (optional)", detailsPlaceholder: "Your answers to the eight Heilmeier questions, so the panel can press on them",
  },
  {
    id: "reviewer", group: "research", label: "Reviewer 2", hint: "A sceptical reviewer questions your design",
    template: "academic-phd", counterpart: "Reviewer", title: "Mock design review",
    subjectLabel: "Study or replication", subjectPlaceholder: "e.g. Replicating Warner et al. (2026) on FluencyBank",
    detailsLabel: "Your plan (optional)", detailsPlaceholder: "Claim, data, measures, sample size, what you preregistered",
  },
  {
    id: "audience", group: "research", label: "Conference audience", hint: "Question time after your talk",
    template: "academic-phd", counterpart: "Audience", title: "Mock conference questions",
    subjectLabel: "Your talk", subjectPlaceholder: "e.g. What makes a word hard to say? Surprisal and stuttering",
    detailsLabel: "Your message and outline (optional)", detailsPlaceholder: "So the audience can ask about what you actually said",
  },
  {
    id: "committee", group: "research", label: "Viva committee", hint: "A long oral exam on your own project",
    template: "thesis-defense", counterpart: "Examiner", title: "Mock viva",
    subjectLabel: "Your project", subjectPlaceholder: "e.g. Surprisal and disfluency in conversational speech",
    detailsLabel: "Summary of your work (optional)", detailsPlaceholder: "Question, methods, results and limits, so the committee can dig in",
  },
  {
    id: "professor", group: "research", label: "Call with a professor", hint: "The short call after your cold email",
    template: "academic-phd", counterpart: "Professor", title: "Mock call with a professor",
    subjectLabel: "What you're asking about", subjectPlaceholder: "e.g. A PhD place in the speech and fluency lab",
    detailsLabel: "Your email and background (optional)", detailsPlaceholder: "What you sent them and what you've done",
  },
  {
    id: "journal_club", group: "research", label: "Journal club", hint: "Present a paper, take the panel's questions",
    template: "academic-phd", counterpart: "Journal club", title: "Mock journal club",
    subjectLabel: "Paper you're presenting", subjectPlaceholder: "e.g. Warner et al. 2026, Information load predicts stuttering events",
    detailsLabel: "Your summary of the paper (optional)", detailsPlaceholder: "Question, method, main result, one limitation — or attach the paper below",
  },
  {
    id: "job", group: "apply", label: "Job interview", hint: "Behavioral and technical questions",
    template: null, counterpart: "Interviewer", title: "Mock interview",
    subjectLabel: "Role you're interviewing for", subjectPlaceholder: "e.g. Junior Backend Developer",
    detailsLabel: "Job description (optional)", detailsPlaceholder: "Paste the job description to get questions tailored to it",
  },
  {
    id: "thesis", group: "apply", label: "Thesis defence", hint: "Viva with examiners",
    template: "thesis-defense", counterpart: "Examiner", title: "Mock thesis defence",
    subjectLabel: "Thesis or project title", subjectPlaceholder: "e.g. Low-latency speech recognition for Twi",
    detailsLabel: "Abstract or summary (optional)", detailsPlaceholder: "Paste your abstract so the examiner can dig into your actual methods and results",
  },
  {
    id: "scholarship", group: "apply", label: "Scholarship panel", hint: "Motivation, impact, giving back",
    template: "scholarship", counterpart: "Panel member", title: "Mock scholarship interview",
    subjectLabel: "Scholarship or fellowship", subjectPlaceholder: "e.g. Chevening, Mastercard Foundation, DAAD",
    detailsLabel: "Selection criteria or your essay (optional)", detailsPlaceholder: "Paste the criteria or your personal statement",
  },
  {
    id: "salary", group: "work", label: "Salary negotiation", hint: "Practise asking for more",
    template: "salary-negotiation", counterpart: "Hiring manager", title: "Mock salary negotiation",
    subjectLabel: "Role and offer", subjectPlaceholder: "e.g. Data Analyst offer at GHS 8,000/month",
    detailsLabel: "Offer details and your target (optional)", detailsPlaceholder: "What they offered, what you want, and anything you know about their budget",
  },
  {
    id: "meeting", group: "work", label: "Work meeting", hint: "Updates, pushback, asks",
    template: "work-meeting", counterpart: "Manager", title: "Mock work meeting",
    subjectLabel: "What the meeting is about", subjectPlaceholder: "e.g. Weekly check-in on the payments migration",
    detailsLabel: "Agenda or context (optional)", detailsPlaceholder: "Status, risks, what you need to ask for",
  },
  {
    id: "pitch", group: "work", label: "Sales / investor pitch", hint: "Objections, traction, the ask",
    template: "sales-pitch", counterpart: "Prospect", title: "Rehearse a pitch",
    subjectLabel: "What you're pitching", subjectPlaceholder: "e.g. iReliabee to a university career centre",
    detailsLabel: "Pitch details (optional)", detailsPlaceholder: "The problem, your solution, traction, pricing, the ask",
  },
  {
    id: "presentation", group: "work", label: "Present to leadership", hint: "Headline, data, tough questions",
    template: "presentation", counterpart: "Stakeholder", title: "Rehearse a presentation",
    subjectLabel: "What you're presenting", subjectPlaceholder: "e.g. Q3 roadmap to the leadership team",
    detailsLabel: "Key points or slides (optional)", detailsPlaceholder: "Your main message, the data, the decision you need",
  },
  {
    id: "difficult", group: "work", label: "Difficult conversation", hint: "Feedback, conflict, hard news",
    template: "difficult-conversation", counterpart: "The other person", title: "Rehearse a hard conversation",
    subjectLabel: "What the conversation is about", subjectPlaceholder: "e.g. Telling a teammate their work is slipping",
    detailsLabel: "Context (optional)", detailsPlaceholder: "What happened, what you want to say, the outcome you want",
  },
  {
    id: "speaking", group: "speak", label: "Public speaking", hint: "A talk or speech + Q and A",
    template: "public-speaking", counterpart: "Audience", title: "Rehearse a talk",
    subjectLabel: "Your talk", subjectPlaceholder: "e.g. A 5-minute talk on why practice beats talent",
    detailsLabel: "Outline or script (optional)", detailsPlaceholder: "Your hook, key points and close",
  },
  // ── Roadmap 2.3 ──────────────────────────────────────────────────────────
  {
    id: "ielts", group: "exam", label: "IELTS Speaking", hint: "Parts 1–3, band scores",
    template: "general", counterpart: "Examiner", title: "IELTS Speaking practice",
    subjectLabel: "Topic you'd like for Part 2 (optional)", subjectPlaceholder: "e.g. travel, technology, a person you admire",
    detailsLabel: "Anything to focus on (optional)", detailsPlaceholder: "e.g. I lose fluency in Part 3, I overuse 'very'",
  },
  {
    id: "toefl", group: "exam", label: "TOEFL-style speaking", hint: "Timed tasks, 0–4 scores",
    template: "general", counterpart: "Examiner", title: "TOEFL-style speaking practice",
    subjectLabel: "Topic you'd like (optional)", subjectPlaceholder: "e.g. campus life, science, work",
    detailsLabel: "Anything to focus on (optional)", detailsPlaceholder: "e.g. I run out of time, I need more examples",
  },
  // ── Roadmap 2.4 ──────────────────────────────────────────────────────────
  {
    id: "admission", group: "apply", label: "University admission", hint: "Why this course, think out loud",
    template: "admission-interview", counterpart: "Admissions tutor", title: "Mock admission interview",
    subjectLabel: "Course and university", subjectPlaceholder: "e.g. Computer Science at KNUST",
    detailsLabel: "Personal statement or course details (optional)", detailsPlaceholder: "Paste your personal statement so the tutor can ask about it",
  },
  {
    id: "internship", group: "apply", label: "Internship / graduate scheme", hint: "Competencies from uni life",
    template: "graduate-interview", counterpart: "Graduate recruiter", title: "Mock graduate interview",
    subjectLabel: "Programme or role", subjectPlaceholder: "e.g. Summer internship, Deloitte Technology",
    detailsLabel: "Job advert or programme details (optional)", detailsPlaceholder: "Paste the advert so questions match what they're looking for",
  },
  {
    id: "group", group: "apply", label: "Group discussion", hint: "Assessment-centre exercise",
    template: "group-discussion", counterpart: "Assessor", title: "Mock group exercise",
    subjectLabel: "The case or topic", subjectPlaceholder: "e.g. Choose which of three products to launch",
    detailsLabel: "Case brief (optional)", detailsPlaceholder: "Paste the brief if you have one — otherwise one is made up",
  },
  {
    id: "one_on_one", group: "work", label: "1:1 with your manager", hint: "Blockers, asks, growth",
    template: "one-on-one", counterpart: "Manager", title: "Rehearse a 1:1",
    subjectLabel: "What you want to cover", subjectPlaceholder: "e.g. The delayed release and my next goal",
    detailsLabel: "Context (optional)", detailsPlaceholder: "What's going well, what's blocked, what you want to ask",
  },
  {
    id: "review", group: "work", label: "Performance review", hint: "Evidence, self-rating, goals",
    template: "performance-review", counterpart: "Manager", title: "Rehearse a performance review",
    subjectLabel: "Review period", subjectPlaceholder: "e.g. H1 2026 review",
    detailsLabel: "Your highlights and goals (optional)", detailsPlaceholder: "Results with numbers, what didn't go well, goals you want",
  },
  {
    id: "promotion", group: "work", label: "Asking for a promotion", hint: "Make the case, handle 'not yet'",
    template: "promotion-ask", counterpart: "Manager", title: "Rehearse a promotion ask",
    subjectLabel: "The role you're asking for", subjectPlaceholder: "e.g. Senior Engineer",
    detailsLabel: "Your evidence (optional)", detailsPlaceholder: "Where you already work at the next level, and the impact",
  },
  {
    id: "feedback", group: "work", label: "Giving feedback", hint: "Specific, kind, clear ask",
    template: "giving-feedback", counterpart: "Team member", title: "Rehearse giving feedback",
    subjectLabel: "What the feedback is about", subjectPlaceholder: "e.g. Missed deadlines on the reporting work",
    detailsLabel: "What happened (optional)", detailsPlaceholder: "The behaviour, its impact, and what you want instead",
  },
  {
    id: "support", group: "work", label: "Customer / support call", hint: "Frustration, fixes, next steps",
    template: "customer-call", counterpart: "Customer", title: "Rehearse a customer call",
    subjectLabel: "What the call is about", subjectPlaceholder: "e.g. A customer charged twice this month",
    detailsLabel: "Product and policy details (optional)", detailsPlaceholder: "What you can offer, refund rules, known issues",
  },
  {
    id: "custom", group: "speak", label: "Something else", hint: "Describe any conversation",
    template: "general", counterpart: "The other party", title: "Rehearse a conversation",
    subjectLabel: "Describe the situation", subjectPlaceholder: "e.g. Convincing my landlord to lower the rent",
    detailsLabel: "Anything to add (optional)", detailsPlaceholder: "Who you're talking to, the stakes, what you want",
  },
];

export function getScenario(id: string | undefined): Scenario {
  return SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
}

// What to call the other party per live-coach template — display label only.
// Interview-style templates keep "Interviewer"; others use their scenario's counterpart.
const BASE_COUNTERPART: Record<string, string> = {
  "tech-interview": "Interviewer",
  "academic-phd": "Interviewer",
  "product-management": "Interviewer",
  "sales-discovery": "Prospect",
  "medical-residency": "Interviewer",
  "general": "Them",
  "lecture": "Lecturer",
};

export function counterpartLabel(template?: string | null): string {
  if (!template) return "Them";
  if (template in BASE_COUNTERPART) return BASE_COUNTERPART[template];
  const s = SCENARIOS.find(sc => sc.template === template);
  return s ? s.counterpart : "Them";
}

export const EXTRA_TEMPLATES = [
  { id: "thesis-defense",     label: "Thesis Defence / Viva" },
  { id: "scholarship",        label: "Scholarship Panel" },
  { id: "salary-negotiation", label: "Salary Negotiation" },
  { id: "work-meeting",       label: "Work Meeting (ends with a recap)" },
  { id: "sales-pitch",        label: "Sales / Investor Pitch" },
  { id: "presentation",       label: "Presentation" },
  { id: "difficult-conversation", label: "Difficult Conversation" },
  { id: "public-speaking",    label: "Public Speaking" },
  { id: "lecture",            label: "Lecture Companion (study notes, flashcards, quiz)" },
  { id: "admission-interview", label: "University Admission Interview" },
  { id: "graduate-interview", label: "Internship / Graduate Interview" },
  { id: "group-discussion",   label: "Group Discussion / Assessment Centre" },
  { id: "one-on-one",         label: "1:1 with Your Manager" },
  { id: "performance-review", label: "Performance Review" },
  { id: "promotion-ask",      label: "Asking for a Promotion" },
  { id: "giving-feedback",    label: "Giving Feedback" },
  { id: "customer-call",      label: "Customer / Support Call" },
];
