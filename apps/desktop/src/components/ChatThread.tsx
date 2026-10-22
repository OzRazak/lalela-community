import { noAiHint } from "@/lib/edition";
import { trackEvent } from "@/lib/analytics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CitedMarkdown } from "@/components/CitedMarkdown";
import { ReportAiButton } from "@/components/ReportAiContent";
import { Button } from "@/components/ui/Button";
import { SlashPicker, type SlashEntry, type SlashPickerHandle } from "@/components/SlashPicker";
import { aiChatWithConnections, aiGenerate, type ChatCitation } from "@/lib/ai";
import {
  chatModel,
  isAppleModelId,
  isLocalModelId,
  setChatModel,
  getResponseLength,
  setResponseLength,
  modelPickerLabel,
  type Prompt,
  type ResponseLength,
} from "@/lib/settings";
import { fetchChatConnections } from "@/lib/connections";
import { useModelPicker } from "@/lib/useModels";
import { LengthSelect } from "@/components/LengthSelect";
import { clearBgTask, startBgTask, useBgTask } from "@/lib/bgTask";
import { executeSend } from "@/lib/automations";
import { isSendBlock, runWorkflow, WorkflowBlockError } from "@/lib/runWorkflow";
import { IS_MOBILE, chord } from "@/lib/platform";
import {
  listChatThreads,
  createChatThread,
  listChatMessages,
  appendChatMessage,
  deleteChatThread,
  transcriptToText,
  type ChatScope,
  type ChatThreadRow,
  type FullMeeting,
  type Workflow,
} from "@/lib/lalela";
import {
  MessagesSquare,
  Send,
  Slash,
  Loader2,
  AlertTriangle,
  History,
  Plug,
  Plus,
  Trash2,
} from "lucide-react";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** A one-line "Connections used:" footer appended to an answer (T7). */
function citationsFooter(citations: ChatCitation[]): string {
  if (!citations.length) return "";
  const byConn = new Map<string, Set<string>>();
  for (const c of citations) {
    if (!byConn.has(c.connectionName)) byConn.set(c.connectionName, new Set());
    byConn.get(c.connectionName)!.add(c.tool);
  }
  const parts = [...byConn.entries()].map(
    ([name, tools]) => `**${name}** (${[...tools].join(", ")})`,
  );
  return `\n\n---\n*Connections used: ${parts.join(" · ")}*`;
}

// A chat send runs as a detached background task (T4) keyed by scope, so an
// answer whose pane unmounted mid-generation still lands in the right thread and
// is shown on return — instead of being stranded in an unopened History thread.
// One in-flight run per scope (the store dedupes), matching the one-at-a-time
// send the busy flag already enforced.
type ChatRunMeta = { question: string; threadId: string | null };
type ChatRunResult = { answer: string; threadId: string | null };

function chatRunKey(scope: ChatScope, scopeId?: string): string {
  return `chat:${scope}:${scopeId ?? ""}`;
}

/** Persist a Q/A exchange to its thread (creating the thread on the first
 * message), detached from component state so it runs even if the pane unmounted
 * mid-generation. Returns the thread id (or the input id on failure). */
async function persistChatExchange(
  scope: ChatScope,
  scopeId: string | null,
  threadId: string | null,
  question: string,
  answer: string,
): Promise<string | null> {
  try {
    let tid = threadId;
    if (!tid) {
      const t = await createChatThread(scope, scopeId, question.replace(/\s+/g, " ").slice(0, 60));
      tid = t.id;
    }
    await appendChatMessage(tid, "user", question);
    await appendChatMessage(tid, "assistant", answer);
    return tid;
  } catch {
    return threadId;
  }
}

