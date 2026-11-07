begin;

-- Envasados al vacío vendidos desde el POS (D-091). Se apoya en 202611010093 (Envasados) y NO lo modifica:
--
--   1. Importe comercial único. Con el esquema PRICE_EMBEDDED, el importe del paquete (el que se imprime, se embebe en el EAN, muestra el POS y
--      se cobra) es el precio calculado redondeado half-up a un múltiplo del divisor del valor (divisor 100 = pesos enteros). El cálculo original
--      con centavos queda en `computed_total_cents` sólo para auditoría. Con otros esquemas no cambia nada.
--   2. Estado de cada paquete SIN tocar `vacuum_packages` (inmutable): `vacuum_package_state` (AVAILABLE / SOLD / VOIDED + sucursal donde
--      está), `vacuum_package_events` (historial append-only) y `vacuum_package_conflicts` (ventas offline que reclamaron el mismo paquete).
--   3. Línea de venta PACKAGE: `sale_items.vacuum_package_id` + `vacuum_ean13`. El importe es el del paquete (fijo), no precio/kg × peso;
--      el servidor lo valida contra el registro del paquete y descuenta del ledger EXISTENTE los gramos reales (un movimiento SALE por línea).
--      Envasar sigue sin mover stock: el descuento ocurre una sola vez, al vender.
--   4. Ventas offline concurrentes: el servidor NUNCA descarta una venta ya cobrada. Si el paquete ya estaba vendido / anulado / en otra
--      sucursal, la venta se registra igual y queda un conflicto ABIERTO para resolverlo en el Admin.
--   5. Anular una venta (cancel_sale, Mercado Pago sin acreditar) libera el paquete; reactivarla lo vuelve a reclamar. Todo por un trigger sobre
--      `sales.status`: no se reescribe ninguna de esas funciones.
--   6. `get_pos_vacuum_state` entrega a cada POS la configuración EAN, los PLU y los paquetes disponibles de SU sucursal (para escanear sin Internet).
--   7. Los códigos que cumplen el esquema de Envasados quedan RESERVADOS: no se pueden cargar como código de barras del catálogo.
--
-- La función `sync_offline_sale_core` se reemplaza por su cuerpo vigente (202610060065) más UNA rama al comienzo del bucle de líneas:
-- una línea con `vacuumPackageId` la resuelve `app_private.sync_vacuum_package_line` y las demás líneas siguen exactamente igual.

-- ---------------------------------------------------------------------------------------------
-- 1. Importe comercial único
-- ---------------------------------------------------------------------------------------------

-- Redondea half-up el importe en centavos a un múltiplo de `p_value_step` (PRICE_EMBEDDED). Cualquier otro esquema devuelve el importe tal cual.
create function app_private.vacuum_commercial_total(p_scheme text, p_value_step integer, p_raw_cents bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_scheme = 'PRICE_EMBEDDED' and coalesce(p_value_step, 1) > 1
      then ((p_raw_cents + coalesce(p_value_step, 1) / 2) / coalesce(p_value_step, 1)) * coalesce(p_value_step, 1)
    else p_raw_cents
  end;
$$;

alter table public.vacuum_packages add column computed_total_cents bigint check (computed_total_cents is null or computed_total_cents > 0);
comment on column public.vacuum_packages.computed_total_cents is
  'Importe calculado precio/kg × peso con centavos, sólo para auditoría. total_cents es el importe comercial único (impreso, en el EAN y cobrado). null = paquete anterior al redondeo comercial.';

-- Importe que cobra el POS por un paquete. Para un paquete nuevo es total_cents; para uno anterior al redondeo comercial (PRICE_EMBEDDED con
-- centavos) es el importe que realmente quedó embebido en su EAN (el esquema con que se armó vive en su snapshot).
create function app_private.vacuum_package_charge_cents(p public.vacuum_packages)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select app_private.vacuum_commercial_total(
    p.label_snapshot -> 'ean' ->> 'scheme',
    coalesce(nullif(p.label_snapshot -> 'ean' ->> 'valueStep', '')::integer, 1),
    p.total_cents
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Estado, historial y conflictos de paquetes
-- ---------------------------------------------------------------------------------------------

create table public.vacuum_package_state (
  package_id uuid primary key,
  organization_id uuid not null,
  -- Sucursal donde está el paquete (donde se elaboró hasta que se lo envíe a otra): el POS sólo ofrece los de SU sucursal.
  current_branch_id uuid not null,
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'SOLD', 'VOIDED')),
  sold_sale_id uuid,
  sold_sale_item_id uuid,
  sold_at timestamptz,
  void_reason text check (void_reason is null or char_length(btrim(void_reason)) between 3 and 300),
  updated_at timestamptz not null default now(),
  foreign key (package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete cascade,
  foreign key (current_branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  check ((status = 'SOLD') = (sold_sale_id is not null)),
  check ((status = 'VOIDED') = (void_reason is not null))
);
create index vacuum_package_state_branch_idx on public.vacuum_package_state (organization_id, current_branch_id, status);
create index vacuum_package_state_sale_idx on public.vacuum_package_state (sold_sale_id) where sold_sale_id is not null;

create table public.vacuum_package_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  package_id uuid not null,
  branch_id uuid,
  kind text not null check (kind in ('CREATED', 'MOVED', 'SOLD', 'RELEASED', 'VOIDED', 'CONFLICT', 'CONFLICT_RESOLVED')),
  sale_id uuid,
  sale_item_id uuid,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete cascade
);
create index vacuum_package_events_package_idx on public.vacuum_package_events (package_id, created_at);

-- Una venta (offline) que reclamó un paquete que el servidor ya tenía vendido / anulado / en otra sucursal. La venta SÍ queda registrada.
create table public.vacuum_package_conflicts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  package_id uuid not null,
  sale_id uuid not null,
  sale_item_id uuid not null unique,
  device_id uuid,
  reason text not null check (reason in ('ALREADY_SOLD', 'VOIDED', 'WRONG_BRANCH', 'RESTORE_UNAVAILABLE')),
  first_sale_id uuid,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  resolution_note text check (resolution_note is null or char_length(btrim(resolution_note)) between 3 and 500),
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete cascade,
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  check ((status = 'RESOLVED') = (resolved_at is not null))
);
create index vacuum_package_conflicts_open_idx on public.vacuum_package_conflicts (organization_id, status, created_at desc);

alter table public.vacuum_package_state enable row level security;
alter table public.vacuum_package_events enable row level security;
alter table public.vacuum_package_conflicts enable row level security;

