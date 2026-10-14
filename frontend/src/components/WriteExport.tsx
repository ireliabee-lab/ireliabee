import { useState } from "react";
import toast from "react-hot-toast";
import { Download, Loader2 } from "lucide-react";
import { fetchApi } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";
import type { Ref } from "../lib/citations";
import { buildDocument, fileName, toDocx, toMarkdown, type ExportDocument } from "../lib/writingExport";
import type { Project } from "../lib/writing";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function pdfOf(doc: ExportDocument): Promise<Blob> {
  const res = await fetchApi("/writing/export.pdf", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.blob();
}

/** Word, PDF or Markdown: the finished document, citations formatted, reference list at the end. */
export function ExportButtons({ p, refs, headings }: { p: Project; refs: Ref[]; headings: boolean }) {
  const [busy, setBusy] = useState<"" | "docx" | "pdf" | "md">("");
  async function run(kind: "docx" | "pdf" | "md") {
    setBusy(kind);
    try {
      const doc = await buildDocument({ title: p.title, style: p.style, sections: p.sections ?? [] }, refs, headings);
      if (!doc.sections.length) { toast("Write something first: there is nothing to export yet."); return; }
      const blob = kind === "docx" ? await toDocx(doc)
        : kind === "pdf" ? await pdfOf(doc)
        : new Blob([toMarkdown(doc)], { type: "text/markdown" });
      save(blob, fileName(p.title, kind));
      if (doc.unknown.length) toast(`Saved. ${doc.unknown.map(k => `@${k}`).join(", ")} ${doc.unknown.length === 1 ? "has" : "have"} no source, so it stays as typed.`);
      else toast.success("Saved");
    } catch (e) { notifyError(e); } finally { setBusy(""); }
  }
  return (
    <span className="write-export" role="group" aria-label="Export">
      {(["docx", "pdf", "md"] as const).map(kind => (
        <button key={kind} type="button" className="btn-ghost" disabled={!!busy} onClick={() => void run(kind)}
          title={kind === "docx" ? "Word document, ready to submit" : kind === "pdf" ? "PDF, as it will print" : "Markdown, plain text"}>
          {busy === kind ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {kind === "docx" ? "Word" : kind === "pdf" ? "PDF" : "Markdown"}
        </button>
      ))}
    </span>
  );
}
