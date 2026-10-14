import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

export interface DictSense { definition: string; examples: string[]; synonyms: string[] }
export interface DictEntry {
  query: string; word: string; found: boolean;
  /** Other dictionary words this is a form of ("running" → run). */
  forms_of: string[];
  meanings: { pos: string; senses: DictSense[] }[];
  sentences: string[];
  phrases: { before: { word: string; count: number }[]; after: { word: string; count: number }[] };
}
export interface DictStatus {
  installed: boolean; words: number;
  download: { state: "idle" | "downloading" | "done" | "error"; done: number; total: number; error: string };
  credits: { name: string; licence: string; url: string }[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

/** Wordcraft's dictionary: downloaded once, then every lookup stays on this computer. */
export const dictionaryApi = {
  status: () => fetchApi("/dictionary/status").then(r => json<DictStatus>(r)),
  download: () => fetchApi("/dictionary/download", { method: "POST" }).then(r => json<DictStatus>(r)),
  lookup: (q: string) => fetchApi(`/dictionary/lookup?q=${encodeURIComponent(q)}`).then(r => json<DictEntry>(r)),
  suggest: (q: string) => fetchApi(`/dictionary/suggest?q=${encodeURIComponent(q)}`).then(r => json<{ words: string[] }>(r)),
};

/** Megabytes, as the download shows them: "12.4 MB". */
export const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
