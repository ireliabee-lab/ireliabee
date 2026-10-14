import { describe, expect, it } from "vitest";
import {
  addBlock, addSection, anchorMarks, parseRichKey, richAt, richKey, textAt, withRich, type RichTarget, applyInk, applyMark, clearFormatting, clock, hasFormatting, hasStyle, placeOf, richRuns, toggleStyle, deleteBlock, deleteSection, emptyDoc, moveBlock, moveSection, newBlock, newSection,
  sourceLabel, styleVars, updateBlock, updateSection, type NotebookDoc,
} from "./notebook";

function docWith(): NotebookDoc {
  const d = emptyDoc();
  const s = { ...newSection("Light reactions"), id: "s1" };
  return {
    ...d,
    sections: [{ ...s, blocks: [{ ...newBlock("point", "one"), id: "b1" }, { ...newBlock("key", "two"), id: "b2" }] }],
  };
}

describe("notebook editing helpers", () => {
  it("never mutate the document they are given", () => {
    const doc = docWith();
    const frozen = JSON.stringify(doc);
    addBlock(doc, { section: "s1" }, newBlock("note", "mine"));
    updateBlock(doc, { section: "s1" }, "b1", { text: "changed" });
    deleteBlock(doc, { section: "s1" }, "b1");
    moveBlock(doc, { section: "s1" }, "b1", 1);
    addSection(doc, newSection());
    deleteSection(doc, "s1");
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it("add a block at the end, or right after another", () => {
    const doc = docWith();
    const end = addBlock(doc, { section: "s1" }, { ...newBlock("note", "last"), id: "b3" });
    expect(end.sections[0].blocks.map(b => b.id)).toEqual(["b1", "b2", "b3"]);
    const mid = addBlock(doc, { section: "s1" }, { ...newBlock("note", "mid"), id: "bx" }, "b1");
    expect(mid.sections[0].blocks.map(b => b.id)).toEqual(["b1", "bx", "b2"]);
  });

  it("add to a meeting board column", () => {
    const doc = addBlock(emptyDoc(), { board: "actions" }, newBlock("action", "Publish the form"));
    expect(doc.board.actions).toHaveLength(1);
    expect(doc.board.actions[0].owner).toBe("");
    expect(doc.board.actions[0].done).toBe(false);
  });

  it("changing a block's type keeps its text and id and adds the new type's fields", () => {
    const doc = updateBlock(docWith(), { section: "s1" }, "b1", { type: "definition" });
    const b = doc.sections[0].blocks[0];
    expect(b).toMatchObject({ id: "b1", type: "definition", text: "one", term: "" });
  });

  it("move within bounds and ignore moves off the ends", () => {
    const doc = docWith();
    expect(moveBlock(doc, { section: "s1" }, "b1", 1).sections[0].blocks.map(b => b.id)).toEqual(["b2", "b1"]);
    expect(moveBlock(doc, { section: "s1" }, "b1", -1)).toBe(doc);
    const two = addSection(doc, { ...newSection("Calvin"), id: "s2" });
    expect(moveSection(two, "s2", -1).sections.map(s => s.id)).toEqual(["s2", "s1"]);
    expect(moveSection(two, "s2", 1)).toBe(two);
  });

  it("rename and delete sections", () => {
    const doc = updateSection(docWith(), "s1", { title: "Renamed" });
    expect(doc.sections[0].title).toBe("Renamed");
    expect(deleteSection(doc, "s1").sections).toHaveLength(0);
  });

  it("new tables start as a 2×2 grid", () => {
    expect(newBlock("table").rows).toEqual([["", ""], ["", ""]]);
  });
});

describe("how it looks", () => {
  it("maps the chosen style onto CSS variables", () => {
    const v = styleVars({ family: "readable", size: "l", style: "bold" });
    expect(v["--nb-font"]).toContain("Atkinson Hyperlegible");
    expect(v["--nb-size"]).toBe("18px");
    expect(v["--nb-weight"]).toBe("600");
    expect(v["--nb-italic"]).toBe("normal");
  });

  it("gives handwriting a little more size", () => {
    expect(styleVars({ family: "hand", size: "m", style: "italic" })["--nb-size"]).toBe("20px");
  });
});

describe("sources", () => {
  it("show a time for a session and a page range for a document", () => {
    expect(sourceLabel({ kind: "lecture", line_times: { "3": 125 } }, [3, 4])).toBe("2:05");
    expect(sourceLabel({ kind: "reading" }, [42, 44, 43])).toBe("p. 42–44");
    expect(sourceLabel({ kind: "reading" }, [7])).toBe("p. 7");
    expect(sourceLabel({ kind: "meeting", line_times: {} }, [9])).toBeNull();
    expect(sourceLabel({ kind: "lecture", line_times: {} }, [])).toBeNull();
  });

  it("format long times with hours", () => {
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-4)).toBe("0:00");
  });
});

