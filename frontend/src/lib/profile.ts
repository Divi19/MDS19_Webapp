import { supabase } from "@/lib/supabaseClient";

export interface Profile {
  displayName: string | null;
  institution: string | null;
  role: string | null;
}

/** null means no row yet — a brand new account, or one that predates this
 * feature. Not an error case; the panel just shows empty fields. */
export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, institution, role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Loading profile failed: ${error.message}`);
  if (!data) return null;
  return { displayName: data.display_name, institution: data.institution, role: data.role };
}

export async function saveProfile(userId: string, profile: Profile): Promise<void> {
  const { error } = await supabase.from("profiles").upsert(
    {
      id: userId,
      display_name: profile.displayName || null,
      institution: profile.institution || null,
      role: profile.role || null,
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`Saving profile failed: ${error.message}`);
}

/** Total predictions saved under this user — reuses the existing history
 * table rather than tracking a separate counter. */
export async function countPredictions(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("predictions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`Loading prediction count failed: ${error.message}`);
  return count ?? 0;
}
