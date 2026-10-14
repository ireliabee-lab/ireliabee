import { describe, expect, it } from "vitest";
import { type BookEntry, docToEntries, entriesToDoc, HIGHLIGHT_VALUE, INK_VALUE, type LineMeta, remapMeta } from "./notebookBook";
import type { NotebookDoc } from "./notebook";

const pages = (src: number[]) => (src.length ? `p. ${src.join("–")}` : "");

function lecture(): NotebookDoc {
  return {
    title: "Speech motor control", author: "Dr. Patel", summary: "Timing matters.\nFeedback is slow.", cues: ["What is feedforward control?"],
    board: { decisions: [], actions: [], questions: [], risks: [], numbers: [] },
    sections: [{
      id: "s1", title: "Control", src: [3],
      blocks: [
        { id: "b1", type: "point", text: "Speech needs precise timing", src: [3] },
        { id: "b2", type: "key", text: "Feedforward runs ahead of feedback", src: [4],
          marks: [{ s: 0, e: 11, c: "yellow", q: "Feedforward" }], fmt: { b: [{ s: 17, e: 22, q: "ahead" }] },
          ink: [{ s: 26, e: 34, c: "blue", q: "feedback" }] },
        { id: "b3", type: "definition", term: "Efference copy", text: "a copy of the motor command", src: [5] },
        { id: "b4", type: "example", text: "hearing your own voice late", src: [] },
        { id: "b5", type: "quote", speaker: "Levelt", text: "Speaking is planned", src: [6] },
        { id: "b6", type: "formula", text: "y = Kx", src: [] },
        { id: "b7", type: "table", text: "", rows: [["Model", "Year"], ["DIVA", "1995"]], caption: "Models", src: [7] },
        { id: "b8", type: "tutor", text: "Think of a thermostat", src: [] },
      ],
    }],
  };
}

function meeting(): NotebookDoc {
  return {
    title: "Lab meeting", summary: "", cues: [],
    board: {
      decisions: [{ id: "d1", type: "decision", text: "Use SEP-28k", src: [12] }],
      actions: [{ id: "a1", type: "action", text: "Send the plan", owner: "Oliver", due: "Wed", done: false, src: [] }],
      questions: [], risks: [{ id: "r1", type: "risk", text: "Data licence", src: [] }],
      numbers: [{ id: "n1", type: "number", term: "28,000", text: "clips", src: [] }],
    },
    sections: [{ id: "s1", title: "Updates", src: [], blocks: [{ id: "p1", type: "point", text: "Pilot done", src: [] }] }],
  };
}

/** Edits one entry's text (and styles) the way the book editor would. */
function edit(entries: BookEntry[], id: string, change: (e: BookEntry) => Partial<BookEntry>): BookEntry[] {
  return entries.map(e => (e.id === id ? { ...e, ...change(e) } : e));
}

