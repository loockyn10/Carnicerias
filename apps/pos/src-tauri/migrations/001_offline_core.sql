pragma foreign_keys = on;

create table if not exists schema_migrations (
  version integer primary key,
  applied_at text not null
);

create table if not exists local_device (
  singleton integer primary key check (singleton = 1),
  device_id text not null unique,
  organization_id text,
  branch_id text,
  branch_name text,
  profile_id text,
  user_email text,
  role_name text,
  device_status text not null default 'UNREGISTERED' check (device_status in ('UNREGISTERED', 'ACTIVE', 'DISABLED')),
  authorization_validated_at text,
  authorization_expires_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists catalog_categories (
  id text primary key,
  organization_id text not null,
  name text not null,
  sort_order integer not null,
  active integer not null check (active in (0, 1)),
  updated_at text not null
);

create table if not exists catalog_products (
  id text primary key,
  organization_id text not null,
  category_id text not null,
  name text not null,
  sku text,
  unit_type text not null,
  active integer not null check (active in (0, 1)),
  updated_at text not null,
  foreign key (category_id) references catalog_categories(id)
);

create table if not exists catalog_prices (
  product_id text not null,
  branch_id text not null,
  price_per_kg_cents integer not null check (price_per_kg_cents > 0),
  valid_from text not null,
  synced_at text not null,
  primary key (product_id, branch_id),
  foreign key (product_id) references catalog_products(id)
);

create table if not exists local_sales (
  id text primary key,
  organization_id text not null,
  branch_id text not null,
  profile_id text not null,
  device_id text not null,
  status text not null check (status = 'COMPLETED'),
  total_cents integer not null check (total_cents > 0),
  total_weight_grams integer not null check (total_weight_grams > 0),
  created_at text not null,
  completed_at text not null,
  synced_at text
);

create table if not exists local_sale_items (
  id text primary key,
  sale_id text not null,
  product_id text not null,
  product_name_snapshot text not null,
  weight_grams integer not null check (weight_grams > 0),
  price_per_kg_cents integer not null check (price_per_kg_cents > 0),
  subtotal_cents integer not null check (subtotal_cents > 0),
  created_at text not null,
  foreign key (sale_id) references local_sales(id)
);

create table if not exists local_payments (
  id text primary key,
  sale_id text not null,
  method text not null,
  amount_cents integer not null check (amount_cents > 0),
  created_at text not null,
  foreign key (sale_id) references local_sales(id)
);

create table if not exists local_stock_movements (
  id text primary key,
  sale_id text not null,
  organization_id text not null,
  branch_id text not null,
  product_id text not null,
  movement_type text not null check (movement_type = 'SALE'),
  quantity_grams integer not null check (quantity_grams < 0),
  profile_id text not null,
  occurred_at text not null,
  created_at text not null,
  synced_at text,
  foreign key (sale_id) references local_sales(id)
);

create table if not exists sync_outbox (
  id text primary key,
  aggregate_type text not null check (aggregate_type = 'SALE'),
  aggregate_id text not null,
  operation text not null check (operation = 'UPSERT'),
  payload text not null,
  status text not null check (status in ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at text not null,
  last_attempt_at text,
  next_attempt_at text not null,
  last_error text,
  synced_at text,
  unique (aggregate_type, aggregate_id, operation)
);

create table if not exists sync_metadata (
  key text primary key,
  value text not null,
  updated_at text not null
);

create index if not exists catalog_products_category_idx on catalog_products(category_id, active);
create index if not exists local_sales_created_idx on local_sales(created_at desc);
create index if not exists local_stock_branch_product_idx on local_stock_movements(branch_id, product_id, occurred_at);
create index if not exists sync_outbox_due_idx on sync_outbox(status, next_attempt_at, created_at);

