import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

interface Option { id: string; label: string; }

interface Props {
  options: Option[];
  value: string;
  onChange: (id: string) => void;
  style?: React.CSSProperties;
  placeholder?: string;
}

/** Themed dropdown: looks like the text inputs when closed, a themed menu when open (styles in index.css). */
export default function GlassSelect({ options, value, onChange, style, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  // Open upward when there isn't room below (e.g. controls at the bottom of a pane).
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  function toggle() {
    if (!open && ref.current) {
      const box = ref.current.getBoundingClientRect();
      const needed = Math.min(options.length * 34 + 16, 320);
      setDropUp(window.innerHeight - box.bottom < needed && box.top > window.innerHeight - box.bottom);
    }
    setOpen(o => !o);
  }

  const selected = options.find(o => o.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="glass-dropdown" style={style}>
      <button type="button" className={`glass-dropdown-trigger ${open ? "open" : ""} ${selected ? "" : "empty"}`}
        onClick={toggle} aria-haspopup="listbox" aria-expanded={open}>
        <span>{selected?.label ?? placeholder ?? value}</span>
        <ChevronDown size={12} className="glass-dropdown-chevron" />
      </button>

      {open && (
        <div className={`glass-dropdown-menu ${dropUp ? "up" : ""}`} role="listbox">
          {options.map(o => {
            const active = o.id === value;
            return (
              <button key={o.id} type="button" role="option" aria-selected={active}
                className={`glass-dropdown-option ${active ? "active" : ""}`}
                onClick={() => { onChange(o.id); setOpen(false); }} title={o.label}>
                <span>{o.label}</span>
                {active && <Check size={12} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
