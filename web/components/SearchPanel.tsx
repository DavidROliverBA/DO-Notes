// The sidebar's Search tab: keyword search, plus semantic (by meaning) when the server has an
// embeddings provider (src/search.ts). Debounced as you type; a later query's reply always wins
// over an earlier one's, and a failed search says so with a way to try again. The query lives in App, so it survives switching tabs, and can be saved
// to the sidebar as a smart folder (web/lib/savedSearches.ts). Snippets are sanitised down to <mark>.

import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { findCommands, runCommandSoon } from "./CommandPalette";
import { api, type Session } from "../lib/api";
import { navigate, noteUrl } from "../lib/router";
import { removeSearch, saveSearch, useSavedSearches } from "../lib/savedSearches";
import { Icon } from "../ui/Icon";

interface Hit {
  id: number;
  path: string;
  title: string;
  snippet: string;
  via: string[];
}

export function SearchPanel({ vaultId, session, query, setQuery, onNavigate }: { vaultId: number; session: Session; query: string; setQuery: (q: string) => void; onNavigate: () => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  // Typing a command's name ("tour") offers it too: the search box is where people look.
  const commands = useMemo(() => findCommands(query), [query]);
  const [semantic, setSemantic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const { list } = useSavedSearches();
  const saved = list.find((s) => s.query === query.trim()) ?? null;

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    // Every change (clearing included) starts a new round, so a slower reply to an earlier query
    // can never land on top of this one.
    const mine = ++seq.current;
    setError(null);
    if (!q) {
      setHits(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api<{ hits: Hit[]; semantic: boolean }>(`/vaults/${vaultId}/search?q=${encodeURIComponent(q)}`);
        if (mine === seq.current) {
          setHits(r.hits);
          setSemantic(r.semantic);
        }
      } catch (e) {
        if (mine === seq.current) {
          setHits(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query, vaultId, retry]);

  return (
    <div className="search-panel">
      <input
        ref={input}
        type="search"
        placeholder="Search words, meaning, tag:x, path:x"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        enterKeyHint="search"
      />
      <div className="search-meta muted">
        <span>
          {busy ? "Searching…" : error ? "Couldn't search" : hits ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : session.search.semantic ? `Keyword + semantic (${session.search.provider})` : "Keyword search"}
          {hits && semantic && !busy && " · incl. semantic"}
        </span>
        {query.trim() && (
          <button
            className={`quiet search-save${saved ? " on" : ""}`}
            aria-pressed={!!saved}
            title={saved ? "Remove from the sidebar" : "Keep this search in the sidebar"}
            onClick={() => (saved ? removeSearch(vaultId, saved) : saveSearch(vaultId, query))}
          >
            <Icon name="bookmark" size={14} /> {saved ? "Saved" : "Save"}
          </button>
        )}
      </div>
      {error && !busy && (
        <div className="error search-error" role="alert">
          <span>{error}</span>
          <button className="quiet" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {commands.length > 0 && (
        <ul className="search-commands" aria-label="Commands">
          {commands.map((c) => (
            <li key={c.id}>
              <button className="quiet" onClick={() => (onNavigate(), runCommandSoon(c))}>
                {c.icon && <Icon name={c.icon} size={16} />}
                <span>{c.title}</span>
                <small>command</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="search-results">
        {hits?.map((h) => (
          <li key={h.id}>
            <a
              href={noteUrl(vaultId, h.id)}
              onClick={(e) => {
                e.preventDefault();
                navigate(noteUrl(vaultId, h.id));
                onNavigate();
              }}
            >
              <div className="hit-title">
                {h.title}
                {h.via.includes("semantic") && !h.via.includes("keyword") && !h.via.includes("title") && (
                  <span className="pill" title="Matched by meaning, not exact words">
                    similar
                  </span>
                )}
              </div>
              {h.path.includes("/") && <div className="hit-path">{h.path.replace(/\/[^/]+$/, "")}</div>}
              {h.snippet && <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(h.snippet, { ALLOWED_TAGS: ["mark"] }) }} />}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
