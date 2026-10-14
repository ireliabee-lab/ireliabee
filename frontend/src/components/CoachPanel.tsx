import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useEffect, useState } from "react";
import { Volume2, Loader2, Copy, Check, WrapText, Languages } from "lucide-react";
import { fetchApi } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";

interface Props {
  reply: string;
  /** When you read in another language than the call (docs/translation.md, T1): the answer as you'd say it. */
  sayIn?: { language: string; fetch: () => Promise<string> };
}

// New replies: SHORT / FULL. Older saved replies: SAY / ANALYSIS / WHY —
// only their SAY part is shown.
export function parseReply(reply: string) {
  const sections: Record<string, string> = {};
  const pattern = /^\s*(CUES|SHORT|FULL|SAY|ANALYSIS|WHY|PRONOUNCE)\s*:\s*/gim;
  // Lines inside ``` code blocks (e.g. `full: int = 0`) are code, not headings.
  const fences = [...reply.matchAll(/```[\s\S]*?(```|$)/g)].map(f => [f.index!, f.index! + f[0].length]);
  const matches = [...reply.matchAll(pattern)]
    .filter(m => !fences.some(([a, b]) => m.index! > a && m.index! < b));
  if (!matches.length) return { cues: [] as string[], short: "", full: reply.trim(), pronounce: [] as Pronunciation[] };
  matches.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = matches[i + 1]?.index ?? reply.length;
    // Drop a trailing "---" rule the model sometimes puts before the next heading.
    sections[m[1].toUpperCase()] = reply.slice(start, end).trim().replace(/\n*-{3,}$/, "").trim();
  });
  const cues = (sections.CUES ?? "")
    .split("\n")
    .map(l => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const pronounce = (sections.PRONOUNCE ?? "")
    .split("\n")
    .map(l => l.replace(/^\s*[-•*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .map(l => {
      const [word, sounds = "", tip = ""] = l.split(/\s+[—–-]\s+/);
      return { word: word.trim(), sounds: sounds.trim(), tip: tip.trim() };
    })
    .filter(p => p.word)
    .slice(0, 4);
  return { cues, short: sections.SHORT ?? "", full: sections.FULL ?? sections.SAY ?? "", pronounce };
}

export interface Pronunciation { word: string; sounds: string; tip: string; }

let playing: HTMLAudioElement | null = null;

function PronounceChip({ p }: { p: Pronunciation }) {
  const [loading, setLoading] = useState(false);
  async function play() {
    setLoading(true);
    try {
      const res = await fetchApi(`/mock/pronounce?text=${encodeURIComponent(p.word)}`);
      if (!res.ok) throw await errorFromResponse(res);
      const url = URL.createObjectURL(await res.blob());
      playing?.pause();
      playing = new Audio(url);
      playing.onended = () => URL.revokeObjectURL(url);
      await playing.play();
    } catch (e) { notifyError(e); } finally { setLoading(false); }
  }
  return (
    <button className="pronounce-chip" onClick={play} title={`Hear "${p.word}"`}>
      {loading ? <Loader2 size={12} className="spin" /> : <Volume2 size={12} />}
      <strong>{p.word}</strong>
      {p.sounds && <span className="pronounce-sounds">{p.sounds}</span>}
      {p.tip && <small>{p.tip}</small>}
    </button>
  );
}

// Display names for fenced-code languages (and highlight.js's detected names).
const LANGUAGE_NAMES: Record<string, string> = {
  py: "Python", python: "Python", java: "Java", js: "JavaScript", javascript: "JavaScript",
  jsx: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript",
  c: "C", cpp: "C++", "c++": "C++", cc: "C++", cs: "C#", csharp: "C#", go: "Go", golang: "Go",
  rust: "Rust", rs: "Rust", kotlin: "Kotlin", kt: "Kotlin", swift: "Swift", scala: "Scala",
  ruby: "Ruby", rb: "Ruby", php: "PHP", sql: "SQL", bash: "Bash", sh: "Shell", shell: "Shell",
  json: "JSON", yaml: "YAML", yml: "YAML", xml: "XML", html: "HTML", css: "CSS",
  r: "R", lua: "Lua", dart: "Dart", perl: "Perl", plaintext: "Text", text: "Text",
};

// Wrap long code lines (off = scroll sideways like an editor). One setting for all blocks.
const WRAP_KEY = "codeWrap";
function readWrap(): boolean {
  try { return localStorage.getItem(WRAP_KEY) === "1"; } catch { return false; }
}

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] };

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** A fenced code block, rendered like an editor pane: language, line numbers, Dark+ colours. */
function CodeBlock({ node, children, ...props }: React.HTMLAttributes<HTMLPreElement> & { node?: HastNode }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(readWrap);
  useEffect(() => {
    const sync = () => setWrap(readWrap());
    window.addEventListener("code-wrap", sync);
    return () => window.removeEventListener("code-wrap", sync);
  }, []);
  function toggleWrap() {
    try { localStorage.setItem(WRAP_KEY, wrap ? "0" : "1"); } catch { /* ignore */ }
    window.dispatchEvent(new Event("code-wrap"));
  }
  const codeEl = node?.children?.find(c => c.type === "element" && c.tagName === "code");
  const classes = Array.isArray(codeEl?.properties?.className) ? (codeEl!.properties!.className as string[]) : [];
  const lang = classes.find(c => c.startsWith("language-"))?.slice("language-".length).toLowerCase();
  const source = hastText(codeEl).replace(/\n$/, "");
  const lineCount = source ? source.split("\n").length : 1;

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className={`code-block ide ${wrap ? "wrap" : ""}`}>
      <div className="code-head">
        <span className="code-dots" aria-hidden><i /><i /><i /></span>
        <span className="code-lang">{lang ? (LANGUAGE_NAMES[lang] ?? lang) : "Code"}</span>
        <span className="code-meta">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
        <button className={`code-wrap-toggle ${wrap ? "on" : ""}`} onClick={toggleWrap}
          title={wrap ? "Long lines wrap — click to scroll sideways instead" : "Long lines scroll sideways — click to wrap them"}>
          <WrapText size={12} /> Wrap
        </button>
        <button className="code-copy" onClick={copy} title="Copy code">
          {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="code-body">
        {/* Line numbers only line up when lines don't wrap */}
        {!wrap && (
          <div className="code-gutter" aria-hidden>
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </div>
        )}
        <pre {...props}>{children}</pre>
      </div>
    </div>
  );
}

function Body({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Colour code like an IDE; guess the language when the fence doesn't name one.
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
        components={{ pre: ({ node, ...p }) => <CodeBlock node={node as unknown as HastNode} {...p} /> }}
      >{text}</ReactMarkdown>
    </div>
  );
}

export default function CoachPanel({ reply, sayIn }: Props) {
  const { cues, short, full, pronounce } = parseReply(reply);
  const [spoken, setSpoken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!cues.length && !short && !full) return null;
  const said = spoken ? parseReply(spoken) : null;
  async function translate() {
    if (!sayIn) return;
    setBusy(true); setFailed(false);
    try { setSpoken(await sayIn.fetch()); } catch { setFailed(true); } finally { setBusy(false); }
  }
  return (
    <div className="coach-panel" style={{ overflow: "auto" }}>
      {cues.length > 0 && (
        <div className="cue-cards">
          {cues.map((cue, i) => (
            <div key={i} className="cue-card" style={{ animationDelay: `${i * 60}ms` }}>
              <span>{i + 1}</span>
              <p>{cue}</p>
            </div>
          ))}
        </div>
      )}
      <div className="coach-section">
        <div className="coach-section-label say">TALKING POINTS</div>
        {short && (
          <div className="say-version">
            <div className="say-version-label">Short</div>
            <div className="coach-section-body"><Body text={short} /></div>
          </div>
        )}
        {full && (
          <div className="say-version">
            {short && <div className="say-version-label">Full answer</div>}
            <div className="coach-section-body"><Body text={full} /></div>
          </div>
        )}
      </div>
      {sayIn && (short || full) && !said && (
        <button type="button" className="say-in-btn" onClick={() => void translate()} disabled={busy}
          title={`The answer to say, in ${sayIn.language}: one small AI call`}>
          {busy ? <Loader2 size={12} className="spin" /> : <Languages size={12} />} Say it in {sayIn.language}
          {failed && <span className="say-in-failed"> · didn't work, try again</span>}
        </button>
      )}
      {said && (
        <div className="coach-section say-in">
          <div className="coach-section-label say">TO SAY, IN {sayIn?.language.toUpperCase()}</div>
          {said.short && <div className="say-version"><div className="say-version-label">Short</div><div className="coach-section-body"><Body text={said.short} /></div></div>}
          {said.full && <div className="say-version">{said.short && <div className="say-version-label">Full answer</div>}<div className="coach-section-body"><Body text={said.full} /></div></div>}
        </div>
      )}
      {pronounce.length > 0 && (
        <div className="pronounce-row">
          <div className="say-version-label">Pronounce</div>
          <div className="pronounce-chips">{pronounce.map(p => <PronounceChip key={p.word} p={p} />)}</div>
        </div>
      )}
    </div>
  );
}

export function ToneBadge({ tone }: { tone?: string }) {
  if (!tone) return null;
  const basic = tone === "basic";
  return (
    <span
      title={basic ? "Plain, everyday language" : "Technical, expert-depth language"}
      style={{
        marginLeft: "auto", padding: "1px 7px", borderRadius: 999, fontSize: 9,
        whiteSpace: "nowrap", flexShrink: 0,
        fontWeight: 700, letterSpacing: "0.06em",
        color: basic ? "var(--tone-green)" : "var(--primary-hover)",
        background: basic ? "rgba(16,185,129,0.12)" : "rgba(var(--accent-rgb),0.14)",
      }}
    >
      {basic ? "BASIC LANGUAGE" : "ADVANCED LANGUAGE"}
    </span>
  );
}
