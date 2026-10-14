import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { THEMES, PATTERNS, STRENGTHS, AUTO_THEME, getLook, setLook, type Look } from "../lib/theme";
import { patternUrl } from "../lib/patterns";
import { track } from "../lib/usage";

/** The current theme/pattern choice, kept in sync with changes made elsewhere. */
export function useLook(): [Look, (c: Partial<Look>) => void] {
  const [look, setState] = useState<Look>(getLook);
  useEffect(() => {
    const h = (e: Event) => setState((e as CustomEvent<Look>).detail);
    window.addEventListener("look", h);
    return () => window.removeEventListener("look", h);
  }, []);
  const change = (c: Partial<Look>) => {
    const next = setLook(c);
    if (c.theme) track(`look.theme.${c.theme}`);
    if (c.pattern) track(`look.pattern.${c.pattern}`);
    setState(next);
  };
  return [look, change];
}

/** A tiny window in the theme's colours with its dot field — what the theme will look like. */
function ThemePreview({ theme, pattern }: { theme: (typeof THEMES)[number]; pattern: Look["pattern"] }) {
  const mask = patternUrl(pattern === "none" ? "flow" : pattern);
  return (
    <span className="look-preview" style={{ background: theme.base }}>
      {pattern !== "none" && (
        <i className="look-preview-dots" style={{ background: theme.dots, WebkitMaskImage: mask, maskImage: mask }} />
      )}
      <i className="look-preview-card" style={{ background: theme.raised }}>
        <b style={{ background: theme.accent }} />
      </i>
    </span>
  );
}

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const [look, change] = useLook();
  // The list scrolls; open it on the theme in use rather than at the top.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chosen = list.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    chosen?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div className={`look-themes ${compact ? "compact" : ""}`} ref={list} role="radiogroup" aria-label="Theme">
      <button role="radio" aria-checked={look.theme === "auto"} className={look.theme === "auto" ? "active" : ""}
        onClick={() => change({ theme: "auto" })} title={AUTO_THEME.hint}>
        <span className="look-preview look-preview-auto">
          <span style={{ background: THEMES[0].base }}><ThemePreview theme={THEMES[0]} pattern={look.pattern} /></span>
          <span style={{ background: THEMES[1].base }}><ThemePreview theme={THEMES[1]} pattern={look.pattern} /></span>
        </span>
        <span className="look-label">
          <strong>{AUTO_THEME.label}</strong>
          {!compact && <small>{AUTO_THEME.hint}</small>}
        </span>
        {look.theme === "auto" && <Check size={13} className="look-check" />}
      </button>
      {THEMES.map(t => (
        <button key={t.id} role="radio" aria-checked={look.theme === t.id}
          className={look.theme === t.id ? "active" : ""} onClick={() => change({ theme: t.id })} title={t.hint}>
          <ThemePreview theme={t} pattern={look.pattern} />
          <span className="look-label">
            <strong>{t.label}</strong>
            {!compact && <small>{t.hint}</small>}
          </span>
          {look.theme === t.id && <Check size={13} className="look-check" />}
        </button>
      ))}
    </div>
  );
}

export function PatternPicker({ compact = false }: { compact?: boolean }) {
  const [look, change] = useLook();
  return (
    <div className="look-pattern-row">
      <div className={`look-patterns ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Background pattern">
        {PATTERNS.map(p => (
          <button key={p.id} role="radio" aria-checked={look.pattern === p.id} title={p.hint}
            className={look.pattern === p.id ? "active" : ""} onClick={() => change({ pattern: p.id })}>
            <span className="look-swatch">
              {p.id !== "none" && <i style={{ WebkitMaskImage: patternUrl(p.id), maskImage: patternUrl(p.id) }} />}
            </span>
            <strong>{p.label}</strong>
          </button>
        ))}
      </div>
      <div className="look-strength" role="radiogroup" aria-label="Pattern strength">
        {STRENGTHS.map(s => (
          <button key={s.id} role="radio" aria-checked={look.strength === s.id} disabled={look.pattern === "none"}
            className={look.strength === s.id ? "active" : ""} onClick={() => change({ strength: s.id })}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
