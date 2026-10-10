begin;

create extension if not exists pgtap with schema extensions;
select plan(83);

-- Covers 202610080071 (D-074): foto comercial por producto (Storage + referencia) y los HECHOS de la pieza «Producto protagonista».
-- La foto vive en el bucket privado `product-artwork`; Postgres sólo guarda la ruta. El precio de la pieza sigue el orden del POS (precio
-- de la sucursal vigente > global); la cuenta de «llevando N» NO vive acá (la hace el motor TS), así que acá se prueban sólo los hechos.

-- ---------------------------------------------------------------------------------------------
-- Fixture (ids propios: prefijo c)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'aw-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"AW Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'aw-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"AW Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'aw-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"AW Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'AW Org', 'aw-org'),
  ('c2000000-0000-4000-8000-000000000002', 'AW Org B', 'aw-org-b');
insert into public.branches (id, organization_id, name, code, address) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'AW Central', 'AW-C', 'Av. Siempre Viva 742'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'AW Avenida', 'AW-A', null),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000002', 'AW B Branch', 'AW-B', null);
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug, active) values
  ('c4000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001', 'Almacen', 'aw-almacen', true),
  ('c4000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001', 'Vaca', 'aw-vaca', true),
  ('c4000000-0000-4000-8000-00000000000c', 'c2000000-0000-4000-8000-000000000001', 'Apagada', 'aw-apagada', false),
  ('c4000000-0000-4000-8000-00000000000e', 'c2000000-0000-4000-8000-000000000002', 'Almacen B', 'awb-almacen', true);
-- 01 Mayonesa (UNIT, global $2.035 / Avenida $2.200), 02 Aceite (UNIT, no está en el surtido de Avenida), 03 Nalga (WEIGHT, $11.000/kg),
-- 04 Inactivo, 05 Sin precio (0), 06 Categoría apagada, 07 Org B, 08 Materia prima.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000a', 'Mayonesa Hellmanns 250gr', 'aw-mayo', 'AW-01', 'UNIT', true, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000a', 'Aceite Canuelas 900ml', 'aw-aceite', 'AW-02', 'UNIT', true, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000b', 'Nalga vacuna', 'aw-nalga', 'AW-03', 'WEIGHT', true, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000a', 'Producto inactivo', 'aw-inactivo', 'AW-04', 'UNIT', false, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000a', 'Producto sin precio', 'aw-sin-precio', 'AW-05', 'UNIT', true, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000c', 'Producto de categoria apagada', 'aw-cat-apagada', 'AW-06', 'UNIT', true, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-00000000000e', 'Producto de otra org', 'awb-otra', 'AWB-07', 'UNIT', true, 'SELLABLE'),
  ('c5000000-0000-4000-8000-000000000008', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-00000000000b', 'Media res', 'aw-media-res', 'AW-08', 'WEIGHT', true, 'RAW_MATERIAL');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where not (b.id = 'c3000000-0000-4000-8000-000000000002' and p.id = 'c5000000-0000-4000-8000-000000000002');

insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, valid_to) values
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', null, 203500, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 220000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', null, 245000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', null, 1100000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000001', 1790000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000004', null, 100000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000005', null, 0, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000006', null, 100000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000007', null, 500000, now() - interval '2 day', null),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000008', null, 100000, now() - interval '2 day', null);
-- Costos y margen: la pieza NO debe exponerlos jamás (están cargados a propósito).
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 123456, now() - interval '2 day');
-- «Llevando 3u»: Central 15 %; Avenida sin regla; la configuración global (20 %) sólo vale sin sucursal.
insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps)
values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 3, 1500);
insert into public.organization_pricing_settings (organization_id, margin_bps, unit_bulk_discount_bps)
values ('c2000000-0000-4000-8000-000000000001', 3333, 2000);
insert into public.organization_quantity_discount_tiers (organization_id, minimum_units, discount_bps)
values ('c2000000-0000-4000-8000-000000000001', 3, 2000);
-- Nalga: 10 % desde 2 kg (global) y precio fijo $9.500/kg desde 5 kg sólo en Central; uno vencido que no debe aparecer.
insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value) values
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', null, 2000, 'PERCENTAGE', 1000),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000001', 5000, 'FIXED_PRICE_PER_KG', 950000);
insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, valid_from, valid_until)
values ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', null, 9000, 'PERCENTAGE', 5000, now() - interval '3 day', now() - interval '1 day');

