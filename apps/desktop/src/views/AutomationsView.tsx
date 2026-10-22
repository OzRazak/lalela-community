// Automations — a top-level tab (deliberately NOT buried in Settings so it
// isn't missed). Three panes: the tag rules (create/edit/toggle/delete), the
// pending-approval queue (ask-mode sends awaiting a click), and the run history
// (the audit trail). Local SQLite is canonical for the rules; every write
// mirrors to the cloud so the web app and the cloud engine share one state.

import { useCallback, useEffect, useState } from "react";
import { PlayCircle, Zap } from "lucide-react";
import { VideoModal } from "@/components/VideoModal";
import { getVideoById } from "@/lib/videos";
import { TagRuleList } from "@/components/automations/TagRuleList";
import { PendingApprovals } from "@/components/automations/PendingApprovals";
import { RunHistory } from "@/components/automations/RunHistory";
import { AutomationEditorDialog } from "@/components/automations/AutomationEditorDialog";
import { RetroRunDialog } from "@/components/automations/RetroRunDialog";
import { LibraryView } from "@/views/LibraryView";
import type { AutomationsTab } from "@/components/Sidebar";
import { cn } from "@/lib/utils";
import {
  deleteAutomation,
  listAutomations,
  listTags,
  upsertAutomation,
  type Automation,
  type Tag,
} from "@/lib/tags";
import { cloudDeleteAutomation, cloudUpsertAutomation, currentUid } from "@/lib/automationsSync";
import { SENDS_AVAILABLE } from "@/lib/destinations";

/** Flattened single tab row. Rules / Pending approvals / History all live under
 * the "rules" hub value; Library is its own hub value. */
type Tab = "rules" | "pending" | "history" | "library";

interface AutomationsViewProps {
  /** Which hub tab external navigation (⌘K deep-links) is pointing at — Rules or
   * Library. Only these two round-trip to the parent; Pending/History are local. */
  tab: AutomationsTab;
  onTabChange: (tab: AutomationsTab) => void;
}

export function AutomationsView({ tab, onTabChange }: AutomationsViewProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [showVideo, setShowVideo] = useState(false);
  const introVideo = getVideoById("automations");
  const [active, setActive] = useState<Tab>(tab === "library" ? "library" : "rules");

  // Follow external navigation: a ⌘K deep-link (or re-opening the hub) sets the
  // AutomationsTab prop, which maps onto the single row here. Only fires when the
  // prop value actually changes, so clicking Pending/History never gets clobbered.
  useEffect(() => {
    setActive(tab === "library" ? "library" : "rules");
  }, [tab]);

  const select = (id: Tab) => {
    setActive(id);
    // Only the two hub-level tabs propagate to the parent's AutomationsTab so
    // external navigation state stays coherent; Pending/History are local-only.
    if (id === "library") onTabChange("library");
    else if (id === "rules") onTabChange("rules");
  };
  const [editing, setEditing] = useState<Automation | null | undefined>(undefined); // undefined = closed
  const [running, setRunning] = useState<Automation | null>(null); // retro-run dialog target
  // Bumped when a retro-run finishes so the Pending/History panes remount + refetch.
  const [runsKey, setRunsKey] = useState(0);

  const refresh = useCallback(async () => {
    const [t, a] = await Promise.all([
      listTags().catch(() => []),
      listAutomations().catch(() => []),
    ]);
    setTags(t);
    setAutomations(a);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = async (a: Automation, enabled: boolean) => {
    const next = { ...a, enabled };
    setAutomations((prev) => prev.map((x) => (x.tag_id === a.tag_id ? next : x))); // optimistic
    try {
      if (await currentUid()) await cloudUpsertAutomation(next);
      await upsertAutomation(next);
    } catch {
      void refresh();
    }
  };

  const onDelete = async (a: Automation) => {
    const tag = tags.find((t) => t.id === a.tag_id);
    if (!window.confirm(`Delete the automation on “${tag?.name ?? a.tag_id}”? The tag is kept.`))
      return;
    await deleteAutomation(a.tag_id).catch(() => {});
    void cloudDeleteAutomation(a.tag_id);
    await refresh();
  };

  const tagsWithout = tags.filter((t) => !automations.some((a) => a.tag_id === t.id));
  const editorTag = editing ? tags.find((t) => t.id === editing.tag_id) ?? null : null;

  // Library is a place of its own — a standalone pill the same height as the
  // trio's segment, so the whole row sits on one centerline.
  const tabButton = (id: Tab, label: string, tourId?: string) => (
    <button
      data-tour-id={tourId}
      onClick={() => select(id)}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-[var(--radius)] px-3 py-1.5 text-sm transition-colors",
        active === id
          ? "border border-border bg-card font-semibold text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  // Rules / Pending / History are one workflow — they share a segmented control
  // (classic pill), visually set apart from Library. Active = raised card pill.
  const segButton = (id: Tab, label: string, tourId?: string) => (
    <button
      data-tour-id={tourId}
      onClick={() => select(id)}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-[calc(var(--radius)-2px)] px-3 py-1 text-sm transition-colors",
        active === id
          ? "bg-card font-semibold text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-6 py-4">
        <Zap className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold tracking-tight">Automations</h1>
        <button
          onClick={() => setShowVideo(true)}
          className="ml-auto flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="A 90-second video of what Automations can do"
        >
          <PlayCircle className="h-3.5 w-3.5" />
          Watch intro
          <span className="text-[10px] text-muted-foreground">1:31</span>
        </button>
      </header>
      {showVideo && introVideo && <VideoModal video={introVideo} onClose={() => setShowVideo(false)} />}

      {/* Row reads: Library ┃ [Rules · Pending approvals · History]. Library is
          its own place; the rules trio is one workflow, grouped in a segmented
          control and fenced off by a divider. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-surface px-6 py-2">
        {tabButton("library", "Library", "automations-library-tab")}
        <div className="mx-2 h-6 shrink-0 border-l border-border" aria-hidden="true" />
        <div
          className="flex shrink-0 items-center gap-1 rounded-[var(--radius)] bg-muted/60 p-1"
          title="Rules, their pending approvals, and the run history — one workflow."
        >
          {segButton("rules", "Rules", "automations-rules-tab")}
          {SENDS_AVAILABLE && segButton("pending", "Pending approvals", "automations-pending-tab")}
          {segButton("history", "History")}
        </div>
      </div>

      {active === "library" ? (
        <div className="min-h-0 flex-1">
          <LibraryView embedded />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {active === "rules" && (
            <TagRuleList
              tags={tags}
              automations={automations}
              onNew={() => setEditing(null)}
              onEdit={(a) => setEditing(a)}
              onToggle={onToggle}
              onDelete={onDelete}
              onRunPast={(a) => setRunning(a)}
            />
          )}
          {active === "pending" && (
            <PendingApprovals key={runsKey} showMeeting onChanged={refresh} />
          )}
          {active === "history" && <RunHistory key={runsKey} />}
        </div>
      )}

      {editing !== undefined && (
        <AutomationEditorDialog
          existing={editing}
          existingTag={editorTag}
          availableTags={tagsWithout}
          allTagsCount={tags.length}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void refresh();
          }}
          onRunPast={(a) => {
            setEditing(undefined);
            void refresh();
            setRunning(a);
          }}
        />
      )}

      {running && (
        <RetroRunDialog
          automation={running}
          tag={tags.find((t) => t.id === running.tag_id) ?? null}
          onClose={() => setRunning(null)}
          onRan={() => {
            setRunsKey((k) => k + 1);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
