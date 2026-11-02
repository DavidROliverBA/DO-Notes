import { describe, expect, test } from "bun:test";
import { findBlocks, parseRef, renderBlock, resolve } from "../src/floeDiagrams";

const C4 = 'C4Context\n  title Context\n\n  Person(customer_1, "Customer")\n';
const index = [
  { id: "d-1", landscape: "Payments", diagram: "Context" },
  { id: "d-2", landscape: "Payments", diagram: "Payments" },
  { id: "d-3", landscape: "Shop", diagram: "Context" },
];

describe("Floe diagrams in notes", () => {
  test("a %% floe: line names a diagram by names, by id, or both", () => {
    expect(parseRef("Payments / Context")).toEqual({ id: null, landscape: "Payments", diagram: "Context" });
    expect(parseRef("d-1")).toEqual({ id: "d-1", landscape: null, diagram: null });
    expect(parseRef("Payments / Context · d-1")).toEqual({ id: "d-1", landscape: "Payments", diagram: "Context" });
    expect(parseRef("A / B / Context")).toEqual({ id: null, landscape: "A / B", diagram: "Context" });
    expect(parseRef("")).toBeNull();
    expect(parseRef("Payments /")).toBeNull();
  });

  test("only mermaid blocks whose first line is %% floe: count", () => {
    const note = [
      "# Design",
      "```mermaid\n%% floe: Payments / Context\n```",
      "```mermaid\nflowchart LR\n  A --> B\n```",
      "```js\n%% floe: Payments / Context\n```",
      "~~~~mermaid\n%% floe: d-3 %%\nC4Context\n~~~~",
    ].join("\n\n");
    const blocks = findBlocks(note);
    expect(blocks.map((b) => b.ref)).toEqual([
      { id: null, landscape: "Payments", diagram: "Context" },
      { id: "d-3", landscape: null, diagram: null },
    ]);
    expect(note).toContain(blocks[0]!.text);
    expect(blocks[1]!.text).toBe("~~~~mermaid\n%% floe: d-3 %%\nC4Context\n~~~~");
  });

  test("resolves by id first, then by names, without case; ambiguity and misses are reasons", () => {
    expect(resolve(index, { id: "d-2", landscape: "Old name", diagram: "Old" })).toEqual(index[1]!);
    expect(resolve(index, { id: null, landscape: "payments", diagram: "context" })).toEqual(index[0]!);
    expect(resolve(index, { id: "gone", landscape: null, diagram: null })).toBe("no diagram with id gone");
    expect(resolve(index, { id: null, landscape: "Payments", diagram: "Nope" })).toBe('no diagram "Payments / Nope"');
    expect(resolve([...index, { id: "d-4", landscape: "Shop", diagram: "Context" }], { id: null, landscape: "Shop", diagram: "Context" })).toContain("use the id");
  });

  test("the refreshed block keeps its fence and indent, writes the line back with the id, and is stable", () => {
    const [b] = findBlocks("- item\n  ```mermaid\n  %% floe: Payments / Context\n  ```\n");
    const next = renderBlock(b!.text, index[0]!, C4);
    expect(next).toBe('  ```mermaid\n  %% floe: Payments / Context · d-1\n  C4Context\n    title Context\n\n    Person(customer_1, "Customer")\n  ```');
    const [again] = findBlocks(`- item\n${next}\n`);
    expect(again!.ref).toEqual({ id: "d-1", landscape: "Payments", diagram: "Context" });
    expect(renderBlock(again!.text, index[0]!, C4)).toBe(next);
  });
});