describe("notebook ↔ book", () => {
  it("gives every section, the summary and Test yourself their own entry", () => {
    const entries = docToEntries(lecture(), "lecture", pages);
    expect(entries.map(e => [e.role, e.title])).toEqual([["section", "Control"], ["summary", "Summary"], ["cues", "Test yourself"]]);
    expect(entries[2].paras).toEqual(["numbered"]);
  });

  it("draws labels, terms, speakers and sources as text on the line", () => {
    const [sec] = docToEntries(lecture(), "lecture", pages);
    const lines = sec.text.split("\n");
    expect(lines[0]).toBe("Speech needs precise timing (p.3)");
    expect(lines[2]).toBe("Efference copy — a copy of the motor command (p.5)");
    expect(lines[3]).toBe("Example: hearing your own voice late");
    expect(lines[4]).toBe("Speaking is planned — Levelt (p.6)");
    expect(lines[6]).toBe("Model\tYear");
    expect(sec.paras).toEqual(["bullet", "key", "normal", "normal", "quote", "center", "table", "table", "quote"]);
  });

  it("maps highlights and text colours to the book's palette", () => {
    const [sec] = docToEntries(lecture(), "lecture", pages);
    const start = sec.text.indexOf("Feedforward");
    expect(sec.marks).toContainEqual({ type: "highlight", start, end: start + 11, value: HIGHLIGHT_VALUE.yellow });
    expect(sec.marks).toContainEqual({ type: "color", start: start + 26, end: start + 34, value: INK_VALUE.blue });
    expect(sec.marks).toContainEqual({ type: "bold", start: start + 17, end: start + 22 });
  });

  it("gives back exactly the same lecture when nothing was edited", () => {
    const doc = lecture();
    expect(entriesToDoc(doc, docToEntries(doc, "lecture", pages))).toEqual(doc);
  });

  it("gives back exactly the same meeting when nothing was edited", () => {
    const doc = meeting();
    const entries = docToEntries(doc, "meeting", pages);
    expect(entries[0]).toMatchObject({ role: "board", title: "At a glance" });
    expect(entries[0].text.split("\n")).toContain("Send the plan — Oliver, by Wed");
    expect(entriesToDoc(doc, entries)).toEqual(doc);
  });

  it("keeps a line's id and sources when only its words change", () => {
    const doc = lecture();
    const entries = edit(docToEntries(doc, "lecture", pages), "s1",
      e => ({ text: e.text.replace("precise timing", "very precise timing") }));
    const b1 = entriesToDoc(doc, entries).sections[0].blocks[0];
    expect(b1).toMatchObject({ id: "b1", type: "point", text: "Speech needs very precise timing", src: [3] });
  });

  it("keeps the words when the reader deletes a label", () => {
    const doc = lecture();
    const entries = edit(docToEntries(doc, "lecture", pages), "s1", e => ({ text: e.text.replace("Example: ", "") }));
    expect(entriesToDoc(doc, entries).sections[0].blocks[3]).toMatchObject({ id: "b4", type: "example", text: "hearing your own voice late" });
  });

  it("turns new lines into blocks by their style, and keeps blank lines and numbered lists", () => {
    const doc = lecture();
    const entries = edit(docToEntries(doc, "lecture", pages), "s1", e => ({
      text: `${e.text}\n\nMy own thought\nfirst step\nsecond step\n`,
      paras: [...e.paras, "normal", "normal", "numbered", "numbered", "normal"],
      meta: [...e.meta, null, null, null, null, null],
    }));
    const blocks = entriesToDoc(doc, entries).sections[0].blocks.slice(8);
    expect(blocks.map(b => [b.type, b.text, b.para])).toEqual([
      ["note", "", "blank"], ["note", "My own thought", undefined], ["point", "first step", "numbered"], ["point", "second step", "numbered"],
    ]);
  });

  it("starts a new section at a heading line", () => {
    const doc = lecture();
    const entries = edit(docToEntries(doc, "lecture", pages), "s1", e => ({
      text: `${e.text}\nFeedback\nToo slow for fluent speech`,
      paras: [...e.paras, "heading", "bullet"], meta: [...e.meta, null, null],
    }));
    const sections = entriesToDoc(doc, entries).sections;
    expect(sections.map(s => s.title)).toEqual(["Control", "Feedback"]);
    expect(sections[1].blocks).toMatchObject([{ type: "point", text: "Too slow for fluent speech" }]);
  });

  it("ticks an action on the front page, and files a new line under the column above it", () => {
    const doc = meeting();
    const entries = edit(docToEntries(doc, "meeting", pages), "board", e => {
      const lines = e.text.split("\n");
      const at = lines.indexOf("Risks");
      const paras = [...e.paras];
      paras[lines.findIndex(l => l.startsWith("Send the plan"))] = "checked";
      lines.splice(at + 2, 0, "Compute budget");
      paras.splice(at + 2, 0, "normal");
      const meta = [...e.meta];
      meta.splice(at + 2, 0, null);
      return { text: lines.join("\n"), paras, meta };
    });
    const board = entriesToDoc(doc, entries).board;
    expect(board.actions[0]).toMatchObject({ id: "a1", done: true, owner: "Oliver", due: "Wed" });
    expect(board.risks.map(r => r.text)).toEqual(["Data licence", "Compute budget"]);
  });

  it("writes the summary and Test yourself back", () => {
    const doc = lecture();
    let entries = docToEntries(doc, "lecture", pages);
    entries = edit(entries, "summary", () => ({ text: "One line now.\n" }));
    entries = edit(entries, "cues", e => ({ text: `${e.text}\nWhy is feedback slow?\n`, paras: [...e.paras, "numbered", "numbered"] }));
    const out = entriesToDoc(doc, entries);
    expect(out.summary).toBe("One line now.");
    expect(out.cues).toEqual(["What is feedforward control?", "Why is feedback slow?"]);
  });

  it("gives a new formatted line its formatting as spans", () => {
    const doc = lecture();
    const entries = edit(docToEntries(doc, "lecture", pages), "s1", e => {
      const start = e.text.length + 1;
      return {
        text: `${e.text}\nremember this`,
        paras: [...e.paras, "key"], meta: [...e.meta, null],
        marks: [...e.marks, { type: "highlight", start, end: start + 8, value: HIGHLIGHT_VALUE.pink }, { type: "italic", start: start + 9, end: start + 13 }],
      };
    });
    const b = entriesToDoc(doc, entries).sections[0].blocks[8];
    expect(b).toMatchObject({ type: "key", text: "remember this", marks: [{ s: 0, e: 8, c: "pink", q: "remember" }], fmt: { i: [{ s: 9, e: 13, q: "this" }] } });
  });

  it("stars a point into a key point and back", () => {
    const doc = lecture();
    const starred = edit(docToEntries(doc, "lecture", pages), "s1", e => ({ paras: ["key", ...e.paras.slice(1)] }));
    expect(entriesToDoc(doc, starred).sections[0].blocks[0]).toMatchObject({ id: "b1", type: "key" });
    const unstarred = edit(docToEntries(doc, "lecture", pages), "s1", e => ({ paras: [e.paras[0], "bullet", ...e.paras.slice(2)] }));
    expect(entriesToDoc(doc, unstarred).sections[0].blocks[1]).toMatchObject({ id: "b2", type: "point" });
  });
});

