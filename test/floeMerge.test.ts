import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/markdown";
import { entries, markRemoved, mergeNote, OVERVIEW_KEYS, regionOf, scalar } from "../src/floeMerge";

const API = `---
type: system
technologies: [Node.js]
owner: Payments team
floe-id: s1
---
Takes card payments.

## Uses

- → [[Stripe]] charges cards
`;

describe("Landscapes from Floe: what's Floe's and what's yours (F41)", () => {
  test("a new note: Floe's keys with floe-landscape, and Floe's text inside the markers", () => {
    const { content } = mergeNote(null, API, { "floe-landscape": "l1" });
    const fm = parseFrontmatter(content);
    expect(fm.data).toMatchObject({ type: "system", technologies: ["Node.js"], owner: "Payments team", "floe-id": "s1", "floe-landscape": "l1" });
    expect(fm.body).toMatch(/^<!-- floe -->\nTakes card payments\.[\s\S]*charges cards\n<!-- \/floe [0-9a-f]{8} -->\n$/);
    expect(regionOf(content)).toStartWith("Takes card payments.");
  });

  test("an update rewrites Floe's part and keeps the person's keys and writing, in place", () => {
    const first = mergeNote(null, API, { "floe-landscape": "l1" }).content;
    const mine = first
      .replace("floe-landscape: l1\n", "floe-landscape: l1\nreviewed: 2026-10-30\nrisks:\n  - card data\n")
      .replace(/(<!-- \/floe [0-9a-f]+ -->)\n$/, "$1\n\n## Why it's shaped like this\n\nOne API so the shops don't each hold card data.\n");
    const next = API.replace("owner: Payments team\n", "owner: Money team\nstatus: future\n").replace("Takes card payments.", "Takes card and wallet payments.");
    const m = mergeNote(mine, next, { "floe-landscape": "l1" });
    const fm = parseFrontmatter(m.content);
    expect(fm.data).toMatchObject({ owner: "Money team", status: "future", reviewed: "2026-10-30", risks: ["card data"] });
    expect(m.content).toContain("Takes card and wallet payments.");
    expect(m.content).not.toContain("Takes card payments.");
    expect(m.content).toContain("## Why it's shaped like this\n\nOne API so the shops don't each hold card data.");
    expect(m).toMatchObject({ edited: false, adopted: false, personal: true });
    // The same again changes nothing.
    expect(mergeNote(m.content, next, { "floe-landscape": "l1" }).content).toBe(m.content);
  });

  test("a key Floe no longer writes goes; a key that isn't Floe's stays", () => {
    const first = mergeNote(null, API.replace("floe-id", "external: true\nfloe-id"), { "floe-landscape": "l1" }).content.replace("---\n<!--", "colour: red\n---\n<!--");
    const fm = parseFrontmatter(mergeNote(first, API, { "floe-landscape": "l1" }).content).data;
    expect(fm.external).toBeUndefined();
    expect(fm.colour).toBe("red");
  });

  test("the person's edits to Floe's part are noticed, and Floe's wins", () => {
    const first = mergeNote(null, API, { "floe-landscape": "l1" }).content;
    const changedByMe = first.replace("Takes card payments.", "Takes card payments (and refunds, says Sam).");
    const m = mergeNote(changedByMe, API.replace("owner: Payments team", "owner: Money team"), { "floe-landscape": "l1" });
    expect(m.edited).toBe(true);
    expect(m.content).toContain("Takes card payments.\n");
    // An edit that matches what Floe now says isn't one to warn about.
    expect(mergeNote(changedByMe, API.replace("Takes card payments.", "Takes card payments (and refunds, says Sam)."), { "floe-landscape": "l1" }).edited).toBe(false);
    // Nor is an edit outside the markers.
    expect(mergeNote(first + "\nMy note.\n", API.replace("Payments team", "Money team"), { "floe-landscape": "l1" }).edited).toBe(false);
  });

  test("a note from an earlier plain import gets a region; its text stays below unless it was only Floe's", () => {
    const plain = API.replace("---\nTakes", "---\nMy own opening line.\n\nTakes");
    const m = mergeNote(plain, API, { "floe-landscape": "l1" });
    expect(m.adopted).toBe(true);
    expect(m.content.indexOf("<!-- /floe")).toBeLessThan(m.content.indexOf("My own opening line."));
    const same = mergeNote(API, API, { "floe-landscape": "l1" });
    expect(same.adopted).toBe(false);
    expect(same.content.match(/Takes card payments/g)).toHaveLength(1);
  });

  test("removed from Floe: status removed and a dated line in the region; writing kept; idempotent", () => {
    const first = mergeNote(null, API, { "floe-landscape": "l1" }).content + "\nMine.\n";
    const r = markRemoved(first, "2 Nov 2026");
    expect(parseFrontmatter(r).data.status).toBe("removed");
    expect(regionOf(r)).toStartWith("_Removed from Floe on 2 Nov 2026._");
    expect(r).toContain("Mine.");
    expect(markRemoved(r, "3 Nov 2026")).toBe(r);
    // It comes back in Floe: Floe's part again, nothing flagged as the person's edit.
    const back = mergeNote(r, API, { "floe-landscape": "l1" });
    expect(parseFrontmatter(back.content).data.status).toBeUndefined();
    expect(back.content).toContain("Mine.");
  });

  test("the overview's own keys", () => {
    const ov = "---\ntype: landscape\n---\n## Systems\n\n- [[Payments API]]\n";
    const { content } = mergeNote(null, ov, { "floe-landscape": "l1", "floe-updated": "2026-11-02", "floe-hash": "0a1b2c3d" }, OVERVIEW_KEYS);
    expect(parseFrontmatter(content).data).toEqual({ type: "landscape", "floe-landscape": "l1", "floe-updated": "2026-11-02", "floe-hash": "0a1b2c3d" });
  });

  test("frontmatter entries keep their nested lines; values are quoted only when they need it", () => {
    expect(entries("a: 1\nlist:\n  - x\n- y\n# note\nb: two").map((e) => e.key)).toEqual(["a", "list", null, "b"]);
    expect(scalar("3f2a-11")).toBe("3f2a-11");
    expect(scalar("2026-11-02")).toBe("2026-11-02");
    expect(scalar("12345")).toBe('"12345"');
    expect(scalar("yes")).toBe('"yes"');
    expect(scalar("a: b")).toBe('"a: b"');
  });
});
