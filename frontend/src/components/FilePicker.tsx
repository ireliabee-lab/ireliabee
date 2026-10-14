import { useEffect, useState } from "react";
import { FileText, ArrowRight } from "lucide-react";
import { fetchApi } from "../lib/api";

interface LibraryFile { id: number; name: string; original_filename: string; }

/**
 * Tick Library reference files — a job spec, an agenda, slides, notes
 * (roadmap 2.5). Used by plans (the live coach reads them) and practice
 * (questions and feedback draw on them).
 */
export default function FilePicker({ value, onChange, emptyHint }: {
  value: number[];
  onChange: (ids: number[]) => void;
  emptyHint?: string;
}) {
  const [files, setFiles] = useState<LibraryFile[] | null>(null);
  useEffect(() => {
    fetchApi("/documents/").then(r => (r.ok ? r.json() : [])).then(setFiles).catch(() => setFiles([]));
  }, []);

  const openLibrary = () => window.dispatchEvent(new CustomEvent("navigate", { detail: "documents" }));

  if (files == null) return null;
  if (files.length === 0) {
    return (
      <div className="file-picker-empty">
        <span className="muted">{emptyHint ?? "No reference files yet — add a job spec, agenda, slides or notes to your Library."}</span>
        <button className="link-btn" onClick={openLibrary}>Open Library <ArrowRight size={11} /></button>
      </div>
    );
  }
  return (
    <div className="file-picker">
      {files.map(f => {
        const on = value.includes(f.id);
        return (
          <label key={f.id} className={on ? "on" : ""} title={f.original_filename}>
            <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter(x => x !== f.id) : [...value, f.id])} />
            <FileText size={13} />
            <span>{f.name}</span>
          </label>
        );
      })}
    </div>
  );
}
