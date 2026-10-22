import { noAiHint } from "@/lib/edition";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ReportAiButton } from "@/components/ReportAiContent";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { WorkflowEditorDialog } from "@/components/WorkflowEditorDialog";
import {
  listWorkflows,
  getWorkflowOutputs,
  setWorkflowOutput,
  transcriptToText,
  formatDate,
  type FullMeeting,
  type Workflow,
  type WorkflowBlock,
} from "@/lib/lalela";
import { getModel, isAppleModelId, isLocalModelId } from "@/lib/settings";
import { aiGenerate, NoAiError } from "@/lib/ai";
import { clearBgTask, startBgTask, useBgTask } from "@/lib/bgTask";
import { executeSend, sendResultMessage } from "@/lib/automations";
import { isSendBlock, runWorkflow, WorkflowBlockError } from "@/lib/runWorkflow";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Pencil,
  Play,
  Send,
  Workflow as WorkflowIcon,
} from "lucide-react";
// Send-block destination labels (T8) — for badges + the confirm prompt.
import { DESTINATION_LABEL } from "@/lib/destinations";

interface WorkflowPanelProps {
  meeting: FullMeeting;
}

/** Runs prompt pipelines against a meeting: each block feeds on the transcript
 * or an earlier block's output; outputs persist per meeting (and are written
 * to the meeting's workflows.md). */
