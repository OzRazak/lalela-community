// Knowledge hub — "what your meetings add up to". A thin wrapper that groups the
// two derived-insight surfaces (Wiki + Reports) behind internal tabs, mirroring
// the existing internal-tab pattern used by Automations/Library. The child views
// render unchanged below the hub tab strip, keeping their own headers, detail
// overlays and empty states — the IA consolidation is navigational only.

import { WikiView } from "@/views/WikiView";
import { ReportsView } from "@/views/ReportsView";
import { PeopleCompaniesView } from "@/views/PeopleCompaniesView";
import type { KnowledgeTab } from "@/components/Sidebar";
import { cn } from "@/lib/utils";

interface KnowledgeViewProps {
  tab: KnowledgeTab;
  onTabChange: (tab: KnowledgeTab) => void;
  onOpenMeeting: (id: string) => void;
}

const TABS: Array<[KnowledgeTab, string]> = [
  ["reports", "Reports"],
  ["wiki", "Wiki"],
  ["people", "People"],
];

export function KnowledgeView({ tab, onTabChange, onOpenMeeting }: KnowledgeViewProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-border bg-surface px-6 pt-2">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-t-[var(--radius)] px-3 py-1.5 text-sm",
              tab === id
                ? "border border-b-0 border-border bg-card font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "wiki" ? (
          <WikiView onOpenMeeting={onOpenMeeting} />
        ) : tab === "people" ? (
          <PeopleCompaniesView onOpenMeeting={onOpenMeeting} />
        ) : (
          <ReportsView />
        )}
      </div>
    </div>
  );
}
