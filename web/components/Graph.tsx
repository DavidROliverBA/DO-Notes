// The graph page (after Capacities): the whole vault, or a scope of it (a type, a folder, a tag or
// a search), or the neighbourhood of one note with Show more and Show less. Notes show their
// type's icon and colour; links from properties carry the property's name. The bar at the bottom
// has the filters (only or hide types, daily notes, busy notes, unlinked notes, a simplified
// drawing), zoom, fit and a PNG export, and the timeline (F21); a search box moves to a note.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type NoteSummary } from "../lib/api";
import { activeFilters, BUSY, canShowMore, type DayRange, daySpan, type Filters, type GraphData, graphUrl, loadFilters, NO_FILTERS, outside, rangeFrom, saveFilters, type Scope, scopeFrom, shown } from "../lib/graph";
import { currentPath, currentSearch, navigate, noteUrl, replaceQuietly } from "../lib/router";
import { Icon } from "../ui/Icon";
import { PanelToggle } from "../ui/PanelToggle";
import { toastError } from "../ui/overlays";
import { type GraphHandle, GraphCanvas } from "./GraphCanvas";
import { GraphTimeline } from "./GraphTimeline";

// One copy of each vault's graph, refetched a moment after notes change, shared by the page and
// the side panel's Graph tab.
const cache = new Map<number, GraphData>();
const waiting = new Map<number, Promise<GraphData>>();

/** The vault's graph (null until loaded), refetched shortly after `changed` changes. */
export function useGraphData(vaultId: number, changed: unknown): GraphData | null {
  const [, loaded] = useState(0);
  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        const p = waiting.get(vaultId) ?? api<GraphData>(`/vaults/${vaultId}/graph`);
        waiting.set(vaultId, p);
        p.then(
          (d) => {
            cache.set(vaultId, d);
            if (live) loaded((n) => n + 1);
          },
          (e) => live && toastError(e),
        ).finally(() => waiting.delete(vaultId));
      },
      cache.has(vaultId) ? 800 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [vaultId, changed]);
  return cache.get(vaultId) ?? null;
}

/** The page's ?query, kept up to date as the app navigates. */
function useSearch(): string {
  const [s, set] = useState(currentSearch);
  useEffect(() => {
    const on = () => set(currentSearch());
    window.addEventListener("cp:navigate", on);
    window.addEventListener("popstate", on);
    return () => (window.removeEventListener("cp:navigate", on), window.removeEventListener("popstate", on));
  }, []);
  return s;
}

const scopeLabel = (s: NonNullable<Scope>) => (s.kind === "type" ? s.value : s.kind === "folder" ? `${s.value}/` : s.kind === "tag" ? `#${s.value.replace(/^#/, "")}` : `“${s.value}”`);

interface Props {
  vaultId: number;
  vaultName: string;
  notes: NoteSummary[];
  leftOpen: boolean;
  onToggleLeft: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
}

