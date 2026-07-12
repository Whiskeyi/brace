import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { createUserSupabaseClient } from "@/lib/supabase/server";

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(message = "Authentication required", options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

export interface VerifiedAuth {
  userId: string;
  email: string | null;
  user: User;
  accessToken: string;
  supabase: SupabaseClient;
}

export function extractBearerToken(headers: Headers): string {
  const value = headers.get("authorization");
  const match = value?.match(/^Bearer[ \t]+([^\s]+)$/i);
  if (!match) {
    throw new AuthenticationError("Missing or malformed Bearer token");
  }
  return match[1];
}

/** Validates a JWT against Supabase Auth; it never trusts decoded claims alone. */
export async function verifyAccessToken(
  accessToken: string,
  client: SupabaseClient = createUserSupabaseClient(accessToken),
): Promise<VerifiedAuth> {
  const token = accessToken.trim();
  if (!token) {
    throw new AuthenticationError("Missing access token");
  }

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    throw new AuthenticationError("Invalid or expired access token", {
      cause: error ?? undefined,
    });
  }

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    user: data.user,
    accessToken: token,
    supabase: client,
  };
}

export async function authenticateRequest(
  request: Pick<Request, "headers">,
): Promise<VerifiedAuth> {
  return verifyAccessToken(extractBearerToken(request.headers));
}