describe("highlights", () => {
  const text = "RuBisCO fixes carbon dioxide onto RuBP in the stroma.";
  it("paints a range and keeps the words it covers", () => {
    const m = applyMark(text, [], 0, 7, "yellow");
    expect(m).toEqual([{ s: 0, e: 7, c: "yellow", q: "RuBisCO" }]);
  });
  it("a new colour over part of an old highlight takes that part only", () => {
    let m = applyMark(text, [], 0, 20, "yellow");
    m = applyMark(text, m, 8, 13, "green");
    expect(m.map(x => [x.q, x.c])).toEqual([["RuBisCO", "yellow"], ["fixes", "green"], ["carbon", "yellow"]]);
  });
  it("leaves out the spaces a selection picks up at its ends", () => {
    expect(applyMark(text, [], 7, 14, "yellow")).toEqual([{ s: 8, e: 13, c: "yellow", q: "fixes" }]);
  });
  it("clearing removes just what was selected", () => {
    let m = applyMark(text, [], 0, 20, "blue");
    m = applyMark(text, m, 0, 8, null);
    expect(m).toEqual([{ s: 8, e: 20, c: "blue", q: "fixes carbon" }]);
    // and what's left of a split highlight doesn't start with a space
    expect(applyMark(text, applyMark(text, [], 0, 20, "blue"), 0, 7, null)[0].q).toBe("fixes carbon");
  });
  it("finds its words again after the text is edited, or drops away", () => {
    const m = applyMark(text, [], 34, 38, "pink");                    // "RuBP"
    const edited = "Note: " + text;
    expect(anchorMarks(edited, m)).toEqual([{ s: 40, e: 44, c: "pink", q: "RuBP" }]);
    expect(anchorMarks(text.replace("RuBP", "ribulose"), m)).toEqual([]);
  });
  it("ignores a highlight in a colour it doesn't know, and whitespace-only runs", () => {
    expect(anchorMarks(text, [{ s: 0, e: 7, c: "purple" as never, q: "RuBisCO" }])).toEqual([]);
    expect(applyMark("a   b", [], 1, 4, "yellow")).toEqual([]);
  });
  it("knows where a block lives", () => {
    const doc = { ...emptyDoc(), sections: [{ id: "s1", title: "x", src: [], blocks: [{ id: "b1", type: "point" as const, text: "t", src: [] }] }] };
    expect(placeOf(doc, "b1")).toEqual({ section: "s1" });
    expect(placeOf(doc, "nope")).toBeNull();
  });
});

describe("bold, italic, underline, strikethrough", () => {
  const text = "RuBisCO fixes carbon dioxide onto RuBP.";
  it("toggles on, then off when the whole selection already has it", () => {
    const on = toggleStyle(text, {}, "b", 0, 7);
    expect(on.b).toEqual([{ s: 0, e: 7, q: "RuBisCO" }]);
    expect(hasStyle(text, on, "b", 0, 7)).toBe(true);
    expect(toggleStyle(text, on, "b", 0, 7).b).toBeUndefined();
  });
  it("a part-styled selection is styled throughout, as in a word processor", () => {
    const part = toggleStyle(text, {}, "i", 0, 7);
    expect(hasStyle(text, part, "i", 0, 13)).toBe(false);
    expect(toggleStyle(text, part, "i", 0, 13).i).toEqual([{ s: 0, e: 13, q: "RuBisCO fixes" }]);
  });
  it("styles and a highlight combine on the same words", () => {
    const fmt = toggleStyle(text, toggleStyle(text, {}, "b", 0, 13), "u", 8, 13);
    const marks = applyMark(text, [], 8, 20, "green");
    const runs = richRuns(text, marks, fmt).filter(r => r.text.trim());
    expect(runs.map(r => [r.text, r.b, r.u, r.c])).toEqual([
      ["RuBisCO ", true, false, null],
      ["fixes", true, true, "green"],
      [" carbon", false, false, "green"],
      [" dioxide onto RuBP.", false, false, null],
    ]);
  });
  it("clear formatting takes everything off the selection only", () => {
    const fmt = toggleStyle(text, toggleStyle(text, {}, "b", 0, 20), "x", 0, 20);
    const marks = applyMark(text, [], 0, 20, "pink");
    const out = clearFormatting(text, marks, fmt, 0, 8);
    expect(out.fmt.b).toEqual([{ s: 8, e: 20, q: "fixes carbon" }]);
    expect(out.marks[0].q).toBe("fixes carbon");
    expect(hasFormatting(text, out.marks, out.fmt, 0, 7)).toBe(false);
    expect(hasFormatting(text, out.marks, out.fmt, 8, 13)).toBe(true);
  });
  it("styles find their words again after an edit", () => {
    const fmt = toggleStyle(text, {}, "b", 34, 38);                 // "RuBP"
    expect(richRuns("Note: " + text, [], fmt).find(r => r.b)?.text).toBe("RuBP");
  });
});