export function WorkflowPanel({ meeting }: WorkflowPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [outputs, setOutputs] = useState<Map<string, { output: string; updated_at: number }>>(
    new Map(),
  );
  const [runningBlock, setRunningBlock] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [blockErrors, setBlockErrors] = useState<Map<string, string>>(new Map());
  const [showEditor, setShowEditor] = useState(false);
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ blockId: string; text: string } | null>(null);
  // Ask-mode send approval, via the app's ConfirmDialog. window.confirm silently
  // returns false in Tauri's WKWebView (see ConfirmDialog.tsx), so it could
  // never approve a send; the modal resolves this promise when the user chooses.
  const [confirmSendBody, setConfirmSendBody] = useState<string | null>(null);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);

  // If the panel unmounts while a send confirmation is open (e.g. a tab switch
  // mid-run), release the pending promise so the detached run doesn't hang.
  useEffect(
    () => () => {
      confirmResolveRef.current?.(false);
      confirmResolveRef.current = null;
    },
    [],
  );

  const workflow = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  // Runs are detached (T4) keyed by meeting+workflow: this panel is a tab that
  // unmounts on every tab switch, so a run kept only in local state would drop
  // its "running" indicator and never refresh its output if the user clicked
  // away mid-run. Block outputs already persist via setWorkflowOutput; the
  // store just keeps the run observable so a returning tab shows it's still
  // going and reloads the outputs when it lands.
  const runKey = `wf:${meeting.id}:${workflow?.id ?? "none"}`;
  const task = useBgTask(runKey);

  const refreshWorkflows = useCallback(() => {
    listWorkflows()
      .then((list) => {
        setWorkflows(list);
        setSelectedId((prev) => (list.some((w) => w.id === prev) ? prev : (list[0]?.id ?? "")));
      })
      .catch(() => setWorkflows([]));
  }, []);

  useEffect(refreshWorkflows, [refreshWorkflows]);

  // Load persisted outputs whenever the selected workflow changes.
  useEffect(() => {
    if (!workflow) {
      setOutputs(new Map());
      return;
    }
    let cancelled = false;
    getWorkflowOutputs(meeting.id, workflow.id)
      .then((list) => {
        if (cancelled) return;
        setOutputs(
          new Map(list.map((o) => [o.block_id, { output: o.output, updated_at: o.updated_at }])),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meeting.id, workflow]);

  const blockName = (id: string) =>
    workflow?.blocks.find((b) => b.id === id)?.name ?? "earlier block";

  /** The text a block runs on — transcript or a previous block's output. */
  const resolveInput = (block: WorkflowBlock, live: Map<string, { output: string }>) => {
    if (block.input === "transcript") return transcriptToText(meeting.segments);
    const dep = live.get(block.input);
    if (!dep?.output) {
      throw new Error(`Run “${blockName(block.input)}” first — this block uses its output.`);
    }
    return dep.output;
  };

  /** Ask before an "ask"-mode send; "auto" sends run straight away (T8).
   * Resolves via the ConfirmDialog modal below (never window.confirm). */
  const askConfirmSend = (block: WorkflowBlock): Promise<boolean> => {
    const send = block.send!;
    if (send.mode !== "ask") return Promise.resolve(true);
    const dest = DESTINATION_LABEL[send.destination] ?? send.destination;
    return new Promise<boolean>((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmSendBody(
        `Send this meeting to ${dest}${send.target?.name ? ` → ${send.target.name}` : ""}?`,
      );
    });
  };

  const resolveConfirmSend = (ok: boolean) => {
    setConfirmSendBody(null);
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    resolve?.(ok);
  };

  const runBlock = async (
    block: WorkflowBlock,
    live: Map<string, { output: string; updated_at: number }>,
  ) => {
    if (!workflow) throw new Error("no workflow selected");
    // Send blocks push the meeting to a connected MCP destination through the
    // SAME hosted push routes as automation sends (executeSend) — never
    // reinvented. Ask-mode confirms first; the transcript never leaves.
    if (isSendBlock(block)) {
      const label = DESTINATION_LABEL[block.send!.destination] ?? block.send!.destination;
      let result: string;
      if (!(await askConfirmSend(block))) {
        result = "Not sent — you declined.";
      } else {
        const res = await executeSend(meeting.id, block.send!, { interactive: true });
        result = sendResultMessage(label, res);
      }
      await setWorkflowOutput(meeting.id, workflow.id, block.id, result);
      return result;
    }
    const model = block.model ?? getModel();
    const input = resolveInput(block, live);
    let result: string;
    try {
      result = await aiGenerate(input, block.prompt_text, model, { interactive: true });
    } catch (e) {
      if (e instanceof NoAiError) {
        throw new Error(
          noAiHint("Sign in for free monthly AI, add your own key in Settings, or pick a local model."),
        );
      }
      throw e;
    }
    await setWorkflowOutput(meeting.id, workflow.id, block.id, result);
    return result;
  };

  const handleRunBlock = (block: WorkflowBlock) => {
    void startBgTask(runKey, {
      run: async () => {
        setBlockErrors(new Map());
        setRunningBlock(block.id);
        try {
          const result = await runBlock(block, outputs);
          setOutputs((prev) =>
            new Map(prev).set(block.id, { output: result, updated_at: Date.now() }),
          );
        } catch (e) {
          setBlockErrors(new Map([[block.id, e instanceof Error ? e.message : String(e)]]));
        } finally {
          setRunningBlock(null);
        }
      },
    });
  };

  const handleRunAll = () => {
    if (!workflow) return;
    const wf = workflow;
    void startBgTask(runKey, {
      run: async () => {
        setBlockErrors(new Map());
        setRunningAll(true);
        try {
          // Shared runner (lib/runWorkflow) — the SAME path the chat "/" picker
          // (SlashPicker) uses; here it streams progress into the panel and
          // confirms ask-mode send blocks before they fire (T8). Blocks run
          // top-to-bottom; the editor only allows earlier blocks as inputs, so
          // this order always satisfies dependencies.
          await runWorkflow({
            workflow: wf,
            transcriptText: transcriptToText(meeting.segments),
            meetingId: meeting.id,
            generate: async (u, s, m) => {
              try {
                return await aiGenerate(u, s, m ?? getModel(), { interactive: true });
              } catch (e) {
                if (e instanceof NoAiError) {
                  throw new Error(
                    noAiHint("Sign in for free monthly AI, add your own key in Settings, or pick a local model."),
                  );
                }
                throw e;
              }
            },
            executeSend: async (send) => {
              const label = DESTINATION_LABEL[send.destination] ?? send.destination;
              const res = await executeSend(meeting.id, send, { interactive: true });
              return sendResultMessage(label, res);
            },
            confirmSend: (block) => askConfirmSend(block),
            onBlockStart: (blockId) => setRunningBlock(blockId),
            onBlock: (blockId, result) =>
              setOutputs((prev) =>
                new Map(prev).set(blockId, { output: result, updated_at: Date.now() }),
              ),
          });
        } catch (e) {
          if (e instanceof WorkflowBlockError) {
            setBlockErrors(new Map([[e.blockId, e.message]]));
          }
        }
        setRunningBlock(null);
        setRunningAll(false);
      },
    });
  };

  // Re-attach to a detached run: when it lands, reload the persisted outputs so
  // a tab that returned mid-run (its own setState was lost while unmounted)
  // shows the results without a manual re-run.
  useEffect(() => {
    if (!workflow) return;
    if (task.status === "done" || task.status === "error") {
      getWorkflowOutputs(meeting.id, workflow.id)
        .then((list) =>
          setOutputs(
            new Map(list.map((o) => [o.block_id, { output: o.output, updated_at: o.updated_at }])),
          ),
        )
        .catch(() => {});
      clearBgTask(runKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.status]);

  const copyOutput = async (blockId: string) => {
    const text = outputs.get(blockId)?.output ?? "";
    await navigator.clipboard.writeText(text);
    setCopiedBlock(blockId);
    setTimeout(() => setCopiedBlock(null), 1500);
  };

  const toggleCollapsed = (blockId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });

  const saveEditedOutput = async () => {
    if (!editing || !workflow) return;
    try {
      await setWorkflowOutput(meeting.id, workflow.id, editing.blockId, editing.text);
      setOutputs((prev) =>
        new Map(prev).set(editing.blockId, { output: editing.text, updated_at: Date.now() }),
      );
      setEditing(null);
    } catch (e) {
      setBlockErrors(new Map([[editing.blockId, e instanceof Error ? e.message : String(e)]]));
    }
  };

  // Includes the detached-run status so a tab that remounts mid-run (its local
  // runningAll/runningBlock reset to idle) still reads as busy.
  const busy = runningAll || runningBlock !== null || task.status === "running";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-3">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
          title="Workflow"
        >
          {workflows.length === 0 && <option value="">No workflows yet</option>}
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={handleRunAll}
          disabled={busy || !workflow || workflow.blocks.length === 0 || meeting.segments.length === 0}
        >
          {runningAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run all
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowEditor(true)}>
          <Pencil className="h-4 w-4" />
          Edit workflows
        </Button>
        {/* Visible on a tab that returned mid-run, where the per-block spinners
            (local state) have reset but the detached run is still going. */}
        {task.status === "running" && runningBlock === null && !runningAll && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Running…
          </span>
        )}
      </div>

      <div className="space-y-3 px-5 py-4">
        {!workflow || workflow.blocks.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <WorkflowIcon className="mx-auto mb-2 h-5 w-5" />
            {workflows.length === 0
              ? "Build a workflow: chained prompt blocks that turn a transcript into user stories, feature lists, follow-up emails — whatever you need."
              : "This workflow has no blocks yet."}
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => setShowEditor(true)}>
                {workflows.length === 0 ? "Create your first workflow" : "Add blocks"}
              </Button>
            </div>
          </div>
        ) : (
          workflow.blocks.map((block, i) => {
            const out = outputs.get(block.id);
            const error = blockErrors.get(block.id);
            const isRunning = runningBlock === block.id;
            const isCollapsed = collapsed.has(block.id);
            // The vertical arrow means "flows from the block above" — only
            // draw it when this block actually consumes the previous block's
            // output. Everything else gets a labelled source chip instead.
            const chainedFromPrev = i > 0 && block.input === workflow.blocks[i - 1].id;
            return (
              <div key={block.id}>
                {i > 0 &&
                  (chainedFromPrev ? (
                    <div className="mb-3 flex justify-center text-muted-foreground">
                      <ArrowDown className="h-4 w-4" />
                    </div>
                  ) : (
                    <div className="mb-3 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      {block.input === "transcript"
                        ? "from Transcript"
                        : `from “${blockName(block.input)}”`}
                      <ArrowDown className="h-3 w-3" />
                    </div>
                  ))}
                <div className="rounded-[var(--radius)] border border-border bg-card">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                    <button
                      onClick={() => toggleCollapsed(block.id)}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                      title={isCollapsed ? "Expand" : "Collapse"}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                    <span className="text-sm font-semibold">
                      {i + 1}. {block.name}
                    </span>
                    {isSendBlock(block) ? (
                      <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                        <Send className="h-3 w-3" />
                        {DESTINATION_LABEL[block.send!.destination] ?? block.send!.destination}
                        {block.send!.target?.name ? ` → ${block.send!.target.name}` : ""}
                        <span className="opacity-70">
                          · {block.send!.mode === "auto" ? "Auto" : "Ask first"}
                        </span>
                      </span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          <FileText className="h-3 w-3" />
                          {block.input === "transcript" ? "Transcript" : `← ${blockName(block.input)}`}
                        </span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {block.model
                            ? isAppleModelId(block.model)
                              ? "Apple Intelligence"
                              : isLocalModelId(block.model)
                                ? "Local model"
                                : block.model.split("/").pop()
                            : "Default model"}
                        </span>
                      </>
                    )}
                    <div className="flex-1" />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRunBlock(block)}
                      disabled={busy || (!isSendBlock(block) && meeting.segments.length === 0)}
                    >
                      {isRunning ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : isSendBlock(block) ? (
                        <Send className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      {isSendBlock(block) ? "Send" : "Run"}
                    </Button>
                  </div>
                  {!isCollapsed && (
                    <>
                      <p className="line-clamp-2 px-3 pt-2 text-xs text-muted-foreground">
                        {isSendBlock(block)
                          ? "Pushes this meeting's summary + approved action items to the connected destination."
                          : block.prompt_text}
                      </p>
                      <div className="px-3 pb-3 pt-2">
                        {error ? (
                          <div className="rounded-[var(--radius)] border border-danger/30 bg-danger/10 p-2 text-sm text-danger">
                            {error}
                          </div>
                        ) : editing?.blockId === block.id ? (
                          <div className="rounded-[var(--radius)] border border-border bg-surface p-3">
                            <textarea
                              value={editing.text}
                              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                              rows={10}
                              autoFocus
                              className="w-full resize-y rounded-[var(--radius)] border border-border bg-card p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                            />
                            <div className="mt-2 flex justify-end gap-2">
                              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                              <Button size="sm" onClick={saveEditedOutput}>
                                Save output
                              </Button>
                            </div>
                          </div>
                        ) : out?.output ? (
                          <div className="rounded-[var(--radius)] border border-border bg-surface p-3">
                            <div className="md text-sm">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {out.output}
                              </ReactMarkdown>
                            </div>
                            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                              Updated {formatDate(out.updated_at)}
                              <button
                                onClick={() => copyOutput(block.id)}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                              >
                                {copiedBlock === block.id ? (
                                  <Check className="h-3 w-3" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                                Copy
                              </button>
                              <button
                                onClick={() =>
                                  setEditing({ blockId: block.id, text: out.output })
                                }
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                                Edit
                              </button>
                              <ReportAiButton
                                size="xs"
                                surface="workflow"
                                output={out.output}
                                className="text-xs"
                              />
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No output yet.</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {showEditor && (
        <WorkflowEditorDialog
          onClose={() => {
            setShowEditor(false);
            refreshWorkflows();
          }}
        />
      )}

      {confirmSendBody && (
        <ConfirmDialog
          title="Send this meeting?"
          body={confirmSendBody}
          confirmLabel="Send"
          onConfirm={() => resolveConfirmSend(true)}
          onClose={() => resolveConfirmSend(false)}
        />
      )}
    </div>
  );
}
