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

`packages/database/src/database.types.ts` es exactamente lo que produce `pnpm db:types` (`supabase gen types typescript --local`); nunca se edita a mano. El generador no puede saber, sólo por el tipo SQL declarado, que un parámetro de RPC sin `default` acepta `null` con un significado propio (crear vs. editar, "sin sucursal" = global), ni que una columna de retorno detrás de un `LEFT JOIN` puede ser `null` — Postgres no tiene "not null" a nivel de parámetro/columna de retorno, así que el generador no tiene señal para agregarlo, y una edición manual del archivo generado se perdería en la próxima regeneración. Esas correcciones viven en `packages/database/src/database.rpc-null-overrides.ts` (un override por RPC, comentado con el motivo), fusionadas sobre el tipo generado en `packages/database/src/database.merged.ts` mediante un mapped type homomórfico (`{ [K in keyof Functions]: K extends keyof Overrides ? Overrides[K] : Functions[K] }`); `index.ts` exporta ese `Database` fusionado, no el generado directamente. Un `Omit<Functions, keyof Overrides> & Overrides` ingenuo se probó primero y rompió la resolución de los overloads genéricos de `SupabaseClient<Database>.rpc()` para toda la tabla de funciones (no sólo las corregidas), afectando incluso a `apps/pos`, que no tiene overrides propios — de ahí el mapped type en su lugar.

Las rutas autenticadas son dinámicas por el uso de cookies. Existe instrumentación de tiempos, `getAdminContext` se deduplica por request y varias cargas fueron paralelizadas.

Navegación: el sidebar (`components/admin-sidebar.tsx`) expone sólo las áreas principales (Inicio, Sucursales, Ventas, Stock, Desposte, Distribución, Productos, Empleados, Configuración); no hay submenús desplegables. Pantallas relacionadas que antes eran entradas separadas del sidebar (Rendiciones/Rentabilidad bajo Ventas; Stock por sucursal/Reposición bajo Stock; Precios/Promociones bajo Productos; Horas trabajadas bajo Empleados) se agrupan mediante pestañas encima del contenido, con `components/section-tabs.tsx` como patrón reusable (misma idea que `components/branch-tabs.tsx`, ya existente para el detalle de sucursal). Cada pestaña sigue siendo su ruta propia (`/admin/settlements`, `/admin/branch-stock`, etc.); no se migraron URLs. Dispositivos, Avisos y Auditoría se agrupan sin pestañas en `/admin/settings` (rutas propias sin cambios). El sidebar resuelve el grupo activo por prefijo de ruta (una entrada puede matchear varias rutas), no sólo por coincidencia exacta.

`apps/admin/vercel.json` fija la región de las funciones serverless a `gru1` (São Paulo), igual que la referencia Supabase vinculada (`sa-east-1`). Confirmado contra producción real: antes de este cambio el header `x-vercel-id` mostraba `gru1::iad1::...` (función ejecutando en Virginia, EE. UU., contra una base en São Paulo); después, `gru1::gru1::...`. Este mismatch de región era la causa dominante de la lentitud reportada (navegación y acciones 3–12× más lentas que con la función en la misma región que Supabase); ver `docs/CURRENT_STATE.md` para la medición antes/después.

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

- `product_prices`: historial del precio de lista con vigencias y alcance global/sucursal. **Es la única fuente del precio de venta**, cargado manualmente (`set_product_price`/`bulk_set_product_prices`, migración `202609220030`) — no se deriva de costo+markup (ver D-037, `docs/DECISIONS.md`).
- `product_costs`: historial de costo, alimentado automáticamente al finalizar un desposte (`complete_production_batch`, migración `202609220029`) o cargado directo (`set_product_cost`) para productos comprados ya terminados.
- `organization_cash_discounts`: historial de recargo por tarjeta (D-044, columna `cash_discount_bps` conservada por nombre), configurado vía `set_cash_discount` (sin reprecio). CASH/TRANSFER/OTHER pagan el precio cargado sin ajuste; DEBIT/CREDIT pagan ese precio más el porcentaje configurado.
- `product_pricing_settings` (markup) y el flujo `save_product_pricing`/`calculate_product_price`/`set_cash_discount_and_reprice` (D-006) quedan en la base intactos (historial) pero ninguna UI vigente los vuelve a escribir.