describe("photos, tags and the summary's formatting", () => {
  const photo = "data:image/jpeg;base64,AAAA";
  const withPhoto = (): NotebookDoc => {
    const d = lecture();
    d.sections[0].blocks.push({ id: "img1", type: "image", text: "", image: photo, w: 400, h: 300, src: [8] });
    return d;
  };

  it("puts a photo on a line of its own and gives it back", () => {
    const doc = withPhoto();
    const [sec] = docToEntries(doc, "lecture", pages);
    expect(sec.paras[sec.paras.length - 1]).toBe("image:img1");
    expect(sec.media).toEqual({ img1: { src: photo, w: 400, h: 300 } });
    expect(entriesToDoc(doc, docToEntries(doc, "lecture", pages))).toEqual(doc);
  });

  it("drops a photo whose picture is gone", () => {
    const doc = withPhoto();
    const entries = edit(docToEntries(doc, "lecture", pages), "s1", () => ({ media: {} }));
    expect(entriesToDoc(doc, entries).sections[0].blocks.some(b => b.type === "image")).toBe(false);
  });

  it("draws the source tag in its own ink without saving that ink into the note", () => {
    const doc = lecture();
    const [sec] = docToEntries(doc, "lecture", pages);
    const line = sec.text.split("\n")[0];
    const start = sec.text.indexOf("(p.3)");
    expect(line.endsWith("(p.3)")).toBe(true);
    expect(sec.marks).toContainEqual({ type: "color", start, end: start + "(p.3)".length, value: INK_VALUE.blue });
    expect(entriesToDoc(doc, docToEntries(doc, "lecture", pages))).toEqual(doc);
  });

  it("remembers the source tag drawn at the end of a line", () => {
    const [sec] = docToEntries(lecture(), "lecture", pages);
    expect(sec.meta[0]).toMatchObject({ id: "b1", tag: "(p.3)", src: [3] });
    expect(sec.meta[3]?.tag).toBeUndefined();
  });

  it("keeps formatting on the summary and on Test yourself", () => {
    const doc = lecture();
    let entries = docToEntries(doc, "lecture", pages);
    entries = edit(entries, "summary", e => ({ marks: [{ type: "bold", start: 0, end: 6 }, { type: "highlight", start: 16, end: 24, value: HIGHLIGHT_VALUE.green }] }));
    entries = edit(entries, "cues", () => ({ marks: [{ type: "italic", start: 8, end: 20 }] }));
    const out = entriesToDoc(doc, entries);
    expect(out.rich?.summary).toEqual({ fmt: { b: [{ s: 0, e: 6, q: "Timing" }] }, marks: [{ s: 16, e: 24, c: "green", q: "Feedback" }] });
    expect(out.rich?.["cue:0"]).toEqual({ fmt: { i: [{ s: 8, e: 20, q: "feedforward " }] } });
    // …and they come back onto the page.
    const again = docToEntries(out, "lecture", pages);
    expect(again.find(e => e.role === "summary")?.marks).toContainEqual({ type: "bold", start: 0, end: 6 });
    expect(again.find(e => e.role === "summary")?.marks).toContainEqual({ type: "highlight", start: 16, end: 24, value: HIGHLIGHT_VALUE.green });
  });
});

