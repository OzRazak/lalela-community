import { trackEvent } from "./analytics";
import { supabase } from "@/lib/supabase";
import { LALELA_API } from "@/lib/ai";
import { pushMeeting } from "@/lib/sync";
import type { FullMeeting } from "@/lib/lalela";

// Client-side share-link operations (Wave D1), desktop signed-in path. Mirrors
// apps/web/lib/shareLinks.ts 1:1 (web/desktop parity) with two desktop-only
// wrinkles: it uses the desktop supabase client + the LALELA_API origin, and it
// PUSHES the meeting to the cloud before minting a link (a desktop meeting is
// local-first, so its cloud row must exist for the public page to resolve it).
//
// The token is minted here with crypto.getRandomValues (32 bytes → base64url),
// so it is 256-bit and never sequential. A password is hashed server-side via
// /api/share/hash before storage — plaintext never touches the row.

export interface MeetingShare {
  id: string;
  meeting_id: string;
  token: string;
  password_hash: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function shareUrl(token: string): string {
  return `${LALELA_API}/s/${token}`;
}

/** True when a share is currently live (not revoked, not past expiry). */
export function isActive(s: MeetingShare): boolean {
  if (s.revoked_at) return false;
  if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return false;
  return true;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SHARE_COLS = "id, meeting_id, token, password_hash, expires_at, revoked_at, created_at";

/** The share links a meeting already has (owner RLS filters to yours). */
export async function listShareLinks(meetingId: string): Promise<MeetingShare[]> {
  const { data, error } = await supabase
    .from("meeting_shares")
    .select(SHARE_COLS)
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as MeetingShare[];
}

/** Hash a password server-side (scrypt) so plaintext never reaches the row. */
async function hashPassword(password: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in first.");
  const res = await fetch(`${LALELA_API}/api/share/hash`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const j = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
  if (!res.ok || !j.hash) throw new Error(j.error ?? "Could not secure the password.");
  return j.hash;
}

export interface CreateShareOptions {
  password?: string | null;
  /** Days until expiry; null / 0 = never expires. */
  expiresInDays?: number | null;
}

/**
 * Create a share link for a meeting the caller OWNS. Ensures the meeting is in
 * the cloud first (pushMeeting is an idempotent upsert) so the public page can
 * resolve it — a link to a never-synced meeting would 404. Throws if the push
 * fails (offline / signed out), so the UI can explain instead of minting a dead
 * link.
 */
export async function createShareLink(
  uid: string,
  meeting: FullMeeting,
  opts: CreateShareOptions = {},
): Promise<MeetingShare> {
  await pushMeeting(uid, meeting);
  trackEvent("share_link_created", {
    password: Boolean(opts.password && opts.password.length),
    expires: Boolean(opts.expiresInDays && opts.expiresInDays > 0),
  });
  const password_hash =
    opts.password && opts.password.length ? await hashPassword(opts.password) : null;
  const expires_at =
    opts.expiresInDays && opts.expiresInDays > 0
      ? new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString()
      : null;
  const token = generateToken();
  const { data, error } = await supabase
    .from("meeting_shares")
    .insert({ meeting_id: meeting.id, owner: uid, token, password_hash, expires_at })
    .select(SHARE_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as MeetingShare;
}

/** Revoke a link — indistinguishable from never-existed on the public page. */
export async function revokeShareLink(id: string): Promise<void> {
  const { error } = await supabase
    .from("meeting_shares")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}
