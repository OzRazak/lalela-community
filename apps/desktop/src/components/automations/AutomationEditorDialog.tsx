// Create / edit one tag automation (phase 19 / B7 — desktop). A tag carries at
// most ONE automation: the "When" section decides when a meeting earns the tag
// (deterministic match, OR AI classification), the "Then" section decides what
// happens next (file into a folder, run a workflow, bind a summary prompt/model,
// queue/auto sends to connected destinations). The JSON shapes match the cloud
// jsonb columns exactly (apps/web/lib/tags.ts) so both engines agree.

import { useEffect, useMemo, useState } from "react";
import { History, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { IS_MOBILE } from "@/lib/platform";
import {
  listProjects,
  listWorkflows,
  flattenProjectTree,
  type Project,
  type Workflow,
} from "@/lib/lalela";
import { getPrompts, MODELS, modelPickerLabel, type Prompt } from "@/lib/settings";
import {
  saveTag,
  upsertAutomation,
  type Automation,
  type AutomationSend,
  type SendDestination,
  type Tag,
} from "@/lib/tags";
import { cloudSaveTag } from "@/lib/tagsSync";
import { cloudUpsertAutomation, currentUid } from "@/lib/automationsSync";
import { PRODUCT_HQ_LABEL, SENDS_AVAILABLE } from "@/lib/destinations";

const SOURCES: { id: string; label: string }[] = [
  { id: "web", label: "Web" },
  { id: "desktop", label: "Desktop" },
  { id: "teams", label: "Teams" },
  { id: "readai", label: "Read AI" },
  { id: "granola", label: "Granola" },
  { id: "fathom", label: "Fathom" },
  { id: "fireflies", label: "Fireflies" },
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DESTINATIONS: { id: SendDestination; label: string; needsTarget: "deal" | "product" | null }[] =
  [
    { id: "artemis", label: "Fikelela CRM (deal)", needsTarget: "deal" },
    { id: "artemis_lead_flow", label: "Fikelela CRM (create lead)", needsTarget: null },
    { id: "atlas", label: "Atlas Delivery", needsTarget: null },
    { id: "atlas_pack", label: "Atlas (proposed actions)", needsTarget: null },
    { id: "arete", label: PRODUCT_HQ_LABEL, needsTarget: "product" },
  ];

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

/** Comma/Enter-to-add chip input for keyword/email/name lists. */
function ChipsInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = draft.trim().replace(/,$/, "").trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-2 py-1.5">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="opacity-60 hover:opacity-100"
            aria-label={`Remove ${v}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ""}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

interface Props {
  /** The automation being edited, or null for a brand-new one. */
  existing: Automation | null;
  /** The tag the existing automation belongs to (for the header chip). */
  existingTag?: Tag | null;
  /** Tags without an automation yet (candidates when creating). */
  availableTags: Tag[];
  allTagsCount: number;
  onClose: () => void;
  onSaved: () => void;
  /** Save the current edits, then open the retro-run dialog on this automation
   * (only offered when editing an existing automation). */
  onRunPast?: (a: Automation) => void;
}

export function AutomationEditorDialog({
  existing,
  existingTag,
  availableTags,
  allTagsCount,
  onClose,
  onSaved,
  onRunPast,
}: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const prompts = useMemo<Prompt[]>(() => getPrompts(), []);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => setProjects([]));
    listWorkflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, []);

  // --- Tag choice (fixed when editing) ---
  const editing = !!existing;
  const [tagChoice, setTagChoice] = useState<string>(
    existing?.tag_id ?? availableTags[0]?.id ?? "__new__",
  );
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[allTagsCount % TAG_COLORS.length]);

  // --- When ---
  const m = existing?.match ?? {};
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [titleKeywords, setTitleKeywords] = useState<string[]>(m.title_keywords ?? []);
  const [attendeeEmails, setAttendeeEmails] = useState<string[]>(m.attendee_emails ?? []);
  const [attendeeNames, setAttendeeNames] = useState<string[]>(m.attendee_names ?? []);
  const [sources, setSources] = useState<string[]>(m.sources ?? []);
  const win = m.schedule_window as
    | { days?: number[]; start_hhmm?: string; end_hhmm?: string }
    | undefined;
  const [scheduleOn, setScheduleOn] = useState(!!win);
  const [days, setDays] = useState<number[]>(win?.days ?? []);
  const [startHHMM, setStartHHMM] = useState(win?.start_hhmm ?? "09:00");
  const [endHHMM, setEndHHMM] = useState(win?.end_hhmm ?? "17:00");

  // --- AI classification ---
  const ai = existing?.ai_classify ?? { enabled: false };
  const [aiEnabled, setAiEnabled] = useState(ai.enabled);
  const [aiHint, setAiHint] = useState(ai.hint ?? "");
  const [aiModel, setAiModel] = useState(ai.model ?? "");

  // --- Then ---
  const acts = existing?.actions ?? {};
  const [projectId, setProjectId] = useState<string>(acts.project_id ?? "");
  const [workflowId, setWorkflowId] = useState<string>(acts.workflow_id ?? "");
  const [promptId, setPromptId] = useState<string>(acts.prompt_id ?? "");
  const [summaryModelId, setSummaryModelId] = useState<string>(acts.summary_model ?? "");
  const [actionsModelId, setActionsModelId] = useState<string>(acts.actions_model ?? "");
  const [sends, setSends] = useState<AutomationSend[]>(acts.sends ?? []);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleIn = (list: string[], v: string, set: (n: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  const addSend = () => setSends([...sends, { destination: "atlas", mode: "ask" }]);
  const updateSend = (i: number, patch: Partial<AutomationSend>) =>
    setSends(sends.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeSend = (i: number) => setSends(sends.filter((_, idx) => idx !== i));

  const hasWhen =
    titleKeywords.length > 0 ||
    attendeeEmails.length > 0 ||
    attendeeNames.length > 0 ||
    sources.length > 0 ||
    (aiEnabled && aiHint.trim().length > 0);

  /** Validate + persist (cloud-first, then local). Returns the saved automation
   * on success, or null when validation/persist failed (error is set). */
  const persist = async (): Promise<Automation | null> => {
    setError(null);
    // Resolve the target tag (create it if the user is making a new one).
    let tagId = tagChoice;
    if (!editing && tagChoice === "__new__") {
      const name = newTagName.trim();
      if (!name) {
        setError("Name the tag this automation creates.");
        return null;
      }
      try {
        const tag = await saveTag({ name, color: newTagColor });
        void cloudSaveTag(tag);
        tagId = tag.id;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not create the tag.");
        return null;
      }
    }
    if (!tagId || tagId === "__new__") {
      setError("Pick a tag for this automation.");
      return null;
    }
    if (!hasWhen) {
      setError("Add at least one condition under “When” (or an AI description).");
      return null;
    }

    const match: Automation["match"] = {};
    if (titleKeywords.length) match.title_keywords = titleKeywords;
    if (attendeeEmails.length) match.attendee_emails = attendeeEmails;
    if (attendeeNames.length) match.attendee_names = attendeeNames;
    if (sources.length) match.sources = sources;
    if (scheduleOn) {
      match.schedule_window = {
        days,
        start_hhmm: startHHMM,
        end_hhmm: endHHMM,
        // Stamp the local UTC offset so the window is interpreted in the
        // owner's timezone (getTimezoneOffset is minutes BEHIND UTC).
        utc_offset_minutes: -new Date().getTimezoneOffset(),
      };
    }

    const actions: Automation["actions"] = {};
    if (projectId) actions.project_id = projectId;
    if (workflowId) actions.workflow_id = workflowId;
    if (promptId) {
      const p = prompts.find((x) => x.id === promptId);
      actions.prompt_id = promptId;
      if (p) actions.summary_prompt_text = p.text; // inline the runnable text
    }
    if (summaryModelId) actions.summary_model = summaryModelId;
    if (actionsModelId) actions.actions_model = actionsModelId;
    if (sends.length) actions.sends = sends;

    const automation: Automation = {
      tag_id: tagId,
      enabled,
      match,
      ai_classify: {
        enabled: aiEnabled,
        ...(aiHint.trim() ? { hint: aiHint.trim() } : {}),
        ...(aiModel ? { model: aiModel } : {}),
      },
      actions,
    };

    setSaving(true);
    try {
      // Cloud-first (authoritative), then local mirror.
      if (await currentUid()) await cloudUpsertAutomation(automation);
      await upsertAutomation(automation);
      return automation;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the automation.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const saved = await persist();
    if (saved) onSaved();
  };

  const saveAndRun = async () => {
    const saved = await persist();
    if (saved) onRunPast?.(saved);
  };

  const section = "border-t border-border pt-4 mt-4 first:mt-0 first:border-t-0 first:pt-0";
  const label = "block text-xs font-semibold text-muted-foreground mb-1.5";
  const selectCls = "h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm";

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        // Mobile: full-screen sheet. Desktop: centered fixed-width modal.
        IS_MOBILE ? "flex-col" : "items-center justify-center bg-black/40 p-4",
      )}
    >
      <div
        className={cn(
          "flex flex-col bg-background",
          IS_MOBILE
            ? "h-full w-full pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
            : "max-h-[90vh] w-full max-w-2xl rounded-[var(--radius)] border border-border shadow-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-bold">
            {editing ? "Edit automation" : "New automation"}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Tag */}
          <div className={section}>
            <label className={label}>Tag</label>
            {editing ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  background: `${existingTag?.color ?? "#7c6cf5"}22`,
                  color: existingTag?.color ?? "#7c6cf5",
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: existingTag?.color ?? "#7c6cf5" }}
                />
                {existingTag?.name ?? existing?.tag_id}
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={tagChoice}
                  onChange={(e) => setTagChoice(e.target.value)}
                  className={selectCls}
                >
                  {availableTags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  <option value="__new__">+ Create a new tag…</option>
                </select>
                {tagChoice === "__new__" && (
                  <>
                    <input
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      placeholder="Tag name"
                      className="h-8 w-40 rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none"
                    />
                    <input
                      type="color"
                      value={newTagColor}
                      onChange={(e) => setNewTagColor(e.target.value)}
                      className="h-8 w-10 rounded-[var(--radius)] border border-border bg-card"
                      title="Tag color"
                    />
                  </>
                )}
              </div>
            )}
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
          </div>

          {/* When */}
          <div className={section}>
            <p className="mb-2 text-sm font-semibold">When a meeting matches any of…</p>
            <div className="space-y-3">
              <div>
                <label className={label}>Title contains</label>
                <ChipsInput
                  values={titleKeywords}
                  onChange={setTitleKeywords}
                  placeholder="e.g. standup, discovery — Enter to add"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={label}>Attendee emails</label>
                  <ChipsInput
                    values={attendeeEmails}
                    onChange={setAttendeeEmails}
                    placeholder="name@company.com"
                  />
                </div>
                <div>
                  <label className={label}>Attendee names</label>
                  <ChipsInput
                    values={attendeeNames}
                    onChange={setAttendeeNames}
                    placeholder="e.g. Thandi"
                  />
                </div>
              </div>
              <div>
                <label className={label}>Source</label>
                <div className="flex flex-wrap gap-1.5">
                  {SOURCES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleIn(sources, s.id, setSources)}
                      className={
                        "rounded-full border px-2.5 py-1 text-xs " +
                        (sources.includes(s.id)
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted")
                      }
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scheduleOn}
                    onChange={(e) => setScheduleOn(e.target.checked)}
                  />
                  Only within a schedule window
                </label>
                {scheduleOn && (
                  <div className="mt-2 space-y-2 rounded-[var(--radius)] border border-border bg-surface p-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {DAYS.map((d, i) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDay(i)}
                          className={
                            "rounded-full border px-2 py-0.5 text-xs " +
                            (days.includes(i)
                              ? "border-primary bg-primary/15 text-foreground"
                              : "border-border text-muted-foreground hover:bg-muted")
                          }
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-xs text-muted-foreground">From</span>
                      <input
                        type="time"
                        value={startHHMM}
                        onChange={(e) => setStartHHMM(e.target.value)}
                        className={selectCls}
                      />
                      <span className="text-xs text-muted-foreground">to</span>
                      <input
                        type="time"
                        value={endHHMM}
                        onChange={(e) => setEndHHMM(e.target.value)}
                        className={selectCls}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* AI classification */}
          <div className={section}>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
              />
              …or let AI decide
            </label>
            {aiEnabled && (
              <div className="mt-2 space-y-2">
                <textarea
                  value={aiHint}
                  onChange={(e) => setAiHint(e.target.value)}
                  rows={2}
                  placeholder="Describe the meetings this should match, e.g. “sales calls with a prospective customer where pricing is discussed”."
                  className="w-full resize-y rounded-[var(--radius)] border border-border bg-card p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex items-center gap-2">
                  <label className={label + " mb-0"}>Model</label>
                  <select
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    className={selectCls}
                  >
                    <option value="">Default model</option>
                    {MODELS.map((mo) => (
                      <option key={mo.id} value={mo.id}>
                        {modelPickerLabel(mo)}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI classification runs only when the conditions above don't already match.
                </p>
              </div>
            )}
          </div>

          {/* Then */}
          <div className={section}>
            <p className="mb-2 text-sm font-semibold">Then…</p>
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={label}>File into folder</label>
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className={selectCls + " w-full"}
                  >
                    <option value="">— none —</option>
                    {flattenProjectTree(projects).map(({ project: p, depth }) => (
                      <option key={p.id} value={p.id}>
                        {" ".repeat(depth) + p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Run workflow</label>
                  <select
                    value={workflowId}
                    onChange={(e) => setWorkflowId(e.target.value)}
                    className={selectCls + " w-full"}
                  >
                    <option value="">— none —</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={label}>Summary prompt</label>
                  <select
                    value={promptId}
                    onChange={(e) => setPromptId(e.target.value)}
                    className={selectCls + " w-full"}
                  >
                    <option value="">— none —</option>
                    {prompts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Summary model</label>
                  <select
                    value={summaryModelId}
                    onChange={(e) => setSummaryModelId(e.target.value)}
                    className={selectCls + " w-full"}
                  >
                    <option value="">Default model</option>
                    {MODELS.map((mo) => (
                      <option key={mo.id} value={mo.id}>
                        {modelPickerLabel(mo)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Actions model</label>
                  <select
                    value={actionsModelId}
                    onChange={(e) => setActionsModelId(e.target.value)}
                    className={selectCls + " w-full"}
                  >
                    <option value="">Default model</option>
                    {MODELS.map((mo) => (
                      <option key={mo.id} value={mo.id}>
                        {modelPickerLabel(mo)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {promptId && (
                <p className="text-xs text-muted-foreground">
                  The summary is generated only when the meeting doesn't already have one.
                </p>
              )}

              {/* Sends — hosted connectors, official edition only. */}
              <div className={SENDS_AVAILABLE ? undefined : "hidden"}>
                <label className={label}>Send to</label>
                <div className="space-y-2">
                  {sends.map((s, i) => {
                    const dest = DESTINATIONS.find((d) => d.id === s.destination);
                    return (
                      <div
                        key={i}
                        className="rounded-[var(--radius)] border border-border bg-surface p-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={s.destination}
                            onChange={(e) =>
                              updateSend(i, {
                                destination: e.target.value as SendDestination,
                                target: undefined,
                                includeTranscript: undefined,
                              })
                            }
                            className={selectCls}
                          >
                            {DESTINATIONS.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                          <div className="inline-flex overflow-hidden rounded-[var(--radius)] border border-border text-xs">
                            {(["ask", "auto"] as const).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => updateSend(i, { mode })}
                                className={
                                  "px-2.5 py-1 " +
                                  (s.mode === mode
                                    ? "bg-primary text-primary-foreground font-semibold"
                                    : "text-muted-foreground hover:bg-muted")
                                }
                                title={
                                  mode === "ask"
                                    ? "Queue for approval before sending"
                                    : "Send automatically"
                                }
                              >
                                {mode === "ask" ? "Ask first" : "Auto"}
                              </button>
                            ))}
                          </div>
                          <div className="flex-1" />
                          <button
                            type="button"
                            onClick={() => removeSend(i)}
                            className="text-muted-foreground hover:text-danger"
                            aria-label="Remove send"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {s.destination === "atlas_pack" && (
                          <div className="mt-2 space-y-1.5">
                            <p className="text-xs text-muted-foreground">
                              When the meeting is ready (transcript + summary — the summary is
                              generated if missing), sends the title, date, attendees, summary,
                              notes and approved action items to your Atlas account, which
                              proposes drafts, tasks and holds for you to approve there.
                            </p>
                            <label className="flex items-start gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={s.includeTranscript === true}
                                onChange={(e) =>
                                  updateSend(i, {
                                    includeTranscript: e.target.checked || undefined,
                                  })
                                }
                                className="mt-0.5"
                              />
                              <span>
                                Include the full transcript{" "}
                                <span className="text-muted-foreground">
                                  (off by default; very long transcripts are trimmed to the most
                                  recent part)
                                </span>
                              </span>
                            </label>
                          </div>
                        )}
                        {dest?.needsTarget && (
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <input
                              value={s.target?.name ?? ""}
                              onChange={(e) =>
                                updateSend(i, {
                                  target: {
                                    type: dest.needsTarget!,
                                    id: s.target?.id ?? "",
                                    name: e.target.value,
                                  },
                                })
                              }
                              placeholder={`${dest.needsTarget} name`}
                              className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none"
                            />
                            <input
                              value={s.target?.id ?? ""}
                              onChange={(e) =>
                                updateSend(i, {
                                  target: {
                                    type: dest.needsTarget!,
                                    id: e.target.value,
                                    name: s.target?.name ?? "",
                                  },
                                })
                              }
                              placeholder={`${dest.needsTarget} id`}
                              className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <Button variant="outline" size="sm" onClick={addSend}>
                    <Plus className="h-4 w-4" /> Add a send
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-4 rounded-[var(--radius)] border border-danger/30 bg-danger/10 p-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div
          className={cn(
            "flex items-center gap-2 border-t border-border px-5 py-3",
            IS_MOBILE && "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          )}
        >
          {editing && onRunPast && (
            <Button
              variant="outline"
              size="sm"
              onClick={saveAndRun}
              disabled={saving}
              title="Save, then run this automation on your past meetings"
            >
              <History className="h-4 w-4" /> Run on past meetings…
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create automation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