-- Objetos de Storage de prueba (los crea Storage al subir; acá se insertan con los mismos metadatos que guarda).
insert into storage.objects (bucket_id, name, metadata) values
  ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000001.png', '{"mimetype":"image/png","size":120000}'),
  ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000002.jpg', '{"mimetype":"image/jpeg","size":300000}'),
  ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000003.png', '{"mimetype":"image/gif","size":1000}'),
  ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000004.png', '{"mimetype":"image/png","size":9000000}'),
  ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000003/c6000000-0000-4000-8000-000000000005.jpg', '{"mimetype":"image/jpeg","size":80000}'),
  ('product-artwork', 'c2000000-0000-4000-8000-000000000002/c5000000-0000-4000-8000-000000000007/c6000000-0000-4000-8000-000000000006.png', '{"mimetype":"image/png","size":50000}'),
  -- Objeto de la org A subido bajo la carpeta del producto de la org B (no debe poder registrarse).
  ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000007/c6000000-0000-4000-8000-000000000007.png', '{"mimetype":"image/png","size":50000}');

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select ok(exists (select 1 from storage.buckets where id = 'product-artwork' and public = false), 'the artwork bucket exists and is PRIVATE');
select is((select file_size_limit from storage.buckets where id = 'product-artwork'), 5242880::bigint, 'the bucket limits files to 5 MB');
select is((select allowed_mime_types from storage.buckets where id = 'product-artwork'), array['image/jpeg', 'image/png'], 'the bucket only accepts JPG and PNG (WebP is converted to PNG in the browser before uploading)');
select has_table('public', 'product_artwork_photos', 'the photo reference table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.product_artwork_photos'::regclass), 'the photo table has RLS');
select ok(not has_table_privilege('anon', 'public.product_artwork_photos', 'SELECT'), 'anonymous cannot read photo references');
select ok(not has_table_privilege('authenticated', 'public.product_artwork_photos', 'INSERT'), 'browser clients cannot insert photo references');
select ok(not has_table_privilege('authenticated', 'public.product_artwork_photos', 'UPDATE'), 'nor update them');
select ok(not has_table_privilege('authenticated', 'public.product_artwork_photos', 'DELETE'), 'nor delete them');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_artwork_photos' and (data_type = 'bytea' or column_name ~ 'base64|blob|data')),
  'the table keeps a path and metadata only: no bytea, base64 or blob column');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_artwork_photos' and column_name ~ 'price|cost|margin'), 'and no prices');
select ok(not has_function_privilege('anon', 'public.set_product_artwork_photo(uuid,text)', 'EXECUTE'), 'anonymous cannot register a photo');
select ok(not has_function_privilege('anon', 'public.remove_product_artwork_photo(uuid)', 'EXECUTE'), 'anonymous cannot remove a photo');
select ok(not has_function_privilege('anon', 'public.get_product_artwork(uuid,uuid)', 'EXECUTE'), 'anonymous cannot read the artwork facts');
select ok(not has_function_privilege('anon', 'public.get_product_artwork_photo(uuid)', 'EXECUTE'), 'anonymous cannot read a photo reference');
select is(app_private.product_artwork_path_org('c2000000-0000-4000-8000-000000000001/x/y.png'), 'c2000000-0000-4000-8000-000000000001'::uuid, 'the organization of an object is its first folder');
select is(app_private.product_artwork_path_org('not-a-uuid/x/y.png'), null::uuid, 'a first folder that is not a uuid belongs to nobody');

