// Global top bar (desktop). Owns the "utility" affordances the IA consolidation
// demoted out of the sidebar: a persistent Search field (opens the ⌘K command
// palette, which runs the same full-text search), an AI free-allowance usage
// chip (mirrors the web app), and the Notifications bell + panel. Everything
// that is a *place* lives in the sidebar; everything that is an *action* or
// *alert* lives here.

import { useEffect, useState } from "react";
import { Search, CloudOff } from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";
import { useAuth } from "@/lib/auth";
import { getAiUsage, type AiUsage } from "@/lib/ai";
import {
  getSyncOutcome,
  isSyncAlerting,
  syncFailureHint,
  formatSyncTime,
  SYNC_OUTCOME_CHANGED_EVENT,
  type SyncOutcome,
} from "@/lib/syncStatus";
import { getApiKey, getModel, isAppleModelId, isLocalModelId } from "@/lib/settings";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** The command-palette keyboard chord, shown as a keycap. Windows uses Ctrl;
 * macOS uses ⌘. The handler in App.tsx already accepts either (metaKey ||
 * ctrlKey) — this only fixes what the label claims. */
const SEARCH_CHORD = IS_WINDOWS ? "Ctrl K" : "⌘K";

interface TopBarProps {
  /** Opens the ⌘K command palette (the search surface). */
  onOpenSearch: () => void;
  overdueCount?: number;
  onOpenMeeting: (id: string) => void;
  /** Opens Settings → Account (the free-allowance / plan surface). */
  onOpenAccount?: () => void;
}

/** "AI 12k / 200k" pill — the same numbers the Settings "Plan & usage" bar
 * shows. Only relevant when the user is actually spending the free cloud
 * allowance: signed in, no BYOK OpenRouter key, and not defaulted to a local
 * (on-device) model. Best-effort; renders nothing until usage loads. */
function AiUsageChip({ onOpenAccount }: { onOpenAccount?: () => void }) {
  const { user } = useAuth();
  const [usage, setUsage] = useState<AiUsage | null>(null);

  // Read from localStorage each render — cheap, and re-evaluated whenever the
  // chip re-renders (usage refresh / auth change).
  // On-device models (local or Apple) don't draw on the free-tier quota, so the
  // usage chip is hidden for both.
  const eligible =
    !!user && !getApiKey().trim() && !isLocalModelId(getModel()) && !isAppleModelId(getModel());

  useEffect(() => {
    if (!eligible || !user) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      getAiUsage(user.id)
        .then((u) => !cancelled && setUsage(u))
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [eligible, user]);

  if (!eligible || !usage) return null;
  const pct = usage.quota > 0 ? Math.round((usage.used / usage.quota) * 100) : 0;
  const danger = pct >= 90;
  return (
    <button
      onClick={onOpenAccount}
      title="Free AI allowance used this month — manage in Settings → Account"
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
        danger
          ? "border-danger/40 text-danger hover:bg-danger/10"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      AI {Math.round(usage.used / 1000)}k / {Math.round(usage.quota / 1000)}k
    </button>
  );
}

/** "Sync failing" pill — the one place a broken cloud sync is visible without
 * opening Settings. Deliberately quiet: it appears only once sync has been
 * failing for more than half an hour (see SYNC_ALERT_AFTER_MS), so a tunnel or
 * a sleeping laptop never nags, while a paused backend or an expired session
 * cannot stay invisible for two weeks the way it once did. */
function SyncStatusChip({ onOpenAccount }: { onOpenAccount?: () => void }) {
  const { user } = useAuth();
  const [outcome, setOutcome] = useState<SyncOutcome | null>(getSyncOutcome());

  useEffect(() => {
    const read = () => setOutcome(getSyncOutcome());
    read();
    // Re-read on our own broadcast (a fresh outcome) and on a timer (the
    // "failing for > 30 min" threshold passes with no new event).
    const interval = setInterval(read, 60_000);
    window.addEventListener(SYNC_OUTCOME_CHANGED_EVENT, read);
    return () => {
      clearInterval(interval);
      window.removeEventListener(SYNC_OUTCOME_CHANGED_EVENT, read);
    };
  }, [user]);

  if (!user || !isSyncAlerting(outcome) || !outcome) return null;
  return (
    <button
      onClick={onOpenAccount}
      title={`${syncFailureHint(outcome)} Failing since ${formatSyncTime(
        outcome.failingSince ?? outcome.at,
      )}.`}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-warning/40 px-2.5 py-1 text-xs text-warning transition-colors hover:bg-warning/10"
    >
      <CloudOff className="h-3.5 w-3.5" />
      Sync failing
    </button>
  );
}

export function TopBar({ onOpenSearch, overdueCount, onOpenMeeting, onOpenAccount }: TopBarProps) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
      <button
        data-tour-id="topbar-search"
        onClick={onOpenSearch}
        title={`Search (${SEARCH_CHORD})`}
        className="group flex h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          Search meetings, folders, actions…
        </span>
        <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none">
          {SEARCH_CHORD}
        </kbd>
      </button>
      <div className="flex-1" />
      <SyncStatusChip onOpenAccount={onOpenAccount} />
      <AiUsageChip onOpenAccount={onOpenAccount} />
      <NotificationBell overdueCount={overdueCount} onOpenMeeting={onOpenMeeting} align="right" />
    </header>
  );
}
