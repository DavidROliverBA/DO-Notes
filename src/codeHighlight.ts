// Code blocks coloured by language: the editor (as Markdown's nested languages), reading view
// and published pages (as `tok-*` classes, coloured by markdown.css) share these parsers, so
// code looks the same everywhere. A short list of common languages rather than every one, since
// each parser adds to the app's size. Shared with the browser: keep it free of server imports.

import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { jsonLanguage } from "@codemirror/lang-json";
import { pythonLanguage } from "@codemirror/lang-python";
import { StandardSQL } from "@codemirror/lang-sql";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { type Language, StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { classHighlighter, highlightCode } from "@lezer/highlight";

export interface CodeLanguage {
  /** As offered in the language picker, and written after the ``` fence. */
  name: string;
  label: string;
  /** Other names people write after the fence. */
  aliases: string[];
  language: Language;
}

const shellLanguage = StreamLanguage.define(shell);

export const CODE_LANGUAGES: CodeLanguage[] = [
  { name: "js", label: "JavaScript", aliases: ["javascript", "mjs", "cjs"], language: javascriptLanguage },
  { name: "ts", label: "TypeScript", aliases: ["typescript"], language: typescriptLanguage },
  { name: "jsx", label: "JSX", aliases: [], language: jsxLanguage },
  { name: "tsx", label: "TSX", aliases: [], language: tsxLanguage },
  { name: "python", label: "Python", aliases: ["py"], language: pythonLanguage },
  { name: "sql", label: "SQL", aliases: ["postgres", "postgresql", "psql"], language: StandardSQL.language },
  { name: "json", label: "JSON", aliases: ["jsonc"], language: jsonLanguage },
  { name: "yaml", label: "YAML", aliases: ["yml"], language: yamlLanguage },
  { name: "html", label: "HTML", aliases: ["xml", "svg"], language: htmlLanguage },
  { name: "css", label: "CSS", aliases: [], language: cssLanguage },
  { name: "bash", label: "Shell", aliases: ["sh", "shell", "zsh", "console"], language: shellLanguage },
];

const byName = new Map(CODE_LANGUAGES.flatMap((l) => [l.name, ...l.aliases].map((n) => [n, l.language] as const)));

/** The language for a fence's info string (```ts title="x"), or null for one we don't colour. */
export function codeLanguage(info: string | undefined | null): Language | null {
  const name = info?.trim().split(/\s/)[0]?.toLowerCase();
  return (name && byName.get(name)) || null;
}

/** The code as HTML with `tok-*` spans, or null when its language isn't one we colour. */
export function highlightedCode(code: string, info: string | undefined | null, esc: (s: string) => string): string | null {
  const lang = codeLanguage(info);
  if (!lang) return null;
  let out = "";
  highlightCode(
    code,
    lang.parser.parse(code),
    classHighlighter,
    (text, classes) => (out += classes ? `<span class="${classes}">${esc(text)}</span>` : esc(text)),
    () => (out += "\n"),
  );
  return out;
}

/** A fenced code block as HTML: coloured when its language is one we know, with its language
 *  named and (in the app, not on published pages, which run no script) a Copy button. */
export function codeBlockHtml(code: string, info: string | undefined | null, esc: (s: string) => string, copy: boolean): string {
  const name = info?.trim().split(/\s/)[0]?.toLowerCase() ?? "";
  const known = CODE_LANGUAGES.find((l) => l.name === name || l.aliases.includes(name));
  const body = highlightedCode(code, name, esc) ?? esc(code);
  const label = known?.label ?? name;
  const bar =
    label || copy
      ? `<div class="code-bar">${label ? `<span class="code-lang">${esc(label)}</span>` : ""}${copy ? `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>` : ""}</div>`
      : "";
  return `<div class="code-block">${bar}<pre><code${name ? ` class="language-${esc(name)}"` : ""}>${body}</code></pre></div>\n`;
}
