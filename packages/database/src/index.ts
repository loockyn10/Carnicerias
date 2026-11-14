import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.merged";

export type { Json } from "./database.types";
export type { Database } from "./database.merged";

export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
  /** Optional `fetch` wrapper for every request the client makes (e.g. to recover from an expired JWT). */
  fetch?: typeof fetch;
}

/** Creates an RLS-bound client. A service-role key must never be passed here. */
export function createSupabaseClient(
  config: PublicSupabaseConfig
): SupabaseClient<Database> {
  if (!config.url || !config.anonKey) {
    throw new Error("Supabase URL and anonymous key are required");
  }

  return createClient<Database>(config.url, config.anonKey, {
    ...(config.fetch ? { global: { fetch: config.fetch } } : {}),
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true
    }
  });
}

