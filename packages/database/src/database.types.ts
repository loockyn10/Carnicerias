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
          device_id: string | null;
          sync_event_id: string | null;
          cancellation_key: string | null;
          cancelled_at: Timestamp | null;
          cancelled_by: string | null;
          cancellation_reason: string | null;
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
          device_id?: string | null;
          sync_event_id?: string | null;
          cancellation_key?: string | null;
          cancelled_at?: Timestamp | null;
          cancelled_by?: string | null;
          cancellation_reason?: string | null;
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
          stock_operation_id: string | null;
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
          stock_operation_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["stock_movements"]["Insert"]>;
        Relationships: [];
      };
      pos_devices: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          label: string | null;
          status: "ACTIVE" | "DISABLED";
          registered_by: string;
          registered_at: Timestamp;
          last_seen_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id: string;
          organization_id: string;
          branch_id: string;
          label?: string | null;
          status?: "ACTIVE" | "DISABLED";
          registered_by: string;
          registered_at?: Timestamp;
          last_seen_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["pos_devices"]["Insert"]>;
        Relationships: [];
      };
      pos_sync_receipts: {
        Row: {
          event_id: string;
          sale_id: string;
          device_id: string;
          payload_hash: string;
          received_at: Timestamp;
        };
        Insert: {
          event_id: string;
          sale_id: string;
          device_id: string;
          payload_hash: string;
          received_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["pos_sync_receipts"]["Insert"]>;
        Relationships: [];
      };
      pos_catalog_changes: {
        Row: {
          sequence: number;
          organization_id: string;
          branch_id: string | null;
          entity_type: "BRANCH" | "CATEGORY" | "PRODUCT" | "PRICE";
          entity_id: string;
          changed_at: Timestamp;
        };
        Insert: {
          sequence?: number;
          organization_id: string;
          branch_id?: string | null;
          entity_type: "BRANCH" | "CATEGORY" | "PRODUCT" | "PRICE";
          entity_id: string;
          changed_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["pos_catalog_changes"]["Insert"]>;
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string | null;
          actor_profile_id: string | null;
          event_type: string;
          entity_type: string;
          entity_id: string | null;
          before_data: Json | null;
          after_data: Json | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id?: string | null;
          actor_profile_id?: string | null;
          event_type: string;
          entity_type: string;
          entity_id?: string | null;
          before_data?: Json | null;
          after_data?: Json | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["audit_logs"]["Insert"]>;
        Relationships: [];
      };
      branch_product_stock_settings: {
        Row: {
          organization_id: string;
          branch_id: string;
          product_id: string;
          minimum_stock_grams: number;
          target_stock_grams: number;
          updated_by: string;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          organization_id: string;
          branch_id: string;
          product_id: string;
          minimum_stock_grams?: number;
          target_stock_grams?: number;
          updated_by: string;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["branch_product_stock_settings"]["Insert"]>;
        Relationships: [];
      };
      stock_operations: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          operation_type: "PURCHASE" | "WASTE" | "ADJUSTMENT";
          supplier: string | null;
          waste_reason: "DISCARD" | "EXPIRY" | "TRIMMING" | "DETERIORATION" | "INVENTORY_DIFFERENCE" | "OTHER" | null;
          note: string | null;
          occurred_at: Timestamp;
          actor_profile_id: string;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          operation_type: "PURCHASE" | "WASTE" | "ADJUSTMENT";
          supplier?: string | null;
          waste_reason?: "DISCARD" | "EXPIRY" | "TRIMMING" | "DETERIORATION" | "INVENTORY_DIFFERENCE" | "OTHER" | null;
          note?: string | null;
          occurred_at?: Timestamp;
          actor_profile_id: string;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["stock_operations"]["Insert"]>;
        Relationships: [];
      };
      stock_operation_items: {
        Row: {
          id: string;
          operation_id: string;
          organization_id: string;
          branch_id: string;
          product_id: string;
          quantity_grams: number;
          system_quantity_before_grams: number | null;
          physical_quantity_grams: number | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          operation_id: string;
          organization_id: string;
          branch_id: string;
          product_id: string;
          quantity_grams: number;
          system_quantity_before_grams?: number | null;
          physical_quantity_grams?: number | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["stock_operation_items"]["Insert"]>;
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
      branch_stock_status: {
        Row: {
          organization_id: string | null;
          branch_id: string | null;
          branch_name: string | null;
          product_id: string | null;
          product_name: string | null;
          sku: string | null;
          current_stock_grams: number | null;
          minimum_stock_grams: number | null;
          target_stock_grams: number | null;
          suggested_replenishment_grams: number | null;
          stock_status: string | null;
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
      register_pos_device: {
        Args: { p_device_id: string; p_branch_id: string; p_label?: string | null };
        Returns: Json;
      };
      pull_pos_state: {
        Args: { p_device_id: string; p_after_sequence?: number };
        Returns: Json;
      };
      sync_offline_sale: {
        Args: { p_device_id: string; p_event_id: string; p_payload: Json };
        Returns: Json;
      };
      save_category: {
        Args: { p_category_id: string | null; p_name: string; p_slug: string; p_sort_order?: number; p_active?: boolean };
        Returns: string;
      };
      save_product: {
        Args: { p_product_id: string | null; p_category_id: string; p_name: string; p_slug: string; p_sku: string; p_unit_type: "WEIGHT" | "UNIT"; p_active?: boolean };
        Returns: string;
      };
      set_product_price: {
        Args: { p_product_id: string; p_branch_id: string | null; p_price_cents: number | null; p_effective_at?: string };
        Returns: string | null;
      };
      set_stock_policy: {
        Args: { p_branch_id: string; p_product_id: string; p_minimum_stock_grams: number; p_target_stock_grams: number };
        Returns: undefined;
      };
      record_stock_operation: {
        Args: { p_branch_id: string; p_operation_type: string; p_items: Json; p_supplier?: string | null; p_waste_reason?: string | null; p_note?: string | null; p_occurred_at?: string };
        Returns: string;
      };
      cancel_sale: {
        Args: { p_sale_id: string; p_idempotency_key: string; p_reason: string };
        Returns: Json;
      };
      manage_existing_member: {
        Args: { p_email: string; p_display_name: string; p_role_key: string; p_branch_id: string | null; p_status?: "INVITED" | "ACTIVE" | "DISABLED" };
        Returns: string;
      };
      list_organization_members: {
        Args: Record<never, never>;
        Returns: { profile_id: string; display_name: string; email: string; role_key: string; status: "INVITED" | "ACTIVE" | "DISABLED"; branch_id: string | null; branch_name: string | null }[];
      };
      set_pos_device_status: {
        Args: { p_device_id: string; p_status: "ACTIVE" | "DISABLED" };
        Returns: undefined;
      };
      get_admin_dashboard: {
        Args: { p_branch_id?: string | null };
        Returns: Json;
      };
      get_pos_commercial_config: {
        Args: { p_branch_id: string };
        Returns: Json;
      };
      complete_discounted_sale: {
        Args: { p_branch_id: string; p_items: Json; p_payment_method: string };
        Returns: { sale_id: string; total_cents: number; total_weight_grams: number; completed_at: Timestamp }[];
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
      pos_device_status: "ACTIVE" | "DISABLED";
      stock_operation_type: "PURCHASE" | "WASTE" | "ADJUSTMENT";
      waste_reason: "DISCARD" | "EXPIRY" | "TRIMMING" | "DETERIORATION" | "INVENTORY_DIFFERENCE" | "OTHER";
    };
    CompositeTypes: Record<never, never>;
  };
}