create policy vacuum_package_state_select on public.vacuum_package_state for select to authenticated
using (
  app_private.has_permission(organization_id, 'vacuum.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(current_branch_id))
);
create policy vacuum_package_events_select on public.vacuum_package_events for select to authenticated
using (
  app_private.has_permission(organization_id, 'vacuum.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or (branch_id is not null and app_private.is_branch_member(branch_id)))
);
create policy vacuum_package_conflicts_select on public.vacuum_package_conflicts for select to authenticated
using (
  app_private.has_permission(organization_id, 'vacuum.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(branch_id))
);

revoke all on table public.vacuum_package_state, public.vacuum_package_events, public.vacuum_package_conflicts from public, anon, authenticated;
grant select on table public.vacuum_package_state, public.vacuum_package_events, public.vacuum_package_conflicts to authenticated;

-- Todo paquete nace AVAILABLE en la sucursal donde se elaboró.
create function app_private.vacuum_package_init_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.vacuum_package_state (package_id, organization_id, current_branch_id) values (new.id, new.organization_id, new.branch_id);
  insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, created_by) values (new.organization_id, new.id, new.branch_id, 'CREATED', new.created_by);
  return new;
end;
$$;
create trigger vacuum_packages_init_state after insert on public.vacuum_packages for each row execute function app_private.vacuum_package_init_state();

-- Paquetes que ya existieran (registrados con 202611010093): disponibles en su sucursal de origen.
insert into public.vacuum_package_state (package_id, organization_id, current_branch_id)
select p.id, p.organization_id, p.branch_id from public.vacuum_packages p;
insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, created_by)
select p.organization_id, p.id, p.branch_id, 'CREATED', p.created_by from public.vacuum_packages p;

-- ---------------------------------------------------------------------------------------------
-- 3. Línea de venta PACKAGE
-- ---------------------------------------------------------------------------------------------

alter table public.sale_items add column vacuum_package_id uuid, add column vacuum_ean13 text;
alter table public.sale_items
  add constraint sale_items_vacuum_package_fk foreign key (vacuum_package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete restrict,
  add constraint sale_items_vacuum_package_shape check (
    (vacuum_package_id is null and vacuum_ean13 is null)
    or (vacuum_package_id is not null and vacuum_ean13 ~ '^[0-9]{13}$' and weight_grams is not null and not manual_price_applied)
  );
create index sale_items_vacuum_package_idx on public.sale_items (vacuum_package_id) where vacuum_package_id is not null;

-- Valida y registra UNA línea de paquete de una venta offline (la llama sync_offline_sale_core). Devuelve el subtotal y los gramos de la línea.
-- Rechaza (la venta entera) todo lo que el POS nunca puede producir: línea alterada, paquete de otra organización o producto, importe distinto
-- del paquete, descuentos. NO rechaza un paquete ya vendido / anulado / de otra sucursal: ver el conflicto al final.
create function app_private.sync_vacuum_package_line(
  p_org_id uuid, p_branch_id uuid, p_sale_id uuid, p_device_id uuid, p_profile_id uuid,
  p_method public.payment_method, p_completed_at timestamptz, p_item jsonb, p_movement jsonb
)
returns table (o_subtotal bigint, o_grams integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item_id uuid; v_product_id uuid; v_package_id uuid; v_ean text; v_fixed bigint; v_bps integer;
  v_subtotal bigint; v_surcharge bigint; v_grams integer; v_list_price bigint; v_final_price bigint; v_name text;
  v_cash_discount bigint; v_discount bigint; v_promo_discount bigint;
  v_pkg public.vacuum_packages%rowtype; v_state public.vacuum_package_state%rowtype;
  v_cost bigint; v_profit integer; v_reason text; v_expected_subtotal bigint;
begin
  begin
    v_item_id := (p_item ->> 'id')::uuid; v_product_id := (p_item ->> 'productId')::uuid; v_package_id := (p_item ->> 'vacuumPackageId')::uuid;
    v_ean := p_item ->> 'vacuumEan13'; v_fixed := (p_item ->> 'vacuumPackageTotalCents')::bigint;
    v_bps := coalesce(nullif(p_item ->> 'cashDiscountBps', '')::integer, 0);
    v_subtotal := (p_item ->> 'subtotalCents')::bigint; v_surcharge := coalesce(nullif(p_item ->> 'cardSurchargeCents', '')::bigint, 0);
    v_grams := (p_item ->> 'weightGrams')::integer; v_final_price := (p_item ->> 'pricePerKgCents')::bigint;
    v_list_price := coalesce(nullif(p_item ->> 'originalPricePerKgCents', '')::bigint, v_final_price);
    v_name := p_item ->> 'productNameSnapshot';
    v_cash_discount := coalesce(nullif(p_item ->> 'cashDiscountCents', '')::bigint, 0);
    v_discount := coalesce(nullif(p_item ->> 'discountCents', '')::bigint, 0);
    v_promo_discount := coalesce(nullif(p_item ->> 'promotionDiscountCents', '')::bigint, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline vacuum package line is malformed' using errcode = '22023';
  end;
  if v_item_id is null or v_product_id is null or v_package_id is null or v_ean is null or v_fixed is null or v_subtotal is null
     or v_grams is null or v_grams <= 0 or v_final_price is null or v_final_price <= 0 or v_list_price <= 0 or v_name is null then
    raise exception 'Offline vacuum package line is incomplete' using errcode = '22023';
  end if;
  -- Un paquete tiene importe fijo: ni cantidad por unidades, ni precio manual, ni Pack, ni promociones ni descuentos de línea.
  if exists (
    select 1 from jsonb_each(p_item) e
    where e.key in ('quantityUnits', 'manualPriceApplied', 'manualUnitPriceCents', 'manualAdjustmentCents', 'soldAsPack', 'packCount',
        'packSizeUnitsSnapshot', 'packDiscountBps', 'packDiscountCents', 'packConfigId', 'branchPromotionId', 'branchPromotionEveryUnits',
        'branchPromotionMinimumUnits', 'branchPromotionDiscountBps', 'branchPromotionDiscountedUnits', 'branchPromotionDiscountCents',
        'discountRuleId', 'discountType', 'discountValue', 'promotionMode')
      and e.value <> 'null'::jsonb and e.value <> 'false'::jsonb
  ) or v_cash_discount <> 0 or v_discount <> 0 or v_promo_discount <> 0 then
    raise exception 'Offline vacuum package line cannot carry discounts, promotions or a manual price' using errcode = '22023';
  end if;
  -- El único ajuste posible es el recargo de tarjeta (D-044), con una configuración que la organización haya tenido al venderse.
  if v_bps not between 0 and 9999 or (app_private.payment_method_receives_discount(p_method) and v_bps <> 0) then
    raise exception 'Offline vacuum package line has an invalid surcharge' using errcode = '22023';
  end if;
  if not app_private.payment_method_receives_discount(p_method) and not app_private.card_surcharge_bps_was_valid(p_org_id, v_bps, p_completed_at) then
    raise exception 'Offline card surcharge does not match the commercial configuration of the sale' using errcode = '22023';
  end if;

  select * into v_pkg from public.vacuum_packages x where x.id = v_package_id and x.organization_id = p_org_id for update;
  if not found then raise exception 'Offline vacuum package does not belong to the device organization' using errcode = '42501'; end if;
  if v_pkg.product_id <> v_product_id or v_pkg.weight_grams <> v_grams or v_pkg.ean13 <> v_ean then
    raise exception 'Offline vacuum package line does not match the registered package' using errcode = '22023';
  end if;
  -- El importe de la línea ES el del paquete: nunca precio/kg × peso (el precio/kg pudo cambiar desde que se envasó).
  if v_fixed <> app_private.vacuum_package_charge_cents(v_pkg) then
    raise exception 'Offline vacuum package amount does not match the registered package' using errcode = '22023';
  end if;
  v_expected_subtotal := case when v_bps > 0 then app_private.round_ratio_half_up(v_fixed * (10000 + v_bps), 10000) else v_fixed end;
  if v_subtotal <> v_expected_subtotal or v_surcharge <> v_subtotal - v_fixed
     or v_list_price <> app_private.round_ratio_half_up(v_fixed * 1000, v_grams)
     or v_final_price <> app_private.round_ratio_half_up(v_subtotal * 1000, v_grams) then
    raise exception 'Offline vacuum package arithmetic is invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products p where p.id = v_product_id and p.organization_id = p_org_id and p.unit_type = 'WEIGHT') then
    raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
  end if;
  if (p_movement ->> 'productId')::uuid <> v_product_id or (p_movement ->> 'quantityGrams')::bigint <> -v_grams::bigint then
    raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
  end if;

  select c.cost_cents into v_cost from public.product_costs c
  where c.organization_id = p_org_id and c.product_id = v_product_id and c.valid_from <= p_completed_at and (c.valid_to is null or c.valid_to > p_completed_at)
  order by c.valid_from desc limit 1;
  select s.profit_markup_bps into v_profit from public.product_pricing_settings s
  where s.organization_id = p_org_id and s.product_id = v_product_id and s.valid_from <= p_completed_at and (s.valid_to is null or s.valid_to > p_completed_at)
  order by s.valid_from desc limit 1;

  insert into public.sale_items(
    id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
    original_price_per_kg_cents, final_price_per_kg_cents, discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents,
    promotion_discount_cents, cost_cents_snapshot, profit_markup_bps_snapshot, subtotal_cents, created_at, vacuum_package_id, vacuum_ean13
  ) values (
    v_item_id, p_sale_id, p_org_id, p_branch_id, v_product_id, v_name, v_grams, v_final_price,
    v_list_price, v_final_price, 0, v_bps, 0, v_surcharge,
    0, v_cost, v_profit, v_subtotal, p_completed_at, v_package_id, v_ean
  );
  -- Un único movimiento SALE por línea, con los gramos REALES del paquete (envasar nunca descontó).
  insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
  values ((p_movement ->> 'id')::uuid, p_org_id, p_branch_id, v_product_id, 'SALE', -v_grams::bigint, p_sale_id, p_profile_id, (p_movement ->> 'occurredAt')::timestamptz, p_completed_at);

  -- Reclamo del paquete. El paquete está bloqueado (for update): dos cajas que sincronizan a la vez se serializan acá.
  select * into v_state from public.vacuum_package_state s where s.package_id = v_package_id for update;
  v_reason := case
    when v_state.status = 'SOLD' then 'ALREADY_SOLD'
    when v_state.status = 'VOIDED' then 'VOIDED'
    when v_state.current_branch_id <> p_branch_id then 'WRONG_BRANCH'
  end;
  if v_state.status = 'AVAILABLE' then
    update public.vacuum_package_state set status = 'SOLD', sold_sale_id = p_sale_id, sold_sale_item_id = v_item_id, sold_at = p_completed_at, updated_at = now()
    where package_id = v_package_id;
    insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, created_by)
    values (p_org_id, v_package_id, p_branch_id, 'SOLD', p_sale_id, v_item_id, p_profile_id);
  end if;
  if v_reason is not null then
    insert into public.vacuum_package_conflicts (organization_id, branch_id, package_id, sale_id, sale_item_id, device_id, reason, first_sale_id)
    values (p_org_id, p_branch_id, v_package_id, p_sale_id, v_item_id, p_device_id, v_reason, case when v_state.status = 'SOLD' then v_state.sold_sale_id end);
    insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, note, created_by)
    values (p_org_id, v_package_id, p_branch_id, 'CONFLICT', p_sale_id, v_item_id, v_reason, p_profile_id);
  end if;

  o_subtotal := v_subtotal; o_grams := v_grams;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Anular / reactivar una venta libera / vuelve a reclamar sus paquetes
-- ---------------------------------------------------------------------------------------------
create function app_private.vacuum_sale_status_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_released boolean := new.status in ('CANCELLED', 'REFUNDED') and old.status in ('COMPLETED', 'PENDING_PAYMENT');
  v_restored boolean := new.status in ('COMPLETED', 'PENDING_PAYMENT') and old.status in ('CANCELLED', 'REFUNDED');
begin
  if not v_released and not v_restored then return new; end if;
  for r in
    select si.id as item_id, si.vacuum_package_id as package_id from public.sale_items si where si.sale_id = new.id and si.vacuum_package_id is not null
  loop
    if v_released then
      -- El paquete vuelve a estar disponible SÓLO si lo tenía esta venta. Si la línea era un conflicto, el conflicto se da por resuelto.
      update public.vacuum_package_state set status = 'AVAILABLE', sold_sale_id = null, sold_sale_item_id = null, sold_at = null, updated_at = now()
      where package_id = r.package_id and sold_sale_id = new.id and sold_sale_item_id = r.item_id;
      if found then
        insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, note)
        values (new.organization_id, r.package_id, new.branch_id, 'RELEASED', new.id, r.item_id, 'Venta anulada');
      end if;
      update public.vacuum_package_conflicts set status = 'RESOLVED', resolved_at = now(), resolution_note = 'La venta fue anulada'
      where sale_item_id = r.item_id and status = 'OPEN';
    else
      update public.vacuum_package_state set status = 'SOLD', sold_sale_id = new.id, sold_sale_item_id = r.item_id, sold_at = now(), updated_at = now()
      where package_id = r.package_id and status = 'AVAILABLE';
      if found then
        insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, note)
        values (new.organization_id, r.package_id, new.branch_id, 'SOLD', new.id, r.item_id, 'Venta restablecida');
      elsif not exists (select 1 from public.vacuum_package_state s where s.package_id = r.package_id and s.sold_sale_item_id = r.item_id) then
        insert into public.vacuum_package_conflicts (organization_id, branch_id, package_id, sale_id, sale_item_id, reason, first_sale_id)
        select new.organization_id, new.branch_id, r.package_id, new.id, r.item_id, 'RESTORE_UNAVAILABLE', s.sold_sale_id
        from public.vacuum_package_state s where s.package_id = r.package_id
        on conflict (sale_item_id) do update set status = 'OPEN', resolved_at = null, resolution_note = null, resolved_by = null, reason = 'RESTORE_UNAVAILABLE';
      end if;
    end if;
  end loop;
  return new;