Los cambios generan nuevas vigencias; no sobrescriben historia. Dinero y peso usan cents y gramos enteros; porcentajes usan basis points y redondeo half-up. Los ítems de venta guardan snapshots suficientes de lista, costo, markup, recargo por tarjeta, promoción y subtotal final.

## Recargo por tarjeta (D-044)

Migración `202609240035_card_surcharge_pricing.sql` (nueva, no edita `202609230031`/`202609230034` — ver el motivo en D-044) invierte la regla anterior: `product_prices.price_cents` ya es el precio de CASH/TRANSFER/OTHER sin ajuste; DEBIT/CREDIT pagan ese precio más un recargo (`organization_cash_discounts.cash_discount_bps`, nombre físico conservado). `packages/business-logic/src/pricing.ts` centraliza la fórmula (`isCardSurchargePaymentMethod`, reemplaza `isDiscountEligiblePaymentMethod`; las tres funciones de pricing ganan `cardSurchargeCents`), replicada byte-a-byte en `complete_discounted_sale`/`sync_offline_sale` (Postgres) e `insert_sale` (Rust/SQLite) — ninguna de las tres puede aceptar un total que la otra rechazaría. `sale_items`/`local_sale_items` ganan `card_surcharge_cents` (columna nueva, `>= 0`); `cash_discount_cents` se conserva sin tocar en filas históricas pero queda siempre en 0 para una venta nueva (ya ningún medio de pago da descuento).

`PACK_FIXED_TOTAL` (D-039) queda deliberadamente invariante al medio de pago — el total fijo de un pack nunca lleva recargo, igual que nunca varía con el peso/cantidad real; sólo el remanente de un pack `UNIT` (unidades fuera del último pack completo) es una venta normal y sí lleva recargo. Bug encontrado y corregido en la misma migración: `get_pos_commercial_config` había perdido la clave `cashDiscountBps` de su jsonb en un `CREATE OR REPLACE` anterior (202609230031).

Productos legacy con precio vigente siguen vendiéndose aunque todavía no tengan costo. El dominio, pricing, analytics y venta POS contemplan `UNIT` de punta a punta (ver "Venta POS `UNIT`" más abajo), incluidos outputs de desposte por unidad.

## Promociones pack, corrección de forma de venta y multicategoría

`product_weight_discounts` (migración `202609230031`) gana `promotion_mode` (`THRESHOLD` | `PACK_FIXED_TOTAL`, ver D-039 y `docs/DOMAIN_RULES.md`). `save_weight_discount` extiende su firma con parámetros opcionales al final (mismo patrón de compatibilidad ya usado en el repo), sin tocar el camino `THRESHOLD` existente. `complete_discounted_sale`/`sync_offline_sale` ganan un camino paralelo para una línea pack (precio total fijo, no escala con el peso), validado igual online y offline; el snapshot en `sale_items`/`local_sale_items` usa una columna nueva `promotion_mode` (no se tocó el enum `weight_discount_type` existente, para no arriesgar un `ALTER TYPE ... ADD VALUE` sobre un tipo ya usado por filas reales). El POS (`apps/pos/src/App.tsx`) ofrece un toggle "Vender como pack" cuando el producto `WEIGHT` tiene un pack activo (el pack `UNIT` se aplica automáticamente, ver más abajo); Rust (`insert_sale` en `lib.rs`) re-valida la consistencia del pack contra `local_weight_discounts` antes de persistir.

`save_product` (migración `202609230032`) agrega una guarda: cambiar `unit_type` de un producto con historial operativo (ventas, stock, producción, cualquier promoción) se rechaza; sin ese historial, el cambio se permite igual que siempre (ver D-040). Nueva RPC `get_products_with_unit_type_history` le permite a `/admin/products` deshabilitar el selector por adelantado para los productos que la guarda igual rechazaría.

