begin;

create extension if not exists pgtap with schema extensions;
select plan(69);

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'get_branch_operating_result', array['date','date','uuid'], 'get_branch_operating_result exists');
select has_function('public', 'get_branch_operating_costs', array['uuid','date','date'], 'get_branch_operating_costs exists');
select has_function('public', 'save_branch_recurring_cost', array['uuid','uuid','text','bigint','date','uuid'], 'save_branch_recurring_cost exists');
select has_function('public', 'end_branch_recurring_cost', array['uuid','date'], 'end_branch_recurring_cost exists');
select has_function('public', 'record_branch_expense', array['uuid','date','text','bigint','uuid'], 'record_branch_expense exists');
select has_function('public', 'void_branch_expense', array['uuid','text'], 'void_branch_expense exists');
select ok((select bool_and(prosecdef) from pg_proc where oid in (
  'public.get_branch_operating_result(date,date,uuid)'::regprocedure, 'public.get_branch_operating_costs(uuid,date,date)'::regprocedure,
  'public.save_branch_recurring_cost(uuid,uuid,text,bigint,date,uuid)'::regprocedure, 'public.record_branch_expense(uuid,date,text,bigint,uuid)'::regprocedure)),
  'the operating-cost RPCs are security definer');
select ok(not has_function_privilege('anon', 'public.get_branch_operating_result(date,date,uuid)', 'EXECUTE'), 'anonymous cannot read the operating result');
select ok(not has_function_privilege('anon', 'public.record_branch_expense(uuid,date,text,bigint,uuid)', 'EXECUTE'), 'anonymous cannot record expenses');
select ok(not has_function_privilege('authenticated', 'app_private.recurring_cost_imputed_cents(uuid,date,date)', 'EXECUTE'), 'the proration formula is not callable by browser clients');
select ok(not has_table_privilege('authenticated', 'public.branch_expenses', 'SELECT'), 'browser clients cannot read the expenses table directly');
select ok(not has_table_privilege('authenticated', 'public.branch_recurring_cost_versions', 'INSERT'), 'browser clients cannot write cost versions directly');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A: Avenida y Janssen. Org B: una sucursal. Admin A, empleado A (sin analytics ni costos), Admin B.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'oc-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OC Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'oc-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OC Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'oc-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OC Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'OC Org A', 'oc-org-a'),
  ('e2000000-0000-4000-8000-000000000002', 'OC Org B', 'oc-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Avenida', 'OC-AV'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Janssen', 'OC-JA'),
  ('e3000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000002', 'Org B Branch', 'OC-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Varios', 'oc-varios');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Pata muslo', 'oc-pata', 'OC-PATA', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Sin costo', 'oc-sc', 'OC-SC', 'WEIGHT');