interface ChatThreadProps {
  /** Builds the grounded context block for a question (scoped by the host:
   * all meetings, one folder, or one meeting). Optional only when `getContext`
   * (which overrides it) is supplied — e.g. the ephemeral live-catchup host. */
  buildContext?: (question: string) => Promise<string>;
  /** Overrides `buildContext` for hosts that assemble their own grounding — the
   * live recorder passes the in-progress transcript (Wave A4). Read at ask time,
   * so a live host can close over a ref and always see the CURRENT transcript. */
  getContext?: (question: string) => Promise<string>;
  systemPrompt: string;
  placeholder: string;
  busyLabel: string;
  emptyHint: ReactNode;
  /** Which chat surface this is — keys the persisted thread history. */
  scope: ChatScope;
  /** The folder/meeting id for folder/meeting scopes; omit for global. */
  scopeId?: string;
  /** Meeting scope only: the full meeting, so the "/" picker can run Workflows
   * against it (they're meeting-shaped — folder/global chat gets Prompts only). */
  meeting?: FullMeeting;
  onOpenSettings?: () => void;
  /** Tight paddings for side-pane hosts. */
  compact?: boolean;
  /** Makes [m:ss] citations in answers clickable (meeting-scoped chat). */
  onSeek?: (ms: number) => void;
  /** Ephemeral mode (Wave A4 live catch-up): pure in-memory exchanges — no
   * thread persistence, no History UI, no thread-list loading. Uses a simple
   * local run path instead of the detached bg-task store (whose per-scope key
   * would otherwise collide with the eventual saved-meeting chat thread). */
  ephemeral?: boolean;
  /** Quick-action chips rendered above the input (e.g. "What did I miss?"): the
   * label becomes the user bubble, the instruction is sent as the question. */
  quickActions?: { label: string; instruction: string }[];
  /** Called after each completed exchange — the live host collects these to
   * replay them into the saved meeting's chat thread on finish (Wave A4). */
  onExchange?: (question: string, answer: string) => void;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/** A grounded Q&A thread (messages + input). The host decides the scope via
 * buildContext; every exchange is auto-saved to a per-scope thread history.
 * Opens on a fresh chat — past threads are one click away under History. */
export function ChatThread({
  buildContext,
  getContext,
  systemPrompt,
  placeholder,
  busyLabel,
  emptyHint,
  scope,
  scopeId,
  meeting,
  onOpenSettings,
  compact = false,
  onSeek,
  ephemeral = false,
  quickActions,
  onExchange,
}: ChatThreadProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  // "/" launcher state: open whenever the input starts with "/" (unless the
  // user dismissed it with Esc). The picker keeps focus in the textarea and is
  // driven via `pickerRef` from the textarea's keydown.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const pickerRef = useRef<SlashPickerHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThreadRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // The in-flight send lives in a module-level store keyed by scope, so it keeps
  // running (and stays re-attachable) if the user navigates away mid-answer.
  // Ephemeral (live catch-up) hosts skip that store entirely and run locally.
  const runKey = chatRunKey(scope, scopeId);
  const task = useBgTask<ChatRunResult, ChatRunMeta>(runKey);
  const [localBusy, setLocalBusy] = useState(false);
  const busy = ephemeral ? localBusy : task.status === "running";
  // Chat model picker (T3): defaults to the user's global default (local
  // included), persisted across chats via the `chatModel` setting.
  const { model, setModel, models } = useModelPicker(chatModel);
  const [length, setLength] = useState<ResponseLength>(getResponseLength);
  // "Use my connections" (T7) — default OFF so pure-local privacy is unchanged.
  // Connections need a cloud model (tool-calling) + being signed in; the toggle
  // is only offered when the user has connected a chat-capable MCP server.
  const [useConnections, setUseConnections] = useState(false);
  const [connections, setConnections] = useState<{ id: string; label: string }[]>([]);
  // On-device models (local sidecar or Apple Intelligence) can't call MCP
  // tools, so the connections toggle is disabled for both.
  const localModel = isLocalModelId(model) || isAppleModelId(model);

  useEffect(() => {
    fetchChatConnections().then(setConnections).catch(() => {});
  }, []);

  // Load this scope's history. New-chat-by-default: past threads are listed
  // but the pane always opens empty. Cancelled-flag guards fast scope
  // switches (the folder pane remounts via a React key). Ephemeral hosts have
  // no persisted history, so this is skipped there.
  useEffect(() => {
    if (ephemeral) return;
    let cancelled = false;
    listChatThreads(scope, scopeId ?? null)
      .then((list) => !cancelled && setThreads(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scope, scopeId, ephemeral]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, busy]);

  const openThread = async (id: string) => {
    setHistoryOpen(false);
    try {
      const rows = await listChatMessages(id);
      setThreadId(id);
      setMessages(rows.map((r) => ({ role: r.role, content: r.content })));
      setError(null);
    } catch {
      /* thread vanished — refresh the list */
      listChatThreads(scope, scopeId ?? null).then(setThreads).catch(() => {});
    }
  };

  const newChat = () => {
    setHistoryOpen(false);
    setThreadId(null);
    setMessages([]);
    setError(null);
  };

  const removeThread = async (id: string) => {
    try {
      await deleteChatThread(id);
    } catch {
      /* best-effort */
    }
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (threadId === id) newChat();
  };

  // Meeting-scoped chat (desktop) can also run Workflows from "/"; folder/global
  // chat and mobile get Prompts only (workflows are meeting-shaped + a
  // desktop-only tab).
  const allowWorkflows = scope === "meeting" && !!meeting && !IS_MOBILE;
  const slashOpen = input.startsWith("/") && !slashDismissed && !busy;
  const slashQuery = input.startsWith("/") ? input.slice(1) : "";

  const onInputChange = (v: string) => {
    setInput(v);
    // Leaving "/" mode re-arms the picker so the next "/" opens it again.
    if (!v.startsWith("/")) setSlashDismissed(false);
  };
  const closeSlash = () => setSlashDismissed(true);
  const openSlash = () => {
    setSlashDismissed(false);
    setInput((cur) => (cur.startsWith("/") ? cur : "/"));
    inputRef.current?.focus();
  };

  /** Assemble the grounded prompt and generate — identical for a typed message
   * and a "/"-run Prompt (only the instruction text differs). */
  const generateAnswer = async (
    instruction: string,
    priorHistory: ChatMsg[],
    runModel: string,
    runLength: ResponseLength,
    withConnections: boolean,
    connectionIds: string[],
  ): Promise<string> => {
    // getContext (live catch-up) overrides the scope's buildContext when present.
    const assemble = getContext ?? buildContext;
    const context = assemble ? await assemble(instruction) : "";
    const history = priorHistory
      .map((h) => `${h.role === "user" ? "User" : "Lalela"}: ${h.content}`)
      .join("\n");
    const userContent =
      `MEETING CONTEXT:\n${context || "(no meetings found)"}\n\n` +
      (history ? `CONVERSATION SO FAR:\n${history}\n\n` : "") +
      `QUESTION: ${instruction}`;
    // Connections on + a cloud model → the hosted tool-use loop (/api/chat)
    // may call the user's connected MCP servers' read-only tools; otherwise
    // the normal front door (local sidecar / BYOK / free proxy).
    if (withConnections) {
      const { content, citations } = await aiChatWithConnections(
        userContent,
        systemPrompt,
        runModel,
        connectionIds,
      );
      return content + citationsFooter(citations);
    }
    // Length applies to the plain front-door path; the connections tool-use
    // loop manages its own budget across iterations.
    return await aiGenerate(userContent, systemPrompt, runModel, { length: runLength, interactive: true });
  };

  /** One chat exchange as a detached bg task: shows the `display` user bubble,
   * runs `execute` for the answer, persists both. The run must not depend on
   * this pane staying mounted, so it completes + persists after navigation. */
  const runExchange = (display: string, execute: () => Promise<string>) => {
    if (busy) return;
    setError(null);
    setMessages((m) => [...m, { role: "user", content: display }]);
    // Ephemeral (live catch-up): run locally — no persistence, no bg-task store.
    // The store keys by scope, and once the recording is saved a real
    // scope:"meeting" chat opens; a detached run under the same key would
    // collide, so an in-memory run is both simpler and safer here. Completed
    // exchanges are handed to onExchange for replay into the saved meeting.
    if (ephemeral) {
      setLocalBusy(true);
      void (async () => {
        try {
          const answer = await execute();
          setMessages((m) => [...m, { role: "assistant", content: answer }]);
          onExchange?.(display, answer);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "no-ai") {
            setError("no-key");
            // Give the question back rather than stranding an unanswered bubble.
            setMessages((m) =>
              m[m.length - 1]?.role === "user" && m[m.length - 1]?.content === display
                ? m.slice(0, -1)
                : m,
            );
          } else {
            setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${msg}` }]);
          }
        } finally {
          setLocalBusy(false);
        }
      })();
      return;
    }
    const startThreadId = threadId;
    void startBgTask<ChatRunResult, ChatRunMeta>(runKey, {
      meta: { question: display, threadId: startThreadId },
      run: async () => {
        const answer = await execute();
        // Persist immediately so a completion whose pane unmounted still lands
        // in the thread (adopted by the reattach effect / visible in History).
        const tid = await persistChatExchange(
          scope,
          scopeId ?? null,
          startThreadId,
          display,
          answer,
        );
        return { answer, threadId: tid };
      },
    });
  };

  const send = () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    // Snapshot everything the run needs NOW so it survives an unmount.
    const priorHistory = messages.slice(-4);
    const runModel = model;
    const runLength = length;
    const withConnections = useConnections && !localModel && connections.length > 0;
    const connectionIds = connections.map((c) => c.id);
    // Analytics: that a message was sent — never the question or answer.
    trackEvent("chat_message_sent", { with_connections: withConnections });
    runExchange(question, () =>
      generateAnswer(question, priorHistory, runModel, runLength, withConnections, connectionIds),
    );
  };

  /** Run a saved Prompt from "/": its template text becomes the instruction,
   * grounding/context assembly stays identical to a typed message, and the user
   * bubble reads /<name>. */
  const runPrompt = (p: Prompt) => {
    const priorHistory = messages.slice(-4);
    const runModel = model;
    const runLength = length;
    const withConnections = useConnections && !localModel && connections.length > 0;
    const connectionIds = connections.map((c) => c.id);
    runExchange(`/${p.name}`, () =>
      generateAnswer(p.text, priorHistory, runModel, runLength, withConnections, connectionIds),
    );
  };

  /** Run a Workflow from "/" (meeting scope): the SAME execution path the
   * Workflows tab uses (shared runWorkflow → outputs persist per meeting), then
   * post a short exchange linking to the Workflows tab. */
  const runWorkflowFromChat = (w: Workflow) => {
    if (!meeting) return;
    const m = meeting;
    const runModel = model;
    // Ask-mode send blocks need an interactive approval the quick chat surface
    // can't host — and `window.confirm` silently returns false in Tauri's
    // WKWebView (see ConfirmDialog.tsx), so passing it could NEVER approve a
    // send: it just made chat-run workflows look dead. So chat runs prompt
    // blocks + auto-mode sends and SKIPS ask-mode sends (no `confirmSend` →
    // runWorkflow skips them, without blocking the rest); the user approves
    // those from the Workflows tab.
    const hasAskSend = w.blocks.some((b) => isSendBlock(b) && b.send?.mode === "ask");
    runExchange(`/${w.name}`, async () => {
      try {
        await runWorkflow({
          workflow: w,
          transcriptText: transcriptToText(m.segments),
          meetingId: m.id,
          generate: (u, s, mdl) => aiGenerate(u, s, mdl ?? runModel, { interactive: true }),
          executeSend: async (send) => {
            await executeSend(m.id, send, { interactive: true });
            return "Sent.";
          },
        });
        return (
          `Ran workflow **${w.name}** — see the **Workflows** tab for the full output.` +
          (hasAskSend
            ? "\n\nSends that ask for approval were skipped — open the **Workflows** tab to approve them."
            : "")
        );
      } catch (e) {
        const msg =
          e instanceof WorkflowBlockError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
        if (msg === "no-ai") {
          return noAiHint("To run this workflow: sign in for free monthly AI, add your own key, or pick a local model in Settings.");
        }
        return `⚠️ Couldn't finish workflow **${w.name}**: ${msg}`;
      }
    });
  };

  const runEntry = (entry: SlashEntry) => {
    setInput("");
    setSlashDismissed(true);
    if (entry.kind === "prompt") runPrompt(entry.prompt);
    else runWorkflowFromChat(entry.workflow);
  };

  /** Run a quick-action chip (e.g. "What did I miss?"): the chip label is the
   * user bubble, its instruction is sent as the question (grounding is identical
   * to a typed message). */
  const runQuickAction = (action: { label: string; instruction: string }) => {
    const priorHistory = messages.slice(-4);
    const runModel = model;
    const runLength = length;
    const withConnections = useConnections && !localModel && connections.length > 0;
    const connectionIds = connections.map((c) => c.id);
    runExchange(action.label, () =>
      generateAnswer(
        action.instruction,
        priorHistory,
        runModel,
        runLength,
        withConnections,
        connectionIds,
      ),
    );
  };

  // Re-attach to this scope's chat run — one that finished while the pane was
  // elsewhere, or one still in flight — so the answer shows on return (not
  // stranded in an unopened History thread) and an in-flight run reads as
  // pending rather than a blank pane.
  useEffect(() => {
    // Ephemeral hosts never touch the bg-task store — their runs are local.
    if (ephemeral) return;
    if (task.status === "running") {
      const q = task.meta?.question;
      if (q) {
        // send() already showed the question on the original mount; on a
        // remount `messages` is empty, so surface it. Guard against duplicates.
        setMessages((m) =>
          m.some((x) => x.role === "user" && x.content === q)
            ? m
            : m.length === 0
              ? [{ role: "user", content: q }]
              : m,
        );
      }
      if (task.meta?.threadId && !threadId) setThreadId(task.meta.threadId);
    } else if (task.status === "done" && task.result) {
      const { answer, threadId: tid } = task.result;
      const q = task.meta?.question;
      setMessages((m) => {
        if (m.length && m[m.length - 1].role === "assistant" && m[m.length - 1].content === answer) {
          return m; // already shown (common mounted case)
        }
        const base =
          q && !m.some((x) => x.role === "user" && x.content === q)
            ? [...m, { role: "user" as const, content: q }]
            : m;
        return [...base, { role: "assistant" as const, content: answer }];
      });
      if (tid) {
        setThreadId(tid);
        // Refresh History so the (possibly new) thread is listed.
        listChatThreads(scope, scopeId ?? null).then(setThreads).catch(() => {});
      }
      clearBgTask(runKey);
    } else if (task.status === "error") {
      const q = task.meta?.question;
      if (task.error === "no-ai") {
        setError("no-key");
        setMessages((m) =>
          q && m[m.length - 1]?.role === "user" && m[m.length - 1]?.content === q
            ? m.slice(0, -1) // give the question back
            : m,
        );
        if (q) setInput((cur) => cur || q);
      } else {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `⚠️ ${task.error ?? "Something went wrong"}` },
        ]);
      }
      clearBgTask(runKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.status]);

  // History/New-chat controls only exist for persisted scopes — ephemeral
  // (live catch-up) has no thread history to show.
  const showHeader = !ephemeral && (threads.length > 0 || messages.length > 0);

  const modelSelect = (
    <div className="flex items-center gap-2">
      {connections.length > 0 && (
        <label
          className={
            "flex items-center gap-1 text-[11px] " +
            (localModel
              ? "cursor-not-allowed text-muted-foreground/60"
              : "text-muted-foreground")
          }
          title={
            localModel
              ? "Connections need a cloud model (local models can't call tools)."
              : `Let the model consult ${connections.map((c) => c.label).join(", ")} (read-only) to enrich answers.`
          }
        >
          <input
            type="checkbox"
            checked={useConnections && !localModel}
            disabled={localModel}
            onChange={(e) => setUseConnections(e.target.checked)}
            className="accent-primary"
          />
          <Plug className="h-3 w-3" />
          Connections
        </label>
      )}
      <select
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
          setChatModel(e.target.value); // remembered across chats
        }}
        className="h-7 max-w-[10rem] rounded-[var(--radius)] border border-border bg-card px-1.5 text-xs"
        title="AI model for this chat"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelPickerLabel(m)}
          </option>
        ))}
      </select>
      <LengthSelect
        value={length}
        onChange={(v) => {
          setLength(v);
          setResponseLength(v); // remembered across chats
        }}
        className="h-7 rounded-[var(--radius)] border border-border bg-card px-1.5 text-xs"
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={
          compact
            ? "relative flex items-center justify-between gap-2 border-b border-border px-2 py-1"
            : "relative flex items-center justify-between gap-2 border-b border-border px-3 py-1.5"
        }
      >
        <div className="flex items-center gap-1">
          {showHeader && (
            <>
              <button
                onClick={() => setHistoryOpen((v) => !v)}
                disabled={threads.length === 0}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-40"
                title="Past chats"
              >
                <History className="h-3.5 w-3.5" />
                History
                {threads.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px]">
                    {threads.length}
                  </span>
                )}
              </button>
              <button
                onClick={newChat}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                title="Start a new chat (this one stays in History)"
              >
                <Plus className="h-3.5 w-3.5" />
                New chat
              </button>
            </>
          )}
        </div>
        {modelSelect}

        {historyOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setHistoryOpen(false)} />
              <div className="absolute left-2 top-full z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-[var(--radius)] border border-border bg-card p-1 shadow-lg">
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={
                      "group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted " +
                      (t.id === threadId ? "bg-primary/10 font-medium" : "")
                    }
                  >
                    <button
                      onClick={() => void openThread(t.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate">{t.title || "Untitled chat"}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {relativeTime(t.updated_at)}
                      </span>
                    </button>
                    <button
                      onClick={() => void removeThread(t.id)}
                      title="Delete chat"
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

      <div className={compact ? "flex-1 overflow-y-auto px-3 py-3" : "flex-1 overflow-y-auto px-6 py-5"}>
        <div className={compact ? "space-y-3" : "mx-auto max-w-2xl space-y-4"}>
          {messages.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <MessagesSquare className="mx-auto mb-2 h-6 w-6" />
              {emptyHint}
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-[var(--radius)] bg-accent px-3 py-2 text-sm text-accent-foreground">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%]">
                  <div className="md rounded-[var(--radius)] border border-border bg-card px-3 py-2">
                    <CitedMarkdown onSeek={onSeek}>{m.content}</CitedMarkdown>
                  </div>
                  {!m.content.startsWith("⚠️") && (
                    <div className="mt-0.5 flex justify-end">
                      <ReportAiButton size="xs" surface="chat" output={m.content} model={model} />
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {busyLabel}
              {(isLocalModelId(model) || isAppleModelId(model)) &&
                " (on-device model — the first run loads it and can take a minute)"}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {error === "no-key" && (
        <div className="flex items-center gap-2 border-t border-warning/40 bg-warning/10 px-4 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          {noAiHint("To chat: sign in for free monthly AI, add your own key, or download a local model.")}
          {onOpenSettings && (
            <button onClick={onOpenSettings} className="font-medium text-accent hover:underline">
              Open Settings →
            </button>
          )}
        </div>
      )}

      <div className={compact ? "border-t border-border p-2" : "border-t border-border p-3"}>
        {quickActions && quickActions.length > 0 && (
          <div
            className={
              compact
                ? "mb-2 flex flex-wrap gap-1.5"
                : "mx-auto mb-2 flex max-w-2xl flex-wrap gap-1.5"
            }
          >
            {quickActions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => runQuickAction(a)}
                disabled={busy}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        <div
          className={
            compact
              ? "relative flex items-end gap-2"
              : "relative mx-auto flex max-w-2xl items-end gap-2"
          }
        >
          {slashOpen && (
            <SlashPicker
              ref={pickerRef}
              query={slashQuery}
              allowWorkflows={allowWorkflows}
              onRun={runEntry}
              onClose={closeSlash}
            />
          )}
          <button
            type="button"
            onClick={openSlash}
            title={`Run a saved prompt or workflow (${chord("/")})`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Slash className="h-4 w-4" />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.metaKey && e.key === "/") {
                e.preventDefault();
                openSlash();
                return;
              }
              // While the picker is open it owns Arrow/Enter/Esc (returns true).
              if (slashOpen && pickerRef.current?.handleKey(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="max-h-32 flex-1 resize-none rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={send} disabled={busy || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
