// Wiki browse surface (Intelligence Layer, Slice 3): the LLM-compiled
// knowledge pages (people / projects / topics), each with its sources —
// every fact links back to the meeting (+ timestamp) it came from.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ReportAiButton } from "@/components/ReportAiContent";
import {
  listWikiPages,
  getWikiPage,
  formatDate,
  formatMs,
  type WikiPageRow,
  type WikiPageDetail,
} from "@/lib/lalela";
import { User, FolderOpen, Hash, ChevronLeft, Quote } from "lucide-react";
import { Button } from "@/components/ui/Button";
// Amp: the teaching empty state (Spark mark + wayfinding copy).
import { EmptyState } from "@auxo/amp-primitives";

const KIND_META: Record<string, { label: string; icon: typeof User }> = {
  person: { label: "People", icon: User },
  project: { label: "Projects", icon: FolderOpen },
  topic: { label: "Topics", icon: Hash },
};

interface WikiViewProps {
  onOpenMeeting: (id: string) => void;
}

export function WikiView({ onOpenMeeting }: WikiViewProps) {
  const [pages, setPages] = useState<WikiPageRow[] | null>(null);
  const [open, setOpen] = useState<WikiPageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWikiPages()
      .then(setPages)
      .catch((e) => {
        setPages([]);
        setError(String(e));
      });
  }, []);

  const openPage = async (id: string) => {
    try {
      setOpen(await getWikiPage(id));
    } catch (e) {
      setError(String(e));
    }
  };

  if (open) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <Button variant="ghost" size="icon" onClick={() => setOpen(null)} title="Back to wiki">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-bold tracking-tight">{open.title}</h1>
            <p className="text-sm text-muted-foreground">
              {open.summary_line || KIND_META[open.kind]?.label || open.kind}
            </p>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="md max-w-3xl">
            <ReactMarkdown>{open.content_md}</ReactMarkdown>
          </div>
          <div className="mt-3 flex max-w-3xl justify-end">
            <ReportAiButton surface="knowledge" output={open.content_md} />
          </div>
          <div className="mt-8 max-w-3xl">
            <h3 className="mb-2 text-sm font-semibold">
              Sources ({open.facts.length})
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Every fact on this page traces back to a meeting. Click a source to open it.
            </p>
            <div className="space-y-2">
              {open.facts.map((f, i) => (
                <button
                  key={i}
                  onClick={() => onOpenMeeting(f.meeting_id)}
                  className="flex w-full items-start gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-muted-foreground">“{f.quote}”</span>
                    <span className="mt-0.5 block text-xs font-medium">
                      {f.meeting_title}
                      {f.t_ms != null && ` · ${formatMs(f.t_ms)}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const kinds = ["person", "project", "topic"].filter((k) =>
    (pages ?? []).some((p) => p.kind === k),
  );

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">Wiki</h1>
        <p className="text-sm text-muted-foreground">
          Knowledge compiled from your meetings — people, projects and topics, every fact
          sourced.
        </p>
      </header>
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-6 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-6">
        {pages && pages.length > 0 ? (
          <div className="mx-auto max-w-3xl space-y-6">
            {kinds.map((kind) => {
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              return (
                <section key={kind}>
                  <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                    <Icon className="h-4 w-4" />
                    {meta.label}
                  </h2>
                  <div className="space-y-2">
                    {pages
                      .filter((p) => p.kind === kind)
                      .map((p) => (
                        <button
                          key={p.id}
                          onClick={() => openPage(p.id)}
                          className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3 text-left hover:bg-muted"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{p.title}</div>
                            {p.summary_line && (
                              <div className="truncate text-xs text-muted-foreground">
                                {p.summary_line}
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {p.fact_count} source{p.fact_count === 1 ? "" : "s"} ·{" "}
                            {formatDate(p.updated_at)}
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : pages === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title="No wiki pages yet"
              body="Your knowledge, compiled. Pages build automatically when you generate a meeting summary — the people, projects and topics your meetings keep coming back to, with every fact traced to its source."
            />
          </div>
        )}
      </div>
    </div>
  );
}
