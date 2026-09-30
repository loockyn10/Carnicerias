begin;

-- Persistent barcodes for the catalog (warehouse/"almacén" products such as "Coca Cola 2.25 L").
--
-- products.sku stays the INTERNAL code (unchanged: text, upper-cased, unique per organization).
-- A barcode is a different thing — it is what a scanner emits and it is printed on the physical
-- package — so it lives in its own table instead of a second column on products:
--   * a product can carry several barcodes (same item, different packagings/EAN re-issues);
--   * a barcode resolves to exactly ONE product inside an organization (unique index), which is
--     what makes "scan → resolve product → add to ticket" unambiguous;
--   * products.sku and product_barcodes.barcode are independent namespaces (a code may be both the
--     SKU of one product and, deliberately, nothing else — no cross-table uniqueness is imposed).
-- Nothing here touches WEIGHT products: they simply have zero barcode rows, exactly as before.

create table public.product_barcodes (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  barcode text not null check (barcode ~ '^[A-Z0-9][A-Z0-9._-]{2,63}$'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete cascade,
  unique (organization_id, barcode)
);

create index product_barcodes_product_idx on public.product_barcodes (product_id);

comment on table public.product_barcodes is
  'Scanner codes (EAN-8/13, UPC, ITF-14, internal) per product. Unique per organization: a barcode resolves to one product. Stored normalized (upper-case, trimmed, no spaces). Written only through set_product_barcodes / the import engine.';

alter table public.product_barcodes enable row level security;
create policy product_barcodes_select on public.product_barcodes
for select to authenticated
using (app_private.is_org_member(organization_id));

revoke all on table public.product_barcodes from public, anon, authenticated;
grant select on table public.product_barcodes to authenticated;

-- Single normalization point (scanner input and admin/imported values must compare equal).
create function app_private.normalize_barcode(p_barcode text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_barcode, '')), '\s+', '', 'g')), '');
$$;

-- Adds the missing barcodes of ONE product (never removes). Shared by set_product_barcodes and the
-- import engine. A barcode that already belongs to a DIFFERENT product raises with the owner's
-- name, so the caller (Admin, or the import preview) can tell the user exactly what collides.
create function app_private.add_product_barcodes(
  p_organization_id uuid,
  p_product_id uuid,
  p_barcodes text[]
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  raw_barcode text;
  normalized text;
  owner_product_id uuid;
  owner_name text;
  added integer := 0;
begin
  foreach raw_barcode in array coalesce(p_barcodes, array[]::text[])
  loop
    normalized := app_private.normalize_barcode(raw_barcode);
    if normalized is null or normalized !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$' then
      raise exception 'Código de barras inválido: %', raw_barcode using errcode = '22023';
    end if;
    select pb.product_id, p.name into owner_product_id, owner_name
    from public.product_barcodes pb
    join public.products p on p.id = pb.product_id and p.organization_id = pb.organization_id
    where pb.organization_id = p_organization_id and pb.barcode = normalized;
    if found then
      if owner_product_id <> p_product_id then
        raise exception 'El código de barras % ya pertenece al producto "%"', normalized, owner_name using errcode = '23505';
      end if;
      continue;
    end if;
    insert into public.product_barcodes (organization_id, product_id, barcode, created_by)
    values (p_organization_id, p_product_id, normalized, auth.uid());
    added := added + 1;
  end loop;
  return added;
end;
$$;

-- Replaces the full barcode set of a product (same reconcile semantics as set_product_categories:
-- idempotent, calling it twice with the same array changes nothing).
create function public.set_product_barcodes(p_product_id uuid, p_barcodes text[])
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  wanted text[];
  raw_barcode text;
  normalized text;
begin
  if not exists (
    select 1 from public.products p where p.id = p_product_id and p.organization_id = current_organization_id
  ) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  wanted := array[]::text[];
  foreach raw_barcode in array coalesce(p_barcodes, array[]::text[])
  loop
    normalized := app_private.normalize_barcode(raw_barcode);
    if normalized is null or normalized !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$' then
      raise exception 'Código de barras inválido: %', raw_barcode using errcode = '22023';
    end if;
    if not (normalized = any (wanted)) then
      wanted := wanted || normalized;
    end if;
  end loop;

  -- Serialize concurrent edits of the same product so delete+insert cannot interleave.
  perform 1 from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id for update;

  delete from public.product_barcodes pb
  where pb.organization_id = current_organization_id and pb.product_id = p_product_id
    and not (pb.barcode = any (wanted));
  perform app_private.add_product_barcodes(current_organization_id, p_product_id, wanted);

  return coalesce((
    select array_agg(pb.barcode order by pb.created_at, pb.barcode)
    from public.product_barcodes pb
    where pb.organization_id = current_organization_id and pb.product_id = p_product_id
  ), array[]::text[]);
end;
$$;

-- Scan → product resolution on the server (Admin tooling and an online fallback). The offline POS
-- will resolve the same way against its SQLite copy once barcodes are synced (see docs/IMPORTS.md);
-- this function defines the contract: exact match on the normalized code, active products only are
-- flagged (not hidden) so the caller decides what to do with a deactivated product.
create function public.resolve_product_barcode(p_barcode text)
returns table (product_id uuid, product_name text, sku text, unit_type public.unit_type, active boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
begin
  return query
  select p.id, p.name, p.sku, p.unit_type, p.active
  from public.product_barcodes pb
  join public.products p on p.id = pb.product_id and p.organization_id = pb.organization_id
  where pb.organization_id = current_organization_id
    and pb.barcode = app_private.normalize_barcode(p_barcode);
end;
$$;

-- Barcode changes must reach the POS through the existing incremental catalog cursor: a change to
-- a product's barcodes is a change to that PRODUCT (pull_pos_state re-sends changed products).
-- Dedicated small trigger function instead of extending app_private.log_pos_catalog_change, so
-- the hot shared trigger from 202609100005 is left untouched. pull_pos_state does not emit
-- barcodes yet (next sprint); until then these rows only cause a harmless identical re-send.
create function app_private.log_product_barcode_catalog_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_product_id uuid := case when tg_op = 'DELETE' then old.product_id else new.product_id end;
  changed_organization_id uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
begin
  -- A product being deleted cascades its barcodes; its own trigger already logged the change and
  -- the referenced row may be gone, so only log while the product still exists.
  if exists (select 1 from public.products p where p.id = changed_product_id) then
    insert into public.pos_catalog_changes (organization_id, branch_id, entity_type, entity_id)
    values (changed_organization_id, null, 'PRODUCT', changed_product_id);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger product_barcodes_log_pos_change
after insert or update or delete on public.product_barcodes
for each row execute function app_private.log_product_barcode_catalog_change();
create trigger product_barcodes_audit
after insert or update or delete on public.product_barcodes
for each row execute function app_private.audit_row_change();

revoke all on function
  app_private.normalize_barcode(text),
  app_private.add_product_barcodes(uuid, uuid, text[]),
  app_private.log_product_barcode_catalog_change()
from public, anon, authenticated;
revoke all on function
  public.set_product_barcodes(uuid, text[]),
  public.resolve_product_barcode(text)
from public, anon;
grant execute on function
  public.set_product_barcodes(uuid, text[]),
  public.resolve_product_barcode(text)
to authenticated;

commit;
