// Editor usability: word counts, code coloured by language, and formatting that toggles.
import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { hasMark, toggleMark } from "../web/lib/format";
import { codeBlockHtml, codeLanguage, highlightedCode } from "../src/codeHighlight";
import { countWords, readingMinutes } from "../src/markdown";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

describe("word count", () => {
  test("counts words, not markdown's marks", () => {
    expect(countWords("# Plan\n\n- [ ] Book the tiler\n> quote — here\n| a | b |")).toBe(8);
    expect(countWords("")).toBe(0);
    expect(countWords("  \n ")).toBe(0);
    expect(countWords("naïve café 2026")).toBe(3);
  });
  test("reading time is at least a minute, at 220 words a minute", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(220)).toBe(1);
    expect(readingMinutes(1100)).toBe(5);
  });
});

describe("code colouring", () => {
  test("languages by name or alias, and only ones we know", () => {
    expect(codeLanguage("ts")).not.toBeNull();
    expect(codeLanguage("TypeScript title=x")).toBe(codeLanguage("ts"));
    expect(codeLanguage("py")).toBe(codeLanguage("python"));
    expect(codeLanguage("zsh")).toBe(codeLanguage("bash"));
    expect(codeLanguage("cobol")).toBeNull();
    expect(codeLanguage("")).toBeNull();
  });
  test("coloured spans, with the code itself escaped and unchanged", () => {
    const html = highlightedCode('const s = "<b>"; // hi', "js", esc)!;
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-string">&quot;&lt;b&gt;&quot;</span>');
    expect(html).toContain('<span class="tok-comment">// hi</span>');
    expect(html.replace(/<[^>]+>/g, "")).toBe(esc('const s = "<b>"; // hi'));
    expect(highlightedCode("select 1 from t", "sql", esc)).toContain("tok-keyword");
    expect(highlightedCode("echo $HOME", "sh", esc)).toContain("<span");
    expect(highlightedCode("x", "cobol", esc)).toBeNull();
  });
  test("a block names its language and, in the app, has Copy; unknown ones stay plain", () => {
    const app = codeBlockHtml("print(1)\n", "python", esc, true);
    expect(app).toContain('<span class="code-lang">Python</span>');
    expect(app).toContain('class="code-copy"');
    expect(app).toContain('class="language-python"');
    const site = codeBlockHtml("<x>", "cobol", esc, false);
    expect(site).not.toContain("code-copy");
    expect(site).toContain("<code class=\"language-cobol\">&lt;x&gt;</code>");
    expect(codeBlockHtml("x", "", esc, false)).toBe('<div class="code-block"><pre><code>x</code></pre></div>\n');
  });
});

describe("formatting toggles (release 3)", () => {
  // "a [b] c": the selection in brackets; returns the text after, with the new selection marked.
  const apply = (marked: string, mark: Parameters<typeof toggleMark>[1]) => {
    const from = marked.indexOf("[");
    const to = marked.indexOf("]") - 1;
    let state = EditorState.create({ doc: marked.replace("[", "").replace("]", ""), selection: EditorSelection.single(from, to) });
    state = state.update(toggleMark(state, mark)).state;
    const r = state.selection.main;
    const d = state.doc.toString();
    return `${d.slice(0, r.from)}[${d.slice(r.from, r.to)}]${d.slice(r.to)}`;
  };
  test("wraps, and unwraps from outside or inside", () => {
    expect(apply("a [word] b", "**")).toBe("a **[word]** b");
    expect(apply("a **[word]** b", "**")).toBe("a [word] b");
    expect(apply("a [**word**] b", "**")).toBe("a [word] b");
    expect(apply("a [word ]b", "**")).toBe("a **[word]** b");
    expect(apply("x [y] z", "==")).toBe("x ==[y]== z");
    expect(apply("x `[y]` z", "`")).toBe("x [y] z");
  });
  test("italic and bold share * but don't undo each other", () => {
    expect(apply("a **[word]** b", "*")).toBe("a ***[word]*** b");
    expect(apply("a ***[word]*** b", "*")).toBe("a **[word]** b");
    expect(apply("a ***[word]*** b", "**")).toBe("a *[word]* b");
    expect(apply("a *[word]* b", "**")).toBe("a ***[word]*** b");
  });
  test("knows what the selection already is", () => {
    const st = (doc: string, from: number, to: number) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });
    expect(hasMark(st("**bold**", 2, 6), "**")).toBe(true);
    expect(hasMark(st("**bold**", 2, 6), "*")).toBe(false);
    expect(hasMark(st("*it*", 1, 3), "*")).toBe(true);
    expect(hasMark(st("plain", 0, 5), "**")).toBe(false);
  });
});
