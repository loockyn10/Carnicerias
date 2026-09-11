alter table local_sale_items add column original_price_per_kg_cents integer;
alter table local_sale_items add column discount_rule_id text;
alter table local_sale_items add column discount_type text;
alter table local_sale_items add column discount_value integer;
alter table local_sale_items add column discount_cents integer not null default 0;
update local_sale_items set original_price_per_kg_cents = price_per_kg_cents where original_price_per_kg_cents is null;
