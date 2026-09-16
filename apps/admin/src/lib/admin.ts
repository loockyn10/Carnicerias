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

// Embedded via the organization_members -> roles / organizations foreign keys so
// PostgREST resolves membership + role + organization in a single round trip
// instead of three (the lightweight database.types.ts has no Relationships
// metadata for this table, so the embed result needs a manual shape here).
interface MembershipWithRoleAndOrganization {
  organization_id: string;
  role: { key: string } | null;
  organization: { name: string; timezone: string } | null;
}

export const getAdminContext = cache(async (): Promise<AdminContext | null> => {
  const startedAt = performance.now();
  const supabase = await createClient();
  const authStartedAt = performance.now();
  const { data: authData } = await supabase.auth.getUser();
  const authMs = Math.round(performance.now() - authStartedAt);
  if (!authData.user) redirect("/login");

  const membershipStartedAt = performance.now();
  const { data: membershipRow } = await supabase
    .from("organization_members")
    .select("organization_id, role:roles(key), organization:organizations(name, timezone)")
    .eq("profile_id", authData.user.id)
    .eq("status", "ACTIVE")
    .limit(1)
    .maybeSingle();
  const membership = membershipRow as unknown as MembershipWithRoleAndOrganization | null;
  const membershipMs = Math.round(performance.now() - membershipStartedAt);
  if (process.env.NODE_ENV !== "production" || process.env.ADMIN_PERF_LOGS === "1") {
    console.info(`[PERF adminContext]\n  auth: ${String(authMs)}ms\n  membershipRoleAndOrganization: ${String(membershipMs)}ms\n  total: ${String(Math.round(performance.now() - startedAt))}ms`);
  }
  if (!membership || membership.role?.key !== "admin" || !membership.organization) return null;

  return {
    userId: authData.user.id,
    email: authData.user.email ?? authData.user.id,
    organizationId: membership.organization_id,
    organizationName: membership.organization.name,
    timezone: membership.organization.timezone
  };
});

export async function requireAdminContext(): Promise<AdminContext> {
  const context = await getAdminContext();
  if (!context) throw new Error("Esta operación requiere el rol administrador");
  return context;
}
