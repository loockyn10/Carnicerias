# Architecture

## Vista general

```text
Admin Web (Next.js 15 / React 19)
  ↓ cliente Supabase sujeto a RLS
Supabase Auth + PostgreSQL
  ↕ pull/push idempotente
POS Windows (Tauri 2 + React/Vite)
  ↕ comandos Rust tipados
SQLite local
```

El monorepo pnpm contiene `apps/admin`, `apps/pos` y los paquetes compartidos `business-logic`, `database`, `sync`, `types` y `ui`.

- Las apps componen flujos y presentación.
- `business-logic` contiene reglas puras y no depende de React, Supabase, SQLite ni Tauri.
- `database` contiene cliente RLS-bound y tipos del esquema; no contiene credenciales `service_role`.
- `sync` define contratos y transformación del intercambio POS.
- La persistencia SQLite vive detrás de comandos Rust en el POS.

## Admin

El Admin es Next.js/TypeScript, online-first y se despliega como web. Usa Supabase Auth, memberships, roles, permisos y RLS. No introducir SQLite administrativo ni `service_role` en el cliente.

Las rutas autenticadas son dinámicas por el uso de cookies. Existe instrumentación de tiempos, `getAdminContext` se deduplica por request y varias cargas fueron paralelizadas. Falta un baseline autenticado de producción antes de optimizar nuevamente.

La configuración concreta de proyecto/región Vercel está fuera del repositorio. La referencia Supabase vinculada apunta a `sa-east-1`; toda comparación de regiones requiere consultar el dashboard de Vercel.

## POS offline-first

El dispositivo se enrola en una organización y sucursal inmutables. La sucursal operativa no cambia al cambiar empleado. El selector manual de sucursal sólo puede usarse para desarrollo, setup o simulación, no como flujo productivo normal.

La distribución Windows se genera como instalador NSIS x64 mediante `pnpm build:pos:desktop`. Debian 12 i386 se distribuye como `.deb` mediante `pnpm build:pos:linux:i386` (detalle en `docs/LINUX_POS.md`); mismo código, mismo identificador `com.carnicerias.pos`, sólo cambia target de compilación y empaquetado. El bundle contiene la aplicación y sus recursos estáticos, pero no el archivo SQLite: cada equipo crea y migra su base dentro del directorio de datos de la plataforma (`appData` en Windows, XDG data dir en Linux) usando el identificador estable `com.carnicerias.pos`, separado del directorio reemplazado por futuras instalaciones.

Una venta se confirma primero en una transacción SQLite que persiste venta, ítems, pago, movimientos y evento outbox con UUID generados por el cliente. El push posterior usa recibos e identificadores estables para garantizar idempotencia. Los estados del outbox son `PENDING`, `SYNCING`, `SYNCED` y `FAILED`, con recuperación tras reinicio y backoff exponencial.

El pull de catálogo usa cursor monotónico y `removedProductIds`. Configuración comercial y roster se sincronizan como snapshots completos. Después de sincronizar, el POS conserva catálogo, promociones, avisos, descuento por pago, autorización y operación offline dentro de sus vigencias.

Supabase Auth es la identidad técnica usada para aprovisionar y sincronizar el dispositivo, no la identidad del operador. La sesión técnica persistida y la autorización cacheada en SQLite permiten iniciar en el selector local; si no existe una credencial válida, la vista normal sólo informa que la caja requiere configuración. El formulario de Auth queda detrás de una acción administrativa explícita para aprovisionamiento o recuperación.

La sincronización se dispara al iniciar, después de mutaciones locales, al recuperar conexión y por retry/backoff. Un polling preventivo de 60 segundos actualiza catálogo, configuración y roster; el refresco visual de duración de turno tiene su propio timer de 60 segundos y no reinstala ni ejecuta el scheduler de sync.

La sesión/autorización del dispositivo puede persistir. Después de reiniciar debe exigirse nuevamente selección de operador y PIN; no se restaura automáticamente el operador activo.

Después del PIN se recupera el turno local/remoto y, si falta, el fichaje de entrada bloquea el uso normal. `Salir` y el cierre normal de la ventana usan una operación SQLite idempotente que cierra el turno, agrega el evento `SHIFT` al outbox y limpia el operador activo antes de intentar red. La sincronización puede ser best-effort durante el cierre; nunca es condición para terminar la aplicación.

