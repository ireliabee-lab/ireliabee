import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Loader2, Maximize2, Minimize2, X, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fetchApi } from "../../lib/api";
import { readingApi, rangesLabel } from "../../lib/reading";
import { printedLines, SPEAKER, textBands } from "../../lib/sourceText";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// One open document at a time: a book can be 150 MB, so keep the last one only.
let cached: { id: number; doc: Promise<pdfjs.PDFDocumentProxy> } | null = null;

/** Let go of the open book (a 150 MB PDF shouldn't stay in memory after its notebook closes). */
export function releasePdf() {
  cached?.doc.then(d => d.destroy()).catch(() => {});
  cached = null;
}

function openPdf(documentId: number): Promise<pdfjs.PDFDocumentProxy> {
  if (cached?.id === documentId) return cached.doc;
  cached?.doc.then(d => d.destroy()).catch(() => {});
  const doc = fetchApi(`/documents/${documentId}/file`).then(async r => {
    if (r.status === 404) throw new Error("gone");
    if (!r.ok) throw new Error("failed");
    return pdfjs.getDocument({ data: new Uint8Array(await r.arrayBuffer()) }).promise;
  });
  cached = { id: documentId, doc };
  doc.catch(() => { if (cached?.doc === doc) cached = null; });
  return doc;
}

/**
 * "Where did this come from?" for reading notes (spec 185 §4.3): the original
 * PDF opened at the cited page, one page at a time, in a side panel. The
 * reader can page around it, zoom, or switch to the page's plain text.
 */
