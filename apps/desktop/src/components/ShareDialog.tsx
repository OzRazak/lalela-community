import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/auth";
import {
  shareProject,
  listMembers,
  updateMemberRole,
  removeMember,
  pushNotification,
  myActorName,
  type Member,
} from "@/lib/sync";
import { X, Users, Trash2 } from "lucide-react";

interface ShareDialogProps {
  projectId: string;
  projectName: string;
  projectCreatedMs: number;
  /** Pre-seed the invite field (e.g. from a "People at your company" suggestion). */
  prefillEmail?: string;
  onClose: () => void;
}

const inputClass =
  "w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

export function ShareDialog({
  projectId,
  projectName,
  projectCreatedMs,
  prefillEmail,
  onClose,
}: ShareDialogProps) {
  const { user } = useAuth();
  const [email, setEmail] = useState(prefillEmail ?? "");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => listMembers(projectId).then(setMembers).catch(() => {});
  useEffect(() => {
    refresh();
  }, [projectId]);

  const invite = async () => {
    if (!user) return;
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await shareProject(user.id, projectId, projectName, projectCreatedMs, email, role);
      setMsg(`Shared with ${email}`);
      // Tell the invitee (best-effort — resolve their uid from the member list).
      listMembers(projectId)
        .then(async (mem) => {
          const invited = mem.find((m) => m.email?.toLowerCase() === email.toLowerCase());
          if (!invited || invited.user_id === user.id) return;
          const name = await myActorName(user.id);
          await pushNotification({
            actorId: user.id,
            actorName: name,
            recipientId: invited.user_id,
            projectId,
            kind: "member_added",
            title: `${name} added you to “${projectName}”`,
            body: `You can now see its meetings as ${role}.`,
          });
        })
        .catch(() => {});
      setEmail("");
      refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-5">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            <h2 className="font-semibold">Share "{projectName}"</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <p className="text-sm text-muted-foreground">
            Invite a teammate by email. They need a Lalela account; meetings in this folder — and
            in its subfolders — sync to them with the role you choose. Folders you don't share
            stay private to you.
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className={inputClass}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {err && <p className="text-sm text-danger">{err}</p>}
          {msg && <p className="text-sm text-success">{msg}</p>}
          <Button className="w-full" onClick={invite} disabled={busy || !email}>
            Share
          </Button>

          {members.length > 0 && (
            <div className="pt-2">
              <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                People with access
              </h3>
              <div className="space-y-1">
                {members.map((m) => {
                  const isMe = m.user_id === user?.id;
                  return (
                    <div key={m.user_id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        {m.display_name || m.email || m.user_id.slice(0, 8)}
                        {isMe && <span className="text-muted-foreground"> (you)</span>}
                      </span>
                      <select
                        value={m.role}
                        disabled={isMe}
                        onChange={async (e) => {
                          setErr(null);
                          try {
                            await updateMemberRole(projectId, m.user_id, e.target.value);
                            refresh();
                          } catch (er) {
                            setErr(er instanceof Error ? er.message : String(er));
                          }
                        }}
                        className="h-7 rounded-[var(--radius)] border border-border bg-card px-1.5 text-xs capitalize disabled:opacity-50"
                        title={isMe ? "You can't change your own role" : "Change role"}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        onClick={async () => {
                          setErr(null);
                          try {
                            await removeMember(projectId, m.user_id);
                            refresh();
                          } catch (er) {
                            setErr(er instanceof Error ? er.message : String(er));
                          }
                        }}
                        className="rounded p-1 text-muted-foreground hover:text-danger"
                        title={isMe ? "Leave this share" : "Remove access"}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