`product_category_assignments` (migración `202609230033`, ver D-041/D-043) agrega multicategoría sin reemplazar `products.category_id` (sigue siendo la categoría principal). `set_product_categories` reconcilia ambos atómicamente. `pull_pos_state` y `get_pos_catalog` (esta última recreada vía `DROP FUNCTION`/`CREATE FUNCTION`, ya que una función `RETURNS TABLE` no puede ganar una columna con `CREATE OR REPLACE`) agregan `categoryIds` al payload de catálogo; SQLite gana una tabla espejo `catalog_product_categories` (migración SQLite `008`) poblada por `apply_catalog_pull` con un barrido acotado al producto tocado en cada pull (no una tabla completa). El filtro de categoría del POS (`apps/pos/src/lib/catalog.ts`, con tests propios) considera todas las categorías asignadas.

**Directorio de categorías del POS** (agregado a la migración `202609230033` en la misma sesión, antes de que se aplicara ningún entorno): las tabs ya no se infieren de qué producto es principal de cada categoría. `get_pos_categories(p_branch_id)` (nuevo RPC) devuelve id/nombre/color/orden de cada categoría con al menos una asignación real (principal o secundaria); `pull_pos_state` incluye el mismo set completo bajo la clave `categories`. SQLite refleja esto en `catalog_categories` (tabla ya existente en la migración `008`, ahora poblada por `apply_catalog_pull` marcando todo inactivo y dando de alta el set fresco — nunca `DELETE`, para no romper la FK de un producto local desactivado que aún referencia una categoría vieja); `get_local_categories` (comando Tauri nuevo) la expone al frontend. `apps/pos/src/lib/catalog.ts` (`buildCategoryTabs`) construye las tabs desde este directorio en vez de derivarlas de `products`, resolviendo la limitación original de D-041 (una categoría 100%-secundaria ahora sí genera su propia tab).

Precios y Promociones (`Productos → Precios`, `Productos → Promociones`) ganaron un buscador cliente-side (sin roundtrip adicional, el dataset ya está cargado) sobre un helper de normalización compartido, `apps/admin/src/lib/text-search.ts` (extraído del que ya usaba `/admin/branch-stock`).

## Venta POS `UNIT` end-to-end (D-042)

Migración `202609230034_unit_sale_support.sql` (Postgres) y `009_unit_sale_support.sql` (SQLite), agregadas como migraciones nuevas porque son alcance genuinamente nuevo (a diferencia de las tres de arriba, que se editaron en el lugar por no estar aplicadas todavía).

`sale_items` gana `quantity_units` (columna separada de `weight_grams`, ambas nullable, `CHECK` exige exactamente una de las dos — no se reutilizó `weight_grams` porque el dominio prohíbe mezclar kg/unidades en un campo sin separar). `stock_movements.quantity_grams` sí se reutiliza como contador de unidades con signo para una venta `UNIT`, mismo precedente que `PRODUCTION_YIELD` (D-038). SQLite reconstruye `local_sales`/`local_sale_items` con el patrón de rebuild no destructivo ya usado en el repo (tabla `_new`, copia de filas existentes, `DROP`+`RENAME`) porque ambas tablas tienen historial de ventas real; el toggle de `pragma foreign_keys` se hace en Rust **fuera** de la transacción de la migración (SQLite ignora ese pragma dentro de una transacción abierta — bug real encontrado por un test de esta sesión, ver `docs/CURRENT_STATE.md`).

`complete_discounted_sale`/`sync_offline_sale` (Postgres) e `insert_sale` (Rust) ganan una rama `quantity_units` paralela a la de `weight_grams`, con la misma fórmula de pack que ya existía para `UNIT` en `packages/business-logic` (múltiplos exactos + resto a precio normal). El frontend (`apps/pos/src/App.tsx`) deja de filtrar el catálogo a sólo `WEIGHT`; un producto `UNIT` abre un stepper de cantidad (no la balanza) y reutiliza el mismo motor de precio (`computeWeightLine`/`computeUnitLine`, funciones puras que llaman a `calculateSalePricing`/`calculateUnitPackSalePricing` de `packages/business-logic`) sin duplicar la secuencia lista → descuento por pago → promoción → final.

