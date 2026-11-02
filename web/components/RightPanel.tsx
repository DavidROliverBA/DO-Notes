// The Links tab of the side panel, beside an open note: on a daily note its calendar and what was
// made or changed that day; the outline; its relationships both ways, each read from this note
// and changed from its row (F31); backlinks in the text; outgoing
// links (unresolved ones create the note); unlinked mentions with a one-click Link; and, with
// semantic search on, related notes. Refetched, debounced, when the note's updated_at moves.

import { addComment, changeComment, type Comment, useComments } from "../lib/comments";
import { useEffect, useState } from "react";
import { kebabId } from "../../src/aixfId";
import { type Kind, phraseNamed, reversible } from "../../src/relationships";
import { api, type NoteSummary } from "../lib/api";
import { editRelations, linkFor } from "../lib/relations";
import { navigate, noteUrl } from "../lib/router";
import { dailyDate, formatDate, isoDay } from "../lib/templates";
import { typeNamed, useTypes } from "../lib/types";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { promptDialog, toast, toastError } from "../ui/overlays";
import { DailyCalendar } from "./DailyCalendar";
import { openRelationshipBuilder, propKey } from "./RelationshipBuilder";

interface Links {
  /** With the relation property each comes through (F16), empty for a link in the text. */
  backlinks: { id: number; path: string; title: string; type: string | null; properties: string[] }[];
  /** This note's own relation properties and the notes they link to (F31). */
  relations?: { property: string; id: number; path: string; title: string; type: string | null }[];
  created_at: string;
  outgoing: { target: string; id: number | null; path: string | null }[];
  related: { id: number; path: string; title: string; similarity: number }[];
  /** The boards it's on (F11), and arrows drawn there between it and other notes. */
  boards?: { id: number; title: string }[];
  arrows?: { id: number; title: string; direction: "from" | "to"; label: string | null; board: { id: number; title: string } }[];
}

interface Props {
  vaultId: number;
  /** Viewers see mentions but can't link them. */
  canWrite?: boolean;
  noteId: number;
  notes: NoteSummary[];
  outline: { level: number; text: string; line: number }[];
  jump: (line: number) => void;
  semantic: boolean;
  onCreate: (target: string) => void;
  onNavigate: () => void;
  onDaily: (d: Date) => void;
}

type Item = { id: number; path: string; title: string; type: string | null };

/** One relationship, as this note's panel shows it. */
interface Row {
  /** The note it's written in, the property, and the note that property links to. */
  holder: NoteSummary;
  key: string;
  target: NoteSummary;
  /** The other note (not this one), and how it reads from here. */
  other: Item;
  phrase: { kind: Kind; back: boolean } | null;
  /** Its words read from this note: "comes after". */
  words: string;
}

