import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True once real Supabase credentials are configured. Auth/history features
 * degrade gracefully (login disabled, guest-only) when this is false, rather
 * than crashing the whole app. */
export const supabaseEnabled = Boolean(url && anonKey);

// Falls back to harmless placeholder values so createClient doesn't throw
// when the env vars aren't set yet (e.g. local dev before Supabase is wired
// up) — callers must still check `supabaseEnabled` before relying on it.
export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder-anon-key",
);
