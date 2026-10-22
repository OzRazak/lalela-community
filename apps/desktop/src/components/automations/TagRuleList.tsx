// The list of tag automations (phase 19 / B7 — desktop). One card per tag that
// carries an automation: color chip, a one-line rule summary, an enabled
// toggle, and edit/delete. "New automation" opens the editor.

import { History, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { Automation, Tag } from "@/lib/tags";

/** Human one-liner for a rule's conditions + actions. */
function summarize(a: Automation): string {
  const when: string[] = [];
  const m = a.match ?? {};
  if (m.title_keywords?.length) when.push(`title ~ ${m.title_keywords.join(" / ")}`);
  if (m.attendee_emails?.length) when.push(`${m.attendee_emails.length} email(s)`);
  if (m.attendee_names?.length) when.push(`name ~ ${m.attendee_names.join(" / ")}`);
  if (m.sources?.length) when.push(`source: ${m.sources.join(", ")}`);
  if (m.schedule_window) when.push("in a schedule window");
  if (a.ai_classify?.enabled && a.ai_classify.hint) when.push("AI classification");

  const then: string[] = [];
  const acts = a.actions ?? {};
  if (acts.project_id) then.push("file");
  if (acts.workflow_id) then.push("workflow");
  if (acts.summary_prompt_text || acts.prompt_id) then.push("summary");
  if (acts.sends?.length) then.push(`${acts.sends.length} send(s)`);

  const whenStr = when.length ? when.join(" · ") : "no conditions";
  const thenStr = then.length ? then.join(", ") : "tag only";
  return `When ${whenStr} → ${thenStr}`;
}

interface Props {
  tags: Tag[];
  automations: Automation[];
  onNew: () => void;
  onEdit: (a: Automation) => void;
  onToggle: (a: Automation, enabled: boolean) => void;
  onDelete: (a: Automation) => void;
  onRunPast: (a: Automation) => void;
}

export function TagRuleList({
  tags,
  automations,
  onNew,
  onEdit,
  onToggle,
  onDelete,
  onRunPast,
}: Props) {
  const tagOf = (id: string) => tags.find((t) => t.id === id);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Automations tag meetings as they arrive and run actions — file into a folder, run a
          workflow, draft a summary, or send to another app.
        </p>
        <Button data-tour-id="new-automation" size="sm" onClick={onNew} className="shrink-0">
          <Plus className="h-4 w-4" /> New automation
        </Button>
      </div>

      {automations.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          <Zap className="mx-auto mb-2 h-5 w-5" />
          No automations yet. Create one to tag and route meetings automatically.
        </div>
      ) : (
        <ul className="space-y-2">
          {automations.map((a) => {
            const tag = tagOf(a.tag_id);
            return (
              <li
                key={a.tag_id}
                className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3"
              >
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                  style={{
                    background: `${tag?.color ?? "#7c6cf5"}22`,
                    color: tag?.color ?? "#7c6cf5",
                  }}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: tag?.color ?? "#7c6cf5" }}
                  />
                  {tag?.name ?? a.tag_id}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {summarize(a)}
                </span>
                <label
                  className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  title={a.enabled ? "Enabled" : "Disabled"}
                >
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={(e) => onToggle(a, e.target.checked)}
                  />
                  On
                </label>
                <button
                  onClick={() => onRunPast(a)}
                  title="Run this automation on past meetings"
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <History className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onEdit(a)}
                  title="Edit automation"
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onDelete(a)}
                  title="Delete automation"
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