end;
$$;
create trigger sales_vacuum_status_changed after update of status on public.sales
for each row when (old.status is distinct from new.status) execute function app_private.vacuum_sale_status_changed();

-- ---------------------------------------------------------------------------------------------
-- 7. Códigos reservados para Envasados
-- ---------------------------------------------------------------------------------------------
create function app_private.guard_vacuum_reserved_barcode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
begin
  select s.ean_prefix into v_prefix from public.organization_vacuum_settings s where s.organization_id = new.organization_id and s.ean_scheme is not null;
  if v_prefix is not null and new.barcode ~ '^[0-9]{13}$' and left(new.barcode, char_length(v_prefix)) = v_prefix and app_private.ean13_is_valid(new.barcode) then
    raise exception 'El código % empieza con el prefijo % reservado para paquetes envasados', new.barcode, v_prefix using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger product_barcodes_guard_vacuum_reserved before insert on public.product_barcodes for each row execute function app_private.guard_vacuum_reserved_barcode();


-- ---------------------------------------------------------------------------------------------
-- Funciones de 202611010093 / 202610060065 reemplazadas con cambios mínimos (el resto de su cuerpo no cambia)
-- ---------------------------------------------------------------------------------------------
-- create_vacuum_package: el importe del paquete es el importe comercial único (computed_total_cents guarda el cálculo con centavos).
create or replace function public.create_vacuum_package(
  p_branch_id uuid,
  p_product_id uuid,
  p_weight_grams integer,
  p_packed_on date,
  p_expires_on date default null,
  p_lot text default null,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_at timestamptz := clock_timestamp();
  v_tz text;
  v_today date;
  v_existing public.vacuum_packages%rowtype;
  v_branch public.branches%rowtype;
  v_product public.products%rowtype;
  v_pset public.product_vacuum_settings%rowtype;
  v_org_set public.organization_vacuum_settings%rowtype;
  v_price bigint;
  v_total bigint;
  v_raw_total bigint;
  v_expires date;
  v_ean text;
  v_lot text := nullif(upper(regexp_replace(btrim(coalesce(p_lot, '')), '\s+', '', 'g')), '');
  v_seq integer;
  v_conservation text;
  v_row public.vacuum_packages%rowtype;
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  select * into v_branch from public.branches b where b.id = p_branch_id and b.organization_id = v_org;
  if not v_branch.active then raise exception 'La sucursal está inactiva' using errcode = '22023'; end if;

  if p_request_key is not null then
    select * into v_existing from public.vacuum_packages x where x.organization_id = v_org and x.request_key = p_request_key;
    if found then return app_private.vacuum_package_json(v_existing); end if;
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_today := (v_at at time zone coalesce(v_tz, 'UTC'))::date;
  if p_packed_on is null or p_packed_on < v_today - 366 or p_packed_on > v_today + 366 then
    raise exception 'La fecha de elaboración es inválida' using errcode = '22023';
  end if;
  if p_weight_grams is null or p_weight_grams not between 1 and 99999 then raise exception 'El peso tiene que estar entre 1 g y 99,999 kg' using errcode = '22023'; end if;

  select * into v_product from public.products p where p.id = p_product_id and p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT';
  if not found then raise exception 'Corte no encontrado' using errcode = '42501'; end if;
  select * into v_pset from public.product_vacuum_settings s where s.product_id = p_product_id and s.organization_id = v_org and s.enabled;
  if not found then raise exception 'El corte % no está habilitado para envasar', v_product.name using errcode = '22023'; end if;

  v_price := app_private.vacuum_price_per_kg(v_org, p_product_id, p_branch_id, v_at);
  if v_price is null or v_price <= 0 then raise exception 'El corte % no tiene un precio vigente', v_product.name using errcode = '22023'; end if;
  -- Mismo redondeo que el POS (priceForWeight): precio por kg × gramos / 1000, half-up en centavos.
  v_raw_total := (v_price * p_weight_grams::bigint + 500) / 1000;
  if v_raw_total <= 0 then raise exception 'El importe del paquete es cero' using errcode = '22023'; end if;

  -- Vencimiento: por defecto elaboración + vida útil configurada. Cambiarlo requiere permiso; sin vida útil configurada se carga a mano.
  if p_expires_on is null then
    if v_pset.shelf_life_days is null then raise exception 'El corte no tiene vida útil configurada: ingresá el vencimiento' using errcode = '22023'; end if;
    v_expires := p_packed_on + v_pset.shelf_life_days;
  else
    v_expires := p_expires_on;
    if v_pset.shelf_life_days is not null and v_expires <> p_packed_on + v_pset.shelf_life_days
       and not app_private.has_permission(v_org, 'vacuum.override_expiry') then
      raise exception 'No tenés permiso para cambiar el vencimiento configurado' using errcode = '42501';
    end if;
  end if;
  if v_expires < p_packed_on then raise exception 'El vencimiento no puede ser anterior a la elaboración' using errcode = '22023'; end if;

  select * into v_org_set from public.organization_vacuum_settings s where s.organization_id = v_org;
  if not found or v_org_set.ean_scheme is null then
    raise exception 'Falta configurar el esquema EAN-13 de envasados (Envasados → Configuración)' using errcode = '22023';
  end if;
  -- Importe comercial ÚNICO: el que se imprime, se embebe en el EAN, muestra el POS y se cobra (con divisor 100, pesos enteros half-up).
  -- El cálculo original con centavos queda en computed_total_cents sólo para auditoría.
  v_total := app_private.vacuum_commercial_total(v_org_set.ean_scheme, v_org_set.ean_value_step, v_raw_total);
  if v_total <= 0 then raise exception 'El importe comercial del paquete es cero' using errcode = '22023'; end if;
  v_ean := app_private.vacuum_build_ean(v_org_set.ean_scheme, v_org_set.ean_prefix, v_org_set.ean_plu_digits, v_org_set.ean_value_digits,
    v_org_set.ean_value_step, v_pset.plu, v_total, p_weight_grams);

  -- Lote: único por organización y legible (SUCURSAL-AAMMDD-0001). Automático con contador por sucursal y día; editable.
  if v_lot is null then
    loop
      insert into public.vacuum_lot_counters (organization_id, branch_id, packed_on, last_seq) values (v_org, p_branch_id, p_packed_on, 1)
      on conflict (organization_id, branch_id, packed_on) do update set last_seq = public.vacuum_lot_counters.last_seq + 1
      returning last_seq into v_seq;
      v_lot := upper(v_branch.code) || '-' || to_char(p_packed_on, 'YYMMDD') || '-' || lpad(v_seq::text, 4, '0');
      exit when not exists (select 1 from public.vacuum_packages x where x.organization_id = v_org and x.lot = v_lot);
      v_lot := null;
    end loop;
  elsif v_lot !~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$' then
    raise exception 'El lote tiene que tener entre 3 y 40 caracteres (letras, números, . _ / -)' using errcode = '22023';
  elsif exists (select 1 from public.vacuum_packages x where x.organization_id = v_org and x.lot = v_lot) then
    raise exception 'El lote % ya existe', v_lot using errcode = '23505';
  end if;

  v_conservation := coalesce(v_pset.conservation_text, v_org_set.default_conservation_text);
  insert into public.vacuum_packages (
    organization_id, branch_id, product_id, request_key, product_name_snapshot, product_sku_snapshot, weight_grams, price_per_kg_cents, total_cents, computed_total_cents,
    packed_on, expires_on, lot, ean13, shelf_life_days_snapshot, conservation_text_snapshot, label_snapshot, created_by
  ) values (
    v_org, p_branch_id, p_product_id, p_request_key, v_product.name, v_product.sku, p_weight_grams, v_price, v_total, v_raw_total,
    p_packed_on, v_expires, v_lot, v_ean, v_pset.shelf_life_days, v_conservation,
    jsonb_build_object(
      'businessName', v_org_set.business_name, 'address', v_org_set.address, 'establishmentInfo', v_org_set.establishment_info,
      'extraText', v_org_set.extra_text, 'branchName', v_branch.name,
      'labelWidthMm', v_org_set.label_width_mm, 'infoHeightMm', v_org_set.info_height_mm, 'priceHeightMm', v_org_set.price_height_mm,
      'ean', jsonb_build_object('scheme', v_org_set.ean_scheme, 'prefix', v_org_set.ean_prefix, 'pluDigits', v_org_set.ean_plu_digits,
        'valueDigits', v_org_set.ean_value_digits, 'valueStep', v_org_set.ean_value_step, 'plu', v_pset.plu)
    ),
    auth.uid()
  ) returning * into v_row;
  return app_private.vacuum_package_json(v_row);
end;
$$;

-- vacuum_package_json: agrega el importe a cobrar, el original con centavos, el estado y la sucursal donde está el paquete.
create or replace function app_private.vacuum_package_json(p public.vacuum_packages)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'organizationId', p.organization_id, 'branchId', p.branch_id,
    'branchName', (select b.name from public.branches b where b.id = p.branch_id and b.organization_id = p.organization_id),
    'productId', p.product_id, 'productName', p.product_name_snapshot, 'productSku', p.product_sku_snapshot,
    'weightGrams', p.weight_grams, 'pricePerKgCents', p.price_per_kg_cents::text, 'totalCents', p.total_cents::text,
    'packedOn', p.packed_on, 'expiresOn', p.expires_on, 'lot', p.lot, 'ean13', p.ean13,
    'shelfLifeDays', p.shelf_life_days_snapshot, 'conservationText', p.conservation_text_snapshot,
    'label', p.label_snapshot, 'createdAt', p.created_at,
    'createdBy', (select pr.display_name from public.profiles pr where pr.id = p.created_by),
    'printCount', (select count(*) from public.vacuum_package_prints x where x.package_id = p.id),
    'computedTotalCents', p.computed_total_cents::text, 'chargeCents', app_private.vacuum_package_charge_cents(p)::text,
    'status', (select s.status from public.vacuum_package_state s where s.package_id = p.id),
    'currentBranchId', (select s.current_branch_id from public.vacuum_package_state s where s.package_id = p.id)
  );
