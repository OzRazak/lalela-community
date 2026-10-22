/// <reference types="vite/client" />

/** Build-time distribution channel, injected by the `define` in
 * vite.config.ts from the `LALELA_DISTRIBUTION` environment variable.
 * "store" for the Microsoft Store MSIX build, "direct" for everything else.
 * Read it through `@/lib/distribution`, never directly. */
declare const __LALELA_DISTRIBUTION__: string;

interface ImportMetaEnv {
  /** PostHog project key override (unset ⇒ the shared estate key in release
   *  builds, nothing in dev; "off" ⇒ never send). See lib/posthog.ts. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingest host; defaults to the EU cloud. */
  readonly VITE_POSTHOG_HOST?: string;
  /** Release-build default PostHog key (edition/official.env). */
  readonly VITE_POSTHOG_DEFAULT_KEY?: string;
  /** "official" | "community" — set by vite.config.ts from the edition env.
   *  Read it through `@/lib/edition`, never directly. */
  readonly VITE_LALELA_EDITION?: string;
  /** Supabase project URL + publishable key (official edition only). */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Microsoft Entra client id; unset ⇒ the Microsoft integration is hidden. */
  readonly VITE_MS_CLIENT_ID?: string;
  /** Label of the partner product-hub send destination (official edition). */
  readonly VITE_PRODUCT_HQ_LABEL?: string;
}
