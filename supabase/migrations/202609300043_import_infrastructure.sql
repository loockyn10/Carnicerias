begin;

-- Generic, source-agnostic import infrastructure (first consumer: SimplyGest → this platform).
-- Nothing here knows about SimplyGest: the source is just `source_system` text. Mapping a file's
-- columns to the canonical payloads defined in 202609300044 is the job of a parser/mapper OUTSIDE
-- the database; Postgres receives already-mapped rows, stages them, classifies them (preview) and
-- applies them atomically. See docs/IMPORTS.md for the full flow.
--
-- Tables:
--   import_batches         one uploaded file / one run (lifecycle STAGING → READY → APPLIED|CANCELLED)
--   import_rows            staging rows: original `raw`, canonical `payload`, and, after preview, the
--                          classification (CREATE / UPDATE / IGNORE / ERROR) with a reason code
--   external_entity_links  (source_system, entity_type, external_id) → internal UUID. THE dedupe
--                          mechanism: a second import of the same external id resolves to the same
--                          internal row instead of creating a new one.
-- All three are readable by `imports.read` and writable ONLY through the RPCs of migration 044
-- (no INSERT/UPDATE/DELETE grant, same pattern as product_costs/audit_logs).

insert into public.permissions (key, description) values
  ('imports.read', 'Read import batches, staged rows and external-id links'),
  ('imports.write', 'Stage, preview, apply and cancel data imports')
on conflict (key) do nothing;

-- Admin only (same scope as settlements.* / production.*). The apply step ALSO re-checks the
-- permission of the entity being written (products.write / stock.write), so granting imports.write
-- alone to a future role never widens what that role can change.
insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'imports.read'),
  ('10000000-0000-4000-8000-000000000001', 'imports.write')
on conflict (role_id, permission_key) do nothing;