$$;

-- save_vacuum_ean_scheme: no se puede elegir un prefijo que ya usan códigos de barras del catálogo.
create or replace function public.save_vacuum_ean_scheme(
  p_scheme text default null,
  p_prefix text default null,
  p_plu_digits integer default null,
  p_value_digits integer default null,
  p_value_step integer default 1
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
begin
  if p_scheme is not null then
    if p_scheme not in ('PRICE_EMBEDDED', 'WEIGHT_EMBEDDED') then raise exception 'Esquema EAN-13 no soportado' using errcode = '22023'; end if;
    if p_prefix is null or p_prefix !~ '^[0-9]{1,6}$' then raise exception 'El prefijo tiene que tener entre 1 y 6 dígitos' using errcode = '22023'; end if;
    if p_plu_digits is null or p_plu_digits not between 1 and 8 or p_value_digits is null or p_value_digits not between 1 and 8 then
      raise exception 'Indicá cuántos dígitos usan el PLU y el valor (1 a 8)' using errcode = '22023';
    end if;
    if char_length(p_prefix) + p_plu_digits + p_value_digits <> 12 then
      raise exception 'Prefijo + PLU + valor tienen que sumar 12 dígitos (el 13.º es el verificador); hoy suman %', char_length(p_prefix) + p_plu_digits + p_value_digits using errcode = '22023';
    end if;
    if coalesce(p_value_step, 1) not between 1 and 100000 then raise exception 'El divisor del valor es inválido' using errcode = '22023'; end if;
    -- Los códigos con este prefijo quedan reservados para paquetes: no puede haber ya uno del catálogo (el POS lo confundiría).
    if exists (
      select 1 from public.product_barcodes pb
      where pb.organization_id = v_org and pb.barcode ~ '^[0-9]{13}$' and left(pb.barcode, char_length(p_prefix)) = p_prefix and app_private.ean13_is_valid(pb.barcode)
    ) then
      raise exception 'Hay códigos de barras del catálogo que empiezan con el prefijo %: elegí otro prefijo para Envasados', p_prefix using errcode = '22023';
    end if;
  end if;
  insert into public.organization_vacuum_settings (organization_id, ean_scheme, ean_prefix, ean_plu_digits, ean_value_digits, ean_value_step)
  values (v_org, p_scheme, p_prefix, p_plu_digits, p_value_digits, coalesce(p_value_step, 1))
  on conflict (organization_id) do update set
    ean_scheme = excluded.ean_scheme, ean_prefix = excluded.ean_prefix, ean_plu_digits = excluded.ean_plu_digits,
    ean_value_digits = excluded.ean_value_digits, ean_value_step = excluded.ean_value_step;
end;
$$;

-- list_vacuum_packages_page: cada fila trae su estado y la sucursal donde está.
create or replace function public.list_vacuum_packages_page(
  p_branch_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_product_id uuid default null,
  p_search text default null,
  p_limit integer default 30,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_text text := app_private.import_normalize_text(p_search);
  v_pattern text := case when v_text is null then null else '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_digits text := case when btrim(coalesce(p_search, '')) ~ '^[0-9]{13}$' then btrim(p_search) end;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if p_branch_id is not null then perform app_private.require_visible_branch(v_org, p_branch_id); end if;
  select count(*) into v_total
  from public.vacuum_packages x
  where x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis))
    and (p_branch_id is null or x.branch_id = p_branch_id)
    and (p_from is null or x.packed_on >= p_from) and (p_to is null or x.packed_on <= p_to)
    and (p_product_id is null or x.product_id = p_product_id)
    and (v_pattern is null or lower(x.lot) like v_pattern escape '\' or app_private.import_normalize_text(x.product_name_snapshot) like v_pattern escape '\' or x.ean13 = v_digits);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'lot', r.lot, 'branchId', r.branch_id, 'branchName', r.branch_name, 'productId', r.product_id, 'productName', r.product_name_snapshot,
    'weightGrams', r.weight_grams, 'pricePerKgCents', r.price_per_kg_cents::text, 'totalCents', r.total_cents::text,
    'packedOn', r.packed_on, 'expiresOn', r.expires_on, 'ean13', r.ean13, 'createdAt', r.created_at,
    'printCount', coalesce(pr.prints, 0), 'lastPrintedAt', pr.last_printed_at,
    'status', r.package_status, 'currentBranchId', r.current_branch_id, 'currentBranchName', r.current_branch_name
  ) order by r.created_at desc, r.id), '[]'::jsonb) into v_rows
  from (
    select x.*, b.name as branch_name, st.status as package_status, st.current_branch_id, cb.name as current_branch_name
    from public.vacuum_packages x
    join public.branches b on b.id = x.branch_id and b.organization_id = x.organization_id
    left join public.vacuum_package_state st on st.package_id = x.id
    left join public.branches cb on cb.id = st.current_branch_id and cb.organization_id = x.organization_id
    where x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis))
      and (p_branch_id is null or x.branch_id = p_branch_id)
      and (p_from is null or x.packed_on >= p_from) and (p_to is null or x.packed_on <= p_to)
      and (p_product_id is null or x.product_id = p_product_id)
      and (v_pattern is null or lower(x.lot) like v_pattern escape '\' or app_private.import_normalize_text(x.product_name_snapshot) like v_pattern escape '\' or x.ean13 = v_digits)
    order by x.created_at desc, x.id
    limit v_limit offset v_offset
  ) r
  left join lateral (
    select count(*) as prints, max(p.printed_at) as last_printed_at from public.vacuum_package_prints p where p.package_id = r.id
  ) pr on true;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- sync_offline_sale_core: cuerpo vigente (202610060065) + una rama al comienzo del bucle para las líneas de paquete envasado (vacuumPackageId).
