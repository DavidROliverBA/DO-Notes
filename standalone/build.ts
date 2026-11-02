// Builds Commonplace as one self-contained HTML file: `bun standalone/build.ts`.
// Bundles standalone/main.tsx (which reuses the app's editor, renderer, dialogs and styles),
// swaps web/lib/api.ts for a stand-in that reads the open folder, and inlines the script and
// stylesheet (and Mermaid, packed) so the file works from disk with no server. The help's pages
// marked `standalone: true` come with their pictures inside (web/lib/helpImages.ts is swapped).

import { gzipSync } from "fflate";
import { dataviewjsSandbox } from "../src/sandbox";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const out = join(here, "dist", "commonplace.html");
const shim = join(here, "api-shim.ts");
const mermaidShim = join(here, "mermaid-lib.ts");
const pkg = await Bun.file(join(here, "..", "package.json")).json();

// The help's pictures that the standalone pages show, as data: addresses.
const helpDir = join(here, "..", "docs", "help");
const helpImages: Record<string, string> = {};
for (const page of new Bun.Glob("*.md").scanSync(helpDir)) {
  const text = await Bun.file(join(helpDir, page)).text();
  if (!/^---\n[\s\S]*?^standalone: true$[\s\S]*?^---$/m.test(text)) continue;
  for (const [, name] of text.matchAll(/\]\(images\/([\w-]+\.webp)\)/g))
    helpImages[name!] = `data:image/webp;base64,${Buffer.from(await Bun.file(join(helpDir, "images", name!)).bytes()).toString("base64")}`;
}

const result = await Bun.build({
  entrypoints: [join(here, "main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "local-api",
      setup(b) {
        // Every `./api` (or `../lib/api`) import in the shared client code resolves to the shim.
        b.onResolve({ filter: /(^|\/)api(\.ts)?$/ }, (args) => {
          const target = join(dirname(args.importer), args.path).replace(/\.ts$/, "");
          return target.endsWith(join("web", "lib", "api")) ? { path: shim } : undefined;
        });
        // Mermaid comes from inside the file, not the server.
        b.onResolve({ filter: /(^|\/)mermaidLib(\.ts)?$/ }, () => ({ path: mermaidShim }));
        // The help shows only its standalone pages, with their pictures inside the file.
        b.onResolve({ filter: /(^|\/)helpImages(\.ts)?$/ }, () => ({ path: "help-images", namespace: "cp-help" }));
        b.onLoad({ filter: /.*/, namespace: "cp-help" }, () => ({
          loader: "ts",
          contents: `const IMAGES: Record<string, string> = ${JSON.stringify(helpImages)};\nexport const HELP_STANDALONE = true;\nexport const helpImageUrl = (name: string) => IMAGES[name] ?? "";\n`,
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

let js = "";
let css = "";
for (const o of result.outputs) {
  if (o.path.endsWith(".js")) js += await o.text();
  else if (o.path.endsWith(".css")) css += await o.text();
}
// Nothing in the inlined code may close its own tag early.
const safe = (s: string, tag: string) => s.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

// Mermaid's browser build, gzipped: unpacked only when a note has a diagram (standalone/mermaid-lib.ts).
const mermaidJs = await Bun.file(join(dirname(Bun.resolveSync("mermaid/package.json", here)), "dist", "mermaid.min.js")).bytes();
const mermaidPacked = Buffer.from(gzipSync(mermaidJs, { level: 9 })).toString("base64");

// The dataviewjs sandbox page (src/sandbox.ts), shown in its frames with srcdoc.
const sandboxPacked = Buffer.from(gzipSync(new TextEncoder().encode((await dataviewjsSandbox()).html), { level: 9 })).toString("base64");

const icon = await Bun.file(join(here, "..", "web", "icon.svg")).text();
const html = `<!doctype html>
<!-- DO Notes ${pkg.version}, MIT licence. It includes open-source packages, each under its own licence; their notices: https://github.com/DavidROliverBA/commonplace-md/blob/main/THIRD_PARTY_NOTICES.md -->
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="generator" content="DO Notes ${pkg.version} standalone">
<title>DO Notes</title>
<meta name="description" content="A Markdown editor for a folder of notes, in one file.">
<meta name="theme-color" content="#f7f6fb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1b22" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">
<style>${safe(css, "style")}</style>
</head>
<body>
<div id="root"></div>
<script type="application/octet-stream" id="mermaid-lib">${mermaidPacked}</script>
<script type="application/octet-stream" id="dvjs-sandbox">${sandboxPacked}</script>
<script type="module">${safe(js, "script")}</script>
</body>
</html>
`;
await Bun.write(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`);
