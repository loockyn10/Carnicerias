begin;

-- Fixes a real production regression found in the 2026-09-28 release smoke test:
-- clicking "Marcar entrada" failed with
--   function app_private.apply_employee_time_event(uuid, uuid, uuid, uuid, text,
--   public.time_event_action, unknown, timestamp with time zone, timestamp with time zone)
--   is not unique
--
-- Root cause: migration 202609280037_shift_heartbeat_lease.sql added a trailing
-- `p_inferred boolean default false` parameter to app_private.apply_employee_time_event via
-- `create or replace function`. CREATE OR REPLACE identifies the function to replace by its
-- exact declared parameter TYPE LIST — adding a parameter changes that list (9 types -> 10
-- types), so Postgres did NOT replace the original 9-parameter function from
-- 202609130018_pos_operator_timekeeping.sql; it created a SECOND, separate overload
-- alongside it (this is the same class of incompatibility already documented in
-- docs/ARCHITECTURE.md for create_production_batch/update_production_batch_header, which is
-- why those used DROP FUNCTION + recreate instead of a bare CREATE OR REPLACE).
--
-- Both record_employee_time_event and sync_offline_time_event call
-- apply_employee_time_event positionally with exactly the original 9 arguments (relying on
-- p_inferred's default for the common case). With two coexisting overloads whose first 9
-- declared types are identical, Postgres cannot pick one for a 9-argument call — every
-- CLOCK_IN/CLOCK_OUT, online or offline, was affected, not just the specific path the smoke
-- test happened to exercise first. The "unknown" argument in the error is the untyped
-- 'ONLINE'/'OFFLINE' literal for p_source: both candidates accept it identically, so it can't
-- be used to disambiguate either.
--
-- Fix: 202609280037 is already applied to the remote project and is not edited. The
-- 9-parameter overload is legacy — nothing should call it anymore, every current caller
-- already expects the p_inferred-aware behavior — so it is dropped outright by its exact
-- signature (not reconciled as a second legitimate overload). Once only the 10-parameter
-- version remains, existing 9-argument calls resolve unambiguously and keep working exactly
-- as before, using p_inferred's default (false).
drop function app_private.apply_employee_time_event(
  uuid, uuid, uuid, uuid, text, public.time_event_action, public.time_event_source, timestamptz, timestamptz
);

-- The dropped overload's own revoke (from 202609130018) is gone with it; re-assert the same
-- hardening on the sole remaining overload for parity (app_private internals are never meant
-- to be called directly by anon/authenticated, only by the public.* SECURITY DEFINER wrappers
-- that already exist).
revoke all on function app_private.apply_employee_time_event(
  uuid, uuid, uuid, uuid, text, public.time_event_action, public.time_event_source, timestamptz, timestamptz, boolean
) from public, anon, authenticated;

commit;
