// The journal's Markdown (F24): entries go at the end of a day's `## Journal` section, made if it
// isn't there, and read back in order. Pure, so no database.

import { describe, expect, test } from "bun:test";
import { addToJournal, entriesIn } from "../src/journal";

describe("journal entries in a daily note", () => {
  test("a note without a Journal section gets one at the end", () => {
    expect(addToJournal("# Saturday 25 October 2026\n\n", "08:12", "Coffee in the garden.")).toBe("# Saturday 25 October 2026\n\n## Journal\n\n### 08:12\n\nCoffee in the garden.\n");
    expect(addToJournal("", "08:12", "First.")).toBe("## Journal\n\n### 08:12\n\nFirst.\n");
  });

  test("a later entry goes after the last one, before the next section; other sections stay as they were", () => {
    const md = "# Day\n\n## Journal\n\n### 08:12\n\nCoffee.\n\n## Tasks\n- [ ] Bins\n";
    const out = addToJournal(md, "21:40", "Long walk.\n\nBed early.");
    expect(out).toBe("# Day\n\n## Journal\n\n### 08:12\n\nCoffee.\n\n### 21:40\n\nLong walk.\n\nBed early.\n\n## Tasks\n- [ ] Bins\n");
    expect(entriesIn(out)).toEqual([
      { time: "08:12", text: "Coffee." },
      { time: "21:40", text: "Long walk.\n\nBed early." },
    ]);
  });

  test("reading back: only the Journal section, any case, and empty entries left out", () => {
    expect(entriesIn("# Day\n\n### 09:00\n\nNot a journal.\n")).toEqual([]);
    expect(entriesIn("## journal\n### 7:05\nEarly.\n### 08:00\n\n")).toEqual([{ time: "07:05", text: "Early." }]);
  });
});
