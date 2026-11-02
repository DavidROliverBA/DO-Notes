// Changing relationships (F31): each is a property in the note it starts from, its value one
// [[link]] or a list of them. `editRelations` makes a set of changes, across one note or two
// (Reverse takes one out of a note and writes it into the other), and gives back the Undo that
// puts every property it touched back as it was.

import { kebabId } from "../../src/aixfId";
import { linkTargets } from "../../src/types";
import { api, type Note, type NoteSummary } from "./api";

export interface RelationEdit {
  note: number;
  /** The property, as it's spelled in that note if it's there already (any spelling of the name). */
  key: string;
  /** A link to add, `[[Loft]]`. */
  add?: string;
  /** A note whose link to take out, by what the link points at. */
  remove?: NoteSummary;
}

/** The link to write to a note: its title, or its path when another note has the same title. */
export function linkFor(n: NoteSummary, all: NoteSummary[]) {
  const same = all.filter((x) => x.title.toLowerCase() === n.title.toLowerCase()).length > 1;
  return `[[${same ? n.path.replace(/\.md$/i, "") : n.title}]]`;
}

/** Whether a link points at this note (by title, path or the end of its path). */
export function pointsAt(link: string, n: NoteSummary) {
  const t = linkTargets(link)[0]?.toLowerCase();
  if (!t) return false;
  const p = n.path.replace(/\.md$/i, "").toLowerCase();
  return t === n.title.toLowerCase() || t === p || p.endsWith(`/${t}`);
}

const asList = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map(String);

/** Make the changes. Returns false when there was nothing to do (the link is there already),
 *  otherwise the Undo. */
export async function editRelations(vaultId: number, edits: RelationEdit[]): Promise<false | (() => Promise<void>)> {
  const ids = [...new Set(edits.map((e) => e.note))];
  const fms = new Map<number, Record<string, unknown>>();
  await Promise.all(ids.map(async (id) => fms.set(id, (await api<Note & { frontmatter?: Record<string, unknown> }>(`/vaults/${vaultId}/notes/${id}`)).frontmatter ?? {})));
  const was = new Map<number, Record<string, unknown>>(); // note → key → the value before
  const now = new Map<number, Record<string, unknown>>();
  for (const e of edits) {
    const fm = fms.get(e.note)!;
    const key = Object.keys(fm).find((k) => kebabId(k) === kebabId(e.key)) ?? e.key;
    const before = was.get(e.note) ?? {};
    if (!(key in before)) before[key] = fm[key] ?? null;
    was.set(e.note, before);
    let list = asList(fm[key]);
    if (e.remove) {
      // Gone already (changed somewhere else since the list was drawn): change nothing.
      if (!list.some((l) => pointsAt(l, e.remove!))) throw new Error("That relationship has changed since this list was shown. Look again and try once more.");
      list = list.filter((l) => !pointsAt(l, e.remove!));
    }
    if (e.add && !list.some((l) => linkTargets(l)[0]?.toLowerCase() === linkTargets(e.add!)[0]?.toLowerCase())) list.push(e.add);
    fm[key] = list.length === 0 ? null : list.length === 1 && !Array.isArray(fm[key]) ? list[0] : list;
    now.set(e.note, { ...(now.get(e.note) ?? {}), [key]: fm[key] });
  }
  const changed = [...now].filter(([id, set]) => Object.entries(set).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(was.get(id)![k])));
  if (!changed.length) return false;
  for (const [id, set] of changed) await api(`/vaults/${vaultId}/notes/${id}/properties`, { method: "PATCH", body: { set } });
  return async () => {
    for (const [id] of changed) await api(`/vaults/${vaultId}/notes/${id}/properties`, { method: "PATCH", body: { set: was.get(id) } });
  };
}
