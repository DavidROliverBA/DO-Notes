// Live Preview's editable properties panel in place of the frontmatter.
// Values edit by type: text, number, date picker, checkbox, and lists as pills. Keys can be
// renamed, properties added and removed. Every edit is a surgical text change to the YAML
// (web/lib/frontmatter.ts) dispatched as the smallest replacement, so it merges with live edits.
//
// A typed note (F16) shows its type's properties too, even before they have values, with the
// right editor for each: a menu for a select, a note picker for a relation, a type menu on `type`.
// Any note can add a relationship (F27): an AI-XF rel as the key (`part-of`), a link as the value,
// picked from the notes this one already links to first.

import { type EditorView, WidgetType } from "@codemirror/view";
import { linkTargets, type TypeProp, typeOf as typeNameOf } from "../../src/types";
import { chooseDialog, toast, toastError } from "../ui/overlays";
import { relationKind, typeNamed, typesState } from "./types";
import { deleteProp, emptyValue, minimalChange, type Prop, type PropType, type PropValue, readProps, renameProp, setProp } from "./frontmatter";

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TYPES: [PropType, string][] = [
  ["text", "Text"],
  ["list", "List"],
  ["number", "Number"],
  ["checkbox", "Checkbox"],
  ["date", "Date"],
];

/** After an edit rebuilds the panel, put focus back where the person was typing. */
let refocus: { selector: string } | null = null;

