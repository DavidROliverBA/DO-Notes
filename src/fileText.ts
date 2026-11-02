// The words inside files, for search (docs/BACKLOG.md, Phase 2): a PDF's text is read here, on the
// server, when it's added (and, for PDFs added before, in the background at boot); a photo's
// words and a voice note's transcript are read on the iPhone or Mac, where Apple's own text and
// speech recognition run privately, and arrive with the file (src/capture.ts). Kept on the
// attachment (attachments.text), never written into a note, so notes stay as they were.
// Search finds the notes that show or link the file (src/search.ts).

import { extractText, getDocumentProxy } from "unpdf";
import { sql } from "./db";

const MAX_TEXT = 200_000;

/** A PDF's text, or "" when it has none (a scan) or can't be read. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(doc, { mergePages: true });
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  } catch {
    return "";
  }
}

/** Keep a file's words. `""` records that it was read and had none, so it isn't read again. */
export async function setFileText(vaultId: number, path: string, text: string): Promise<void> {
  await sql`update attachments set text = ${text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)} where vault_id = ${vaultId} and path = ${path}`;
}

/** Read a just-saved PDF without making the upload wait. */
export function readPdfLater(vaultId: number, path: string, bytes: Uint8Array): void {
  if (!/\.pdf$/i.test(path)) return;
  void pdfText(bytes)
    .then((t) => setFileText(vaultId, path, t))
    .catch(() => {});
}

/** PDFs added before this was built: read a few at a time in the background. */
export async function readOldPdfs(batch = 20): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = await sql`select vault_id, path, data from attachments where text is null and mime = 'application/pdf' limit ${batch}`;
    if (!rows.length) return done;
    for (const r of rows) {
      await setFileText(Number(r.vault_id), r.path, await pdfText(r.data));
      done++;
    }
  }
}
