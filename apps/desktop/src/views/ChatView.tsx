import { ChatThread } from "@/components/ChatThread";
import { buildGlobalContext, CHAT_SYSTEM_PROMPT } from "@/lib/chatContext";

interface ChatViewProps {
  onOpenSettings: () => void;
}

/** Global chat across the whole meeting history. */
export function ChatView({ onOpenSettings }: ChatViewProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">Chat with your meetings</h1>
        <p className="text-sm text-muted-foreground">
          Ask anything across your meeting history — answers are grounded in your transcripts and
          summaries.
        </p>
      </header>
      <ChatThread
        scope="global"
        buildContext={buildGlobalContext}
        systemPrompt={CHAT_SYSTEM_PROMPT}
        placeholder="Ask about your meetings…"
        busyLabel="Searching your meetings…"
        emptyHint={
          <>
            Try: "What did we decide about the timeline?" or "List all action items assigned to
            me."
          </>
        }
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