-- Avenida, 10/04/2026 (hora local Buenos Aires, UTC-3): ventas $2.500.000 con costo histórico $1.500.000 -> ganancia bruta $1.000.000.
-- Avenida, 15/04/2026: una venta de $10.000 SIN costo histórico (resultado parcial). Janssen, 10/04: $400.000 con costo $300.000.
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'COMPLETED', 250000000, 1000, '2026-04-10 15:00:00+00'),
  ('e6000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'COMPLETED', 1000000, 1000, '2026-04-15 15:00:00+00'),
  ('e6000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'COMPLETED', 40000000, 1000, '2026-04-10 15:00:00+00'),
  ('e6000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'PENDING_PAYMENT', 99900000, 1000, '2026-04-10 16:00:00+00');
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 250000000, 250000000, 250000000, 250000000, 150000000),
  ('e6000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002', 'Sin costo', 1000, 1000000, 1000000, 1000000, 1000000, null),
  ('e6000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 40000000, 40000000, 40000000, 40000000, 30000000),
  ('e6000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 99900000, 99900000, 99900000, 99900000, 1);

-- Costos fijados por el dueño (rol de administración) desde la base como superusuario sólo para el fixture de los casos de otra organización.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Sin costos configurados: resultado operativo = ganancia bruta
-- ---------------------------------------------------------------------------------------------
select is((select gross_profit_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 100000000::bigint, 'Avenida gross profit on 10/04 is $1.000.000 (shared profitability engine)');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 100000000::bigint, 'with no costs configured the operating result equals the gross profit');
select is((select gross_profit_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')),
  (select gross_profit_cents from public.get_branch_profitability_summary('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 'the gross profit is exactly the one of the existing profitability summary');

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000009', null, 'Alquiler', 30000000, '2026-01-01')$$, '42501', null, 'a branch of another organization is rejected');
select throws_ok($$select public.record_branch_expense('e3000000-0000-4000-8000-000000000009', '2026-04-10', 'Luz', 100)$$, '42501', null, 'an expense for another organization branch is rejected');

-- ---------------------------------------------------------------------------------------------
-- Costos recurrentes: alquiler $300.000/mes y sueldo $600.000/mes, vigentes desde 01/01/2026
-- ---------------------------------------------------------------------------------------------
create temp table oc_ids (name text primary key, id uuid);
grant all on oc_ids to public;
insert into oc_ids select 'rent', (public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', null, 'Alquiler', 30000000, '2026-01-01', 'e8000000-0000-4000-8000-000000000001') ->> 'costId')::uuid;
insert into oc_ids select 'salary', (public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', null, 'Empleada', 60000000, '2026-01-01', 'e8000000-0000-4000-8000-000000000002') ->> 'costId')::uuid;
select is((select count(*)::int from oc_ids), 2, 'two monthly costs were created');

-- Idempotencia del alta: el mismo request_key devuelve el mismo concepto y no crea otro.
select is((public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', null, 'Alquiler', 30000000, '2026-01-01', 'e8000000-0000-4000-8000-000000000001') ->> 'costId')::uuid, (select id from oc_ids where name = 'rent'), 'a repeated create with the same request key returns the same cost');
select is(jsonb_array_length(public.get_branch_operating_costs('e3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') -> 'recurring'), 2, 'no duplicate concept was created');

-- Gasto puntual de $50.000 el 10/04.
insert into oc_ids select 'expense', (public.record_branch_expense('e3000000-0000-4000-8000-000000000001', '2026-04-10', 'Reparación heladera', 5000000, 'e8000000-0000-4000-8000-000000000003') ->> 'expenseId')::uuid;
select is((public.record_branch_expense('e3000000-0000-4000-8000-000000000001', '2026-04-10', 'Reparación heladera', 5000000, 'e8000000-0000-4000-8000-000000000003') ->> 'expenseId')::uuid, (select id from oc_ids where name = 'expense'), 'a repeated expense with the same request key is registered once');
select is(jsonb_array_length(public.get_branch_operating_costs('e3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') -> 'expenses'), 1, 'one expense is listed');

-- Caso real: abril tiene 30 días -> $900.000 / 30 = $30.000 por día.
-- Hoy (10/04): ganancia 1.000.000 - 30.000 - 50.000 = 920.000
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 3000000::bigint, 'one day of April charges 900.000 / 30 = 30.000 of monthly costs');
select is((select expense_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 5000000::bigint, 'the one-off expense is charged in full on its date');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 92000000::bigint, 'today: 1.000.000 - 30.000 - 50.000 = 920.000');
-- 7 días (04 a 10/04): 7 x 30.000 = 210.000 + gasto 50.000 -> 740.000
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-04-04', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 21000000::bigint, 'seven days charge seven daily shares');
select is((select expense_cents from public.get_branch_operating_result('2026-04-04', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 5000000::bigint, 'a 7-day range that includes 10/04 carries the full expense');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-04', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 74000000::bigint, '7 days: 1.000.000 - 210.000 - 50.000 = 740.000');
-- Un período que no incluye el 10/04 no carga el gasto.
select is((select expense_cents from public.get_branch_operating_result('2026-04-11', '2026-04-14', 'e3000000-0000-4000-8000-000000000001')), 0::bigint, 'a period that does not include the expense date has no expense');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-04-11', '2026-04-14', 'e3000000-0000-4000-8000-000000000001')), 12000000::bigint, 'four days charge 4 x 30.000');
-- 30 días completos de abril: 900.000 + 50.000 -> 1.000.000 - 950.000 = 50.000 (con la venta sin costo del 15/04 el resultado es parcial).
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'e3000000-0000-4000-8000-000000000001')), 5000000::bigint, 'the whole month charges exactly the monthly amounts');
-- Rango personalizado que cruza meses (29/03 a 02/04): marzo 31 días (3 días) + abril 30 días (2 días), un redondeo por concepto.
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-03-29', '2026-04-02', 'e3000000-0000-4000-8000-000000000001')),
  (round(30000000::numeric * 3 / 31 + 30000000::numeric * 2 / 30) + round(60000000::numeric * 3 / 31 + 60000000::numeric * 2 / 30))::bigint, 'a range across months prorates each month by its own number of days (never 30)');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-03-29', '2026-04-02', 'e3000000-0000-4000-8000-000000000001')), 14709678::bigint, 'the cross-month proration is 14.709678 in cents');
-- Ejemplo del enunciado: alquiler $310.000 en un mes de 31 días, 1 día -> $10.000.
select lives_ok($$select public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000002', null, 'Alquiler Janssen', 31000000, '2026-01-01', 'e8000000-0000-4000-8000-000000000004')$$, 'Janssen rent $310.000 created');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-03-05', '2026-03-05', 'e3000000-0000-4000-8000-000000000002')), 1000000::bigint, 'one day of a 31-day month charges 310.000 / 31 = 10.000');

-- ---------------------------------------------------------------------------------------------
-- Resultado parcial (líneas sin costo histórico)
-- ---------------------------------------------------------------------------------------------
select is((select is_partial from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'e3000000-0000-4000-8000-000000000001')), true, 'the result is partial when a line has no historical cost');
select is((select missing_cost_items from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'e3000000-0000-4000-8000-000000000001')), 1, 'the existing missing-cost counter is reused');
select is((select is_partial from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), false, 'a period with every line costed is not partial');
select is((select operating_margin_bps from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 3680::bigint, 'operating margin = result / sales (920.000 / 2.500.000 = 36.8%)');

-- ---------------------------------------------------------------------------------------------
-- Histórico: el alquiler sube a $500.000 desde el 01/05; abril conserva $300.000
-- ---------------------------------------------------------------------------------------------
select is((public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', (select id from oc_ids where name = 'rent'), 'Alquiler', 50000000, '2026-05-01') ->> 'changed')::boolean, true, 'changing the rent opens a new version');
select is(jsonb_array_length((select r -> 'history' from jsonb_array_elements(public.get_branch_operating_costs('e3000000-0000-4000-8000-000000000001', '2026-05-01', '2026-05-31') -> 'recurring') r where r ->> 'name' = 'Alquiler')), 2, 'the history keeps both versions');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'e3000000-0000-4000-8000-000000000001')), 90000000::bigint, 'April still uses the old $300.000 rent');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-05-01', '2026-05-31', 'e3000000-0000-4000-8000-000000000001')), 110000000::bigint, 'May uses the new $500.000 rent (+ salary 600.000)');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-04-30', '2026-05-01', 'e3000000-0000-4000-8000-000000000001')),
  (round(30000000::numeric / 30 + 50000000::numeric / 31) + round(60000000::numeric / 30 + 60000000::numeric / 31))::bigint, 'a range that crosses the version change uses each version for its own days');
select is((public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', (select id from oc_ids where name = 'rent'), 'Alquiler', 50000000, '2026-06-01') ->> 'changed')::boolean, false, 'saving the same amount again changes nothing');
select throws_ok($$select public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', (select id from oc_ids where name = 'rent'), 'Alquiler', 60000000, '2026-04-20')$$, '22023', null, 'a new amount cannot start before the current version (history is not rewritten)');
-- Corrección del mismo día: el importe vigente desde el 01/05 era un error de tipeo.
select is((public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', (select id from oc_ids where name = 'rent'), 'Alquiler', 55000000, '2026-05-01') ->> 'changed')::boolean, true, 'a same-day correction is accepted');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-05-01', '2026-05-31', 'e3000000-0000-4000-8000-000000000001')), 115000000::bigint, 'the corrected amount is the one that applies');
select is(jsonb_array_length((select r -> 'history' from jsonb_array_elements(public.get_branch_operating_costs('e3000000-0000-4000-8000-000000000001', '2026-05-01', '2026-05-31') -> 'recurring') r where r ->> 'name' = 'Alquiler')), 2, 'the modal history hides the emptied correction row and shows two real versions');

-- El historial es append-only incluso para el dueño de la tabla.
reset role;
select throws_ok($$delete from public.branch_recurring_cost_versions$$, '55000', null, 'cost versions cannot be deleted');
select throws_ok($$update public.branch_recurring_cost_versions set amount_cents = 1 where valid_to is null$$, '55000', null, 'an existing version cannot be rewritten');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Baja de un costo y anulación de un gasto
-- ---------------------------------------------------------------------------------------------
select is((public.end_branch_recurring_cost((select id from oc_ids where name = 'salary'), '2026-07-01') ->> 'changed')::boolean, true, 'ending the salary closes its current version');
select is((select recurring_cost_cents from public.get_branch_operating_result('2026-06-30', '2026-07-02', 'e3000000-0000-4000-8000-000000000001')),
  (round(55000000::numeric / 30 + 55000000::numeric * 2 / 31) + round(60000000::numeric / 30))::bigint, 'the salary applies up to 30/06 and stops on 01/07');
select throws_ok($$select public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', (select id from oc_ids where name = 'salary'), 'Empleada', 70000000, '2026-06-15')$$, '22023', null, 'a cost ended on 01/07 cannot be reactivated from before that date');
select is((public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', (select id from oc_ids where name = 'salary'), 'Empleada', 70000000, '2026-08-01') ->> 'changed')::boolean, true, 'a stopped cost can be reactivated later');
select is((public.void_branch_expense((select id from oc_ids where name = 'expense'), 'Cargado dos veces') ->> 'changed')::boolean, true, 'an expense can be voided');
select is((public.void_branch_expense((select id from oc_ids where name = 'expense'), 'Cargado dos veces') ->> 'changed')::boolean, false, 'voiding twice does nothing');
select is((select expense_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'e3000000-0000-4000-8000-000000000001')), 0::bigint, 'a voided expense stops being charged');
reset role;
select is((select count(*)::int from public.branch_expenses where voided_at is not null), 1, 'the voided expense is kept in the database');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.record_branch_expense('e3000000-0000-4000-8000-000000000001', (current_date + 30), 'Futuro', 100)$$, '22023', null, 'an expense cannot be dated in the future');
select throws_ok($$select public.record_branch_expense('e3000000-0000-4000-8000-000000000001', '2026-04-10', 'Cero', 0)$$, '22023', null, 'a zero expense is rejected');
select throws_ok($$select public.save_branch_recurring_cost('e3000000-0000-4000-8000-000000000001', null, 'Cero', 0, '2026-01-01')$$, '22023', null, 'a zero monthly cost is rejected');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento y permisos
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::int from public.get_branch_operating_result('2026-04-01', '2026-04-30')), 2, 'the home query returns every accessible branch (Avenida and Janssen)');
select is((select sum(gross_profit_cents)::bigint from public.get_branch_operating_result('2026-04-10', '2026-04-10')), 110000000::bigint, 'the total of the branches is the sum of their gross profits (Avenida 1.000.000 + Janssen 100.000)');

select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_operating_result('2026-04-10', '2026-04-10')$$, '42501', null, 'an employee without analytics.read cannot read the operating result');
select throws_ok($$select public.record_branch_expense('e3000000-0000-4000-8000-000000000001', '2026-04-10', 'Intento', 100)$$, '42501', null, 'an employee cannot register expenses');

select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*)::int from public.get_branch_operating_result('2026-04-01', '2026-04-30')), 1, 'another organization only sees its own branch');
select throws_ok($$select public.get_branch_operating_costs('e3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')$$, '42501', null, 'another organization cannot read the costs of Avenida');
select throws_ok($$select public.void_branch_expense('e9000000-0000-4000-8000-000000000001', 'x')$$, '42501', null, 'voiding an unknown expense is rejected');

select * from finish();
rollback;
