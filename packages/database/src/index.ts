import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

export type { Database, Json } from "./database.types";

export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
}

/** Creates an RLS-bound client. A service-role key must never be passed here. */
export function createSupabaseClient(
  config: PublicSupabaseConfig
): SupabaseClient<Database> {
  if (!config.url || !config.anonKey) {
    throw new Error("Supabase URL and anonymous key are required");
  }

  return createClient<Database>(config.url, config.anonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true
    }
  });
}

