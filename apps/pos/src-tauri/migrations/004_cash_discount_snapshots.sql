alter table local_sale_items add column cash_discount_bps integer not null default 0;
alter table local_sale_items add column cash_discount_cents integer not null default 0;
alter table local_sale_items add column promotion_discount_cents integer not null default 0;
alter table local_sale_items add column cost_cents_snapshot integer;
alter table local_sale_items add column profit_markup_bps_snapshot integer;
update local_sale_items set promotion_discount_cents = discount_cents where discount_cents > 0;