create or replace function app_private.sync_offline_sale_core(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile_id uuid := auth.uid();
  org_id uuid;
  branch_uuid uuid;
  device_status public.pos_device_status;
  payload_hash text := encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  receipt public.pos_sync_receipts%rowtype;
  inserted boolean;
  sale_id uuid; created_at timestamptz; completed_at timestamptz; declared_total bigint; declared_weight bigint;
  computed_total bigint := 0; computed_weight bigint := 0; method public.payment_method;
  item_index integer; item jsonb; movement jsonb; current_product_id uuid; grams integer; quantity integer;
  list_price bigint; promo_price bigint; final_price bigint; subtotal bigint;
  discount_total bigint; cash_bps integer; cash_discount bigint; card_surcharge bigint; promo_discount bigint;
  discount_type public.weight_discount_type; discount_value bigint; discount_rule uuid;
  line_promotion_mode public.promotion_mode; pack_promo public.product_weight_discounts%rowtype;
  whole_packs bigint; remainder bigint;
  list_subtotal bigint; cash_subtotal bigint; cost_snapshot bigint; profit_snapshot integer;
  -- D-061: precio manual por línea y descuento general del ticket (sólo POS de Central).
  manual_applied boolean; manual_price bigint; manual_adjustment bigint;
  discount_bps integer := 0; declared_discount bigint := 0; expected_discount bigint; net_total bigint;
  ordered_item_ids uuid[];
  -- Pack y promoción de sucursal de una línea UNIT (snapshot que manda el POS; el servidor lo revalida).
  sold_pack boolean; pack_count integer; pack_size integer; pack_bps integer; pack_discount bigint;
  pack_config uuid; pack_version public.product_pack_versions%rowtype;
  bp_id uuid; bp_every integer; bp_min integer; bp_bps integer; bp_units integer; bp_discount bigint;
  unit_discount bigint; has_unit_discount boolean;
begin
  if profile_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_payload is null or p_payload->>'schemaVersion' <> '1' then raise exception 'Unsupported offline sale payload' using errcode = '22023'; end if;
  if jsonb_typeof(p_payload->'items') <> 'array' or jsonb_array_length(p_payload->'items') not between 1 and 100
     or jsonb_typeof(p_payload->'stockMovements') <> 'array' or jsonb_array_length(p_payload->'stockMovements') <> jsonb_array_length(p_payload->'items') then
    raise exception 'Offline sale items are invalid' using errcode = '22023';
  end if;
  select d.organization_id, d.branch_id, d.status into org_id, branch_uuid, device_status from public.pos_devices d where d.id = p_device_id;
  if not found or device_status <> 'ACTIVE' or not app_private.can_access_branch(org_id, branch_uuid, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  begin
    sale_id := (p_payload->>'saleId')::uuid; created_at := (p_payload->>'createdAt')::timestamptz; completed_at := (p_payload->>'completedAt')::timestamptz;
    declared_total := (p_payload->>'totalCents')::bigint; declared_weight := (p_payload->>'totalWeightGrams')::bigint;
    method := upper(p_payload->'payment'->>'method')::public.payment_method;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale header is invalid' using errcode = '22023'; end;
  if (p_payload->>'eventId')::uuid <> p_event_id or (p_payload->>'deviceId')::uuid <> p_device_id or (p_payload->>'organizationId')::uuid <> org_id
     or (p_payload->>'branchId')::uuid <> branch_uuid or (p_payload->>'profileId')::uuid <> profile_id or p_payload->>'status' <> 'COMPLETED'
     or created_at > completed_at or completed_at > now() + interval '5 minutes' then
    raise exception 'Offline sale identity or timestamps are invalid' using errcode = '42501';
  end if;
  -- D-061: el precio manual y el descuento general sólo existen en la sucursal productiva de la organización
  -- (organizations.production_branch_id, la misma que decide `get_pos_device_capabilities`: nunca el nombre).
  -- El POS ya lo bloquea, pero el servidor no confía en el POS: una venta de cualquier otra sucursal que traiga
  -- cualquiera de estas claves se rechaza entera (sin recibo, sin venta, sin movimientos).
  if p_payload ? 'ticketDiscountBps' or p_payload ? 'ticketDiscountCents' or p_payload ? 'subtotalCents'
     or exists (
       select 1 from jsonb_array_elements(p_payload->'items') as candidate(value)
       where candidate.value ? 'manualPriceApplied' or candidate.value ? 'manualUnitPriceCents' or candidate.value ? 'manualAdjustmentCents'
     ) then
    if not exists (select 1 from public.organizations o where o.id = org_id and o.production_branch_id = branch_uuid) then
      raise exception 'FLEXIBLE_PRICING_NOT_ALLOWED' using errcode = '42501',
        hint = 'El precio manual y el descuento general sólo están habilitados en el POS de Central.';
    end if;
  end if;
  insert into public.pos_sync_receipts(event_id, sale_id, device_id, payload_hash) values(p_event_id, sale_id, p_device_id, payload_hash)
  on conflict(event_id) do nothing returning true into inserted;
  if not coalesce(inserted, false) then
    select * into receipt from public.pos_sync_receipts where event_id = p_event_id;
    if receipt.sale_id <> sale_id or receipt.device_id <> p_device_id or receipt.payload_hash <> payload_hash then
      raise exception 'Idempotency key was reused with a different payload' using errcode = '23505';
    end if;
    return jsonb_build_object('saleId', sale_id, 'duplicate', true, 'syncedAt', receipt.received_at);
  end if;
  if exists(select 1 from public.sales where id = sale_id) then raise exception 'Sale id already exists with another sync event' using errcode = '23505'; end if;
  insert into public.sales(id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, created_at, completed_at, device_id, sync_event_id)
  values(sale_id, org_id, branch_uuid, profile_id, 'COMPLETED', 0, 0, created_at, completed_at, p_device_id, p_event_id);

  for item_index in 0..jsonb_array_length(p_payload->'items') - 1 loop
    item := p_payload->'items'->item_index; movement := p_payload->'stockMovements'->item_index;
    begin
      current_product_id := (item->>'productId')::uuid; final_price := (item->>'pricePerKgCents')::bigint;
      list_price := coalesce(nullif(item->>'originalPricePerKgCents', '')::bigint, final_price);
      discount_total := coalesce(nullif(item->>'discountCents', '')::bigint, 0);
      cash_bps := coalesce(nullif(item->>'cashDiscountBps', '')::integer, 0);
      cash_discount := coalesce(nullif(item->>'cashDiscountCents', '')::bigint, 0);
      card_surcharge := coalesce(nullif(item->>'cardSurchargeCents', '')::bigint, 0);
      promo_discount := coalesce(nullif(item->>'promotionDiscountCents', '')::bigint, discount_total - cash_discount);
      discount_type := nullif(item->>'discountType', '')::public.weight_discount_type; discount_value := nullif(item->>'discountValue', '')::bigint; discount_rule := nullif(item->>'discountRuleId', '')::uuid;
      line_promotion_mode := nullif(item->>'promotionMode', '')::public.promotion_mode;
      subtotal := (item->>'subtotalCents')::bigint;
      grams := nullif(item->>'weightGrams', '')::integer;
      quantity := nullif(item->>'quantityUnits', '')::integer;
      manual_applied := coalesce((item->>'manualPriceApplied')::boolean, false);
      manual_price := nullif(item->>'manualUnitPriceCents', '')::bigint;
      manual_adjustment := nullif(item->>'manualAdjustmentCents', '')::bigint;
      sold_pack := coalesce((item->>'soldAsPack')::boolean, false);
      pack_count := nullif(item->>'packCount', '')::integer;
      pack_size := nullif(item->>'packSizeUnitsSnapshot', '')::integer;
      pack_bps := nullif(item->>'packDiscountBps', '')::integer;
      pack_discount := nullif(item->>'packDiscountCents', '')::bigint;
      pack_config := nullif(item->>'packConfigId', '')::uuid;
      bp_id := nullif(item->>'branchPromotionId', '')::uuid;
      -- Promoción de sucursal "DESDE N" (cantidad mínima): branchPromotionMinimumUnits. La clave branchPromotionEveryUnits es el
      -- formato anterior ("cada N", sólo grupos completos) de un POS que todavía no se actualizó: se sigue validando con su regla.
      bp_every := nullif(item->>'branchPromotionEveryUnits', '')::integer;
      bp_min := nullif(item->>'branchPromotionMinimumUnits', '')::integer;
      bp_bps := nullif(item->>'branchPromotionDiscountBps', '')::integer;
      bp_units := nullif(item->>'branchPromotionDiscountedUnits', '')::integer;
      bp_discount := nullif(item->>'branchPromotionDiscountCents', '')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode = '22023'; end;
    -- Línea de PAQUETE ENVASADO (D-091): importe fijo del paquete, gramos reales, reclamo del paquete. Todo lo demás sigue igual.
    if item ? 'vacuumPackageId' then
      select r.o_subtotal, r.o_grams into subtotal, grams
      from app_private.sync_vacuum_package_line(org_id, branch_uuid, sale_id, p_device_id, profile_id, method, completed_at, item, movement) r;
      computed_total := computed_total + subtotal; computed_weight := computed_weight + grams;
      continue;
    end if;
    -- D-044: only DEBIT/CREDIT may carry a nonzero bps now (the surcharge); CASH/TRANSFER/OTHER
    -- must not (they get no adjustment at all).
    if list_price <= 0 or final_price <= 0 or cash_bps not between 0 and 9999
       or (app_private.payment_method_receives_discount(method) and cash_bps <> 0)
       or cash_discount <> 0 then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;
    -- D-068: el recargo de tarjeta tiene que ser uno que la configuración comercial haya tenido al hacerse la venta (no el de HOY).
    if not manual_applied and not app_private.payment_method_receives_discount(method)
       and not app_private.card_surcharge_bps_was_valid(org_id, cash_bps, completed_at) then
      raise exception 'Offline card surcharge does not match the commercial configuration of the sale' using errcode = '22023';
    end if;
    -- Línea con precio manual: el precio fijado ES el precio final (pricePerKgCents). No lleva promoción, pack,
    -- recargo por tarjeta ni ningún ajuste por medio de pago, y su aritmética se valida más abajo contra
    -- precio * cantidad y contra el precio original (lista) que quedó como snapshot.
    if manual_applied then
      if manual_price is null or manual_adjustment is null or manual_price <= 0 or manual_price <> final_price
         or discount_rule is not null or discount_type is not null or discount_value is not null or line_promotion_mode is not null
         or discount_total <> 0 or promo_discount <> 0 or card_surcharge <> 0 or cash_bps <> 0 then
        raise exception 'Offline manual price line is inconsistent' using errcode = '22023';
      end if;
    elsif manual_price is not null or manual_adjustment is not null then
      raise exception 'Offline manual price metadata without a manual price' using errcode = '22023';
    end if;

    -- Pack / promoción de sucursal: sólo en líneas UNIT normales, nunca juntos, nunca con precio manual ni con una
    -- promoción específica del producto (un solo descuento por línea). El detalle se revalida en la rama UNIT.
    has_unit_discount := sold_pack or pack_count is not null or pack_size is not null or pack_bps is not null or pack_discount is not null
      or pack_config is not null
      or bp_id is not null or bp_every is not null or bp_min is not null or bp_bps is not null or bp_units is not null or bp_discount is not null;
    if has_unit_discount then
      if manual_applied or quantity is null or grams is not null
         or (sold_pack and (bp_id is not null or bp_every is not null or bp_min is not null or bp_bps is not null or bp_units is not null or bp_discount is not null))
         or (not sold_pack and (pack_count is not null or pack_size is not null or pack_bps is not null or pack_discount is not null or pack_config is not null))
         or (bp_every is not null and bp_min is not null)
         or (bp_id is null and (bp_every is not null or bp_min is not null or bp_bps is not null or bp_units is not null or bp_discount is not null))
         or line_promotion_mode is not null or discount_rule is not null or discount_type is not null or discount_value is not null then
        raise exception 'Offline unit discount metadata is inconsistent' using errcode = '22023';
      end if;
    end if;

    if quantity is not null and grams is null then
      -- UNIT line.
      if quantity <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := list_price * quantity;
      if discount_type is not null or discount_value is not null then
        raise exception 'Offline unit sale discount metadata is inconsistent' using errcode = '22023';
      end if;
      if manual_applied then
        cash_subtotal := subtotal;
        if subtotal <> manual_price * quantity or subtotal <= 0 or manual_adjustment <> subtotal - list_subtotal then
          raise exception 'Offline manual price arithmetic is invalid' using errcode = '22023';
        end if;
      elsif sold_pack or bp_id is not null then
        -- Un solo descuento sobre las unidades REALES de la línea, calculado una vez sobre el total de lista y
        -- redondeado half-up (espeja calculateUnitPackLinePricing / calculateBranchPromotionLinePricing y el
        -- insert_sale de Rust). Después, el recargo de tarjeta una sola vez sobre el total comercial de la línea.
        if sold_pack then
          if pack_count is null or pack_count < 1 or pack_size is null or pack_size not between 2 and 10000
             or quantity <> pack_count * pack_size or pack_bps is null or pack_bps not between 0 and 9999 or pack_discount is null
             or pack_config is null then
            raise exception 'Offline pack line is inconsistent' using errcode = '22023';
          end if;
          -- La versión del pack con la que el POS dice haber vendido: tiene que existir, ser de ESTE producto y coincidir con
          -- el snapshot (tamaño y porcentaje: cada producto tiene el suyo y cambia con el tiempo; la venta se valida contra
          -- el de SU versión). NUNCA se compara contra products.pack_size_units actual: el Admin pudo cambiarlo
          -- mientras el dispositivo estaba sin conexión (una venta hecha con un pack de 8 sigue siendo válida).
          select * into pack_version from public.product_pack_versions v
          where v.id = pack_config and v.organization_id = org_id and v.product_id = current_product_id;
          if not found then
            raise exception 'Offline pack configuration does not belong to the sale product' using errcode = '42501';
          end if;
          if pack_version.pack_size_units <> pack_size or pack_version.discount_bps <> pack_bps then
            raise exception 'Offline pack snapshot does not match its configuration' using errcode = '22023';
          end if;
          -- Vigencia para el dispositivo que la recibió: la versión ya existía cuando se hizo la venta (tolerancia de reloj de
          -- 10 min) y, si el Admin la cerró después, el dispositivo todavía podía tenerla: un POS sólo vende con una
          -- autorización de hasta 24 h desde su último sync (pull_pos_state.authorizationExpiresAt), así que una venta posterior
          -- a valid_to + 24 h no pudo hacerse con esa versión.
          if pack_version.valid_from > completed_at + interval '10 minutes'
             or (pack_version.valid_to is not null and completed_at > pack_version.valid_to + interval '24 hours 10 minutes') then
            raise exception 'Offline pack configuration was not valid for the device that sold it' using errcode = '42501';
          end if;
          unit_discount := app_private.round_ratio_half_up(list_subtotal * pack_bps, 10000);
          if pack_discount <> unit_discount then raise exception 'Offline pack discount does not match its percentage' using errcode = '22023'; end if;
        else
          if bp_min is not null then
            -- "DESDE N unidades": si la línea llega a la cantidad mínima, TODAS sus unidades reciben el descuento (no sólo los
            -- grupos completos). Se evalúa por producto/línea, nunca sumando productos distintos. Espeja
            -- calculateBranchPromotionLinePricing y el insert_sale de Rust.
            if bp_min not between 2 and 1000 or bp_bps is null or bp_bps not between 1 and 9999
               or quantity < bp_min or bp_units is null or bp_units <> quantity or bp_discount is null then
              raise exception 'Offline branch promotion line is inconsistent' using errcode = '22023';
            end if;
          else
            -- Formato anterior (POS sin actualizar): "cada N", sólo los grupos completos. Se conserva únicamente para que una
            -- venta ya hecha con ese formato sincronice; el POS actual nunca lo envía.
            if bp_every is null or bp_every not between 2 and 1000 or bp_bps is null or bp_bps not between 1 and 9999
               or bp_units is null or bp_units <= 0 or bp_units <> (quantity / bp_every) * bp_every or bp_discount is null then
              raise exception 'Offline branch promotion line is inconsistent' using errcode = '22023';
            end if;
          end if;
          -- La regla tiene que existir, ser de esta sucursal y tener exactamente los valores que el POS dice haber usado
          -- (las filas son inmutables: editar una promoción crea otra). Tolerancia de reloj: el dispositivo puede estar
          -- unos minutos atrasado respecto del servidor que creó la promoción.
          if not exists (
            select 1 from public.branch_promotions bpr
            where bpr.id = bp_id and bpr.organization_id = org_id and bpr.branch_id = branch_uuid
              and bpr.scope = 'ALL_UNIT_PRODUCTS' and bpr.minimum_units = coalesce(bp_min, bp_every) and bpr.discount_bps = bp_bps
              and bpr.valid_from <= completed_at + interval '10 minutes'
              -- La semántica de la venta tiene que ser la de la regla: "desde N" (branchPromotionMinimumUnits) sólo contra una regla
              -- FROM_MINIMUM y el formato anterior "cada N" (branchPromotionEveryUnits) sólo contra una regla EVERY_GROUP.
              and bpr.semantics = case when bp_min is not null then 'FROM_MINIMUM' else 'EVERY_GROUP' end
              -- Una regla "cada N" está cerrada desde 202610040061: vale para lo vendido antes del cierre y para un POS que todavía
              -- no sincronizó (autorización offline de 24 h + 10 min de tolerancia), nunca para ventas nuevas indefinidamente.
              and (bp_min is not null or bpr.valid_until is null or completed_at <= bpr.valid_until + interval '24 hours 10 minutes')
          ) then
            if bp_min is null then
              raise exception 'Offline branch promotion uses the superseded "cada N" rule: update the POS' using errcode = '42501';
            end if;
            raise exception 'Offline branch promotion does not match a rule of this branch' using errcode = '42501';
          end if;
          unit_discount := app_private.round_ratio_half_up(list_price * bp_units * bp_bps, 10000);
          if bp_discount <> unit_discount then raise exception 'Offline branch promotion discount does not match its percentage' using errcode = '22023'; end if;
        end if;
        if promo_discount <> unit_discount or discount_total <> unit_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        cash_subtotal := list_subtotal - unit_discount;
        if cash_subtotal <= 0 then raise exception 'Offline unit discount leaves the line at zero' using errcode = '22023'; end if;
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> app_private.round_ratio_half_up(subtotal, quantity) then
          raise exception 'Offline unit discount line is inconsistent' using errcode = '22023';
        end if;
      elsif line_promotion_mode = 'PACK_FIXED_TOTAL' then
        if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
        select * into pack_promo from public.product_weight_discounts
        where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
        if not found or pack_promo.pack_quantity_units is null then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
        if pack_promo.pack_price_cents > list_price * pack_promo.pack_quantity_units then
          raise exception 'El precio del pack supera el precio de lista para su cantidad' using errcode = '22023';
        end if;
        whole_packs := quantity / pack_promo.pack_quantity_units;
        remainder := quantity % pack_promo.pack_quantity_units;
        -- Pack total: CASH-equivalent = whole packs at their fixed price + remainder at plain
        -- list (never a discounted rate) — the surcharge (D-044, corrected) is ONE rounding on
        -- the WHOLE resulting total below, never only on the remainder.
        cash_subtotal := pack_promo.pack_price_cents * whole_packs + list_price * remainder;
        if promo_discount <> greatest(list_price * (whole_packs * pack_promo.pack_quantity_units) - pack_promo.pack_price_cents * whole_packs, 0)
           or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> subtotal then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
      else
        cash_subtotal := list_subtotal;
        if promo_discount <> 0 or discount_total <> 0 then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- Non-pack: round once at the per-unit level (mirrors calculateSalePricing exactly,
        -- since quantityDivisor 1 makes its own subtotal rounding a no-op), then multiply exactly
        -- — not a single rounding on the subtotal, which can disagree by a cent for some quantities.
        if final_price <> (case when cash_bps > 0 then app_private.round_ratio_half_up(list_price * (10000 + cash_bps), 10000) else list_price end)
           or subtotal <> final_price * quantity then
          raise exception 'Undiscounted snapshot is inconsistent' using errcode = '22023';
        end if;
      end if;
      if card_surcharge <> subtotal - cash_subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;
      if not exists(select 1 from public.products p where p.id = current_product_id and p.organization_id = org_id and p.unit_type = 'UNIT') then
        raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
      end if;
      if (movement->>'productId')::uuid <> current_product_id or (movement->>'quantityGrams')::bigint <> -quantity::bigint then
        raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
      end if;

      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = current_product_id and c.valid_from <= completed_at and (c.valid_to is null or c.valid_to > completed_at)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = current_product_id and s.valid_from <= completed_at and (s.valid_to is null or s.valid_to > completed_at)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
        manual_price_applied, manual_unit_price_cents, manual_adjustment_cents,
        sold_as_pack, pack_size_units_snapshot, pack_count, pack_discount_bps, pack_discount_cents, pack_config_id,
        branch_promotion_id, branch_promotion_every_units, branch_promotion_discount_bps, branch_promotion_discounted_units, branch_promotion_discount_cents
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', quantity, final_price,
        list_price, discount_rule, null, null, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at,
        manual_applied, manual_price, coalesce(manual_adjustment, 0),
        sold_pack, pack_size, pack_count, pack_bps, coalesce(pack_discount, 0), pack_config,
        bp_id, coalesce(bp_min, bp_every), bp_bps, bp_units, coalesce(bp_discount, 0)
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -quantity::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal;
    else
      -- WEIGHT line.
      if grams is null or grams <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000);

      if manual_applied then
        cash_subtotal := subtotal;
        if subtotal <> app_private.round_ratio_half_up(manual_price * grams, 1000) or subtotal <= 0 or manual_adjustment <> subtotal - list_subtotal then
          raise exception 'Offline manual price arithmetic is invalid' using errcode = '22023';
        end if;
      elsif line_promotion_mode = 'PACK_FIXED_TOTAL' then
        if discount_type is not null or discount_value is not null then
          raise exception 'Offline pack promotion metadata is inconsistent' using errcode = '22023';
        end if;
        if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
        select * into pack_promo from public.product_weight_discounts
        where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
        if not found then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
        -- Guard against LIST price, before any card surcharge — the pack total is
        -- payment-method-invariant only up to this guard, not in the final charged amount below.
        if pack_promo.pack_price_cents > list_subtotal then raise exception 'El precio del pack supera el precio de lista para el peso pesado' using errcode = '22023'; end if;
        cash_subtotal := pack_promo.pack_price_cents;
        if promo_discount <> greatest(list_subtotal - cash_subtotal, 0) or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- The surcharge (D-044, corrected) applies to the WHOLE pack total below — one rounding,
        -- mirrors calculateWeightPackSalePricing exactly (no single per-kg rate to round first).
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> app_private.round_ratio_half_up(subtotal * 1000, grams) then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
      else
        if discount_type = 'PERCENTAGE' then
          if discount_value not between 1 and 10000 then raise exception 'Offline percentage promotion is inconsistent' using errcode = '22023'; end if;
          promo_price := app_private.round_ratio_half_up(list_price * (10000 - discount_value), 10000);
        elsif discount_type = 'FIXED_PRICE_PER_KG' then
          if discount_value <= 0 then raise exception 'Offline fixed-price promotion is inconsistent' using errcode = '22023'; end if;
          promo_price := discount_value;
        elsif discount_rule is not null or discount_value is not null then
          raise exception 'Offline promotion metadata is inconsistent' using errcode = '22023';
        else
          promo_price := list_price;
        end if;
        if promo_price > list_price then raise exception 'Offline promotion cannot increase a price' using errcode = '22023'; end if;
        cash_subtotal := app_private.round_ratio_half_up(promo_price * grams, 1000);
        if promo_discount <> list_subtotal - cash_subtotal or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- Non-pack: round once at the per-kg level (list -> promotion -> surcharge, D-044,
        -- corrected), THEN derive the subtotal from grams — mirrors calculateSalePricing exactly.
        if final_price <> (case when cash_bps > 0 then app_private.round_ratio_half_up(promo_price * (10000 + cash_bps), 10000) else promo_price end)
           or subtotal <> app_private.round_ratio_half_up(final_price * grams, 1000) then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        if discount_rule is not null and not exists(
          select 1 from public.product_weight_discounts pwd where pwd.id = discount_rule and pwd.organization_id = org_id and pwd.product_id = current_product_id
        ) then
          raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501';
        end if;
      end if;
      if card_surcharge <> subtotal - cash_subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;

      if not exists(select 1 from public.products p where p.id = current_product_id and p.organization_id = org_id and p.unit_type = 'WEIGHT') then
        raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
      end if;
      if (movement->>'productId')::uuid <> current_product_id or (movement->>'quantityGrams')::bigint <> -grams::bigint then
        raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
      end if;
      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = current_product_id and c.valid_from <= completed_at and (c.valid_to is null or c.valid_to > completed_at)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = current_product_id and s.valid_from <= completed_at and (s.valid_to is null or s.valid_to > completed_at)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
        manual_price_applied, manual_unit_price_cents, manual_adjustment_cents
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', grams, final_price,
        list_price, discount_rule, discount_type, discount_value, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at,
        manual_applied, manual_price, coalesce(manual_adjustment, 0)
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -grams::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal; computed_weight := computed_weight + grams;
    end if;
  end loop;

  -- Descuento general del ticket (D-061): el servidor recalcula el importe con la misma regla que el POS
  -- (porcentaje en basis points sobre la suma final de las líneas, redondeo half-up) y rechaza la venta si lo
  -- declarado no coincide. Lo cobrado (sales.total_cents y el pago) es la suma de las líneas menos ese descuento.
  if (p_payload ? 'ticketDiscountBps') <> (p_payload ? 'ticketDiscountCents') then
    raise exception 'Offline ticket discount needs both its percentage and its amount' using errcode = '22023';
  end if;
  begin
    discount_bps := coalesce(nullif(p_payload->>'ticketDiscountBps', '')::integer, 0);
    declared_discount := coalesce(nullif(p_payload->>'ticketDiscountCents', '')::bigint, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline ticket discount is malformed' using errcode = '22023';
  end;
  if p_payload ? 'ticketDiscountBps' and discount_bps not between 1 and 10000 then
    raise exception 'Offline ticket discount percentage is outside 0-100%%' using errcode = '22023';
  end if;
  expected_discount := app_private.round_ratio_half_up(computed_total * discount_bps, 10000);
  if declared_discount <> expected_discount then
    raise exception 'Offline ticket discount does not match its percentage' using errcode = '22023';
  end if;
  if p_payload ? 'subtotalCents' and (p_payload->>'subtotalCents')::bigint <> computed_total then
    raise exception 'Offline ticket subtotal does not match its items' using errcode = '22023';
  end if;
  net_total := computed_total - expected_discount;
  if net_total <= 0 then raise exception 'Offline sale total must be greater than zero' using errcode = '22023'; end if;
  if net_total <> declared_total or computed_weight <> declared_weight or (p_payload->'payment'->>'amountCents')::bigint <> declared_total then
    raise exception 'Offline sale totals do not match its details' using errcode = '22023';
  end if;
  update public.sales set total_cents = net_total, total_weight_grams = computed_weight,
    ticket_discount_bps = discount_bps, ticket_discount_cents = expected_discount where id = sale_id;
  select coalesce(array_agg((e.value->>'id')::uuid order by e.ordinality), '{}'::uuid[]) into ordered_item_ids
  from jsonb_array_elements(p_payload->'items') with ordinality as e(value, ordinality);
  perform app_private.allocate_ticket_discount(sale_id, ordered_item_ids);
  insert into public.payments(id, sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values ((p_payload->'payment'->>'id')::uuid, sale_id, org_id, branch_uuid, method, declared_total, completed_at);
  return jsonb_build_object('saleId', sale_id, 'duplicate', false, 'syncedAt', now());
end;
$$;


-- ---------------------------------------------------------------------------------------------
-- 6. Estado de Envasados para el POS (offline) y administración de paquetes
-- ---------------------------------------------------------------------------------------------

-- Lo que un POS necesita para reconocer y vender paquetes sin Internet: el esquema EAN, el PLU de cada corte habilitado y los paquetes
-- DISPONIBLES de su sucursal (con peso real e importe a cobrar). Mismo control de acceso que get_pos_branch_stock.
create function public.get_pos_vacuum_state(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_tz text;
  v_since date;
  v_scheme jsonb;
  v_plus jsonb;
  v_packages jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select b.organization_id into v_org from public.branches b where b.id = p_branch_id and b.active;
  if v_org is null or not app_private.can_access_branch(v_org, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_since := (now() at time zone coalesce(v_tz, 'UTC'))::date - 30;

  select jsonb_build_object('scheme', s.ean_scheme, 'prefix', s.ean_prefix, 'pluDigits', s.ean_plu_digits,
    'valueDigits', s.ean_value_digits, 'valueStep', s.ean_value_step)
  into v_scheme
  from public.organization_vacuum_settings s where s.organization_id = v_org and s.ean_scheme is not null;

  select coalesce(jsonb_agg(jsonb_build_object('productId', x.product_id, 'plu', x.plu) order by x.plu::bigint), '[]'::jsonb) into v_plus
  from public.product_vacuum_settings x
  where x.organization_id = v_org and x.enabled and x.plu is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'packageId', r.id, 'productId', r.product_id, 'productName', r.product_name_snapshot, 'ean13', r.ean13,
    'weightGrams', r.weight_grams, 'chargeCents', app_private.vacuum_package_charge_cents(r)::text,
    'lot', r.lot, 'packedOn', r.packed_on, 'expiresOn', r.expires_on
  ) order by r.packed_on, r.created_at, r.id), '[]'::jsonb) into v_packages
  from (
    select p.* from public.vacuum_package_state s
    join public.vacuum_packages p on p.id = s.package_id and p.organization_id = s.organization_id
    where s.organization_id = v_org and s.current_branch_id = p_branch_id and s.status = 'AVAILABLE' and p.expires_on >= v_since
    order by p.packed_on, p.created_at, p.id
    limit 3000
  ) r;

  return jsonb_build_object('serverTime', now(), 'branchId', p_branch_id, 'scheme', v_scheme, 'plus', v_plus, 'packages', v_packages);
end;
$$;

create function public.list_vacuum_package_conflicts(p_status text default 'OPEN', p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
begin
  if p_status not in ('OPEN', 'RESOLVED', 'ALL') then raise exception 'Estado inválido' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'status', c.status, 'reason', c.reason, 'createdAt', c.created_at,
      'branchId', c.branch_id, 'branchName', b.name, 'packageId', c.package_id,
      'productName', p.product_name_snapshot, 'weightGrams', p.weight_grams, 'totalCents', app_private.vacuum_package_charge_cents(p)::text,
      'lot', p.lot, 'ean13', p.ean13, 'saleId', c.sale_id, 'firstSaleId', c.first_sale_id,
      'resolutionNote', c.resolution_note, 'resolvedAt', c.resolved_at
    ) order by c.created_at desc, c.id)
    from (
      select * from public.vacuum_package_conflicts x
      where x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis)) and (p_status = 'ALL' or x.status = p_status)
      order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) c
    join public.vacuum_packages p on p.id = c.package_id and p.organization_id = c.organization_id
    join public.branches b on b.id = c.branch_id and b.organization_id = c.organization_id
  ), '[]'::jsonb);
