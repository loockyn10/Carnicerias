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
      branch_expenses: {
        Row: {
          amount_cents: number
          branch_id: string
          concept: string
          created_at: string
          created_by: string | null
          expense_date: string
          id: string
          organization_id: string
          request_key: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_cents: number
          branch_id: string
          concept: string
          created_at?: string
          created_by?: string | null
          expense_date: string
          id?: string
          organization_id: string
          request_key?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_cents?: number
          branch_id?: string
          concept?: string
          created_at?: string
          created_by?: string | null
          expense_date?: string
          id?: string
          organization_id?: string
          request_key?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branch_expenses_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_expenses_organization_id_fkey"
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
      branch_product_assortment: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          product_id: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          product_id: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_product_assortment_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "branch_product_assortment_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_product_assortment_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_product_assortment_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_product_assortment_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
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
      branch_promotions: {
        Row: {
          active: boolean
          branch_id: string
          created_at: string
          created_by: string | null
          discount_bps: number
          every_units: number | null
          id: string
          minimum_units: number
          organization_id: string
          scope: string
          semantics: string
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          active?: boolean
          branch_id: string
          created_at?: string
          created_by?: string | null
          discount_bps: number
          every_units?: number | null
          id?: string
          minimum_units: number
          organization_id: string
          scope?: string
          semantics?: string
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          active?: boolean
          branch_id?: string
          created_at?: string
          created_by?: string | null
          discount_bps?: number
          every_units?: number | null
          id?: string
          minimum_units?: number
          organization_id?: string
          scope?: string
          semantics?: string
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branch_promotions_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "branch_promotions_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_promotions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_promotions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_recurring_cost_versions: {
        Row: {
          amount_cents: number
          branch_id: string
          cost_id: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          amount_cents: number
          branch_id: string
          cost_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          amount_cents?: number
          branch_id?: string
          cost_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branch_recurring_cost_versions_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_recurring_cost_versions_cost_id_organization_id_fkey"
            columns: ["cost_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_recurring_costs"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      branch_recurring_costs: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          organization_id: string
          request_key: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          organization_id: string
          request_key?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          organization_id?: string
          request_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branch_recurring_costs_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "branch_recurring_costs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          active: boolean
          address: string | null
          city: string | null
          code: string
          created_at: string
          id: string
          name: string
          organization_id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          city?: string | null
          code: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          city?: string | null
          code?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          phone?: string | null
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
      digital_signage_displays: {
        Row: {
          branch_id: string | null
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          name: string
          organization_id: string
          slide_duration_seconds: number
          token_hash: string
          token_rotated_at: string
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          name: string
          organization_id: string
          slide_duration_seconds?: number
          token_hash: string
          token_rotated_at?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          name?: string
          organization_id?: string
          slide_duration_seconds?: number
          token_hash?: string
          token_rotated_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "digital_signage_displays_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "digital_signage_displays_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "digital_signage_displays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "digital_signage_displays_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      digital_signage_slides: {
        Row: {
          created_at: string
          display_id: string
          group_id: string | null
          id: string
          kind: string
          organization_id: string
          position: number
          product_id: string | null
          promotion_id: string | null
        }
        Insert: {
          created_at?: string
          display_id: string
          group_id?: string | null
          id?: string
          kind?: string
          organization_id: string
          position: number
          product_id?: string | null
          promotion_id?: string | null
        }
        Update: {
          created_at?: string
          display_id?: string
          group_id?: string | null
          id?: string
          kind?: string
          organization_id?: string
          position?: number
          product_id?: string | null
          promotion_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "digital_signage_slides_display_id_organization_id_fkey"
            columns: ["display_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "digital_signage_displays"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "digital_signage_slides_group_fk"
            columns: ["group_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "signage_promotion_groups"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "digital_signage_slides_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "digital_signage_slides_promotion_fk"
            columns: ["promotion_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "product_weight_discounts"
            referencedColumns: ["id", "organization_id"]
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
          auto_closed_by_heartbeat: boolean
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
          last_heartbeat_at: string | null
          organization_id: string
          status: Database["public"]["Enums"]["employee_shift_status"]
          updated_at: string
        }
        Insert: {
          auto_closed_by_heartbeat?: boolean
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
          last_heartbeat_at?: string | null
          organization_id: string
          status?: Database["public"]["Enums"]["employee_shift_status"]
          updated_at?: string
        }
        Update: {
          auto_closed_by_heartbeat?: boolean
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
          last_heartbeat_at?: string | null
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
      external_entity_links: {
        Row: {
          content_hash: string
          created_at: string
          entity_type: string
          external_id: string
          first_batch_id: string | null
          internal_id: string
          last_batch_id: string | null
          organization_id: string
          source_system: string
          updated_at: string
        }
        Insert: {
          content_hash: string
          created_at?: string
          entity_type: string
          external_id: string
          first_batch_id?: string | null
          internal_id: string
          last_batch_id?: string | null
          organization_id: string
          source_system: string
          updated_at?: string
        }
        Update: {
          content_hash?: string
          created_at?: string
          entity_type?: string
          external_id?: string
          first_batch_id?: string | null
          internal_id?: string
          last_batch_id?: string | null
          organization_id?: string
          source_system?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "external_entity_links_first_batch_id_fkey"
            columns: ["first_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_entity_links_last_batch_id_fkey"
            columns: ["last_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_entity_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_summary: Json | null
          branch_id: string | null
          created_at: string
          created_by: string
          entity_type: string
          file_name: string | null
          file_sha256: string | null
          id: string
          options: Json
          organization_id: string
          preview_summary: Json | null
          previewed_at: string | null
          source_system: string
          status: string
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_summary?: Json | null
          branch_id?: string | null
          created_at?: string
          created_by: string
          entity_type: string
          file_name?: string | null
          file_sha256?: string | null
          id?: string
          options?: Json
          organization_id: string
          preview_summary?: Json | null
          previewed_at?: string | null
          source_system: string
          status?: string
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_summary?: Json | null
          branch_id?: string | null
          created_at?: string
          created_by?: string
          entity_type?: string
          file_name?: string | null
          file_sha256?: string | null
          id?: string
          options?: Json
          organization_id?: string
          preview_summary?: Json | null
          previewed_at?: string | null
          source_system?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "import_batches_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "import_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_rows: {
        Row: {
          action: string | null
          applied_at: string | null
          batch_id: string
          content_hash: string
          created_at: string
          external_id: string | null
          id: string
          internal_id: string | null
          message: string | null
          organization_id: string
          payload: Json
          raw: Json
          reason_code: string | null
          row_number: number
        }
        Insert: {
          action?: string | null
          applied_at?: string | null
          batch_id: string
          content_hash: string
          created_at?: string
          external_id?: string | null
          id?: string
          internal_id?: string | null
          message?: string | null
          organization_id: string
          payload?: Json
          raw?: Json
          reason_code?: string | null
          row_number: number
        }
        Update: {
          action?: string | null
          applied_at?: string | null
          batch_id?: string
          content_hash?: string
          created_at?: string
          external_id?: string | null
          id?: string
          internal_id?: string | null
          message?: string | null
          organization_id?: string
          payload?: Json
          raw?: Json
          reason_code?: string | null
          row_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_batch_id_organization_id_fkey"
            columns: ["batch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      mercadopago_branch_pos: {
        Row: {
          branch_id: string
          created_at: string
          enabled: boolean
          expiration_minutes: number
          external_pos_id: string
          id: string
          mp_pos_id: string | null
          mp_store_id: string | null
          organization_id: string
          qr_mode: string
          require_verified_digital_payments: boolean
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          enabled?: boolean
          expiration_minutes?: number
          external_pos_id: string
          id?: string
          mp_pos_id?: string | null
          mp_store_id?: string | null
          organization_id: string
          qr_mode?: string
          require_verified_digital_payments?: boolean
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          enabled?: boolean
          expiration_minutes?: number
          external_pos_id?: string
          id?: string
          mp_pos_id?: string | null
          mp_store_id?: string | null
          organization_id?: string
          qr_mode?: string
          require_verified_digital_payments?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mercadopago_branch_pos_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "mercadopago_branch_pos_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      mercadopago_orders: {
        Row: {
          amount_mismatch: boolean
          attempt: number
          branch_id: string
          cancelled_at: string | null
          confirmed_amount_cents: number | null
          confirmed_at: string | null
          created_at: string
          device_id: string | null
          error_code: string | null
          expected_amount_cents: number
          expiration_minutes: number
          expired_at: string | null
          expires_at: string | null
          external_pos_id: string
          external_reference: string
          id: string
          idempotency_key: string
          last_checked_at: string | null
          last_event_at: string | null
          mp_created_at: string | null
          mp_order_id: string | null
          mp_payment_id: string | null
          mp_status: string | null
          mp_status_detail: string | null
          organization_id: string
          requested_by: string | null
          sale_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount_mismatch?: boolean
          attempt: number
          branch_id: string
          cancelled_at?: string | null
          confirmed_amount_cents?: number | null
          confirmed_at?: string | null
          created_at?: string
          device_id?: string | null
          error_code?: string | null
          expected_amount_cents: number
          expiration_minutes: number
          expired_at?: string | null
          expires_at?: string | null
          external_pos_id: string
          external_reference: string
          id?: string
          idempotency_key?: string
          last_checked_at?: string | null
          last_event_at?: string | null
          mp_created_at?: string | null
          mp_order_id?: string | null
          mp_payment_id?: string | null
          mp_status?: string | null
          mp_status_detail?: string | null
          organization_id: string
          requested_by?: string | null
          sale_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount_mismatch?: boolean
          attempt?: number
          branch_id?: string
          cancelled_at?: string | null
          confirmed_amount_cents?: number | null
          confirmed_at?: string | null
          created_at?: string
          device_id?: string | null
          error_code?: string | null
          expected_amount_cents?: number
          expiration_minutes?: number
          expired_at?: string | null
          expires_at?: string | null
          external_pos_id?: string
          external_reference?: string
          id?: string
          idempotency_key?: string
          last_checked_at?: string | null
          last_event_at?: string | null
          mp_created_at?: string | null
          mp_order_id?: string | null
          mp_payment_id?: string | null
          mp_status?: string | null
          mp_status_detail?: string | null
          organization_id?: string
          requested_by?: string | null
          sale_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mercadopago_orders_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "mercadopago_orders_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "mercadopago_orders_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mercadopago_orders_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      mercadopago_webhook_events: {
        Row: {
          action: string | null
          dedupe_key: string
          delivery_count: number
          event_type: string | null
          external_reference: string | null
          id: string
          last_received_at: string
          mp_order_id: string | null
          mp_status: string | null
          mp_status_detail: string | null
          received_at: string
          request_id: string | null
          result: string
        }
        Insert: {
          action?: string | null
          dedupe_key: string
          delivery_count?: number
          event_type?: string | null
          external_reference?: string | null
          id?: string
          last_received_at?: string
          mp_order_id?: string | null
          mp_status?: string | null
          mp_status_detail?: string | null
          received_at?: string
          request_id?: string | null
          result: string
        }
        Update: {
          action?: string | null
          dedupe_key?: string
          delivery_count?: number
          event_type?: string | null
          external_reference?: string | null
          id?: string
          last_received_at?: string
          mp_order_id?: string | null
          mp_status?: string | null
          mp_status_detail?: string | null
          received_at?: string
          request_id?: string | null
          result?: string
        }
        Relationships: []
      }
      organization_artwork_logos: {
        Row: {
          content_type: string
          created_at: string
          created_by: string | null
          height_px: number
          organization_id: string
          size_bytes: number
          storage_path: string
          updated_at: string
          width_px: number
        }
        Insert: {
          content_type: string
          created_at?: string
          created_by?: string | null
          height_px: number
          organization_id: string
          size_bytes: number
          storage_path: string
          updated_at?: string
          width_px: number
        }
        Update: {
          content_type?: string
          created_at?: string
          created_by?: string | null
          height_px?: number
          organization_id?: string
          size_bytes?: number
          storage_path?: string
          updated_at?: string
          width_px?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_artwork_logos_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_artwork_logos_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
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
      organization_pricing_excluded_categories: {
        Row: {
          category_id: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_pricing_excluded__category_id_organization_id_fkey"
            columns: ["category_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_pricing_excluded_categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_pricing_excluded_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_pricing_settings: {
        Row: {
          created_at: string
          id: string
          margin_bps: number | null
          organization_id: string
          pack_discount_bps: number | null
          unit_bulk_discount_bps: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          margin_bps?: number | null
          organization_id: string
          pack_discount_bps?: number | null
          unit_bulk_discount_bps?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          margin_bps?: number | null
          organization_id?: string
          pack_discount_bps?: number | null
          unit_bulk_discount_bps?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_pricing_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_pricing_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_quantity_discount_tiers: {
        Row: {
          created_at: string
          discount_bps: number
          id: string
          minimum_units: number
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          discount_bps: number
          id?: string
          minimum_units: number
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          discount_bps?: number
          id?: string
          minimum_units?: number
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_quantity_discount_tiers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          provider: string | null
          sale_id: string
          verification_status: string
          verified_amount_cents: number | null
          verified_at: string | null
        }
        Insert: {
          amount_cents: number
          branch_id: string
          created_at?: string
          id?: string
          method: Database["public"]["Enums"]["payment_method"]
          organization_id: string
          provider?: string | null
          sale_id: string
          verification_status?: string
          verified_amount_cents?: number | null
          verified_at?: string | null
        }
        Update: {
          amount_cents?: number
          branch_id?: string
          created_at?: string
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          organization_id?: string
          provider?: string | null
          sale_id?: string
          verification_status?: string
          verified_amount_cents?: number | null
          verified_at?: string | null
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
      product_artwork_photos: {
        Row: {
          content_type: string
          created_at: string
          created_by: string | null
          organization_id: string
          product_id: string
          size_bytes: number
          storage_path: string
          updated_at: string
        }
        Insert: {
          content_type: string
          created_at?: string
          created_by?: string | null
          organization_id: string
          product_id: string
          size_bytes: number
          storage_path: string
          updated_at?: string
        }
        Update: {
          content_type?: string
          created_at?: string
          created_by?: string | null
          organization_id?: string
          product_id?: string
          size_bytes?: number
          storage_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_artwork_photos_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_artwork_photos_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      pricing_receipt_requests: {
        Row: {
          created_at: string
          created_by: string | null
          organization_id: string
          payload_hash: string
          request_key: string
          result: Json | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          organization_id: string
          payload_hash: string
          request_key: string
          result?: Json | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          organization_id?: string
          payload_hash?: string
          request_key?: string
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_receipt_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_receipt_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      product_barcodes: {
        Row: {
          barcode: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          product_id: string
        }
        Insert: {
          barcode: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          product_id: string
        }
        Update: {
          barcode?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_barcodes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_barcodes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_barcodes_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
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
            foreignKeyName: "product_category_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
      product_custom_margins: {
        Row: {
          created_at: string
          custom_margin_bps: number
          id: string
          organization_id: string
          product_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          custom_margin_bps: number
          id?: string
          organization_id: string
          product_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          custom_margin_bps?: number
          id?: string
          organization_id?: string
          product_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_custom_margins_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_custom_margins_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_custom_margins_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      product_label_group_items: {
        Row: {
          active: boolean
          created_at: string
          group_id: string
          id: string
          organization_id: string
          position: number
          product_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          group_id: string
          id?: string
          organization_id: string
          position: number
          product_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          group_id?: string
          id?: string
          organization_id?: string
          position?: number
          product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_label_group_items_group_id_organization_id_fkey"
            columns: ["group_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "product_label_groups"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_label_group_items_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_label_groups: {
        Row: {
          active: boolean
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_label_groups_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branch_stock_status"
            referencedColumns: ["branch_id", "organization_id"]
          },
          {
            foreignKeyName: "product_label_groups_branch_id_organization_id_fkey"
            columns: ["branch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_label_groups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_label_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      product_label_print_run_items: {
        Row: {
          condition_text: string | null
          copies: number
          displayed_name: string
          generated_at: string
          group_id: string
          id: string
          list_price_cents: number
          organization_id: string
          position: number
          product_id: string
          promo_discount_bps: number | null
          promo_minimum_units: number | null
          promo_price_cents: number | null
          run_id: string
          unit_type: Database["public"]["Enums"]["unit_type"]
          variant: string
        }
        Insert: {
          condition_text?: string | null
          copies: number
          displayed_name: string
          generated_at: string
          group_id: string
          id?: string
          list_price_cents: number
          organization_id: string
          position: number
          product_id: string
          promo_discount_bps?: number | null
          promo_minimum_units?: number | null
          promo_price_cents?: number | null
          run_id: string
          unit_type: Database["public"]["Enums"]["unit_type"]
          variant: string
        }
        Update: {
          condition_text?: string | null
          copies?: number
          displayed_name?: string
          generated_at?: string
          group_id?: string
          id?: string
          list_price_cents?: number
          organization_id?: string
          position?: number
          product_id?: string
          promo_discount_bps?: number | null
          promo_minimum_units?: number | null
          promo_price_cents?: number | null
          run_id?: string
          unit_type?: Database["public"]["Enums"]["unit_type"]
          variant?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_label_print_run_items_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_label_print_run_items_run_id_organization_id_fkey"
            columns: ["run_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "product_label_print_runs"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_label_print_runs: {
        Row: {
          branch_id: string | null
          generated_at: string
          generated_by: string | null
          group_id: string
          id: string
          label_count: number
          organization_id: string
          product_count: number
        }
        Insert: {
          branch_id?: string | null
          generated_at?: string
          generated_by?: string | null
          group_id: string
          id?: string
          label_count: number
          organization_id: string
          product_count: number
        }
        Update: {
          branch_id?: string | null
          generated_at?: string
          generated_by?: string | null
          group_id?: string
          id?: string
          label_count?: number
          organization_id?: string
          product_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_label_print_runs_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_label_print_runs_group_id_organization_id_fkey"
            columns: ["group_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "product_label_groups"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_pack_versions: {
        Row: {
          created_at: string
          created_by: string | null
          discount_bps: number
          id: string
          organization_id: string
          pack_size_units: number
          product_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          discount_bps: number
          id?: string
          organization_id: string
          pack_size_units: number
          product_id: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          discount_bps?: number
          id?: string
          organization_id?: string
          pack_size_units?: number
          product_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_pack_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_pack_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_pack_versions_product_id_organization_id_fkey"
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
      product_suppliers: {
        Row: {
          created_at: string
          is_primary: boolean
          organization_id: string
          product_id: string
          supplier_id: string
          supplier_sku: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          is_primary?: boolean
          organization_id: string
          product_id: string
          supplier_id: string
          supplier_sku?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          is_primary?: boolean
          organization_id?: string
          product_id?: string
          supplier_id?: string
          supplier_sku?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_suppliers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_suppliers_product_id_organization_id_fkey"
            columns: ["product_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "product_suppliers_supplier_id_organization_id_fkey"
            columns: ["supplier_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      product_weight_discounts: {
        Row: {
          active: boolean
          branch_id: string | null
          created_at: string
          discount_type:
            | Database["public"]["Enums"]["weight_discount_type"]
            | null
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
          discount_type?:
            | Database["public"]["Enums"]["weight_discount_type"]
            | null
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
          discount_type?:
            | Database["public"]["Enums"]["weight_discount_type"]
            | null
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
          pack_discount_bps: number | null
          pack_size_units: number | null
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
          pack_discount_bps?: number | null
          pack_size_units?: number | null
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
          pack_discount_bps?: number | null
          pack_size_units?: number | null
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
      quick_stock_requests: {
        Row: {
          created_at: string
          created_by: string | null
          organization_id: string
          payload_hash: string
          request_key: string
          result: Json | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          organization_id: string
          payload_hash: string
          request_key: string
          result?: Json | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          organization_id?: string
          payload_hash?: string
          request_key?: string
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "quick_stock_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quick_stock_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
          branch_promotion_discount_bps: number | null
          branch_promotion_discount_cents: number
          branch_promotion_discounted_units: number | null
          branch_promotion_every_units: number | null
          branch_promotion_id: string | null
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
          manual_adjustment_cents: number
          manual_price_applied: boolean
          manual_unit_price_cents: number | null
          organization_id: string
          original_price_per_kg_cents: number
          pack_config_id: string | null
          pack_count: number | null
          pack_discount_bps: number | null
          pack_discount_cents: number
          pack_size_units_snapshot: number | null
          price_per_kg_cents: number
          product_id: string
          product_name_snapshot: string
          profit_markup_bps_snapshot: number | null
          promotion_discount_cents: number
          promotion_mode: Database["public"]["Enums"]["promotion_mode"] | null
          quantity_units: number | null
          sale_id: string
          sold_as_pack: boolean
          subtotal_cents: number
          ticket_discount_cents: number
          weight_grams: number | null
        }
        Insert: {
          branch_id: string
          branch_promotion_discount_bps?: number | null
          branch_promotion_discount_cents?: number
          branch_promotion_discounted_units?: number | null
          branch_promotion_every_units?: number | null
          branch_promotion_id?: string | null
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
          manual_adjustment_cents?: number
          manual_price_applied?: boolean
          manual_unit_price_cents?: number | null
          organization_id: string
          original_price_per_kg_cents: number
          pack_config_id?: string | null
          pack_count?: number | null
          pack_discount_bps?: number | null
          pack_discount_cents?: number
          pack_size_units_snapshot?: number | null
          price_per_kg_cents: number
          product_id: string
          product_name_snapshot: string
          profit_markup_bps_snapshot?: number | null
          promotion_discount_cents?: number
          promotion_mode?: Database["public"]["Enums"]["promotion_mode"] | null
          quantity_units?: number | null
          sale_id: string
          sold_as_pack?: boolean
          subtotal_cents: number
          ticket_discount_cents?: number
          weight_grams?: number | null
        }
        Update: {
          branch_id?: string
          branch_promotion_discount_bps?: number | null
          branch_promotion_discount_cents?: number
          branch_promotion_discounted_units?: number | null
          branch_promotion_every_units?: number | null
          branch_promotion_id?: string | null
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
          manual_adjustment_cents?: number
          manual_price_applied?: boolean
          manual_unit_price_cents?: number | null
          organization_id?: string
          original_price_per_kg_cents?: number
          pack_config_id?: string | null
          pack_count?: number | null
          pack_discount_bps?: number | null
          pack_discount_cents?: number
          pack_size_units_snapshot?: number | null
          price_per_kg_cents?: number
          product_id?: string
          product_name_snapshot?: string
          profit_markup_bps_snapshot?: number | null
          promotion_discount_cents?: number
          promotion_mode?: Database["public"]["Enums"]["promotion_mode"] | null
          quantity_units?: number | null
          sale_id?: string
          sold_as_pack?: boolean
          subtotal_cents?: number
          ticket_discount_cents?: number
          weight_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_branch_promotion_id_fkey"
            columns: ["branch_promotion_id"]
            isOneToOne: false
            referencedRelation: "branch_promotions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_discount_rule_id_fkey"
            columns: ["discount_rule_id"]
            isOneToOne: false
            referencedRelation: "product_weight_discounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_pack_config_id_fkey"
            columns: ["pack_config_id"]
            isOneToOne: false
            referencedRelation: "product_pack_versions"
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
          ticket_discount_bps: number
          ticket_discount_cents: number
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
          ticket_discount_bps?: number
          ticket_discount_cents?: number
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
          ticket_discount_bps?: number
          ticket_discount_cents?: number
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
      signage_promotion_group_items: {
        Row: {
          created_at: string
          group_id: string
          id: string
          organization_id: string
          position: number
          promotion_id: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          organization_id: string
          position: number
          promotion_id: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          organization_id?: string
          position?: number
          promotion_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "signage_promotion_group_items_group_id_organization_id_fkey"
            columns: ["group_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "signage_promotion_groups"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "signage_promotion_group_items_promotion_id_organization_id_fkey"
            columns: ["promotion_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "product_weight_discounts"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      signage_promotion_groups: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "signage_promotion_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          import_batch_id: string | null
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
          import_batch_id?: string | null
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
          import_batch_id?: string | null
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
            foreignKeyName: "stock_movements_import_batch_fk"
            columns: ["import_batch_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
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
          total_units: number
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
          total_units?: number
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
          total_units?: number
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
      suppliers: {
        Row: {
          active: boolean
          code: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          code?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          organization_id: string
          phone?: string | null
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          organization_id?: string
          phone?: string | null
          tax_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_deliveries: {
        Row: {
          branch_id: string
          channel: string
          claim_id: string | null
          created_at: string
          delivered_at: string | null
          device_id: string | null
          failed_at: string | null
          id: string
          organization_id: string
          provider_error_code: string | null
          provider_error_message: string | null
          provider_message_id: string | null
          read_at: string | null
          recipient_phone: string
          recipient_phone_masked: string | null
          requested_by: string | null
          sale_id: string
          sent_at: string | null
          status: string
          template_name: string | null
          updated_at: string
        }
        Insert: {
          branch_id: string
          channel?: string
          claim_id?: string | null
          created_at?: string
          delivered_at?: string | null
          device_id?: string | null
          failed_at?: string | null
          id?: string
          organization_id: string
          provider_error_code?: string | null
          provider_error_message?: string | null
          provider_message_id?: string | null
          read_at?: string | null
          recipient_phone: string
          recipient_phone_masked?: string | null
          requested_by?: string | null
          sale_id: string
          sent_at?: string | null
          status?: string
          template_name?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string
          channel?: string
          claim_id?: string | null
          created_at?: string
          delivered_at?: string | null
          device_id?: string | null
          failed_at?: string | null
          id?: string
          organization_id?: string
          provider_error_code?: string | null
          provider_error_message?: string | null
          provider_message_id?: string | null
          read_at?: string | null
          recipient_phone?: string
          recipient_phone_masked?: string | null
          requested_by?: string | null
          sale_id?: string
          sent_at?: string | null
          status?: string
          template_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_deliveries_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_ticket_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_deliveries_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_deliveries_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_deliveries_sale_id_organization_id_branch_id_fkey"
            columns: ["sale_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "organization_id", "branch_id"]
          },
        ]
      }
      ticket_delivery_events: {
        Row: {
          dedupe_key: string
          delivery_count: number
          delivery_id: string | null
          error_code: string | null
          error_message: string | null
          event_at: string | null
          event_status: string
          id: string
          last_received_at: string
          provider_message_id: string
          received_at: string
          result: string
        }
        Insert: {
          dedupe_key: string
          delivery_count?: number
          delivery_id?: string | null
          error_code?: string | null
          error_message?: string | null
          event_at?: string | null
          event_status: string
          id?: string
          last_received_at?: string
          provider_message_id: string
          received_at?: string
          result: string
        }
        Update: {
          dedupe_key?: string
          delivery_count?: number
          delivery_id?: string | null
          error_code?: string | null
          error_message?: string | null
          event_at?: string | null
          event_status?: string
          id?: string
          last_received_at?: string
          provider_message_id?: string
          received_at?: string
          result?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_delivery_events_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "ticket_deliveries"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_ticket_claims: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          device_id: string | null
          expires_at: string
          id: string
          organization_id: string
          redeemed_at: string | null
          redeemed_message_id: string | null
          redeemed_phone: string | null
          sale_id: string
          token_hash: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          device_id?: string | null
          expires_at: string
          id?: string
          organization_id: string
          redeemed_at?: string | null
          redeemed_message_id?: string | null
          redeemed_phone?: string | null
          sale_id: string
          token_hash: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          device_id?: string | null
          expires_at?: string
          id?: string
          organization_id?: string
          redeemed_at?: string | null
          redeemed_message_id?: string | null
          redeemed_phone?: string | null
          sale_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_ticket_claims_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_ticket_claims_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "pos_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_ticket_claims_sale_id_organization_id_branch_id_fkey"
            columns: ["sale_id", "organization_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "organization_id", "branch_id"]
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
          unit_type: Database["public"]["Enums"]["unit_type"] | null
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
      apply_import_batch: {
        Args: { p_batch_id: string; p_skip_errors?: boolean }
        Returns: Json
      }
      apply_pricing_receipt: {
        Args: { p_items: Json; p_request_key: string }
        Returns: Json
      }
      apply_quick_stock_changes: {
        Args: { p_items: Json; p_request_key: string }
        Returns: Json
      }
      bulk_set_product_costs: {
        Args: { p_effective_at?: string; p_items: Json }
        Returns: Json
      }
      bulk_set_product_prices: {
        Args: { p_branch_id?: string; p_effective_at?: string; p_items: Json }
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
      cancel_import_batch: { Args: { p_batch_id: string }; Returns: Json }
      cancel_production_batch: {
        Args: { p_batch_id: string }
        Returns: undefined
      }
      cancel_sale: {
        Args: { p_idempotency_key: string; p_reason: string; p_sale_id: string }
        Returns: Json
      }
      close_branch_price_overrides: {
        Args: { p_product_ids?: string[] }
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
      complete_missing_sale_costs: {
        Args: {
          p_also_set_current_cost?: boolean
          p_branch_id: string
          p_from: string
          p_line_ids: string[]
          p_product_id: string
          p_to: string
          p_unit_cost_cents: number
        }
        Returns: Json
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
      copy_branch_assortment: {
        Args: { p_destination_branch_id: string; p_source_branch_id: string }
        Returns: number
      }
      correct_employee_shift: {
        Args: {
          p_clock_out_local: string
          p_reason: string
          p_shift_id: string
        }
        Returns: undefined
      }
      create_import_batch: {
        Args: {
          p_branch_id?: string
          p_entity_type: string
          p_file_name?: string
          p_file_sha256?: string
          p_options?: Json
          p_source_system: string
        }
        Returns: string
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
      create_pos_quick_product: {
        Args: {
          p_barcode: string
          p_cost_cents?: number
          p_device_id: string
          p_name: string
          p_operator_profile_id: string
          p_operator_token: string
          p_price_cents: number
        }
        Returns: Json
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
      create_signage_display: {
        Args: { p_branch_id?: string; p_name: string }
        Returns: Json
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
      deactivate_products: { Args: { p_product_ids: string[] }; Returns: Json }
      delete_branch: { Args: { p_branch_id: string }; Returns: undefined }
      delete_production_batch: {
        Args: { p_batch_id: string }
        Returns: undefined
      }
      get_admin_dashboard: { Args: { p_branch_id?: string }; Returns: Json }
      get_artwork_branding: { Args: { p_branch_id?: string }; Returns: Json }
      delete_signage_group: {
        Args: {
          p_group_id: string
        }
        Returns: Json
      }
      end_branch_recurring_cost: {
        Args: {
          p_cost_id: string
          p_effective_to: string
        }
        Returns: Json
      }
      get_branch_carry_plan: {
        Args: { p_branch_id?: string }
        Returns: {
          branch_id: string
          branch_name: string
          calculated_at: string
          current_quantity: number
          product_id: string
          product_name: string
          sold_quantity: number
          suggested_quantity: number
          unit_type: Database["public"]["Enums"]["unit_type"]
          window_days: number
          window_start: string
        }[]
      }
      get_branch_operating_costs: {
        Args: {
          p_branch_id: string
          p_from: string
          p_to: string
        }
        Returns: Json
      }
      get_branch_operating_result: {
        Args: { p_branch_id?: string; p_from: string; p_to: string }
        Returns: {
          branch_id: string
          branch_name: string
          expense_cents: number
          gross_profit_cents: number
          is_partial: boolean
          labor_cost_cents: number
          labor_open_shifts: number
          labor_rate_missing: boolean
          labor_review_shifts: number
          labor_worked_seconds: number
          missing_cost_items: number
          missing_cost_revenue_cents: number
          missing_cost_sales: number
          operating_cost_cents: number
          operating_margin_bps: number
          operating_result_cents: number
          recurring_cost_cents: number
          revenue_cents: number
        }[]
      }
      get_branch_operations_summary: {
        Args: { p_branch_id: string; p_from: string; p_to: string }
        Returns: {
          current_quantity: number
          last_inbound_at: string
          last_sale_at: string
          ledger_mismatch_quantity: number
          ledger_mismatch_tickets: number
          product_id: string
          product_name: string
          revenue_period_cents: number
          sold_14d: number
          sold_7d: number
          sold_period: number
          sold_previous: number
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      get_branch_profitability_summary: {
        Args: { p_branch_id?: string; p_from: string; p_to: string }
        Returns: {
          branch_id: string
          branch_name: string
          cost_cents: number
          costed_revenue_cents: number
          gross_margin_bps: number
          gross_profit_cents: number
          missing_cost_items: number
          missing_cost_revenue_cents: number
          missing_cost_sales: number
          revenue_cents: number
        }[]
      }
      get_branch_sales_summary: {
        Args: { p_branch_id?: string; p_from: string; p_to: string }
        Returns: {
          branch_id: string
          branch_name: string
          previous_total_cents: number
          sales_count: number
          total_cents: number
          units: number
          weight_grams: number
        }[]
      }
      get_branch_stock_status: {
        Args: {
          p_branch_id?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_status?: string
        }
        Returns: {
          branch_id: string
          branch_name: string
          current_stock_grams: number
          minimum_stock_grams: number
          product_id: string
          product_name: string
          sku: string
          stock_status: string
          suggested_replenishment_grams: number
          target_stock_grams: number
          total_count: number
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      get_branch_stock_summary: {
        Args: never
        Returns: {
          branch_id: string
          branch_name: string
          low_stock_count: number
          out_of_stock_count: number
          product_count: number
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
      get_import_batch: { Args: { p_batch_id: string }; Returns: Json }
      get_label_group: { Args: { p_group_id: string }; Returns: Json }
      get_mercadopago_branch_pos: {
        Args: never
        Returns: {
          branch_id: string
          branch_name: string
          enabled: boolean
          expiration_minutes: number
          external_pos_id: string
          mp_pos_id: string
          mp_store_id: string
          qr_mode: string
          require_verified_digital_payments: boolean
        }[]
      }
      get_mercadopago_reconciliation: {
        Args: {
          p_branch_id?: string
          p_from: string
          p_only_issues?: boolean
          p_to: string
        }
        Returns: {
          attempts: number
          branch_id: string
          branch_name: string
          cancelled_at: string
          classification: string
          confirmed_amount_cents: number
          confirmed_at: string
          expected_amount_cents: number
          expired_at: string
          mp_order_id: string
          mp_payment_id: string
          occurred_at: string
          order_created_at: string
          order_status: string
          sale_id: string
          sale_status: string
          sale_total_cents: number
          verification_status: string
        }[]
      }
      get_missing_sale_costs: {
        Args: { p_branch_id: string; p_from: string; p_to: string }
        Returns: Json
      }
      get_pos_branch_stock: { Args: { p_branch_id: string }; Returns: Json }
      get_pos_catalog: {
        Args: { p_branch_id: string }
        Returns: {
          barcodes: string[]
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
        Returns: {
          color_hex: string
          id: string
          name: string
          sort_order: number
        }[]
      }
      get_pos_commercial_config: {
        Args: { p_branch_id: string }
        Returns: Json
      }
      get_pos_device_capabilities: {
        Args: { p_device_id: string }
        Returns: Json
      }
      get_pos_operator_roster: { Args: { p_device_id: string }; Returns: Json }
      get_product_artwork: {
        Args: { p_branch_id?: string; p_product_id: string }
        Returns: Json
      }
      get_product_artwork_photo: {
        Args: { p_product_id: string }
        Returns: Json
      }
      get_product_branch_activity: {
        Args: { p_product_id: string }
        Returns: {
          branch_id: string
          branch_name: string
          current_quantity: number
          is_production: boolean
          last_sale_at: string
          sold_7d: number
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      get_product_sales_summary: {
        Args: {
          p_branch_id?: string
          p_from: string
          p_product_id: string
          p_to: string
        }
        Returns: {
          branch_id: string
          branch_name: string
          quantity: number
          revenue_cents: number
          tickets: number
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
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
      get_products_unit_type_locks: {
        Args: { p_product_ids: string[] }
        Returns: string[]
      }
      get_products_with_unit_type_history: { Args: never; Returns: string[] }
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
      get_signage_display: { Args: { p_token: string }; Returns: Json }
      get_signage_display_admin: {
        Args: { p_display_id: string }
        Returns: Json
      }
      get_signage_promotion_catalog: {
        Args: {
          p_applicable_only?: boolean
          p_branch_id?: string
        }
        Returns: Json
      }
      get_stock_audit_summary: {
        Args: {
          p_branch_id: string
          p_from?: string
          p_product_id: string
          p_since_last_inbound?: boolean
          p_to?: string
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
      list_import_batch_suppliers: {
        Args: { p_batch_id: string }
        Returns: Json
      }
      list_label_groups: {
        Args: { p_include_inactive?: boolean }
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
      list_pricing_rows: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_product_ids?: string[]
          p_query?: string
        }
        Returns: Json
      }
      list_products_page: {
        Args: {
          p_branch_id?: string
          p_category_id?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_status?: string
        }
        Returns: {
          active: boolean
          barcodes: string[]
          branch_ids: string[]
          category_id: string
          inventory_role: Database["public"]["Enums"]["product_inventory_role"]
          product_id: string
          product_name: string
          sku: string
          slug: string
          total_count: number
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      list_stock_audit_movements: {
        Args: {
          p_branch_id: string
          p_from?: string
          p_limit?: number
          p_newest_first?: boolean
          p_offset?: number
          p_product_id: string
          p_since_last_inbound?: boolean
          p_to?: string
        }
        Returns: Json
      }
      list_stock_transfers: {
        Args: { p_branch_id?: string; p_limit?: number }
        Returns: Json
      }
      list_suppliers_page: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_status?: string
        }
        Returns: {
          active: boolean
          code: string
          email: string
          name: string
          notes: string
          phone: string
          product_count: number
          supplier_id: string
          tax_id: string
          total_count: number
        }[]
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
      mp_abandon_unpaid_sale: {
        Args: { p_device_id: string; p_sale_id: string }
        Returns: Json
      }
      mp_admin_context: { Args: never; Returns: Json }
      mp_apply_order_state: {
        Args: {
          p_external_reference: string
          p_mp_order_id: string
          p_mp_payment_id: string
          p_mp_status: string
          p_mp_status_detail: string
          p_new_status: string
          p_paid_amount_cents: number
          p_source?: string
          p_total_amount_cents: number
        }
        Returns: Json
      }
      mp_get_branch_config: { Args: { p_device_id: string }; Returns: Json }
      mp_get_order_status: {
        Args: { p_device_id: string; p_sale_id: string }
        Returns: Json
      }
      mp_prepare_order: {
        Args: {
          p_amount_cents: number
          p_device_id: string
          p_operator_profile_id: string
          p_operator_token: string
          p_retry?: boolean
          p_sale_id: string
        }
        Returns: Json
      }
      mp_record_order_result: {
        Args: {
          p_error_code: string
          p_mp_order_id: string
          p_mp_payment_id: string
          p_mp_status: string
          p_mp_status_detail: string
          p_order_id: string
        }
        Returns: Json
      }
      mp_record_webhook_event: {
        Args: {
          p_action: string
          p_dedupe_key: string
          p_event_type: string
          p_external_reference: string
          p_mp_order_id: string
          p_mp_status: string
          p_mp_status_detail: string
          p_request_id: string
          p_result: string
        }
        Returns: number
      }
      preview_import_batch: { Args: { p_batch_id: string }; Returns: Json }
      preview_import_product_purge: {
        Args: { p_candidates: Json; p_source_system: string }
        Returns: Json
      }
      preview_import_zero_price_purge: {
        Args: { p_source_system: string }
        Returns: Json
      }
      publish_restock_announcement: {
        Args: { p_message: string; p_restock_event_id: string; p_title: string }
        Returns: string
      }
      pull_pos_state: {
        Args: { p_after_sequence?: number; p_device_id: string }
        Returns: Json
      }
      purge_import_products: {
        Args: {
          p_candidates: Json
          p_expected_delete_count: number
          p_source_system: string
        }
        Returns: Json
      }
      purge_import_zero_price_products: {
        Args: {
          p_batch_size?: number
          p_expected_delete_count: number
          p_source_system: string
        }
        Returns: Json
      }
      record_branch_expense: {
        Args: {
          p_amount_cents: number
          p_branch_id: string
          p_concept: string
          p_expense_date: string
          p_request_key?: string
        }
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
      record_label_print_run: {
        Args: { p_group_id: string; p_items: Json }
        Returns: Json
      }
      record_shift_heartbeat: {
        Args: {
          p_device_id: string
          p_employee_id: string
          p_occurred_at?: string
          p_operator_token: string
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
      regenerate_signage_token: {
        Args: { p_display_id: string }
        Returns: Json
      }
      register_pos_device: {
        Args: { p_branch_id: string; p_device_id: string; p_label?: string }
        Returns: Json
      }
      remove_organization_artwork_logo: { Args: never; Returns: Json }
      remove_product_artwork_photo: {
        Args: { p_product_id: string }
        Returns: Json
      }
      remove_production_batch_output: {
        Args: { p_output_id: string }
        Returns: undefined
      }
      resolve_pos_scan_barcode: {
        Args: {
          p_barcode: string
          p_device_id: string
          p_operator_profile_id: string
          p_operator_token: string
        }
        Returns: Json
      }
      resolve_product_barcode: {
        Args: { p_barcode: string }
        Returns: {
          active: boolean
          product_id: string
          product_name: string
          sku: string
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
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
      save_branch_promotion: {
        Args: {
          p_active?: boolean
          p_branch_id: string
          p_discount_bps: number
          p_every_units: number
        }
        Returns: string
      }
      save_branch_recurring_cost: {
        Args: {
          p_amount_cents: number
          p_branch_id: string
          p_cost_id: string
          p_effective_from: string
          p_name: string
          p_request_key?: string
        }
        Returns: Json
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
      save_label_group: {
        Args: {
          p_active?: boolean
          p_branch_id: string
          p_group_id: string
          p_name: string
        }
        Returns: Json
      }
      save_pricing_config: {
        Args: {
          p_card_surcharge_bps: number
          p_close_branch_overrides?: boolean
          p_confirm?: boolean
          p_excluded_category_ids?: string[]
          p_margin_bps: number
          p_pack_discount_bps: number
          p_quantity_tiers?: Json
          p_unit_bulk_discount_bps: number
        }
        Returns: Json
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
      save_signage_display: {
        Args: {
          p_branch_id: string
          p_display_id: string
          p_enabled: boolean
          p_name: string
          p_product_ids: string[]
          p_slide_duration_seconds: number
        }
        Returns: Json
      }
      save_signage_display_entries: {
        Args: {
          p_branch_id: string
          p_display_id: string
          p_enabled: boolean
          p_entries: Json
          p_name: string
          p_slide_duration_seconds: number
        }
        Returns: Json
      }
      save_signage_group: {
        Args: {
          p_group_id: string
          p_name: string
          p_promotion_ids: string[]
        }
        Returns: Json
      }
      save_supplier: {
        Args: {
          p_active?: boolean
          p_code?: string
          p_email?: string
          p_name: string
          p_notes?: string
          p_phone?: string
          p_supplier_id: string
          p_tax_id?: string
        }
        Returns: string
      }
      save_weight_discount:
        | {
            Args: {
              p_active: boolean
              p_branch_id: string
              p_discount_type: string
              p_discount_value: number
              p_id: string
              p_minimum_grams: number
              p_product_id: string
              p_valid_from: string
              p_valid_until?: string
            }
            Returns: string
          }
        | {
            Args: {
              p_active: boolean
              p_branch_id: string
              p_discount_type: string
              p_discount_value: number
              p_id: string
              p_minimum_grams: number
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
      search_products: {
        Args: {
          p_active_only?: boolean
          p_branch_id?: string
          p_limit?: number
          p_query?: string
        }
        Returns: {
          active: boolean
          barcodes: string[]
          product_id: string
          product_name: string
          sku: string
          unit_type: Database["public"]["Enums"]["unit_type"]
        }[]
      }
      set_branch_active: {
        Args: { p_active: boolean; p_branch_id: string }
        Returns: undefined
      }
      set_branch_artwork_contact: {
        Args: { p_address: string; p_branch_id: string; p_city: string; p_phone: string }
        Returns: Json
      }
      set_branch_products: {
        Args: {
          p_branch_id: string
          p_enabled: boolean
          p_product_ids: string[]
        }
        Returns: number
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
      set_label_group_products: {
        Args: { p_add: string[]; p_group_id: string; p_remove?: string[] }
        Returns: Json
      }
      set_mercadopago_branch_pos: {
        Args: {
          p_branch_id: string
          p_enabled?: boolean
          p_expiration_minutes?: number
          p_external_pos_id: string
          p_mp_pos_id?: string
          p_mp_store_id?: string
          p_qr_mode?: string
          p_require_verified_digital_payments?: boolean
        }
        Returns: string
      }
      set_organization_artwork_logo: {
        Args: { p_height_px: number; p_storage_path: string; p_width_px: number }
        Returns: Json
      }
      set_pos_device_status: {
        Args: {
          p_device_id: string
          p_status: Database["public"]["Enums"]["pos_device_status"]
        }
        Returns: undefined
      }
      set_pos_product_price: {
        Args: {
          p_device_id: string
          p_operator_profile_id: string
          p_operator_token: string
          p_price_cents: number
          p_product_id: string
        }
        Returns: Json
      }
      set_product_artwork_photo: {
        Args: { p_product_id: string; p_storage_path: string }
        Returns: Json
      }
      set_product_barcodes: {
        Args: { p_barcodes: string[]; p_product_id: string }
        Returns: string[]
      }
      set_product_branches: {
        Args: { p_branch_ids: string[]; p_product_id: string }
        Returns: Json
      }
      set_product_categories: {
        Args: {
          p_category_ids: string[]
          p_primary_category_id: string
          p_product_id: string
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
      set_product_custom_margin: {
        Args: {
          p_margin_bps: number
          p_product_id: string
          p_reprice?: boolean
        }
        Returns: Json
      }
      set_product_inventory_role: {
        Args: { p_inventory_role: string; p_product_id: string }
        Returns: undefined
      }
      set_product_pack_size: {
        Args: {
          p_pack_discount_bps?: number
          p_pack_size_units: number
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
      set_product_primary_supplier: {
        Args: { p_product_id: string; p_supplier_id: string }
        Returns: Json
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
      set_supplier_active: {
        Args: { p_active: boolean; p_supplier_id: string }
        Returns: undefined
      }
      set_timekeeping_max_shift_hours: {
        Args: { p_hours: number }
        Returns: undefined
      }
      stage_import_rows: {
        Args: { p_batch_id: string; p_rows: Json }
        Returns: Json
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
      void_branch_expense: {
        Args: {
          p_expense_id: string
          p_reason: string
        }
        Returns: Json
      }
      void_settlement: {
        Args: { p_reason: string; p_settlement_id: string }
        Returns: undefined
      }
      wa_apply_status_event: {
        Args: {
          p_dedupe_key: string
          p_error_code: string
          p_error_message: string
          p_event_at: string
          p_provider_message_id: string
          p_status: string
        }
        Returns: Json
      }
      wa_create_claim: {
        Args: {
          p_device_id: string
          p_operator_profile_id: string
          p_operator_token: string
          p_sale_id: string
        }
        Returns: Json
      }
      wa_prepare_ticket: {
        Args: {
          p_device_id: string
          p_operator_profile_id: string
          p_operator_token: string
          p_phone: string
          p_resend?: boolean
          p_sale_id: string
        }
        Returns: Json
      }
      wa_record_send_result: {
        Args: {
          p_delivery_id: string
          p_error_code: string
          p_error_message: string
          p_provider_message_id: string
          p_template_name?: string
        }
        Returns: Json
      }
      wa_redeem_claim: {
        Args: {
          p_from: string
          p_message_id: string
          p_received_at?: string
          p_token: string
        }
        Returns: Json
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
      sale_status:
        | "DRAFT"
        | "COMPLETED"
        | "CANCELLED"
        | "REFUNDED"
        | "PENDING_PAYMENT"
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
        | "OPENING_BALANCE"
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
      sale_status: [
        "DRAFT",
        "COMPLETED",
        "CANCELLED",
        "REFUNDED",
        "PENDING_PAYMENT",
      ],
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
        "OPENING_BALANCE",
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
