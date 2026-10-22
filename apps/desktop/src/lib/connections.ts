// Client helper for the "Use my connections" chat toggle (T7) on desktop. The
// connectors framework lives in the WEB backend, so the desktop reaches it
// through the hosted lalela-app route (CORS-enabled in middleware.ts) with the
// Supabase JWT — the same pattern as the push routes in lib/automations.ts.

import { LALELA_API } from "@/lib/ai";
import { supabase } from "@/lib/supabase";
import { PRODUCT_HQ_LABEL } from "@/lib/destinations";

/** Provider ids that can enrich chat — mirrors the server's CHAT_PROVIDER_IDS
 * (apps/web/lib/chatWithConnections.ts). */
export const CHAT_CONNECTIONS: { id: string; label: string }[] = [
  { id: "artemis", label: "Fikelela CRM" },
  { id: "atlas", label: "Atlas Delivery" },
  { id: "arete", label: PRODUCT_HQ_LABEL },
  { id: "codex", label: "Codex Vault" },
];

const CHAT_IDS = new Set(CHAT_CONNECTIONS.map((c) => c.id));

/** The signed-in user's connected, chat-capable connections (usable only — an
 * account in `error` state is excluded). Best-effort: returns [] when signed
 * out or on any failure, so the toggle simply stays unavailable. */
export async function fetchChatConnections(): Promise<{ id: string; label: string }[]> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return [];
    const res = await fetch(`${LALELA_API}/api/connectors`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      providers?: { id: string; name: string; account?: { status?: string } | null }[];
    };
    return (j.providers ?? [])
      .filter((p) => CHAT_IDS.has(p.id) && p.account && p.account.status !== "error")
      .map((p) => ({ id: p.id, label: CHAT_CONNECTIONS.find((c) => c.id === p.id)?.label ?? p.name }));
  } catch {
    return [];
  }
}
