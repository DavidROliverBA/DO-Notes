// Boards (F11): JSON Canvas read, written and kept in a Yjs document (src/canvas.ts, src/ydoc.ts).

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { applyCanvasDiff, canvasFromDoc, canvasLinks, canvasMaps, canvasText, parseCanvas, serialiseCanvas, setField } from "../src/canvas";
import { docContent, loadDoc, rebaseStoredDoc } from "../src/ydoc";

// As Obsidian writes it.
const OBSIDIAN = `{
	"nodes":[
		{"id":"a1","type":"text","text":"# Idea\\nSee [[Plan]]","x":-200,"y":-100,"width":250,"height":120},
		{"id":"b2","type":"file","file":"Projects/Kitchen.md","x":120,"y":-100,"width":400,"height":400,"color":"4"},
		{"id":"g3","type":"group","label":"Next","x":-260,"y":-160,"width":900,"height":600}
	],
	"edges":[
		{"id":"e1","fromNode":"a1","fromSide":"right","toNode":"b2","toSide":"left","label":"leads to"}
	]
}`;

describe("JSON Canvas", () => {
  test("an Obsidian file writes back byte for byte", () => {
    expect(serialiseCanvas(parseCanvas(OBSIDIAN)!)).toBe(OBSIDIAN);
  });

  test("unknown keys, top-level and per card, are kept", () => {
    const c = parseCanvas('{"nodes":[{"id":"x","type":"text","text":"hi","x":0,"y":0,"width":1,"height":1,"styleAttributes":{"shape":"pill"}}],"edges":[],"metadata":{"v":1}}')!;
    const out = parseCanvas(serialiseCanvas(c))!;
    expect(out.nodes[0]!.styleAttributes).toEqual({ shape: "pill" });
    expect(out.extra).toEqual({ metadata: { v: 1 } });
  });

  test("not JSON is null; empty is an empty board", () => {
    expect(parseCanvas("{nope")).toBeNull();
    expect(parseCanvas("[]")).toBeNull();
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [], extra: {} });
  });

  test("links: note cards, [[links]] in text cards and arrow labels; not pictures", () => {
    const c = parseCanvas(OBSIDIAN)!;
    c.nodes.push({ id: "p", type: "file", file: "attachments/photo.png", x: 0, y: 0, width: 1, height: 1 });
    c.nodes.push({ id: "n", type: "file", file: "Other board.canvas", x: 0, y: 0, width: 1, height: 1 });
    expect(canvasLinks(c).sort()).toEqual(["other board.canvas", "plan", "projects/kitchen"]);
    expect(canvasText(c)).toContain("leads to");
  });
});

describe("a board's live document", () => {
  test("load, read back and keep the stored text while nothing changes", () => {
    const doc = loadDoc(OBSIDIAN, null, true);
    expect(serialiseCanvas(canvasFromDoc(doc))).toBe(OBSIDIAN);
    expect(docContent(doc, true, OBSIDIAN)).toBe(OBSIDIAN);
    // Text written differently (another editor's spacing) is kept until a card changes.
    const loose = JSON.stringify(JSON.parse(OBSIDIAN), null, 2);
    expect(docContent(loadDoc(loose, null, true), true, loose)).toBe(loose);
  });

  test("a moved card changes only its line", () => {
    const doc = loadDoc(OBSIDIAN, null, true);
    canvasMaps(doc).nodes.get("a1")!.set("x", 0);
    const out = docContent(doc, true, OBSIDIAN);
    const diff = out.split("\n").filter((l, i) => l !== OBSIDIAN.split("\n")[i]);
    expect(diff).toEqual(['\t\t{"id":"a1","type":"text","text":"# Idea\\nSee [[Plan]]","x":0,"y":-100,"width":250,"height":120},']);
  });

  test("two people moving different cards merge", () => {
    const a = loadDoc(OBSIDIAN, null, true);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    canvasMaps(a).nodes.get("a1")!.set("x", 10);
    canvasMaps(b).nodes.get("b2")!.set("y", 20);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ca = canvasFromDoc(a);
    expect(ca.nodes.find((n) => n.id === "a1")!.x).toBe(10);
    expect(ca.nodes.find((n) => n.id === "b2")!.y).toBe(20);
    expect(serialiseCanvas(ca)).toBe(serialiseCanvas(canvasFromDoc(b)));
  });

  test("typing in the same text card from two places merges", () => {
    const a = loadDoc(OBSIDIAN, null, true);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    (canvasMaps(a).nodes.get("a1")!.get("text") as Y.Text).insert(0, "A ");
    setField(canvasMaps(b).nodes.get("a1")!, "text", "# Idea\nSee [[Plan]] now");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(canvasFromDoc(a).nodes[0]!.text).toBe("A # Idea\nSee [[Plan]] now");
  });

  test("an outside change is patched in by id, not rebuilt (an offline copy merges cleanly)", () => {
    const server = loadDoc(OBSIDIAN, null, true);
    const phone = new Y.Doc();
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(server));
    // The folder's copy drops the group and moves a card; the phone, offline, adds a card.
    const next = parseCanvas(OBSIDIAN)!;
    next.nodes = next.nodes.filter((n) => n.id !== "g3");
    next.nodes[0]!.y = 50;
    const stored = rebaseStoredDoc(OBSIDIAN, Y.encodeStateAsUpdate(server), serialiseCanvas(next), true);
    const m = new Y.Map<unknown>();
    canvasMaps(phone).nodes.set("new", m);
    m.set("type", "text");
    m.set("z", 9);
    Y.applyUpdate(phone, stored);
    const ids = canvasFromDoc(phone).nodes.map((n) => n.id);
    expect(ids).toEqual(["a1", "b2", "new"]);
    expect(canvasFromDoc(phone).nodes[0]!.y).toBe(50);
  });

  test("drawing order follows the file's order, and a reorder is kept", () => {
    const doc = loadDoc(OBSIDIAN, null, true);
    const next = parseCanvas(OBSIDIAN)!;
    next.nodes.reverse();
    doc.transact(() => applyCanvasDiff(doc, next));
    expect(canvasFromDoc(doc).nodes.map((n) => n.id)).toEqual(["g3", "b2", "a1"]);
  });

  test("a broken file is left as it is", () => {
    const doc = loadDoc("{ not json", null, true);
    expect(docContent(doc, true, "{ not json")).toBe("{ not json");
    expect(() => rebaseStoredDoc("{}", null, "{ nope", true)).toThrow("isn't a board");
  });
});
