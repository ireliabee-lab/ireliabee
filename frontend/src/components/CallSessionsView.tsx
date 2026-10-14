import { useEffect, useMemo, useState } from "react";
import { Search, ArrowUpDown, LayoutGrid, List, MoreVertical, Clipboard, ScrollText, Circle, Play, Sparkles, Mail, Phone, Keyboard, Mic, Clock, Info, X, Plus, GraduationCap } from "lucide-react";
import toast from "react-hot-toast";
import ConfirmDialog from "./ConfirmDialog";
import Illustration from "./Illustration";
import Page, { PageTab } from "./Page";
import SessionHub, { HUB_TABS, isHubTab, type HubTab } from "./session/SessionHub";
import { fetchApi } from "../lib/api";

interface Session {
  id: number;
  title: string;
  subtitle?: string | null;
  mode: string;
  status?: string | null;   // 'draft' | 'active' | 'paused' | 'ended' | null
  duration_sec?: number;
  tags?: string[];
  llm_provider?: string;
  llm_model?: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  paused_at?: string | null;
  saved_at?: string | null;
  turns: number;
}

const FILTERS: { id: string; label: string; test: (s: Session) => boolean }[] = [
  { id: "all",    label: "All",    test: () => true },
  { id: "saved",  label: "Saved",  test: s => !!s.saved_at },
  // "Active" bundles drafts (Ready to Start) + active — everything still workable
  { id: "active", label: "Active", test: s => statusOf(s) === "active" || statusOf(s) === "draft" },
  { id: "paused", label: "Paused", test: s => statusOf(s) === "paused" },
  { id: "ended",  label: "Ended",  test: s => statusOf(s) === "ended" },
  { id: "mock",   label: "Mock",   test: s => isMockSession(s) },
];

