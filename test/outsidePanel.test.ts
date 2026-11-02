import { expect, test } from "bun:test";
import { inputFor, itemsIn } from "../src/outsidePanel";

test("the first list with titles in an answer: Longview's events, Recall's cards, plain results", () => {
  expect(itemsIn({ events: [{ id: "e1", title: "Gemini 4 Carbon released", url: "https://e.com/g", date: "2026-10-30T09:00:00Z" }] })).toEqual([
    { title: "Gemini 4 Carbon released", url: "https://e.com/g", date: "2026-10-30" },
  ]);
  expect(itemsIn({ cards: [{ card_id: "c", title: "How to tile", source_url: "https://e.com/t" }], has_more: false })).toEqual([{ title: "How to tile", url: "https://e.com/t", date: null }]);
  expect(itemsIn({ data: { results: [{ name: "Payments" }] } })).toEqual([{ title: "Payments", url: null, date: null }]);
  // Only web addresses are links; nothing without a title; at most five.
  expect(itemsIn([{ title: "x", url: "javascript:alert(1)" }])).toEqual([{ title: "x", url: null, date: null }]);
  expect(itemsIn({ items: [{ id: 1 }] })).toEqual([]);
  expect(itemsIn({ list: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}` })) })).toHaveLength(5);
  expect(itemsIn("plain text")).toEqual([]);
});

test("a tool can look a note up when it's read-only and takes one text input", () => {
  const t = (input_schema: object, kind: "read" | "unknown" = "read") => ({ name: "x", input_schema: input_schema as Record<string, unknown>, kind });
  expect(inputFor({ preset: null }, t({ properties: { q: { type: "string" } }, required: ["q"] }))).toBe("q");
  expect(inputFor({ preset: null }, t({ properties: { q: { type: "string" }, limit: { type: "number" } } }))).toBe("q");
  expect(inputFor({ preset: null }, t({ properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] }))).toBeNull();
  expect(inputFor({ preset: null }, t({ properties: {} }))).toBeNull();
  expect(inputFor({ preset: null }, t({ properties: { q: { type: "string" } } }, "unknown"))).toBeNull();
  // A preset says which input, or that it's not for the panel.
  expect(inputFor({ preset: "longview" }, { name: "search_intelligence", input_schema: {}, kind: "read" })).toBe("query");
  expect(inputFor({ preset: "longview" }, { name: "get_trend", input_schema: { properties: { entity: { type: "string" } } }, kind: "read" })).toBeNull();
});
