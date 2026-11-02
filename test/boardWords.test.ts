import { describe, expect, test } from "bun:test";
import { arrowSentence, cardName } from "../web/lib/boardWords";

const notes = [{ path: "Boards/Roof.md", title: "Roof" }, { path: "Boards/Loft.md", title: "Loft" }];
const cards = new Map(
  [
    { id: "r", type: "file", file: "Boards/Roof.md" },
    { id: "l", type: "file", file: "boards/loft.md" },
    { id: "t", type: "text", text: "**Budget**: £20k\nmore" },
    { id: "g", type: "group", label: "Plans" },
    { id: "w", type: "link", url: "https://www.example.com/x" },
  ].map((c) => [c.id, c]),
);

describe("a board in words (F31)", () => {
  test("cards are named by what they show", () => {
    expect(cardName(cards.get("r"), notes)).toBe("Roof");
    expect(cardName(cards.get("l"), notes)).toBe("Loft");
    expect(cardName(cards.get("t"), notes)).toBe("Budget: £20k");
    expect(cardName(cards.get("g"), notes)).toBe("the group Plans");
    expect(cardName(cards.get("w"), notes)).toBe("example.com");
    expect(cardName({ id: "x", type: "file", file: "Gone/Shed.md" }, notes)).toBe("Shed");
    expect(cardName({ id: "e", type: "text", text: "" }, notes)).toBe("an empty text card");
  });

  test("an arrow reads in the direction it points", () => {
    expect(arrowSentence({ id: "e", fromNode: "r", toNode: "l", label: "comes before" }, cards, notes)).toBe("Roof → comes before → Loft");
    expect(arrowSentence({ id: "e", fromNode: "r", toNode: "l" }, cards, notes)).toBe("Roof → Loft");
    // A head only at the start points back.
    expect(arrowSentence({ id: "e", fromNode: "r", toNode: "l", fromEnd: "arrow", toEnd: "none" }, cards, notes)).toBe("Loft → Roof");
    expect(arrowSentence({ id: "e", fromNode: "r", toNode: "l", fromEnd: "arrow" }, cards, notes)).toBe("Roof ↔ Loft");
    expect(arrowSentence({ id: "e", fromNode: "r", toNode: "l", toEnd: "none", label: "near" }, cards, notes)).toBe("Roof — near — Loft");
  });
});
