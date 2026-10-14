import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Users, X, UserPlus, Loader2 } from "lucide-react";
import GlassSelect from "./GlassSelect";
import { StatusChip, initials, startResearch, type Person } from "./PeopleView";
import { fetchApi } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";

/**
 * "People in this meeting" on a plan (roadmap 2.6): link people you've
 * researched, or add and research someone new without leaving the plan.
 * Their briefs go to the live coach with the plan.
 */
export default function PlanPeople({ ids, onChange }: { ids: number[]; onChange: (ids: number[]) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchApi("/people/");
      if (res.ok) setPeople(await res.json());
    } catch { /* keep what we have */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const linked = ids.map(id => people.find(p => p.id === id)).filter((p): p is Person => !!p);
  const running = linked.some(p => p.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(load, 1500);
    return () => window.clearInterval(t);
  }, [running, load]);

  async function addNew() {
    if (!name.trim()) { toast.error("Add their name"); return; }
    setAdding(true);
    try {
      const res = await fetchApi("/people/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, organisation: org }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      const made: Person = await res.json();
      onChange([...ids, made.id]);
      setName(""); setOrg("");
      await startResearch(made.id);
      await load();
    } catch (e) { notifyError(e); }
    finally { setAdding(false); }
  }

  const others = people.filter(p => !ids.includes(p.id));

  return (
    <section className="glass-card plan-people">
      <div className="plan-people-head">
        <Users size={15} />
        <div>
          <div className="plan-section-title">People in this meeting</div>
          <p className="muted">Researched briefs go to the coach: what they care about, common ground, likely questions.</p>
        </div>
      </div>

      {linked.length > 0 && (
        <ul className="plan-people-list">
          {linked.map(p => (
            <li key={p.id}>
              <span className="person-avatar">{initials(p.name)}</span>
              <button className="plan-people-name" title="Open their brief"
                onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "people" }))}>
                <strong>{p.name}</strong>
                <StatusChip person={p} />
              </button>
              <button className="icon-btn" onClick={() => onChange(ids.filter(i => i !== p.id))} title="Remove from this plan"><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <GlassSelect
          style={{ width: "100%" }}
          value=""
          placeholder="Add someone you've researched…"
          onChange={id => id && onChange([...ids, Number(id)])}
          options={others.map(p => ({ id: String(p.id), label: [p.name, p.organisation].filter(Boolean).join(" — ") }))}
        />
      )}

      <div className="plan-people-add">
        <input className="glass-input" value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
        <input className="glass-input" value={org} onChange={e => setOrg(e.target.value)} placeholder="Organisation"
          onKeyDown={e => { if (e.key === "Enter") addNew(); }} />
        <button className="btn-neutral" onClick={addNew} disabled={adding} title="Add to this plan and research them">
          {adding ? <Loader2 size={13} className="spin" /> : <UserPlus size={13} />} Add and research
        </button>
      </div>
    </section>
  );
}
