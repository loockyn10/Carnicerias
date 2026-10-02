-- Mercado Pago (D-054), lado SQLite. Espejo mínimo de lo que el POS necesita para no mentir
-- después de un reinicio: qué ventas locales se declararon Mercado Pago y en qué estado de
-- verificación están. El estado AUTORITATIVO vive en el servidor (payments.verification_status,
-- escrito sólo por el backend); esta columna es un caché de lo que el servidor informó y se
-- inicia en PENDING para una venta Mercado Pago, nunca en CONFIRMED.
--
-- Aditivo: dos columnas con default sobre local_payments (mismo patrón de ALTER TABLE ADD COLUMN
-- de 004/010). Las filas históricas quedan como medio manual (provider NULL, NOT_REQUIRED).
alter table local_payments add column provider text;
alter table local_payments add column verification_status text not null default 'NOT_REQUIRED';

create index if not exists local_payments_provider_status_idx
  on local_payments(provider, verification_status) where provider is not null;
