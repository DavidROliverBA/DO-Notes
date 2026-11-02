import { describe, expect, test } from "bun:test";
import { addRelationships, kindNamed, newRelationshipsNote, parseRelationships, phraseNamed, relationshipKinds, reversible } from "../src/relationships";

const note = `# Relationships

Our own words.

| Relationship | Other direction | Meaning |
| --- | --- | --- |
| comes before | comes after | Happens first |
| Twin of | — | The same thing, made twice |
| owns \\| runs | run by | Pipes escaped |
| | nameless | skipped |
| comes before | again | a repeat, skipped |

After the table.
`;

describe("kinds of relationship (F31 step 2)", () => {
  test("the note's table is read: name, other direction (— reads the same both ways), meaning", () => {
    expect(parseRelationships(note)).toEqual([
      { rel: "comes-before", label: "comes before", inverse: "comes after", hint: "Happens first", source: "own" },
      { rel: "twin-of", label: "Twin of", inverse: "Twin of", hint: "The same thing, made twice", source: "own" },
      { rel: "owns-runs", label: "owns | runs", inverse: "run by", hint: "Pipes escaped", source: "own" },
    ]);
    expect(parseRelationships("# Nothing here\n\n| a | b |\n| - | - |\n| x | y |\n")).toEqual([]);
  });

  test("new kinds go at the end of the table; ones it has, and the rest of the note, stay as they are", () => {
    const out = addRelationships(note, [
      { label: "Comes before", inverse: "x", hint: "already there" },
      { label: "blocks", inverse: "blocked by", hint: "Stops it" },
      { label: "mirrors", inverse: "mirrors", hint: "Both ways" },
    ]);
    expect(out).toContain("| comes before | again | a repeat, skipped |\n| blocks | blocked by | Stops it |\n| mirrors | — | Both ways |\n\nAfter the table.");
    expect(out.match(/Comes before/g)).toBeNull();
    expect(addRelationships(note, [{ label: "comes before", inverse: "", hint: "" }])).toBe(note);
    // A note with no table gets one.
    const fresh = addRelationships("# Relationships\n\nNotes to self.\n", [{ label: "blocks", inverse: "blocked by", hint: "Stops it" }]);
    expect(parseRelationships(fresh).map((k) => k.rel)).toEqual(["blocks"]);
    expect(fresh).toStartWith("# Relationships\n\nNotes to self.");
    expect(parseRelationships(newRelationshipsNote([{ label: "blocks", inverse: "blocked by", hint: "Stops it" }]))[0]).toMatchObject({ rel: "blocks", inverse: "blocked by" });
  });

  test("one list: the collection's own first, then the types' relations, then AI-XF's core kinds", () => {
    const own = parseRelationships(note);
    const kinds = relationshipKinds([...own, { rel: "part-of", label: "inside", inverse: "holds", hint: "Ours", source: "own" }], [
      { name: "attendees", type: "Meeting", target: "Person" },
      { name: "depends-on", type: "Project" },
    ]);
    expect(kinds.slice(0, 6).map((k) => [k.rel, k.source])).toEqual([
      ["comes-before", "own"],
      ["twin-of", "own"],
      ["owns-runs", "own"],
      ["part-of", "own"],
      ["attendees", "type"],
      ["depends-on", "type"],
    ]);
    expect(kindNamed(kinds, "attendees")).toMatchObject({ inverse: "As attendees", hint: "A Meeting's attendees: a Person", type: "Meeting" });
    // A type relation with a core name keeps the core kind's words.
    expect(kindNamed(kinds, "depends-on")).toMatchObject({ inverse: "Depended on by", source: "type" });
    // The collection's own words win over a core kind's; every core kind is there once.
    expect(kindNamed(kinds, "Part of")).toMatchObject({ label: "inside", source: "own" });
    expect(kinds.filter((k) => k.rel === "part-of")).toHaveLength(1);
    expect(kindNamed(kinds, "relates_to")).toMatchObject({ source: "core" });
  });
});

describe("a property read as a kind, either way (F31 step 4)", () => {
  const kinds = relationshipKinds(parseRelationships(note), [{ name: "attendees", type: "Meeting", target: "Person" }]);
  test("the kind's own name reads forwards, its other direction's name backwards", () => {
    expect(phraseNamed(kinds, "comes-before")).toMatchObject({ kind: { rel: "comes-before" }, back: false });
    expect(phraseNamed(kinds, "Comes after")).toMatchObject({ kind: { rel: "comes-before" }, back: true });
    // A kind of its own wins over another's other direction (has part / part of).
    expect(phraseNamed(kinds, "has-part")).toMatchObject({ kind: { rel: "has-part" }, back: false });
    expect(phraseNamed(kinds, "authored-by")).toMatchObject({ kind: { rel: "authored-by" }, back: false });
    expect(phraseNamed(kinds, "author-of")).toMatchObject({ kind: { rel: "authored-by" }, back: true });
    expect(phraseNamed(kinds, "colour")).toBeNull();
  });
  test("a type's own relation has no other name, so it can't be written in the other note", () => {
    expect(reversible(kindNamed(kinds, "attendees")!)).toBe(false);
    expect(reversible(kindNamed(kinds, "comes-before")!)).toBe(true);
  });
});