end;
$$;

create function public.resolve_vacuum_package_conflict(p_conflict_id uuid, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_row public.vacuum_package_conflicts%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_note is null or char_length(v_note) < 3 then raise exception 'Indicá cómo se resolvió el conflicto (mínimo 3 caracteres)' using errcode = '22023'; end if;
  select * into v_row from public.vacuum_package_conflicts c
  where c.id = p_conflict_id and c.organization_id = v_org and (v_vis is null or c.branch_id = any(v_vis)) for update;
  if not found then raise exception 'Conflicto no encontrado' using errcode = '42501'; end if;
  if v_row.status = 'RESOLVED' then return; end if;
  update public.vacuum_package_conflicts set status = 'RESOLVED', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now() where id = v_row.id;
  insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, note, created_by)
  values (v_org, v_row.package_id, v_row.branch_id, 'CONFLICT_RESOLVED', v_row.sale_id, v_row.sale_item_id, v_note, auth.uid());
end;
$$;

-- Envía paquetes DISPONIBLES a otra sucursal: sólo cambia dónde los ofrece el POS. El stock del corte se mueve con las transferencias de
-- siempre (no hay una segunda contabilidad: los paquetes no tienen stock propio).
create function public.move_vacuum_packages(p_package_ids uuid[], p_to_branch_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_moved integer := 0;
  v_ids uuid[] := (select coalesce(array_agg(distinct i), '{}'::uuid[]) from unnest(coalesce(p_package_ids, '{}'::uuid[])) i);
  r record;
begin
  if coalesce(array_length(v_ids, 1), 0) not between 1 and 500 then raise exception 'Elegí entre 1 y 500 paquetes' using errcode = '22023'; end if;
  perform app_private.require_visible_branch(v_org, p_to_branch_id);
  if not exists (select 1 from public.branches b where b.id = p_to_branch_id and b.organization_id = v_org and b.active) then
    raise exception 'La sucursal de destino está inactiva' using errcode = '22023';
  end if;
  for r in
    select s.package_id, s.current_branch_id, s.status from public.vacuum_package_state s
    where s.organization_id = v_org and s.package_id = any(v_ids) order by s.package_id for update
  loop
    if v_vis is not null and not (r.current_branch_id = any(v_vis)) then raise exception 'Paquete de una sucursal que no podés administrar' using errcode = '42501'; end if;
    if r.status <> 'AVAILABLE' then raise exception 'Sólo se pueden enviar paquetes disponibles' using errcode = '22023'; end if;
    if r.current_branch_id <> p_to_branch_id then
      update public.vacuum_package_state set current_branch_id = p_to_branch_id, updated_at = now() where package_id = r.package_id;
      insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, created_by) values (v_org, r.package_id, p_to_branch_id, 'MOVED', auth.uid());
      v_moved := v_moved + 1;
    end if;
  end loop;
  if (select count(*) from public.vacuum_package_state s where s.organization_id = v_org and s.package_id = any(v_ids)) <> array_length(v_ids, 1) then
    raise exception 'Algún paquete no existe en esta organización' using errcode = '42501';
  end if;
  return v_moved;
