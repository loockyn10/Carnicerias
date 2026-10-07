import type { Database as GeneratedDatabase, Json } from "./database.types";

/**
 * Manual nullability corrections layered on top of the generated Supabase types.
 *
 * Why this exists: `pnpm db:types` (`supabase gen types typescript --local`) derives each RPC
 * argument's TypeScript type purely from its declared Postgres type (e.g. `uuid` -> `string`) and
 * marks it optional only when the SQL parameter has a `default`. Postgres has no "not null"
 * concept for function parameters — any parameter, with or without a default, can always be
 * called with SQL NULL — so the generator has no signal to add `| null` even when a function's
 * own body treats that null as meaningful, e.g.:
 *
 *   - save_branch / save_category / save_product: p_branch_id / p_category_id / p_product_id
 *     have no default, but the function branches on them — null means "create", a real id means
 *     "update this row". save_branch's p_address is also `default null` in SQL and genuinely
 *     optional (a branch with no street address is valid).
 *   - set_product_price: p_branch_id null means "the global price"; p_price_cents null means
 *     "close this price range without a replacement".
 *   - manage_existing_member: p_branch_id is null for an admin membership, required only when
 *     p_role_key = 'employee'.
 *   - record_stock_operation / confirm_settlement / get_profitability_analytics /
 *     get_settlement_history / get_timekeeping_report: several optional filter/note parameters
 *     are declared `default null` in SQL, where an explicit null and omitting the key are
 *     identical at the database level, but `exactOptionalPropertyTypes` (tsconfig.base.json)
 *     rejects an explicit null against a plain `T` (or even `T | undefined` without `| null`).
 *
 * The same generator limitation also shows up on a RETURN column, not just arguments:
 * list_organization_members left-joins auth.users (an internal POS employee has no
 * auth_user_id, hence no email), so `email` is genuinely nullable in the real result set, but
 * the generator has no way to see that a LEFT JOIN column can be null either — it just uses the
 * declared `text` column type. That correction lives here too.
 *
 * That distinction only lives in each function's own body, which codegen cannot see, so every
 * regeneration silently drops it — hand-editing it into database.types.ts directly would just
 * get lost the next time someone runs `pnpm db:types` (confirmed: the generator emits a plain,
 * non-null type for every one of these; it never itself writes `| null`, with or without this
 * file). This file is the durable place for it: it imports the generated `Database` unmodified
 * and only overrides the `Functions` entries listed below via `RpcNullOverrides`; the merge
 * happens once, in database.merged.ts. `database.types.ts` itself stays exactly what
 * `pnpm db:types` would produce, safe to regenerate at any time.
 *
 * Keep this file to nullability-only corrections (same parameter set, only `| null` added).
 * If a migration changes one of these RPCs' actual argument list, regenerate database.types.ts
 * and update the matching entry here to match the new shape — the compile-time guard below only
 * checks that each overridden key still exists as an RPC in the generated file, not that its
 * shape still matches, so review the diff of `pnpm db:types` against these entries when a touched
 * migration lands.
 */
