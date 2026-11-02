// A note's look (F28, from Confluence): an emoji icon beside its title, a cover picture above it,
// and a wider page. Each is an ordinary property, so the note stays plain Markdown:
//
//   icon: 🚀                              (a note in Types/ uses `icon` for its type's icon)
//   cover: "[[attachments/harbour.jpg]]"  (or an https address)
//   width: wide                           (or full)
//
// Also the emoji themselves, for `:name` as you type and the icon picker, loaded when first
// needed so the app doesn't carry them until then.

import { isAttachmentPath } from "../../src/markdown";
import { api } from "./api";
import type { EditorHandle } from "../components/Editor";
import { pickFile } from "./journal";
import { prepareImage } from "./resizeImage";
import { fileUrl } from "./render";
import { chooseDialog, promptDialog, toastError } from "../ui/overlays";

export interface Emoji {
  char: string;
  name: string;
}

let emoji: Promise<Emoji[]> | null = null;
export function loadEmoji(): Promise<Emoji[]> {
  emoji ??= import("unicode-emoji-json/data-by-emoji.json").then((m) =>
    Object.entries((m.default ?? m) as Record<string, { name: string }>).map(([char, v]) => ({ char, name: v.name })),
  );
  return emoji;
}

/** Emoji whose name has a word starting with `q` ("hea" → heart, head…), whole words first. */
export function findEmoji(all: Emoji[], q: string, limit = 40): Emoji[] {
  const words = q.toLowerCase().replace(/[_-]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return all.slice(0, limit);
  const score = (e: Emoji) => {
    const name = e.name.toLowerCase().split(/[\s:-]+/);
    if (!words.every((w) => name.some((n) => n.startsWith(w)))) return null;
    return (name[0] === words[0] ? 2 : 0) + (name.includes(words[0]!) ? 1 : 0) - name.length / 100;
  };
  return all
    .map((e) => ({ e, s: score(e) }))
    .filter((x): x is { e: Emoji; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

/** An `icon` value that's an emoji (not a type's icon name such as "user"). */
export function emojiIcon(v: unknown): string | null {
  return typeof v === "string" && /^\p{Extended_Pictographic}/u.test(v.trim()) && [...v.trim()].length <= 8 ? v.trim() : null;
}

/** Where a `cover` value's picture is: an attachment of the collection, or an https address. */
export function coverSrc(vaultId: number, v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0]!.trim();
  if (/^https:\/\/[^\s"]+$/i.test(s)) return s;
  return !/^[a-z][a-z0-9+.-]*:/i.test(s) && isAttachmentPath(s) ? fileUrl(vaultId, s) : null;
}

/** Icon…: pick an emoji by name, or remove the one there. */
export async function pickIcon(e: EditorHandle, current: string | null) {
  const all = await loadEmoji();
  const options = [...(current ? [{ value: "", label: "Remove the icon", icon: "x" }] : []), ...all.map((x) => ({ value: x.char, label: `${x.char}  ${x.name}` }))];
  const choice = await chooseDialog({ title: "Icon", options, placeholder: "Rocket, star, house…", empty: "No emoji has that name" });
  if (choice === null) return;
  e.setProperty("icon", choice || null);
}

/** Cover…: upload a picture, use one from the web, or remove it. */
export async function pickCover(vaultId: number, e: EditorHandle, current: string | null) {
  const how = await chooseDialog({
    title: "Cover picture",
    options: [
      { value: "upload", label: "Upload a picture…", icon: "image" },
      { value: "web", label: "A picture on the web…", icon: "globe" },
      ...(current ? [{ value: "remove", label: "Remove the cover", icon: "x" }] : []),
    ],
  });
  if (how === "remove") return e.setProperty("cover", null);
  if (how === "web") {
    const url = await promptDialog({ title: "Cover picture", label: "Its address", placeholder: "https://…", action: "Use it" });
    if (!url) return;
    if (!/^https:\/\/\S+$/i.test(url.trim())) return toastError(new Error("A picture's address starts with https://"));
    return e.setProperty("cover", url.trim());
  }
  if (how !== "upload") return;
  const picked = await pickFile("image/*");
  if (!picked) return;
  try {
    const file = await prepareImage(picked);
    const form = new FormData();
    form.append("file", file, file.name || "Cover.jpg");
    const { path } = await api<{ path: string }>(`/vaults/${vaultId}/files`, { form });
    e.setProperty("cover", `[[${path}]]`);
  } catch (err) {
    toastError(err);
  }
}
