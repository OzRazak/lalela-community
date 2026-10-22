import { IS_COMMUNITY } from "@/lib/edition";
// Notifications bell + dropdown panel. Replaces the former "Notifications" nav
// tab (ActivityView): the team activity feed and the overdue-task list now live
// in a bell dropdown owned by the top bar (desktop) and the mobile header.
//
// The overdue-task count rides on the bell as a red badge (moved here from the
// old sidebar nav item). A subtle unread dot appears when there are team events
// newer than the last time the panel was opened — the `lalela.activity.lastSeen`
// logic is preserved from ActivityView.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { listNotifications, importSharedMeeting, type ActivityItem } from "@/lib/sync";
import { formatDate, getMeeting, listActionItems, type ActionItem } from "@/lib/lalela";
import { isTaskOverdue } from "@/lib/settings";
import { useNotificationPrefs } from "@/lib/notifications";
import { pendingNudge, consumeNudge, type DomainNudge } from "@/lib/teammates";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Bell,
  Building2,
  CalendarClock,
  Check,
  ClipboardList,
  FileText,
  User,
  UserPlus,
  Users,
  X,
} from "lucide-react";

const LAST_SEEN_KEY = "lalela.activity.lastSeen";

export const getActivityLastSeen = () => Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0);
const markActivitySeen = () => localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));

const KIND_ICON: Record<string, typeof Bell> = {
  task_assigned: ClipboardList,
  task_done: Check,
  member_added: UserPlus,
};

interface NotificationBellProps {
  /** Overdue-task count → red badge on the bell. */
  overdueCount?: number;
  onOpenMeeting: (id: string) => void;
  /** Which edge of the bell the dropdown hangs from. */
  align?: "left" | "right";
}

/** Bell button + activity dropdown. Self-contained: fetches the team feed and
 * the overdue-task list, tracks unread state, and opens meetings. */