export interface RpcNullOverrides {
  confirm_settlement: {
    Args: {
      p_branch_id: string
      p_notes?: string | null
      p_period_end_local: string
      p_period_start_local: string
      p_received_cash_cents: number
    }
    Returns: string
  }
  get_profitability_analytics: {
    Args: {
      p_branch_id?: string | null
      p_category_id?: string | null
      p_from?: string | null
      p_preset?: string
      p_product_id?: string | null
      p_to?: string | null
    }
    Returns: Json
  }
  get_settlement_history: {
    Args: {
      p_branch_id?: string | null
      p_from?: string | null
      p_has_difference?: boolean | null
      p_settlement_id?: string | null
      p_to?: string | null
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
      // See the file-level comment: a member with no linked Auth user (an internal POS
      // employee) has no email, from the LEFT JOIN in list_organization_members.
      email: string | null
      profile_id: string
      role_key: string
      status: GeneratedDatabase["public"]["Enums"]["membership_status"]
    }[]
  }
  get_timekeeping_report: {
    Args: {
      p_branch_id?: string | null
      p_employee_id?: string | null
      p_from: string
      p_to: string
    }
    Returns: Json
  }
  manage_existing_member: {
    Args: {
      p_branch_id: string | null
      p_display_name: string
      p_email: string
      p_role_key: string
      p_status?: GeneratedDatabase["public"]["Enums"]["membership_status"]
    }
    Returns: string
  }
  record_stock_operation: {
    Args: {
      p_branch_id: string
      p_items: Json
      p_note?: string | null
      p_occurred_at?: string
      p_operation_type: string
      p_supplier?: string | null
      p_waste_reason?: string | null
    }
    Returns: string
  }
  save_branch: {
    Args: {
      p_active?: boolean
      p_address?: string | null
      p_branch_id: string | null
      p_code: string
      p_name: string
    }
    Returns: string
  }
  save_category:
    | {
        Args: {
          p_active?: boolean
          p_category_id: string | null
          p_name: string
          p_slug: string
          p_sort_order?: number
        }
        Returns: string
      }
    | {
        Args: {
          p_active: boolean
          p_category_id: string | null
          p_color_hex: string | null
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
      p_product_id: string | null
      p_sku: string
      p_slug: string
      p_unit_type: GeneratedDatabase["public"]["Enums"]["unit_type"]
    }
    Returns: string
  }
  // p_branch_id/p_file_name/p_file_sha256/p_options are `default null`/optional in SQL (only the
  // stock opening import needs a branch); explicit null and omitted are identical there.
  create_import_batch: {
    Args: {
      p_branch_id?: string | null
      p_entity_type: string
      p_file_name?: string | null
      p_file_sha256?: string | null
      p_options?: Json
      p_source_system: string
    }
    Returns: string
  }
  // products.sku is nullable (products without an internal code); the generator types a
  // `returns table` column from its declared SQL type only, so it cannot see that.
  resolve_product_barcode: {
    Args: { p_barcode: string }
    Returns: {
      active: boolean
      product_id: string
      product_name: string
      sku: string | null
      unit_type: GeneratedDatabase["public"]["Enums"]["unit_type"]
    }[]
  }
  // sku / category_id are nullable columns of products; the generator types a `returns table`
  // column from its declared SQL type only.
  list_products_page: {
    Args: {
      p_branch_id?: string | null
      p_category_id?: string | null
      p_limit?: number
      p_offset?: number
      p_search?: string | null
      p_status?: string
    }
    Returns: {
      active: boolean
      barcodes: string[]
      branch_ids: string[]
      category_id: string | null
      inventory_role: GeneratedDatabase["public"]["Enums"]["product_inventory_role"]
      product_id: string
      product_name: string
      sku: string | null
      slug: string
      total_count: number
      unit_type: GeneratedDatabase["public"]["Enums"]["unit_type"]
    }[]
  }
  get_branch_stock_status: {
    Args: {
      p_branch_id?: string | null
      p_limit?: number | null
      p_offset?: number
      p_search?: string | null
      p_status?: string | null
    }
    Returns: {
      branch_id: string
      branch_name: string
      current_stock_grams: number
      minimum_stock_grams: number
      product_id: string
      product_name: string
      sku: string | null
      stock_status: string
      suggested_replenishment_grams: number
      target_stock_grams: number
      total_count: number
      unit_type: GeneratedDatabase["public"]["Enums"]["unit_type"]
    }[]
  }
  search_products: {
    Args: {
      p_active_only?: boolean
      p_branch_id?: string | null
      p_limit?: number
      p_query?: string | null
    }
    Returns: {
      active: boolean
      barcodes: string[]
      product_id: string
      product_name: string
      sku: string | null
      unit_type: GeneratedDatabase["public"]["Enums"]["unit_type"]
    }[]
  }
  // p_branch_id null = pantalla sin sucursal (precio global de la organización).
  create_signage_display: {
    Args: { p_branch_id?: string | null; p_name: string }
    Returns: Json
  }
  save_signage_display: {
    Args: {
      p_branch_id: string | null
      p_display_id: string
      p_enabled: boolean
      p_name: string
      p_product_ids: string[]
      p_slide_duration_seconds: number
    }
    Returns: Json
  }
  // Etiquetas (D-073): p_group_id null = crear el grupo; p_branch_id null = grupo sin sucursal (precio global de la organización).
  save_label_group: {
    Args: { p_active?: boolean; p_branch_id: string | null; p_group_id: string | null; p_name: string }
    Returns: Json
  }
  // Agregar y/o quitar en lote: cualquiera de las dos listas puede faltar (null = ninguna).
  set_label_group_products: {
    Args: { p_add: string[] | null; p_group_id: string; p_remove?: string[] | null }
    Returns: Json
  }
  // p_margin_bps null = quitar el margen personalizado del producto (vuelve a la regla general).
  set_product_custom_margin: {
    Args: {
      p_margin_bps: number | null
      p_product_id: string
      p_reprice?: boolean
    }
    Returns: Json
  }
  set_product_price: {
    Args: {
      p_branch_id: string | null
      p_effective_at?: string
      p_price_cents: number | null
      p_product_id: string
    }
    Returns: string
  }
  // p_supplier_id null = create; every optional contact field is `default null` in SQL (only the
  // name is mandatory), where explicit null and omitted are the same.
  save_supplier: {
    Args: {
      p_active?: boolean
      p_code?: string | null
      p_email?: string | null
      p_name: string
      p_notes?: string | null
      p_phone?: string | null
      p_supplier_id: string | null
      p_tax_id?: string | null
    }
    Returns: string
  }
  // p_pack_size_units null = "this product has no pack" (quita las unidades por pack y su descuento: p_pack_discount_bps null/omitido).
  set_product_pack_size: {
    Args: { p_pack_discount_bps?: number | null; p_pack_size_units: number | null; p_product_id: string }
    Returns: undefined
  }
  // p_supplier_id null = "this product has no primary supplier".
  set_product_primary_supplier: {
    Args: { p_product_id: string; p_supplier_id: string | null }
    Returns: Json
  }
  // The optional contact columns of suppliers are nullable; a `returns table` column is typed from
  // its declared SQL type only.
  list_suppliers_page: {
    Args: {
      p_limit?: number
      p_offset?: number
      p_search?: string | null
      p_status?: string
    }
    Returns: {
      active: boolean
      code: string | null
      email: string | null
      name: string
      notes: string | null
      phone: string | null
      product_count: number
      supplier_id: string
      tax_id: string | null
      total_count: number
    }[]
  }
}

// Every key overridden here must still exist as an RPC in the generated file. If a migration
// drops or renames one of them, this fails to compile instead of silently layering an override
// onto a function that no longer exists.
type _KeysStillExistInGenerated =
  keyof RpcNullOverrides extends keyof GeneratedDatabase["public"]["Functions"] ? true : false;
const _keysStillExistInGenerated: _KeysStillExistInGenerated extends true ? true : never = true;
export { _keysStillExistInGenerated as _rpcNullOverridesKeysStillExistInGenerated };
