import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { User, BookMarked, FileText, Plus, Trash2, Loader2, ArrowRight, Users } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";
import GlassSelect from "./GlassSelect";
import { AiSuggest, SuggestLabel } from "./Suggested";
import { withSuggestion } from "../lib/suggestApi";
import StoriesView from "./StoriesView";
import { fetchApi } from "../lib/api";
import { track } from "../lib/usage";
import Page, { PageTab } from "./Page";

interface Profile {
  id: number;
  name: string;
  pronouns?: string;
  background?: string;
  target_role?: string;
  strengths?: string;
  weaknesses?: string;
  extra_context?: string;
  experience_level?: string;
  hard_question?: string;
  is_active?: number;
  cv_id?: number | null;
}
interface Cv { id: number; name: string; is_active?: number | boolean; }

const EMPTY_FORM = {
  name: "", pronouns: "", background: "", target_role: "",
  strengths: "", weaknesses: "", extra_context: "", experience_level: "", hard_question: "",
};
type Form = typeof EMPTY_FORM;

const EXPERIENCE_LEVELS = [
  { id: "",        label: "Not set — coach infers from background" },
  { id: "student", label: "Student / new graduate" },
  { id: "junior",  label: "Junior (0–2 years)" },
  { id: "mid",     label: "Mid-level (2–5 years)" },
  { id: "senior",  label: "Senior (5–10 years)" },
  { id: "lead",    label: "Lead / staff / principal (10+ years)" },
];

