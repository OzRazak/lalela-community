import { Button } from "@/components/ui/Button";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { Workflow as WorkflowIcon, X } from "lucide-react";

interface WorkflowEditorDialogProps {
  onClose: () => void;
}

/** Modal wrapper around WorkflowEditor (used from a meeting's Workflows tab).
 * Saving closes the dialog so the panel underneath refreshes immediately —
 * staying open with no feedback reads as "the save did nothing". */
export function WorkflowEditorDialog({ onClose }: WorkflowEditorDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15">
              <WorkflowIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold">Workflows</h2>
              <p className="text-xs text-muted-foreground">
                Reusable prompt pipelines — each block runs on the transcript or an earlier
                block's output.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <WorkflowEditor onSaved={onClose} />
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
