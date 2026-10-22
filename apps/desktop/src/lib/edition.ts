// Build edition — the ONE switch between the official Lalela app and the
// open-source, local-only Community edition (docs/OPEN-SOURCE.md).
//
// The edition is baked in at build time from `VITE_LALELA_EDITION`, which
// vite.config.ts resolves from `edition/<edition>.env` (or the LALELA_EDITION
// environment variable). The source is identical in both editions; only the
// env file differs.
//
//   official  — sign-in, cloud sync, sharing, free-tier AI, cloud
//               transcription, analytics, crash reports and the self-updater,
//               all pointing at Auxo's hosted services.
//   community — none of the above. No Supabase client is ever created, no
//               request goes to an Auxo-operated host, and the cloud surfaces
//               are hidden. Recording, on-device transcription, speaker
//               separation, local models and bring-your-own-key AI all work.
//
// Gate at entry points (nav, settings sections, the supabase module) rather
// than scattering checks: with no session ever existing, most cloud code paths
// are already inert, because they only run for a signed-in user.
//
// `import.meta.env?.` (optional) because the node --test runner imports some
// modules without Vite, where `import.meta.env` is undefined.

export type Edition = "official" | "community";

export const EDITION: Edition =
  import.meta.env?.VITE_LALELA_EDITION === "community" ? "community" : "official";

/** True in the open-source, local-only Community edition. */
export const IS_COMMUNITY: boolean = EDITION === "community";

/** True in the official Auxo-built app (App Store, direct download). */
export const IS_OFFICIAL: boolean = !IS_COMMUNITY;

export const COMMUNITY_UNAVAILABLE_MESSAGE =
  "This feature needs Lalela's hosted services and is not available in the Community edition.";

/** Thrown by anything that would reach an Auxo cloud service in the
 *  Community edition. */
export class CommunityEditionError extends Error {
  constructor(message: string = COMMUNITY_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "CommunityEditionError";
  }
}

/** Read a build-time value the OFFICIAL edition cannot run without. A missing
 *  value fails loudly (vite.config.ts already refuses to build without it;
 *  this is the belt-and-braces first-use check), never silently degrades. */
export function requireOfficialEnv(name: string, value: string | undefined): string {
  const v = value?.trim();
  if (!v) {
    throw new Error(
      `Lalela official build is missing ${name}. Provide apps/desktop/edition/official.env, ` +
        `or build the Community edition (LALELA_EDITION=community).`,
    );
  }
  return v;
}

/** Microsoft (Outlook calendar + Teams transcript) sign-in needs an Azure app
 *  registration. The official build ships Auxo's; a Community build gets the
 *  feature only when it is compiled with its own `VITE_MS_CLIENT_ID`. */
export const MS_CLIENT_ID: string = (import.meta.env?.VITE_MS_CLIENT_ID ?? "").trim();
export const MS_INTEGRATION_AVAILABLE: boolean = MS_CLIENT_ID !== "";

/** Copy helper for "no AI source yet" hints: the official text invites the
 *  user to sign in for the free allowance, which the Community edition has
 *  no way to offer. */
export function noAiHint(official: string): string {
  return IS_COMMUNITY
    ? "To use AI: add your own OpenRouter key or download an on-device model in Settings → AI models."
    : official;
}
