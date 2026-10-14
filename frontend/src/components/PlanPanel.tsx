import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import GlassSelect from "./GlassSelect";
import { fetchApi } from "../lib/api";

interface Props {
  plan: any;
  onSelect: (plan: any) => void;
  sectionIdx: number;
  onSectionChange: (i: number) => void;
}

export default function PlanPanel({ plan, onSelect, sectionIdx, onSectionChange }: Props) {
  const [plans, setPlans] = useState<any[]>([]);

  useEffect(() => {
    fetchApi("/plans/").then(r => r.json()).then(setPlans).catch(() => {});
  }, []);

  const sections = plan?.sections ?? [];
  const planOptions = [
    { id: "", label: "— no plan —" },
    ...plans.map(p => ({ id: String(p.id), label: p.title })),
  ];

  return (
    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 16, fontSize: 13 }}>

      {/* Plan picker */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 8 }}>
          Meeting Plan
        </div>
        <GlassSelect
          options={planOptions}
          value={plan ? String(plan.id) : ""}
          onChange={id => {
            const p = plans.find(p => String(p.id) === id);
            onSelect(p ?? null);
          }}
          style={{ width: "100%" }}
        />
      </div>

      {plan && (
        <>
          {plan.counterparty && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>
                Counterparty
              </div>
              <p style={{ fontSize: 12, color: "var(--text)" }}>{plan.counterparty}</p>
            </div>
          )}

          {((plan.people_ids?.length ?? 0) > 0 || (plan.document_ids?.length ?? 0) > 0) && (
            <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              The coach also reads this plan's
              {plan.people_ids?.length ? ` ${plan.people_ids.length} researched ${plan.people_ids.length === 1 ? "person" : "people"}` : ""}
              {plan.people_ids?.length && plan.document_ids?.length ? " and" : ""}
              {plan.document_ids?.length ? ` ${plan.document_ids.length} ${plan.document_ids.length === 1 ? "file" : "files"}` : ""}.
            </p>
          )}

          {sections.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>
                Agenda
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {sections.map((s: any, i: number) => (
                  <button
                    key={i}
                    onClick={() => onSectionChange(i)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 12,
                      textAlign: "left",
                      fontFamily: "var(--font)",
                      transition: "background 0.12s",
                      background: i === sectionIdx ? "rgba(var(--accent-rgb),0.18)" : "transparent",
                      color: i === sectionIdx ? "var(--primary-hover)" : "var(--muted)",
                      fontWeight: i === sectionIdx ? 600 : 400,
                    }}
                    onMouseEnter={e => { if (i !== sectionIdx) e.currentTarget.style.background = "rgba(var(--ink-rgb),0.05)"; }}
                    onMouseLeave={e => { if (i !== sectionIdx) e.currentTarget.style.background = "transparent"; }}
                  >
                    {i === sectionIdx
                      ? <ChevronRight size={10} style={{ flexShrink: 0 }} />
                      : <span style={{ width: 10, flexShrink: 0 }} />
                    }
                    §{i + 1} {s.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {plan.traps_avoid?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--red)", marginBottom: 6 }}>
                ⚠ Traps to avoid
              </div>
              <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                {plan.traps_avoid.map((t: string, i: number) => (
                  <li key={i} style={{ fontSize: 12, color: "var(--muted)" }}>• {t}</li>
                ))}
              </ul>
            </div>
          )}

          {plan.questions_ask?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--primary-hover)", marginBottom: 6 }}>
                Questions to ask
              </div>
              <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                {plan.questions_ask.map((q: string, i: number) => (
                  <li key={i} style={{ fontSize: 12, color: "var(--muted)" }}>• {q}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