**Compatibilidad con RPCs preexistentes**: `get_profitability_analytics`, `get_replenishment_plan`, `cancel_sale` y `get_admin_dashboard` (de sprints anteriores) ya leían `sale_items.weight_grams` asumiendo que también podía contener una cantidad `UNIT`; se reemplazaron (`CREATE OR REPLACE FUNCTION`, misma firma, dentro de la migración `202609230034`) usando `coalesce(weight_grams, quantity_units)` donde antes asumían sólo peso. Sin este fix, `cancel_sale` crashea con NOT NULL al anular una venta con línea `UNIT` — detalle en D-042.

## Desposte / Producción

`production_batches` y `production_batch_outputs` (migraciones `202609220024`/`202609220025`, extendidas en `202609220029`) registran la transformación de un insumo comprado por peso en múltiples productos de catálogo más merma. Nombres genéricos deliberadamente (no específicos de cerdo): el mismo modelo sirve para cualquier insumo. Todo output registra su peso real producido (`output_weight_grams`, siempre obligatorio); un output cuyo producto vende por unidad registra además `output_quantity_units` (ver D-038). El peso real determina la merma (`input_weight_grams - suma(output_weight_grams de todos los outputs)`), nunca el valor comercial de un output `UNIT` (ese usa cantidad × precio/unidad, independiente del peso).

Los cálculos (costo total, merma, rendimiento, valor potencial, asignación de costo por valor relativo de venta con redondeo determinístico exacto, márgenes) viven como funciones puras en `packages/business-logic/src/production.ts`, reutilizables sin Supabase; `allocateProductionCost` acepta outputs `WEIGHT` o `UNIT` indistintamente (discriminated union), ya que sólo necesita el valor de venta potencial en centavos de cada uno. El servidor implementa la misma asignación (`app_private.compute_production_preview`) tanto para la vista previa en vivo de un borrador como, sin cambios, para los valores que `complete_production_batch` congela como snapshot.

Al finalizar un lote (`DRAFT → COMPLETED`, irreversible salvo una futura reversión no implementada), se toma snapshot del precio de venta vigente de cada output (reutilizando `product_prices`) y se escribe en el ledger existente `stock_movements`: `PRODUCTION_CONSUME` (negativo, insumo completo) y `PRODUCTION_YIELD` (positivo, cada output, en gramos o en unidades según corresponda). La merma nunca es un movimiento de stock; es la diferencia aritmética reportada en `production_batches.waste_grams`. No existe un segundo modelo de inventario. Además, el costo asignado de cada output pasa a ser el costo vigente de ese producto en `product_costs` (ver D-037): el desposte alimenta el costo automáticamente, sin entrada manual.

La UI vive enteramente en Admin (`/admin/production`, patrón Server Component + Server Actions en `apps/admin/src/app/admin/actions.ts`, igual que rendiciones/stock), no en el POS: es información administrativa (costo, costo asignado, márgenes), no operativa de mostrador (ver D-031). Los permisos `production.read`/`production.write` son exclusivos del rol `admin`.

### Materias primas, sucursal productiva y Distribución

`products.inventory_role` (`RAW_MATERIAL` | `SELLABLE` | `BOTH`, default `SELLABLE`) distingue qué productos puede ofrecer el selector de insumo de un desposte de los que puede ofrecer el selector de outputs, sin un catálogo paralelo. `organizations.production_branch_id` (mismo patrón que `replenishment_target_days`: columna simple, leída directo por el cliente, escrita por una RPC dedicada, `set_production_branch`) es la sucursal donde un desposte genera stock cuando no se indica una explícitamente; normalmente Central, que sigue siendo una sucursal comercial real, no una ficticia (ver D-011, D-033). `create_production_batch`/`update_production_batch_header` ganaron parámetros (`p_branch_id` ahora opcional, `p_input_unit_count`); como Postgres identifica una función por su firma de tipos, agregar parámetros a mitad de la lista no es compatible con `CREATE OR REPLACE FUNCTION`, así que la migración `202609220026` hace `DROP FUNCTION` de las versiones anteriores y las recrea.

