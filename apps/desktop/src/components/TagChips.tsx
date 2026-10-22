// Tag chips for a meeting (phase 19): shows assigned tags, and (unless
// read-only) a "+ Tag" popover to toggle existing tags or create one inline.
// Local SQLite is canonical; every change writes through to the cloud mirror
// so the web app and the cloud automation engine see the same tag state.

import { useEffect, useRef, useState } from "react";
import { Plus, Tag as TagIcon, Trash2, X } from "lucide-react";
import {
  deleteTag,
  getMeetingTags,
  listTags,
  saveTag,
  setMeetingTags,
  type Tag,
} from "@/lib/tags";
import { cloudDeleteTag, cloudSaveTag, cloudSetMeetingTags } from "@/lib/tagsSync";

/** Rotating palette for newly created tags. */
const TAG_COLORS = [
  "#7c6cf5",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
];

/** Display-only chip row — used in meeting lists. */
export function TagChipRow({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 rounded-full px-2 py-px text-[11px] font-medium"
          style={{ background: `${t.color}22`, color: t.color }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
          {t.name}
        </span>
      ))}
    </div>
  );
}

export function TagChips({
  meetingId,
  readOnly,
  onChanged,
}: {
  meetingId: string;
  readOnly?: boolean;
  onChanged?: () => void;
}) {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const popRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    setAllTags(await listTags().catch(() => []));
    setAssigned(await getMeetingTags(meetingId).catch(() => []));
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const apply = async (tagIds: string[]) => {
    setAssigned(tagIds); // optimistic
    await setMeetingTags(meetingId, tagIds).catch(() => {});
    void cloudSetMeetingTags(meetingId, tagIds);
    onChanged?.();
  };

  const toggle = (tagId: string) =>
    apply(assigned.includes(tagId) ? assigned.filter((id) => id !== tagId) : [...assigned, tagId]);

  const createTag = async () => {
    const name = newName.trim();
    if (!name) return;
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      setNewName("");
      if (!assigned.includes(existing.id)) await toggle(existing.id);
      return;
    }
    const color = TAG_COLORS[allTags.length % TAG_COLORS.length];
    const tag = await saveTag({ name, color });
    void cloudSaveTag(tag);
    setAllTags([...allTags, tag]);
    setNewName("");
    await apply([...assigned, tag.id]);
  };

  const removeTagEverywhere = async (tag: Tag) => {
    if (!window.confirm(`Delete the tag “${tag.name}” from all meetings?`)) return;
    await deleteTag(tag.id).catch(() => {});
    void cloudDeleteTag(tag.id);
    await refresh();
    onChanged?.();
  };

  const assignedTags = allTags.filter((t) => assigned.includes(t.id));

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      {assignedTags.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ background: `${t.color}22`, color: t.color }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
          {t.name}
          {!readOnly && (
            <button
              onClick={() => toggle(t.id)}
              aria-label={`Remove tag ${t.name}`}
              className="opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {assignedTags.length === 0 ? <TagIcon className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          Tag
        </button>
      )}
      {open && (
        <div
          ref={popRef}
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-[var(--radius)] border border-border bg-card p-2 shadow-lg"
        >
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {allTags.length === 0 && (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                No tags yet — create one below. Tags can also drive automations
                (folder filing, workflows, sends).
              </p>
            )}
            {allTags.map((t) => (
              <div key={t.id} className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={assigned.includes(t.id)}
                    onChange={() => toggle(t.id)}
                  />
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color }} />
                  <span className="truncate">{t.name}</span>
                </label>
                <button
                  onClick={() => removeTagEverywhere(t)}
                  aria-label={`Delete tag ${t.name}`}
                  title="Delete this tag everywhere"
                  className="hidden text-muted-foreground hover:text-danger group-hover:block"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createTag();
            }}
            className="mt-2 flex items-center gap-1.5 border-t border-border pt-2"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New tag name…"
              className="h-7 min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-transparent px-2 text-sm outline-none"
            />
            <button
              type="submit"
              disabled={!newName.trim()}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--radius)] bg-primary px-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
