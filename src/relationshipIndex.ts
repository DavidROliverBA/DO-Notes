// A collection's kinds of relationship (F31 step 2; the list itself is src/relationships.ts):
// read from its Relationships note and its types, and added to by import.

import { kebabId } from "./aixfId";
import { sql } from "./db";
import * as notes from "./notes";
import { addRelationships, type Kind, newRelationshipsNote, parseRelationships, RELATIONSHIPS_NOTE, relationshipKinds } from "./relationships";
import { listTypes } from "./typeIndex";

/** The Relationships note, if the collection has one. */
async function kindsNote(vaultId: number): Promise<{ id: number; content: string } | null> {
  const [n] = await sql`select id, content from notes where vault_id = ${vaultId} and lower(path) = lower(${RELATIONSHIPS_NOTE}) limit 1`;
  return n ? { id: Number(n.id), content: n.content as string } : null;
}

/** Every kind the collection has: its own, its types' relations, then AI-XF's core kinds. */
export async function vaultKinds(vaultId: number): Promise<{ kinds: Kind[]; noteId: number | null }> {
  const [note, { types }] = await Promise.all([kindsNote(vaultId), listTypes(vaultId)]);
  const typeRelations = types.flatMap((t) => t.properties.filter((p) => p.kind === "relation").map((p) => ({ name: p.name, type: t.name, target: p.type })));
  return { kinds: relationshipKinds(note ? parseRelationships(note.content) : [], typeRelations), noteId: note?.id ?? null };
}

/** Add kinds the collection doesn't have yet to its Relationships note, making the note if need
 *  be. Kinds it has already (its own, a type's or a core kind) are left alone. Returns the names added. */
export async function addKinds(vaultId: number, userId: number, kinds: { label: string; inverse: string; hint: string }[], reason = "import"): Promise<string[]> {
  const { kinds: have } = await vaultKinds(vaultId);
  const known = new Set(have.map((k) => k.rel));
  const fresh = kinds.filter((k) => kebabId(k.label) && !known.has(kebabId(k.label)));
  if (!fresh.length) return [];
  const note = await kindsNote(vaultId);
  if (note) await notes.overwriteContent(note.id, (cur) => addRelationships(cur, fresh), userId, reason);
  else await notes.createNote(vaultId, userId, RELATIONSHIPS_NOTE, newRelationshipsNote(fresh));
  return fresh.map((k) => k.label);
}
