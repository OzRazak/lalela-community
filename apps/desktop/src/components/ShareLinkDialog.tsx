import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  createShareLink,
  isActive,
  listShareLinks,
  revokeShareLink,
  shareUrl,
  type MeetingShare,
} from "@/lib/shareLinks";
import type { FullMeeting } from "@/lib/lalela";
import { Check, Copy, Link2, Loader2, Lock, Trash2, X } from "lucide-react";

// "Share link" — per-meeting private link (Wave D1). Default OFF: a link exists
// only once the owner creates one here. Opt-in, optional password, optional
// expiry, revocable, read-only (summary + notes, never the transcript). Mirrors
// apps/web/components/ShareLinkButton.tsx 1:1 (web/desktop parity rule).

type Expiry = "never" | "7" | "30";

const inputClass =
  "w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

function expiryLabel(s: MeetingShare): string | null {
  if (!s.expires_at) return null;
  return `Expires ${new Date(s.expires_at).toLocaleDateString()}`;
}

export function ShareLinkDialog({
  meeting,
  uid,
  onClose,
}: {
  meeting: FullMeeting;
  uid: string;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<MeetingShare[] | null>(null);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = () =>
    listShareLinks(meeting.id)
      .then(setLinks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  const active = (links ?? []).filter(isActive);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createShareLink(uid, meeting, {
        password: password.trim() || null,
        expiresInDays: expiry === "never" ? null : Number(expiry),
      });
      setPassword("");
      setExpiry("never");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this link? Anyone holding it will lose access immediately.")) {
      return;
    }
    setError(null);
    try {
      await revokeShareLink(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (s: MeetingShare) => {
    await navigator.clipboard.writeText(shareUrl(s.token));
    setCopiedId(s.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-lg rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-5">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            <h2 className="font-semibold">Share a private link</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">
            Anyone with the link can view this meeting's summary and notes — read-only, no
            transcript. Links are off until you create one, and you can revoke a link any time.
          </p>

          {error && <p className="text-sm text-danger">{error}</p>}

          {links === null ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : active.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Active links
              </h3>
              {active.map((s) => (
                <div key={s.id} className="rounded-[var(--radius)] border border-border p-3">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={shareUrl(s.token)}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 truncate rounded-[var(--radius)] border border-border bg-background px-2 py-1.5 text-xs"
                    />
                    <button
                      onClick={() => copy(s)}
                      title="Copy link"
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {copiedId === s.id ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      onClick={() => revoke(s.id)}
                      title="Revoke link"
                      className="rounded p-1.5 text-muted-foreground hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {s.password_hash && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                        <Lock className="h-3 w-3" />
                        Password
                      </span>
                    )}
                    {expiryLabel(s) && (
                      <span className="rounded-full bg-muted px-2 py-0.5">{expiryLabel(s)}</span>
                    )}
                    {!s.password_hash && !s.expires_at && <span>No password · no expiry</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-3 rounded-[var(--radius)] border border-dashed border-border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              New link
            </h3>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Password (optional)</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no password"
                autoComplete="new-password"
                className={inputClass}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Expires</span>
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as Expiry)}
                className="w-full rounded-[var(--radius)] border border-border bg-card px-2 py-2 text-sm"
              >
                <option value="never">Never</option>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days</option>
              </select>
            </label>
            <Button className="w-full" onClick={create} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Create link
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
