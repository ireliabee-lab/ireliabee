import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight, Download, Upload, Loader2, ShieldCheck, Check, FileJson, AlertTriangle,
} from "lucide-react";
import toast from "react-hot-toast";
import { fetchApi, apiMediaUrl } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";
import GlassSelect from "./GlassSelect";

/**
 * Move prep work between installs: export the selected data as one JSON file,
 * hand it to someone else, and they import it into their own profile.
 *
 * API keys and session transcripts are deliberately not transferable — see
 * backend/transfer.py.
 */

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

// Order shown in the UI. `heavy` sections stay off by default: they're bulky
// or personal, so sharing them should be a deliberate tick.
const SECTIONS: { id: string; label: string; hint: string; heavy?: boolean }[] = [
  { id: "profiles",    label: "Profiles",        hint: "Name, background, strengths, the context the coach speaks from" },
  { id: "plans",       label: "Meeting plans",   hint: "Agendas, questions to ask, traps to avoid, commitments" },
  { id: "stories",     label: "Your stories",    hint: "The STAR story bank answers are built on" },
  { id: "drills",      label: "Practice history", hint: "Explain-clearly scores over time", heavy: true },
  { id: "cvs",         label: "CVs & resumes",   hint: "Original files, carried inside the JSON", heavy: true },
  { id: "documents",   label: "Documents",       hint: "Job specs, briefs and other reference material", heavy: true },
  { id: "preferences", label: "Preferences",     hint: "Language, response style and other settings — never any keys", heavy: true },
  { id: "research",    label: "Research Track",  hint: "Your level, term cards and their review schedule, paper cards, lessons, projects and mentor sign-offs", heavy: true },
  { id: "wordcraft",   label: "Wordcraft",       hint: "Your realm, cards and their review schedule, lessons, exercises, writing, missions and streak", heavy: true },
  { id: "writing",     label: "Writing projects", hint: "Your essays, reviews, papers and proposals: each with its sections, plan and stage ticks" },
];

interface Profile { id: number; name: string; is_active: number; }
interface Inspection {
  exported_at: string;
  app_version: string;
  counts: Record<string, number>;
  preview: Record<string, string[]>;
  sections: string[];
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  return isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function Toggle({ checked, onChange, label, hint, count }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; count?: number;
}) {
  return (
    <label className={`transfer-row ${checked ? "on" : ""}`}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="transfer-row-body">
        <span className="transfer-row-title">
          {label}
          {count !== undefined && <span className="transfer-count">{count}</span>}
        </span>
        <span className="muted transfer-row-hint">{hint}</span>
      </span>
    </label>
  );
}

