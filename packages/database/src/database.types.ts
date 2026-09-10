/**
 * Checked-in bootstrap types for Phase 1A. Regenerate from the local database
 * with `pnpm db:types` whenever a migration changes the schema.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type Timestamp = string;

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          currency: string;
          timezone: string;
          active: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          currency?: string;
          timezone?: string;
          active?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["organizations"]["Insert"]>;
        Relationships: [];
      };
      branches: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          code: string;
          address: string | null;
          active: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          code: string;
          address?: string | null;
          active?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["branches"]["Insert"]>;
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          display_name: string;
          active: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id: string;
          display_name: string;
          active?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      roles: {
        Row: {
          id: string;
          organization_id: string | null;
          key: string;
          name: string;
          description: string | null;
          is_system: boolean;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          key: string;
          name: string;
          description?: string | null;
          is_system?: boolean;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["roles"]["Insert"]>;
        Relationships: [];
      };
      permissions: {
        Row: { key: string; description: string; created_at: Timestamp };
        Insert: { key: string; description: string; created_at?: Timestamp };
        Update: Partial<Database["public"]["Tables"]["permissions"]["Insert"]>;
        Relationships: [];
      };
      role_permissions: {
        Row: { role_id: string; permission_key: string; created_at: Timestamp };
        Insert: { role_id: string; permission_key: string; created_at?: Timestamp };
        Update: Partial<Database["public"]["Tables"]["role_permissions"]["Insert"]>;
        Relationships: [];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          profile_id: string;
          role_id: string;
          status: "INVITED" | "ACTIVE" | "DISABLED";
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          profile_id: string;
          role_id: string;
          status?: "INVITED" | "ACTIVE" | "DISABLED";
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["organization_members"]["Insert"]>;
        Relationships: [];
      };
      branch_members: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          profile_id: string;
          active: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          profile_id: string;
          active?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["branch_members"]["Insert"]>;
        Relationships: [];
      };
      categories: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          slug: string;
          sort_order: number;
          active: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          slug: string;
          sort_order?: number;
          active?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["categories"]["Insert"]>;
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          organization_id: string;
          category_id: string | null;
          name: string;
          slug: string;
          sku: string | null;
          unit_type: "WEIGHT" | "UNIT";
          active: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          category_id?: string | null;
          name: string;
          slug: string;
          sku?: string | null;
          unit_type?: "WEIGHT" | "UNIT";
          active?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Insert"]>;
        Relationships: [];
      };
      product_prices: {
        Row: {
          id: string;
          organization_id: string;
          product_id: string;
          branch_id: string | null;
          price_cents: number;
          valid_from: Timestamp;
          valid_to: Timestamp | null;
          created_by: string | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          product_id: string;
          branch_id?: string | null;
          price_cents: number;
          valid_from?: Timestamp;
          valid_to?: Timestamp | null;
          created_by?: string | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["product_prices"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: {
      unit_type: "WEIGHT" | "UNIT";
      membership_status: "INVITED" | "ACTIVE" | "DISABLED";
    };
    CompositeTypes: Record<never, never>;
  };
}
