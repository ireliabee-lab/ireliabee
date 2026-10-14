import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { StatusChip, type Person } from "./PeopleView";

/**
 * Tick the researched people who'll be on this call (roadmap 2.6). The coach
 * gets their briefs and tailors every suggestion to them. Renders nothing
 * until at least one person has been researched.
 */
export default function PeoplePicker({ value, onChange, label = "People in this call" }: {
  value: number[];
  onChange: (ids: number[]) => void;
  label?: string;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    fetchApi("/people/").then(r => (r.ok ? r.json() : [])).then(setPeople).catch(() => setPeople([]));
  }, []);

  if (!people || people.length === 0) return null;
  return (
    <div className="people-picker">
      <div className="people-picker-head">
        <span className="settings-label" style={{ margin: 0 }}>{label}</span>
        <span className="muted">The coach tailors answers to them</span>
      </div>
      <div className="people-picker-list">
        {people.map(p => {
          const on = value.includes(p.id);
          return (
            <label key={p.id} className={on ? "on" : ""}>
              <input type="checkbox" checked={on}
                onChange={() => onChange(on ? value.filter(x => x !== p.id) : [...value, p.id])} />
              <span className="people-picker-name">
                <strong>{p.name}</strong>
                {p.organisation && <small>{p.organisation}</small>}
              </span>
              <StatusChip person={p} />
            </label>
          );
        })}
      </div>
    </div>
  );
}