/** Apply `edit` to the note's current frontmatter YAML and dispatch the minimal change. */
function commit(view: EditorView, edit: (yaml: string) => string) {
  if (view.state.readOnly) return;
  const head = view.state.doc.sliceString(0, Math.min(view.state.doc.length, 200_000));
  const m = FM.exec(head);
  if (!m) return;
  const start = m[0].indexOf("\n") + 1;
  let next: string;
  try {
    next = edit(m[1]!);
  } catch (e) {
    toastError(e);
    return;
  }
  const c = minimalChange(m[1]!, next);
  if (c) view.dispatch({ changes: { from: start + c.from, to: start + c.to, insert: c.insert }, userEvent: "input.properties" });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

export class PropertiesWidget extends WidgetType {
  /** The note's type's properties (F16), and a key for eq so the panel redraws when types load. */
  readonly schema: TypeProp[];
  readonly schemaKey: string;
  constructor(
    readonly yaml: string,
    /** Part of eq: the editor is read-only until the note syncs, and the panel must then unlock. */
    readonly readOnly: boolean,
    readonly onEditYaml: (view: EditorView) => void,
  ) {
    super();
    const type = typeNameOf(Object.fromEntries((readProps(yaml) ?? []).map((p) => [p.key, p.value])));
    this.schema = typeNamed(type)?.properties ?? [];
    this.schemaKey = JSON.stringify([this.schema, typesState().types.map((t) => t.name)]);
  }
  eq(o: PropertiesWidget) {
    return o.yaml === this.yaml && o.readOnly === this.readOnly && o.schemaKey === this.schemaKey;
  }
  ignoreEvent() {
    return true; // the panel's inputs handle their own keys, clicks and pastes
  }

  toDOM(view: EditorView) {
    const props = readProps(this.yaml) ?? [];
    const ro = this.readOnly;
    const root = el("div", { className: "cm-lp-block cm-lp-properties cm-lp-props" });
    const head = el("div", { className: "props-head" }, el("span", { textContent: "Properties" }));
    const yamlBtn = el("button", { className: "props-yaml", type: "button", textContent: "Edit YAML" });
    yamlBtn.onclick = () => this.onEditYaml(view);
    head.append(yamlBtn);
    root.append(head);

    // The AI-XF id (F9) is kept out of sight: ⌘K or ⋯ → Copy the note's id.
    for (const p of props) if (p.key !== "id") root.append(this.row(view, p, ro));
    // The type's properties this note doesn't have yet, ready to fill in.
    for (const s of this.schema) if (!props.some((p) => p.key === s.name)) root.append(this.ghostRow(view, s, ro));

    if (!ro) {
      const name = el("input", { className: "prop-new-key", placeholder: "Add property", autocomplete: "off", spellcheck: false });
      const type = el("select", { className: "prop-new-type", title: "Type" });
      for (const [v, label] of TYPES) type.append(el("option", { value: v, textContent: label }));
      const add = () => {
        const key = name.value.trim();
        if (!key) return;
        if (props.some((p) => p.key === key)) return toast(`There's already a property called “${key}”`, { tone: "error" });
        refocus = { selector: `.prop-row[data-key="${CSS.escape(key)}"] .prop-input` };
        commit(view, (y) => setProp(y, key, emptyValue(type.value as PropType)));
      };
      // Handlers must not return false: an on<event> handler returning false cancels the key.
      name.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          add();
        }
      };
      const btn = el("button", { className: "prop-add-btn", type: "button", textContent: "Add" });
      btn.onclick = add;
      const rel = el("button", { className: "prop-add-rel", type: "button", textContent: "Add relationship…" });
      rel.onclick = () => openBuilder();
      root.append(el("div", { className: "prop-add" }, name, type, btn), el("div", { className: "prop-add-rels" }, rel));
    }

    if (refocus) {
      const target = refocus.selector;
      refocus = null;
      requestAnimationFrame(() => root.querySelector<HTMLElement>(target)?.focus());
    }
    return root;
  }

  private row(view: EditorView, p: Prop, ro: boolean) {
    const row = el("div", { className: `prop-row prop-${p.type}` });
    row.dataset.key = p.key;
    const key = el("input", { className: "prop-key", value: p.key, disabled: ro, spellcheck: false, title: "Rename" });
    key.onchange = () => {
      const to = key.value.trim();
      if (!to) return void (key.value = p.key);
      commit(view, (y) => renameProp(y, p.key, to));
    };
    key.onkeydown = (e) => {
      if (e.key === "Enter") key.blur();
    };
    row.append(key, this.valueEditor(view, p, ro || p.readOnly));
    if (!ro) {
      const del = el("button", { className: "prop-del", type: "button", title: `Remove ${p.key}`, textContent: "×" });
      del.setAttribute("aria-label", `Remove ${p.key}`);
      del.onclick = () => commit(view, (y) => deleteProp(y, p.key));
      row.append(del);
    }
    return row;
  }

  private ghostRow(view: EditorView, s: TypeProp, ro: boolean) {
    const row = el("div", { className: `prop-row prop-ghost prop-${s.kind}` });
    row.dataset.key = s.name;
    row.append(el("span", { className: "prop-key", textContent: s.name }));
    const empty: PropValue = s.kind === "checkbox" ? false : s.kind === "list" || (s.kind === "relation" && s.many) ? [] : null;
    row.append(this.valueEditor(view, { key: s.name, type: s.kind === "checkbox" ? "checkbox" : s.kind === "list" ? "list" : s.kind === "number" ? "number" : s.kind === "date" ? "date" : "text", value: empty, readOnly: false }, ro));
    return row;
  }

  private valueEditor(view: EditorView, p: Prop, ro: boolean): HTMLElement {
    const set = (v: PropValue) => commit(view, (y) => setProp(y, p.key, v));
    const s = this.schema.find((x) => x.name === p.key);
    if (p.key === "type" && !p.readOnly) return this.typeEditor(p, ro, set);
    if (s?.kind === "select" && !p.readOnly) {
      const sel = el("select", { className: "prop-input prop-select", disabled: ro });
      const cur = p.value === null ? "" : String(p.value);
      for (const o of ["", ...new Set([...(s.options ?? []), ...(cur ? [cur] : [])])]) sel.append(el("option", { value: o, textContent: o || "—", selected: o === cur }));
      sel.onchange = () => set(sel.value || null);
      return sel;
    }
    if (s?.kind === "relation" && !p.readOnly) return this.relationEditor(p, s, ro, set, view);
    const r = !s && !p.readOnly && (p.type === "text" || p.type === "list") ? relationKind(p.key) : null;
    if (r && (p.value === null || linkTargets(p.value).length)) return this.relationEditor(p, { name: p.key, kind: "relation", many: Array.isArray(p.value) }, ro, set, view, true);
    if (p.type === "checkbox") {
      const box = el("input", { type: "checkbox", className: "prop-input prop-check", checked: p.value === true, disabled: ro });
      box.onchange = () => set(box.checked);
      return box;
    }
    if (p.type === "list") return this.listEditor(view, p, ro);
    const input = el("input", {
      className: "prop-input",
      type: p.type === "number" ? "number" : p.type === "date" ? "date" : "text",
      value: p.value === null ? "" : String(p.value),
      disabled: ro,
      placeholder: ro ? "" : "Empty",
      spellcheck: p.type === "text",
      title: p.readOnly ? "Edit this one as YAML" : "",
    });
    input.onchange = () => {
      const raw = input.value;
      if (p.type === "number") set(raw.trim() === "" || Number.isNaN(Number(raw)) ? null : Number(raw));
      else set(raw === "" ? null : raw);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") input.blur();
    };
    return input;
  }

  /** `type`: a menu of the vault's types (and whatever this note says, even if undefined). */
  private typeEditor(p: Prop, ro: boolean, set: (v: PropValue) => void) {
    const cur = p.value === null ? "" : String(p.value).replace(/^\[\[|\]\]$/g, "");
    const sel = el("select", { className: "prop-input prop-select", disabled: ro, title: "What this note is" });
    const names = [...new Set([...typesState().types.map((t) => t.name), ...(cur ? [cur] : [])])];
    for (const n of ["", ...names]) sel.append(el("option", { value: n, textContent: n || "No type", selected: n.toLowerCase() === cur.toLowerCase() }));
    sel.onchange = () => set(sel.value || null);
    return sel;
  }

  /** A relation: its links as pills, and + to pick a note of the target type. */
  private relationEditor(p: Prop, s: TypeProp, ro: boolean, set: (v: PropValue) => void, view: EditorView, grows = false) {
    const box = el("div", { className: "prop-pills prop-relation" });
    const links = linkTargets(p.value);
    links.forEach((t, i) => {
      const pill = el("span", { className: "pill link-pill" }, t);
      if (!ro) {
        const x = el("button", { type: "button", className: "pill-x", textContent: "×", title: `Remove ${t}` });
        x.setAttribute("aria-label", `Remove ${t}`);
        x.onclick = () => {
          const rest = links.filter((_, j) => j !== i).map((l) => `[[${l}]]`);
          // A relationship that loses its last note goes; a type's relation stays, empty.
          if (grows && !rest.length) commit(view, (y) => deleteProp(y, p.key));
          else set(s.many ? rest : (rest[0] ?? null));
        };
        pill.append(x);
      }
      box.append(pill);
    });
    if (!ro && (s.many || grows || !links.length)) {
      const add = el("button", { type: "button", className: "prop-relation-add", textContent: links.length ? "+" : `Choose ${s.type ? `a ${s.type}` : "a note"}…` });
      add.onclick = async () => {
        const notes = this.candidates(s, view);
        const choice = await chooseDialog({
          title: `${p.key}: choose ${s.type ? `a ${s.type}` : "a note"}`,
          options: notes.map((n) => ({ value: n.title, label: n.title, hint: n.folder })),
          placeholder: `Find ${s.type ? `a ${s.type}` : "a note"}…`,
          empty: s.type ? `No ${s.type} notes match. Make one first, then pick it here.` : "No notes match",
        });
        if (!choice) return;
        const link = `[[${choice}]]`;
        set(s.many || (grows && links.length) ? [...links.map((l) => `[[${l}]]`), link] : link);
      };
      box.append(add);
    }
    return box;
  }

  private candidates(s: TypeProp, view: EditorView) {
    return candidates(s.type ?? null, view);
  }

  private listEditor(view: EditorView, p: Prop, ro: boolean) {
    const items = (p.value as string[]) ?? [];
    const box = el("div", { className: "prop-pills" });
    const sel = `.prop-row[data-key="${CSS.escape(p.key)}"] .prop-input`;
    const save = (next: string[]) => {
      refocus = { selector: sel };
      commit(view, (y) => setProp(y, p.key, next));
    };
    items.forEach((item, i) => {
      const pill = el("span", { className: "pill" }, item);
      if (!ro) {
        const x = el("button", { type: "button", className: "pill-x", textContent: "×", title: `Remove ${item}` });
        x.setAttribute("aria-label", `Remove ${item}`);
        x.onclick = () => save(items.filter((_, j) => j !== i));
        pill.append(x);
      }
      box.append(pill);
    });
    if (!ro) {
      const input = el("input", { className: "prop-input prop-pill-input", placeholder: items.length ? "" : "Add…", spellcheck: false });
      input.setAttribute("aria-label", `Add to ${p.key}`);
      const addFrom = () => {
        const fresh = input.value
          .split(",")
          .map((s) => (p.key === "tags" ? s.trim().replace(/^#/, "") : s.trim()))
          .filter((s) => s && !items.includes(s));
        input.value = "";
        if (fresh.length) save([...items, ...fresh]);
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          addFrom();
        } else if (e.key === "Backspace" && input.value === "" && items.length) {
          save(items.slice(0, -1));
        }
      };
      input.onblur = addFrom;
      box.append(input);
    }
    return box;
  }
}

/** The frontmatter's YAML (between the --- lines), or null when the note has none. */
export function frontmatterYaml(src: string): string | null {
  return FM.exec(src)?.[1] ?? null;
}

/** Opens the relationship builder for this note (F31): set by the editor, which knows the note. */
let openBuilder: () => void = () => {};
export function setRelationshipOpener(fn: () => void) {
  openBuilder = fn;
}

/** The vault's notes, for relation pickers: set by the editor, which has them. */
let relationCandidates: (type: string | null) => { title: string; folder?: string }[] = () => [];
export function setRelationCandidates(fn: typeof relationCandidates) {
  relationCandidates = fn;
}

/** Notes a relation can point at: of `type`, if given, with those this note already links to in
 *  its text first. */
function candidates(type: string | null, view: EditorView): { title: string; folder?: string }[] {
  const all = relationCandidates(type);
  const body = view.state.doc.sliceString(0, Math.min(view.state.doc.length, 200_000)).replace(FM, "");
  const linked = new Set(linkTargets(body).map((t) => t.toLowerCase().split("/").pop()!));
  const first = all.filter((n) => linked.has(n.title.toLowerCase())).map((n) => ({ ...n, folder: "Linked in this note" }));
  return [...first, ...all.filter((n) => !linked.has(n.title.toLowerCase()))];
}

