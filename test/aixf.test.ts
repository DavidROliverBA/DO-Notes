// AI-XF (F9): ids, the canonical form and the mapping between relations and typed links.

import { describe, expect, test } from "bun:test";
import { ID_RE, idFor, isUntitled, kebabId } from "../src/aixfId";

describe("ids", () => {
  test("lowercase words joined by -, accents and symbols dropped", () => {
    expect(kebabId("Kitchen extension")).toBe("kitchen-extension");
    expect(kebabId("Café table & chairs")).toBe("cafe-table-and-chairs");
    expect(kebabId("  2026-10-31 Roof: quote #2!  ")).toBe("2026-10-31-roof-quote-2");
    expect(kebabId("Unicode — naïve façade")).toBe("unicode-naive-facade");
    for (const t of ["Kitchen extension", "日本の庭", "Café", "a/b\\c", "--x--"]) expect(idFor(t, new Set())).toMatch(ID_RE);
  });

  test("taken ids get -2, -3; a title with no Latin letters gets a stable hash", () => {
    expect(idFor("Plan", new Set(["plan"]))).toBe("plan-2");
    expect(idFor("Plan", new Set(["plan", "plan-2"]))).toBe("plan-3");
    expect(idFor("日本の庭", new Set())).toMatch(/^note-[0-9a-f]{6}$/);
    expect(idFor("日本の庭", new Set())).toBe(idFor("日本の庭", new Set()));
    expect(idFor("日本の庭", new Set())).not.toBe(idFor("مرحبا", new Set()));
  });

  test("Untitled notes wait to be named", () => {
    expect(isUntitled("Untitled")).toBe(true);
    expect(isUntitled("Untitled 3")).toBe(true);
    expect(isUntitled("Untitled thoughts")).toBe(false);
  });
});
