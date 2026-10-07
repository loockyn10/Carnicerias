-- Redondeo comercial del precio de lista calculado por margen (D-071).
--
--   costo -> gross-up por margen (costo / (1 - margen), half-up, sin cambios) -> redondeo al múltiplo de $50 más cercano
--   (half-up en el punto medio) -> nueva vigencia de precio.
--
-- Se cambia UNA sola función: app_private.list_price_from_margin. Todo precio automático pasa por ella (set_product_cost,
-- bulk_set_product_costs, importación con costo, cambio de margen global/propio, alta con costo) vía reprice_from_margin y
-- recalculate_prices_from_margin, así que no hay que tocar a ninguno de ellos ni a sus vistas previas (que usan la misma función).
--
-- NO cambia: public.calculate_product_price (gross-up genérico y sistema de markup anterior), precios manuales, precio manual por
-- línea de Central, categorías excluidas sin margen propio, snapshots y vigencias históricas (nada se reescribe: los precios ya
-- guardados quedan como están hasta que un costo/margen vuelva a derivarlos), ni dto 3u / pack / promociones / tarjeta (siguen
-- calculándose sobre el precio de lista ya redondeado, sin redondear cada etapa).

begin;

-- $50 = 5.000 centavos. Enteros puros: floor((precio + 2.500) / 5.000) * 5.000, o sea 2.475,00 -> 2.500 y 2.474,99 -> 2.450.
create function app_private.round_commercial_price_to_nearest_50(p_price_cents bigint)
returns bigint
language sql
immutable
security definer
set search_path = ''
as $$
  select ((p_price_cents + 2500) / 5000) * 5000;
$$;

create or replace function app_private.list_price_from_margin(p_cost_cents bigint, p_margin_bps integer)
returns bigint
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  list_price bigint;
begin
  if p_cost_cents is null or p_cost_cents <= 0 then
    raise exception 'El costo tiene que ser mayor a cero' using errcode = '22023';
  end if;
  if p_margin_bps is null or p_margin_bps not between 1 and 9999 then
    raise exception 'El margen tiene que ser mayor a 0 %% y menor a 100 %%' using errcode = '22023';
  end if;
  -- calculate_product_price(costo, markup 0, bps) = round_half_up(costo * 10000 / (10000 - bps)): el gross-up existente, sin tocar.
  select cp.list_price_cents into list_price from public.calculate_product_price(p_cost_cents, 0, p_margin_bps) cp;
  -- Redondeo comercial a $50. Piso de $50: un costo mínimo nunca produce un precio de $0 (set_price_history lo rechazaría y frenaría
  -- toda la carga masiva); $0 significaría «sin precio definido».
  return greatest(app_private.round_commercial_price_to_nearest_50(list_price), 5000);
end;
$$;

revoke all on function app_private.round_commercial_price_to_nearest_50(bigint) from public, anon, authenticated;

commit;
