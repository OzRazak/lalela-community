// Pending automation sends awaiting approval (phase 19 / B7 — desktop). An
// automation matched a meeting and queued an ask-mode send; nothing leaves
// Lalela until it's approved here. State is read from the CLOUD automation_runs
// table (via the desktop Supabase client) so it matches the web app's approval
// queue exactly. Approve runs the send through the hosted push route with the
// user's JWT (409 = already sent = done) and flips the ledger row to done;
// dismiss keeps it auditable as dismissed. Both ledgers (cloud + local) update.

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Send, X } from "lucide-react";
import { listMeetings, type MeetingMeta } from "@/lib/lalela";
import {
  listTags,
  updateAutomationRunStatus as localUpdateRunStatus,
  type AutomationSend,
  type Tag,
} from "@/lib/tags";
import {
  cloudListAutomationRuns,
  cloudUpdateAutomationRunStatus,
  currentUid,
  type CloudAutomationRun,
} from "@/lib/automationsSync";
import { executeSend } from "@/lib/automations";

import { DESTINATION_LABEL, SENDS_AVAILABLE } from "@/lib/destinations";

function sendOf(run: CloudAutomationRun): AutomationSend | null {
  const send = (run.detail as { send?: AutomationSend } | null)?.send;
  return send?.destination ? send : null;
}

interface Props {
  /** Scope to one meeting (meeting-detail card); omit for the global queue. */
  meetingId?: string;
  /** Show the meeting title next to each row (global queue only). */
  showMeeting?: boolean;
  onChanged?: () => void;
}

/** Sends (and so approvals of them) are official-edition only. */
export function PendingApprovals(props: Props) {
  if (!SENDS_AVAILABLE) return null;
  return <PendingApprovalsImpl {...props} />;
}

function PendingApprovalsImpl({ meetingId, showMeeting, onChanged }: Props) {
  const [pending, setPending] = useState<CloudAutomationRun[]>([]);
  const [tags, setTags] = useState<Map<string, Tag>>(new Map());
  const [meetings, setMeetings] = useState<Map<string, MeetingMeta>>(new Map());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const uid = await currentUid();
    setSignedIn(!!uid);
    if (!uid) {
      setPending([]);
      return;
    }
    try {
      const [runs, allTags, metas] = await Promise.all([
        cloudListAutomationRuns({ status: "pending_approval", meetingId }),
        listTags().catch(() => []),
        showMeeting ? listMeetings(null).catch(() => []) : Promise.resolve([] as MeetingMeta[]),
      ]);
      setPending(runs.filter((r) => r.action.startsWith("send:") && sendOf(r)));
      setTags(new Map(allTags.map((t) => [t.id, t])));
      setMeetings(new Map(metas.map((m) => [m.id, m])));
    } catch {
      setPending([]);
    }
  }, [meetingId, showMeeting]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const keyOf = (r: CloudAutomationRun) => `${r.meeting_id}:${r.tag_id}:${r.action}`;

  async function approve(run: CloudAutomationRun) {
    const send = sendOf(run);
    if (!send) return;
    setBusyKey(keyOf(run));
    setError(null);
    setNotice(null);
    try {
      const result = await executeSend(run.meeting_id, send, { interactive: true });
      await cloudUpdateAutomationRunStatus(run.meeting_id, run.tag_id, run.action, "done");
      await localUpdateRunStatus(run.meeting_id, run.tag_id, run.action, "done").catch(() => {});
      setNotice(
        (result as { alreadySent?: boolean }).alreadySent
          ? "Already sent earlier — marked done."
          : "Sent.",
      );
      onChanged?.();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setBusyKey(null);
    }
  }

  async function dismiss(run: CloudAutomationRun) {
    await cloudUpdateAutomationRunStatus(run.meeting_id, run.tag_id, run.action, "dismissed").catch(
      () => {},
    );
    await localUpdateRunStatus(run.meeting_id, run.tag_id, run.action, "dismissed").catch(() => {});
    onChanged?.();
    void refresh();
  }

  // Meeting-detail card: render nothing when there's nothing to approve.
  if (meetingId && pending.length === 0 && !notice) return null;

  if (!meetingId && signedIn === false) {
    return (
      <p className="text-sm text-muted-foreground">Sign in to review pending sends.</p>
    );
  }

  const body = (
    <>
      {notice && <p className="mt-1 text-xs text-success">{notice}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {pending.length === 0 ? (
        !meetingId && (
          <p className="mt-2 text-sm text-muted-foreground">Nothing waiting for approval.</p>
        )
      ) : (
        <ul className="mt-2 space-y-2">
          {pending.map((run) => {
            const send = sendOf(run)!;
            const tag = tags.get(run.tag_id);
            const meeting = meetings.get(run.meeting_id);
            const busy = busyKey === keyOf(run);
            return (
              <li
                key={keyOf(run)}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">
                    {DESTINATION_LABEL[send.destination] ?? send.destination}
                  </span>
                  {send.target?.name && (
                    <span className="text-muted-foreground"> → {send.target.name}</span>
                  )}
                  {send.destination === "atlas_pack" && (
                    <span className="text-muted-foreground">
                      {send.includeTranscript ? " · includes the full transcript" : " · summary + action items"}
                    </span>
                  )}
                  {showMeeting && meeting && (
                    <span className="text-muted-foreground"> · {meeting.title}</span>
                  )}
                  {tag && (
                    <span
                      className="ml-2 rounded-full px-2 py-px text-[11px] font-medium"
                      style={{ background: `${tag.color}22`, color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  )}
                </div>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => approve(run)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 text-xs font-semibold text-primary-foreground hover:brightness-95"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve &amp; send
                    </button>
                    <button
                      onClick={() => dismiss(run)}
                      aria-label="Dismiss"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] border border-border text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  // Compact amber card inside a meeting; plain block in the global queue.
  if (meetingId) {
    return (
      <div className="rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Send className="h-4 w-4" /> Automation wants to send this meeting
        </p>
        {body}
      </div>
    );
  }
  return <div>{body}</div>;
}