const toForm = (p: Profile): Form => ({
  name: p.name ?? "", pronouns: p.pronouns ?? "", background: p.background ?? "",
  target_role: p.target_role ?? "", strengths: p.strengths ?? "", weaknesses: p.weaknesses ?? "",
  extra_context: p.extra_context ?? "", experience_level: p.experience_level ?? "",
  hard_question: p.hard_question ?? "",
});

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchApi(path, init);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
const send = (method: string, body?: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

type Tab = "profile" | "stories";

/**
 * Who you are, in one place (roadmap 1.6): the profile the coach speaks from,
 * the CV it uses, and your story bank. Multiple profiles live behind a
 * "Switch profile" control — most people have one.
 */
export default function AboutYouView({ section }: { section?: string }) {
  const [tab, setTab] = useState<Tab>(section === "stories" ? "stories" : "profile");
  useEffect(() => { track(`about.${tab}`); }, [tab]);

  return (
    <Page
      title="About you"
      subtitle="Who the coach speaks as: your profile, the CV it draws on, and the stories you can tell."
      tabs={<>
        <PageTab active={tab === "profile"} icon={<User size={14} />} onClick={() => setTab("profile")}>Profile &amp; CV</PageTab>
        <PageTab active={tab === "stories"} icon={<BookMarked size={14} />} onClick={() => setTab("stories")}>Stories</PageTab>
      </>}
    >
      {tab === "profile" ? <ProfilePanel /> : <StoriesView />}
    </Page>
  );
}

function ProfilePanel() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [cvs, setCvs] = useState<Cv[]>([]);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const active = useMemo(() => profiles?.find(p => p.is_active === 1) ?? profiles?.[0] ?? null, [profiles]);
  const editing = creating ? null : active;
  const dirty = editing ? JSON.stringify(toForm(editing)) !== JSON.stringify(form) : creating;
  const activeCv = cvs.find(c => !!c.is_active) ?? null;

  async function load() {
    try {
      const [ps, cs] = await Promise.all([json<Profile[]>("/profiles/"), json<Cv[]>("/cvs/").catch(() => [])]);
      setProfiles(ps);
      setCvs(cs);
      const current = ps.find(p => p.is_active === 1) ?? ps[0];
      setForm(current ? toForm(current) : EMPTY_FORM);
      setCreating(ps.length === 0);
    } catch {
      setProfiles([]);
      toast.error("Couldn't load your profile");
    }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    if (!form.name.trim()) { toast.error("Your name is required"); return; }
    setSaving(true);
    try {
      if (editing) {
        await json(`/profiles/${editing.id}`, send("PUT", form));
        toast.success("Profile saved");
      } else {
        const made = await json<Profile>("/profiles/", send("POST", form));
        await json(`/profiles/${made.id}/activate`, send("POST"));
        toast.success("Profile created");
      }
      window.dispatchEvent(new Event("onboarding-refresh"));
      await load();
    } catch {
      toast.error("Couldn't save the profile");
    } finally {
      setSaving(false);
    }
  }

  async function switchTo(id: string) {
    if (id === "new") { setCreating(true); setForm(EMPTY_FORM); return; }
    try {
      const out = await json<{ active_cv_id: number | null }>(`/profiles/${id}/activate`, send("POST"));
      toast.success(out.active_cv_id ? "Switched profile and its CV" : "Switched profile");
      await load();
    } catch { toast.error("Couldn't switch profile"); }
  }

  async function remove() {
    if (!editing) return;
    setConfirmDelete(false);
    try {
      await json(`/profiles/${editing.id}`, send("DELETE"));
      const rest = (profiles ?? []).filter(p => p.id !== editing.id);
      if (rest.length) await json(`/profiles/${rest[0].id}/activate`, send("POST"));
      toast.success("Profile deleted");
      await load();
    } catch { toast.error("Couldn't delete the profile"); }
  }

  async function linkCv(id: string) {
    if (!editing) return;
    const cvId = Number(id);
    try {
      await json(`/profiles/${editing.id}`, send("PUT", { cv_id: cvId }));
      if (cvId) await json(`/cvs/${cvId}/activate`, send("POST"));
      toast.success(cvId ? "This profile now uses that CV" : "CV unlinked from this profile");
      await load();
    } catch { toast.error("Couldn't change the CV"); }
  }

  if (profiles == null) return <div className="page-content progress-loading"><Loader2 size={18} className="spin" /></div>;

  return (
    <div className="page-content">
    <div className="page-split about-split">
      <section className="glass-card about-card">
        <header>
          <User size={15} />
          <div>
            <div className="plan-section-title">{creating ? (profiles.length ? "New profile" : "Tell the coach about you") : "Your profile"}</div>
            <p className="muted">The coach speaks as this person and never claims more than it says here.</p>
          </div>
        </header>
        <ProfileForm form={form} onChange={setForm} />
        <div className="about-actions">
          {editing && profiles.length > 0 && (
            <button className="btn-neutral danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete profile</button>
          )}
          <button className="btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 size={14} className="spin" /> : creating ? <Plus size={14} /> : null}
            {creating ? "Create profile" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </section>

      <aside className="page-side">
      {profiles.length > 0 && (
        <section className="glass-card about-card">
          <header>
            <Users size={15} />
            <div>
              <div className="plan-section-title">Profile in use</div>
              <p className="muted">Keep one per role or audience — a job hunt, a thesis defence, a sales role.</p>
            </div>
          </header>
          <GlassSelect
            style={{ width: "100%" }}
            value={creating ? "new" : String(active?.id ?? "")}
            onChange={switchTo}
            options={[
              ...profiles.map(p => ({ id: String(p.id), label: `${p.name}${p.target_role ? ` — ${p.target_role}` : ""}` })),
              { id: "new", label: "+ New profile…" },
            ]}
          />
          {creating && <button className="btn-neutral about-cancel" onClick={() => { setCreating(false); setForm(active ? toForm(active) : EMPTY_FORM); }}>Cancel new profile</button>}
        </section>
      )}

      {editing && (
        <section className="glass-card about-card">
          <header>
            <FileText size={15} />
            <div>
              <div className="plan-section-title">Your CV</div>
              <p className="muted">The coach uses this CV's real projects and results. Link one to this profile and switching profile switches CV too.</p>
            </div>
          </header>
          {cvs.length === 0 ? (
            <div className="about-empty-cv">
              <span className="muted">No CV uploaded yet.</span>
              <button className="btn-primary" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "library" }))}>
                Upload your CV <ArrowRight size={13} />
              </button>
            </div>
          ) : (
            <div className="about-cv-row">
              <GlassSelect
                style={{ width: "100%" }}
                value={String(editing.cv_id ?? 0)}
                onChange={linkCv}
                options={[
                  { id: "0", label: activeCv ? `Not linked — currently using "${activeCv.name}"` : "Not linked" },
                  ...cvs.map(c => ({ id: String(c.id), label: c.name })),
                ]}
              />
              <button className="btn-neutral" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "library" }))}>
                Open Library <ArrowRight size={13} />
              </button>
            </div>
          )}
        </section>
      )}

      <section className="glass-card about-card about-stories-link">
        <header>
          <BookMarked size={15} />
          <div>
            <div className="plan-section-title">Your stories</div>
            <p className="muted">Real examples the coach can suggest in answers — a hard bug, a conflict, a win.</p>
          </div>
        </header>
        <button className="btn-neutral" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "stories" }))}>
          Open stories <ArrowRight size={13} />
        </button>
      </section>
      </aside>
    </div>

      {confirmDelete && editing && (
        <ConfirmDialog
          message={`Delete "${editing.name}"?`}
          detail="This profile will be permanently removed."
          confirmLabel="Delete"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function ProfileForm({ form, onChange }: { form: Form; onChange: (f: Form) => void }) {
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...form, [key]: e.target.value });
  // What the paid Suggest reads: the profile without the name or pronouns (lib/suggestApi.ts).
  const suggestForm = () => {
    const { name: _name, pronouns: _pronouns, ...rest } = form as Form & { name?: string; pronouns?: string };
    return rest as Record<string, unknown>;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="about-row">
        <div style={{ flex: 2 }}>
          <label className="settings-label">Name *</label>
          <input className="glass-input" value={form.name} onChange={set("name")} placeholder="Your full name" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="settings-label">Pronouns</label>
          <input className="glass-input" value={form.pronouns} onChange={set("pronouns")} placeholder="they/them" />
        </div>
      </div>
      <div className="about-row">
        <div style={{ flex: 1 }}>
          <SuggestLabel label="Target role">
            <AiSuggest<string> field="profile.target_role" label="Target role" value={form.target_role} form={suggestForm}
              onSuggest={text => onChange(form.target_role.trim() ? form : { ...form, target_role: text })} />
          </SuggestLabel>
          <input className="glass-input" value={form.target_role} onChange={set("target_role")} placeholder="Software Engineer" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="settings-label">Experience level</label>
          <GlassSelect options={EXPERIENCE_LEVELS} value={form.experience_level}
            onChange={v => onChange({ ...form, experience_level: v })} style={{ width: "100%" }} />
        </div>
      </div>
      <div>
        <SuggestLabel label="Background">
            <AiSuggest<string> field="profile.background" label="Professional background" length="long" form={suggestForm}
              onSuggest={text => onChange({ ...form, background: withSuggestion(form.background, text) })} />
          </SuggestLabel>
        <textarea className="glass-input" rows={3} value={form.background} onChange={set("background")} placeholder="Brief professional background…" style={{ resize: "vertical" }} />
      </div>
      <div className="about-row">
        <div style={{ flex: 1 }}>
          <SuggestLabel label="Strengths">
            <AiSuggest<string> field="profile.strengths" label="Strengths" length="long" form={suggestForm}
              onSuggest={text => onChange({ ...form, strengths: withSuggestion(form.strengths, text) })} />
          </SuggestLabel>
          <textarea className="glass-input" rows={2} value={form.strengths} onChange={set("strengths")} placeholder="Key strengths…" style={{ resize: "vertical" }} />
        </div>
        <div style={{ flex: 1 }}>
          <SuggestLabel label="Weaknesses">
            <AiSuggest<string> field="profile.weaknesses" label="Areas to improve" length="long" form={suggestForm}
              onSuggest={text => onChange({ ...form, weaknesses: withSuggestion(form.weaknesses, text) })} />
          </SuggestLabel>
          <textarea className="glass-input" rows={2} value={form.weaknesses} onChange={set("weaknesses")} placeholder="Areas to improve…" style={{ resize: "vertical" }} />
        </div>
      </div>
      <div>
        <SuggestLabel label="Extra context">
            <AiSuggest<string> field="profile.extra_context" label="Anything else the coach should know" length="long" form={suggestForm}
              onSuggest={text => onChange({ ...form, extra_context: withSuggestion(form.extra_context, text) })} />
          </SuggestLabel>
        <textarea className="glass-input" rows={2} value={form.extra_context} onChange={set("extra_context")} placeholder="Anything else the coach should know…" style={{ resize: "vertical" }} />
      </div>
      <div>
        <SuggestLabel label="The question you're dreading">
            <AiSuggest<string> field="profile.hard_question" label="The question you dread being asked" length="long" form={suggestForm}
              onSuggest={text => onChange({ ...form, hard_question: withSuggestion(form.hard_question, text) })} />
          </SuggestLabel>
        <textarea className="glass-input" rows={2} value={form.hard_question} onChange={set("hard_question")}
          placeholder="The thing you hope they don't ask — a grade, a gap between jobs, why you left…"
          style={{ resize: "vertical" }} />
        <span className="muted about-hint">
          Naming it lets Practice put it to you on purpose, so you answer it once here instead of
          bracing for it there. It never goes to the live coach unprompted.
        </span>
      </div>
    </div>
  );
}
