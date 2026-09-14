pragma foreign_keys = off;

create table local_pos_operators (
  profile_id text primary key,
  display_name text not null,
  role_name text not null,
  has_pin integer not null default 0 check (has_pin in (0,1)),
  active integer not null default 1 check (active in (0,1)),
  has_shift_issue integer not null default 0 check (has_shift_issue in (0,1)),
  pin_salt text,
  pin_verifier text,
  operator_token text,
  grant_valid_until text,
  verified_at text,
  failed_attempts integer not null default 0 check(failed_attempts between 0 and 20),
  locked_until text,
  updated_at text not null
);

create table local_active_operator (
  singleton integer primary key check (singleton=1),
  profile_id text not null references local_pos_operators(profile_id),
  selected_at text not null
);

create table local_employee_shifts (
  id text primary key,
  employee_id text not null,
  branch_id text not null,
  device_id text not null,
  clock_in_at text not null,
  clock_out_at text,
  clock_in_source text not null check(clock_in_source in ('ONLINE','OFFLINE','ADMIN_CORRECTION')),
  clock_out_source text check(clock_out_source is null or clock_out_source in ('ONLINE','OFFLINE','ADMIN_CORRECTION')),
  status text not null check(status in ('OPEN','CLOSED','REQUIRES_REVIEW')),
  updated_at text not null
);

create unique index local_employee_one_open_uq on local_employee_shifts(employee_id) where clock_out_at is null;

alter table sync_outbox rename to sync_outbox_v5;
create table sync_outbox (
  id text primary key,
  aggregate_type text not null check (aggregate_type in ('SALE','SHIFT')),
  aggregate_id text not null,
  operation text not null check (operation in ('UPSERT','EVENT')),
  payload text not null,
  status text not null check (status in ('PENDING','SYNCING','SYNCED','FAILED')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at text not null,
  last_attempt_at text,
  next_attempt_at text not null,
  last_error text,
  synced_at text
);
insert into sync_outbox select * from sync_outbox_v5;
drop table sync_outbox_v5;
create index sync_outbox_due_idx on sync_outbox(status,next_attempt_at,created_at);

pragma foreign_keys = on;