-- ---------------------------------------------------------------------------------------------
-- Permisos de escritura y validaciones
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000001.png')$$, '42501', null, 'an employee (no catalog.write) cannot register a photo');
select throws_ok($$select public.remove_product_artwork_photo('c5000000-0000-4000-8000-000000000001')$$, '42501', null, 'nor remove one');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000007/c6000000-0000-4000-8000-000000000007.png')$$, '42501', 'Product was not found in this organization', 'a product of ANOTHER organization is rejected');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000003/c6000000-0000-4000-8000-000000000005.jpg')$$, '22023', 'Ruta de foto inválida', 'an object that belongs to ANOTHER product path is rejected');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', '../etc/passwd')$$, '22023', 'Ruta de foto inválida', 'a path that is not <org>/<product>/<uuid>.<ext> is rejected');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', null)$$, '22023', 'Ruta de foto inválida', 'a null path is rejected');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-0000000000ff.png')$$, '22023', 'La foto todavía no se subió', 'a photo that was never uploaded is rejected');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000003.png')$$, '22023', 'La foto tiene que ser JPG o PNG', 'an object whose REAL type is not JPG or PNG is rejected (the type comes from Storage metadata)');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000008.webp')$$, '22023', 'Ruta de foto inválida', 'a .webp path is refused (the browser converts WebP to PNG before uploading; Satori cannot render WebP)');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000004.png')$$, '22023', 'La foto pesa demasiado (máximo 5 MB)', 'an object over 5 MB is rejected (the size comes from Storage metadata)');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000002.png')$$, '22023', 'La foto todavía no se subió', 'the extension is part of the path (a .png that was uploaded as .jpg does not exist)');

