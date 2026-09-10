/**
 * Checked-in Supabase types. Regenerate from the local database
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
      sales: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          profile_id: string;
          status: "DRAFT" | "COMPLETED" | "CANCELLED" | "REFUNDED";
          total_cents: number;
          total_weight_grams: number;
          created_at: Timestamp;
          completed_at: Timestamp | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          profile_id: string;
          status?: "DRAFT" | "COMPLETED" | "CANCELLED" | "REFUNDED";
          total_cents?: number;
          total_weight_grams?: number;
          created_at?: Timestamp;
          completed_at?: Timestamp | null;
        };
        Update: Partial<Database["public"]["Tables"]["sales"]["Insert"]>;
        Relationships: [];
      };
      sale_items: {
        Row: {
          id: string;
          sale_id: string;
          organization_id: string;
          branch_id: string;
          product_id: string;
          product_name_snapshot: string;
          weight_grams: number;
          price_per_kg_cents: number;
          subtotal_cents: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          sale_id: string;
          organization_id: string;
          branch_id: string;
          product_id: string;
          product_name_snapshot: string;
          weight_grams: number;
          price_per_kg_cents: number;
          subtotal_cents: number;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["sale_items"]["Insert"]>;
        Relationships: [];
      };
      payments: {
        Row: {
          id: string;
          sale_id: string;
          organization_id: string;
          branch_id: string;
          method: "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER";
          amount_cents: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          sale_id: string;
          organization_id: string;
          branch_id: string;
          method: "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER";
          amount_cents: number;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["payments"]["Insert"]>;
        Relationships: [];
      };
      stock_movements: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          product_id: string;
          type:
            | "PURCHASE"
            | "SALE"
            | "WASTE"
            | "ADJUSTMENT_POSITIVE"
            | "ADJUSTMENT_NEGATIVE"
            | "TRANSFER_IN"
            | "TRANSFER_OUT"
            | "RETURN";
          quantity_grams: number;
          sale_id: string | null;
          reason: string | null;
          profile_id: string;
          occurred_at: Timestamp;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          product_id: string;
          type:
            | "PURCHASE"
            | "SALE"
            | "WASTE"
            | "ADJUSTMENT_POSITIVE"
            | "ADJUSTMENT_NEGATIVE"
            | "TRANSFER_IN"
            | "TRANSFER_OUT"
            | "RETURN";
          quantity_grams: number;
          sale_id?: string | null;
          reason?: string | null;
          profile_id: string;
          occurred_at?: Timestamp;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["stock_movements"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      stock_levels: {
        Row: {
          organization_id: string | null;
          branch_id: string | null;
          product_id: string | null;
          quantity_grams: number | null;
          last_movement_at: Timestamp | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      get_pos_catalog: {
        Args: { p_branch_id: string };
        Returns: {
          organization_id: string;
          branch_id: string;
          branch_name: string;
          category_id: string;
          category_name: string;
          category_sort_order: number;
          product_id: string;
          product_name: string;
          product_sku: string | null;
          unit_type: "WEIGHT" | "UNIT";
          price_per_kg_cents: number;
          price_valid_from: Timestamp;
        }[];
      };
      complete_sale: {
        Args: {
          p_branch_id: string;
          p_items: Json;
          p_payment_method: string;
        };
        Returns: {
          sale_id: string;
          total_cents: number;
          total_weight_grams: number;
          completed_at: Timestamp;
        }[];
      };
    };
    Enums: {
      unit_type: "WEIGHT" | "UNIT";
      membership_status: "INVITED" | "ACTIVE" | "DISABLED";
      sale_status: "DRAFT" | "COMPLETED" | "CANCELLED" | "REFUNDED";
      payment_method: "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER";
      stock_movement_type:
        | "PURCHASE"
        | "SALE"
        | "WASTE"
        | "ADJUSTMENT_POSITIVE"
        | "ADJUSTMENT_NEGATIVE"
        | "TRANSFER_IN"
        | "TRANSFER_OUT"
        | "RETURN";
    };
    CompositeTypes: Record<never, never>;
  };
}
