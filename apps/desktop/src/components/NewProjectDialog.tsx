import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FolderPlus, X } from "lucide-react";

interface NewProjectDialogProps {
  title: string; // "New project" | "Rename project"
  confirmLabel: string; // "Create" | "Rename"
  initialValue?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Name-a-project modal, used for both create and rename.
 * Replaces window.prompt(), which silently returns null in Tauri's WKWebView.
 */
export function NewProjectDialog({
  title,
  confirmLabel,
  initialValue = "",
  onSubmit,
  onClose,
}: NewProjectDialogProps) {
  const [name, setName] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15">
              <FolderPlus className="h-5 w-5" />
            </div>
            <h2 className="font-semibold">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="Project name"
            className="w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