export default function TransferView() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [profiles, setProfiles] = useState<Profile[]>([]);

  // Export
  const [picked, setPicked] = useState<string[]>(["profiles", "plans", "stories"]);
  const [scope, setScope] = useState("all");

  // Import
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [importPicked, setImportPicked] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState("skip");
  const [target, setTarget] = useState("keep");
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<Record<string, { imported: number; skipped: number }> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    fetchApi("/transfer/summary").then(r => r.json()).then(d => setCounts(d.counts || {}))
      .catch(() => toast.error("Failed to read your data"));
    fetchApi("/profiles/").then(r => r.json()).then(setProfiles).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const toggle = (list: string[], set: (v: string[]) => void) => (id: string, on: boolean) =>
    set(on ? [...list, id] : list.filter(s => s !== id));

  const exportHref = () => {
    const params = new URLSearchParams({ include: picked.join(","), app_version: __APP_VERSION__ });
    if (scope !== "all") params.set("profile_id", scope);
    // A link cannot send a header: the token rides in the URL (audit 180-C3).
    return apiMediaUrl(`/transfer/export?${params.toString()}`);
  };

  const nothingToExport = picked.length === 0
    || picked.every(s => (counts[s] ?? 0) === 0);

  const reset = () => {
    setFile(null); setInspection(null); setReport(null); setImportPicked([]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const inspect = async (f: File) => {
    if (!/\.json$/i.test(f.name) || f.size > MAX_BUNDLE_BYTES) {
      notifyError(f.size > MAX_BUNDLE_BYTES
        ? { title: "File too large", message: "Transfer files can be up to 50 MB." }
        : { title: "Not a transfer file", message: "Pick the .json file the app exported." });
      reset();
      return;
    }
    setReading(true); setReport(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetchApi("/transfer/inspect", { method: "POST", body: fd });
      if (!res.ok) throw await errorFromResponse(res);
      const info: Inspection = await res.json();
      setFile(f);
      setInspection(info);
      setImportPicked(info.sections.filter(s => (info.counts[s] ?? 0) > 0));
    } catch (e) {
      notifyError(e);
      reset();
    } finally {
      setReading(false);
    }
  };

  const runImport = async () => {
    if (!file || importPicked.length === 0) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("include", importPicked.join(","));
      fd.append("duplicates", duplicates);
      if (target !== "keep") fd.append("target_profile_id", target);
      const res = await fetchApi("/transfer/import", { method: "POST", body: fd });
      if (!res.ok) throw await errorFromResponse(res);
      const data = await res.json();
      setReport(data.report);
      const total = Object.values(data.report as Record<string, { imported: number }>)
        .reduce((n, r) => n + r.imported, 0);
      toast.success(total ? `Imported ${total} item${total === 1 ? "" : "s"}` : "Nothing new to import");
      load();
    } catch (e) {
      notifyError(e);
    } finally {
      setImporting(false);
    }
  };

  const labelOf = (id: string) => SECTIONS.find(s => s.id === id)?.label ?? id;

  return (
    <div className="plans-page">
      <div className="plans-header">
        <div>
          <h2>Your data</h2>
          <p className="muted">
            Export your plans, profile and stories as one file — then import it on another machine
            or into someone else's copy of iReliabee.
          </p>
        </div>
      </div>

      <section className="glass-card transfer-note">
        <ShieldCheck size={15} />
        <span className="muted">
          Your sessions, transcripts, CVs and notes are stored on this machine, not on ours, and
          travel only in the file you export. Running the AI sends what a session needs to
          iReliabee, which keeps none of it.
        </span>
      </section>

      <div className="transfer-cols">
      {/* ── Export ─────────────────────────────────────────────────────── */}
      <section className="glass-card plan-form">
        <div className="transfer-head">
          <Download size={15} />
          <span className="plan-section-title">Export</span>
        </div>

        <div className="transfer-rows">
          {SECTIONS.map(s => (
            <Toggle
              key={s.id}
              checked={picked.includes(s.id)}
              onChange={on => toggle(picked, setPicked)(s.id, on)}
              label={s.label}
              hint={s.hint}
              count={counts[s.id]}
            />
          ))}
        </div>

        <div className="transfer-actions">
          <div className="transfer-scope">
            <label className="settings-label">Profile to export</label>
            <GlassSelect
              value={scope}
              onChange={setScope}
              options={[
                { id: "all", label: "All profiles" },
                ...profiles.map(p => ({ id: String(p.id), label: p.name })),
              ]}
              style={{ minWidth: 200 }}
            />
          </div>
          <a
            className="btn-primary transfer-export-btn"
            href={nothingToExport ? undefined : exportHref()}
            download
            aria-disabled={nothingToExport}
            onClick={e => {
              if (nothingToExport) { e.preventDefault(); return; }
              toast.success("Export saved to your downloads");
            }}
          >
            <Download size={14} /> Export JSON
          </a>
        </div>
        {picked.includes("plans") && scope !== "all" && (
          <span className="muted transfer-hint">Only plans belonging to that profile are exported.</span>
        )}
        {picked.includes("documents") && (
          <span className="muted transfer-hint">Papers and books over 20 MB stay behind — upload those again on the other computer.</span>
        )}
      </section>

      {/* ── Import ─────────────────────────────────────────────────────── */}
      <section className="glass-card plan-form">
        <div className="transfer-head">
          <Upload size={15} />
          <span className="plan-section-title">Import</span>
        </div>

        {!inspection && (
          <>
            <p className="muted transfer-hint">
              Pick a file exported from iReliabee. You'll see what's inside before anything is written.
            </p>
            <label className="btn-neutral transfer-pick" style={{ cursor: reading ? "wait" : "pointer" }}>
              {reading ? <Loader2 size={14} className="spin" /> : <FileJson size={14} />}
              {reading ? "Reading…" : "Choose a transfer file"}
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) inspect(f); }}
              />
            </label>
          </>
        )}

        {inspection && (
          <>
            <div className="transfer-filemeta">
              <FileJson size={14} />
              <span>{file?.name}</span>
              {inspection.exported_at && (
                <span className="muted">
                  · exported {formatWhen(inspection.exported_at)}
                  {inspection.app_version ? ` · v${inspection.app_version}` : ""}
                </span>
              )}
              <button className="btn-neutral small" onClick={reset} style={{ marginLeft: "auto" }}>
                Choose another
              </button>
            </div>

            {inspection.sections.length === 0 && (
              <p className="muted transfer-hint">
                <AlertTriangle size={13} /> There's nothing in this file to import.
              </p>
            )}

            <div className="transfer-rows">
              {SECTIONS.filter(s => inspection.sections.includes(s.id)).map(s => {
                const names = inspection.preview[s.id];
                return (
                  <Toggle
                    key={s.id}
                    checked={importPicked.includes(s.id)}
                    onChange={on => toggle(importPicked, setImportPicked)(s.id, on)}
                    label={s.label}
                    hint={names?.length ? names.join(" · ") : s.hint}
                    count={inspection.counts[s.id]}
                  />
                );
              })}
            </div>

            <div className="plan-grid-2">
              <div>
                <label className="settings-label">If something is already here</label>
                <GlassSelect
                  value={duplicates}
                  onChange={setDuplicates}
                  options={[
                    { id: "skip", label: "Keep mine, skip theirs" },
                    { id: "add", label: "Import as a second copy" },
                  ]}
                />
              </div>
              <div>
                <label className="settings-label">Attach imported plans to</label>
                <GlassSelect
                  value={target}
                  onChange={setTarget}
                  options={[
                    { id: "keep", label: "The profile from the file" },
                    ...profiles.map(p => ({
                      id: String(p.id),
                      label: p.is_active ? `${p.name} (active)` : p.name,
                    })),
                  ]}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn-primary" onClick={runImport}
                      disabled={importing || importPicked.length === 0}>
                {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                {importing ? "Importing…" : "Import"}
              </button>
            </div>
          </>
        )}

        {report && (
          <div className="transfer-report">
            {Object.entries(report).map(([id, r]) => (
              <div key={id} className="transfer-report-row">
                <Check size={13} />
                <span>{labelOf(id)}</span>
                <span className="muted">
                  {r.imported} imported{r.skipped ? ` · ${r.skipped} already here` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      </div>

      <p className="muted transfer-hint">
        <ArrowLeftRight size={13} /> Sessions, meeting notes and confidence reports stay on the
        machine that recorded them.
      </p>
    </div>
  );
}
