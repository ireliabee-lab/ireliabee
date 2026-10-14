import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AArrowDown, AArrowUp, AlignCenter, BookA, Bold, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Heading, Highlighter, ImagePlus, Italic, List, ListChecks, ListOrdered, Minus,
  BookOpenCheck, Lightbulb, Loader2, MessageSquareText, Network, Palette, Pencil, Plus, Quote, Redo2, RemoveFormatting, Sparkles, Star, Strikethrough, Table, Type, Underline, Undo2, Volume2, VolumeX, X,
} from "lucide-react";
import { createNotebookBook, type NotebookBookApp, type NotebookBookState } from "../../lib/book/notebookApp";
import { HIGHLIGHTS, INK_COLORS } from "../../lib/book/diary/editor";
import { CLEAN_THEMES, PAGE_COLORS, THEMES, type ThemeId } from "../../lib/book/themes";
import { COLORS, type TextSize } from "../../lib/book/pages";
import { PageSound } from "../../lib/book/sound";
import { downscaleImage } from "../../lib/book/diary/pictures";
import toast from "react-hot-toast";
import type { ToggleParaStyle } from "../../lib/book/rich";
import { docToEntries, entriesToDoc, type BookEntry } from "../../lib/notebookBook";
import { knownTerms, termAt, type KnownTerm } from "../../lib/readingHelp";
import ExplainBack from "./ExplainBack";
import ExplainCard, { type Selected } from "./ExplainCard";
import MindMapCard from "./MindMapCard";
import StudyChapter from "./StudyChapter";
import { placeBeside, type Placement } from "../../lib/cardPlacement";
import UnderstandCard from "./UnderstandCard";
import CheckCard from "./CheckCard";
import GlossaryCard from "./GlossaryCard";
import type { ReadingProgress } from "../../lib/reading";
import { readingApi, rememberedLevel, UNDERSTAND_MODES, type ReaderLevel, type UnderstandMode } from "../../lib/reading";
import { notifyError } from "../../lib/errors";
import { DEFAULT_STYLE, sourceLabel, type Notebook, type NotebookDoc, type NotebookStyle, type Paper } from "../../lib/notebook";

const KIND_WORDS = { lecture: "Lecture notes", meeting: "Meeting notes", reading: "Reading notes" } as const;

/** Whether the formatting bar is showing (Ctrl + . hides it for more book), remembered on this computer. */
const BAR_KEY = "ireliabee.nbkBar";
const barWanted = () => { try { return localStorage.getItem(BAR_KEY) !== "0"; } catch { return true; } };
/** Whether the notebook makes sounds (the page turning), remembered on this computer. */
const SOUND_KEY = "ireliabee.nbkSound";
const soundWanted = () => { try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch { return true; } };
/** Space left under the bar, so it sits just above the window's bottom edge (below the sidebar's Settings row). */
const BOTTOM_GAP = 12;


function Tool({ label, pressed, disabled, onClick, children }: {
  label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" className="nbk-tool" aria-label={label} title={label} disabled={disabled}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      onMouseDown={e => e.preventDefault()} onClick={onClick}>{children}</button>
  );
}

type Menu = null | "color" | "highlight" | "insert" | "theme" | "understand";

/**
 * A notebook written in a book (the Nkɔmmɔ engine): tap a page and write, with
 * the formatting bar underneath. Every edit becomes the notebook document again
 * (lib/notebookBook.ts) and goes to the editor's autosave through `onDoc`.
 */
