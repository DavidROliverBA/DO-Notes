// A small month calendar for daily notes: dots on days that have one, today ringed, the open
// day filled. Picking a day opens its note, or makes it.

import { useEffect, useMemo, useState } from "react";
import type { NoteSummary } from "../lib/api";
import { addDays, dailyDate, formatDate, isoDay } from "../lib/templates";
import { Icon } from "../ui/Icon";

const WEEK = ["M", "T", "W", "T", "F", "S", "S"];

export function DailyCalendar({ notes, selected, onPick }: { notes: NoteSummary[]; selected: Date | null; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(() => {
    const d = selected ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  useEffect(() => {
    if (selected) setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }, [selected?.getTime()]);

  const have = useMemo(() => new Set(notes.map((n) => dailyDate(n.path)).filter((d): d is Date => !!d).map(isoDay)), [notes]);
  const today = isoDay(new Date());
  const chosen = selected ? isoDay(selected) : "";
  // Weeks start on Monday, as in the UK.
  const start = addDays(month, -((month.getDay() + 6) % 7));
  const days = [...Array(42)].map((_, i) => addDays(start, i));
  const rows = days[35]!.getMonth() === month.getMonth() ? 6 : 5;

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
          <Icon name="chevron-left" size={16} />
        </button>
        <span>{formatDate(month, "MMMM YYYY")}</span>
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
          <Icon name="chevron" size={16} />
        </button>
      </div>
      {/* A group of day buttons, not an ARIA grid: a grid needs rows and cells to be correct. */}
      <div className="calendar-grid" role="group" aria-label={formatDate(month, "MMMM YYYY")}>
        {WEEK.map((w, i) => (
          <span key={i} className="calendar-dow">
            {w}
          </span>
        ))}
        {days.slice(0, rows * 7).map((d) => {
          const iso = isoDay(d);
          const cls = ["calendar-day", d.getMonth() !== month.getMonth() && "other", iso === today && "today", iso === chosen && "on", have.has(iso) && "has"].filter(Boolean).join(" ");
          return (
            <button key={iso} className={cls} onClick={() => onPick(d)} aria-label={`${formatDate(d, "dddd D MMMM")}${have.has(iso) ? ", has a note" : ""}`} aria-pressed={iso === chosen}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
