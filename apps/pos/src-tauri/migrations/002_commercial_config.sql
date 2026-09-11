create table if not exists local_weight_discounts (
  id text primary key, product_id text not null, branch_id text, minimum_grams integer not null,
  discount_type text not null, discount_value integer not null, active integer not null default 1
);
create index if not exists local_weight_discounts_product_idx on local_weight_discounts(product_id, minimum_grams desc);
create table if not exists local_announcements (
  id text primary key, title text not null, message text not null, type text not null, priority integer not null, branch_id text
);
