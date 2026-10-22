import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  type Workflow,
  type WorkflowBlock,
} from "@/lib/lalela";
import type { SendDestination } from "@/lib/tags";
import {
  getPrompts,
  MODELS,
  LOCAL_MODEL_CATALOG,
  localModelOption,
  modelPickerLabel,
} from "@/lib/settings";
import { ArrowDown, ArrowUp, Plus, Send, Trash2 } from "lucide-react";
import { PRODUCT_HQ_LABEL, SENDS_AVAILABLE } from "@/lib/destinations";

interface WorkflowEditorProps {
  /** Called after a successful save (dialogs close; embedded views flash). */
  onSaved?: () => void;
}

const inputClass =
  "w-full rounded-[var(--radius)] border border-border bg-card px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

// Send-block destinations (T8) — the same set the automation editor offers.
const SEND_DESTINATIONS: {
  id: SendDestination;
  label: string;
  needsTarget: "deal" | "product" | null;
}[] = [
  { id: "artemis", label: "Fikelela CRM (deal)", needsTarget: "deal" },
  { id: "artemis_lead_flow", label: "Fikelela CRM (create lead)", needsTarget: null },
  { id: "atlas", label: "Atlas Delivery", needsTarget: null },
  { id: "arete", label: PRODUCT_HQ_LABEL, needsTarget: "product" },
];

function newBlock(): WorkflowBlock {
  return {
    id: `blk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    name: "New block",
    type: "prompt",
    prompt_text: "",
    prompt_ref: null,
    input: "transcript",
    model: null,
  };
}

function newSendBlock(): WorkflowBlock {
  return {
    id: `blk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    name: "Send to CRM",
    type: "send",
    prompt_text: "",
    prompt_ref: null,
    input: "transcript",
    model: null,
    send: { destination: "artemis_lead_flow", mode: "ask" },
  };
}

/** Create/edit the global workflow templates (blocks, prompts, inputs, models).
 * Embeddable — the modal chrome lives in WorkflowEditorDialog. */
