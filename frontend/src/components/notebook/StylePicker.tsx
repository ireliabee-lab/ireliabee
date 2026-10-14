import { FONT_FAMILIES, FONT_SIZES, FONT_STYLES, LIST_MARKERS, styleVars, type NotebookKind, type NotebookStyle } from "../../lib/notebook";

/**
 * How the notes look: font family, size and style, with a live sample.
 * Shown before the AI writes anything, and again from the notebook's toolbar.
 */
export default function StylePicker({ value, onChange, kind }: {
  value: NotebookStyle;
  onChange: (s: NotebookStyle) => void;
  kind: NotebookKind;
}) {
  return (
    <div className="nb-style-picker">
      <fieldset className="nb-style-group">
        <legend className="settings-label">Font</legend>
        <div className="nb-style-families">
          {FONT_FAMILIES.map(f => (
            <label key={f.id} className={`nb-style-family ${value.family === f.id ? "active" : ""}`}>
              <input type="radio" name="nb-family" value={f.id} checked={value.family === f.id}
                onChange={() => onChange({ ...value, family: f.id })} />
              <span className="nb-style-family-name" style={{ fontFamily: f.stack }}>{f.label}</span>
              <span className="muted nb-style-family-hint">{f.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="nb-style-row">
        <fieldset className="nb-style-group">
          <legend className="settings-label">Size</legend>
          <div className="nb-segment" role="radiogroup" aria-label="Size">
            {FONT_SIZES.map(s => (
              <label key={s.id} className={value.size === s.id ? "active" : ""}>
                <input type="radio" name="nb-size" value={s.id} checked={value.size === s.id}
                  onChange={() => onChange({ ...value, size: s.id })} />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="nb-style-group">
          <legend className="settings-label">Style</legend>
          <div className="nb-segment" role="radiogroup" aria-label="Style">
            {FONT_STYLES.map(s => (
              <label key={s.id} className={value.style === s.id ? "active" : ""}>
                <input type="radio" name="nb-weight" value={s.id} checked={value.style === s.id}
                  onChange={() => onChange({ ...value, style: s.id })} />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="nb-style-group">
          <legend className="settings-label">List markers</legend>
          <div className="nb-segment" role="radiogroup" aria-label="List markers">
            {LIST_MARKERS.map(m => (
              <label key={m.id} className={(value.list ?? "bullet") === m.id ? "active" : ""}>
                <input type="radio" name="nb-list" value={m.id} checked={(value.list ?? "bullet") === m.id}
                  onChange={() => onChange({ ...value, list: m.id })} />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className={`nb-style-sample nb-paper-${kind === "meeting" ? "modern" : "classic"}`}
        style={styleVars(value) as React.CSSProperties} aria-label="Sample">
        <div className="nb-body">
          <span className="nb-hl">Water is split and oxygen is released</span> — the light reactions make ATP and NADPH,
          and the Calvin cycle spends them to fix CO₂ into sugars.
        </div>
      </div>
    </div>
  );
}
