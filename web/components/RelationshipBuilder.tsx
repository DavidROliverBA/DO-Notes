// The relationship builder (F31 step 3): one sentence of three labelled controls, [Roof]
// [comes before ▾] [Loft ▾], read out whole as it changes. ⇄ Swap reads the same relationship
// from the other note (Loft comes after Roof). Either direction of a kind can be chosen; the
// relationship is always written as a property of the note it starts from (decided 2026-10-12),
// so choosing "comes after" from Loft writes `comes-before: [[Loft]]` into Roof. Opened from a
// note (⌘K, ⋯, /), the side panel and a board arrow; a new kind can be added from it. From a
// row of the side panel's Relationships it changes that relationship instead of adding one.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { kebabId } from "../../src/aixfId";
import type { Kind } from "../../src/relationships";
import { api, type NoteSummary } from "../lib/api";
import { editRelations, linkFor, type RelationEdit } from "../lib/relations";
import { loadTypes, useTypes } from "../lib/types";
import { Combobox, type ComboOption } from "../ui/Combobox";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { promptDialog, toast, toastError } from "../ui/overlays";

export interface BuilderOpts {
  vaultId: number;
  notes: NoteSummary[];
  /** The note the sentence starts with: the open note, or a board arrow's start. */
  from: number;
  to?: number;
  /** A kind to start with (`comes-before`), as a board arrow's label suggests. */
  kind?: string;
  /** Or the kind read one way: `comes-before>`, or `comes-before<` for "comes after". */
  phrase?: `${string}${">" | "<"}`;
  /** Changing a relationship: the one to take out as this one is written. */
  replace?: { note: number; key: string; other: NoteSummary };
  /** Titles to offer first for the other note (the ones this note links to). */
  linked?: string[];
  /** Called with the note written to, once saved. */
  onSaved?(noteId: number): void;
}

let open: BuilderOpts | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
/** Open the builder. */
export function openRelationshipBuilder(opts: BuilderOpts) {
  open = opts;
  emit();
}
const close = () => ((open = null), emit());

/** Mounted once, in App. */
export function RelationshipBuilderHost() {
  const o = useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => open,
  );
  return o ? <Builder key={`${o.from}-${o.to ?? ""}`} opts={o} /> : null;
}

/** A phrase: a kind, read forwards (">", its own name) or backwards ("<", its other name). */
type Phrase = `${string}${">" | "<"}`;
const kindOf = (kinds: Kind[], p: Phrase | null) => (p ? (kinds.find((k) => k.rel === p.slice(0, -1)) ?? null) : null);
const backwards = (p: Phrase | null) => !!p && p.endsWith("<");
const symmetric = (k: Kind) => k.inverse.toLowerCase() === k.label.toLowerCase();
const words = (k: Kind, back: boolean) => (back ? k.inverse : k.label).toLowerCase();

/** How a relationship is written: the property's name. */
export const propKey = (k: Kind) => (k.source === "type" ? k.label : k.rel);