end;
$$;

-- Anula un paquete DISPONIBLE (se descarta, se rompió el vacío…). No mueve stock: envasar nunca lo descontó.
create function public.void_vacuum_package(p_package_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_state public.vacuum_package_state%rowtype;
begin
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'Indicá el motivo (mínimo 3 caracteres)' using errcode = '22023'; end if;
  select * into v_state from public.vacuum_package_state s
  where s.package_id = p_package_id and s.organization_id = v_org and (v_vis is null or s.current_branch_id = any(v_vis)) for update;
  if not found then raise exception 'Paquete no encontrado' using errcode = '42501'; end if;
  if v_state.status <> 'AVAILABLE' then raise exception 'Sólo se puede anular un paquete disponible' using errcode = '22023'; end if;
  update public.vacuum_package_state set status = 'VOIDED', void_reason = v_reason, updated_at = now() where package_id = p_package_id;
  insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, note, created_by)
  values (v_org, p_package_id, v_state.current_branch_id, 'VOIDED', v_reason, auth.uid());
end;
$$;

revoke all on function
  app_private.vacuum_commercial_total(text, integer, bigint),
  app_private.vacuum_package_charge_cents(public.vacuum_packages),
  app_private.vacuum_package_init_state(),
  app_private.sync_vacuum_package_line(uuid, uuid, uuid, uuid, uuid, public.payment_method, timestamptz, jsonb, jsonb),
  app_private.vacuum_sale_status_changed(),
  app_private.guard_vacuum_reserved_barcode()
from public, anon, authenticated;

revoke all on function
  public.get_pos_vacuum_state(uuid),
  public.list_vacuum_package_conflicts(text, integer),
  public.resolve_vacuum_package_conflict(uuid, text),
  public.move_vacuum_packages(uuid[], uuid),
  public.void_vacuum_package(uuid, text)
from public, anon;
grant execute on function
  public.get_pos_vacuum_state(uuid),
  public.list_vacuum_package_conflicts(text, integer),
  public.resolve_vacuum_package_conflict(uuid, text),
  public.move_vacuum_packages(uuid[], uuid),
  public.void_vacuum_package(uuid, text)
to authenticated;

commit;
