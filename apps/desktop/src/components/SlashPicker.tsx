import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { getPrompts, type Prompt } from "@/lib/settings";
import { listWorkflows, type Workflow } from "@/lib/lalela";
import { Sparkles, Workflow as WorkflowIcon } from "lucide-react";

/** What a "/" run resolves to — a saved Prompt or a Workflow. */
export type SlashEntry =
  | { kind: "prompt"; prompt: Prompt }
  | { kind: "workflow"; workflow: Workflow };

/** Imperative surface so the chat textarea (which keeps focus) can drive the
 * popover: forward Arrow/Enter/Esc here first; a `true` return means consumed. */
export interface SlashPickerHandle {
  handleKey: (e: React.KeyboardEvent) => boolean;
}

interface SlashPickerProps {
  /** The text typed after "/" — filters both groups as you type. */
  query: string;
  /** Meeting scope only (and desktop, not mobile): Workflows are meeting-shaped. */
  allowWorkflows: boolean;
  onRun: (entry: SlashEntry) => void;
  onClose: () => void;
}

interface Row {
  key: string;
  group: "Prompts" | "Workflows";
  label: string;
  hint?: string;
  entry: SlashEntry;
}

/** Granola-style "/" launcher: run a saved Prompt or a Workflow from the chat
 * input. Prompts come from the library (getPrompts); Workflows (meeting scope
 * only) from the local store. Filters as you type; ↑↓ + ⏎ run, esc dismisses.
 * Matches the ⌘K CommandPalette's grouped-list look (Amp dial 2, sober). */
export const SlashPicker = forwardRef<SlashPickerHandle, SlashPickerProps>(function SlashPicker(
  { query, allowWorkflows, onRun, onClose },
  ref,
) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Load workflows once when offered (meeting scope). Prompts are synchronous.
  useEffect(() => {
    if (!allowWorkflows) {
      setWorkflows([]);
      return;
    }
    let cancelled = false;
    listWorkflows()
      .then((list) => !cancelled && setWorkflows(list))
      .catch(() => !cancelled && setWorkflows([]));
    return () => {
      cancelled = true;
    };
  }, [allowWorkflows]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Row[] = [];
    for (const p of getPrompts()) {
      if (hit(p.name)) {
        out.push({
          key: `prompt:${p.id}`,
          group: "Prompts",
          label: p.name,
          entry: { kind: "prompt", prompt: p },
        });
      }
    }
    if (allowWorkflows) {
      for (const w of workflows) {
        if (hit(w.name)) {
          out.push({
            key: `workflow:${w.id}`,
            group: "Workflows",
            label: w.name,
            hint: `${w.blocks.length} step${w.blocks.length === 1 ? "" : "s"}`,
            entry: { kind: "workflow", workflow: w },
          });
        }
      }
    }
    return out;
  }, [query, allowWorkflows, workflows]);

  // Keep the cursor valid as the filter narrows the list.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(rows.length - 1, 0)));
  }, [rows.length]);
  useEffect(() => setSelected(0), [query]);

  // Keep the highlighted row scrolled into view while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useImperativeHandle(
    ref,
    () => ({
      handleKey: (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelected((s) => Math.min(s + 1, Math.max(rows.length - 1, 0)));
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelected((s) => Math.max(s - 1, 0));
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // Always consume Enter while open so a filtered-out "/query" is never
          // sent as a literal chat message.
          e.preventDefault();
          const row = rows[selected];
          if (row) onRun(row.entry);
          return true;
        }
        return false;
      },
    }),
    [rows, selected, onRun, onClose],
  );

  let lastGroup: string | null = null;
  return (
    <>
      {/* Click-away layer (matches the History dropdown pattern). */}
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute bottom-full left-0 right-0 z-20 mb-2 flex max-h-72 flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Run from your library
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No matching prompts. Manage them under Automations → Library.
            </p>
          ) : (
            rows.map((r, i) => {
              const header = r.group !== lastGroup ? r.group : null;
              lastGroup = r.group;
              const Icon = r.entry.kind === "workflow" ? WorkflowIcon : Sparkles;
              return (
                <div key={r.key}>
                  {header && (
                    <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase text-muted-foreground">
                      {header}
                    </div>
                  )}
                  <button
                    data-idx={i}
                    onClick={() => onRun(r.entry)}
                    onMouseMove={() => setSelected(i)}
                    className={
                      "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-left text-sm " +
                      (i === selected ? "bg-primary/15" : "hover:bg-muted")
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    {r.hint && <span className="text-xs text-muted-foreground">{r.hint}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          ↑↓ navigate · ⏎ run · esc close
        </div>
      </div>
    </>
  );
});
