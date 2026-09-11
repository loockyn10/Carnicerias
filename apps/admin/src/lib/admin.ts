import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "./supabase/server";

export interface AdminContext {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  timezone: string;
}

export const getAdminContext = cache(async (): Promise<AdminContext | null> => {
  const startedAt = performance.now();
  const supabase = await createClient();
  const authStartedAt = performance.now();
  const { data: authData } = await supabase.auth.getUser();
  const authMs = Math.round(performance.now() - authStartedAt);
  if (!authData.user) redirect("/login");

  const membershipStartedAt = performance.now();
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, role_id")
    .eq("profile_id", authData.user.id)
    .eq("status", "ACTIVE")
    .limit(1)
    .maybeSingle();
  const membershipMs = Math.round(performance.now() - membershipStartedAt);
  if (!membership) return null;

  const organizationStartedAt = performance.now();
  const [{ data: role }, { data: organization }] = await Promise.all([
    supabase.from("roles").select("key").eq("id", membership.role_id).maybeSingle(),
    supabase.from("organizations").select("name, timezone").eq("id", membership.organization_id).maybeSingle()
  ]);
  const organizationMs = Math.round(performance.now() - organizationStartedAt);
  if (process.env.NODE_ENV !== "production" || process.env.ADMIN_PERF_LOGS === "1") {
    console.info(`[PERF adminContext]\n  auth: ${String(authMs)}ms\n  membership: ${String(membershipMs)}ms\n  roleAndOrganization: ${String(organizationMs)}ms\n  total: ${String(Math.round(performance.now() - startedAt))}ms`);
  }
  if (role?.key !== "admin" || !organization) return null;

  return {
    userId: authData.user.id,
    email: authData.user.email ?? authData.user.id,
    organizationId: membership.organization_id,
    organizationName: organization.name,
    timezone: organization.timezone
  };
});

export async function requireAdminContext(): Promise<AdminContext> {
  const context = await getAdminContext();
  if (!context) throw new Error("Esta operación requiere el rol administrador");
  return context;
}
