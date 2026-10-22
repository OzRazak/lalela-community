import { useEffect, useMemo, useState } from "react";
import { Users, FileText, Folder, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { listSharedMeetings, importSharedMeeting, listSharedProjectNames } from "@/lib/sync";
import { formatDate, type MeetingMeta } from "@/lib/lalela";

interface SharedViewProps {
  onOpenMeeting: (id: string) => void;
}

export function SharedView({ onOpenMeeting }: SharedViewProps) {
  const { user } = useAuth();
  const [meetings, setMeetings] = useState<MeetingMeta[] | null>(null);
  const [folderNames, setFolderNames] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setMeetings([]);
      return;
    }
    listSharedMeetings(user.id)
      .then(setMeetings)
      .catch(() => setMeetings([]));
    listSharedProjectNames(user.id)
      .then(setFolderNames)
      .catch(() => {});
  }, [user]);

  // Group by folder so shares read as folders, not one flat list.
  const groups = useMemo(() => {
    const byFolder = new Map<string, MeetingMeta[]>();
    for (const m of meetings ?? []) {
      const key = m.project_id ?? "";
      byFolder.set(key, [...(byFolder.get(key) ?? []), m]);
    }
    return [...byFolder.entries()].sort((a, b) =>
      (folderNames[a[0]] ?? "").localeCompare(folderNames[b[0]] ?? ""),
    );
  }, [meetings, folderNames]);

  const open = async (id: string) => {
    setOpening(id);
    try {
      await importSharedMeeting(id);
      onOpenMeeting(id);
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">Shared with me</h1>
        <p className="text-sm text-muted-foreground">
          Meetings teammates shared with you via a project.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {!user ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Sign in (Settings → Account) to see meetings shared with you.
          </p>
        ) : meetings && meetings.length > 0 ? (
          <div className="mx-auto max-w-3xl space-y-5">
            {groups.map(([folderId, folderMeetings]) => (
              <div key={folderId || "unfiled"}>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  {folderNames[folderId] ?? "Shared meetings"}
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                    {folderMeetings.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {folderMeetings.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => open(m.id)}
                      className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3 text-left hover:bg-muted"
                    >
                      {opening === m.id ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{m.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(m.created_at)}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Users className="mx-auto mb-2 h-6 w-6" />
            Nothing shared with you yet.
          </div>
        )}
      </div>
    </div>
  );
}