create table public.import_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_system text not null check (source_system ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- New entity types (customer, supplier, price_list, …) are added here by a future migration
  -- together with their handler in the engine; the table layout itself does not change.
  entity_type text not null check (entity_type in ('category', 'product', 'stock_opening_balance')),
  -- Only stock imports are branch-scoped (opening balance of ONE branch per batch).
  branch_id uuid,
  file_name text check (file_name is null or char_length(file_name) <= 255),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  status text not null default 'STAGING' check (status in ('STAGING', 'READY', 'APPLIED', 'CANCELLED')),
  preview_summary jsonb,
  previewed_at timestamptz,
  applied_summary jsonb,
  applied_at timestamptz,
  applied_by uuid references public.profiles(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  unique (id, organization_id),
  check ((entity_type = 'stock_opening_balance') = (branch_id is not null)),
  check ((status = 'APPLIED') = (applied_at is not null))
);

create index import_batches_org_idx on public.import_batches (organization_id, created_at desc);
create index import_batches_file_idx on public.import_batches (organization_id, source_system, entity_type, file_sha256)
  where file_sha256 is not null;

create trigger import_batches_set_updated_at before update on public.import_batches
for each row execute function app_private.set_updated_at();

create table public.import_rows (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null,
  organization_id uuid not null,
  row_number integer not null check (row_number > 0),
  -- The source system's own identifier for the entity (SimplyGest "código"). Nullable on purpose:
  -- a row without one is staged anyway and reported as an ERROR at preview, never silently dropped.
  external_id text check (external_id is null or char_length(external_id) <= 200),
  raw jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  -- sha256 of the canonical payload: "did this row change since the last applied import?".
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  action text check (action is null or action in ('CREATE', 'UPDATE', 'IGNORE', 'ERROR')),
  reason_code text,
  message text,
  internal_id uuid,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (batch_id, organization_id)
    references public.import_batches(id, organization_id) on delete cascade,
  unique (batch_id, row_number)
);

create index import_rows_batch_action_idx on public.import_rows (batch_id, action);
create index import_rows_batch_external_idx on public.import_rows (batch_id, external_id);

create table public.external_entity_links (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_system text not null check (source_system ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Only entities that are first-class rows with their own UUID. Future: customer, supplier.
  entity_type text not null check (entity_type in ('category', 'product')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  -- Polymorphic by entity_type, so no FK can be declared; the engine validates existence on every
  -- use and re-creates/re-links when the internal row is gone (see apply_import_batch).
  internal_id uuid not null,
  -- Hash of the canonical payload at the last applied import (UNCHANGED detection).
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  first_batch_id uuid references public.import_batches(id) on delete set null,
  last_batch_id uuid references public.import_batches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, source_system, entity_type, external_id)
);

create index external_entity_links_internal_idx
  on public.external_entity_links (organization_id, entity_type, internal_id);

create trigger external_entity_links_set_updated_at before update on public.external_entity_links
for each row execute function app_private.set_updated_at();

alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.external_entity_links enable row level security;

create policy import_batches_select on public.import_batches
for select to authenticated using (app_private.has_permission(organization_id, 'imports.read'));
create policy import_rows_select on public.import_rows
for select to authenticated using (app_private.has_permission(organization_id, 'imports.read'));
create policy external_entity_links_select on public.external_entity_links
for select to authenticated using (app_private.has_permission(organization_id, 'imports.read'));

revoke all on table public.import_batches, public.import_rows, public.external_entity_links
from public, anon, authenticated;
grant select on table public.import_batches, public.import_rows, public.external_entity_links to authenticated;

comment on table public.import_batches is
  'One import run. Lifecycle: STAGING (rows being uploaded) → READY (previewed) → APPLIED | CANCELLED. Append-only history: batches are never deleted.';
comment on table public.import_rows is
  'Staged rows of a batch. payload is the canonical mapped row; action/reason_code are written by preview_import_batch; internal_id is set when the row is applied.';
comment on table public.external_entity_links is
  'Maps a source system''s identifier to our internal UUID. The primary key is what guarantees that importing the same external id twice never creates a second internal entity.';

-- ---------------------------------------------------------------------------------------------
-- Stock: opening balances enter the EXISTING ledger as OPENING_BALANCE movements.
-- ---------------------------------------------------------------------------------------------
alter table public.stock_movements add column import_batch_id uuid;

alter table public.stock_movements
  add constraint stock_movements_import_batch_fk
  foreign key (import_batch_id, organization_id)
  references public.import_batches(id, organization_id) on delete restrict;

create index stock_movements_import_batch_idx
  on public.stock_movements (import_batch_id) where import_batch_id is not null;

-- Only an opening balance may carry an import link (other movement types have their own links).
alter table public.stock_movements add constraint stock_movements_import_link_check
  check (import_batch_id is null or type = 'OPENING_BALANCE');

-- A (branch, product) pair can be opened at most once, from any source. A later re-import of a
-- stock file therefore cannot double the stock; real corrections go through the existing
-- physical-count adjustment (ADJUSTMENT_*), which is what they are.
create unique index stock_movements_opening_balance_uq
  on public.stock_movements (organization_id, branch_id, product_id)
  where type = 'OPENING_BALANCE';

-- Named explicitly by 202609220025; replaced (not edited in place) to add the new type.
alter table public.stock_movements drop constraint stock_movements_type_sign_check;
alter table public.stock_movements add constraint stock_movements_type_sign_check check (
  (type in ('PURCHASE', 'ADJUSTMENT_POSITIVE', 'TRANSFER_IN', 'RETURN', 'PRODUCTION_YIELD', 'OPENING_BALANCE') and quantity_grams > 0)
  or (type in ('SALE', 'WASTE', 'ADJUSTMENT_NEGATIVE', 'TRANSFER_OUT', 'PRODUCTION_CONSUME') and quantity_grams < 0)
);

comment on column public.stock_movements.import_batch_id is
  'Set only for OPENING_BALANCE rows written by apply_import_batch (stock_opening_balance). Traces migrated stock back to the import run.';

-- "Stock restocked" events drive the POS/Admin restock notices. An opening balance is carry-over
-- stock at cut-over, not a delivery: importing 800 products must not raise 800 restock events.
-- Same function as 202609100008 with one extra exclusion; everything else is unchanged.
create or replace function app_private.log_restock_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare previous_stock bigint;
begin
  if new.quantity_grams <= 0 or new.type = 'OPENING_BALANCE' then return new; end if;
  select coalesce(sum(quantity_grams), 0) - new.quantity_grams into previous_stock
  from public.stock_movements where organization_id = new.organization_id and branch_id = new.branch_id and product_id = new.product_id;
  if previous_stock <= 0 then
    insert into public.product_restock_events(organization_id, branch_id, product_id, stock_movement_id, occurred_at)
    values(new.organization_id, new.branch_id, new.product_id, new.id, new.occurred_at);
  end if;
  return new;
end; $$;

commit;
