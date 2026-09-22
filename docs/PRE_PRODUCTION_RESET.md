# Pre-production reset

Operación de una sola vez para pasar de datos ficticios/demo a producción
real, sin recrear el proyecto Supabase. Script: `scripts/pre-production-reset.sql`.
No es una migración, no corre automáticamente, no tiene botón en Admin ni RPC
pública — se ejecuta manualmente, una vez, contra una base que ya tiene backup.

## Qué preserva

- `organizations` (la organización no se toca).
- El/los profile(s) con rol `admin` (dueño/administrador) y su membership.
- `roles`, `permissions`, `role_permissions`.
- `products`, `categories`, `product_prices` (historial de precios completo).
- `product_costs`, `product_pricing_settings`, `organization_cash_discounts`
  (configuración comercial que no depende de una sucursal específica).
- Promociones y avisos **globales** (`branch_id is null`): son configuración
  comercial, no datos de una sucursal ficticia.
- Esquema, migraciones, funciones/RPCs y RLS: el script no ejecuta DDL.

## Qué elimina

Sólo para las sucursales seleccionadas en el paso 2 del script (por defecto,
**todas** las sucursales de la organización — el escenario para el que se
escribió este script es "ninguna sucursal actual es real todavía"):

- `sales`, `sale_items`, `payments`, `stock_movements`.
- `stock_operations` y `stock_operation_items` (compras/mermas/ajustes).
- `settlements` (rendiciones).
- `employee_shifts`, `employee_time_events`, `employee_hourly_rates` de los
  empleados eliminados.
- `pos_devices` y `pos_sync_receipts` de esas sucursales.
- `production_batches` (y sus `production_batch_outputs`, por cascada).
- `stock_transfers` con origen o destino en esas sucursales (y sus
  `stock_transfer_items`, por cascada).
- `announcements` y `product_weight_discounts` **con `branch_id` de una de
  esas sucursales** (ver "Promociones y avisos" más abajo).
- `branch_product_stock_settings` (mínimos/objetivos de stock por sucursal).
- Ruido de auditoría (`audit_logs`) generado por esas sucursales/empleados.
- Perfiles de empleados internos de POS (`organization_members.role = 'employee'`).
  Nunca un perfil con rol `admin`.
- Las sucursales seleccionadas.

## Promociones y avisos: por qué se borran los que son de una sucursal

`product_weight_discounts.branch_id` y `announcements.branch_id` tienen
`foreign key ... references branches(id, organization_id) on delete restrict`.
Eso significa que si una promoción o un aviso sigue apuntando a una sucursal
ficticia, Postgres **no permite borrar esa sucursal** hasta que se resuelva.
Como la sucursal en sí es ficticia, una promoción o aviso configurado
específicamente para ella también lo es, y se elimina junto con la sucursal.

Las promociones y avisos **globales** (`branch_id is null`, es decir, válidos
para toda la organización) no dependen de ninguna sucursal ficticia y el
script no los toca.

## Precios: por qué el script puede abortar

`product_prices.branch_id` tiene la misma restricción (`on delete restrict`).
Los precios son datos protegidos explícitamente (CLAUDE.md, `DOMAIN_RULES.md`)
y este script **nunca los borra silenciosamente**: si detecta un precio
específico de una sucursal que está por eliminarse, aborta toda la
transacción con un mensaje claro. Si eso pasa, hay que decidir manualmente
(cerrar la vigencia de ese precio, o excluir esa sucursal del paso 2 del
script) antes de volver a correrlo.

## Cómo ejecutarlo

### 1. Backup

Antes de correr esto contra Supabase remoto **tiene que existir un
backup/export**. Opciones (elegir una):

```bash
# Dump completo del schema public vía la connection string de Supabase
# (Project Settings → Database → Connection string).
pg_dump "postgresql://postgres:<password>@<host>:5432/postgres" \
  --schema=public --no-owner --format=custom \
  --file="carnicerias-backup-$(date +%Y%m%d-%H%M).dump"
```

O, desde el dashboard de Supabase: **Database → Backups** (si el plan lo
incluye) y confirmar que existe un snapshot reciente antes de continuar.

### 2. Revisar / ajustar el script

Abrir `scripts/pre-production-reset.sql`:

- Paso 1: si hay más de una organización, editar la query para apuntar a una
  explícitamente (el script aborta si encuentra más de una).
- Paso 2: por defecto toma **todas** las sucursales de la organización. Si ya
  existe una sucursal real que hay que conservar, agregar una condición
  (ejemplo comentado en el script).

### 3. Dry-run / check (recomendado)

