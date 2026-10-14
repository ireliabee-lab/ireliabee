/**
 * Suggested values for forms, from what the app already knows. Free, instant,
 * on this computer: no AI, nothing sent anywhere.
 *
 * A suggestion only ever goes into an empty box, is shown as a suggestion
 * (components/Suggested.tsx), and stops being one the moment the person types
 * in that box — after that it is theirs and is never replaced.
 *
 * The map:
 *   New session — title from the meeting on now or next (calendar), or the
 *                 plan waiting to be used; role from the active profile's
 *                 target role, with the plan's company.
 *   Plans       — title and company from a job link or pasted job post, or
 *                 from the next meeting today that has no plan yet.
 *   Meeting agenda — the agenda and who you're meeting, from that invite.
 *   Stories     — tags from the story's own words.
 */
import type { CalEvent, Person } from "./calendar";
import { meetingForQuickStart } from "./liveGate";

export interface Suggestion { value: string; source: string }
export type Suggestions<K extends string> = Partial<Record<K, Suggestion>>;

// ── Keeping suggestions apart from what the person typed ─────────────────────

/** Box → the suggested text we put there, while it is still untouched. */
export type Placed = Record<string, string>;

/**
 * Put suggestions into empty boxes, refresh ones we placed that nobody has
 * touched, and let go of any the person has edited. A suggestion that goes
 * away (the job link was cleared) takes its text with it, but only if that
 * text is still exactly what we put there.
 */
export function mergeSuggestions<T extends object>(
  values: T,
  suggestions: Partial<Record<keyof T & string, Suggestion | undefined>>,
  placed: Placed,
): { values: T; placed: Placed } {
  const next: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  const still: Placed = {};
  for (const [key, text] of Object.entries(placed)) {
    if (next[key] === text) still[key] = text;            // untouched: still ours
  }
  const keys = new Set([...Object.keys(still), ...Object.keys(suggestions)]);
  for (const key of keys) {
    const s = (suggestions as Record<string, Suggestion | undefined>)[key];
    const value = s?.value?.trim() ?? "";
    if (key in still) {
      if (value) { next[key] = value; still[key] = value; }
      else { next[key] = ""; delete still[key]; }
    } else if (value && isEmpty(next[key])) {
      next[key] = value;
      still[key] = value;
    }
  }
  return { values: next as T, placed: still };
}

const isEmpty = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

// ── New session ───────────────────────────────────────────────────────────────

export interface ProfileLike { target_role?: string | null; is_active?: number | boolean | null }
export interface PlanLike { title?: string | null; counterparty?: string | null }

export function sessionSuggestions(ctx: {
  events?: Pick<CalEvent, "start" | "end" | "all_day" | "title">[] | null;
  profiles?: ProfileLike[] | null;
  plan?: PlanLike | null;
  now?: number;
}): Suggestions<"title" | "subtitle"> {
  const out: Suggestions<"title" | "subtitle"> = {};
  const meeting = meetingForQuickStart(ctx.events, ctx.now);
  if (meeting) out.title = { value: meeting.title.trim(), source: "your calendar" };
  else if (ctx.plan?.title?.trim()) out.title = { value: ctx.plan.title.trim(), source: "the plan you chose" };

  const profile = (ctx.profiles ?? []).find(p => Boolean(p.is_active)) ?? null;
  const role = profile?.target_role?.trim() ?? "";
  const company = ctx.plan?.counterparty?.trim() ?? "";
  const subtitle = [role, company].filter(Boolean).join(" · ");
  if (subtitle) {
    out.subtitle = {
      value: subtitle,
      source: role && company ? "your profile and the plan" : role ? "your profile" : "the plan you chose",
    };
  }
  return out;
}

// ── Plans: from a job post ────────────────────────────────────────────────────

