import type { Database as GeneratedDatabase } from "./database.types";
import type { RpcNullOverrides } from "./database.rpc-null-overrides";

type GeneratedFunctions = GeneratedDatabase["public"]["Functions"];

// A per-key conditional inside a homomorphic mapped type ([K in keyof GeneratedFunctions]),
// rather than `Omit<GeneratedFunctions, keyof RpcNullOverrides> & RpcNullOverrides`: the Omit+
// intersect version type-checks the same way when inspected directly, but it stopped
// @supabase/supabase-js's own generic `SupabaseClient<Database>.rpc(name, args)` overloads from
// resolving correctly for every function (not just the overridden ones) across the whole app —
// confirmed by reverting to the plain generated Database and seeing every one of those errors
// disappear. Keeping the same key set via a mapped type instead avoids that.
type MergedFunctions = {
  [FunctionName in keyof GeneratedFunctions]: FunctionName extends keyof RpcNullOverrides
    ? RpcNullOverrides[FunctionName]
    : GeneratedFunctions[FunctionName]
}

/**
 * The `Database` type actually used across the app: the generated schema from
 * `database.types.ts`, with the RPC argument/return nullability corrections from
 * `database.rpc-null-overrides.ts` layered on top. See that file for why the corrections live
 * separately instead of being hand-edited into the generated file.
 *
 * Every other part of the schema (Tables, Views, Enums, every RPC not listed in
 * RpcNullOverrides) passes through from the generated file unchanged.
 */
export type Database = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedDatabase["public"], "Functions"> & {
    Functions: MergedFunctions
  }
}