export function Graph(p: Props) {
  const data = useGraphData(p.vaultId, p.notes);
  const search = useSearch();
  const { scope: asked, note } = useMemo(() => scopeFrom(search), [search]);
  const [scope, setScope] = useState<Scope>(asked);
  const [depth, setDepth] = useState(1);
  const [filters, setFiltersState] = useState<Filters>(() => loadFilters(p.vaultId));
  const [panel, setPanel] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [find, setFind] = useState("");
  const canvas = useRef<GraphHandle>(null);
  // The timeline: open with a range from the address (?from=&to=), or from the button.
  const [range, setRangeState] = useState<DayRange | null>(() => rangeFrom(currentSearch()));
  const [hideOutside, setHideOutside] = useState(false);
  const [playing, setPlaying] = useState(false);
  const setRange = (r: DayRange | null) => {
    setRangeState(r);
    const q = new URLSearchParams(currentSearch());
    if (r) (q.set("from", r.from), q.set("to", r.to));
    else (q.delete("from"), q.delete("to"));
    replaceQuietly(`${currentPath()}${q.size ? `?${q}` : ""}`);
  };
  const setFilters = (f: Filters) => (setFiltersState(f), saveFilters(p.vaultId, f));

  // A search scope needs its notes from the server; the others are worked out here.
  useEffect(() => {
    setDepth(1);
    if (asked?.kind !== "search") return setScope(asked);
    setScope({ ...asked, ids: [] });
    api<{ hits: { id: number }[] }>(`/vaults/${p.vaultId}/search?q=${encodeURIComponent(asked.value)}`).then((r) => setScope({ ...asked, ids: r.hits.map((h) => h.id) }), toastError);
  }, [search, p.vaultId]);

  const view = useMemo(() => (data ? shown(data, { scope, centre: note, depth, filters }) : null), [data, scope, note, depth, filters]);
  const centreNote = note !== null ? data?.nodes.find((n) => n.id === note) : null;
  const more = useMemo(() => !!data && note !== null && canShowMore(data.edges, note, depth), [data, note, depth]);
  const away = useMemo(() => (view ? outside(view.nodes, range) : new Set<number>()), [view, range]);
  const toggleTimeline = () => {
    setPlaying(false);
    setRange(range ? null : view ? daySpan(view.nodes) : null);
  };
  const badge = activeFilters(filters);
  const types = data?.types ?? [];

  const toggle = (list: "only" | "hide", name: string) => {
    const cur = filters[list];
    const other = list === "only" ? "hide" : "only";
    setFilters({ ...filters, [list]: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name], [other]: filters[other].filter((x) => x !== name) });
  };
  const chips = (list: "only" | "hide") => (
    <div className="graph-chips">
      {[...types.map((t) => ({ key: t.name, label: t.name, icon: t.icon, colour: t.colour })), { key: "", label: "No type", icon: "file", colour: "grey" }].map((t) => (
        <button key={t.key || "none"} className={`graph-chip colour-${t.colour}${filters[list].includes(t.key) ? " on" : ""}`} aria-pressed={filters[list].includes(t.key)} onClick={() => toggle(list, t.key)}>
          <Icon name={t.icon} size={14} /> {t.label}
        </button>
      ))}
    </div>
  );

  function goTo(title: string) {
    const n = view?.nodes.find((x) => x.title.toLowerCase() === title.trim().toLowerCase());
    if (n) canvas.current?.focusOn(n.id);
  }

  const title = centreNote ? centreNote.title : scope ? scopeLabel(scope) : p.vaultName;
  return (
    <div className="graph-view">
      <header className="note-header">
        <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
        <h1 className="note-title">
          Graph
          {(scope || centreNote) && (
            <button className="graph-scope" onClick={() => navigate(graphUrl(p.vaultId))} title="Show the whole collection" aria-label={`${title}: show the whole collection instead`}>
              {centreNote ? "around " : ""}
              {title} <Icon name="x" size={12} />
            </button>
          )}
        </h1>
        <div className="note-actions">
          <input
            className="graph-find"
            type="search"
            list="graph-titles"
            value={find}
            placeholder="Find in graph"
            aria-label="Find a note in the graph"
            onChange={(e) => (setFind(e.target.value), goTo(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && goTo(find)}
          />
          <datalist id="graph-titles">
            {view?.nodes.slice(0, 500).map((n) => (
              <option key={n.id} value={n.title} />
            ))}
          </datalist>
          {view && (
            <span className="muted only-wide">
              {view.nodes.length} note{view.nodes.length === 1 ? "" : "s"} · {view.edges.length} link{view.edges.length === 1 ? "" : "s"}
            </span>
          )}
          <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
        </div>
      </header>
      <div className="graph-stage">
        {view && (
          <GraphCanvas
            ref={canvas}
            nodes={view.nodes}
            edges={view.edges}
            types={types}
            centre={note}
            simplified={filters.simplified}
            label={`Graph of ${title}: ${view.nodes.length} notes and ${view.edges.length} links`}
            onOpen={(id) => navigate(noteUrl(p.vaultId, id))}
            onZoom={setZoom}
            outside={away}
            hideOutside={hideOutside}
            onTouch={() => setPlaying(false)}
          />
        )}
        {view && !view.nodes.length && (
          <div className="graph-empty">
            {view.before ? (
              <>
                <p>The filters hide every note here.</p>
                <button onClick={() => setFilters(NO_FILTERS)}>Clear the filters</button>
              </>
            ) : (
              <p>No notes here yet.</p>
            )}
          </div>
        )}
        {panel && (
          <div className="graph-filters" role="dialog" aria-label="Graph filters">
            <div className="graph-filters-head">
              <b>Filters</b>
              {badge > 0 && (
                <button className="link" onClick={() => setFilters({ ...NO_FILTERS, simplified: filters.simplified })}>
                  Clear
                </button>
              )}
              <button className="icon-btn" onClick={() => setPanel(false)} aria-label="Close the filters">
                <Icon name="x" size={16} />
              </button>
            </div>
            <span className="field-label">Only these types</span>
            {chips("only")}
            <span className="field-label">Hide these types{filters.hide.length ? ` (${filters.hide.length})` : ""}</span>
            {chips("hide")}
            <label className="check">
              <input type="checkbox" checked={filters.orphans} onChange={(e) => setFilters({ ...filters, orphans: e.target.checked })} /> Notes with no links
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.daily} onChange={(e) => setFilters({ ...filters, daily: e.target.checked })} /> Daily notes
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.busy} onChange={(e) => setFilters({ ...filters, busy: e.target.checked })} /> Hide busy notes (more than {BUSY} links)
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.simplified} onChange={(e) => setFilters({ ...filters, simplified: e.target.checked })} /> Simplified: coloured dots, for big graphs
            </label>
          </div>
        )}
        <div className="graph-bar" role="toolbar" aria-label="Graph">
          <button className={`quiet${panel ? " on" : ""}`} onClick={() => setPanel(!panel)} aria-expanded={panel}>
            <Icon name="list" size={16} /> Filters{badge > 0 && <span className="graph-badge">{badge}</span>}
          </button>
          <button className={`quiet${range ? " on" : ""}`} onClick={toggleTimeline} aria-expanded={!!range} disabled={!view?.nodes.length} aria-label="Timeline">
            <Icon name="clock" size={16} /> <span className="only-wide">Timeline</span>
          </button>
          {note !== null && (
            <span className="graph-depth">
              <button className="quiet" onClick={() => setDepth(Math.max(1, depth - 1))} disabled={depth <= 1}>
                Show less
              </button>
              <button className="quiet" onClick={() => setDepth(depth + 1)} disabled={!more}>
                Show more
              </button>
            </span>
          )}
          <span className="graph-zoom">
            <button className="icon-btn" onClick={() => canvas.current?.zoomBy(1 / 1.25)} aria-label="Zoom out">
              −
            </button>
            <button className="quiet graph-zoom-k" onClick={() => canvas.current?.fit()} title="Fit everything in" aria-label={`Zoom ${Math.round(zoom * 100)}%: fit everything in`}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-btn" onClick={() => canvas.current?.zoomBy(1.25)} aria-label="Zoom in">
              +
            </button>
          </span>
          <button className="icon-btn" onClick={() => canvas.current?.exportPng(`Graph of ${title}`)} aria-label="Save as a picture (PNG)" title="Save as a picture (PNG)">
            <Icon name="download" size={16} />
          </button>
        </div>
      </div>
      {range && view && view.nodes.length > 0 && (
        <GraphTimeline
          nodes={view.nodes}
          range={range}
          setRange={setRange}
          showing={view.nodes.length - away.size}
          hide={hideOutside}
          setHide={setHideOutside}
          playing={playing}
          setPlaying={setPlaying}
          onClose={toggleTimeline}
        />
      )}
    </div>
  );
}
