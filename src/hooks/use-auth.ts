"use client";

import type { Session, User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

type AuthState = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  configured: boolean;
  error: string | null;
};

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
    configured: true,
    error: null,
  });

  useEffect(() => {
    let client: ReturnType<typeof createBrowserSupabaseClient>;
    try {
      client = createBrowserSupabaseClient();
    } catch (error) {
      setState((current) => ({
        ...current,
        configured: false,
        loading: false,
        error: error instanceof Error ? error.message : "Supabase 尚未配置",
      }));
      return;
    }

    void client.auth.getSession().then(({ data, error }) => {
      setState({
        user: data.session?.user ?? null,
        session: data.session,
        loading: false,
        configured: true,
        error: error?.message ?? null,
      });
    });

    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setState((current) => ({
        ...current,
        user: session?.user ?? null,
        session,
        loading: false,
        error: null,
      }));
    });

    return () => data.subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const client = createBrowserSupabaseClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const client = createBrowserSupabaseClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    return { needsConfirmation: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    const client = createBrowserSupabaseClient();
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }, []);

  return { ...state, signIn, signUp, signOut };
}
