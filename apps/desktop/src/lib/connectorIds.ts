// Connector meeting ids (issue #284). Pure + dependency-free so `node --test`
// can load it; the web engine (apps/web/lib/connectors/meetingIds.ts) derives
// the SAME ids, so a meeting imported on either side lands on one record.
//
// Two schemes:
//  - legacy (until 1.3.9):  conn-<provider>-<sha1(externalId)[0..16]>
//    Keyed on the external meeting alone, so two Lalela users who attended the
//    same Teams call got the same id — and `meetings.id` is the cloud's global
//    primary key, so the second one could never back theirs up.
//  - per owner (now):       conn-<provider>-<sha1(ownerId + ":" + legacyId)[0..16]>
//    The owner's Supabase user id namespaces the legacy id. It hashes the
//    LEGACY ID rather than the raw external id on purpose: the external id is
//    not stored locally, so a meeting re-keyed after a collision (all we have
//    is its legacy id) must still land on exactly the id a fresh import by the
//    same owner would produce — otherwise re-key and re-import would duplicate.
//
// Existing ids never change unless they collide: a legacy id the user owns
// (or that no-one has pushed yet) stays as it is forever.

export async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** conn-<provider>-<sha1(externalId)[0..16]> — the pre-#284 shared id. */
export async function legacyConnectorMeetingId(provider: string, externalId: string): Promise<string> {
  return `conn-${provider}-${(await sha1Hex(externalId)).slice(0, 16)}`;
}

/** conn-<provider>-<sha1(ownerId:legacyId)[0..16]> — the per-owner id. */
export async function ownedConnectorMeetingId(
  provider: string,
  ownerId: string,
  legacyId: string,
): Promise<string> {
  return `conn-${provider}-${(await sha1Hex(`${ownerId}:${legacyId}`)).slice(0, 16)}`;
}

/** The provider of a connector meeting id (`conn-<provider>-<hash>`), else null. */
export function connectorProviderOf(id: string): string | null {
  const m = /^conn-([a-z0-9]+)-[0-9a-f]+$/i.exec(id);
  return m ? m[1].toLowerCase() : null;
}

/** Both candidate ids for one external meeting. `owned` is null while signed
 * out: there is no owner yet, so the import keeps the legacy id and a
 * collision is fixed by re-keying when it is first pushed. */
export async function connectorImportIds(
  provider: string,
  externalId: string,
  ownerId: string | null,
): Promise<{ legacy: string; owned: string | null }> {
  const legacy = await legacyConnectorMeetingId(provider, externalId);
  return { legacy, owned: ownerId ? await ownedConnectorMeetingId(provider, ownerId, legacy) : null };
}

export type ImportIdChoice = { action: "skip"; reason: "local" | "cloud" } | { action: "import"; id: string };

/**
 * Which id (if any) a connector import should create.
 *  - Either id already here (`have` = local meeting ids + re-key aliases) →
 *    skip: dedupe across both schemes, so nothing imported before #284
 *    re-imports as a duplicate.
 *  - Either id already in the cloud and OURS (`cloudOwners`, when the lookup
 *    ran) → skip: pull-down sync brings it here; importing would overwrite the
 *    cloud copy's edits.
 *  - Signed out → the legacy id (see `connectorImportIds`).
 *  - Otherwise → the per-owner id, never the legacy one: a legacy id that is
 *    free today can be taken by another account tomorrow.
 */
export function chooseConnectorImportId(opts: {
  legacy: string;
  owned: string | null;
  have: ReadonlySet<string>;
  uid: string | null;
  cloudOwners?: ReadonlyMap<string, string> | null;
}): ImportIdChoice {
  const { legacy, owned, have, uid, cloudOwners } = opts;
  if (have.has(legacy) || (owned !== null && have.has(owned))) return { action: "skip", reason: "local" };
  if (uid && cloudOwners) {
    if (cloudOwners.get(legacy) === uid || (owned !== null && cloudOwners.get(owned) === uid))
      return { action: "skip", reason: "cloud" };
  }
  if (!uid || owned === null) return { action: "import", id: legacy };
  return { action: "import", id: owned };
}

/**
 * The id to re-key a local meeting to when its cloud push is refused because
 * another account owns that id (RLS "USING expression" — the row is invisible
 * to us). Only connector imports qualify: their ids are derived, so a second
 * owner is a collision, not a share. Native recordings (`mtg-*`), web
 * recordings and folders are never re-keyed. Null when not applicable.
 */
export async function rekeyTargetFor(id: string, uid: string | null): Promise<string | null> {
  if (!uid) return null;
  const provider = connectorProviderOf(id);
  if (!provider) return null;
  return ownedConnectorMeetingId(provider, uid, id);
}
