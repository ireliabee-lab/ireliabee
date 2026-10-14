import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { DISPLAY_OPTIONS, TRANSLATION_COST, translates } from "../lib/languages";
import GlassSelect from "./GlassSelect";
import PeoplePicker from "./PeoplePicker";
import { RESPONSE_TONES } from "./PreferencesModal";
import { useAccount } from "../lib/account";
import { fetchApi } from "../lib/api";
import type { CalEvent } from "../lib/calendar";
import { sessionSuggestions, type PlanLike, type ProfileLike } from "../lib/prefill";
import { AiSuggest, SuggestedChip, usePrefill } from "./Suggested";
import { withSuggestion } from "../lib/suggestApi";

interface Option { id: string; label: string; }
interface FileOption { id: number; label: string; }

export interface SessionDraft {
  title: string;
  subtitle: string;
  tags: string[];
  cvId: number | null;
  documentIds: number[];
  peopleIds: number[];
  template: string;
  model: string;
  language: string;
  /** What the user reads in, when it differs from the call ("" = same as spoken). */
  displayLanguage?: string;
  aiInstructions: string;
  responseTone: string;
  /** Auto Answer for what they say. */
  autoAnswer: boolean;
  /** Auto Answer for what you say; the same as theirs when not given. */
  autoAnswerYou?: boolean;
}

interface Props {
  templates: Option[];
  models: Option[];
  languages: Option[];
  cvs: FileOption[];
  documents: FileOption[];
  defaults: SessionDraft;
  /** The plan this session opens with, if one is known (a meeting's, or "Use in session"). */
  planId?: number | null;
  onSubmit: (draft: SessionDraft) => void;
  onCancel: () => void;
}

