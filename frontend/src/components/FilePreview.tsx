import { useEffect, useRef, useState } from "react";
import { X, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fetchApi } from "../lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Renders the PDF with bundled pdf.js — the desktop webview has no built-in PDF viewer.
export interface PreviewFile { path: string; name: string; mime: string; kind: string; }

export default function FilePreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [scale, setScale] = useState(1.2);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const isPdf = file.mime === "application/pdf";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    fetchApi(file.path)
      .then(async r => {
        if (!r.ok) throw new Error();
        if (isPdf) setPdfData(await r.arrayBuffer());
        else { setText(await r.text()); setState("ready"); }
      })
      .catch(() => setState("error"));
  }, [file.path, isPdf]);

  useEffect(() => {
    if (!pdfData || !pagesRef.current) return;
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let loaded: pdfjs.PDFDocumentProxy | null = null;
    const container = pagesRef.current;
    (async () => {
      try {
        // pdf.js detaches the buffer it's given, so hand it a copy for re-renders on zoom.
        const doc = await pdfjs.getDocument({ data: pdfData.slice(0) }).promise;
        loaded = doc;
        if (cancelled) return;
        container.innerHTML = "";
        const ratio = window.devicePixelRatio || 1;
        // A book can have hundreds of pages: lay out a placeholder for each (sized from
        // page 1) and draw a page only as it comes near the screen.
        const first = (await doc.getPage(1)).getViewport({ scale });
        const draw = async (n: number, slot: HTMLDivElement) => {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.className = "cv-page";
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          await page.render({
            canvas,
            canvasContext: canvas.getContext("2d")!,
            viewport,
            transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
          }).promise;
          if (!cancelled) slot.replaceChildren(canvas);
        };
        observer = new IntersectionObserver(entries => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const slot = e.target as HTMLDivElement;
            observer?.unobserve(slot);
            draw(Number(slot.dataset.page), slot).catch(() => { slot.textContent = `Page ${slot.dataset.page} couldn't be drawn.`; });
          }
        }, { root: container.closest(".cv-preview-body"), rootMargin: "800px 0px" });
        for (let n = 1; n <= doc.numPages; n++) {
          const slot = document.createElement("div");
          slot.className = "cv-page-slot";
          slot.dataset.page = String(n);
          slot.style.width = `${Math.floor(first.width)}px`;
          slot.style.minHeight = `${Math.floor(first.height)}px`;
          slot.setAttribute("aria-label", `Page ${n}`);
          container.appendChild(slot);
          observer.observe(slot);
        }
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; observer?.disconnect(); loaded?.destroy(); };
  }, [pdfData, scale]);

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="debrief-panel cv-preview-panel">
        <header className="debrief-panel-head">
          <div style={{ minWidth: 0 }}>
            <div className="debrief-kicker">{file.kind} preview</div>
            <div className="debrief-title">{file.name}</div>
          </div>
          {isPdf && (
            <div style={{ display: "flex", gap: 4 }}>
              <button className="titlebar-btn" onClick={() => setScale(s => Math.max(0.6, s - 0.2))} title="Zoom out"><ZoomOut size={15} /></button>
              <button className="titlebar-btn" onClick={() => setScale(s => Math.min(2.4, s + 0.2))} title="Zoom in"><ZoomIn size={15} /></button>
            </div>
          )}
          <button className="titlebar-btn" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
        </header>
        <div className="debrief-panel-body cv-preview-body">
          {state === "loading" && <div className="cv-preview-status"><Loader2 size={18} className="spin" /></div>}
          {state === "error" && <div className="cv-preview-status muted">Couldn't open this file for preview.</div>}
          {isPdf ? <div ref={pagesRef} className="cv-pages" /> : text != null && <pre className="cv-text">{text}</pre>}
        </div>
      </div>
    </div>
  );
}