El paso 5 del script (`raise notice`) imprime los conteos exactos que va a
borrar **antes** de borrar nada. Para verlo sin comprometerse a nada, se
puede correr todo el script salvo el `commit;` final y hacer `rollback;` en
su lugar:

```sql
SET app.confirm_pre_production_reset = 'YES-DELETE-TEST-DATA';
BEGIN; -- iniciar una transacción propia, fuera del begin/commit del script
\i scripts/pre-production-reset.sql
-- revisar los `NOTICE` con los conteos y la verificación final
ROLLBACK; -- deshace todo, incluido el commit interno del script
```

Nota: el `commit;` que trae el propio script confirma su transacción interna
igual; envolverlo en un `BEGIN;`/`ROLLBACK;` exterior no lo revierte en
Postgres (el `commit;` interno ya persistió los cambios). Para un dry-run real
sin persistir nada, comentar temporalmente la línea `commit;` final del
script y reemplazarla por `rollback;` en una copia local antes de correrlo, o
correrlo primero contra `supabase start` (entorno local) y revisar el
resultado ahí antes de tocar el remoto.

### 4. Ejecutar (irreversible salvo por el backup del paso 1)

```bash
psql "postgresql://postgres:<password>@<host>:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -c "SET app.confirm_pre_production_reset = 'YES-DELETE-TEST-DATA';" \
  -f scripts/pre-production-reset.sql
```

O pegando el contenido completo del archivo en el SQL Editor de Supabase,
después de ejecutar la línea `SET app.confirm_pre_production_reset = ...` en
la misma sesión/pestaña.

Si algo falla (el chequeo de precios, la verificación final, o cualquier
error), la transacción completa hace rollback — no queda un estado
intermedio.

### 5. Verificar que quedó limpio

El propio script verifica al final (paso 7) y aborta si algo no cierra. Para
confirmarlo manualmente después:

```sql
select count(*) from public.branches;            -- 0
select count(*) from public.sales;                -- 0
select count(*) from public.payments;              -- 0
select count(*) from public.stock_movements;        -- 0
select count(*) from public.settlements;            -- 0
select count(*) from public.employee_shifts;         -- 0
select count(*) from public.pos_devices;             -- 0

select count(*) from public.organizations;           -- 1 (o el número real)
select count(*) from public.products;                 -- sin cambios
select count(*) from public.product_prices;            -- sin cambios
select count(*)
from public.organization_members om join public.roles r on r.id = om.role_id
where r.key = 'admin';                                   -- >= 1
```

## Después del reset: crear las sucursales reales

Desde Admin → **Sucursales** → **+ Nueva sucursal**: nombre, código y
dirección opcional. No hace falta duplicar catálogo, precios ni promociones
globales — ya se aplican a cualquier sucursal nueva automáticamente.

Después, autorizar cada caja real a su sucursal con el flujo de dispositivos
existente (`/admin/devices`), sin cambios respecto al flujo actual.

## Gestión de sucursales (Admin → Sucursales)

Implementada en la migración `202609220028_branch_management.sql`
(RPCs `save_branch`, `set_branch_active`, `delete_branch`; la tabla
`branches` ya tenía permiso `branches.write` y policies de insert/update
desde `202609100001`, sólo nunca se habían usado). UI en la ruta actual
`/admin/branches` (no existe todavía un sprint de navegación con
`Configuración`, así que queda ahí, lista para moverse cuando ese sprint
exista):

- **Crear**: `/admin/branches/new`. Requiere nombre, código único por
  organización (`^[A-Z0-9][A-Z0-9_-]{1,19}$`, se normaliza a mayúsculas) y
  dirección opcional. No crea stock, dispositivos ni productos — el catálogo
  compartido ya aplica.
- **Editar**: dentro del detalle de la sucursal (pestaña "Otros"), mismo
  formulario reutilizado con los datos actuales.
- **Activar/Desactivar**: botón dedicado, llama a `set_branch_active`. No
  borra nada; la sucursal desaparece del flujo operativo normal pero conserva
  todo su historial. Es la única opción para una sucursal con historial real.
- **Eliminar (hard delete)**: sólo permitido si la sucursal nunca tuvo
  ventas, stock, turnos, dispositivos, rendiciones, desnostes, transferencias,
  auditoría o precios propios — `delete_branch` cuenta esas tablas
  explícitamente y rechaza el borrado con un mensaje claro si encuentra
  cualquier fila, indicando desactivar en su lugar. Pensado para corregir una
  sucursal creada por error, no para operación normal.

Ver D-035 en `docs/DECISIONS.md`.
