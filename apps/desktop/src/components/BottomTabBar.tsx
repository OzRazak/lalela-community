import { useState } from "react";
import { cn } from "@/lib/utils";
import type { NavTarget, View } from "@/components/Sidebar";
import {
  FileText,
  Search,
  MessagesSquare,
  Settings,
  Users,
  ListTodo,
  BookOpen,
  Zap,
  MoreHorizontal,
  X,
} from "lucide-react";

interface BottomTabBarProps {
  active: View;
  /** True when the Meetings "Shared with me" smart folder is the active scope. */
  sharedActive?: boolean;
  onNavigate: (target: NavTarget) => void;
}

type TabDef = { label: string; Icon: typeof FileText; target: NavTarget };

/** The most-used places get a permanent slot — mirrors the desktop sidebar's
 * primary nav (Meetings / Tasks / Chat / Knowledge). */
const PRIMARY: TabDef[] = [
  { label: "Meetings", Icon: FileText, target: { view: "meetings" } },
  { label: "Tasks", Icon: ListTodo, target: { view: "tasks" } },
  { label: "Chat", Icon: MessagesSquare, target: { view: "chat" } },
  { label: "Knowledge", Icon: BookOpen, target: { view: "knowledge" } },
];

/** Everything else lives behind "More". Wiki/Reports live inside Knowledge and
 * Library inside Automations, so they're reached via those hubs' tabs rather
 * than separate entries. Notifications are the header bell (see App.tsx). Search
 * is kept here because mobile has no ⌘K / top-bar search field. */
const OVERFLOW: TabDef[] = [
  { label: "Automations", Icon: Zap, target: { view: "automations" } },
  { label: "Search", Icon: Search, target: { view: "search" } },
  { label: "Shared", Icon: Users, target: { view: "meetings", shared: true } },
  { label: "Settings", Icon: Settings, target: { view: "settings" } },
];

/** Mobile replacement for the desktop sidebar. Primary tabs + a "More" sheet
 * that surfaces the remaining destinations. New Recording lives in a floating
 * action button (see App.tsx) rather than a tab. */
export function BottomTabBar({ active, sharedActive = false, onNavigate }: BottomTabBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  const isActive = (t: NavTarget) =>
    t.view === active && (t.view !== "meetings" || !!t.shared === sharedActive);

  const inOverflow = OVERFLOW.some((t) => isActive(t.target));

  const go = (target: NavTarget) => {
    setSheetOpen(false);
    onNavigate(target);
  };

  const tabClass = (selected: boolean) =>
    cn(
      "flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 pb-1.5 pt-2 text-[10px] font-medium",
      selected ? "text-foreground" : "text-muted-foreground",
    );

  return (
    <>
      {/* Overflow sheet — a bottom sheet listing the remaining destinations. */}
      {sheetOpen && (
        <>
          <button
            aria-label="Close menu"
            onClick={() => setSheetOpen(false)}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl">
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <span className="text-sm font-semibold">More</span>
              <button
                onClick={() => setSheetOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1 p-3">
              {OVERFLOW.map(({ label, Icon, target }) => {
                const selected = isActive(target);
                return (
                  <button
                    key={label}
                    onClick={() => go(target)}
                    className={cn(
                      "relative flex flex-col items-center gap-1.5 rounded-[var(--radius)] px-2 py-3 text-xs font-medium",
                      selected
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground active:bg-muted",
                    )}
                  >
                    <Icon
                      className={cn("h-5 w-5", selected && "text-accent")}
                      strokeWidth={selected ? 2.4 : 2}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <nav
        className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
        role="tablist"
      >
        {PRIMARY.map(({ label, Icon, target }) => {
          const selected = isActive(target) && !sheetOpen;
          return (
            <button
              key={label}
              role="tab"
              aria-selected={selected}
              onClick={() => go(target)}
              className={tabClass(selected)}
            >
              <Icon
                className={cn("h-5 w-5", selected && "text-accent")}
                strokeWidth={selected ? 2.4 : 2}
              />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
        <button
          role="tab"
          aria-selected={sheetOpen || inOverflow}
          onClick={() => setSheetOpen((v) => !v)}
          className={tabClass(sheetOpen || inOverflow)}
        >
          <MoreHorizontal
            className={cn("h-5 w-5", (sheetOpen || inOverflow) && "text-accent")}
            strokeWidth={sheetOpen || inOverflow ? 2.4 : 2}
          />
          <span className="truncate">More</span>
        </button>
      </nav>
    </>
  );
}
