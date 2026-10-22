import { countBucket, trackEvent } from "@/lib/analytics";
import { useEffect, useState } from "react";
import { Search as SearchIcon, FileText } from "lucide-react";
import { searchMeetings, formatDate, type MeetingMeta } from "@/lib/lalela";

interface SearchViewProps {
  onOpenMeeting: (id: string) => void;
}

export function SearchView({ onOpenMeeting }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MeetingMeta[]>([]);

  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      searchMeetings(query)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

  // Analytics: one event per settled search (2 s after typing stops) — the
  // query itself is never sent, only a bucketed result count.
  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(
      () => trackEvent("search_used", { surface: "search_view", results: countBucket(results.length) }),
      2000,
    );
    return () => clearTimeout(t);
  }, [query, results.length]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Across every meeting — titles, transcripts, summaries and notes.
        </p>
      </header>

      <div className="border-b border-border px-6 py-3">
        <div
          data-tour-id="search-input"
          className="mx-auto flex max-w-3xl items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-3"
        >
          <SearchIcon className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your meetings…"
            className="h-10 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-2">
          {results.map((m) => (
            <button
              key={m.id}
              onClick={() => onOpenMeeting(m.id)}
              className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3 text-left hover:bg-muted"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{m.title}</div>
                <div className="text-xs text-muted-foreground">{formatDate(m.created_at)}</div>
                {m.snippet && (
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {m.snippet}
                  </div>
                )}
              </div>
            </button>
          ))}
          {query && results.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No matches.</p>
          )}
        </div>
      </div>
    </div>
  );
}