export function WorkflowEditor({ onSaved }: WorkflowEditorProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const prompts = useMemo(() => getPrompts(), []);

  const refresh = (selectId?: string) => {
    listWorkflows()
      .then((list) => {
        setWorkflows(list);
        const id = selectId ?? selectedId;
        const found = list.find((w) => w.id === id) ?? list[0] ?? null;
        setSelectedId(found?.id ?? "");
        setDraft(found ? structuredClone(found) : null);
      })
      .catch((e) => setError(String(e)));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => refresh(), []);

  const select = (id: string) => {
    setSelectedId(id);
    const found = workflows.find((w) => w.id === id);
    setDraft(found ? structuredClone(found) : null);
  };

  const createWorkflow = async () => {
    setError(null);
    try {
      const w = await saveWorkflow({
        id: "",
        name: `Workflow ${workflows.length + 1}`,
        blocks: [newBlock()],
        created_at: 0,
      });
      refresh(w.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const persistDraft = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      await saveWorkflow(draft);
      if (onSaved) {
        onSaved();
        return; // dialog host closes — don't touch state after unmount
      }
      refresh(draft.id);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeWorkflow = async () => {
    if (!draft) return;
    setError(null);
    try {
      await deleteWorkflow(draft.id);
      setSelectedId("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const patchBlock = (id: string, patch: Partial<WorkflowBlock>) =>
    setDraft((d) =>
      d ? { ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : d,
    );

  const moveBlock = (index: number, dir: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d;
      const to = index + dir;
      if (to < 0 || to >= d.blocks.length) return d;
      const blocks = [...d.blocks];
      [blocks[index], blocks[to]] = [blocks[to], blocks[index]];
      // A move can put a block above its input; reset any now-invalid inputs.
      const seen = new Set<string>(["transcript"]);
      for (const b of blocks) {
        if (b.input !== "transcript" && !seen.has(b.input)) b.input = "transcript";
        seen.add(b.id);
      }
      return { ...d, blocks };
    });

  const removeBlock = (id: string) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            blocks: d.blocks
              .filter((b) => b.id !== id)
              // Blocks that consumed the removed one fall back to the transcript.
              .map((b) => (b.input === id ? { ...b, input: "transcript" } : b)),
          }
        : d,
    );

  const localOptions = LOCAL_MODEL_CATALOG.map(localModelOption);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={selectedId}
          onChange={(e) => select(e.target.value)}
          className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
        >
          {workflows.length === 0 && <option value="">No workflows</option>}
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" onClick={createWorkflow}>
          <Plus className="h-4 w-4" />
          New workflow
        </Button>
        {draft && (
          <Button variant="ghost" size="sm" onClick={removeWorkflow}>
            <Trash2 className="h-4 w-4" />
            Delete workflow
          </Button>
        )}
      </div>

      {draft && (
        <>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Workflow name
          </label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={inputClass}
          />

          <div className="mt-4 space-y-3">
            {draft.blocks.map((block, i) => {
              const isSend = block.type === "send";
              const dest = SEND_DESTINATIONS.find((d) => d.id === block.send?.destination);
              return (
              <div key={block.id} className="rounded-[var(--radius)] border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">{i + 1}.</span>
                  <input
                    value={block.name}
                    onChange={(e) => patchBlock(block.id, { name: e.target.value })}
                    className="flex-1 bg-transparent text-sm font-semibold outline-none"
                  />
                  {isSend && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                      <Send className="h-3 w-3" /> Send
                    </span>
                  )}
                  <button
                    onClick={() => moveBlock(i, -1)}
                    disabled={i === 0}
                    className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => moveBlock(i, 1)}
                    disabled={i === draft.blocks.length - 1}
                    className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => removeBlock(block.id)}
                    className="rounded p-1 text-muted-foreground hover:text-danger"
                    title="Remove block"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {isSend ? (
                  <div className="mt-2 space-y-2 rounded-[var(--radius)] border border-border bg-surface p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Pushes this meeting&apos;s summary + approved action items to the connected
                      destination. Connect it first in Settings → Connections.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={block.send?.destination ?? "artemis_lead_flow"}
                        onChange={(e) =>
                          patchBlock(block.id, {
                            send: {
                              destination: e.target.value as SendDestination,
                              mode: block.send?.mode ?? "ask",
                            },
                          })
                        }
                        className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
                      >
                        {SEND_DESTINATIONS.map((d) => (
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
                            onClick={() =>
                              patchBlock(block.id, {
                                send: {
                                  destination: block.send?.destination ?? "artemis_lead_flow",
                                  mode,
                                  target: block.send?.target,
                                },
                              })
                            }
                            className={
                              "px-2.5 py-1 " +
                              (block.send?.mode === mode
                                ? "bg-primary text-primary-foreground font-semibold"
                                : "text-muted-foreground hover:bg-muted")
                            }
                            title={mode === "ask" ? "Confirm before sending" : "Send automatically"}
                          >
                            {mode === "ask" ? "Ask first" : "Auto"}
                          </button>
                        ))}
                      </div>
                    </div>
                    {dest?.needsTarget && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input
                          value={block.send?.target?.name ?? ""}
                          onChange={(e) =>
                            patchBlock(block.id, {
                              send: {
                                destination: block.send!.destination,
                                mode: block.send!.mode,
                                target: {
                                  type: dest.needsTarget!,
                                  id: block.send?.target?.id ?? "",
                                  name: e.target.value,
                                },
                              },
                            })
                          }
                          placeholder={`${dest.needsTarget} name`}
                          className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none"
                        />
                        <input
                          value={block.send?.target?.id ?? ""}
                          onChange={(e) =>
                            patchBlock(block.id, {
                              send: {
                                destination: block.send!.destination,
                                mode: block.send!.mode,
                                target: {
                                  type: dest.needsTarget!,
                                  id: e.target.value,
                                  name: block.send?.target?.name ?? "",
                                },
                              },
                            })
                          }
                          placeholder={`${dest.needsTarget} id`}
                          className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                          Input
                        </label>
                        <select
                          value={block.input}
                          onChange={(e) => patchBlock(block.id, { input: e.target.value })}
                          className={inputClass}
                        >
                          <option value="transcript">Transcript</option>
                          {/* Only EARLIER blocks — dependencies always run first. */}
                          {draft.blocks.slice(0, i).map((b) => (
                            <option key={b.id} value={b.id}>
                              Output of “{b.name}”
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                          Model
                        </label>
                        <select
                          value={block.model ?? ""}
                          onChange={(e) => patchBlock(block.id, { model: e.target.value || null })}
                          className={inputClass}
                        >
                          <option value="">Use my current model</option>
                          {localOptions.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                          {MODELS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {modelPickerLabel(m)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="mt-2">
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Prompt
                        </label>
                        <select
                          value=""
                          onChange={(e) => {
                            const p = prompts.find((x) => x.id === e.target.value);
                            if (p) {
                              patchBlock(block.id, { prompt_text: p.text, prompt_ref: p.id });
                            }
                          }}
                          className="h-6 rounded border border-border bg-card px-1 text-[11px] text-muted-foreground"
                        >
                          <option value="">Insert from prompt library…</option>
                          {prompts.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        value={block.prompt_text}
                        onChange={(e) =>
                          patchBlock(block.id, { prompt_text: e.target.value, prompt_ref: null })
                        }
                        rows={3}
                        placeholder="e.g. Extract user stories from this text as Markdown bullets…"
                        className={`${inputClass} resize-y`}
                      />
                    </div>
                  </>
                )}
              </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDraft({ ...draft, blocks: [...draft.blocks, newBlock()] })}
            >
              <Plus className="h-4 w-4" />
              Add block
            </Button>
            {SENDS_AVAILABLE && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft({ ...draft, blocks: [...draft.blocks, newSendBlock()] })}
              >
                <Send className="h-4 w-4" />
                Add send block
              </Button>
            )}
            <div className="flex-1" />
            {savedFlash && <span className="text-sm text-success">Saved</span>}
            <Button size="sm" onClick={persistDraft} disabled={saving || !draft.name.trim()}>
              {saving ? "Saving…" : "Save workflow"}
            </Button>
          </div>
        </>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </div>
  );
}