function Builder({ opts }: { opts: BuilderOpts }) {
  const { kinds } = useTypes();
  // Opened before the app's list has this note (it's still loading, or the note is a moment
  // old): the list is fetched afresh.
  const [fresh, setFresh] = useState<NoteSummary[] | null>(null);
  useEffect(() => {
    if (!opts.notes.some((n) => n.id === opts.from)) api<NoteSummary[]>(`/vaults/${opts.vaultId}/notes`).then(setFresh, () => {});
  }, []);
  const notes = useMemo(() => (fresh ?? opts.notes).filter((n) => /\.md$/i.test(n.path)), [opts.notes, fresh]);
  const [first, setFirst] = useState<number>(opts.from);
  const [second, setSecond] = useState<number | null>(opts.to ?? null);
  const [phrase, setPhrase] = useState<Phrase | null>(() => {
    if (opts.phrase && kindOf(kinds, opts.phrase)) return opts.phrase;
    if (!opts.kind) return null;
    const k = kinds.find((x) => x.rel === kebabId(opts.kind!));
    return k ? `${k.rel}>` : null;
  });
  const [busy, setBusy] = useState(false);
  // An arrow's label that isn't a kind yet: typed in already, ready to add as one.
  const unknownKind = opts.kind && !phrase ? opts.kind.trim() : undefined;
  /** After a choice, on to the next box that's empty, then to Add. */
  const next = (after: "first" | "kind" | "second") => {
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLElement>(".rel-builder");
      const want = after === "first" && !phraseRef.current ? "kind" : after !== "second" && !secondRef.current ? "second" : null;
      (want ? box?.querySelector<HTMLElement>(`[data-combo="${want}"]`) : box?.querySelector<HTMLElement>("[data-dialog-action]"))?.focus();
    });
  };
  const phraseRef = useRef(phrase);
  phraseRef.current = phrase;
  const secondRef = useRef(second);
  secondRef.current = second;
  const kind = kindOf(kinds, phrase);
  const byId = (id: number | null) => notes.find((n) => n.id === id) ?? null;
  const a = byId(first);
  const b = byId(second);

  const phrases: ComboOption[] = useMemo(
    () =>
      kinds.flatMap((k) => {
        const own = k.source === "own" ? "Yours" : k.source === "type" ? `${k.type}'s` : "";
        const out: ComboOption[] = [{ value: `${k.rel}>`, label: k.label.toLowerCase(), hint: [own, k.hint].filter(Boolean).join(" · ") }];
        // The other way round, unless it's a kind of its own already (part of / has part).
        if (!symmetric(k) && !kinds.some((o) => o.label.toLowerCase() === k.inverse.toLowerCase())) out.push({ value: `${k.rel}<`, label: k.inverse.toLowerCase(), hint: `the other way round: ${k.label.toLowerCase()}` });
        return out;
      }),
    [kinds],
  );
  const noteOptions = (exclude: number | null): ComboOption[] => {
    const first = new Set((opts.linked ?? []).map((t) => t.toLowerCase()));
    const folder = (n: NoteSummary) => (n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : undefined);
    const all = notes.filter((n) => n.id !== exclude);
    return [
      ...all.filter((n) => first.has(n.title.toLowerCase())).map((n) => ({ value: String(n.id), label: n.title, hint: "Linked in this note", icon: "file" })),
      ...all.filter((n) => !first.has(n.title.toLowerCase())).map((n) => ({ value: String(n.id), label: n.title, hint: folder(n), icon: "file" })),
    ];
  };

  const sentence = a && kind && b ? `${a.title} ${words(kind, backwards(phrase))} ${b.title}` : "";
  const swap = () => {
    if (!second) return;
    setFirst(second);
    setSecond(first);
    if (kind && !symmetric(kind)) setPhrase(`${kind.rel}${backwards(phrase) ? ">" : "<"}`);
  };

  async function newKind(text: string) {
    const other = await promptDialog({ title: `New kind: ${text}`, message: "What is it called from the other note? Keep the same words if it reads the same both ways.", label: "The other way round", value: text, action: "Add" });
    if (!other) return;
    try {
      await api(`/vaults/${opts.vaultId}/relationships`, { body: { label: text, inverse: other, hint: "" } });
      await loadTypes(opts.vaultId);
      setPhrase(`${kebabId(text)}>`);
      next("kind");
    } catch (e) {
      toastError(e);
    }
  }

  async function save() {
    if (!a || !b || !kind) return;
    // Written into the note the relationship starts from.
    const [subject, object] = backwards(phrase) ? [b, a] : [a, b];
    setBusy(true);
    try {
      const edits: RelationEdit[] = [];
      if (opts.replace) edits.push({ note: opts.replace.note, key: opts.replace.key, remove: opts.replace.other });
      edits.push({ note: subject.id, key: propKey(kind), add: linkFor(object, notes) });
      const undo = await editRelations(opts.vaultId, edits);
      close();
      if (!undo) return toast(`Already: ${sentence}`);
      opts.onSaved?.(subject.id);
      toast(opts.replace ? `Changed: ${sentence}` : sentence, { undo });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Relationship" onClose={close} size="wide">
      <form
        className="rel-builder"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="rel-sentence">
          <Combobox label="This note" name="first" options={noteOptions(second)} value={String(first)} onChange={(v) => (setFirst(Number(v)), next("first"))} />
          <Combobox
            label="Relationship"
            name="kind"
            options={phrases}
            value={phrase}
            onChange={(v) => ((phraseRef.current = v as Phrase), setPhrase(v as Phrase), next("kind"))}
            placeholder="comes before…"
            autoFocus={!phrase}
            initialText={unknownKind}
            create={{ label: (t) => `New kind “${t}”…`, run: (t) => void newKind(t) }}
          />
          <Combobox label="Other note" name="second" options={noteOptions(first)} value={second === null ? null : String(second)} onChange={(v) => ((secondRef.current = Number(v)), setSecond(Number(v)), next("second"))} placeholder="Find a note…" autoFocus={!!phrase && !second} />
        </div>
        <p className="rel-said" role="status" aria-live="polite">
          {sentence || "Choose a relationship and the other note."}
        </p>
        {kind && <p className="muted small rel-meaning">{kind.hint}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={swap} disabled={!second} aria-label="Swap: read it from the other note">
            <Icon name="swap" size={16} /> Swap
          </button>
          <span className="spacer" />
          <button type="button" className="quiet" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!sentence || busy} data-dialog-action>
            {opts.replace ? "Change" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
