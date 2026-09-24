export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      announcements: {
        Row: {
          active: boolean
          branch_id: string | null
          created_at: string
          created_by: string
          ends_at: string | null
          id: string
          message: string
          organization_id: string
          priority: number
          starts_at: string
          title: string
          type: Database["public"]["Enums"]["announcement_type"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          created_by: string
          ends_at?: string | null
          id?: string
          message: string
          organization_id: string
          priority?: number
          starts_at?: string
          title: string
          type?: Database["public"]["Enums"]["announcement_type"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string
          ends_at?: string | null
          id?: string
          message?: string
          organization_id?: string
          priority?: number
          starts_at?: string
          title?: string
          type?: Database["public"]["Enums"]["announcement_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "announcements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "announcements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          actor_profile_id: string | null
          after_data: Json | null
          before_data: Json | null
          branch_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          event_type: string
          id: string
          organization_id: string
        }
        Insert: {
          actor_profile_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          branch_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          event_type: string
          id?: string
          organization_id: string
        }
        Update: {
          actor_profile_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          branch_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          event_type?: string
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "audit_logs_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_members: {
        Row: {
          active: boolean
          branch_id: string
          created_at: string
          id: string
          organization_id: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          branch_id: string
          created_at?: string
          id?: string
          organization_id: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          branch_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_members_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "branch_members_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_members_organization_id_profile_id_fkey"
            columns: ["organization_id", "profile_id"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["organization_id", "profile_id"]
          },
        ]
      }
      branch_product_stock_settings: {
        Row: {
          branch_id: string
          created_at: string
          minimum_stock_grams: number
          organization_id: string
          product_id: string
          target_stock_grams: number
          updated_at: string
          updated_by: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          minimum_stock_grams?: number
          organization_id: string
          product_id: string
          target_stock_grams?: number
          updated_at?: string
          updated_by: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          minimum_stock_grams?: number
          organization_id?: string
          product_id?: string
          target_stock_grams?: number
          updated_at?: string
          updated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_product_stock_settings_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "branch_product_stock_settings_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_product_stock_settings_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_product_stock_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          active: boolean
          address: string | null
          code: string
          created_at: string
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          code: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          code?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          active: boolean
          color_hex: string | null
          created_at: string
          id: string
          name: string
          organization_id: string
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          color_hex?: string | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          color_hex?: string | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_hourly_rates: {
        Row: {
          created_at: string
          created_by: string
          employee_id: string
          id: string
          organization_id: string
          rate_cents_per_hour: number
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          employee_id: string
          id?: string
          organization_id: string
          rate_cents_per_hour: number
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          employee_id?: string
          id?: string
          organization_id?: string
          rate_cents_per_hour?: number
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_hourly_rates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_hourly_rates_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_hourly_rates_organization_id_employee_id_fkey"
            columns: ["organization_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["organization_id", "profile_id"]
          },
        ]
      }
      employee_pos_pins: {
        Row: {
          created_at: string
          organization_id: string
          pin_hash: string
          profile_id: string
          updated_at: string
          updated_by: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          pin_hash: string
          profile_id: string
          updated_at?: string
          updated_by: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          pin_hash?: string
          profile_id?: string
          updated_at?: string
          updated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_pos_pins_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_pos_pins_organization_id_profile_id_fkey"
            columns: ["organization_id", "profile_id"]
            isOneToOne: true
            referencedRelation: "organization_members"
            referencedColumns: ["organization_id", "profile_id"]
          },
          {
            foreignKeyName: "employee_pos_pins_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_pos_pins_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_shifts: {
        Row: {
          branch_id: string
          clock_in_at: string
          clock_in_received_at: string
          clock_in_source: Database["public"]["Enums"]["time_event_source"]
          clock_out_at: string | null
          clock_out_received_at: string | null
          clock_out_source:
            | Database["public"]["Enums"]["time_event_source"]
            | null
          corrected_at: string | null
          corrected_by: string | null
          correction_reason: string | null
          created_at: string
          device_id: string
          employee_id: string
          id: string
          organization_id: string
          status: Database["public"]["Enums"]["employee_shift_status"]
          updated_at: string
        }
        Insert: {
          branch_id: string
          clock_in_at: string
          clock_in_received_at: string
          clock_in_source: Database["public"]["Enums"]["time_event_source"]
          clock_out_at?: string | null
          clock_out_received_at?: string | null
          clock_out_source?:
            | Database["public"]["Enums"]["time_event_source"]
            | null
          corrected_at?: string | null
          corrected_by?: string | null
          correction_reason?: string | null
          created_at?: string
          device_id: string
          employee_id: string
          id: string
          organization_id: string
          status?: Database["public"]["Enums"]["employee_shift_status"]
          updated_at?: string
        }
        Update: {
          branch_id?: string
          clock_in_at?: string
          clock_in_received_at?: string
          clock_in_source?: Database["public"]["Enums"]["time_event_source"]
          clock_out_at?: string | null
          clock_out_received_at?: string | null
          clock_out_source?:
            | Database["public"]["Enums"]["time_event_source"]
            | null
          corrected_at?: string | null
          corrected_by?: string | null
          correction_reason?: string | null
          created_at?: string
          device_id?: string
          employee_id?: string
          id?: string
          organization_id?: string
          status?: Database["public"]["Enums"]["employee_shift_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_shifts_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "employee_shifts_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "employee_shifts_corrected_by_fkey"
            columns: ["corrected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_shifts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_shifts_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_time_events: {
        Row: {
          action: Database["public"]["Enums"]["time_event_action"]
          branch_id: string
          created_at: string
          device_id: string
          employee_id: string
          event_id: string
          occurred_at: string
          organization_id: string
          received_at: string
          shift_id: string
          source: Database["public"]["Enums"]["time_event_source"]
        }
        Insert: {
          action: Database["public"]["Enums"]["time_event_action"]
          branch_id: string
          created_at?: string
          device_id: string
          employee_id: string
          event_id: string
          occurred_at: string
          organization_id: string
          received_at?: string
          shift_id: string
          source: Database["public"]["Enums"]["time_event_source"]
        }
        Update: {
          action?: Database["public"]["Enums"]["time_event_action"]
          branch_id?: string
          created_at?: string
          device_id?: string
          employee_id?: string
          event_id?: string
          occurred_at?: string
          organization_id?: string
          received_at?: string
          shift_id?: string
          source?: Database["public"]["Enums"]["time_event_source"]
        }
        Relationships: [
          {
            foreignKeyName: "employee_time_events_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "employee_time_events_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "employee_time_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_time_events_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_time_events_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "employee_shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_cash_discounts: {
        Row: {
          cash_discount_bps: number
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          cash_discount_bps: number
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          cash_discount_bps?: number
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_cash_discounts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_cash_discounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          profile_id: string
          role_id: string
          status: Database["public"]["Enums"]["membership_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          profile_id: string
          role_id: string
          status?: Database["public"]["Enums"]["membership_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          profile_id?: string
          role_id?: string
          status?: Database["public"]["Enums"]["membership_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          id: string
          max_shift_hours: number
          name: string
          production_branch_id: string | null
          replenishment_target_days: number
          slug: string
          timezone: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          id?: string
          max_shift_hours?: number
          name: string
          production_branch_id?: string | null
          replenishment_target_days?: number
          slug: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          id?: string
          max_shift_hours?: number
          name?: string
          production_branch_id?: string | null
          replenishment_target_days?: number
          slug?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_production_branch_id_fkey"
            columns: ["production_branch_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "organizations_production_branch_id_fkey"
            columns: ["production_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          branch_id: string
          created_at: string
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          organization_id: string
          sale_id: string
        }
        Insert: {
          amount_cents: number
          branch_id: string
          created_at?: string
          id?: string
          method: Database["public"]["Enums"]["payment_method"]
          organization_id: string
          sale_id: string
        }
        Update: {
          amount_cents?: number
          branch_id?: string
          created_at?: string
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          organization_id?: string
          sale_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_sale_id_organization_id_branch_id_fkey"
            columns: ["sale_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
        ]
      }
      permissions: {
        Row: {
          created_at: string
          description: string
          key: string
        }
        Insert: {
          created_at?: string
          description: string
          key: string
        }
        Update: {
          created_at?: string
          description?: string
          key?: string
        }
        Relationships: []
      }
      pos_catalog_changes: {
        Row: {
          branch_id: string | null
          changed_at: string
          entity_id: string
          entity_type: string
          organization_id: string
          sequence: number
        }
        Insert: {
          branch_id?: string | null
          changed_at?: string
          entity_id: string
          entity_type: string
          organization_id: string
          sequence?: never
        }
        Update: {
          branch_id?: string | null
          changed_at?: string
          entity_id?: string
          entity_type?: string
          organization_id?: string
          sequence?: never
        }
        Relationships: [
          {
            foreignKeyName: "pos_catalog_changes_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "pos_catalog_changes_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "pos_catalog_changes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_devices: {
        Row: {
          branch_id: string
          id: string
          label: string | null
          last_seen_at: string
          organization_id: string
          registered_at: string
          registered_by: string
          status: Database["public"]["Enums"]["pos_device_status"]
          updated_at: string
        }
        Insert: {
          branch_id: string
          id: string
          label?: string | null
          last_seen_at?: string
          organization_id: string
          registered_at?: string
          registered_by: string
          status?: Database["public"]["Enums"]["pos_device_status"]
          updated_at?: string
        }
        Update: {
          branch_id?: string
          id?: string
          label?: string | null
          last_seen_at?: string
          organization_id?: string
          registered_at?: string
          registered_by?: string
          status?: Database["public"]["Enums"]["pos_device_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_devices_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "pos_devices_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "pos_devices_registered_by_fkey"
            columns: ["registered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_operator_grants: {
        Row: {
          branch_id: string
          device_id: string
          id: string
          issued_at: string
          issued_by: string
          operator_profile_id: string
          organization_id: string
          revoked_at: string | null
          token_hash: string
          valid_until: string
        }
        Insert: {
          branch_id: string
          device_id: string
          id?: string
          issued_at?: string
          issued_by: string
          operator_profile_id: string
          organization_id: string
          revoked_at?: string | null
          token_hash: string
          valid_until: string
        }
        Update: {
          branch_id?: string
          device_id?: string
          id?: string
          issued_at?: string
          issued_by?: string
          operator_profile_id?: string
          organization_id?: string
          revoked_at?: string | null
          token_hash?: string
          valid_until?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_operator_grants_device_id_organization_id_branch_id_fkey"
            columns: ["device_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
          {
            foreignKeyName: "pos_operator_grants_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_operator_grants_operator_profile_id_fkey"
            columns: ["operator_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_operator_grants_organization_id_operator_profile_id_fkey"
            columns: ["organization_id", "operator_profile_id"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["organization_id", "profile_id"]
          },
        ]
      }
      pos_pin_attempts: {
        Row: {
          device_id: string
          failed_attempts: number
          locked_until: string | null
          profile_id: string
          updated_at: string
        }
        Insert: {
          device_id: string
          failed_attempts?: number
          locked_until?: string | null
          profile_id: string
          updated_at?: string
        }
        Update: {
          device_id?: string
          failed_attempts?: number
          locked_until?: string | null
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_pin_attempts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_pin_attempts_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_sync_receipts: {
        Row: {
          device_id: string
          event_id: string
          payload_hash: string
          received_at: string
          sale_id: string
        }
        Insert: {
          device_id: string
          event_id: string
          payload_hash: string
          received_at?: string
          sale_id: string
        }
        Update: {
          device_id?: string
          event_id?: string
          payload_hash?: string
          received_at?: string
          sale_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_sync_receipts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      product_costs: {
        Row: {
          cost_cents: number
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          product_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          cost_cents: number
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          product_id: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          cost_cents?: number
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          product_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_costs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_costs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_costs_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_prices: {
        Row: {
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          price_cents: number
          product_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          price_cents: number
          product_id: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          price_cents?: number
          product_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_prices_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "product_prices_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_prices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_prices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_prices_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_pricing_settings: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          product_id: string
          profit_markup_bps: number
          updated_at: string
          updated_by: string | null
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          product_id: string
          profit_markup_bps: number
          updated_at?: string
          updated_by?: string | null
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          product_id?: string
          profit_markup_bps?: number
          updated_at?: string
          updated_by?: string | null
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_pricing_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_pricing_settings_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_pricing_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      product_restock_events: {
        Row: {
          announcement_id: string | null
          branch_id: string
          id: string
          occurred_at: string
          organization_id: string
          product_id: string
          stock_movement_id: string
        }
        Insert: {
          announcement_id?: string | null
          branch_id: string
          id?: string
          occurred_at?: string
          organization_id: string
          product_id: string
          stock_movement_id: string
        }
        Update: {
          announcement_id?: string | null
          branch_id?: string
          id?: string
          occurred_at?: string
          organization_id?: string
          product_id?: string
          stock_movement_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_restock_events_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_restock_events_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "product_restock_events_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_restock_events_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_restock_events_stock_movement_id_fkey"
            columns: ["stock_movement_id"]
            isOneToOne: true
            referencedRelation: "stock_movements"
            referencedColumns: ["id"]
          },
        ]
      }
      product_category_assignments: {
        Row: {
          category_id: string
          created_at: string
          id: string
          organization_id: string
          product_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          organization_id: string
          product_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_category_assignments_category_id_organization_id_fkey"
            columns: ["category_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_category_assignments_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_weight_discounts: {
        Row: {
          active: boolean
          branch_id: string | null
          created_at: string
          discount_type: Database["public"]["Enums"]["weight_discount_type"] | null
          discount_value: number | null
          id: string
          minimum_grams: number | null
          organization_id: string
          pack_price_cents: number | null
          pack_quantity_grams: number | null
          pack_quantity_units: number | null
          product_id: string
          promotion_mode: Database["public"]["Enums"]["promotion_mode"]
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          discount_type?: Database["public"]["Enums"]["weight_discount_type"] | null
          discount_value?: number | null
          id?: string
          minimum_grams?: number | null
          organization_id: string
          pack_price_cents?: number | null
          pack_quantity_grams?: number | null
          pack_quantity_units?: number | null
          product_id: string
          promotion_mode?: Database["public"]["Enums"]["promotion_mode"]
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          discount_type?: Database["public"]["Enums"]["weight_discount_type"] | null
          discount_value?: number | null
          id?: string
          minimum_grams?: number | null
          organization_id?: string
          pack_price_cents?: number | null
          pack_quantity_grams?: number | null
          pack_quantity_units?: number | null
          product_id?: string
          promotion_mode?: Database["public"]["Enums"]["promotion_mode"]
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_weight_discounts_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "product_weight_discounts_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_weight_discounts_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      production_batch_outputs: {
        Row: {
          allocated_cost_cents_snapshot: number | null
          batch_id: string
          branch_id: string
          created_at: string
          id: string
          organization_id: string
          output_quantity_units: number | null
          output_weight_grams: number
          product_id: string
          sale_price_cents_snapshot: number | null
          sale_value_cents_snapshot: number | null
          updated_at: string
        }
        Insert: {
          allocated_cost_cents_snapshot?: number | null
          batch_id: string
          branch_id: string
          created_at?: string
          id?: string
          organization_id: string
          output_quantity_units?: number | null
          output_weight_grams: number
          product_id: string
          sale_price_cents_snapshot?: number | null
          sale_value_cents_snapshot?: number | null
          updated_at?: string
        }
        Update: {
          allocated_cost_cents_snapshot?: number | null
          batch_id?: string
          branch_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          output_quantity_units?: number | null
          output_weight_grams?: number
          product_id?: string
          sale_price_cents_snapshot?: number | null
          sale_value_cents_snapshot?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_batch_outputs_batch_id_organization_id_branch_i_fkey"
            columns: ["batch_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "production_batches"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
          {
            foreignKeyName: "production_batch_outputs_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      production_batches: {
        Row: {
          branch_id: string
          cancelled_at: string | null
          cancelled_by: string | null
          completed_at: string | null
          completed_by: string | null
          cost_per_kg_cents: number
          cost_total_cents: number
          created_at: string
          created_by: string
          description: string | null
          id: string
          input_unit_count: number | null
          input_weight_grams: number
          notes: string | null
          organization_id: string
          produced_weight_grams: number | null
          source_product_id: string
          status: Database["public"]["Enums"]["production_batch_status"]
          total_sale_value_cents: number | null
          updated_at: string
          waste_grams: number | null
        }
        Insert: {
          branch_id: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          cost_per_kg_cents: number
          cost_total_cents: number
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          input_unit_count?: number | null
          input_weight_grams: number
          notes?: string | null
          organization_id: string
          produced_weight_grams?: number | null
          source_product_id: string
          status?: Database["public"]["Enums"]["production_batch_status"]
          total_sale_value_cents?: number | null
          updated_at?: string
          waste_grams?: number | null
        }
        Update: {
          branch_id?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          cost_per_kg_cents?: number
          cost_total_cents?: number
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          input_unit_count?: number | null
          input_weight_grams?: number
          notes?: string | null
          organization_id?: string
          produced_weight_grams?: number | null
          source_product_id?: string
          status?: Database["public"]["Enums"]["production_batch_status"]
          total_sale_value_cents?: number | null
          updated_at?: string
          waste_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "production_batches_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "production_batches_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "production_batches_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_batches_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_batches_source_product_id_organization_id_fkey"
            columns: ["source_product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          approx_weight_grams: number | null
          category_id: string | null
          created_at: string
          id: string
          inventory_role: Database["public"]["Enums"]["product_inventory_role"]
          name: string
          organization_id: string
          sku: string | null
          slug: string
          unit_type: Database["public"]["Enums"]["unit_type"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          approx_weight_grams?: number | null
          category_id?: string | null
          created_at?: string
          id?: string
          inventory_role?: Database["public"]["Enums"]["product_inventory_role"]
          name: string
          organization_id: string
          sku?: string | null
          slug: string
          unit_type?: Database["public"]["Enums"]["unit_type"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          approx_weight_grams?: number | null
          category_id?: string | null
          created_at?: string
          id?: string
          inventory_role?: Database["public"]["Enums"]["product_inventory_role"]
          name?: string
          organization_id?: string
          sku?: string | null
          slug?: string
          unit_type?: Database["public"]["Enums"]["unit_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_organization_id_fkey"
            columns: ["category_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "products_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          auth_user_id: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          auth_user_id?: string | null
          created_at?: string
          display_name: string
          id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          auth_user_id?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          created_at: string
          permission_key: string
          role_id: string
        }
        Insert: {
          created_at?: string
          permission_key: string
          role_id: string
        }
        Update: {
          created_at?: string
          permission_key?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_key_fkey"
            columns: ["permission_key"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          key: string
          name: string
          organization_id: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          key: string
          name: string
          organization_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          key?: string
          name?: string
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_items: {
        Row: {
          branch_id: string
          card_surcharge_cents: number
          cash_discount_bps: number
          cash_discount_cents: number
          cost_cents_snapshot: number | null
          created_at: string
          discount_cents: number
          discount_rule_id: string | null
          discount_type:
            | Database["public"]["Enums"]["weight_discount_type"]
            | null
          discount_value: number | null
          final_price_per_kg_cents: number
          id: string
          organization_id: string
          original_price_per_kg_cents: number
          price_per_kg_cents: number
          product_id: string
          product_name_snapshot: string
          profit_markup_bps_snapshot: number | null
          promotion_discount_cents: number
          promotion_mode: Database["public"]["Enums"]["promotion_mode"] | null
          quantity_units: number | null
          sale_id: string
          subtotal_cents: number
          weight_grams: number | null
        }
        Insert: {
          branch_id: string
          card_surcharge_cents?: number
          cash_discount_bps?: number
          cash_discount_cents?: number
          cost_cents_snapshot?: number | null
          created_at?: string
          discount_cents?: number
          discount_rule_id?: string | null
          discount_type?:
            | Database["public"]["Enums"]["weight_discount_type"]
            | null
          discount_value?: number | null
          final_price_per_kg_cents: number
          id?: string
          organization_id: string
          original_price_per_kg_cents: number
          price_per_kg_cents: number
          product_id: string
          product_name_snapshot: string
          profit_markup_bps_snapshot?: number | null
          promotion_discount_cents?: number
          promotion_mode?: Database["public"]["Enums"]["promotion_mode"] | null
          quantity_units?: number | null
          sale_id: string
          subtotal_cents: number
          weight_grams?: number | null
        }
        Update: {
          branch_id?: string
          card_surcharge_cents?: number
          cash_discount_bps?: number
          cash_discount_cents?: number
          cost_cents_snapshot?: number | null
          created_at?: string
          discount_cents?: number
          discount_rule_id?: string | null
          discount_type?:
            | Database["public"]["Enums"]["weight_discount_type"]
            | null
          discount_value?: number | null
          final_price_per_kg_cents?: number
          id?: string
          organization_id?: string
          original_price_per_kg_cents?: number
          price_per_kg_cents?: number
          product_id?: string
          product_name_snapshot?: string
          profit_markup_bps_snapshot?: number | null
          promotion_discount_cents?: number
          promotion_mode?: Database["public"]["Enums"]["promotion_mode"] | null
          quantity_units?: number | null
          sale_id?: string
          subtotal_cents?: number
          weight_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_discount_rule_id_fkey"
            columns: ["discount_rule_id"]
            isOneToOne: false
            referencedRelation: "product_weight_discounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_organization_id_branch_id_fkey"
            columns: ["sale_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
        ]
      }
      sales: {
        Row: {
          branch_id: string
          cancellation_key: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          completed_at: string | null
          created_at: string
          device_id: string | null
          id: string
          organization_id: string
          profile_id: string
          status: Database["public"]["Enums"]["sale_status"]
          sync_event_id: string | null
          total_cents: number
          total_weight_grams: number
        }
        Insert: {
          branch_id: string
          cancellation_key?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          created_at?: string
          device_id?: string | null
          id?: string
          organization_id: string
          profile_id: string
          status?: Database["public"]["Enums"]["sale_status"]
          sync_event_id?: string | null
          total_cents?: number
          total_weight_grams?: number
        }
        Update: {
          branch_id?: string
          cancellation_key?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          created_at?: string
          device_id?: string | null
          id?: string
          organization_id?: string
          profile_id?: string
          status?: Database["public"]["Enums"]["sale_status"]
          sync_event_id?: string | null
          total_cents?: number
          total_weight_grams?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "sales_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "sales_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      settlements: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string
          device_sync_snapshot: Json
          difference_cents: number
          employee_totals: Json
          expected_cash_cents: number
          id: string
          notes: string | null
          organization_id: string
          payment_totals: Json
          period_end: string
          period_start: string
          received_cash_cents: number
          sold_weight_grams: number
          status: Database["public"]["Enums"]["settlement_status"]
          ticket_count: number
          total_sales_cents: number
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by: string
          device_sync_snapshot: Json
          difference_cents: number
          employee_totals: Json
          expected_cash_cents: number
          id?: string
          notes?: string | null
          organization_id: string
          payment_totals: Json
          period_end: string
          period_start: string
          received_cash_cents: number
          sold_weight_grams: number
          status?: Database["public"]["Enums"]["settlement_status"]
          ticket_count: number
          total_sales_cents: number
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string
          device_sync_snapshot?: Json
          difference_cents?: number
          employee_totals?: Json
          expected_cash_cents?: number
          id?: string
          notes?: string | null
          organization_id?: string
          payment_totals?: Json
          period_end?: string
          period_start?: string
          received_cash_cents?: number
          sold_weight_grams?: number
          status?: Database["public"]["Enums"]["settlement_status"]
          ticket_count?: number
          total_sales_cents?: number
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "settlements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "settlements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "settlements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlements_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          occurred_at: string
          organization_id: string
          product_id: string
          production_batch_id: string | null
          profile_id: string
          quantity_grams: number
          reason: string | null
          sale_id: string | null
          stock_operation_id: string | null
          stock_transfer_id: string | null
          type: Database["public"]["Enums"]["stock_movement_type"]
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          occurred_at?: string
          organization_id: string
          product_id: string
          production_batch_id?: string | null
          profile_id: string
          quantity_grams: number
          reason?: string | null
          sale_id?: string | null
          stock_operation_id?: string | null
          stock_transfer_id?: string | null
          type: Database["public"]["Enums"]["stock_movement_type"]
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          occurred_at?: string
          organization_id?: string
          product_id?: string
          production_batch_id?: string | null
          profile_id?: string
          quantity_grams?: number
          reason?: string | null
          sale_id?: string | null
          stock_operation_id?: string | null
          stock_transfer_id?: string | null
          type?: Database["public"]["Enums"]["stock_movement_type"]
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "stock_movements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "stock_movements_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "stock_movements_production_batch_fk"
            columns: ["production_batch_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "production_batches"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
          {
            foreignKeyName: "stock_movements_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_sale_id_organization_id_branch_id_fkey"
            columns: ["sale_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
          {
            foreignKeyName: "stock_movements_stock_operation_id_fkey"
            columns: ["stock_operation_id"]
            isOneToOne: false
            referencedRelation: "stock_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_transfer_fk"
            columns: ["stock_transfer_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      stock_operation_items: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          operation_id: string
          organization_id: string
          physical_quantity_grams: number | null
          product_id: string
          quantity_grams: number
          system_quantity_before_grams: number | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          operation_id: string
          organization_id: string
          physical_quantity_grams?: number | null
          product_id: string
          quantity_grams: number
          system_quantity_before_grams?: number | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          operation_id?: string
          organization_id?: string
          physical_quantity_grams?: number | null
          product_id?: string
          quantity_grams?: number
          system_quantity_before_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_operation_items_operation_id_organization_id_branch__fkey"
            columns: ["operation_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "stock_operations"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
          {
            foreignKeyName: "stock_operation_items_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      stock_operations: {
        Row: {
          actor_profile_id: string
          branch_id: string
          created_at: string
          id: string
          note: string | null
          occurred_at: string
          operation_type: Database["public"]["Enums"]["stock_operation_type"]
          organization_id: string
          supplier: string | null
          waste_reason: Database["public"]["Enums"]["waste_reason"] | null
        }
        Insert: {
          actor_profile_id: string
          branch_id: string
          created_at?: string
          id?: string
          note?: string | null
          occurred_at?: string
          operation_type: Database["public"]["Enums"]["stock_operation_type"]
          organization_id: string
          supplier?: string | null
          waste_reason?: Database["public"]["Enums"]["waste_reason"] | null
        }
        Update: {
          actor_profile_id?: string
          branch_id?: string
          created_at?: string
          id?: string
          note?: string | null
          occurred_at?: string
          operation_type?: Database["public"]["Enums"]["stock_operation_type"]
          organization_id?: string
          supplier?: string | null
          waste_reason?: Database["public"]["Enums"]["waste_reason"] | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_operations_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_operations_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "stock_operations_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      stock_transfer_items: {
        Row: {
          id: string
          organization_id: string
          product_id: string
          quantity_grams: number
          transfer_id: string
        }
        Insert: {
          id?: string
          organization_id: string
          product_id: string
          quantity_grams: number
          transfer_id: string
        }
        Update: {
          id?: string
          organization_id?: string
          product_id?: string
          quantity_grams?: number
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfer_items_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "stock_transfer_items_transfer_id_organization_id_fkey"
            columns: ["transfer_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      stock_transfers: {
        Row: {
          created_at: string
          created_by: string
          destination_branch_id: string
          id: string
          item_count: number
          notes: string | null
          organization_id: string
          source_branch_id: string
          total_weight_grams: number
        }
        Insert: {
          created_at?: string
          created_by: string
          destination_branch_id: string
          id?: string
          item_count?: number
          notes?: string | null
          organization_id: string
          source_branch_id: string
          total_weight_grams?: number
        }
        Update: {
          created_at?: string
          created_by?: string
          destination_branch_id?: string
          id?: string
          item_count?: number
          notes?: string | null
          organization_id?: string
          source_branch_id?: string
          total_weight_grams?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_destination_branch_id_organization_id_fkey"
            columns: ["destination_branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "stock_transfers_destination_branch_id_organization_id_fkey"
            columns: ["destination_branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "stock_transfers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_source_branch_id_organization_id_fkey"
            columns: ["source_branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "stock_transfers_source_branch_id_organization_id_fkey"
            columns: ["source_branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
    }
    Views: {
      branch_stock_status: {
        Row: {
          branch_id: string | null
          branch_name: string | null
          current_stock_grams: number | null
          last_movement_at: string | null
          minimum_stock_grams: number | null
          organization_id: string | null
          product_id: string | null
          product_name: string | null
          sku: string | null
          stock_status: string | null
          suggested_replenishment_grams: number | null
          target_stock_grams: number | null
        }
        Relationships: [
          {
            foreignKeyName: "branches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_levels: {
        Row: {
          branch_id: string | null
          last_movement_at: string | null
          organization_id: string | null
          product_id: string | null
          quantity_grams: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "stock_movements_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "stock_movements_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
    }
    Functions: {
      bulk_set_product_prices: {
        Args: {
          p_branch_id?: string
          p_effective_at?: string
          p_items: Json
        }
        Returns: Json
      }
      calculate_product_price: {
        Args: {
          p_cash_discount_bps: number
          p_cost_cents: number
          p_profit_markup_bps: number
        }
        Returns: {
          effective_cash_price_cents: number
          list_price_cents: number
          target_cash_price_cents: number
        }[]
      }
      cancel_production_batch: {
        Args: { p_batch_id: string }
        Returns: undefined
      }
      cancel_sale: {
        Args: { p_idempotency_key: string; p_reason: string; p_sale_id: string }
        Returns: Json
      }
      complete_discounted_sale: {
        Args: { p_branch_id: string; p_items: Json; p_payment_method: string }
        Returns: {
          completed_at: string
          sale_id: string
          total_cents: number
          total_weight_grams: number
        }[]
      }
      complete_pos_operator_sale: {
        Args: {
          p_branch_id: string
          p_device_id: string
          p_items: Json
          p_operator_profile_id: string
          p_operator_token: string
          p_payment_method: string
        }
        Returns: {
          completed_at: string
          sale_id: string
          total_cents: number
          total_weight_grams: number
        }[]
      }
      complete_production_batch: { Args: { p_batch_id: string }; Returns: Json }
      complete_sale: {
        Args: { p_branch_id: string; p_items: Json; p_payment_method: string }
        Returns: {
          completed_at: string
          sale_id: string
          total_cents: number
          total_weight_grams: number
        }[]
      }
      confirm_settlement: {
        Args: {
          p_branch_id: string
          p_notes?: string
          p_period_end_local: string
          p_period_start_local: string
          p_received_cash_cents: number
        }
        Returns: string
      }
      correct_employee_shift: {
        Args: {
          p_clock_out_local: string
          p_reason: string
          p_shift_id: string
        }
        Returns: undefined
      }
      create_pos_employee: {
        Args: {
          p_branch_ids: string[]
          p_display_name: string
          p_pin: string
          p_rate_cents_per_hour: number
          p_rate_valid_from_local: string
          p_status?: Database["public"]["Enums"]["membership_status"]
        }
        Returns: string
      }
      create_product_with_pricing: {
        Args: {
          p_active: boolean
          p_category_id: string
          p_cost_cents?: number
          p_name: string
          p_profit_markup_bps?: number
          p_sku: string
          p_slug: string
          p_unit_type: Database["public"]["Enums"]["unit_type"]
        }
        Returns: string
      }
      create_production_batch: {
        Args: {
          p_branch_id?: string
          p_cost_per_kg_cents: number
          p_description?: string
          p_input_unit_count?: number
          p_input_weight_grams: number
          p_notes?: string
          p_source_product_id: string
        }
        Returns: string
      }
      create_stock_transfer: {
        Args: {
          p_destination_branch_id: string
          p_items: Json
          p_notes?: string
          p_source_branch_id: string
        }
        Returns: string
      }
      delete_branch: { Args: { p_branch_id: string }; Returns: undefined }
      delete_production_batch: {
        Args: { p_batch_id: string }
        Returns: undefined
      }
      get_admin_dashboard: { Args: { p_branch_id?: string }; Returns: Json }
      get_branch_stock_status: {
        Args: { p_branch_id?: string }
        Returns: {
          branch_id: string
          branch_name: string
          current_stock_grams: number
          minimum_stock_grams: number
          product_id: string
          product_name: string
          stock_status: string
          suggested_replenishment_grams: number
          target_stock_grams: number
        }[]
      }
      get_current_employee_shift: {
        Args: {
          p_device_id: string
          p_employee_id: string
          p_operator_token: string
        }
        Returns: Json
      }
      get_employee_security_status: {
        Args: never
        Returns: {
          current_rate_cents_per_hour: number
          has_pin: boolean
          profile_id: string
          rate_valid_from: string
        }[]
      }
      get_pos_catalog: {
        Args: { p_branch_id: string }
        Returns: {
          branch_id: string
          branch_name: string
          category_color_hex: string
          category_id: string
          category_ids: string[]
          category_name: string
          category_sort_order: number
          organization_id: string
          price_per_kg_cents: number
          price_valid_from: string
          product_id: string
          product_name: string
          product_sku: string
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      get_pos_categories: {
        Args: { p_branch_id: string }
        Returns: { color_hex: string; id: string; name: string; sort_order: number }[]
      }
      get_pos_commercial_config: {
        Args: { p_branch_id: string }
        Returns: Json
      }
      get_pos_operator_roster: { Args: { p_device_id: string }; Returns: Json }
      get_production_batch_detail: {
        Args: { p_batch_id: string }
        Returns: Json
      }
      get_production_catalog: {
        Args: { p_branch_id: string }
        Returns: {
          product_id: string
          product_name: string
          product_sku: string
          sale_price_per_kg_cents: number
        }[]
      }
      get_production_yield_summary: {
        Args: { p_limit?: number; p_source_product_id: string }
        Returns: Json
      }
      get_products_with_unit_type_history: {
        Args: never
        Returns: string[]
      }
      get_profitability_analytics: {
        Args: {
          p_branch_id?: string
          p_category_id?: string
          p_from?: string
          p_preset?: string
          p_product_id?: string
          p_to?: string
        }
        Returns: Json
      }
      get_replenishment_plan: {
        Args: { p_days?: number }
        Returns: {
          branch_id: string
          branch_name: string
          current_quantity: number
          minimum_quantity: number
          product_id: string
          product_name: string
          sales_days: number
          sold_recent_quantity: number
          target_coverage_days: number
          target_quantity: number
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      get_settlement_history: {
        Args: {
          p_branch_id?: string
          p_from?: string
          p_has_difference?: boolean
          p_settlement_id?: string
          p_to?: string
        }
        Returns: Json
      }
      get_settlement_overview: { Args: never; Returns: Json }
      get_settlement_preview: {
        Args: {
          p_branch_id: string
          p_period_end_local: string
          p_period_start_local: string
        }
        Returns: Json
      }
      get_timekeeping_report: {
        Args: {
          p_branch_id?: string
          p_employee_id?: string
          p_from: string
          p_to: string
        }
        Returns: Json
      }
      list_organization_members: {
        Args: never
        Returns: {
          auth_linked: boolean
          branch_id: string
          branch_ids: string[]
          branch_name: string
          branch_names: string[]
          display_name: string
          email: string
          profile_id: string
          role_key: string
          status: Database["public"]["Enums"]["membership_status"]
        }[]
      }
      list_production_batches: {
        Args: { p_branch_id?: string; p_limit?: number; p_status?: string }
        Returns: Json
      }
      list_stock_transfers: {
        Args: { p_branch_id?: string; p_limit?: number }
        Returns: Json
      }
      manage_existing_member: {
        Args: {
          p_branch_id: string
          p_display_name: string
          p_email: string
          p_role_key: string
          p_status?: Database["public"]["Enums"]["membership_status"]
        }
        Returns: string
      }
      publish_restock_announcement: {
        Args: { p_message: string; p_restock_event_id: string; p_title: string }
        Returns: string
      }
      pull_pos_state: {
        Args: { p_after_sequence?: number; p_device_id: string }
        Returns: Json
      }
      record_employee_time_event: {
        Args: {
          p_action: Database["public"]["Enums"]["time_event_action"]
          p_device_id: string
          p_employee_id: string
          p_event_id: string
          p_operator_token: string
          p_shift_id: string
        }
        Returns: Json
      }
      record_stock_operation: {
        Args: {
          p_branch_id: string
          p_items: Json
          p_note?: string
          p_occurred_at?: string
          p_operation_type: string
          p_supplier?: string
          p_waste_reason?: string
        }
        Returns: string
      }
      register_pos_device: {
        Args: { p_branch_id: string; p_device_id: string; p_label?: string }
        Returns: Json
      }
      remove_production_batch_output: {
        Args: { p_output_id: string }
        Returns: undefined
      }
      resolve_weight_discount: {
        Args: {
          p_at?: string
          p_branch_id: string
          p_grams: number
          p_organization_id: string
          p_price_cents: number
          p_product_id: string
        }
        Returns: {
          discount_type: Database["public"]["Enums"]["weight_discount_type"]
          discount_value: number
          final_price_cents: number
          rule_id: string
        }[]
      }
      save_announcement: {
        Args: {
          p_active: boolean
          p_branch_id: string
          p_ends_at?: string
          p_id: string
          p_message: string
          p_priority: number
          p_starts_at: string
          p_title: string
          p_type: string
        }
        Returns: string
      }
      save_branch: {
        Args: {
          p_active?: boolean
          p_address?: string
          p_branch_id: string
          p_code: string
          p_name: string
        }
        Returns: string
      }
      save_category:
        | {
            Args: {
              p_active?: boolean
              p_category_id: string
              p_name: string
              p_slug: string
              p_sort_order?: number
            }
            Returns: string
          }
        | {
            Args: {
              p_active: boolean
              p_category_id: string
              p_color_hex: string
              p_name: string
              p_slug: string
              p_sort_order: number
            }
            Returns: string
          }
      save_product: {
        Args: {
          p_active?: boolean
          p_category_id: string
          p_name: string
          p_product_id: string
          p_sku: string
          p_slug: string
          p_unit_type: Database["public"]["Enums"]["unit_type"]
        }
        Returns: string
      }
      save_product_pricing: {
        Args: {
          p_cost_cents: number
          p_product_id: string
          p_profit_markup_bps: number
        }
        Returns: Json
      }
      save_weight_discount: {
        Args: {
          p_active: boolean
          p_branch_id: string
          p_discount_type?: string
          p_discount_value?: number
          p_id: string
          p_minimum_grams?: number
          p_pack_price_cents?: number
          p_pack_quantity_grams?: number
          p_pack_quantity_units?: number
          p_product_id: string
          p_promotion_mode?: string
          p_valid_from: string
          p_valid_until?: string
        }
        Returns: string
      }
      set_branch_active: {
        Args: { p_active: boolean; p_branch_id: string }
        Returns: undefined
      }
      set_cash_discount: {
        Args: { p_cash_discount_bps: number }
        Returns: Json
      }
      set_cash_discount_and_reprice: {
        Args: { p_cash_discount_bps: number; p_confirm?: boolean }
        Returns: Json
      }
      set_employee_hourly_rate: {
        Args: {
          p_employee_id: string
          p_rate_cents_per_hour: number
          p_valid_from_local: string
        }
        Returns: string
      }
      set_employee_pos_pin: {
        Args: { p_pin: string; p_profile_id: string }
        Returns: undefined
      }
      set_pos_device_status: {
        Args: {
          p_device_id: string
          p_status: Database["public"]["Enums"]["pos_device_status"]
        }
        Returns: undefined
      }
      set_product_cost: {
        Args: {
          p_cost_cents: number
          p_effective_at?: string
          p_product_id: string
        }
        Returns: string
      }
      set_product_inventory_role: {
        Args: { p_inventory_role: string; p_product_id: string }
        Returns: undefined
      }
      set_product_categories: {
        Args: {
          p_category_ids: string[]
          p_primary_category_id: string
          p_product_id: string
        }
        Returns: undefined
      }
      set_product_price: {
        Args: {
          p_branch_id: string
          p_effective_at?: string
          p_price_cents: number
          p_product_id: string
        }
        Returns: string
      }
      set_production_batch_output: {
        Args: {
          p_batch_id: string
          p_output_quantity_units?: number
          p_output_weight_grams: number
          p_product_id: string
        }
        Returns: string
      }
      set_production_branch: {
        Args: { p_branch_id: string }
        Returns: undefined
      }
      set_replenishment_target_days: {
        Args: { p_target_days: number }
        Returns: undefined
      }
      set_stock_policy: {
        Args: {
          p_branch_id: string
          p_minimum_stock_grams: number
          p_product_id: string
          p_target_stock_grams: number
        }
        Returns: undefined
      }
      set_timekeeping_max_shift_hours: {
        Args: { p_hours: number }
        Returns: undefined
      }
      sync_discounted_offline_sale: {
        Args: { p_device_id: string; p_event_id: string; p_payload: Json }
        Returns: Json
      }
      sync_offline_sale: {
        Args: { p_device_id: string; p_event_id: string; p_payload: Json }
        Returns: Json
      }
      sync_offline_time_event: {
        Args: { p_device_id: string; p_event_id: string; p_payload: Json }
        Returns: Json
      }
      sync_pos_operator_offline_sale: {
        Args: {
          p_device_id: string
          p_event_id: string
          p_operator_profile_id: string
          p_operator_token: string
          p_payload: Json
        }
        Returns: Json
      }
      update_pos_employee: {
        Args: {
          p_branch_ids: string[]
          p_display_name: string
          p_employee_id: string
          p_status: Database["public"]["Enums"]["membership_status"]
        }
        Returns: undefined
      }
      update_production_batch_header: {
        Args: {
          p_batch_id: string
          p_cost_per_kg_cents: number
          p_description?: string
          p_input_unit_count?: number
          p_input_weight_grams: number
          p_notes?: string
          p_source_product_id: string
        }
        Returns: undefined
      }
      verify_pos_operator_pin: {
        Args: { p_device_id: string; p_pin: string; p_profile_id: string }
        Returns: Json
      }
      void_settlement: {
        Args: { p_reason: string; p_settlement_id: string }
        Returns: undefined
      }
    }
    Enums: {
      announcement_type: "INFO" | "WARNING" | "PROMOTION" | "STOCK" | "INTERNAL"
      employee_shift_status: "OPEN" | "CLOSED" | "REQUIRES_REVIEW"
      membership_status: "INVITED" | "ACTIVE" | "DISABLED"
      payment_method: "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER"
      pos_device_status: "ACTIVE" | "DISABLED"
      product_inventory_role: "RAW_MATERIAL" | "SELLABLE" | "BOTH"
      production_batch_status: "DRAFT" | "COMPLETED" | "CANCELLED"
      promotion_mode: "THRESHOLD" | "PACK_FIXED_TOTAL"
      sale_status: "DRAFT" | "COMPLETED" | "CANCELLED" | "REFUNDED"
      settlement_status: "CONFIRMED" | "VOIDED"
      stock_movement_type:
        | "PURCHASE"
        | "SALE"
        | "WASTE"
        | "ADJUSTMENT_POSITIVE"
        | "ADJUSTMENT_NEGATIVE"
        | "TRANSFER_IN"
        | "TRANSFER_OUT"
        | "RETURN"
        | "PRODUCTION_CONSUME"
        | "PRODUCTION_YIELD"
      stock_operation_type: "PURCHASE" | "WASTE" | "ADJUSTMENT"
      time_event_action: "CLOCK_IN" | "CLOCK_OUT"
      time_event_source: "ONLINE" | "OFFLINE" | "ADMIN_CORRECTION"
      unit_type: "WEIGHT" | "UNIT"
      waste_reason:
        | "DISCARD"
        | "EXPIRY"
        | "TRIMMING"
        | "DETERIORATION"
        | "INVENTORY_DIFFERENCE"
        | "OTHER"
      weight_discount_type: "PERCENTAGE" | "FIXED_PRICE_PER_KG"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      announcement_type: ["INFO", "WARNING", "PROMOTION", "STOCK", "INTERNAL"],
      employee_shift_status: ["OPEN", "CLOSED", "REQUIRES_REVIEW"],
      membership_status: ["INVITED", "ACTIVE", "DISABLED"],
      payment_method: ["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"],
      pos_device_status: ["ACTIVE", "DISABLED"],
      product_inventory_role: ["RAW_MATERIAL", "SELLABLE", "BOTH"],
      production_batch_status: ["DRAFT", "COMPLETED", "CANCELLED"],
      promotion_mode: ["THRESHOLD", "PACK_FIXED_TOTAL"],
      sale_status: ["DRAFT", "COMPLETED", "CANCELLED", "REFUNDED"],
      settlement_status: ["CONFIRMED", "VOIDED"],
      stock_movement_type: [
        "PURCHASE",
        "SALE",
        "WASTE",
        "ADJUSTMENT_POSITIVE",
        "ADJUSTMENT_NEGATIVE",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "RETURN",
        "PRODUCTION_CONSUME",
        "PRODUCTION_YIELD",
      ],
      stock_operation_type: ["PURCHASE", "WASTE", "ADJUSTMENT"],
      time_event_action: ["CLOCK_IN", "CLOCK_OUT"],
      time_event_source: ["ONLINE", "OFFLINE", "ADMIN_CORRECTION"],
      unit_type: ["WEIGHT", "UNIT"],
      waste_reason: [
        "DISCARD",
        "EXPIRY",
        "TRIMMING",
        "DETERIORATION",
        "INVENTORY_DIFFERENCE",
        "OTHER",
      ],
      weight_discount_type: ["PERCENTAGE", "FIXED_PRICE_PER_KG"],
    },
  },
} as const
