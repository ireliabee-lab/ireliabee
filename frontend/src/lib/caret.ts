/**
 * Where the text caret is on screen, for a textarea or text input.
 *
 * Browsers don't expose this, so we lay out an invisible copy of the field
 * (same font, size, padding and width) holding the text up to the caret, and
 * measure where a marker after that text lands.
 */

const COPIED = [
  "direction", "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderStyle", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant",
  "fontWeight", "fontStretch", "fontSize", "lineHeight", "fontFamily", "textAlign", "textTransform", "textIndent",
  "letterSpacing", "wordSpacing", "tabSize",
] as const;

export type CaretPoint = { x: number; y: number; line: number };

const TEXTY = new Set(["text", "search", "url", "email", "tel", ""]);

export function isTextField(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return el instanceof HTMLInputElement && TEXTY.has(el.type) && !el.readOnly && !el.disabled;
}

/** The caret's baseline point in viewport pixels, or null if it can't be measured. */
export function caretPoint(el: HTMLTextAreaElement | HTMLInputElement): CaretPoint | null {
  const pos = el.selectionEnd ?? el.value.length;
  const cs = getComputedStyle(el);
  const isInput = el instanceof HTMLInputElement;
  const fontSize = parseFloat(cs.fontSize) || 16;
  const line = parseFloat(cs.lineHeight) || fontSize * 1.3;

  const mirror = document.createElement("div");
  const s = mirror.style as unknown as Record<string, string>;
  for (const p of COPIED) s[p] = cs[p as keyof CSSStyleDeclaration] as string;
  s.position = "absolute";
  s.visibility = "hidden";
  s.top = "0";
  s.left = "-9999px";
  s.overflow = "hidden";
  s.whiteSpace = isInput ? "pre" : "pre-wrap";
  s.overflowWrap = isInput ? "normal" : "break-word";
  mirror.textContent = el.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(pos, pos + 1) || "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const left = marker.offsetLeft + (parseFloat(cs.borderLeftWidth) || 0);
  const top = marker.offsetTop + (parseFloat(cs.borderTopWidth) || 0);
  mirror.remove();

  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const x = rect.left + left - el.scrollLeft;
  // Inputs centre their single line; textareas stack lines from the top padding.
  const y = isInput
    ? rect.top + rect.height / 2 + fontSize * 0.36
    // The text sits centred in its line box; its baseline is about 0.8 of the font size below the glyphs' top.
    : rect.top + top - el.scrollTop + (line - fontSize) / 2 + fontSize * 0.84;
  return { x, y, line };
}

/** False when the point is scrolled out of view inside any clipping ancestor, or off screen. */
export function pointVisible(el: Element, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const o = getComputedStyle(a);
    if (/(auto|scroll|hidden|clip)/.test(o.overflowY + o.overflowX)) {
      const r = a.getBoundingClientRect();
      if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return false;
    }
  }
  return true;
}
