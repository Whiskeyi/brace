import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerConfig, requireServerConfig } from "@/lib/config";

if (typeof window !== "undefined") {
  throw new Error("The service-role Supabase client cannot be imported in a browser");
}

/**
 * Privileged client for trusted background jobs only. Never use it to serve a
 * user request unless every resource owner is independently checked first.
 */
export function createServiceRoleSupabaseClient(): SupabaseClient {
  const config = getServerConfig();
  const serviceRoleKey = requireServerConfig("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(config.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
