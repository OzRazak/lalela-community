import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Member } from "@/lib/sync";

/** The two fields an assignee edit writes. `assignee_uid` is only set when the
 * name matches a real project member (so their board mirrors the task); a
 * free-typed name keeps it null. */
export interface AssigneeValue {
  assignee_name: string | null;
  assignee_uid: string | null;
}

interface AssigneeComboboxProps {
  assigneeName: string | null;
  assigneeUid: string | null;
  /** Project members — the primary, syncable source. */
  members: Member[];
  /** Distinct free-text names already used on other tasks (suggestions). */
  usedNames?: string[];
  onChange: (next: AssigneeValue) => void;
  /** Classes for the trigger button (sizing to match its context). */
  triggerClassName?: string;
}

type Row =
  | { kind: "unassigned" }
  | { kind: "member"; member: Member }
  | { kind: "name"; name: string }
  | { kind: "add"; name: string };

const memberLabel = (m: Member) => m.display_name ?? m.email ?? m.user_id;
const memberValue = (m: Member) => m.display_name ?? m.email ?? "Member";

/** A type-ahead assignee picker: filter the members + previously-used names as
 * you type, and — when the typed name matches nothing — assign it verbatim via
 * an `Add "…"` row. Keyboard-first (↑↓ move · ⏎ pick · esc close) and styled
 * like the ⌘K palette / "/" launcher (Amp dial 2, sober). Replaces the closed
 * assignee <select> so any name can be used, not just the dropdown options. */
export function AssigneeCombobox({
  assigneeName,
  assigneeUid,
  members,
  usedNames = [],
  onChange,
  triggerClassName,
}: AssigneeComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Anchor the fixed popover under the trigger; re-place on scroll/resize so it
  // stays glued while a kanban column scrolls. Portalled to <body> so no
  // overflow-clipping ancestor can hide it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.max(r.width, 224);
      const left = Math.min(r.left, window.innerWidth - width - 8);
      setPos({ left: Math.max(8, left), top: r.bottom + 4, width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  // Close on outside pointer / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const ql = q.toLowerCase();
    const hit = (s: string) => !ql || s.toLowerCase().includes(ql);
    const out: Row[] = [];

    if (hit("unassigned")) out.push({ kind: "unassigned" });

    const memberKeys = new Set<string>();
    for (const m of members) {
      const label = memberLabel(m);
      memberKeys.add(label.toLowerCase());
      const local = (m.email ?? "").split("@")[0].toLowerCase();
      if (local) memberKeys.add(local);
      if (hit(label) || hit(m.email ?? "")) out.push({ kind: "member", member: m });
    }

    // Free-text names used elsewhere (∪ the current name), minus any that are
    // really a member (so a member isn't listed twice).
    const names = new Set<string>();
    for (const n of usedNames) if (n?.trim()) names.add(n.trim());
    if (assigneeName && !assigneeUid) names.add(assigneeName.trim());
    [...names]
      .filter((n) => !memberKeys.has(n.toLowerCase()) && hit(n))
      .sort((a, b) => a.localeCompare(b))
      .forEach((name) => out.push({ kind: "name", name }));

    // Offer to assign the raw typed text when it matches no existing option.
    const exists =
      memberKeys.has(ql) || [...names].some((n) => n.toLowerCase() === ql);
    if (q && !exists) out.push({ kind: "add", name: q });

    return out;
  }, [query, members, usedNames, assigneeName, assigneeUid]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(rows.length - 1, 0)));
  }, [rows.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const isCurrent = (r: Row) =>
    r.kind === "unassigned"
      ? !assigneeName && !assigneeUid
      : r.kind === "member"
        ? assigneeUid === r.member.user_id
        : r.kind === "name"
          ? !assigneeUid && assigneeName === r.name
          : false;

  const pick = (r: Row) => {
    if (r.kind === "unassigned") onChange({ assignee_name: null, assignee_uid: null });
    else if (r.kind === "member")
      onChange({ assignee_name: memberValue(r.member), assignee_uid: r.member.user_id });
    else onChange({ assignee_name: r.name, assignee_uid: null });
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[selected];
      if (row) pick(row);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Assignee — type any name; matched project members sync to their board"
        className={cn(
          "flex items-center gap-1 rounded-[var(--radius)] border border-border bg-card text-left",
          triggerClassName,
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !assigneeName && "text-muted-foreground")}>
          {assigneeName ?? "Unassigned"}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="fixed z-[70] flex max-h-72 flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
          >
            <div className="border-b border-border p-1.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Assign to a name…"
                className="h-7 w-full rounded-[calc(var(--radius)-2px)] bg-transparent px-2 text-sm outline-none"
              />
            </div>
            <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
              {rows.map((r, i) => {
                const key =
                  r.kind === "member"
                    ? `m:${r.member.user_id}`
                    : r.kind === "name"
                      ? `n:${r.name}`
                      : r.kind;
                const label =
                  r.kind === "unassigned"
                    ? "Unassigned"
                    : r.kind === "member"
                      ? memberLabel(r.member)
                      : r.name;
                const Icon = r.kind === "add" ? Plus : User;
                return (
                  <button
                    key={key}
                    type="button"
                    data-idx={i}
                    onClick={() => pick(r)}
                    onMouseMove={() => setSelected(i)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[calc(var(--radius)-2px)] px-2 py-1.5 text-left text-sm",
                      i === selected ? "bg-primary/15" : "hover:bg-muted",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        r.kind === "unassigned" ? "text-muted-foreground" : "text-muted-foreground",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {r.kind === "add" ? (
                        <>
                          Assign to <span className="font-medium">“{label}”</span>
                        </>
                      ) : (
                        label
                      )}
                    </span>
                    {r.kind === "member" && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        member
                      </span>
                    )}
                    {isCurrent(r) && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
            <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
              ↑↓ navigate · ⏎ assign · esc close
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