-- ---------------------------------------------------------------------------------------------
-- Alta, reemplazo y baja
-- ---------------------------------------------------------------------------------------------
select is(public.get_product_artwork_photo('c5000000-0000-4000-8000-000000000001'), null::jsonb, 'a product without photo reads NULL');
select is(public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000001.png') ->> 'previousPath', null::text, 'the first photo has no previous path');
select is(public.get_product_artwork_photo('c5000000-0000-4000-8000-000000000001') ->> 'contentType', 'image/png', 'the reference stores the type Storage recorded');
select is((public.get_product_artwork_photo('c5000000-0000-4000-8000-000000000001') ->> 'sizeBytes')::integer, 120000, 'and its size');
select is(public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000001.png') ->> 'previousPath', null::text, 'registering the same photo again is idempotent (no previous path to delete)');
select is(public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000002.jpg') ->> 'previousPath', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000001.png', 'replacing returns the previous path so the server can delete that object');
select is((select count(*) from public.product_artwork_photos where product_id = 'c5000000-0000-4000-8000-000000000001'), 1::bigint, 'there is only ONE commercial photo per product');
select is(public.get_product_artwork_photo('c5000000-0000-4000-8000-000000000001') ->> 'contentType', 'image/jpeg', 'the new photo replaced the old one');
select lives_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000003/c6000000-0000-4000-8000-000000000005.jpg')$$, 'a JPG photo can be registered on another product');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento entre organizaciones
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from storage.objects where bucket_id = 'product-artwork'), 6::bigint, 'the admin of A sees the 6 objects under its own organization folder (and none of B)');
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from storage.objects where bucket_id = 'product-artwork' and name like 'c2000000-0000-4000-8000-000000000001/%'), 0::bigint, 'the admin of B cannot read A''s objects');
select is(public.get_product_artwork_photo('c5000000-0000-4000-8000-000000000001'), null::jsonb, 'nor A''s photo reference');
select is(public.get_product_artwork('c5000000-0000-4000-8000-000000000001', null), null::jsonb, 'nor the artwork facts of A''s product');
select is((select count(*) from public.product_artwork_photos), 0::bigint, 'RLS hides A''s references from B');
select throws_ok($$select public.set_product_artwork_photo('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000001.png')$$, '42501', 'Product was not found in this organization', 'B cannot register a photo on A''s product');
select throws_ok($$select public.remove_product_artwork_photo('c5000000-0000-4000-8000-000000000001')$$, '42501', 'Product was not found in this organization', 'nor remove it');
select throws_ok($$insert into storage.objects (bucket_id, name, metadata) values ('product-artwork', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-0000000000aa.png', '{"mimetype":"image/png","size":10}')$$, '42501', null, 'B cannot upload into A''s folder (Storage policy)');
select lives_ok($$insert into storage.objects (bucket_id, name, metadata) values ('product-artwork', 'c2000000-0000-4000-8000-000000000002/c5000000-0000-4000-8000-000000000007/c6000000-0000-4000-8000-0000000000bb.png', '{"mimetype":"image/png","size":10}')$$, 'but B can upload into its own folder');
select throws_ok($$insert into storage.objects (bucket_id, name, metadata) values ('product-artwork', 'otra-cosa/x.png', '{"mimetype":"image/png","size":10}')$$, '42501', null, 'a path whose first folder is not an organization is refused');

-- ---------------------------------------------------------------------------------------------
-- Hechos de la pieza (admin de A)
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table t_aw_facts(label text primary key, facts jsonb);
grant all on t_aw_facts to authenticated;
insert into t_aw_facts values
  ('mayo-central', public.get_product_artwork('c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001')),
  ('mayo-avenida', public.get_product_artwork('c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002')),
  ('mayo-global', public.get_product_artwork('c5000000-0000-4000-8000-000000000001', null)),
  ('nalga-central', public.get_product_artwork('c5000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000001')),
  ('nalga-avenida', public.get_product_artwork('c5000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000002')),
  ('nalga-global', public.get_product_artwork('c5000000-0000-4000-8000-000000000003', null)),
  ('aceite-avenida', public.get_product_artwork('c5000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002')),
  ('inactivo', public.get_product_artwork('c5000000-0000-4000-8000-000000000004', null)),
  ('sin-precio', public.get_product_artwork('c5000000-0000-4000-8000-000000000005', null)),
  ('cat-apagada', public.get_product_artwork('c5000000-0000-4000-8000-000000000006', null)),
  ('materia-prima', public.get_product_artwork('c5000000-0000-4000-8000-000000000008', null));

select is((select facts ->> 'listPriceCents' from t_aw_facts where label = 'mayo-central'), '203500', 'Central: the global price applies when the branch has none (same order as the POS)');
select is((select facts ->> 'listPriceCents' from t_aw_facts where label = 'mayo-avenida'), '220000', 'Avenida: the BRANCH price wins over the global one');
select is((select facts ->> 'listPriceCents' from t_aw_facts where label = 'mayo-global'), '203500', 'no branch: the global price');
select is((select facts ->> 'listPriceCents' from t_aw_facts where label = 'nalga-central'), '1790000', 'WEIGHT: the branch price per kg wins');
select is((select facts ->> 'listPriceCents' from t_aw_facts where label = 'nalga-avenida'), '1100000', 'WEIGHT: another branch falls back to the global price per kg');
select is((select facts ->> 'bulkMinimumUnits' from t_aw_facts where label = 'mayo-central'), '3', 'UNIT in Central: «llevando» minimum comes from the branch rule');
select is((select facts ->> 'bulkDiscountBps' from t_aw_facts where label = 'mayo-central'), '1500', 'and its discount (basis points; the TS engine does the math)');
select is((select facts -> 'bulkMinimumUnits' from t_aw_facts where label = 'mayo-avenida'), 'null'::jsonb, 'UNIT in Avenida (no branch rule): NO «llevando» is invented');
select is((select facts ->> 'bulkDiscountBps' from t_aw_facts where label = 'mayo-global'), '2000', 'no branch: the organization-wide setting (min 3)');
select is((select facts ->> 'bulkMinimumUnits' from t_aw_facts where label = 'mayo-global'), '3', 'with its minimum of 3 units');
select is((select facts -> 'bulkMinimumUnits' from t_aw_facts where label = 'nalga-central'), 'null'::jsonb, 'WEIGHT products never carry a unit rule');
select is((select jsonb_array_length(facts -> 'weightTiers') from t_aw_facts where label = 'nalga-central'), 2, 'WEIGHT in Central: global tier + Central tier (the expired one is excluded)');
select is((select jsonb_array_length(facts -> 'weightTiers') from t_aw_facts where label = 'nalga-avenida'), 1, 'WEIGHT in Avenida: only the global tier (a Central tier does not leak)');
select is((select facts ->> 'branchAddress' from t_aw_facts where label = 'mayo-central'), 'Av. Siempre Viva 742', 'the branch address is returned when configured');
select is((select facts -> 'branchAddress' from t_aw_facts where label = 'mayo-avenida'), 'null'::jsonb, 'and NULL when the branch has none (nothing is hardcoded)');
select is((select facts ->> 'branchName' from t_aw_facts where label = 'mayo-central'), 'AW Central', 'the branch name is returned');
select is((select facts ->> 'organizationName' from t_aw_facts where label = 'mayo-central'), 'AW Org', 'and the organization name');
select is((select facts #>> '{photo,contentType}' from t_aw_facts where label = 'mayo-central'), 'image/jpeg', 'the photo reference travels with the facts');
select ok((select facts #>> '{photo,storagePath}' from t_aw_facts where label = 'mayo-central') like 'c2000000-0000-4000-8000-000000000001/%', 'as a storage path (no bytes)');
select is((select facts -> 'photo' from t_aw_facts where label = 'aceite-avenida'), 'null'::jsonb, 'a product without photo has a NULL photo (the piece uses a fallback)');
select is((select facts ->> 'unavailableReason' from t_aw_facts where label = 'aceite-avenida'), 'NOT_IN_BRANCH', 'a product outside the branch assortment is NOT_IN_BRANCH');
select is((select facts ->> 'unavailableReason' from t_aw_facts where label = 'inactivo'), 'INACTIVE', 'an inactive product is INACTIVE');
select is((select facts ->> 'unavailableReason' from t_aw_facts where label = 'cat-apagada'), 'INACTIVE', 'a product of an inactive category is INACTIVE');
select is((select facts ->> 'unavailableReason' from t_aw_facts where label = 'materia-prima'), 'INACTIVE', 'a raw material is not sellable: INACTIVE');
select is((select facts ->> 'unavailableReason' from t_aw_facts where label = 'sin-precio'), 'NO_PRICE', 'price 0 means «sin precio»: NO_PRICE (never published as $0)');
select is((select (facts ->> 'available')::boolean from t_aw_facts where label = 'mayo-central'), true, 'an available product says so');
select ok(not exists (select 1 from t_aw_facts where facts::text ~* '(cost|margin|stock|sku|123456)'), 'the facts never contain cost, margin, stock or SKU');
select throws_ok($$select public.get_product_artwork('c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003')$$, '42501', 'Branch not found', 'a branch of ANOTHER organization is rejected');
select is(public.get_product_artwork('c5000000-0000-4000-8000-000000000007', null), null::jsonb, 'a product of another organization reads NULL (no leak)');
select is(public.get_product_artwork(gen_random_uuid(), null), null::jsonb, 'an unknown product reads NULL');

-- Un cambio de precio llega solo a la pieza (no hay snapshots).
reset role;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, valid_to)
values ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 210000, now() - interval '1 hour', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.get_product_artwork('c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001') ->> 'listPriceCents', '210000', 'a new branch price is read on the next call (the piece stores no price)');

-- ---------------------------------------------------------------------------------------------
-- Baja
-- ---------------------------------------------------------------------------------------------
select is(public.remove_product_artwork_photo('c5000000-0000-4000-8000-000000000001') ->> 'removedPath', 'c2000000-0000-4000-8000-000000000001/c5000000-0000-4000-8000-000000000001/c6000000-0000-4000-8000-000000000002.jpg', 'removing returns the object path so the server deletes it from Storage');
select is(public.get_product_artwork_photo('c5000000-0000-4000-8000-000000000001'), null::jsonb, 'the product has no photo afterwards');
select is(public.remove_product_artwork_photo('c5000000-0000-4000-8000-000000000001') ->> 'removedPath', null::text, 'removing again is a no-op');
reset role;
select is((select count(*) from public.audit_logs where event_type = 'PRODUCT_ARTWORK_PHOTO_SET'), 4::bigint, 'every registration is audited (3 for the mayonesa, 1 for the nalga)');
select is((select count(*) from public.audit_logs where event_type = 'PRODUCT_ARTWORK_PHOTO_REMOVED'), 1::bigint, 'and so is the removal (the no-op is not)');

select * from finish();
rollback;
