"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getPublicConfig } from "@/lib/config";

let browserClient: SupabaseClient | undefined;

/**
 * Browser-safe singleton. It is intentionally impossible to pass a service-role
 * key through this API; only NEXT_PUBLIC_* values are read.
 */
export function createBrowserSupabaseClient(): SupabaseClient {
  if (typeof window === "undefined") {
    throw new Error("createBrowserSupabaseClient must only be called in a browser");
  }

  if (!browserClient) {
    const config = getPublicConfig();
    browserClient = createClient(
      config.NEXT_PUBLIC_SUPABASE_URL,
      config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  }

  return browserClient;
}