export default function NotebookBook({ nb, doc, style, onDoc, onStyle, onSource, onProgress }: {
  nb: Notebook;
  doc: NotebookDoc;
  style: NotebookStyle;
  onDoc: (doc: NotebookDoc) => void;
  /** The paper and cover are saved with the notebook, in its style. */
  onStyle: (style: NotebookStyle) => void;
  /** A source tag was tapped: open the page of the PDF, or the moment in the transcript. */
  onSource?: (src: number[], find?: string) => void;
  /** A chapter was explained back: the notebook's progress now. */
  onProgress?: (p: ReadingProgress) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const bookBox = useRef<HTMLDivElement>(null);
  const under = useRef<HTMLDivElement>(null);
  const [barOn, setBarOn] = useState(barWanted);
  const [soundOn, setSoundOn] = useState(soundWanted);
  const sound = useRef<PageSound | null>(null);
  const toggleSound = () => setSoundOn(on => {
    const next = !on;
    if (sound.current) sound.current.enabled = next;
    try { localStorage.setItem(SOUND_KEY, next ? "1" : "0"); } catch { /* on again next time */ }
    return next;
  });
  // Help while reading (Deep Read, B3): the term the cursor rests on, and a paragraph in plainer words.
  const terms = useMemo(() => knownTerms(doc), [doc]);
  const [term, setTerm] = useState<KnownTerm | null>(null);
  // The Simplify menu: the paragraph at the cursor, and the way first asked for; the card switches ways itself.
  const [plainer, setPlainer] = useState<null | { mode: UnderstandMode; text: string; src: number[] }>(null);
  // Check your understanding: the paragraph being asked about.
  const [checking, setChecking] = useState<null | { text: string; src: number[] }>(null);
  // The fuller glossary: the notebook's terms, and finding more.
  const [glossary, setGlossary] = useState(false);
  const [explaining, setExplaining] = useState<null | { id: string; title: string }>(null);
  // Explain (select any words): the selection is taken when the card opens, so it stays put while you read.
  const [explainSel, setExplainSel] = useState<Selected | null>(null);
  // Where the Explain card opens: beside the selected words (owner, 30 Sep 2026), worked out when it opens.
  const [explainAt, setExplainAt] = useState<Placement | null>(null);
  // Mind map (select a passage): the passage being drawn as a map.
  const [mapSel, setMapSel] = useState<Selected | null>(null);
  // Study mode: the chapter being studied.
  const [studying, setStudying] = useState<null | { id: string; title: string }>(null);
  const [bookH, setBookH] = useState<number | null>(null);
  const app = useRef<NotebookBookApp | null>(null);
  const latestDoc = useRef(doc);
  latestDoc.current = doc;
  const [st, setSt] = useState<NotebookBookState | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const theme: Paper = style.paper ?? DEFAULT_STYLE[nb.kind].paper ?? "classic";
  const photo = useRef<HTMLInputElement>(null);
  const sourceRef = useRef(onSource);
  sourceRef.current = onSource;
  const [title, setTitle] = useState("");

  const [editingCover, setEditingCover] = useState(false);
  const cover = doc.cover;
  const words = useMemo(() => {
    const name = doc.title || nb.title;
    // The exercise-book label says what you wrote on it, never the title again.
    const label = { name: cover?.name ?? "", class: cover?.class ?? "", year: cover?.year ?? "" };
    return { title: name, intro: KIND_WORDS[nb.kind], footer: "", empty: "Tap here and start writing.", label };
  }, [doc.title, nb.title, nb.kind, cover?.name, cover?.class, cover?.year]);
  const owner = doc.author || doc.title || nb.title;

  // One book per mount; the editor remounts it when the whole document is replaced (restore, load theirs).
  useEffect(() => {
    if (!host.current) return;
    const entries = docToEntries(doc, nb.kind, src => sourceLabel(nb, src) ?? "");
    app.current = createNotebookBook(host.current, {
      entries, words, owner, theme, pageColor: style.pageColor ?? null, textSize: style.size as TextSize,
      onEntries: (next: BookEntry[]) => onDoc(entriesToDoc(latestDoc.current, next)),
      onState: setSt,
      onSource: src => sourceRef.current?.(src),
      reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      sound: (sound.current = new PageSound(soundWanted())),
      prefersDark: () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    });
    return () => { app.current?.destroy(); app.current = null; };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { app.current?.setWords(words, owner); }, [words, owner]);
  // Every term the notebook knows is underlined on its pages.
  const termKey = terms.map(t => t.term).join("|");
  useEffect(() => { app.current?.setMarkedTerms(terms.map(t => t.term)); }, [termKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTitle(st?.role === "section" ? st.entryTitle : ""); }, [st?.entry, st?.role, st?.entryTitle]);
  const onCover = st?.where === "Front cover";
  useEffect(() => { if (!onCover) setEditingCover(false); }, [onCover]);
  // Only the Exercise book cover (the school theme) has a label with a name, class and year on it.
  const labelled = theme === "school";
  const editCover = (patch: { title?: string; name?: string; class?: string; year?: string }) => {
    const cur = latestDoc.current;
    const { title: nextTitle, ...lines } = patch;
    onDoc({
      ...cur,
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(Object.keys(lines).length ? { cover: { ...cur.cover, ...lines } } : {}),
    });
  };
  // The book takes every pixel from its top down to the window's bottom edge,
  // less the row under it (none when the bar is hidden).
  useLayoutEffect(() => {
    const fit = () => {
      const el = bookBox.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // The app can be zoomed (Settings), so screen pixels and CSS pixels differ: work in CSS pixels.
      const scale = el.offsetHeight ? r.height / el.offsetHeight : 1;
      const row = barOn ? (under.current?.offsetHeight ?? 0) + 6 : 0;
      setBookH(Math.max(320, Math.floor((window.innerHeight - r.top) / (scale || 1) - row - BOTTOM_GAP)));
    };
    fit();
    window.addEventListener("resize", fit);
    const ro = new ResizeObserver(fit);
    if (under.current) ro.observe(under.current);
    return () => { window.removeEventListener("resize", fit); ro.disconnect(); };
  }, [barOn]);
  // Ctrl + . (Cmd + . on a Mac) shows or hides the formatting bar.
  useEffect(() => {
    const toggle = (e: KeyboardEvent) => {
      if (e.key !== "." || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setBarOn(on => { try { localStorage.setItem(BAR_KEY, on ? "0" : "1"); } catch { /* shown next time */ } return !on; });
      setMenu(null);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  const setBar = (on: boolean) => { try { localStorage.setItem(BAR_KEY, on ? "1" : "0"); } catch { /* shown next time */ } setBarOn(on); setMenu(null); };

  // Turning pages from the keyboard (A5): Page Up / Page Down anywhere in the
  // notebook, even while writing; the arrow keys too when no text field has focus
  // (in the writing they move the caret, as they should).
  useEffect(() => {
    const turn = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !app.current) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const back = e.key === "PageUp" || (!typing && e.key === "ArrowLeft");
      const fwd = e.key === "PageDown" || (!typing && e.key === "ArrowRight");
      if (!back && !fwd) return;
      e.preventDefault();
      if (back) app.current.prev(); else app.current.next();
    };
    window.addEventListener("keydown", turn);
    return () => window.removeEventListener("keydown", turn);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  // A click (not the keyboard) that lands on a key term opens the source where the term is written.
  const clicked = useRef(false);
  async function showInBook(t: KnownTerm) {
    if (!onSource || !nb.document_id) return;
    try {
      const { pages } = await readingApi.find(nb.document_id, t.term);
      onSource(pages.length ? pages : t.src, t.term);
    } catch (e) { notifyError(e); }
  }
  useEffect(() => {
    const wasClick = clicked.current;
    clicked.current = false;
    if (!terms.length || !app.current) { setTerm(null); return; }
    const line = app.current.caretLine();
    const found = line ? termAt(line.text, line.offset, terms) : null;
    setTerm(found);
    if (found && wasClick && !st?.selected) void showInBook(found);
  }, [st, terms]);  // eslint-disable-line react-hooks/exhaustive-deps

  const level: ReaderLevel = ((nb.scope as { level?: ReaderLevel } | null)?.level) ?? rememberedLevel();
  function simplify(mode: UnderstandMode) {
    const line = app.current?.caretLine();
    setMenu(null);
    if (!line?.text) { toast("Put the cursor in the paragraph you want explained."); return; }
    setExplainSel(null);
    setChecking(null);
    setPlainer({ mode, text: line.text, src: line.src });
  }

  function checkParagraph() {
    const line = app.current?.caretLine();
    setMenu(null);
    if (!line?.text) { toast("Put the cursor in the paragraph you want to be asked about."); return; }
    setExplainSel(null);
    setPlainer(null);
    setChecking({ text: line.text, src: line.src });
  }

  function explainSelection() {
    const sel = app.current?.selectedWords();
    setMenu(null);
    if (!sel) { toast("Select a word or a few words first, then press Explain."); return; }
    setPlainer(null);
    const words = app.current?.selectionBox();
    const box = bookBox.current;
    setExplainAt(words && box ? placeBeside(words, { width: box.clientWidth, height: box.clientHeight }, 520) : null);
    setExplainSel(sel);
  }

  function mapSelection() {
    const sel = app.current?.selectedWords();
    setMenu(null);
    if (!sel) { toast("Highlight a sentence or a paragraph first, then press Mind map."); return; }
    setExplainSel(null);
    setMapSel(sel);
  }

  async function keepMap(svg: Blob) {
    // A see-through PNG, so the map sits on the book's own paper and grain.
    const url = URL.createObjectURL(svg);
    const picture = await new Promise<{ src: string; w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = 1600, h = Math.round((img.naturalHeight / img.naturalWidth) * 1600);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")?.drawImage(img, 0, 0, w, h);
        resolve({ src: c.toDataURL("image/png"), w, h });
      };
      img.onerror = () => reject(new Error("The map couldn't be drawn"));
      img.src = url;
    }).finally(() => URL.revokeObjectURL(url));
    app.current?.insertPicture(picture, true);
    toast.success("The mind map is in your notebook");
  }

  const run = (fn: (a: NotebookBookApp) => void) => { if (app.current) fn(app.current); setMenu(null); };
  const para = (p: ToggleParaStyle) => run(a => a.setPara(p));
  const on = (p: string) => st?.para === p || (p === "check" && st?.para === "checked");
  // The look menu stays open while you try things: paper, page colour and text size together.
  const pickTheme = (id: Paper) => {
    void app.current?.setTheme(id);
    // A Clean paper is the app's own look, which is small type: a notebook still on the default size gets it too.
    const small = CLEAN_THEMES.includes(id as ThemeId) && (style.size ?? "m") === "m";
    if (small) app.current?.setTextSize("xs");
    onStyle({ ...style, paper: id, ...(small ? { size: "xs" as const } : {}) });
  };
  const pickColor = (id: string | null) => {
    void app.current?.setPageColor(id);
    onStyle({ ...style, pageColor: id });
  };
  const pickSize = (size: TextSize) => {
    app.current?.setTextSize(size);
    onStyle({ ...style, size });
  };
  // Text size from the bar (owner, 30 Sep 2026): a step smaller or larger, without opening the look menu.
  const SIZES: TextSize[] = ["xs", "s", "m", "l", "xl"];
  const SIZE_NAMES = ["Extra small", "Small", "Medium", "Large", "Extra large"];
  const sizeAt = Math.max(0, SIZES.indexOf((style.size ?? "m") as TextSize));
  const stepSize = (by: -1 | 1) => { const next = SIZES[sizeAt + by]; if (next) pickSize(next); };
  async function onPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const picture = await downscaleImage(file);
      app.current?.insertPicture(picture);
    } catch {
      toast.error("That photo couldn't be added. Try a JPEG or PNG.");
    }
  }


  return (
    <div className="nbk">
      <input ref={photo} type="file" accept="image/*" hidden onChange={e => void onPhoto(e.target.files?.[0])} />
      <div className="nbk-book" ref={bookBox} style={bookH ? { height: bookH } : undefined}>
        <div className="nbk-stage-host" ref={host} style={{ position: "absolute", inset: 0 }}
          onPointerUp={e => { if (e.button === 0 && nb.document_id) clicked.current = true; }} />
        <p className="sr-only" id="nbk-help">Page Up and Page Down turn the pages. Click or tap a page to write on it.</p>
        <button type="button" className="nbk-sound" aria-pressed={!soundOn}
          aria-label={soundOn ? "Mute the notebook's sounds" : "Turn the notebook's sounds on"}
          title={soundOn ? "Sound on: pages rustle as they turn. Click to mute" : "Muted. Click to hear pages turn"}
          onClick={toggleSound}>
          {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
        <button type="button" className="nbk-round prev" aria-label="Previous page" aria-keyshortcuts="PageUp" aria-describedby="nbk-help" disabled={!st?.canPrev}
          onClick={() => app.current?.prev()}><ChevronLeft size={20} /></button>
        <button type="button" className="nbk-round next" aria-label="Next page" aria-keyshortcuts="PageDown" disabled={!st?.canNext}
          onClick={() => app.current?.next()}><ChevronRight size={20} /></button>
        {onCover && !editingCover && !explaining && (
          <button type="button" className="nbk-pill nbk-cover-edit" onClick={() => { setMenu(null); setEditingCover(true); }}>
            <Pencil size={13} /> Edit cover
          </button>
        )}
        {editingCover && (
          <form className="nbk-help nbk-cover-form" aria-label="Edit the cover"
            onSubmit={e => { e.preventDefault(); setEditingCover(false); }}
            onKeyDown={e => { if (e.key === "Escape") setEditingCover(false); }}>
            <div className="nbk-help-head"><Pencil size={13} /> <strong>The cover</strong>
              <button type="button" className="nb-icon-btn" aria-label="Close" onClick={() => setEditingCover(false)}><X size={13} /></button></div>
            <label className="nbk-cover-row"><span>Title</span>
              <input id="nbk-cover-title" className="nb-input" value={doc.title} placeholder={nb.title} autoFocus maxLength={200}
                onChange={e => editCover({ title: e.target.value })} /></label>
            {labelled ? (
              <>
                <label className="nbk-cover-row"><span>Name</span>
                  <input id="nbk-cover-name" className="nb-input" value={cover?.name ?? ""} maxLength={120}
                    onChange={e => editCover({ name: e.target.value })} /></label>
                <label className="nbk-cover-row"><span>Class</span>
                  <input id="nbk-cover-class" className="nb-input" value={cover?.class ?? ""} maxLength={120}
                    onChange={e => editCover({ class: e.target.value })} /></label>
                <label className="nbk-cover-row"><span>Year</span>
                  <input id="nbk-cover-year" className="nb-input" value={cover?.year ?? ""} maxLength={120}
                    onChange={e => editCover({ year: e.target.value })} /></label>
              </>
            ) : (
              <p className="muted">The Exercise book cover has a label for your name, class and year. Choose it under Paper and cover.</p>
            )}
            <button type="submit" className="nbk-pill">Done</button>
          </form>
        )}
        {explaining && (
          <ExplainBack notebookId={nb.id} sectionId={explaining.id} chapter={explaining.title} onSource={onSource}
            onProgress={onProgress} onClose={() => setExplaining(null)} />
        )}
        {!explaining && explainSel && (
          <ExplainCard key={explainSel.text} selected={explainSel} documentId={nb.document_id ?? null} notebookId={nb.id} level={level} placement={explainAt} onSource={onSource}
            onAddUnder={text => app.current?.addUnderLine(text)} onClose={() => setExplainSel(null)} />
        )}
        {!explaining && !explainSel && !checking && !mapSel && st?.selected && (
          <span className="nbk-explain-pill nbk-sel-pills">
            <button type="button" className="nbk-pill" onMouseDown={e => e.preventDefault()} onClick={explainSelection}
              title="What do these words mean? Basic or technical">
              <Lightbulb size={13} /> Explain
            </button>
            <button type="button" className="nbk-pill nbk-map-pill" onMouseDown={e => e.preventDefault()} onClick={mapSelection}
              title="See this passage as a mind map">
              <Network size={13} /> Mind map
            </button>
          </span>
        )}
        {studying && (() => {
          const sec = latestDoc.current.sections.find(x => x.id === studying.id);
          return sec ? (
            <StudyChapter key={studying.id} notebookId={nb.id} documentId={nb.document_id ?? null} sectionId={sec.id} title={sec.title}
              points={sec.blocks.filter(b => b.type !== "image" && b.text.trim()).map(b => ({ text: b.text, src: b.src }))}
              level={level} onSource={onSource} onClose={() => setStudying(null)} />
          ) : null;
        })()}
        {mapSel && (
          <MindMapCard key={mapSel.text} selected={mapSel} documentId={nb.document_id ?? null} level={level}
            paper={COLORS.paper} ink={COLORS.ink} onSource={onSource} onSave={keepMap} onClose={() => setMapSel(null)} />
        )}
        {!explaining && glossary && (
          <GlossaryCard notebookId={nb.id} doc={latestDoc.current} level={level} onDoc={onDoc} onSource={onSource} onClose={() => setGlossary(false)} />
        )}
        {!explaining && !glossary && !explainSel && checking && (
          <CheckCard key={checking.text} paragraph={checking} documentId={nb.document_id ?? null} notebookId={nb.id} level={level} onClose={() => setChecking(null)} />
        )}
        {!explaining && !glossary && !explainSel && !checking && plainer && (
          <UnderstandCard key={`${plainer.mode}:${plainer.text}`} paragraph={plainer} mode={plainer.mode} level={level}
            documentId={nb.document_id ?? null} notebookId={nb.id} onSource={onSource}
            onAddUnder={text => app.current?.addUnderLine(text)} onClose={() => setPlainer(null)} />
        )}
        {!explaining && !glossary && !explainSel && !checking && !plainer && !menu && term && (
          <div className="nbk-help" role="status" aria-live="polite">
            {term && (
              <>
                <div className="nbk-help-head"><strong>{term.term}</strong>
                  {term.ours && <span className="muted">iReliabee's: not explained in your source</span>}
                  {onSource && nb.document_id && (
                    <button type="button" className="nbk-help-src" onMouseDown={e => e.preventDefault()} onClick={() => void showInBook(term)}
                      title="Open the source where this term is written">
                      Show in the book{term.src.length ? ` · ${sourceLabel(nb, term.src) ?? `p. ${term.src[0]}`}` : ""}
                    </button>
                  )}
                </div>
                <p>{term.meaning.length > 320 ? `${term.meaning.slice(0, 317)}…` : term.meaning}</p>
              </>
            )}
          </div>
        )}
        {!barOn && (
          <button type="button" className="nbk-show-bar" onClick={() => setBar(true)} aria-keyshortcuts="Control+Period"
            title="Show the formatting bar (Ctrl + .)">
            <span aria-live="polite">{st?.where ?? ""}</span> <ChevronUp size={13} /> Formatting <kbd>Ctrl .</kbd>
          </button>
        )}
      </div>

      <div className="nbk-under" ref={under} hidden={!barOn}>
        <span className="nbk-where" aria-live="polite">{st?.where ?? ""}</span>
        {st?.role === "section" ? (
          <input className="nbk-title" aria-label="Section title" value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() && title !== st.entryTitle) app.current?.renameEntry(st.entry, title.trim()); }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        ) : st?.entryTitle ? <span className="nbk-where">{st.entryTitle}</span> : null}
        <button type="button" className="nbk-pill" onClick={() => app.current?.newSection()}><Plus size={14} /> New section</button>
        <div className="nbk-bar" role="toolbar" aria-label="Formatting">
          <Tool label="Undo" disabled={!st?.canUndo} onClick={() => run(a => a.undo())}><Undo2 size={16} /></Tool>
          <Tool label="Redo" disabled={!st?.canRedo} onClick={() => run(a => a.redo())}><Redo2 size={16} /></Tool>
          <span className="nbk-sep" />
          <Tool label={`Smaller text (now ${SIZE_NAMES[sizeAt]})`} disabled={sizeAt === 0} onClick={() => stepSize(-1)}><AArrowDown size={16} /></Tool>
          <span className="nbk-size" aria-live="polite" title="Text size">{SIZE_NAMES[sizeAt]}</span>
          <Tool label={`Larger text (now ${SIZE_NAMES[sizeAt]})`} disabled={sizeAt === SIZES.length - 1} onClick={() => stepSize(1)}><AArrowUp size={16} /></Tool>
          <span className="nbk-sep" />
          <Tool label="Bold" pressed={!!st?.bold} onClick={() => run(a => a.toggle("bold"))}><Bold size={16} /></Tool>
          <Tool label="Italic" pressed={!!st?.italic} onClick={() => run(a => a.toggle("italic"))}><Italic size={16} /></Tool>
          <Tool label="Underline" pressed={!!st?.underline} onClick={() => run(a => a.toggle("underline"))}><Underline size={16} /></Tool>
          <Tool label="Strikethrough" pressed={!!st?.strike} onClick={() => run(a => a.toggle("strike"))}><Strikethrough size={16} /></Tool>
          <span className="nbk-sep" />
          <span className="nbk-menu">
            <Tool label="Text colour" pressed={menu === "color"} onClick={() => setMenu(m => (m === "color" ? null : "color"))}>
              <Type size={16} /><i className="nbk-swatch-bar" style={{ background: st?.color ?? INK_COLORS[0].value }} />
            </Tool>
            {menu === "color" && (
              <span className="nbk-palette" role="group" aria-label="Text colours">
                {INK_COLORS.map((c, i) => (
                  <button key={c.value} type="button" className="nbk-swatch" aria-label={c.name} style={{ background: c.value }}
                    onMouseDown={e => e.preventDefault()} onClick={() => run(a => a.setColor(i === 0 ? null : c.value))} />
                ))}
              </span>
            )}
          </span>
          <span className="nbk-menu">
            <Tool label="Highlight" pressed={menu === "highlight"} onClick={() => setMenu(m => (m === "highlight" ? null : "highlight"))}>
              <Highlighter size={16} /><i className="nbk-swatch-bar" style={{ background: st?.highlight ?? "transparent" }} />
            </Tool>
            {menu === "highlight" && (
              <span className="nbk-palette" role="group" aria-label="Highlight colours">
                <button type="button" className="nbk-swatch none" aria-label="No highlight"
                  onMouseDown={e => e.preventDefault()} onClick={() => run(a => a.setHighlight(null))} />
                {HIGHLIGHTS.map(c => (
                  <button key={c.value} type="button" className="nbk-swatch hl" aria-label={c.name} style={{ ["--swatch" as string]: c.value }}
                    onMouseDown={e => e.preventDefault()} onClick={() => run(a => a.setHighlight(c.value))} />
                ))}
              </span>
            )}
          </span>
          <span className="nbk-sep" />
          <Tool label="Heading (starts a new section)" pressed={on("heading")} onClick={() => para("heading")}><Heading size={16} /></Tool>
          <Tool label="Key point" pressed={on("key")} onClick={() => para("key")}><Star size={16} /></Tool>
          <Tool label="Bulleted list" pressed={on("bullet")} onClick={() => para("bullet")}><List size={16} /></Tool>
          <Tool label="Numbered list" pressed={on("numbered")} onClick={() => para("numbered")}><ListOrdered size={16} /></Tool>
          <Tool label="Checklist" pressed={on("check")} onClick={() => para("check")}><ListChecks size={16} /></Tool>
          <Tool label="Quote" pressed={on("quote")} onClick={() => para("quote")}><Quote size={16} /></Tool>
          <Tool label="Centre" pressed={on("center")} onClick={() => para("center")}><AlignCenter size={16} /></Tool>
          <Tool label="Clear formatting" onClick={() => run(a => a.clear())}><RemoveFormatting size={16} /></Tool>
          <span className="nbk-sep" />
          <span className="nbk-menu">
            <Tool label="Insert" pressed={menu === "insert"} onClick={() => setMenu(m => (m === "insert" ? null : "insert"))}><Plus size={16} /></Tool>
            {menu === "insert" && (
              <span className="nbk-palette nbk-list" role="menu" aria-label="Insert">
                <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()}
                  onClick={() => { setMenu(null); if (photo.current) { photo.current.value = ""; photo.current.click(); } }}><ImagePlus size={15} /> Photo</button>
                <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => run(a => a.insert("table"))}><Table size={15} /> Table</button>
                <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => run(a => a.insert("divider"))}><Minus size={15} /> Divider</button>
                <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => run(a => a.insert("date"))}><Clock size={15} /> Date and time</button>
              </span>
            )}
          </span>
          {nb.kind === "reading" && (
            <Tool label="Explain this chapter back, from memory" pressed={!!explaining} disabled={st?.role !== "section"}
              onClick={() => {
                const e = st && st.entry >= 0 ? app.current?.entries[st.entry] : null;
                setMenu(null);
                setExplaining(x => (x || !e ? null : { id: e.id, title: e.title }));
              }}>
              <MessageSquareText size={16} />
            </Tool>
          )}
          {nb.kind === "reading" && (
            <Tool label="Study this chapter: survey, read for questions, answer from memory" pressed={!!studying} disabled={st?.role !== "section"}
              onClick={() => {
                const e = st && st.entry >= 0 ? app.current?.entries[st.entry] : null;
                setMenu(null);
                setStudying(x => (x || !e ? null : { id: e.id, title: e.title }));
              }}>
              <BookOpenCheck size={16} />
            </Tool>
          )}
          <Tool label="Glossary: every unfamiliar term in these notes, underlined" pressed={glossary}
            onClick={() => { setMenu(null); setGlossary(g => !g); }}>
            <BookA size={16} />
          </Tool>
          <Tool label="Explain the selected words (basic or technical)" pressed={!!explainSel} disabled={!st?.selected && !explainSel}
            onClick={() => (explainSel ? setExplainSel(null) : explainSelection())}>
            <Lightbulb size={16} />
          </Tool>
          <Tool label="Mind map of the highlighted passage" pressed={!!mapSel} disabled={!st?.selected && !mapSel}
            onClick={() => (mapSel ? setMapSel(null) : mapSelection())}>
            <Network size={16} />
          </Tool>
          <span className="nbk-menu">
            <Tool label="Understand this paragraph: plainer, an example, an analogy, step by step, key terms" pressed={menu === "understand" || !!plainer}
              onClick={() => setMenu(m => (m === "understand" ? null : "understand"))}>
              <Sparkles size={16} />
            </Tool>
            {menu === "understand" && (
              <span className="nbk-palette nbk-list" role="menu" aria-label="Understand this paragraph">
                {UNDERSTAND_MODES.map(m => (
                  <button key={m.id} type="button" role="menuitem" title={m.hint} onMouseDown={e => e.preventDefault()} onClick={() => simplify(m.id)}>
                    {m.label}
                  </button>
                ))}
                <button type="button" role="menuitem" className="nbk-menu-split" title="One question about this paragraph; answer in your own words and see what you got"
                  onMouseDown={e => e.preventDefault()} onClick={checkParagraph}>
                  Check my understanding
                </button>
              </span>
            )}
          </span>
          <span className="nbk-menu">
            <Tool label="Paper, page colour and text size" pressed={menu === "theme"} onClick={() => setMenu(m => (m === "theme" ? null : "theme"))}><Palette size={16} /></Tool>
            {menu === "theme" && (
              <span className="nbk-palette nbk-look nbk-right">
                <span className="nbk-look-label" id="nbk-look-paper">Paper and cover</span>
                <span className="nbk-look-papers" role="radiogroup" aria-labelledby="nbk-look-paper">
                  {[...THEMES.map(t => ({ id: t.id as Paper, name: t.name })), { id: "auto" as Paper, name: "Match my system" }].map(t => (
                    <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} onClick={() => pickTheme(t.id)}>{t.name}</button>
                  ))}
                </span>
                <span className="nbk-look-label" id="nbk-look-colour">Page colour</span>
                <span className="nbk-look-colours" role="radiogroup" aria-labelledby="nbk-look-colour">
                  <button type="button" role="radio" aria-checked={!style.pageColor} className="nbk-page-swatch none"
                    aria-label="The paper's own colour" title="The paper's own colour" onClick={() => pickColor(null)} />
                  {PAGE_COLORS.map(c => (
                    <button key={c.id} type="button" role="radio" aria-checked={style.pageColor === c.id} className="nbk-page-swatch"
                      aria-label={c.name} title={c.name} style={{ background: c.paper, color: c.ink }} onClick={() => pickColor(c.id)}>Aa</button>
                  ))}
                </span>
                <span className="nbk-look-label" id="nbk-look-size">Text size</span>
                <span className="nbk-look-sizes" role="radiogroup" aria-labelledby="nbk-look-size">
                  {(["xs", "s", "m", "l", "xl"] as TextSize[]).map((sz, i) => (
                    <button key={sz} type="button" role="radio" aria-checked={(style.size ?? "m") === sz} onClick={() => pickSize(sz)}
                      aria-label={["Extra small", "Small", "Medium", "Large", "Extra large"][i]} style={{ fontSize: 9.5 + i * 2.5 }}>A</button>
                  ))}
                </span>
              </span>
            )}
          </span>
          <span className="nbk-sep" />
          <Tool label="Hide the formatting bar for a bigger book (Ctrl + .)" onClick={() => setBar(false)}><ChevronDown size={16} /></Tool>
        </div>
        {st && st.entry >= 0 && <span className="nbk-words">{st.words} {st.words === 1 ? "word" : "words"}</span>}

      </div>
    </div>
  );
}