/** "acme-corp" → "Acme Corp". */
export function humanize(slug: string): string {
  return slug
    .replace(/[_+.]+/g, " ")
    .replace(/-+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i, all) => {
      // A lone short name is an initialism (bbc → BBC); small joining words stay small.
      if (all.length === 1 && w.length <= 3) return w.toUpperCase();
      if (i > 0 && ["and", "of", "the", "for"].includes(w.toLowerCase())) return w.toLowerCase();
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** Job boards that put the company in the address, and where. */
const BOARD_PATH = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|teamtailor\.com|personio\.(de|com)|breezy\.hr|jobvite\.com)$/i;
const BOARD_SUBDOMAIN = /^([a-z0-9-]+)\.(wd\d+\.myworkdayjobs\.com|bamboohr\.com|recruitee\.com|breezy\.hr|teamtailor\.com|jobs\.personio\.(de|com)|applytojob\.com)$/i;
/** Sites that list other companies' jobs: their name is not the company. */
const AGGREGATOR = /(^|\.)(linkedin|indeed|glassdoor|monster|reed|totaljobs|ziprecruiter|google|seek|jobberman|wellfound|angel|otta|welcometothejungle)\./i;
const GENERIC_SEGMENTS = /^(jobs?|careers?|positions?|openings?|apply|view|en|en-us|en-gb|us|uk|o|p|j|details?|posting|postings|embed|job-boards?|boards?|requisitions?|vacanc(y|ies))$/i;

/** Company and role from a job link, where the address gives them away. */
export function fromJobUrl(raw: string): { company?: string; role?: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return {}; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").map(decodeURIComponent).filter(Boolean);
  let company: string | undefined;
  const sub = host.match(BOARD_SUBDOMAIN);
  if (sub) company = humanize(sub[1]);
  else if (BOARD_PATH.test(host) && segments[0] && !GENERIC_SEGMENTS.test(segments[0])) company = humanize(segments[0]);
  else if (!AGGREGATOR.test(host)) {
    // careers.acme.com, jobs.acme.co.uk, acme.com/careers
    const parts = host.split(".");
    const core = parts.length >= 3 && /^(co|com|org|ac|gov)$/.test(parts[parts.length - 2])
      ? parts[parts.length - 3] : parts[parts.length - 2];
    if (core && core.length > 1) company = humanize(core);
  }
  // A role in the address: the last segment that reads like words, not an id.
  let role: string | undefined;
  for (const seg of [...segments].reverse()) {
    const cleaned = seg.replace(/\.(html?|aspx?|php)$/i, "")
      // A requisition id on the end: 12345, R-12345, JR_1234, REQ-99812, or a hex id.
      .replace(/[-_]+(?:[a-z]{1,4}[-_]?)?\d{3,}$|[-_]?\d{3,}$|[-_]?[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i, "");
    const words = cleaned.split(/[-_+]+/).filter(w => /[a-z]/i.test(w));
    if (words.length >= 2 && !GENERIC_SEGMENTS.test(cleaned) && !/^[0-9a-f-]{16,}$/i.test(seg)) {
      if (company && humanize(cleaned).toLowerCase() === company.toLowerCase()) continue;
      role = humanize(words.join("-"));
      break;
    }
  }
  return { company, role };
}

const LABELLED = (label: string) => new RegExp(`^\\s*(?:${label})\\s*[:\\-–—]\\s*(.{2,80})$`, "im");

/** Company and role from a pasted job description. */
export function fromJobText(text: string): { company?: string; role?: string } {
  const body = text.trim();
  if (!body) return {};
  let role = body.match(LABELLED("job title|position|role|title|vacancy"))?.[1]?.trim();
  let company = body.match(LABELLED("company|employer|organi[sz]ation|hiring company"))?.[1]?.trim();
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  // "Senior Backend Engineer at Acme" / "Senior Backend Engineer - Acme"
  const at = first.match(/^(.{3,70}?)\s+(?:at|@|[-–—|])\s+(.{2,50})$/i);
  if (at) { role ??= at[1].trim(); company ??= at[2].trim(); }
  if (!company) {
    const about = body.match(/^\s*about\s+(?!(?:the|us|you|this|our|your)\b)([A-Z][\w&.' -]{1,40})[ \t]*$/im);
    if (about) company = about[1].trim();
  }
  if (!role && first.length <= 70 && !/[.!?]$/.test(first) && first.split(/\s+/).length <= 8) role = first;
  const tidy = (s?: string) => s?.replace(/[*#_`]+/g, "").replace(/\s+/g, " ").trim() || undefined;
  return { company: tidy(company), role: tidy(role) };
}

export function planTitle(role?: string, company?: string): string | undefined {
  if (role && company) return `${company} — ${role} interview`;
  if (role) return `${role} interview`;
  if (company) return `${company} interview`;
  return undefined;
}

export function planSuggestionsFromJob(input: { url?: string; text?: string }): Suggestions<"title" | "counterparty"> {
  const fromUrl = input.url?.trim() ? fromJobUrl(input.url) : {};
  const fromText = input.text?.trim() ? fromJobText(input.text) : {};
  const company = fromText.company || fromUrl.company;
  const role = fromText.role || fromUrl.role;
  const source = input.text?.trim() ? "the job description" : "the job link";
  const out: Suggestions<"title" | "counterparty"> = {};
  const title = planTitle(role, company);
  if (title) out.title = { value: title, source };
  if (company) out.counterparty = { value: company, source };
  return out;
}

// ── Plans and agendas: from a calendar invite ─────────────────────────────────

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|gmx|mail|yandex|zoho)\./i;

/** Who a meeting is with, as an organisation where email domains say so, else a name. */
export function counterpartyOf(ev: Pick<CalEvent, "organizer" | "attendees">): string | undefined {
  const others = [ev.organizer, ...(ev.attendees ?? [])].filter((p): p is Person => Boolean(p) && !p!.self);
  const orgs: string[] = [];
  for (const p of others) {
    const domain = p.email?.split("@")[1]?.toLowerCase();
    if (!domain || FREE_MAIL.test(domain)) continue;
    const parts = domain.split(".");
    const core = parts.length >= 3 && /^(co|com|org|ac|gov)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
    const name = core && humanize(core);
    if (name && !orgs.includes(name)) orgs.push(name);
  }
  if (orgs.length) return orgs.slice(0, 2).join(", ");
  const named = others.map(p => p.name?.trim()).filter(Boolean) as string[];
  return named.length ? named.slice(0, 2).join(", ") : undefined;
}

/**
 * The next meeting a new plan is probably for: the soonest one still to come
 * within `horizonH` hours (or running now) that has no plan yet.
 */
export function meetingForNewPlan<T extends Pick<CalEvent, "start" | "end" | "all_day" | "title" | "plan_id">>(
  events: T[] | null | undefined, now = Date.now(), horizonH = 12,
): T | null {
  const soon = (events ?? []).filter(ev => !ev.all_day && ev.plan_id == null && ev.title?.trim()
    && Date.parse(ev.end) > now && Date.parse(ev.start) - now <= horizonH * 3_600_000);
  soon.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return soon[0] ?? null;
}

export function planSuggestionsFromEvent(ev: Pick<CalEvent, "title" | "organizer" | "attendees">): Suggestions<"title" | "counterparty"> {
  const source = `your calendar: “${ev.title.trim()}”`;
  const out: Suggestions<"title" | "counterparty"> = { title: { value: ev.title.trim(), source } };
  const who = counterpartyOf(ev);
  if (who) out.counterparty = { value: who, source };
  return out;
}

/** The meeting-agenda boxes, from an invite: its description, and who is coming. */
export function agendaSuggestionsFromEvent(ev: Pick<CalEvent, "title" | "description" | "organizer" | "attendees">): Suggestions<"agenda" | "context"> {
  const source = `your calendar: “${ev.title.trim()}”`;
  const out: Suggestions<"agenda" | "context"> = {};
  const description = (ev.description ?? "").trim();
  const agenda = description.length >= 10 ? `${ev.title.trim()}\n\n${description}`.slice(0, 2000) : "";
  if (agenda) out.agenda = { value: agenda, source };
  const people = [ev.organizer, ...(ev.attendees ?? [])]
    .filter((p): p is Person => Boolean(p) && !p!.self)
    .map(p => p.name?.trim() || p.email?.split("@")[0] || "")
    .filter((n, i, all) => n && all.indexOf(n) === i);
  const org = counterpartyOf(ev);
  const bits = [people.length ? `Meeting with ${people.slice(0, 6).join(", ")}${people.length > 6 ? ` and ${people.length - 6} more` : ""}` : "",
    org && !people.includes(org) ? `(${org})` : ""].filter(Boolean);
  if (bits.length) out.context = { value: bits.join(" "), source };
  return out;
}

// ── Stories: tags from the text ───────────────────────────────────────────────

const TAG_WORDS: [string, RegExp][] = [
  ["leadership", /\b(led|lead|leading|leader(ship)?|managed|mentor(ed|ing)?|owned|took charge)\b/i],
  ["teamwork", /\b(team|teammates?|together|collaborat\w*|cross[- ]functional|group project)\b/i],
  ["conflict", /\b(conflict|disagree\w*|argument|tension|push(ed)? back|difficult (colleague|person|stakeholder))\b/i],
  ["deadline", /\b(deadline|due date|time pressure|last[- ]minute|urgent|two weeks|in time)\b/i],
  ["failure", /\b(fail(ed|ure)?|mistake|went wrong|lesson|setback|missed)\b/i],
  ["problem solving", /\b(bug|debug\w*|root cause|fix(ed)?|diagnos\w*|troubleshoot\w*|solved?)\b/i],
  ["customer", /\b(customers?|clients?|users?|patients?|stakeholders?)\b/i],
  ["data", /\b(data|analy(sis|tics|sed|zed)|metrics?|dashboard|sql|experiment)\b/i],
  ["communication", /\b(present(ed|ation)|explain(ed)?|wrote|writing|communicat\w*|persuad\w*|convinc\w*)\b/i],
  ["initiative", /\b(initiative|proactive\w*|volunteer\w*|on my own|started|proposed)\b/i],
  ["change", /\b(change|migrat\w*|transition|re-?organi[sz]\w*|adapt\w*)\b/i],
  ["impact", /\b(\d+\s?%|percent|saved|reduced|increased|grew|revenue|cost)\b/i],
];

/** Up to `max` tags the story's words point to, leaving out ones it already has. */
export function suggestTags(text: string, existing: string[] = [], max = 4): string[] {
  const have = new Set(existing.map(t => t.toLowerCase()));
  const hits: { tag: string; n: number }[] = [];
  for (const [tag, re] of TAG_WORDS) {
    if (have.has(tag)) continue;
    const n = (text.match(new RegExp(re.source, "gi")) ?? []).length;
    if (n) hits.push({ tag, n });
  }
  return hits.sort((a, b) => b.n - a.n).slice(0, max).map(h => h.tag);
}
