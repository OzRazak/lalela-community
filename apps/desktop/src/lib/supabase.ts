import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CommunityEditionError, IS_COMMUNITY, requireOfficialEnv } from "@/lib/edition";

// Lalela's Supabase project. URL + publishable key come from the build-time
// edition env (apps/desktop/edition/official.env in the official repo). The
// publishable key is safe to embed in the client; row-level security enforces
// all access on the server. The Community edition has neither and never
// creates a client — see `inertClient` below and lib/edition.ts.
export const SUPABASE_URL: string = IS_COMMUNITY
  ? ""
  : requireOfficialEnv("VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL);
export const SUPABASE_PUBLISHABLE_KEY: string = IS_COMMUNITY
  ? ""
  : requireOfficialEnv(
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    );

/**
 * Community edition stand-in for the Supabase client. Nothing here touches the
 * network: there is never a session (so every "signed-in only" path stays
 * off), sign-in attempts are refused, and any query/RPC/storage call resolves
 * to `{ data: null, error: CommunityEditionError }` — the same shape a failed
 * Supabase call has, which existing callers already handle.
 */
function inertClient(): SupabaseClient {
  const error = new CommunityEditionError();
  const result = { data: null, error, count: null, status: 0, statusText: "" };
  // A chainable, awaitable query builder: every method returns the builder,
  // and awaiting it yields the error result.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = new Proxy(function inert() {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return () => builder;
    },
    apply: () => builder,
  });
  const refused = async () => ({ data: { user: null, session: null }, error });
  const auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
    signInWithPassword: refused,
    signUp: refused,
    verifyOtp: refused,
    resend: refused,
    resetPasswordForEmail: refused,
    setSession: refused,
  };
  return {
    auth,
    from: () => builder,
    rpc: () => builder,
    storage: { from: () => builder },
    channel: () => builder,
    removeChannel: async () => "ok",
  } as unknown as SupabaseClient;
}

export const supabase: SupabaseClient = IS_COMMUNITY
  ? inertClient()
  : createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
