// What every "keep a vault in step with a set of files" path shares: GitHub vaults (F14,
// src/git.ts) and folder vaults on the Mac (F22, src/folderSync.ts). Which files come across,
// the paths they get, and the text form they're compared in.

import { createHash } from "node:crypto";
import { isAttachmentPath, normalisePath } from "./markdown";

export const md5 = (data: string | Uint8Array) => createHash("md5").update(data).digest("hex");
/** Notes, and boards (F11), which are notes holding JSON Canvas. */
export const isNotePath = (p: string) => /\.(md|markdown|canvas)$/i.test(p);
/** Text as notes store it: no BOM, LF line endings (as zip imports do). */
export const asText = (data: Uint8Array) => new TextDecoder().decode(data).replace(/^﻿/, "").replace(/\r\n/g, "\n");

/** Copied in: markdown and attachments, not inside a dot-folder (app settings, .github) or node_modules. */
export function importable(rel: string): boolean {
  if (rel.split("/").some((s) => s.startsWith(".") || s === "node_modules")) return false;
  return isNotePath(rel) || isAttachmentPath(rel);
}

/** The vault path for a file's relative path, or null if it can't be one. */
export function vaultPathFor(rel: string): string | null {
  try {
    return isNotePath(rel) ? normalisePath(rel.replace(/\.markdown$/i, ".md")) : normalisePath(rel, null);
  } catch {
    return null;
  }
}

/** Run `fn` over `items`, `n` at a time. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}
