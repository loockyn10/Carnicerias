-- Mirrors Postgres migration 202609230033_product_multi_category.sql. A
-- product can belong to several categories; catalog_products.category_id
-- keeps meaning the PRINCIPAL category (unchanged — still what drives the
-- product card's color/label in the POS UI). This table is the additional
-- membership set, used only for category-tab filtering.
create table if not exists catalog_product_categories (
  product_id text not null,
  category_id text not null,
  primary key (product_id, category_id),
  foreign key (product_id) references catalog_products(id)
);
create index if not exists catalog_product_categories_category_idx on catalog_product_categories(category_id);
