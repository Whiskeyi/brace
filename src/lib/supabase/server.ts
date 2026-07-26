import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getPublicConfig } from "@/lib/config";

function assertAccessToken(accessToken: string): string {
  const token = accessToken.trim();
  if (!token || /[\r\n]/.test(token)) {
    throw new Error("A valid user access token is required");
  }
  return token;
}

/**
 * Server-side anon client scoped by the caller's JWT. It is used to verify
 * identity; application business data uses the separately owner-filtered
 * Service Role data plane.
 */
export function createUserSupabaseClient(accessToken: string): SupabaseClient {
  const config = getPublicConfig();
  const token = assertAccessToken(accessToken);

  return createClient(
    config.NEXT_PUBLIC_SUPABASE_URL,
    config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
