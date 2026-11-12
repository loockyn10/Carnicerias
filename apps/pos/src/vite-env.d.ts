/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: unknown;
}

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __POS_BUILD__: { version: string; builtAt: string | null; commit: string | null } | undefined;