Distribución (`stock_transfers`/`stock_transfer_items`, migración `202609220027`) mueve stock ya producido entre sucursales de la misma organización, típicamente desde Central después de un desposte. Reutiliza `stock_movements` con `TRANSFER_OUT`/`TRANSFER_IN` — tipos que existen en el enum desde `202609100003` pero no se habían usado — sin crear un segundo modelo de inventario. `create_stock_transfer` es una única función `plpgsql`: cualquier excepción (stock insuficiente, producto inválido, sucursales iguales) revierte todo lo que esa llamada ya insertó, dándole atomicidad real de base de datos sin lógica de compensación en la aplicación. La validación de stock suficiente toma el mismo lock consultivo por `(sucursal, producto)` que usa `record_stock_operation`, antes de leer el stock disponible, para ser segura ante escrituras concurrentes. Alcance de este sprint: sólo productos `WEIGHT`, sin confirmación de recepción en dos etapas. Mismos permisos que Desposte (`stock.write`/`stock.read`), nunca otorgados a `employee`. UI en `/admin/transfers`, con un enlace "Distribuir ahora" desde un desposte `COMPLETED` que precompleta origen y líneas con sus outputs.

## Stock, reposición, rendiciones y analítica

- `stock_movements` es la fuente de verdad del stock teórico.
- Reposición combina stock, mínimo manual, ventas recientes y cobertura mediante `get_replenishment_plan`.
- El estado de stock por sucursal (`/admin`, `/admin/branches`, `/admin/stock`) se lee mediante la RPC `SECURITY DEFINER get_branch_stock_status`, que agrega directamente sobre `stock_movements` autorizando una vez por sucursal en vez de RLS fila por fila (mismo patrón que `get_replenishment_plan`). La vista `branch_stock_status` se mantiene para sus otros consumidores (atención, comparar sucursales, detalle de sucursal).
- Rendiciones son snapshots históricos inmutables; una venta offline tardía genera advertencia, no recálculo silencioso.
- Rentabilidad usa revenue final y costo snapshot; presenta ganancia bruta, no neta.
- Timekeeping conserva turnos y tarifas históricas, usa timestamp servidor online y outbox offline.

## Migraciones

PostgreSQL y SQLite se migran incrementalmente. Nunca se edita una migración ya aplicada ni se borra SQLite para actualizar una instalación.

El inventario local confirmado está en `CURRENT_STATE.md`: PostgreSQL 001–033 y SQLite 001–008. El estado remoto sigue pendiente de verificación autenticada.

## PWA y balanza

La PWA Admin no está implementada. La dirección vigente es mantener Admin web, agregar manifest/installability/service worker conservador y no cachear agresivamente ventas o stock.

Integración de balanza (KRETZ Novel Eco 2, RS232, modo transmisión continua de peso) implementada en `apps/pos/src-tauri/src/scale/` (detalle completo en `docs/SCALE_INTEGRATION.md`): comunicación serial en Rust/Tauri (crate `serialport`, sin Web Serial API), nunca en el hilo de UI. `ScaleConfig.kind` (`MANUAL` | `SIMULATED` | `KRETZ_NOVEL_ECO_2`) despacha a la implementación correspondiente; el resto del POS sólo conoce `ScaleSnapshot` (config + estado de conexión `DISCONNECTED`/`CONNECTING`/`CONNECTED`/`ERROR` + última lectura en gramos enteros), por lo que agregar un modelo nuevo no toca el flujo de venta. La balanza sólo aporta peso: precio, promociones, descuentos y snapshots siguen siendo responsabilidad exclusiva del POS. Configuración persistida como JSON en la clave `scale_config` de la tabla genérica `sync_metadata` (sin migración/tabla nueva). **REQUIERE VERIFICACIÓN**: no se conectó una Novel Eco 2 real en este sprint (ver checklist de smoke test en `docs/SCALE_INTEGRATION.md`).