export default function CreateSessionWizard({
  templates, models, languages, cvs, documents, defaults, planId, onSubmit, onCancel,
}: Props) {
  const { admin } = useAccount();
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<SessionDraft>(defaults);
  const patch = (p: Partial<SessionDraft>) => setDraft(d => ({ ...d, ...p }));

  // Free suggestions from what the app already knows (lib/prefill.ts): the
  // meeting on now or next, the plan, the active profile's role. Only empty
  // boxes are filled, and typing in one makes it yours.
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [profiles, setProfiles] = useState<ProfileLike[]>([]);
  const [plan, setPlan] = useState<(PlanLike & { purpose?: string }) | null>(null);
  useEffect(() => {
    let alive = true;
    fetchApi("/profiles/").then(r => (r.ok ? r.json() : [])).then(p => alive && setProfiles(p)).catch(() => {});
    if (!defaults.title) {
      fetchApi("/calendar/events?days=1").then(r => (r.ok ? r.json() : [])).then(e => alive && setEvents(Array.isArray(e) ? e : [])).catch(() => {});
    }
    const pid = planId ?? localStorage.getItem("activePlanId");
    if (pid) fetchApi(`/plans/${pid}`).then(r => (r.ok ? r.json() : null)).then(p => alive && p && setPlan(p)).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const prefill = usePrefill(draft, setDraft, sessionSuggestions({ events, profiles, plan }));
  const chip = (field: "title" | "subtitle") => prefill.isSuggested(field)
    ? <SuggestedChip source={prefill.sourceOf(field)} onClear={() => prefill.clear(field)} /> : null;
  // What the paid Suggest reads: this form (lib/suggestApi.ts). Never a name or contact detail.
  const suggestForm = () => ({
    title: draft.title, subtitle: draft.subtitle, ai_instructions: draft.aiInstructions,
    template: templates.find(t => t.id === draft.template)?.label ?? draft.template,
    language: languages.find(l => l.id === draft.language)?.label ?? draft.language,
    plan: plan ? [plan.title, plan.counterparty, plan.purpose].filter(Boolean).join(" — ") : "",
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel]);

  const canNext = step === 1 && draft.title.trim().length > 0;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 620,
          maxWidth: "calc(94 * var(--vw))",
          background: "rgba(var(--base-rgb), 0.98)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          borderRadius: 14,
          padding: "22px 24px 18px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          display: "flex", gap: 20,
        }}
      >
        {/* Left rail: stepper */}
        <div style={{ width: 130, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
            Create Session
          </div>
          <p className="muted" style={{ fontSize: 11, lineHeight: 1.45, marginTop: 0, marginBottom: 16 }}>
            Enter details & select what you need for this call.
          </p>
          <Stepper active={step} />
        </div>

        {/* Right: form. min-width 0, or a long line inside (a person's
            organisation, a document name) widens the column past the card. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {step === 1 ? "Details" : "Preferences"}
            </div>
            <button onClick={onCancel} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4, display: "flex" }} title="Close">
              <X size={15} />
            </button>
          </div>

          {step === 1 ? (
            <>
              <Field label="Title *" extra={<>{chip("title")}
                <AiSuggest<string> field="session.title" label="Session title" value={draft.title} form={suggestForm}
                  onSuggest={text => setDraft(d => (d.title.trim() ? d : { ...d, title: text }))} /></>}>
                <input
                  className={`glass-input${prefill.isSuggested("title") ? " is-suggested" : ""}`}
                  autoFocus
                  placeholder="e.g. Google SWE Onsite"
                  value={draft.title}
                  onChange={e => patch({ title: e.target.value })}
                />
              </Field>
              <Field label="Role / Subtitle" hint="Shown under the title on the card" extra={<>{chip("subtitle")}
                <AiSuggest<string> field="session.subtitle" label="Role or subtitle" value={draft.subtitle} form={suggestForm}
                  onSuggest={text => setDraft(d => (d.subtitle.trim() ? d : { ...d, subtitle: text }))} /></>}>
                <input
                  className={`glass-input${prefill.isSuggested("subtitle") ? " is-suggested" : ""}`}
                  placeholder="Senior Python Engineer"
                  value={draft.subtitle}
                  onChange={e => patch({ subtitle: e.target.value })}
                />
              </Field>
              <Field label="CV / Resume">
                <GlassSelect
                  options={[{ id: "0", label: "— use active CV —" }, ...cvs.map(c => ({ id: String(c.id), label: c.label }))]}
                  value={String(draft.cvId ?? 0)}
                  onChange={v => patch({ cvId: v === "0" ? null : Number(v) })}
                  style={{ width: "100%" }}
                />
              </Field>
              {documents.length > 0 && (
                <Field label="Reference Documents" hint="Tick documents to include as context">
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 110, overflowY: "auto" }}>
                    {documents.map(d => {
                      const on = draft.documentIds.includes(d.id);
                      return (
                        <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 4, cursor: "pointer", background: on ? "rgba(var(--accent-rgb),0.10)" : "transparent" }}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => patch({
                              documentIds: on ? draft.documentIds.filter(x => x !== d.id) : [...draft.documentIds, d.id],
                            })}
                          />
                          <span style={{ fontSize: 12, color: on ? "var(--text)" : "var(--muted)" }}>{d.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </Field>
              )}
              <PeoplePicker value={draft.peopleIds ?? []} onChange={ids => patch({ peopleIds: ids })} />
            </>
          ) : (
            <>
              <Field label="Template">
                <GlassSelect options={templates} value={draft.template} onChange={v => patch({ template: v })} style={{ width: "100%" }} />
              </Field>
              {/* The admin's alone: everyone else is served whatever the
                  backoffice chose, so a picker would be a control that does
                  nothing, naming providers they never deal with (audit 180-H5). */}
              {admin && (
                <Field label="Model">
                  <GlassSelect options={models} value={draft.model} onChange={v => patch({ model: v })} style={{ width: "100%" }} />
                </Field>
              )}
              <Field label="Language" hint="What the call is spoken in. Transcripts follow it, and so does the coach unless Show me in says otherwise.">
                <GlassSelect options={languages} value={draft.language} onChange={v => patch({ language: v })} style={{ width: "100%" }} />
              </Field>
              <Field label="Show me in" hint={translates(draft.language, draft.displayLanguage)
                ? `What you read: captions, cues, answers, the debrief and notes. ${TRANSLATION_COST}`
                : "What you read: captions, cues, answers, the debrief and notes."}>
                <GlassSelect options={DISPLAY_OPTIONS} value={draft.displayLanguage ?? ""} onChange={v => patch({ displayLanguage: v })} style={{ width: "100%" }} />
              </Field>
              <Field label="Language level" hint="How technical the suggested answers sound.">
                <GlassSelect options={RESPONSE_TONES} value={draft.responseTone} onChange={v => patch({ responseTone: v })} style={{ width: "100%" }} />
              </Field>
              <Field label="AI Instructions" hint="Extra guidance for this session only." extra={
                <AiSuggest<string>
                  field="session.ai_instructions"
                  ready={Boolean(draft.title.trim())}
                  notReadyHint="Give the session a title first"
                  form={suggestForm}
                  label="AI instructions for the coach"
                  // Never replaces what was typed: a suggestion goes under it.
                  onSuggest={text => patch({ aiInstructions: withSuggestion(draft.aiInstructions, text) })}
                />
              }>
                <textarea
                  className="glass-input"
                  rows={3}
                  placeholder="e.g. Prefer short SAY responses under 60s."
                  value={draft.aiInstructions}
                  onChange={e => patch({ aiInstructions: e.target.value })}
                  style={{ resize: "vertical" }}
                />
              </Field>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
                <input type="checkbox" checked={draft.autoAnswer} onChange={e => patch({ autoAnswer: e.target.checked })} />
                Auto Answer them — the coach answers what they say as soon as they finish
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
                <input type="checkbox" checked={draft.autoAnswerYou ?? draft.autoAnswer} onChange={e => patch({ autoAnswerYou: e.target.checked })} />
                Auto Answer you — the coach answers what you say as soon as you finish
              </label>
            </>
          )}

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
            <button
              className="btn-neutral"
              style={{ padding: "8px 16px" }}
              onClick={step === 1 ? onCancel : () => setStep(1)}
            >
              {step === 1 ? "Cancel" : "Back"}
            </button>
            {step === 1 ? (
              <button
                className="btn-primary"
                style={{ padding: "8px 18px", opacity: canNext ? 1 : 0.5, pointerEvents: canNext ? "auto" : "none" }}
                onClick={() => canNext && setStep(2)}
              >
                Next
              </button>
            ) : (
              <button className="btn-primary" style={{ padding: "8px 20px" }} onClick={() => onSubmit(draft)}>
                Start Session
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function Stepper({ active }: { active: 1 | 2 }) {
  const items = [
    { n: 1, label: "Details" },
    { n: 2, label: "Preferences" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(it => (
        <div key={it.n} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 20, height: 20, borderRadius: "50%",
            background: active === it.n ? "var(--primary)" : "rgba(var(--ink-rgb),0.08)",
            color: active === it.n ? "#fff" : "var(--muted)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 700,
          }}>{it.n}</div>
          <span style={{ fontSize: 12, color: active === it.n ? "var(--text)" : "var(--muted)", fontWeight: active === it.n ? 600 : 500 }}>
            {it.label}
          </span>
        </div>
      ))}
    </div>
  );
}


function Field({ label, hint, extra, children }: { label: string; hint?: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="label-row" style={{ marginBottom: 0 }}>
        <label className="settings-label" style={{ marginBottom: 0 }}>{label}</label>
        {extra}
      </div>
      {hint && <span style={{ fontSize: 10, color: "var(--muted)", opacity: 0.7 }}>{hint}</span>}
      {children}
    </div>
  );
}
