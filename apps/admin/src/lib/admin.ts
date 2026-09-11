import { redirect } from "next/navigation";

import { createClient } from "./supabase/server";

export interface AdminContext {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  timezone: string;
}

export async function getAdminContext(): Promise<AdminContext | null> {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login");

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, role_id")
    .eq("profile_id", authData.user.id)
    .eq("status", "ACTIVE")
    .limit(1)
    .maybeSingle();
  if (!membership) return null;

  const [{ data: role }, { data: organization }] = await Promise.all([
    supabase.from("roles").select("key").eq("id", membership.role_id).maybeSingle(),
    supabase.from("organizations").select("name, timezone").eq("id", membership.organization_id).maybeSingle()
  ]);
  if (role?.key !== "admin" || !organization) return null;

  return {
    userId: authData.user.id,
    email: authData.user.email ?? authData.user.id,
    organizationId: membership.organization_id,
    organizationName: organization.name,
    timezone: organization.timezone
  };
}

export async function requireAdminContext(): Promise<AdminContext> {
  const context = await getAdminContext();
  if (!context) throw new Error("Esta operación requiere el rol administrador");
  return context;
}
