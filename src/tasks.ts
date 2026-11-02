// The task lines of a note (`- [ ] step 📅 2026-10-12`), shared by the server's Tasks page
// (src/vaultViews.ts) and the standalone file, which reads them from the folder it has open.

import { maskCode, parseFrontmatter } from "./markdown";

export const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s?)(.*)$/;
/** A due date in the common Tasks format: 📅 2026-10-12. */
const DUE = /📅\s*(\d{4}-\d{2}-\d{2})/u;

export interface Task {
  noteId: number;
  path: string;
  title: string;
  type: string | null;
  /** 0-based line in the note. */
  line: number;
  text: string;
  done: boolean;
  due: string | null;
}

/** The task lines of a note, skipping code blocks and frontmatter. */
export function tasksIn(content: string): { line: number; text: string; done: boolean; due: string | null }[] {
  const fm = parseFrontmatter(content);
  const skip = content.length - fm.body.length;
  const firstLine = content.slice(0, skip).split("\n").length - 1;
  const masked = maskCode(content).split("\n");
  const lines = content.split("\n");
  const out: { line: number; text: string; done: boolean; due: string | null }[] = [];
  for (let i = skip ? firstLine : 0; i < lines.length; i++) {
    const m = TASK.exec(masked[i]!);
    if (!m) continue;
    const real = TASK.exec(lines[i]!)!;
    out.push({ line: i, text: real[4]!.trim(), done: real[2] !== " ", due: DUE.exec(real[4]!)?.[1] ?? null });
  }
  return out;
}
