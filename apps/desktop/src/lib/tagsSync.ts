// Cloud mirror for tags (phase 19). Local SQLite is canonical; every tag
// write from the UI ALSO writes through to Supabase (best-effort — offline or
// signed-out silently no-ops, like the rest of sync). The pull direction is
// union-add only: it brings down tags/assignments created elsewhere (web UI,
// the cloud automation engine tagging imports) without resurrecting local
// deletions, because local deletes write through to the cloud row too.

import { supabase } from "@/lib/supabase";
import { addMeetingTag, saveTag, listTags, getMeetingTags, type Tag } from "@/lib/tags";

async function uid(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Write-through upsert of a tag definition. */
export async function cloudSaveTag(tag: Tag): Promise<void> {
  const owner = await uid();
  if (!owner) return;
  await supabase
    .from("tags")
    .upsert({ id: tag.id, owner_id: owner, name: tag.name, color: tag.color })
    .then(() => {}, () => {});
}

/** Write-through delete (cascades meeting_tags + automations in the cloud). */
export async function cloudDeleteTag(tagId: string): Promise<void> {
  if (!(await uid())) return;
  await supabase.from("tags").delete().eq("id", tagId).then(() => {}, () => {});
}

/** Write-through replace of one meeting's tag set. Swallows FK errors for
 * meetings that haven't reached the cloud yet — the next full sync catches up. */
export async function cloudSetMeetingTags(meetingId: string, tagIds: string[]): Promise<void> {
  const owner = await uid();
  if (!owner) return;
  try {
    await supabase.from("meeting_tags").delete().eq("meeting_id", meetingId);
    if (tagIds.length > 0) {
      await supabase.from("meeting_tags").insert(
        tagIds.map((tagId) => ({
          meeting_id: meetingId,
          tag_id: tagId,
          owner_id: owner,
          added_by: "manual",
        })),
      );
    }
  } catch {
    /* offline / meeting not in cloud yet */
  }
}

/** Pull tags + assignments created elsewhere (web, cloud engine). Union-add. */
export async function pullTags(ownerUid: string): Promise<void> {
  try {
    const { data: cloudTags } = await supabase
      .from("tags")
      .select("id,name,color,created_at")
      .eq("owner_id", ownerUid);
    const localIds = new Set((await listTags()).map((t) => t.id));
    for (const t of cloudTags ?? []) {
      if (localIds.has(t.id)) continue;
      await saveTag({ id: t.id, name: t.name, color: t.color });
    }

    const { data: cloudMt } = await supabase
      .from("meeting_tags")
      .select("meeting_id,tag_id,added_by")
      .eq("owner_id", ownerUid);
    const byMeeting = new Map<string, Set<string>>();
    for (const row of cloudMt ?? []) {
      if (!byMeeting.has(row.meeting_id)) {
        byMeeting.set(
          row.meeting_id,
          new Set(await getMeetingTags(row.meeting_id).catch(() => [])),
        );
      }
      if (byMeeting.get(row.meeting_id)!.has(row.tag_id)) continue;
      const addedBy =
        row.added_by === "ai" || row.added_by === "rule" ? row.added_by : "manual";
      await addMeetingTag(row.meeting_id, row.tag_id, addedBy).catch(() => {});
    }
  } catch {
    /* offline or migration not applied — never block meeting sync */
  }
}
