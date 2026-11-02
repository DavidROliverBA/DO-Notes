// The journal page (F24): the Journal sections of this collection's daily notes, newest day
// first, with On this day from earlier years at the top and a calendar to jump to a day. Each day
// opens its daily note, where the entries are plain Markdown under ## Journal.

import { useEffect, useMemo, useState } from "react";
import { api, type NoteSummary, type Vault } from "../lib/api";
import { importDayOne, type JournalDay, newJournalEntry, useJournalChanges } from "../lib/journal";
import { renderMarkdown } from "../lib/render";
import { navigate, noteUrl } from "../lib/router";
import { formatDate } from "../lib/templates";
import { Icon } from "../ui/Icon";
import { PanelToggle } from "../ui/PanelToggle";
import { toastError } from "../ui/overlays";
import { DailyCalendar } from "./DailyCalendar";

interface Props {
  vault: Vault;
  notes: NoteSummary[];
  leftOpen: boolean;
  onToggleLeft: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
  onNavigate: () => void;
  onDaily: (d: Date) => void;
  /** Bumped when an entry is added, to read the page again. */
  seq: number;
}

const dateOf = (day: string) => new Date(`${day}T12:00:00`);
const dayTitle = (day: string) => formatDate(dateOf(day), "dddd D MMMM YYYY");

export function JournalPage(p: Props) {
  const [days, setDays] = useState<JournalDay[] | null>(null);
  const [past, setPast] = useState<JournalDay[]>([]);
  const [more, setMore] = useState(true);
  const today = formatDate(new Date(), "YYYY-MM-DD");
  const canWrite = p.vault.role !== "viewer";
  const imported = useJournalChanges();

  useEffect(() => {
    setDays(null);
    api<{ days: JournalDay[]; onThisDay: JournalDay[] }>(`/vaults/${p.vault.id}/journal?day=${today}`).then(
      (r) => (setDays(r.days), setPast(r.onThisDay), setMore(r.days.length >= 30)),
      (e) => (toastError(e), setDays([])),
    );
  }, [p.vault.id, p.seq, imported]);

  const loadMore = () => {
    const last = days?.at(-1)?.day;
    if (!last) return;
    api<{ days: JournalDay[] }>(`/vaults/${p.vault.id}/journal?before=${last}`).then((r) => (setDays((d) => [...(d ?? []), ...r.days]), setMore(r.days.length >= 30)), toastError);
  };
  const open = (noteId: number) => {
    navigate(noteUrl(p.vault.id, noteId));
    p.onNavigate();
  };
  const html = useMemo(() => (md: string) => renderMarkdown(md, p.vault.id, p.notes), [p.vault.id, p.notes]);

  const Day = ({ d, label }: { d: JournalDay; label?: string }) => (
    <section className="journal-day">
      <h3>
        <button className="link" onClick={() => open(d.noteId)}>
          {label ?? dayTitle(d.day)}
        </button>
      </h3>
      {d.entries.map((e, i) => (
        <div key={i} className="journal-item">
          <span className="journal-time">{e.time}</span>
          <div className="markdown" dangerouslySetInnerHTML={{ __html: html(e.text) }} />
        </div>
      ))}
    </section>
  );

  return (
    <div className="tasks-page journal-page">
      <header className="note-header">
        <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
        <h1 className="note-title type-title">
          <Icon name="book" /> Journal
        </h1>
        <div className="note-actions">
          {canWrite && (
            <button className="quiet" onClick={() => void importDayOne(p.vault)} aria-label="Import from Day One">
              <Icon name="upload" size={16} /> <span className="only-wide">Import from Day One</span>
            </button>
          )}
          {canWrite && (
            <button className="primary" onClick={newJournalEntry} aria-label="New journal entry">
              <Icon name="plus" size={16} /> <span className="only-wide">New entry</span>
            </button>
          )}
          <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
        </div>
      </header>
      <div className="type-body journal-body">
        <div className="journal-main">
          {past.length > 0 && (
            <div className="journal-otd" aria-label="On this day">
              <h2>On this day</h2>
              {past.map((d) => (
                <Day key={d.day} d={d} label={`${dayTitle(d.day)} · ${Number(today.slice(0, 4)) - Number(d.day.slice(0, 4))} year${Number(today.slice(0, 4)) - Number(d.day.slice(0, 4)) === 1 ? "" : "s"} ago`} />
              ))}
            </div>
          )}
          {days === null ? (
            <div className="loading-bar" />
          ) : days.length === 0 ? (
            <p className="muted">No journal entries in this collection yet. {canWrite ? "New entry writes one into today's daily note; it's kept under ## Journal, as plain Markdown." : ""}</p>
          ) : (
            <>
              {days.map((d) => (
                <Day key={d.day} d={d} />
              ))}
              {more && (
                <button className="quiet" onClick={loadMore}>
                  Earlier days
                </button>
              )}
            </>
          )}
        </div>
        <aside className="journal-calendar" aria-label="Go to a day">
          <DailyCalendar notes={p.notes} selected={null} onPick={(d) => p.onDaily(d)} />
        </aside>
      </div>
    </div>
  );
}
