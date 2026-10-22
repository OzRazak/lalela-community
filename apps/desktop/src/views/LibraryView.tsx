import { useState } from "react";
import { PromptLibrary } from "@/components/PromptLibrary";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { cn } from "@/lib/utils";

interface LibraryViewProps {
  /** When embedded inside the Automations hub, hide the standalone header — the
   * hub already provides the "Automations ▸ Library" context. */
  embedded?: boolean;
}

/** One home for reusable assets: the prompt library and workflow templates.
 * Both are global — prompts feed summaries and workflow blocks; workflows run
 * from any meeting's Workflows tab. */
export function LibraryView({ embedded = false }: LibraryViewProps) {
  const [tab, setTab] = useState<"prompts" | "workflows">("prompts");

  return (
    <div className="flex h-full flex-col">
      {!embedded && (
        <header className="border-b border-border px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            Reusable prompts and workflow templates, available across all meetings.
          </p>
        </header>
      )}

      <div className="flex gap-1 border-b border-border px-6 pt-3">
        {(
          [
            ["prompts", "Prompts"],
            ["workflows", "Workflows"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-t-[var(--radius)] border border-b-0 px-4 py-2 text-sm",
              tab === id
                ? "border-border bg-card font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          {tab === "prompts" ? <PromptLibrary /> : <WorkflowEditor />}
        </div>
      </div>
    </div>
  );
}