/** The text with every whole-word mention of `find` marked, for the Text view. */
export function markMentions(text: string, find: string | null | undefined): (string | { mark: string })[] {
  const words = (find ?? "").trim();
  if (!words) return [text];
  const body = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
  const out: (string | { mark: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push({ mark: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const WIDE_KEY = "ireliabee.sourceWide";
const WIDTH_KEY = "ireliabee.sourceWidth";
/** The narrowest the panel can be dragged, and the gap kept on the left so the page behind still shows it is a panel. */
const MIN_WIDTH = 360, LEFT_GAP = 24;
/** At this width or wider, the Text view lays a page out in columns, as the spread layout does. */
const COLUMNS_FROM = 960;
/** About one screen of text: wide, a page is laid out band by band, each band spread across the width in columns. */
const BAND_CHARS = 2400;

export default function PdfSource({ documentId, pages, find, onClose }: {
  documentId: number;
  pages: number[];
  /** A key term: open on its words, marked, with a step through every page that has it. */
  find?: string | null;
  onClose: () => void;
}) {
  const cited = [...pages].sort((a, b) => a - b);
  const [page, setPage] = useState(cited[0] ?? 1);
  const [count, setCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<"page" | "text">(find ? "text" : "page");
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [text, setText] = useState<{ page: number; text: string }[] | null>(null);
  // Remembered between openings; storage can be unavailable, and then it simply starts narrow.
  const [wide, setWide] = useState(() => { try { return localStorage.getItem(WIDE_KEY) === "1"; } catch { return false; } });
  const toggleWide = () => setWide(w => { try { localStorage.setItem(WIDE_KEY, w ? "0" : "1"); } catch { /* not kept */ } return !w; });
  // Dragged by its left edge: a zoomed-in page needs more room than the default panel.
  const [width, setWidth] = useState<number | null>(() => {
    try { const n = Number(localStorage.getItem(WIDTH_KEY)); return n >= MIN_WIDTH ? n : null; } catch { return null; }
  });
  // The app scales the whole page with its text size (CSS zoom), so screen pixels are turned into
  // the panel's own before they become its width, or the edge would lag behind the pointer.
  const zoom = () => { const el = panelRef.current; return el && el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1; };
  const maxWidth = () => (window.innerWidth - LEFT_GAP) / zoom();
  const clampWidth = (n: number) => Math.round(Math.min(Math.max(n, MIN_WIDTH), maxWidth()));
  const keepWidth = (n: number) => { setWidth(n); try { localStorage.setItem(WIDTH_KEY, String(n)); } catch { /* not kept */ } };
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const right = panel.getBoundingClientRect().right;
    const scale = zoom();
    if (wide) toggleWide();               // dragging takes over from "spread across the page"
    const to = (ev: PointerEvent) => clampWidth((right - ev.clientX) / scale);
    // One width per frame, however fast the pointer reports: each is a layout of the whole panel.
    let frame = 0, last: PointerEvent | null = null;
    const move = (ev: PointerEvent) => {
      last = ev;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (last) setWidth(to(last)); });
    };
    const up = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      keepWidth(to(ev));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function resizeByKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const now = panelRef.current?.offsetWidth ?? MIN_WIDTH;
    const step = e.shiftKey ? 160 : 40;
    if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); if (wide) toggleWide(); keepWidth(clampWidth(now + step)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); if (wide) toggleWide(); keepWidth(clampWidth(now - step)); }
  }
  const columns = wide || (width ?? 0) >= COLUMNS_FROM;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Take focus, so ← → turn the PDF's pages and not the slides behind it; give it back on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => { before?.focus?.(); };
  }, []);

  useEffect(() => { setPage(cited[0] ?? 1); }, [pages.join(",")]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== "page") return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    setState(s => (s === "ready" ? s : "loading"));
    openPdf(documentId).then(async doc => {
      if (cancelled) return;
      setCount(doc.numPages);
      const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
      if (cancelled || !canvasRef.current) return;
      const width = (bodyRef.current?.clientWidth ?? 520) - 32;
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: (width / base.width) * scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      const render = p.render({
        canvas, canvasContext: canvas.getContext("2d")!, viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      task = render;
      await render.promise;
      if (!cancelled) setState("ready");
    }).catch(e => { if (!cancelled) setState(String(e?.message) === "gone" ? "gone" : "error"); });
    return () => { cancelled = true; task?.cancel(); };
  }, [documentId, page, scale, mode]);

  useEffect(() => {
    if (mode !== "text") return;
    let stale = false;                  // flipping fast: only the page on screen may fill it
    setText(null);
    readingApi.pages(documentId, [page]).then(r => { if (!stale) setText(r.pages); }).catch(() => { if (!stale) setText([]); });
    return () => { stale = true; };
  }, [documentId, page, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight" && (!count || page < count)) setPage(p => p + 1);
      else if (e.key === "ArrowLeft" && page > 1) setPage(p => p - 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, page, count]);

  // Bring the first marked mention into view.
  useEffect(() => {
    if (mode === "text" && text && find) bodyRef.current?.querySelector("mark")?.scrollIntoView({ block: "center" });
  }, [text, find, mode]);

  // The page's text laid out once per page, term and layout: dragging the panel wider re-renders
  // the panel every frame, and should not split and mark the whole page again each time.
  const pageText = text?.[0]?.text ?? "";
  const textView = useMemo(() => (
            <div className={`nb-pdf-text ${printedLines(pageText ?? "") ? "printed" : ""}`}>{pageText
              ? textBands(pageText, columns ? BAND_CHARS : Infinity).map((band, b) => (
                <div key={b} className="nb-pdf-band">
                  {band.map((line, i) => {
                    // "— " opens a new speaker's turn (backend link_import.caption_paragraphs).
                    // A tidied transcript names the speaker: "— Nat: …" (backend/source_tidy.py).
                    const turn = line.startsWith("— ");
                    // Only a name: one to four capitalised words, or Host/Guest/Speaker N, so a caption
                    // turn like "— So the question is: what next?" stays text.
                    const named = turn ? SPEAKER.exec(line.slice(2)) : null;
                    return (
                      <p key={i} className={turn ? "nb-pdf-turn" : undefined}>
                        {named && <strong className="nb-pdf-speaker">{named[1]}</strong>}
                        {markMentions(named ? named[2] : turn ? line.slice(2) : line, find).map((part, j) =>
                          typeof part === "string" ? part : <mark key={j} className="nb-pdf-mark">{part.mark}</mark>)}
                      </p>
                    );
                  })}
                </div>
              ))
              : <p className="muted">This page has no readable text.</p>}</div>
  ), [pageText, columns, find]);

  const isCited = cited.includes(page);
  const at = cited.indexOf(page);
  return (
    <div className="debrief-overlay nb-pdf-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={panelRef} tabIndex={-1} className={`glass-card nb-pdf ${wide ? "wide" : ""} ${columns ? "columns" : ""}`}
        style={!wide && width ? { width: Math.min(width, maxWidth()) } : undefined}
        role="dialog" aria-modal="true" aria-label={`Page ${page} of the document`}>
        <div className="nb-pdf-resize" role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label="Resize the panel: drag, or use the left and right arrow keys" title="Drag to resize"
          onPointerDown={startResize} onKeyDown={resizeByKey} onDoubleClick={() => { setWidth(null); try { localStorage.removeItem(WIDTH_KEY); } catch { /* not kept */ } }} />
        <header className="nb-pdf-head">
          <div className="nb-pdf-title">
            <strong>{find ? <>“<span className="nb-pdf-term">{find}</span>” in the document</> : "From the document"}</strong>
            {find ? (
              <span className="muted nb-pdf-steps">
                {cited.length ? <>On {cited.length} {cited.length === 1 ? "page" : "pages"}: p. {rangesLabel(cited)}</> : "Not found in the source's text"}
                {cited.length > 1 && <>
                  <button type="button" className="nb-icon-btn" aria-label="Previous page with this term" disabled={at <= 0}
                    onClick={() => setPage(cited[Math.max(0, at - 1)] ?? page)}><ChevronLeft size={13} /></button>
                  <button type="button" className="nb-icon-btn" aria-label="Next page with this term" disabled={at === cited.length - 1}
                    onClick={() => setPage(cited[at < 0 ? cited.findIndex(p => p > page) : at + 1] ?? page)}><ChevronRight size={13} /></button>
                </>}
              </span>
            ) : (
              <span className="muted">Cited: {cited.length ? `p. ${rangesLabel(cited)}` : "—"}</span>
            )}
          </div>
          <div className="nb-pdf-tools">
            <div className="nb-segment" role="group" aria-label="Show">
              <label className={mode === "page" ? "active" : ""}>
                <input type="radio" name="nb-pdf-mode" checked={mode === "page"} onChange={() => setMode("page")} />
                <span><ImageIcon size={13} /> Page</span>
              </label>
              <label className={mode === "text" ? "active" : ""}>
                <input type="radio" name="nb-pdf-mode" checked={mode === "text"} onChange={() => setMode("text")} />
                <span><FileText size={13} /> Text</span>
              </label>
            </div>
            {mode === "page" && <>
              <button type="button" className="nb-icon-btn" onClick={() => setScale(s => Math.max(0.6, +(s - 0.2).toFixed(1)))} aria-label="Zoom out"><ZoomOut size={15} /></button>
              <button type="button" className="nb-icon-btn" onClick={() => setScale(s => Math.min(2.4, +(s + 0.2).toFixed(1)))} aria-label="Zoom in"><ZoomIn size={15} /></button>
            </>}
            <button type="button" className="nb-icon-btn" onClick={toggleWide} aria-pressed={wide}
              aria-label={wide ? "Narrow the panel" : "Spread across the page"} title={wide ? "Narrow the panel" : "Spread across the page"}>
              {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="Close (Esc)"><X size={16} /></button>
          </div>
        </header>

        <div className="nb-pdf-body" ref={bodyRef}>
          {state === "gone" ? (
            <p className="muted nb-pdf-msg">This document isn't in your Library any more, so its pages can't be shown. Your notes are still here.</p>
          ) : state === "error" && mode === "page" ? (
            <p className="muted nb-pdf-msg">This page couldn't be drawn. Try the Text view.</p>
          ) : mode === "page" ? (
            <>
              {state === "loading" && <div className="nb-pdf-msg"><Loader2 size={18} className="spin" /> Opening the document…</div>}
              <canvas ref={canvasRef} className={`nb-pdf-canvas ${isCited ? "cited" : ""}`} aria-label={`Page ${page}`} />
            </>
          ) : text == null ? (
            <div className="nb-pdf-msg"><Loader2 size={18} className="spin" /></div>
          ) : (
            textView
          )}
        </div>

        <footer className="nb-pdf-foot">
          <button type="button" className="btn-neutral" onClick={() => setPage(p => p - 1)} disabled={page <= 1}>
            <ChevronLeft size={14} /> Previous
          </button>
          <span className={`nb-pdf-page ${isCited ? "cited" : ""}`} aria-live="polite">
            Page {page}{count ? ` of ${count}` : ""}{isCited ? (find ? " · has the term" : " · cited") : ""}
          </span>
          <button type="button" className="btn-neutral" onClick={() => setPage(p => p + 1)} disabled={!!count && page >= count}>
            Next <ChevronRight size={14} />
          </button>
        </footer>
      </aside>
    </div>
  );
}