function formatDate(iso: string): string {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
}
function formatDuration(sec: number): string {
  if (!sec) return "0m 0s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
const STATUS_LABEL = { ended: "Ended", active: "Active", paused: "Paused", draft: "Ready to Start" } as const;

function sessionKind(s: Session): { icon: React.ReactNode; label: string } {
  if (s.mode === "lecture") return { icon: <GraduationCap size={11} />, label: "Lecture" };
  if (!isMockSession(s)) return { icon: <Mic size={11} />, label: "Live session" };
  const voice = (s.tags || []).map(t => t.toLowerCase()).includes("voice");
  return voice ? { icon: <Phone size={11} />, label: "Mock call" } : { icon: <Keyboard size={11} />, label: "Mock typed" };
}

function isMockSession(s: Session): boolean {
  return (s.tags || []).map(t => t.toLowerCase()).includes("mock") || (s.mode || "").toLowerCase().includes("mock");
}
function statusOf(s: Session): "draft" | "active" | "paused" | "ended" {
  // A mock interview can't be picked up halfway: once it's left, it's over.
  if (isMockSession(s)) return "ended";
  const st = (s.status || "draft") as "draft" | "active" | "paused" | "ended";
  return ["draft", "active", "paused", "ended"].includes(st) ? st : "draft";
}

/** `section`: set when arriving from a merged screen (e.g. the old Confidence page). */
export default function CallSessionsView({ section }: { section?: string } = {}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState<string>("all");
  const [search, setSearch]     = useState<string>("");
  const [sortDesc, setSortDesc] = useState<boolean>(true);
  const [view, setView]         = useState<"grid" | "list">("grid");
  const [menuOpen, setMenuOpen] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; title: string } | null>(null);
  // The session hub: transcript and every report for one session (roadmap 1.2).
  const [hubFor, setHubFor] = useState<{ session: Session; tab: HubTab } | null>(null);
  const cameFrom = isHubTab(section) && section !== "transcript" ? section : null;
  const [showMoved, setShowMoved] = useState(!!cameFrom);
  const review = (s: Session, tab: HubTab = cameFrom ?? (statusOf(s) === "ended" ? "transcript" : "debrief")) =>
    setHubFor({ session: s, tab });

  const load = () => {
    setLoading(true);
    fetchApi("/sessions/")
      .then(r => r.json())
      .then(setSessions)
      .catch(() => toast.error("Failed to load sessions"))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  // Arriving with "open:<id>" (from the Research or Wordcraft calendar): open that session's hub.
  const openId = section?.startsWith("open:") ? Number(section.slice(5)) : null;
  useEffect(() => {
    if (!openId || !sessions.length) return;
    const s = sessions.find(x => x.id === openId);
    if (s) review(s, "debrief");                              // a practice round: its score and feedback
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, sessions]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = sessions.filter(FILTERS.find(f => f.id === filter)!.test);
    if (q) {
      list = list.filter(s =>
        s.title.toLowerCase().includes(q) ||
        (s.subtitle || "").toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      const ta = new Date(a.updated_at).getTime();
      const tb = new Date(b.updated_at).getTime();
      return sortDesc ? tb - ta : ta - tb;
    });
    return list;
  }, [sessions, filter, search, sortDesc]);

  const openSession = async (s: Session) => {
    try {
      const res = await fetchApi(`/sessions/${s.id}/messages`);
      if (!res.ok) throw new Error();
      const messages = await res.json();
      // Ask App.tsx to switch to Session view AND pass the session to open
      window.dispatchEvent(new CustomEvent("open-session", {
        detail: { sessionId: s.id, messages, title: s.title, subtitle: s.subtitle },
      }));
      const st = statusOf(s);
      toast.success(st === "ended" ? `Reviewing "${s.title}"` : st === "draft" ? `Starting "${s.title}"` : `Resumed "${s.title}"`);
    } catch { toast.error("Failed to load messages"); }
  };

  const endSession = async (id: number) => {
    const res = await fetchApi(`/sessions/${id}/end`, { method: "POST" });
    if (res.ok) { toast.success("Session ended"); load(); }
    else toast.error("Failed to end session");
  };

  const rename = async (id: number, value: string) => {
    if (!value.trim()) return;
    const res = await fetchApi(`/sessions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: value.trim() }),
    });
    if (res.ok) { toast.success("Renamed"); setRenaming(null); load(); }
    else toast.error("Rename failed");
  };

  const del = async (id: number) => {
    const res = await fetchApi(`/sessions/${id}`, { method: "DELETE" });
    if (res.ok) { toast.success("Deleted"); load(); }
    else toast.error("Delete failed");
    setConfirmDelete(null);
  };

  return (
    <Page
      title="Sessions"
      subtitle="Prepare for calls and review past ones — transcript, debrief, confidence, notes and follow-up email in one place."
      actions={
        <button className="btn-primary" onClick={() => window.dispatchEvent(new Event("start-new-session"))}>
          <Plus size={14} /> New session
        </button>
      }
      tabs={FILTERS.map(f => (
        <PageTab key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)} count={sessions.filter(f.test).length}>
          {f.label}
        </PageTab>
      ))}
    >
    <div className="page-content">
      {showMoved && cameFrom && (
        <div className="moved-note">
          <Info size={14} />
          <span>
            <strong>{HUB_TABS.find(t => t.id === cameFrom)?.label}</strong> now lives inside each session:
            choose <strong>Review</strong> on a session to see it with the transcript, debrief and notes.
          </span>
          <button onClick={() => setShowMoved(false)} title="Dismiss"><X size={13} /></button>
        </div>
      )}

      {/* Toolbar */}
      <div className="page-toolbar">
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
          <input
            className="glass-input"
            style={{ paddingLeft: 30, height: 32, fontSize: 12 }}
            placeholder="Search by title or description"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button className="btn-neutral" style={{ padding: "6px 10px" }} onClick={() => setSortDesc(v => !v)} title={sortDesc ? "Sort: newest first" : "Sort: oldest first"}>
          <ArrowUpDown size={13} />
        </button>
        <div className="page-toolbar-end">
        <span className="muted" style={{ fontSize: 12 }}>
          {visible.length} {visible.length === 1 ? "session" : "sessions"}
        </span>
        <div style={{ display: "flex", gap: 2, background: "rgba(var(--ink-rgb),0.04)", borderRadius: 6, padding: 2 }}>
          <button
            onClick={() => setView("grid")}
            className="view-toggle"
            data-active={view === "grid"}
            title="Grid view"
          >
            <LayoutGrid size={13} />
          </button>
          <button
            onClick={() => setView("list")}
            className="view-toggle"
            data-active={view === "list"}
            title="List view"
          >
            <List size={13} />
          </button>
        </div>
        </div>
      </div>

      {loading && <p className="muted" style={{ fontSize: 13 }}>Loading…</p>}

      {!loading && visible.length === 0 && (sessions.length === 0 ? (
        <div className="glass-card plans-empty">
          <Illustration name="listen" />
          <div className="plans-empty-title">No sessions yet</div>
          <p className="muted">A session is one call: the coach listens, answers and keeps the transcript. Afterwards
            its debrief, notes and follow-up email live here.</p>
          <button className="btn-primary" onClick={() => window.dispatchEvent(new Event("start-new-session"))}>
            <Plus size={14} /> New session
          </button>
        </div>
      ) : (
        <div style={{ padding: 40, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>No sessions match this filter.</p>
        </div>
      ))}

      {!loading && visible.length > 0 && view === "grid" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 14,
        }}>
          {visible.map(s => (
            <SessionCard
              key={s.id}
              session={s}
              menuOpen={menuOpen === s.id}
              renaming={renaming?.id === s.id ? renaming.value : null}
              onMenuOpen={() => setMenuOpen(m => m === s.id ? null : s.id)}
              onMenuClose={() => setMenuOpen(null)}
              onStartRename={() => setRenaming({ id: s.id, value: s.title })}
              onRenameChange={v => setRenaming({ id: s.id, value: v })}
              onRenameCommit={() => rename(s.id, renaming!.value)}
              onCancelRename={() => setRenaming(null)}
              onDelete={() => setConfirmDelete({ id: s.id, title: s.title })}
              onOpen={() => openSession(s)}
              onEnd={() => endSession(s.id)}
              onReview={() => review(s)}
              onEmail={() => review(s, "email")}
            />
          ))}
        </div>
      )}

      {!loading && visible.length > 0 && view === "list" && (
        <div className="session-list">
          {visible.map(s => {
            const st = statusOf(s);
            const kind = sessionKind(s);
            return (
              <div key={s.id} className={`session-row st-${st}`} onClick={() => (st === "ended" ? review(s) : openSession(s))}>
                <span className="sc-kind">{kind.icon}{kind.label}</span>
                <div className="session-row-main">
                  <div className="sc-title" title={s.title}>{s.title || "(untitled)"}</div>
                  <div className="sc-sub">{s.subtitle || s.mode}</div>
                </div>
                <div className="sc-meta session-row-meta">
                  <span className="sc-status"><i />{STATUS_LABEL[st]}</span>
                  <span><Clock size={11} /> {formatDuration(s.duration_sec || 0)}</span>
                  <span><ScrollText size={11} /> {s.turns}</span>
                  <span className="session-row-date">{formatDate(s.updated_at)}</span>
                </div>
                {s.turns > 0 && (
                  <div className="session-row-actions" onClick={e => e.stopPropagation()}>
                    <button className="sc-btn" onClick={() => review(s)} title="Transcript, debrief, confidence, notes"><Sparkles size={12} /> Review</button>
                    <button className="sc-btn" onClick={() => review(s, "email")} title="Write a thank-you or follow-up email"><Mail size={12} /> Email</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>

    {hubFor && (
      <SessionHub
        key={`${hubFor.session.id}-${hubFor.tab}`}
        sessionId={hubFor.session.id}
        title={hubFor.session.title || "(untitled)"}
        subtitle={hubFor.session.subtitle}
        initialTab={hubFor.session.mode === "lecture" && ["debrief", "confidence", "email"].includes(hubFor.tab) ? "study" : hubFor.tab}
        lecture={hubFor.session.mode === "lecture"}
        onClose={() => setHubFor(null)}
        onResume={statusOf(hubFor.session) === "ended" ? undefined : () => { const s = hubFor.session; setHubFor(null); openSession(s); }}
      />
    )}

    {confirmDelete && (
      <ConfirmDialog
        message={`Delete "${confirmDelete.title}"?`}
        detail="This session and all its messages will be permanently removed. Its notebook stays on your Notebook shelf."
        confirmLabel="Delete"
        onConfirm={() => del(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)}
      />
    )}
    </Page>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
function statusColor(st: "draft" | "active" | "paused" | "ended"): string {
  if (st === "ended")  return "#94a3b8";
  if (st === "active") return "#22c55e";
  if (st === "paused") return "#38bdf8";  // sky-blue
  return "#f59e0b";                        // draft = amber
}
function StatusDot({ s }: { s: Session }) {
  const color = statusColor(statusOf(s));
  return <Circle size={9} fill={color} color={color} strokeWidth={0} style={{ flexShrink: 0 }} />;
}


function SessionCard({
  session, menuOpen, renaming,
  onMenuOpen, onMenuClose, onStartRename, onRenameChange, onRenameCommit, onCancelRename,
  onDelete, onOpen, onEnd, onReview, onEmail,
}: {
  session: Session;
  menuOpen: boolean;
  renaming: string | null;
  onMenuOpen: () => void;
  onMenuClose: () => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onEnd: () => void;
  onReview: () => void;
  onEmail: () => void;
}) {
  const st = statusOf(session);
  const dotColor = statusColor(st);
  const statusLabel = st === "ended" ? "Ended" : st === "active" ? "Active" : st === "paused" ? "Paused" : "Ready to Start";
  const tags = session.tags || [];
  const isMock = tags.map(t => t.toLowerCase()).includes("mock");

  const kind = sessionKind(session);
  const primaryLabel = st === "ended" ? "Review" : st === "draft" ? "Start" : "Resume";

  return (
    <div className={`session-card st-${st}`}>
      <div className="sc-top">
        <span className="sc-kind">{kind.icon}{kind.label}</span>
        <span className="sc-date">{formatDate(session.updated_at)}</span>
        <button className="card-menu-btn" onClick={onMenuOpen} title="More">
          <MoreVertical size={14} />
        </button>
        {menuOpen && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={onMenuClose} />
            <div className="card-menu">
              <button onClick={() => { onStartRename(); onMenuClose(); }}>Rename</button>
              {st !== "ended" && (
                <button onClick={() => { onEnd(); onMenuClose(); }}>End session</button>
              )}
              <button onClick={() => { onDelete(); onMenuClose(); }} style={{ color: "var(--tone-red)" }}>Delete</button>
            </div>
          </>
        )}
      </div>

      <div className="sc-body">
        {renaming !== null ? (
          <input
            className="glass-input"
            style={{ fontSize: 14, fontWeight: 600, padding: "5px 8px", height: 30 }}
            value={renaming}
            autoFocus
            onChange={e => onRenameChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") onRenameCommit();
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={onRenameCommit}
          />
        ) : (
          <div className="sc-title" title={session.title}>{session.title || "(untitled)"}</div>
        )}
        {(session.subtitle || session.mode) && <div className="sc-sub">{session.subtitle || session.mode}</div>}
      </div>

      <div className="sc-meta">
        <span className="sc-status"><i />{statusLabel}</span>
        {session.turns > 0 ? (
          <>
            <span><Clock size={11} /> {formatDuration(session.duration_sec || 0)}</span>
            <span><ScrollText size={11} /> {session.turns} turn{session.turns !== 1 ? "s" : ""}</span>
          </>
        ) : (
          <span>No usage yet</span>
        )}
      </div>

      <div className="sc-actions">
        {session.turns > 0 && (
          <>
            {st !== "ended" && (
              <button className="sc-btn" onClick={onReview} title="Transcript, debrief, confidence, notes">
                <Sparkles size={12} /> Review
              </button>
            )}
            <button className="sc-btn" onClick={onEmail} title="Write a thank-you or follow-up email">
              <Mail size={12} /> Email
            </button>
          </>
        )}
        <button className={`sc-btn sc-primary ${st === "ended" ? "quiet" : ""}`} onClick={st === "ended" ? onReview : onOpen}>
          {st === "ended" ? <Sparkles size={12} /> : <Play size={12} />} {primaryLabel}
        </button>
      </div>
    </div>
  );
}


function Chip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 8px",
      borderRadius: 999,
      background: "rgba(var(--ink-rgb),0.05)",
      color: "var(--muted)",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: 0.02,
    }}>
      {icon} {label}
    </span>
  );
}
