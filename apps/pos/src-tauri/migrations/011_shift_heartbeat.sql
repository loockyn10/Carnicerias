-- Presence lease for local_employee_shifts, mirrors employee_shifts.last_heartbeat_at
-- (Postgres migration 202609280037_shift_heartbeat_lease.sql). Updated in place every
-- ~30s while an operator's shift is OPEN, both online and offline; used to reconcile
-- a shift orphaned by a crash/forced kill/power loss at the next app startup instead
-- of leaving it open indefinitely.
alter table local_employee_shifts add column last_heartbeat_at text;