describe("remapMeta", () => {
  const m = (id: string): LineMeta => ({ id, type: "point", src: [], prefix: "", suffix: "", rest: {} });
  const ids = (xs: (LineMeta | null)[]) => xs.map(x => x?.id ?? null);
  const t = (...lines: string[]) => lines.join("\n");

  it("keeps every line's block when a word changes", () => {
    expect(ids(remapMeta(t("a", "b", "c"), t("a", "bee", "c"), [m("1"), m("2"), m("3")]))).toEqual(["1", "2", "3"]);
  });
  it("gives the new half of a split line no block", () => {
    expect(ids(remapMeta(t("a", "bc", "d"), t("a", "b", "c", "d"), [m("1"), m("2"), m("3")]))).toEqual(["1", "2", null, "3"]);
  });
  it("keeps the first block when two lines are joined", () => {
    expect(ids(remapMeta(t("a", "b", "c", "d"), t("a", "bc", "d"), [m("1"), m("2"), m("3"), m("4")]))).toEqual(["1", "2", "4"]);
  });
  it("drops the block of a deleted line and adds pasted lines as new", () => {
    expect(ids(remapMeta(t("a", "b", "c"), t("a", "c"), [m("1"), m("2"), m("3")]))).toEqual(["1", "3"]);
    expect(ids(remapMeta(t("a", "c"), t("a", "x", "y", "c"), [m("1"), m("3")]))).toEqual(["1", null, null, "3"]);
  });
});

describe("a source tag saved inside a note", () => {
  it("shows once, and saves back clean", () => {
    const doc = lecture();
    const text = "Stress does not cause stuttering. (p.1)￼";
    doc.sections[0].blocks = [{ id: "b1", type: "point", text, src: [1], fmt: { i: [{ s: 33, e: 39, q: " (p.1)" }] } } as never];
    const [sec] = docToEntries(doc, "lecture", pages);
    expect(sec.text.match(/\(p\.1\)/g)).toHaveLength(1);
    const back = entriesToDoc(doc, docToEntries(doc, "lecture", pages));
    expect(back.sections[0].blocks[0].text).toBe("Stress does not cause stuttering.");
  });
});