const lower = (s: string) => s.toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function RightPanel(p: Props) {
  const [links, setLinks] = useState<Links | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const version = p.notes.find((n) => n.id === p.noteId)?.updated_at;

  // Bumped after a change from the Relationships rows, which may change only the other note.
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    // Debounced: while someone types, updated_at ticks every few seconds.
    const t = setTimeout(() => {
      api<Links>(`/vaults/${p.vaultId}/notes/${p.noteId}/links`).then(
        (l) => live && (setLinks(l), setLinksError(null)),
        (e) => live && setLinksError(e instanceof Error ? e.message : String(e)),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [p.vaultId, p.noteId, version, p.notes.length, tick]);

  const go = (id: number) => {
    navigate(noteUrl(p.vaultId, id));
    p.onNavigate();
  };
  const minLevel = Math.min(...p.outline.map((h) => h.level), 6);
  const path = p.notes.find((n) => n.id === p.noteId)?.path ?? "";
  const day = dailyDate(path);

  // Days thread themselves (F16): a daily note lists what was made and changed that day.
  const [activity, setActivity] = useState<{ made: Item[]; changed: Item[] } | null>(null);
  useEffect(() => {
    setActivity(null);
    if (!day) return;
    let live = true;
    api<{ made: Item[]; changed: Item[] }>(`/vaults/${p.vaultId}/days/${isoDay(day)}`)
      .then((a) => live && setActivity({ made: a.made.filter((n) => n.id !== p.noteId), changed: a.changed.filter((n) => n.id !== p.noteId) }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [p.vaultId, p.noteId, day?.getTime(), version]);

  // Mentions of this note's title that aren't links yet, with a one-click Link (after Capacities'
  // "Related content").
  const [unlinked, setUnlinked] = useState<{ id: number; path: string; title: string; snippet: string }[]>([]);
  // Another note: nothing of the last one's stays up while this one's links load.
  useEffect(() => {
    setLinks(null);
    setLinksError(null);
    setUnlinked([]);
  }, [p.vaultId, p.noteId]);
  const loadMentions = (live = () => true) =>
    api<typeof unlinked>(`/vaults/${p.vaultId}/notes/${p.noteId}/mentions`).then(
      (m) => live() && setUnlinked(m),
      () => {},
    );
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => void loadMentions(() => live), 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [p.vaultId, p.noteId, p.notes]);
  const link = async (sourceId: number, title: string) => {
    setUnlinked((m) => m.filter((x) => x.id !== sourceId));
    try {
      await api(`/vaults/${p.vaultId}/notes/${p.noteId}/mentions`, { body: { source: sourceId } });
      toast(`Linked from “${title}”`);
    } catch (e) {
      toastError(e);
      void loadMentions();
    }
  };

  // Relationships (F31): this note's relation properties, and other notes' that link here, each
  // read from this note ("Loft · comes after · Roof"), one group per kind and direction. Backlinks
  // that aren't through a property are mentions in the text.
  const { kinds } = useTypes();
  const me = p.notes.find((n) => n.id === p.noteId);
  const summary = (x: Item): NoteSummary => p.notes.find((n) => n.id === x.id) ?? ({ id: x.id, path: x.path, title: x.title } as NoteSummary);
  const rows: Row[] = [];
  const mentions: Links["backlinks"] = [];
  if (me) {
    for (const r of links?.relations ?? []) {
      const phrase = phraseNamed(kinds, r.property);
      const words = phrase ? (phrase.back ? phrase.kind.inverse : phrase.kind.label) : r.property;
      rows.push({ holder: me, key: r.property, target: summary(r), other: r, phrase, words: lower(words) });
    }
    for (const b of links?.backlinks ?? []) {
      if (!b.properties.length) mentions.push(b);
      for (const prop of b.properties) {
        const phrase = phraseNamed(kinds, prop);
        const words = phrase ? (phrase.back ? phrase.kind.label : phrase.kind.inverse) : `As ${prop}`;
        rows.push({ holder: summary(b), key: prop, target: me, other: b, phrase, words: lower(words) });
      }
    }
  }
  // In the order of the kinds (yours first), each kind's two directions together.
  const order = (r: Row) => (r.phrase ? kinds.indexOf(r.phrase.kind) * 2 + (r.words === lower(r.phrase.kind.label) ? 0 : 1) : kinds.length * 2);
  const groups = new Map<string, Row[]>();
  for (const r of [...rows].sort((a, b) => order(a) - order(b) || a.words.localeCompare(b.words) || a.other.title.localeCompare(b.other.title))) groups.set(r.words, [...(groups.get(r.words) ?? []), r]);

  const said = (r: Row, words = r.words) => `${me?.title ?? ""} ${words} ${r.other.title}`;
  const change = async (what: string, edits: Parameters<typeof editRelations>[1]) => {
    try {
      const undo = await editRelations(p.vaultId, edits);
      reload();
      if (undo) toast(what, { undo: async () => (await undo(), reload()) });
    } catch (e) {
      toastError(e);
    }
  };
  const rowMenu = (r: Row) => {
    const k = r.phrase?.kind;
    const symmetric = !!k && lower(k.inverse) === lower(k.label);
    // Read from here after turning it round: the other direction's words.
    const flipped = k ? lower(r.words === lower(k.label) ? k.inverse : k.label) : null;
    // Written in the other note under the other direction's name: the same relationship.
    const otherKey = k ? (symmetric ? r.key : r.phrase!.back ? propKey(k) : kebabId(k.inverse)) : null;
    const newHolder = r.holder.id === me!.id ? r.target : me!;
    return [
      { label: `Open ${r.other.title}`, icon: "file", onSelect: () => go(r.other.id) },
      {
        label: "Change…",
        icon: "edit",
        onSelect: () =>
          openRelationshipBuilder({
            vaultId: p.vaultId,
            notes: p.notes,
            from: me!.id,
            to: r.other.id,
            ...(k ? { phrase: `${k.rel}${r.words === lower(k.label) ? ">" : "<"}` as const } : { kind: r.key }),
            replace: { note: r.holder.id, key: r.key, other: r.target },
            onSaved: reload,
          }),
      },
      {
        label: `Swap: ${said(r, flipped ?? r.words)}`,
        icon: "swap",
        hidden: symmetric || !flipped,
        onSelect: () => void change(`Swapped: ${said(r, flipped!)}`, [
          { note: r.holder.id, key: r.key, remove: r.target },
          { note: r.target.id, key: r.key, add: linkFor(r.holder, p.notes) },
        ]),
      },
      {
        label: `Reverse: keep it in ${newHolder.id === me!.id ? "this note" : newHolder.title}`,
        icon: "arrow-right",
        hidden: !k || !reversible(k),
        onSelect: () => void change(`Reversed: now kept in ${newHolder.title}`, [
          { note: r.holder.id, key: r.key, remove: r.target },
          { note: r.target.id, key: otherKey!, add: linkFor(r.holder, p.notes) },
        ]),
      },
      { label: "Remove", icon: "trash", danger: true, onSelect: () => void change(`Removed: ${said(r)}`, [{ note: r.holder.id, key: r.key, remove: r.target }]) },
    ];
  };
  const item = (b: { id: number; title: string; type: string | null }) => (
    <li key={b.id}>
      <button onClick={() => go(b.id)}>
        {b.type && <Icon name={typeNamed(b.type)?.icon ?? "shapes"} size={14} />} {b.title}
      </button>
    </li>
  );

  return (
    <div className="links-panel">
      {day && (
        <section>
          <h3>Daily notes</h3>
          <DailyCalendar notes={p.notes} selected={day} onPick={(d) => (p.onDaily(d), p.onNavigate())} />
        </section>
      )}
      {day && activity && (activity.made.length > 0 || activity.changed.length > 0) && (
        <section>
          <h3>This day</h3>
          {activity.made.length > 0 && (
            <>
              <p className="muted">Made</p>
              <ul className="link-list">{activity.made.map(item)}</ul>
            </>
          )}
          {activity.changed.length > 0 && (
            <>
              <p className="muted">Changed</p>
              <ul className="link-list">{activity.changed.map(item)}</ul>
            </>
          )}
        </section>
      )}
      {!day && links?.created_at && (
        <section className="made-on">
          <button className="link" onClick={() => (p.onDaily(new Date(links.created_at)), p.onNavigate())} title="Open that day's note">
            Made {formatDate(new Date(links.created_at), "dddd D MMMM YYYY")}
          </button>
        </section>
      )}
      {linksError && !links && (
        <section>
          <p className="muted" role="status">
            Couldn't load this note's links. {linksError}
          </p>
        </section>
      )}
      <section>
        <h3>Outline</h3>
        {p.outline.length === 0 ? (
          <p className="muted">No headings.</p>
        ) : (
          <ul className="outline">
            {p.outline.map((h, i) => (
              <li key={i} style={{ paddingLeft: (h.level - minLevel) * 12 }}>
                <button onClick={() => (p.jump(h.line), p.onNavigate())}>{h.text}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {(rows.length > 0 || p.canWrite !== false) && (
        <section className="relationships">
          <h3>
            Relationships {links && <span className="count">{rows.length}</span>}
          </h3>
          {[...groups].map(([words, list]) => (
            <div key={words} className="rel-group">
              <h4>{cap(words)}</h4>
              <ul className="link-list rel-rows">
                {list.map((r) => (
                  <li key={`${r.holder.id}-${r.key}-${r.target.id}`} data-kept={r.holder.id === p.noteId ? "here" : "there"}>
                    <button onClick={() => go(r.other.id)} aria-label={said(r)}>
                      {r.other.type && <Icon name={typeNamed(r.other.type)?.icon ?? "shapes"} size={14} />} {r.other.title}
                    </button>
                    {p.canWrite !== false && <Menu label={`Change “${said(r)}”`} size={16} items={() => rowMenu(r)} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {p.canWrite !== false && (
            <button className="quiet small rel-add" onClick={() => openRelationshipBuilder({ vaultId: p.vaultId, notes: p.notes, from: p.noteId, linked: links?.outgoing.map((o) => o.target), onSaved: reload })}>
              <Icon name="plus" size={14} /> Add relationship…
            </button>
          )}
        </section>
      )}
      {(links?.boards?.length ?? 0) > 0 && (
        <section>
          <h3>
            On boards <span className="count">{links!.boards!.length}</span>
          </h3>
          <ul className="link-list">
            {links!.boards!.map((b) => (
              <li key={b.id}>
                <button onClick={() => go(b.id)}>
                  <Icon name="graph" size={14} /> {b.title}
                </button>
              </li>
            ))}
          </ul>
          {(links?.arrows?.length ?? 0) > 0 && (
            <ul className="link-list board-arrows">
              {links!.arrows!.map((a, i) => (
                <li key={i}>
                  <button onClick={() => go(a.id)} title={`An arrow on ${a.board.title}`}>
                    {a.direction === "from" ? "←" : "→"} {a.title}
                    {a.label && <span className="muted"> · {a.label}</span>}
                    <span className="muted"> · on {a.board.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section>
        <h3>{rows.length ? "Mentioned in" : "Backlinks"} {links && <span className="count">{mentions.length}</span>}</h3>
        {links && mentions.length === 0 && <p className="muted">{rows.length ? "No mentions in the text." : "Nothing links here yet."}</p>}
        <ul className="link-list">{mentions.map(item)}</ul>
      </section>
      <section>
        <h3>Outgoing links {links && <span className="count">{links.outgoing.length}</span>}</h3>
        <ul className="link-list">
          {links?.outgoing.map((o) => (
            <li key={o.target}>
              {o.id ? (
                <button onClick={() => go(o.id!)}>{o.path!.replace(/\.md$/, "")}</button>
              ) : (
                <button className="unresolved" onClick={() => p.onCreate(o.target)} title="Not created yet — click to create">
                  {o.target} <small>+ create</small>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {unlinked.length > 0 && (
        <section>
          <h3>
            Unlinked mentions <span className="count">{unlinked.length}</span>
          </h3>
          <ul className="mention-list">
            {unlinked.map((m) => (
              <li key={m.id}>
                <div className="mention-head">
                  <button className="link" onClick={() => go(m.id)}>
                    {m.title}
                  </button>
                  {p.canWrite !== false && (
                    <button className="quiet mention-link" onClick={() => void link(m.id, m.title)} title={`Make the mention in “${m.title}” a link here`}>
                      <Icon name="link" size={14} /> Link
                    </button>
                  )}
                </div>
                <p className="muted">{m.snippet}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <CommentsSection vaultId={p.vaultId} noteId={p.noteId} canWrite={p.canWrite !== false} />
      <FromConnections vaultId={p.vaultId} noteId={p.noteId} title={p.notes.find((n) => n.id === p.noteId)?.title ?? ""} />
      {p.semantic && (
        <section>
          <h3>Related</h3>
          {links?.related.length === 0 && <p className="muted">Nothing similar yet (embedding may still be running).</p>}
          <ul className="link-list">
            {links?.related.map((r) => (
              <li key={r.id}>
                <button onClick={() => go(r.id)}>
                  {r.title} <small>{Math.round(r.similarity * 100)}%</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface Outside {
  id: number;
  name: string;
  items: { title: string; url: string | null; date: string | null }[];
  problem: string | null;
}

/** From your connections (F33 step 4): what the services the person put in the side panel have on
 *  this note, looked up by its title when the note opens or is renamed (not as they type). Links
 *  open outside DO Notes. Nothing shows when no connection is in the panel. */
function FromConnections({ vaultId, noteId, title }: { vaultId: number; noteId: number; title: string }) {
  const [found, setFound] = useState<Outside[] | null>(null);
  useEffect(() => {
    setFound(null);
    let live = true;
    const t = setTimeout(() => {
      api<Outside[]>(`/vaults/${vaultId}/notes/${noteId}/outside`).then(
        (r) => live && setFound(r),
        () => live && setFound([]),
      );
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [vaultId, noteId, title]);
  if (!found?.length) return null;
  return (
    <section className="from-connections">
      <h3>From your connections</h3>
      {found.map((c) => (
        <details key={c.id} open>
          <summary>{c.name}</summary>
          {c.problem ? (
            <p className="muted">{c.problem}</p>
          ) : c.items.length === 0 ? (
            <p className="muted">Nothing on this.</p>
          ) : (
            <ul className="link-list">
              {c.items.map((it, i) => (
                <li key={i}>
                  {it.url ? (
                    <a href={it.url} target="_blank" rel="noopener noreferrer">
                      {it.title} {it.date && <small>{it.date}</small>}
                    </a>
                  ) : (
                    <span>
                      {it.title} {it.date && <small>{it.date}</small>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
    </section>
  );
}

/** Comments (L3, web/lib/comments.ts): the note's threads, open ones first, each with the words
 *  it's on, its replies, Reply and Resolve; resolved ones folded away. Nothing shows until there's
 *  a comment: Comment… (⋯ or ⌘K) starts one on the selected words. */
function CommentsSection({ vaultId, noteId, canWrite }: { vaultId: number; noteId: number; canWrite: boolean }) {
  const all = useComments(vaultId, noteId);
  const threads = all.filter((c) => !c.parentId);
  if (!threads.length) return null;
  const open = threads.filter((t) => !t.resolved);
  const done = threads.filter((t) => t.resolved);
  const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const reply = async (t: Comment) => {
    const words = await promptDialog({ title: "Reply", label: `To ${t.author ?? "the comment"}`, placeholder: "Your reply (@Name tells someone)", action: "Reply" });
    if (words) await addComment(vaultId, noteId, { body: words, parentId: t.id }).catch(toastError);
  };
  const resolve = (t: Comment, resolved: boolean) =>
    changeComment(vaultId, noteId, t.id, { resolved }).then(
      () => resolved && toast("Resolved", { undo: () => changeComment(vaultId, noteId, t.id, { resolved: false }).catch(toastError) }),
      toastError,
    );
  const thread = (t: Comment) => (
    <li key={t.id} className={`comment-thread${t.resolved ? " resolved" : ""}`}>
      {t.quote && <blockquote>{t.quote}</blockquote>}
      {[t, ...all.filter((r) => r.parentId === t.id)].map((c) => (
        <div key={c.id} className="comment">
          <p className="comment-head">
            <b>{c.author ?? "Someone"}</b> <small>{when(c.at)}{c.edited ? " · edited" : ""}</small>
          </p>
          <p className="comment-body">{c.body}</p>
        </div>
      ))}
      {canWrite && (
        <div className="row">
          {!t.resolved && (
            <button className="quiet" onClick={() => void reply(t)}>
              Reply
            </button>
          )}
          <button className="quiet" onClick={() => void resolve(t, !t.resolved)}>
            {t.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      )}
    </li>
  );
  return (
    <section className="comments">
      <h3>Comments</h3>
      {open.length ? <ul className="comment-list">{open.map(thread)}</ul> : <p className="muted">All resolved.</p>}
      {done.length > 0 && (
        <details>
          <summary>{done.length} resolved</summary>
          <ul className="comment-list">{done.map(thread)}</ul>
        </details>
      )}
    </section>
  );
}

