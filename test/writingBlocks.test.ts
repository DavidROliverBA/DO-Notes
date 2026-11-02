import { describe, expect, test } from "bun:test";
import { STATUS_ALL, statusColour, statusMarkdown, TOC_RE, tocHtml } from "../src/blocks";
import { headings } from "../src/markdown";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

describe("writing blocks (F28)", () => {
  test("status: written as a directive, read back with its colour", () => {
    expect(statusMarkdown("On track", "green")).toBe(":status[On track]{.green}");
    expect(statusMarkdown("Draft", "grey")).toBe(":status[Draft]");
    expect(statusMarkdown("a [b]\nc", "red")).toBe(":status[a bc]{.red}");
    const m = [..."x :status[Done]{.green} and :status[Hmm]{.teal}".matchAll(STATUS_ALL)];
    expect(m.map((x) => [x[1], statusColour(x[2])])).toEqual([
      ["Done", "green"],
      ["Hmm", "grey"],
    ]);
  });

  test("[TOC]: the headings under the title, three levels deep, escaped", () => {
    expect(TOC_RE.test("[TOC]")).toBe(true);
    expect(TOC_RE.test(" [toc] ")).toBe(true);
    expect(TOC_RE.test("see [TOC] here")).toBe(false);
    const html = tocHtml(headings("# Plan\n\n## Goals\n\n### <b>Q1</b>\n\n##### Deep\n\n```\n## not a heading\n```\n"), (_h, i) => `#h${i}`, esc);
    expect(html).toContain('href="#h1" data-heading="1">Goals<');
    expect(html).toContain('class="toc-l1"');
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("Plan");
    expect(html).not.toContain("not a heading");
    expect(html).not.toContain("Deep");
    expect(tocHtml([], () => "#", esc)).toContain("No headings yet.");
  });
});

describe("a note's look (F28)", async () => {
  const { coverSrc, emojiIcon, findEmoji, loadEmoji } = await import("../web/lib/look");
  test("emoji by name: every word must start one, whole first words first", async () => {
    const all = await loadEmoji();
    expect(all.length).toBeGreaterThan(1000);
    expect(findEmoji(all, "rocke").map((e) => e.char)).toEqual(["🚀"]);
    expect(findEmoji(all, "red heart")[0]!.char).toBe("❤️");
    expect(findEmoji(all, "rock")[0]!.name).toBe("rock");
    expect(findEmoji(all, "zzzz")).toEqual([]);
  });
  test("icon only if an emoji; cover only an attachment or https", () => {
    expect(emojiIcon("🚀")).toBe("🚀");
    expect(emojiIcon("user")).toBeNull();
    expect(emojiIcon(3)).toBeNull();
    expect(coverSrc(4, "[[attachments/a b.png]]")).toBe("/api/vaults/4/files?path=attachments%2Fa%20b.png");
    expect(coverSrc(4, "https://example.com/x.jpg")).toBe("https://example.com/x.jpg");
    expect(coverSrc(4, "http://example.com/x.jpg")).toBeNull();
    expect(coverSrc(4, "javascript:alert(1)")).toBeNull();
    expect(coverSrc(4, "Notes/page.md")).toBeNull();
  });
});
