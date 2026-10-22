// Pure classification of row-level-security refusals from a cloud upsert.
// Kept free of Tauri/Supabase/alias imports so `node --test` can load it.

/**
 * The upsert hit an EXISTING row that RLS won't let us update — i.e. the row
 * belongs to someone else, even when it's invisible to us (not shared with us,
 * so `cloudOwners`/`isForeignRow` see nothing).
 *
 * Postgres words it "new row violates row-level security policy (USING
 * expression) for table …" (SQLSTATE 42501): `INSERT … ON CONFLICT DO UPDATE`
 * found a conflicting row and the UPDATE policy's USING clause rejected it.
 * Our own rows always pass that clause (owner_id = uid), so this variant means
 * "not ours to write".
 *
 * The plain/WITH CHECK variant ("new row violates row-level security policy
 * for table …") is a different problem — the row WE tried to write was refused
 * (e.g. a project_id we may not file into) — and stays a real failure.
 */
export function isForeignRowRejection(e: unknown): boolean {
  if (e === null || e === undefined) return false;
  const code = (e as { code?: unknown }).code;
  const message =
    e instanceof Error
      ? e.message
      : typeof (e as { message?: unknown }).message === "string"
        ? ((e as { message: string }).message)
        : String(e);
  return String(code ?? "") === "42501" && /\(USING expression\)/i.test(message);
}

/** One honest line about rows that weren't uploaded because another account
 * owns them (null when there are none). */
export function foreignSkipLine(skipped: number | null | undefined): string | null {
  if (!skipped || skipped <= 0) return null;
  return skipped === 1
    ? "1 meeting or folder belongs to another Lalela account and wasn't uploaded."
    : `${skipped} meetings or folders belong to other Lalela accounts and weren't uploaded.`;
}
