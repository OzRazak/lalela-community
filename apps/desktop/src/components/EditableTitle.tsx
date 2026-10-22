import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface EditableTitleProps {
  value: string;
  /** Called with the trimmed new text, only when it actually changed. */
  onSave: (next: string) => void;
  /** Read-only rendering (e.g. someone else's shared task). */
  disabled?: boolean;
  /** Classes for BOTH the display element and the editor, so the title keeps
   * its size/weight while editing. */
  className?: string;
  /** Tooltip on the display element (defaults to a "click to edit" hint). */
  title?: string;
  /** Fires on enter/leave of edit mode — lets a draggable parent turn its drag
   * off while the field is focused (otherwise a text selection starts a drag). */
  onEditingChange?: (editing: boolean) => void;
}

const autosize = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
};

/** A title that turns into an inline textarea on click. Enter (or blur) saves,
 * Escape cancels, empty/unchanged is a no-op. Used for editing action-item
 * titles on the meeting panel and the Tasks board. */
export function EditableTitle({
  value,
  onSave,
  disabled = false,
  className,
  title,
  onEditingChange,
}: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
    autosize(el);
  }, [editing]);

  const start = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
    onEditingChange?.(true);
  };
  const stop = () => {
    setEditing(false);
    onEditingChange?.(false);
  };
  const commit = () => {
    stop();
    const next = draft.trim();
    if (next && next !== value) onSave(next);
  };

  if (disabled || !editing) {
    return (
      <div
        className={cn(className, !disabled && "cursor-text rounded hover:bg-muted/50")}
        title={disabled ? title : (title ?? "Click to edit")}
        onClick={disabled ? undefined : start}
      >
        {value}
      </div>
    );
  }

  return (
    <textarea
      ref={ref}
      value={draft}
      rows={1}
      onChange={(e) => {
        setDraft(e.target.value);
        autosize(e.currentTarget);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          stop();
        }
      }}
      // Keep the click/drag off the parent card while editing.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      className={cn(
        className,
        "w-full resize-none rounded-[var(--radius)] border border-border bg-card px-1.5 py-1 outline-none focus:ring-2 focus:ring-ring",
      )}
    />
  );
}