## Identidad de operador

Arquitectura objetivo:

1. dispositivo autorizado;
2. empleado interno autorizado para una o varias sucursales;
3. operador activo autenticado con PIN.

El empleado POS normal no requiere cuenta Supabase Auth individual. `profiles` conserva la identidad operativa y sus UUID históricos; `auth_user_id` es un vínculo opcional para identidades que sí acceden mediante Supabase Auth. El Admin web continúa usando Auth y crea empleados internos mediante RPCs transaccionales sin credenciales administrativas en el cliente.

`branch_members` conserva una o varias asignaciones por empleado. Desactivar una membresía revoca los grants vigentes y la excluye del roster, pero no elimina el perfil, las asignaciones ni las referencias históricas. El contrato POS/SQLite continúa usando el mismo `profileId`, por lo que el desacople no requiere migración local ni altera eventos outbox existentes.

## Seguridad del operador

- PIN servidor: bcrypt mediante `pgcrypto`.
- Verifier offline: Argon2 con salt; no se persiste PIN plaintext.
- Rate limit: cinco fallos y bloqueo temporal de cinco minutos.
- Grants ligados a dispositivo, sucursal y empleado, con hash servidor y vencimiento.
- Desactivar un empleado lo retira del roster y revoca grants activos.
- Ventas, stock y turnos conservan la identidad del operador.

## Tenencia y autorización

`organizations` es la raíz de tenencia. Las entidades operativas llevan `organization_id`, y las relaciones relevantes impiden asociaciones cruzadas entre organizaciones.

Los roles son filas, los permisos son capacidades y `role_permissions` los vincula. Los helpers internos de RLS usan funciones pequeñas `STABLE SECURITY DEFINER` con `search_path` controlado para evitar recursión. RLS, tenant filtering y permisos backend son obligatorios; no se reemplazan con controles visuales.

## Precio e historia

- `product_costs`: historial de costo.
- `product_pricing_settings`: historial de markup.
- `organization_cash_discounts`: historial de descuento por medio elegible.
- `product_prices`: historial del precio de lista con vigencias y alcance global/sucursal.

Los cambios generan nuevas vigencias; no sobrescriben historia. Dinero y peso usan cents y gramos enteros; porcentajes usan basis points y redondeo half-up. Los ítems de venta guardan snapshots suficientes de lista, costo, markup, descuento por pago, promoción y subtotal final.

Productos legacy con precio vigente siguen vendiéndose aunque todavía no tengan costo/markup. El dominio, pricing y analytics contemplan `UNIT`, pero la venta POS completa actualmente sólo soporta `WEIGHT`.

## Stock, reposición, rendiciones y analítica

- `stock_movements` es la fuente de verdad del stock teórico.
- Reposición combina stock, mínimo manual, ventas recientes y cobertura mediante `get_replenishment_plan`.
- El estado de stock por sucursal (`/admin`, `/admin/branches`, `/admin/stock`) se lee mediante la RPC `SECURITY DEFINER get_branch_stock_status`, que agrega directamente sobre `stock_movements` autorizando una vez por sucursal en vez de RLS fila por fila (mismo patrón que `get_replenishment_plan`). La vista `branch_stock_status` se mantiene para sus otros consumidores (atención, comparar sucursales, detalle de sucursal).
- Rendiciones son snapshots históricos inmutables; una venta offline tardía genera advertencia, no recálculo silencioso.
- Rentabilidad usa revenue final y costo snapshot; presenta ganancia bruta, no neta.
- Timekeeping conserva turnos y tarifas históricas, usa timestamp servidor online y outbox offline.

## Migraciones

PostgreSQL y SQLite se migran incrementalmente. Nunca se edita una migración ya aplicada ni se borra SQLite para actualizar una instalación.

El inventario local confirmado está en `CURRENT_STATE.md`: PostgreSQL 001–022 y SQLite 001–006. El estado remoto sigue pendiente de verificación autenticada.

## PWA y balanza

La PWA Admin no está implementada. La dirección vigente es mantener Admin web, agregar manifest/installability/service worker conservador y no cachear agresivamente ventas o stock.

No existen todavía `ScaleAdapter`, adaptadores manual/simulado/serial ni integración Kretz. La futura frontera de hardware debe quedar detrás de un adapter del POS/Tauri y no acoplarse a componentes React ni a un modelo específico.
