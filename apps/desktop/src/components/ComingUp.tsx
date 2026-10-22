import { useEffect, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileText,
  Mic,
  Users,
  Video,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/Button";
import { formatTime, groupByDay } from "@/lib/lalela";
import { COMING_UP_CHANGED_EVENT, getComingUpDays, isMsConnected } from "@/lib/msauth";
import { graphDateMs, upcomingEvents, type GraphEvent } from "@/lib/msgraph";
import { DOSSIER_CHANGED_EVENT, dossierForEvent } from "@/lib/dossiers";
import { IS_MOBILE } from "@/lib/platform";

const COLLAPSE_KEY = "lalela.comingup.collapsed";
const REFRESH_MS = 5 * 60 * 1000;

/** Today / Tomorrow / "Monday 14 July" — the future-facing twin of the meeting
 * list's day headers (which say Yesterday, never Tomorrow). Weekday-date tone
 * matches `dayGroupLabel` in lib/lalela so both sections read the same. */
function upcomingDayLabel(ms: number, now = new Date()): string {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const d = new Date(ms);
  const offset = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { weekday: "long", day: "numeric", month: "long" }
      : { weekday: "long", day: "numeric", month: "long", year: "numeric" };
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

/** The join URL for an online meeting, if any (Teams / etc.). */
function joinUrlOf(e: GraphEvent): string | null {
  const url = e.onlineMeeting?.joinUrl?.trim();
  return url ? url : null;
}

function timeRange(e: GraphEvent): string {
  const start = graphDateMs(e.start);
  const end = graphDateMs(e.end);
  if (start === null) return "";
  const s = formatTime(start);
  return end === null ? s : `${s} – ${formatTime(end)}`;
}

/**
 * Granola-style "Coming up" rail above the meetings list: the next few calendar
 * events (now → +N days, N is the user-set horizon — default 1), each recordable
 * in one click. Renders NOTHING unless a Microsoft account is connected AND there
 * are upcoming events — no nag, no empty shell. Desktop-only (the Graph client is
 * desktop-only). Any Graph error (expired session included) hides the rail
 * silently — it never throws into the meetings view.
 */
export function ComingUp({
  onRecord,
  onOpenMeeting,
}: {
  onRecord: () => void;
  /** Open a meeting (used by the "Prep ready" affordance). Optional so the rail
   * still works where no navigation is wired. */
  onOpenMeeting?: (id: string) => void;
}) {
  // null = not yet loaded (render nothing, no flash); [] = connected-but-empty
  // OR not connected OR errored → also render nothing.
  const [events, setEvents] = useState<GraphEvent[] | null>(null);
  // Bumped whenever a dossier is generated, so the "Prep ready" affordance
  // appears without a reload (the dossier map is read fresh on each render).
  const [, setDossierBump] = useState(0);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === "true",
  );

  useEffect(() => {
    const onDossier = () => setDossierBump((n) => n + 1);
    window.addEventListener(DOSSIER_CHANGED_EVENT, onDossier);
    return () => window.removeEventListener(DOSSIER_CHANGED_EVENT, onDossier);
  }, []);

  useEffect(() => {
    if (IS_MOBILE) return;
    let cancelled = false;
    const load = async () => {
      if (!isMsConnected()) {
        if (!cancelled) setEvents([]);
        return;
      }
      try {
        // Read the horizon fresh each load so a Settings change takes effect.
        const list = await upcomingEvents(Date.now(), getComingUpDays());
        if (!cancelled) setEvents(list);
      } catch {
        // Token expired / offline / Graph hiccup — hide, never surface.
        if (!cancelled) setEvents([]);
      }
    };
    load();
    // Refresh every 5 min, but skip while the window is backgrounded.
    const interval = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Re-fetch immediately when the horizon changes in Settings.
    window.addEventListener(COMING_UP_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(COMING_UP_CHANGED_EVENT, load);
    };
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  };

  if (IS_MOBILE) return null;
  if (events === null || events.length === 0) return null;

  const groups = groupByDay(events, (e) => graphDateMs(e.start) ?? 0).map((g) => ({
    ...g,
    label: upcomingDayLabel(graphDateMs(g.items[0].start) ?? Date.now()),
  }));

  return (
    <div className="px-6 pt-4">
      <div className="mx-auto max-w-3xl">
        <section className="rounded-[var(--radius)] border border-border bg-surface p-2">
          <button
            onClick={toggle}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-1.5 rounded-[var(--radius)] px-1.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            <CalendarClock className="h-3.5 w-3.5" />
            Coming up
            <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-muted-foreground">
              {events.length}
            </span>
          </button>

          {!collapsed && (
            <div className="mt-1 space-y-2">
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="px-1.5 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.label}
                  </div>
                  <div className="space-y-1.5">
                    {g.items.map((e, i) => {
                      const join = joinUrlOf(e);
                      const attendees = e.attendees?.length ?? 0;
                      const dossier = dossierForEvent(e.id);
                      return (
                        <div
                          key={e.id ?? `${g.key}-${i}`}
                          className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2 transition-colors hover:bg-muted"
                        >
                          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {e.subject?.trim() || "Untitled event"}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{timeRange(e)}</span>
                              {attendees > 0 && (
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {attendees}
                                </span>
                              )}
                            </div>
                          </div>
                          {dossier && onOpenMeeting && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onOpenMeeting(dossier.meetingId)}
                              title="Open the pre-meeting briefing Lalela prepared"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Prep ready
                            </Button>
                          )}
                          {join && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openUrl(join).catch(() => {})}
                              title="Open the meeting in your browser"
                            >
                              <Video className="h-3.5 w-3.5" />
                              Join
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={onRecord}
                            title="Start recording this meeting"
                          >
                            <Mic className="h-3.5 w-3.5" />
                            Record
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
