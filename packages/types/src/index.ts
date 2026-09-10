export const SYSTEM_ROLE_KEYS = ["admin", "employee"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const UNIT_TYPES = ["WEIGHT", "UNIT"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export type EntityId = string;

export interface OrganizationSummary {
  id: EntityId;
  name: string;
  slug: string;
  currency: "ARS";
  timezone: string;
}

export interface BranchSummary {
  id: EntityId;
  organizationId: EntityId;
  name: string;
  code: string;
  active: boolean;
}

export interface ProductSummary {
  id: EntityId;
  organizationId: EntityId;
  categoryId: EntityId | null;
  name: string;
  sku: string | null;
  unitType: UnitType;
  active: boolean;
}
