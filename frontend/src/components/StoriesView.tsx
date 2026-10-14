import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, ArrowLeft, Sparkles, Loader2, Trash2, X, Lock } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import Illustration from "./Illustration";
import { suggestTags } from "../lib/prefill";
import { AiSuggest, SuggestLabel } from "./Suggested";
import { withSuggestion } from "../lib/suggestApi";

interface Story {
  id?: number;
  title: string;
  tags: string[];
  is_private?: boolean;
  situation: string;
  task: string;
  action: string;
  result: string;
}

const EMPTY: Story = { title: "", tags: [], situation: "", task: "", action: "", result: "", is_private: false };

const STAR: { key: keyof Story; letter: string; label: string; hint: string; rows: number }[] = [
  { key: "situation", letter: "S", label: "Situation", hint: "Where were you and what was going on?", rows: 3 },
  { key: "task", letter: "T", label: "Task", hint: "What did you need to achieve?", rows: 2 },
  { key: "action", letter: "A", label: "Action", hint: "What did you personally do, step by step?", rows: 4 },
  { key: "result", letter: "R", label: "Result", hint: "What changed? Numbers help. What did you learn?", rows: 3 },
];

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetchApi(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

export default function StoriesView() {
  const [stories, setStories] = useState<Story[]>([]);
  const [editing, setEditing] = useState<Story | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Story | null>(null);

  const load = () => api("/stories/").then(setStories).catch(notifyError);
  useEffect(() => { load(); }, []);

  async function remove(story: Story) {
    try {
      await api(`/stories/${story.id}`, "DELETE");
      toast.success("Story deleted");
      setEditing(null);
      load();
    } catch (e) {
      notifyError(e);
    }
    setConfirmDelete(null);
  }

  return (
    <>
      {editing ? (
        <StoryEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => setConfirmDelete(editing)}
          onSaved={s => { setEditing(null); load(); toast.success(`Saved "${s.title}"`); }}
        />
      ) : (
        <div className="plans-page">
          <div className="plans-header">
            <div>
              <h2>Your Stories</h2>
              <p className="muted">Your best real experiences. The coach builds answers on them when a question fits.</p>
            </div>
            <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={14} /> New story</button>
          </div>

          {stories.length === 0 ? (
            <div className="glass-card plans-empty">
              <Illustration name="stories" />
              <div className="plans-empty-title">No stories yet</div>
              <p className="muted">Save 5–8 stories about conflict, a failure, a tough deadline, leading something and a problem you solved. Jot rough notes and the AI shapes them into STAR form.</p>
              <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Sparkles size={14} /> Write your first story</button>
            </div>
          ) : (
            <div className="plans-grid">
              {stories.map(s => (
                <article key={s.id} className="glass-card plan-card story-card" onClick={() => setEditing(s)}>
                  <div className="plan-card-title">
                    {s.is_private && <Lock size={12} className="story-private-mark" aria-label="Private — never exported" />}
                    {s.title}
                  </div>
                  {s.tags.length > 0 && (
                    <div className="story-tags">{s.tags.map(t => <span key={t}>{t}</span>)}</div>
                  )}
                  {s.result && <p className="plan-card-purpose"><strong>Result:</strong> {s.result}</p>}
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={`Delete "${confirmDelete.title}"?`}
          detail="The coach will stop using this story."
          confirmLabel="Delete"
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}

function StoryEditor({ initial, onCancel, onDelete, onSaved }: {
  initial: Story; onCancel: () => void; onDelete: () => void; onSaved: (s: Story) => void;
}) {
  const [story, setStory] = useState<Story>(initial);
  const [notes, setNotes] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const isNew = story.id == null;

  const set = <K extends keyof Story>(key: K, value: Story[K]) => setStory(s => ({ ...s, [key]: value }));

  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase().replace(/,$/, "");
    if (tag && !story.tags.includes(tag)) set("tags", [...story.tags, tag]);
    setTagInput("");
  }

  async function draft() {
    if (notes.trim().length < 40) { toast("Write a few sentences about what happened first", { icon: "✍️" }); return; }
    if (!(await ensureReady(["llm"]))) return;
    setDrafting(true);
    try {
      const d = await api("/stories/draft", "POST", { notes });
      setStory(s => ({ ...s, ...d, id: s.id }));
      toast.success("Story drafted — fill in any [brackets], then save");
    } catch (e) {
      notifyError(e);
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    if (!story.title.trim()) { toast.error("Give the story a title"); return; }
    setSaving(true);
    try {
      const saved = isNew ? await api("/stories/", "POST", story) : await api(`/stories/${story.id}`, "PUT", story);
      onSaved(saved);
    } catch (e) {
      notifyError(e);
    } finally {
      setSaving(false);
    }
  }

  // What the paid Suggest reads: this story (lib/suggestApi.ts).
  const storyForm = () => ({
    title: story.title, situation: story.situation, task: story.task, action: story.action,
    result: story.result, tags: story.tags,
  });
  const tagIdeas = suggestTags(
    [story.title, story.situation, story.task, story.action, story.result].filter(Boolean).join("\n"), story.tags);
  const hasPlaceholders = STAR.some(f => /\[[^\]]+\]/.test(String(story[f.key])));

  return (
    <div className="plans-page">
      <div className="plans-header">
        <button className="btn-neutral plan-back" onClick={onCancel}><ArrowLeft size={14} /> Your Stories</button>
        <div style={{ display: "flex", gap: 8 }}>
          {!isNew && <button className="btn-neutral danger" onClick={onDelete} title="Delete story"><Trash2 size={13} /></button>}
          <button className="btn-neutral" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Loader2 size={14} className="spin" />} {isNew ? "Save story" : "Save changes"}
          </button>
        </div>
      </div>

      <section className="glass-card plan-import">
        <div className="plan-import-head">
          <Sparkles size={16} />
          <div>
            <div className="plan-section-title">Draft from rough notes</div>
            <p className="muted">Just write what happened. The AI only uses what you wrote and marks gaps like [how many users?].</p>
          </div>
        </div>
        <textarea
          className="glass-input" rows={4} value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g. our group project for a hospital booking app — two teammates stopped replying two weeks before the deadline, so I…"
          style={{ resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn-primary" onClick={draft} disabled={drafting}>
            {drafting ? <><Loader2 size={14} className="spin" /> Writing…</> : <><Sparkles size={14} /> Draft STAR story</>}
          </button>
        </div>
      </section>

      <section className={`glass-card plan-form ${drafting ? "is-loading" : ""}`}>
        <div>
          <SuggestLabel label="Title *">
            <AiSuggest<string> field="story.title" label="Story title" value={story.title} form={storyForm}
              onSuggest={text => setStory(s => (s.title.trim() ? s : { ...s, title: text }))} />
          </SuggestLabel>
          <input className="glass-input" value={story.title} onChange={e => set("title", e.target.value)} placeholder="Rescued a group project two weeks from deadline" />
        </div>
        <label className={`transfer-row ${story.is_private ? "on" : ""}`} style={{ marginTop: 2 }}>
          <input type="checkbox" checked={!!story.is_private}
                 onChange={e => set("is_private", e.target.checked)} />
          <span className="transfer-row-body">
            <span className="transfer-row-title"><Lock size={12} /> Keep this story private</span>
            <span className="muted transfer-row-hint">
              It still coaches you in practice and live sessions, but it is never written to a
              transfer file when you export your data.
            </span>
          </span>
        </label>

        <div>
          <label className="settings-label">Questions it answers</label>
          <div className="tag-input">
            {story.tags.map(t => (
              <span key={t} className="tag-chip">{t}<button onClick={() => set("tags", story.tags.filter(x => x !== t))}><X size={10} /></button></span>
            ))}
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagInput); }
                if (e.key === "Backspace" && !tagInput && story.tags.length) set("tags", story.tags.slice(0, -1));
              }}
              onBlur={() => tagInput && addTag(tagInput)}
              placeholder={story.tags.length ? "" : "conflict, leadership, deadline…"}
            />
          </div>
          {/* Free suggestions from the story's own words (lib/prefill.ts): no AI, added only when clicked. */}
          {tagIdeas.length > 0 && (
            <div className="tag-suggestions">
              <span>From your story:</span>
              {tagIdeas.map(t => (
                <button key={t} type="button" onClick={() => addTag(t)} title={`Add “${t}”`}>+ {t}</button>
              ))}
            </div>
          )}
        </div>

        {hasPlaceholders && (
          <div className="story-gap-note">Fill in the parts in [brackets] with your real details before using this story.</div>
        )}

        {STAR.map(f => (
          <div key={f.key} className="star-row">
            <span className={`star-letter ${f.key}`}>{f.letter}</span>
            <div style={{ flex: 1 }}>
              <SuggestLabel label={f.label}>
                <AiSuggest<string> field={`story.${f.key}`} label={`${f.label}: ${f.hint}`} length="long" form={storyForm}
                  onSuggest={text => setStory(s => ({ ...s, [f.key]: withSuggestion(String(s[f.key] ?? ""), text) }))} />
              </SuggestLabel>
              <textarea
                className="glass-input" rows={f.rows}
                value={String(story[f.key])}
                onChange={e => set(f.key, e.target.value as never)}
                placeholder={f.hint}
                style={{ resize: "vertical" }}
              />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