export function NotificationBell({
  overdueCount = 0,
  onOpenMeeting,
  align = "right",
}: NotificationBellProps) {
  const { user } = useAuth();
  // Wave C3: the "Overdue tasks" / "Team activity" preferences gate what shows
  // in this feed (and on the bell badge). Detection + model-ready prefs gate OS
  // notifications elsewhere; here we only filter the in-app surfaces.
  const prefs = useNotificationPrefs();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [lastSeen, setLastSeen] = useState(getActivityLastSeen());
  const [unread, setUnread] = useState(0);
  const [overdue, setOverdue] = useState<ActionItem[]>([]);
  // Wave D2: a one-time "people from your company also use Lalela" nudge, queued
  // after sign-in (lib/teammates.ts) and shown here exactly once.
  const [nudge, setNudge] = useState<DomainNudge | null>(() => pendingNudge());
  const [nudgeSeen, setNudgeSeen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Team feed. Fetched on mount + whenever the user changes so the closed-state
  // unread dot can be computed without opening the panel.
  const refreshFeed = useCallback(() => {
    if (!user) {
      setItems([]);
      setUnread(0);
      return;
    }
    listNotifications()
      .then((list) => {
        setItems(list);
        const seen = getActivityLastSeen();
        setUnread(list.filter((n) => n.created_at > seen && n.actor_id !== user.id).length);
      })
      .catch(() => setItems([]));
  }, [user]);

  useEffect(() => {
    refreshFeed();
  }, [refreshFeed]);

  // Overdue tasks are local (work even signed out). Recompute when the count
  // the parent tracks changes (a task moved/dated/completed).
  useEffect(() => {
    listActionItems()
      .then((list) =>
        setOverdue(
          list
            .filter((i) => i.status !== "suggested" && isTaskOverdue(i.due, i.status))
            .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "")),
        ),
      )
      .catch(() => setOverdue([]));
  }, [overdueCount]);

  // Opening the panel marks the feed seen (clears the unread dot). It also
  // consumes the one-time domain nudge (persisted so it never re-queues), while
  // keeping it rendered for this open until the user dismisses it.
  useEffect(() => {
    if (open && user) {
      markActivitySeen();
      setLastSeen(getActivityLastSeen());
      setUnread(0);
      if (nudge && !nudgeSeen) {
        consumeNudge();
        setNudgeSeen(true);
      }
    }
  }, [open, user, nudge, nudgeSeen]);

  // Dismiss on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openMeeting = async (meetingId: string) => {
    try {
      await getMeeting(meetingId);
    } catch {
      try {
        await importSharedMeeting(meetingId);
      } catch {
        return;
      }
    }
    setOpen(false);
    onOpenMeeting(meetingId);
  };

  // Preference-gated views. Overdue off → no red badge, no overdue section.
  // Team activity off → no team feed, no unread dot, no All/For-me toggle.
  const overdueShown = prefs.overdueTasks ? overdue : [];
  const badgeCount = prefs.overdueTasks ? overdueCount : 0;
  const hasNudge = !!nudge && !!user;
  const showUnreadDot = (prefs.teamActivity && unread > 0) || (hasNudge && !nudgeSeen);
  const visible = prefs.teamActivity
    ? (items ?? []).filter((n) => !mineOnly || n.recipient_id === user?.id)
    : [];

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        data-tour-id="notifications-bell"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label="Notifications"
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-[var(--radius)] transition-colors",
          open
            ? "bg-primary/15 text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Bell className="h-[18px] w-[18px]" />
        {badgeCount > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 min-w-[1rem] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white"
            title={`${badgeCount} overdue task${badgeCount === 1 ? "" : "s"}`}
          >
            {badgeCount}
          </span>
        ) : (
          showUnreadDot && (
            <span
              className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-surface"
              title={`${unread} new notification${unread === 1 ? "" : "s"}`}
            />
          )
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-[70] mt-2 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-[380px] flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {prefs.teamActivity && (
              <div className="flex rounded-[var(--radius)] border border-border p-0.5">
                {(
                  [
                    [false, "All"],
                    [true, "For me"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={label}
                    onClick={() => setMineOnly(v)}
                    className={cn(
                      "rounded-[calc(var(--radius)-2px)] px-2.5 py-0.5 text-xs",
                      mineOnly === v
                        ? "bg-primary/15 font-semibold text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {hasNudge && nudge && (
              <div className="mb-3 flex items-start gap-2.5 rounded-[var(--radius)] border border-accent/40 bg-accent/5 px-3 py-2">
                <div className="mt-0.5 rounded-full bg-accent/15 p-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {nudge.count} {nudge.count === 1 ? "person" : "people"} from {nudge.domain} also
                    use Lalela
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Share a folder from Settings → Team to collaborate.
                  </p>
                </div>
                <button
                  onClick={() => {
                    consumeNudge();
                    setNudge(null);
                  }}
                  title="Dismiss"
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {overdueShown.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-danger" />
                  <h3 className="text-xs font-semibold">Overdue tasks ({overdueShown.length})</h3>
                </div>
                <div className="space-y-1.5">
                  {overdueShown.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => void openMeeting(t.meeting_id)}
                      className="flex w-full items-start gap-2.5 rounded-[var(--radius)] border border-danger/40 bg-danger/5 px-3 py-2 text-left hover:bg-danger/10"
                    >
                      <div className="mt-0.5 rounded-full bg-danger/15 p-1.5">
                        <CalendarClock className="h-3.5 w-3.5 text-danger" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t.title}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-danger">due {t.due}</span>
                          {t.assignee_name && (
                            <span className="flex items-center gap-1">
                              <User className="h-3 w-3" />
                              {t.assignee_name}
                            </span>
                          )}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!prefs.teamActivity ? (
              overdueShown.length === 0 &&
              !hasNudge && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <Bell className="mx-auto mb-2 h-5 w-5" />
                  You're all caught up.
                </div>
              )
            ) : !user ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {IS_COMMUNITY
                  ? "Nothing new. Team activity is part of the hosted Lalela app."
                  : "Sign in (Settings → Account) to see your team's activity."}
              </p>
            ) : items === null ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
            ) : visible.length === 0 ? (
              !hasNudge && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <Bell className="mx-auto mb-2 h-5 w-5" />
                  {mineOnly
                    ? "Nothing addressed to you yet."
                    : overdueShown.length > 0
                      ? "No team activity yet."
                      : "You're all caught up."}
                </div>
              )
            ) : (
              <div className="space-y-1.5">
                {visible.map((n) => {
                  const Icon = KIND_ICON[n.kind] ?? Bell;
                  const isUnread = n.created_at > lastSeen && n.actor_id !== user.id;
                  const forMe = n.recipient_id === user.id;
                  return (
                    <button
                      key={n.id}
                      onClick={() => n.meeting_id && void openMeeting(n.meeting_id)}
                      disabled={!n.meeting_id}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left",
                        n.meeting_id && "hover:bg-muted",
                        isUnread && "border-accent/40 bg-accent/5",
                      )}
                    >
                      <div className="mt-0.5 rounded-full bg-primary/15 p-1.5">
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{n.title}</span>
                          {forMe && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px]">
                              for you
                            </span>
                          )}
                          {!n.recipient_id && (
                            <span
                              className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                              title="Visible to everyone in the folder"
                            >
                              <Users className="h-3 w-3" />
                              team
                            </span>
                          )}
                        </div>
                        {n.body && (
                          <p className="mt-0.5 truncate text-sm text-muted-foreground">{n.body}</p>
                        )}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {n.actor_name} · {formatDate(n.created_at)}
                        </p>
                      </div>
                      {n.meeting_id && (
                        <FileText className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
