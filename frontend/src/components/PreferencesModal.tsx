import { useEffect } from "react";
import { X } from "lucide-react";
import { DISPLAY_OPTIONS, TRANSLATION_COST, translates } from "../lib/languages";
import GlassSelect from "./GlassSelect";
import PeoplePicker from "./PeoplePicker";
import { useAccount } from "../lib/account";
import { AiSuggest } from "./Suggested";
import { withSuggestion } from "../lib/suggestApi";
import "../session-prefs.css";

interface Option { id: string; label: string; }

export const RESPONSE_TONES: Option[] = [
  { id: "basic",    label: "Basic — plain, everyday language" },
  { id: "advanced", label: "Advanced — technical, expert depth" },
];
interface FileOption { id: number; label: string; }

interface Props {
  templates: Option[];
  models: Option[];
  languages: Option[];
  cvs: FileOption[];
  documents: FileOption[];
  template: string;
  model: string;
  language: string;
  /** What the user reads in ("" = same as spoken). */
  displayLanguage?: string;
  aiInstructions: string;
  responseTone: string;
  cvId: number | null;
  documentIds: number[];
  peopleIds: number[];
  onChange: (patch: Partial<{
    template: string; model: string; language: string; displayLanguage: string; aiInstructions: string;
    responseTone: string; cvId: number | null; documentIds: number[]; peopleIds: number[];
  }>) => void;
  onClose: () => void;
}

/**
 * A session's preferences: how the coach answers, what it knows, and any
 * instructions for this session. The header and footer stay put and only the
 * middle scrolls, so Done is always on screen however long the instructions get.
 * Every change applies as it is made; Done just closes.
 */
export default function PreferencesModal({
  templates, models, languages, cvs, documents,
  template, model, language, displayLanguage = "", aiInstructions, responseTone, cvId, documentIds, peopleIds,
  onChange, onClose,
}: Props) {
  const { admin } = useAccount();

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const ticked = documents.filter(d => documentIds.includes(d.id)).length;

  return (
    <div className="sp-backdrop" onClick={onClose}>
      <div className="sp-panel" role="dialog" aria-modal="true" aria-labelledby="sp-title" onClick={e => e.stopPropagation()}>
        <header className="sp-head">
          <div>
            <h2 id="sp-title">Session preferences</h2>
            <p>For this session only. Changes apply as you make them.</p>
          </div>
          <button className="sp-close" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </header>

        <div className="sp-body">
          <section className="sp-section">
            <h3>How the coach answers</h3>
            <div className="sp-grid">
              <Field label="Template">
                <GlassSelect options={templates} value={template} onChange={v => onChange({ template: v })} style={{ width: "100%" }} />
              </Field>
              <Field label="Language" hint="What the call is spoken in">
                <GlassSelect options={languages} value={language} onChange={v => onChange({ language: v })} style={{ width: "100%" }} />
              </Field>
              <Field label="Show me in" hint={translates(language, displayLanguage) ? `What you read. ${TRANSLATION_COST}` : "What you read: captions, cues, answers and notes"}>
                <GlassSelect options={DISPLAY_OPTIONS} value={displayLanguage} onChange={v => onChange({ displayLanguage: v })} style={{ width: "100%" }} />
              </Field>
              <Field label="Language level" hint="How technical the answers sound">
                <GlassSelect options={RESPONSE_TONES} value={responseTone} onChange={v => onChange({ responseTone: v })} style={{ width: "100%" }} />
              </Field>
              {/* The admin's alone (audit 180-H5). */}
              {admin && (
                <Field label="Model" hint="Coach model for this session">
                  <GlassSelect options={models} value={model} onChange={v => onChange({ model: v })} style={{ width: "100%" }} />
                </Field>
              )}
            </div>
          </section>

          <section className="sp-section">
            <h3>What the coach knows</h3>
            <Field label="CV" hint="Leave on your active CV unless this call needs another">
              <GlassSelect
                options={[{ id: "0", label: "Use my active CV" }, ...cvs.map(c => ({ id: String(c.id), label: c.label }))]}
                value={String(cvId ?? 0)}
                onChange={v => onChange({ cvId: v === "0" ? null : Number(v) })}
                style={{ width: "100%" }}
              />
            </Field>

            {documents.length > 0 && (
              <Field label="Documents" extra={<span className="sp-count">{ticked} of {documents.length} included</span>}>
                <div className="sp-docs">
                  {documents.map(d => {
                    const on = documentIds.includes(d.id);
                    return (
                      <label key={d.id} className={on ? "on" : ""}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => onChange({
                            documentIds: on ? documentIds.filter(x => x !== d.id) : [...documentIds, d.id],
                          })}
                        />
                        <span>{d.label}</span>
                      </label>
                    );
                  })}
                </div>
              </Field>
            )}

            <PeoplePicker value={peopleIds} onChange={ids => onChange({ peopleIds: ids })} />
          </section>

          <section className="sp-section">
            <h3>Instructions for this session</h3>
            <Field label="AI instructions" hint="Added to the coach's guidance for this session only" extra={
              <AiSuggest<string> field="session.ai_instructions" label="AI instructions for the coach"
                form={() => ({ template: templates.find(t => t.id === template)?.label ?? template, language, ai_instructions: aiInstructions })}
                onSuggest={text => onChange({ aiInstructions: withSuggestion(aiInstructions, text) })} />
            }>
              <textarea
                id="sp-instructions"
                className="glass-input sp-instructions"
                rows={6}
                placeholder="e.g. Keep answers under 40 seconds. Tie answers to the professor's recent work."
                value={aiInstructions}
                onChange={e => onChange({ aiInstructions: e.target.value })}
              />
              <span className="sp-count sp-chars">{aiInstructions.length.toLocaleString()} characters</span>
            </Field>
          </section>
        </div>

        <footer className="sp-foot">
          <button className="btn-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, extra, children }: { label: string; hint?: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="sp-field">
      <div className="sp-field-head">
        <label className="sp-label">{label}</label>
        {extra}
      </div>
      {hint && <span className="sp-hint">{hint}</span>}
      {children}
    </div>
  );
}
