import { useEffect, useRef, useState } from "react";
import { Link, Loader2, X } from "lucide-react";
import { linksApi, type LinkDocument, type LinkSource, type ScreenshotPrice } from "../lib/links";
import { toFriendly } from "../lib/errors";
import "../link-import.css";

export default function LinkImport({ onClose, onSaved, target = "notebook" }: {
  onClose: () => void; onSaved: (doc: LinkDocument) => void; target?: "notebook" | "library";
}) {
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<LinkSource | null>(null);
  const [fallback, setFallback] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [price, setPrice] = useState<ScreenshotPrice | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    let unlisten: (() => void) | undefined;
    linksApi.listen(captured => {
      if (alive.current) { setSource(captured); setError(""); setBusy(""); }
    }, message => { if (alive.current) { setError(message); setBusy(""); } })
      .then(stop => { if (alive.current) unlisten = stop; else stop(); })
      .catch(e => { if (alive.current) setError(toFriendly(e).message); });
    return () => { alive.current = false; unlisten?.(); void linksApi.closeBrowser().catch(() => {}); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (!image) { setImageUrl(""); return; }
    const local = URL.createObjectURL(image);
    setImageUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [image]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError("");
    try { await action(); } catch (e) { if (alive.current) setError(toFriendly(e).message); }
    finally { if (alive.current) setBusy(""); }
  }
  async function preview() {
    await run("Reading the public page…", async () => {
      setSource(null); setImage(null); setPrice(null); setFallback("");
      const result = await linksApi.preview(url.trim());
      if (!alive.current) return;
      if ("fallback" in result) { setFallback(result.reason); setUrl(result.url); }
      else setSource(result);
    });
  }
  async function chooseImage(file?: File) {
    if (!file || busy) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError("Use a PNG, JPEG or WebP screenshot smaller than 10 MB."); return;
    }
    setImage(file); setPrice(null); setError("");
    try {
      const next = await linksApi.screenshotPrice();
      if (alive.current) setPrice(next);
    } catch (e) { if (alive.current) setError(toFriendly(e).message); }
  }

  function keys(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); if (!busy) onClose(); }
    if (e.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]") ?? []).filter(el => !el.hasAttribute("hidden"));
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }

  return <div className="debrief-overlay link-import-overlay" onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} className="debrief-panel link-import-panel" role="dialog" aria-modal="true" aria-labelledby="link-import-title" onKeyDown={keys}
      onPaste={e => { if (!fallback || source || busy) return; const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith("image/")); if (file) { e.preventDefault(); void chooseImage(file); } }}
      onDragOver={e => { if (fallback && !source) e.preventDefault(); }}
      onDrop={e => { e.preventDefault(); if (fallback && !source && !busy) void chooseImage(e.dataTransfer.files[0]); }}>
      <header className="debrief-panel-head">
        <h2 id="link-import-title"><Link size={17} aria-hidden="true" /> Add a link</h2>
        <button type="button" className="btn-neutral" aria-label="Close link import" disabled={!!busy} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="link-import-body">
        {error && <p role="alert" className="link-import-error">{error}</p>}
        {!source ? <>
          <form onSubmit={e => { e.preventDefault(); if (!busy) void preview(); }}>
            <label htmlFor="source-url">Web page or social post link</label>
            <div className="link-import-row">
              <input ref={input} id="source-url" className="nb-input" type="url" required maxLength={4096} placeholder="https://…" value={url} disabled={!!busy} onChange={e => { setUrl(e.target.value); setFallback(""); setImage(null); setPrice(null); }} />
              <button className="btn-primary" disabled={!!busy || !url.trim()}>Read link</button>
            </div>
          </form>
          <p className="muted">We first try the public page. You review the text before it is saved on this computer.</p>
          {fallback && <section className="link-import-fallback" aria-label="Other ways to save this link">
            <p>{fallback}</p>
            <button type="button" className="btn-neutral" disabled={!!busy} onClick={() => void run("Opening the browser…", () => linksApi.openBrowser(url))}>Open in app browser</button>
            <p className="muted">Sign in yourself if needed. Click <b>Save to notebook</b> in the browser’s menu to capture the post or article on screen (all of it, even the part below the window), or else the text currently visible. Review it here before adding it.</p>
            <div className="link-import-screenshot">
              <label htmlFor="source-image">Or paste, drop or choose a screenshot</label>
              <input id="source-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} onChange={e => { void chooseImage(e.target.files?.[0]); e.target.value = ""; }} />
              <p className="muted">The screenshot stays local until you confirm. Reading it uses billed vision, even when your text assistant is connected.</p>
              {image && <>
                {imageUrl && <img className="link-import-image" src={imageUrl} alt="Screenshot selected for transcription" />}
                {price ? <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void run("Reading the screenshot…", async () => { const result = await linksApi.screenshot(url, image, price); if (alive.current) setSource(result); })}>
                  Read screenshot (up to {price.credits.toFixed(3)} credits)
                </button> : <button type="button" className="btn-neutral" disabled={!!busy} onClick={() => void chooseImage(image)}>Get screenshot credit cost</button>}
              </>}
            </div>
          </section>}
        </> : <section aria-label="Review captured text" className="link-import-review">
          <h3>Review the text before adding it</h3>
          <p className="muted link-import-origin">{source.url} · {source.method === "browser" ? "Captured on your click" : source.method === "screenshot" ? "Screenshot transcription" : source.partial ? "Public page, start only" : "Public page"}</p>
          {source.method === "public" && source.partial && <div role="alert" className="link-import-partial">
            <p>{source.partial}</p>
            <div className="link-import-row">
              <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void run("Opening the browser…", () => linksApi.openBrowser(source.url))}>Open in app browser</button>
              <button type="button" className="btn-neutral" disabled={!!busy} onClick={() => { setFallback(source.partial ?? ""); setUrl(source.url); setSource(null); }}>Use a screenshot instead</button>
            </div>
            <p className="muted">In the browser, click <b>Save to notebook</b>: it takes the whole post, even the part below the window. You can still add just the start below.</p>
          </div>}
          <label htmlFor="source-title">Source title</label>
          <input id="source-title" className="nb-input" maxLength={200} value={source.title} disabled={!!busy} onChange={e => setSource({ ...source, title: e.target.value })} />
          <label htmlFor="source-author">Author (if known)</label>
          <input id="source-author" className="nb-input" maxLength={200} value={source.author} disabled={!!busy} onChange={e => setSource({ ...source, author: e.target.value })} />
          <label htmlFor="source-text">Captured text</label>
          <textarea id="source-text" className="nb-input" rows={10} maxLength={5_000_000} value={source.text} disabled={!!busy} onChange={e => setSource({ ...source, text: e.target.value })} />
          {source.method === "public" && !source.partial && <p className="muted link-import-wrong">
            Not the post or page you wanted, or only part of it?{" "}
            <button type="button" className="btn-link" disabled={!!busy} onClick={() => void run("Opening the browser…", () => linksApi.openBrowser(source.url))}>Open in app browser</button>
            {" "}— sign in yourself if needed, then click <b>Save to notebook</b>.
          </p>}
          <div className="link-import-row">
            <button type="button" className="btn-neutral" disabled={!!busy} onClick={() => setSource(null)}>Back</button>
            <button type="button" className="btn-primary" disabled={!!busy || !source.text.trim()} onClick={() => void run("Saving the source…", async () => { const doc = await linksApi.save(source); if (alive.current) onSaved(doc); })}>
              {target === "library" ? "Add to Library" : "Add to notebook"}
            </button>
          </div>
        </section>}
        {busy && <p role="status"><Loader2 size={14} className="spin" aria-hidden="true" /> {busy}</p>}
      </div>
    </div>
  </div>;
}