describe("text colour", () => {
  const text = "RuBisCO fixes carbon dioxide onto RuBP.";
  it("colours the letters, and a new colour takes over just its part", () => {
    let ink = applyInk(text, [], 0, 13, "red");
    ink = applyInk(text, ink, 8, 13, "blue");
    expect(ink.map(x => [x.q, x.c])).toEqual([["RuBisCO", "red"], ["fixes", "blue"]]);
  });
  it("sits alongside a highlight and styles on the same words", () => {
    const run = richRuns(text, applyMark(text, [], 0, 7, "yellow"), toggleStyle(text, {}, "b", 0, 7), applyInk(text, [], 0, 7, "purple"))[0];
    expect([run.text, run.c, run.k, run.b]).toEqual(["RuBisCO", "yellow", "purple", true]);
  });
  it("back to the notebook's ink with null, or with clear formatting", () => {
    const ink = applyInk(text, [], 0, 13, "green");
    expect(applyInk(text, ink, 0, 13, null)).toEqual([]);
    expect(clearFormatting(text, [], {}, 0, 13, ink).ink).toEqual([]);
    expect(hasFormatting(text, [], {}, 0, 7, ink)).toBe(true);
  });
});

describe("formatting any notebook text", () => {
  const doc = {
    ...emptyDoc(), title: "Photosynthesis", summary: "Light makes sugar.", cues: ["What is RuBisCO?"],
    sections: [{ id: "s1", title: "The Calvin cycle", src: [], blocks: [
      { id: "b1", type: "definition" as const, text: "attaches CO2", term: "RuBisCO", src: [] },
      { id: "b2", type: "table" as const, text: "", src: [], rows: [["Good", "PED"], ["Petrol", "-0.2"]] },
    ] }],
  };
  const targets: [RichTarget, string][] = [
    [{ scope: "d", id: "", field: "title" }, "Photosynthesis"],
    [{ scope: "d", id: "", field: "cue:0" }, "What is RuBisCO?"],
    [{ scope: "s", id: "s1", field: "title" }, "The Calvin cycle"],
    [{ scope: "b", id: "b1", field: "term" }, "RuBisCO"],
    [{ scope: "b", id: "b1", field: "text" }, "attaches CO2"],
    [{ scope: "b", id: "b2", field: "cell:1:0" }, "Petrol"],
  ];
  it("reads each text by its address, and the address round-trips", () => {
    for (const [t, text] of targets) {
      expect(textAt(doc, t)).toBe(text);
      expect(parseRichKey(richKey(t))).toEqual(t);
    }
    expect(textAt(doc, { scope: "b", id: "gone", field: "text" })).toBeNull();
  });
  it("formats each text, and only that text", () => {
    for (const [t, text] of targets) {
      const next = withRich(doc, t, { fmt: toggleStyle(text, {}, "b", 0, text.length) });
      expect(richAt(next, t).fmt?.b?.[0].q).toBe(text.trim());
      for (const [other] of targets) if (richKey(other) !== richKey(t)) expect(richAt(next, other).fmt).toBeUndefined();
    }
  });
  it("a note's main text keeps its formatting on the block, as before", () => {
    const next = withRich(doc, { scope: "b", id: "b1", field: "text" }, { marks: applyMark("attaches CO2", [], 0, 8, "yellow") });
    const block = next.sections[0].blocks[0];
    expect(block.marks?.[0].q).toBe("attaches");
    expect(block.rich).toBeUndefined();
  });
});
