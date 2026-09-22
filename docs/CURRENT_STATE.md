# Current State

Estado verificado contra el repositorio el 22 de septiembre de 2026. Las decisiones normativas viven en `PRODUCT.md`, `DOMAIN_RULES.md` y `DECISIONS.md`.

## Núcleo confirmado

- Monorepo pnpm con Admin Next.js, POS React/Vite/Tauri y paquetes compartidos.
- Supabase Auth/PostgreSQL con organizaciones, sucursales, perfiles, memberships, roles, permisos y RLS.
- Catálogo, categorías, historial de precios, historial de costos y configuración comercial.
- Ventas, ítems, pagos y stock ledger con operaciones transaccionales.
- POS offline-first con SQLite incremental, outbox, pull/push, retry, restart e idempotencia.
- Distribución Windows NSIS x64 habilitada; el instalador no incluye la SQLite local de desarrollo.
- Distribución Debian 12 i386 (`.deb`) implementada mediante `pnpm build:pos:linux:i386` (ver `docs/LINUX_POS.md`); pipeline reproducible, `REQUIERE VERIFICACIÓN EN HARDWARE REAL` antes de considerarla validada.
- Admin para operación multisucursal, ventas, stock, reposición, productos, promociones, avisos, empleados, dispositivos, rendiciones, timekeeping, analítica y auditoría.
- Admin `/admin/branch-stock` ("Stock por sucursal"): matriz de consulta producto × sucursal, búsqueda por nombre/SKU tolerante a acentos, filtro por categoría, sin escribir stock (sólo lectura). Reutiliza `get_replenishment_plan` (no crea RPC ni fuente de stock nueva); no incluye la Central (ver D-011).

## Contradicciones vigentes

### Soporte `UNIT` incompleto en POS

El dominio, pricing, snapshots y analytics contemplan `UNIT`. El catálogo operativo del POS y los RPC de venta actualmente trabajan sólo con `WEIGHT`, gramos y precio/kg.

Estado: **soporte parcial confirmado; no prioritario salvo necesidad comercial**.

### Bug preexistente en `/admin/stock` (Operaciones de stock)

La tabla de esa pantalla compara `row.stock_status === "CRITICAL" | "LOW"`, pero la vista `branch_stock_status` devuelve `'DISCONTINUED' | 'OUT_OF_STOCK' | 'LOW_STOCK' | 'AVAILABLE'` desde `202609100008_commercial_configuration.sql`. Resultado: la columna "Estado" de esa tabla siempre muestra "NORMAL", incluso sin stock. Es un bug técnico, no una decisión de producto; no se corrigió en este sprint por estar fuera de alcance (la nueva pantalla `/admin/branch-stock` no reutiliza esa comparación, usa `stockPriority` de `lib/multibranch.ts`).

## Empleados, operador y sucursal

- Los empleados POS se crean desde Admin como perfiles internos sin cuenta Supabase Auth, con nombre, PIN, tarifa inicial, estado y una o varias sucursales en una transacción.
- `profiles.auth_user_id` es opcional; los UUID existentes se preservan y una baja de Auth sólo desvincula la cuenta, sin borrar la identidad ni su historia.
- Los operadores históricos que ya tenían Auth siguen siendo compatibles. La asociación por email se conserva para accesos administrativos existentes.
- El dispositivo POS queda ligado a una organización y sucursal; cambiar operador no cambia sucursal.
- El roster incluye perfiles y memberships activos autorizados para esa sucursal.
- PIN servidor con bcrypt mediante `pgcrypto`.
- Verifier offline Argon2 con salt; no existe PIN plaintext persistido.
- Cinco fallos generan bloqueo de cinco minutos.
- Los grants se ligan a dispositivo, sucursal y empleado, tienen vencimiento y se revocan al desactivar al empleado.
- La desactivación conserva ventas, turnos y auditoría; no existe hard-delete en Admin.
- El roster, PIN, grants y branch isolation aceptan identidades internas usando el mismo `profileId`; SQLite y el outbox no requieren cambios.
- Ventas y movimientos quedan atribuidos al operador seleccionado.
- Después de reiniciar, la sesión/autorización del dispositivo puede persistir, pero debe seleccionarse operador e ingresar PIN nuevamente.
- La pantalla diaria no solicita email ni contraseña: sin autorización técnica válida muestra el aviso de configuración y el formulario Supabase sólo se revela mediante la acción administrativa explícita.
- No existe una operación explícita para eliminar/resetear el PIN sin reemplazarlo.

## Timekeeping

- Clock-in/out online con timestamp autoritativo del servidor.
- Registro offline mediante SQLite y outbox `SHIFT`.
- Un solo turno abierto por organización/empleado, protegido también por lock transaccional.
- Turnos vencidos no se autocorrigen: pasan a `REQUIRES_REVIEW`.
- Máximo organizacional configurable, default 12 horas.
- Corrección Admin con motivo obligatorio y auditoría.
- Tarifas por hora con rangos históricos; el reporte divide períodos según la tarifa vigente.
- El turno abierto persiste después de reiniciar y se recupera cuando el operador vuelve a autenticarse.
- Después del PIN, si no existe turno se exige marcar entrada antes de usar el POS.
- El header presenta una sola ficha del operador y `Salir` vuelve al selector sin cerrar Auth del dispositivo.
- `Salir` y el cierre normal de la ventana persisten un clock-out local/outbox idempotente antes de intentar sincronizar; repetir el cierre no duplica el evento.
- El auto-clock-out exige que el operador haya validado PIN en el proceso actual; una fila local residual después de un crash no genera una salida al cerrar antes de reautenticarse.
- La duración visible usa precisión de minutos y un refresco aislado de 60 segundos; ese estado no participa de las dependencias del sync.

Limitación conocida no prioritaria: un clock-out offline fuera de límite deja el turno en revisión, pero el intento/timestamp rechazado no se conserva como evidencia independiente.

Limitación de plataforma: la versión TAO usada por Tauri no procesa actualmente `WM_QUERYENDSESSION` en Windows. El cierre normal de la ventana está cubierto, pero shutdown, kill forzado, crash o corte eléctrico no garantizan ejecutar el handler; esos turnos permanecen abiertos y siguen el flujo `REQUIRES_REVIEW` sin inventar una salida.

## Pricing, pagos y promociones

- Costos, markup, descuento organizacional y precios de lista conservan vigencias históricas.
- Cálculos con cents enteros, basis points y redondeo half-up.
- Gross-up verificado: costo $10.000 + 30% y descuento 10% produce lista $14.444,44 y efectivo $13.000.
- Elegibilidad consistente en backend/POS/sync: `CASH`, `TRANSFER`, `OTHER` aplican; `DEBIT`, `CREDIT` no.
- Promociones `PERCENTAGE` y `FIXED_PRICE_PER_KG` se aplican después del descuento por pago.
- Los ítems guardan snapshots separados de lista, costo, markup, descuento por pago, promoción y subtotal final.
- Productos legacy con precio vigente continúan vendiéndose sin inventar costo histórico.

## Stock y reposición

- `stock_movements` es la fuente de verdad del stock teórico.
- Recepciones, mermas, ajustes, ventas y devoluciones quedan en el ledger.
- Las cancelaciones compensan con `RETURN`; no eliminan historia.
- `get_replenishment_plan` usa ventas completadas de una ventana de 7 días, stock actual, mínimo/objetivo manual y cobertura objetivo organizacional, default 3 días.
- Prioridad crítica: stock <= 0 o cobertura <1 día.
- Prioridad alta: cobertura <2 días o stock debajo del mínimo.
- La vista “Carga de hoy” y “Registrar ingreso” reutilizan el flujo de stock existente.

Limitación pendiente de evidencia real: productos con sólo 1–2 días de historia se dividen por los 7 días completos y pueden subestimar demanda.

## Rendiciones

- Ruta y modelo implementados con períodos `[inicio, fin)`, snapshots, desglose por pago, empleados y dispositivos.
- Efectivo esperado = pagos `CASH` exclusivamente.
- Se conserva efectivo recibido, diferencia, historial y auditoría.
- Sólo la rendición más reciente puede anularse.
- Una venta offline tardía no recalcula una rendición confirmada; se muestra una advertencia de movimientos posteriores. Este comportamiento queda aceptado como vigente.

## Analítica y rentabilidad

- Revenue = subtotal final de ventas completadas.
- Costos siempre desde snapshot histórico, nunca desde costo actual.
- Ganancia bruta = revenue - costo; rentabilidad calculada sobre costo.
- Ganancia por kg o unidad, rankings, filtros, períodos y comparación con período anterior.
- Ventas legacy sin costo participan en facturación, pero se excluyen de rentabilidad y reducen la cobertura informada.
- La UI usa “Ganancia bruta”, no “Ganancia neta”.

## POS offline y UX

- UUID cliente para venta, ítems, pagos, movimientos y eventos.
- Persistencia local atómica antes de cualquier red.
- Outbox `PENDING → SYNCING → SYNCED/FAILED`, reintentos y recuperación tras restart.
- Idempotencia remota mediante recibos e IDs estables; repetir el mismo evento no duplica ventas.
- Pull incremental de catálogo con cursor y `removedProductIds`.
- Configuración comercial y roster como snapshots completos, disponibles offline tras sincronizar.
- Reconexión automática sin eliminar eventos pendientes.
- Sync al iniciar, después de mutaciones locales, al reconectar y según retry/backoff; polling preventivo de catálogo/configuración/roster cada 60 segundos.
- El estado `SINCRONIZANDO` sólo se publica cuando existe outbox vencido con trabajo real; un ciclo vacío permanece `SINCRONIZADO` y el badge reserva ancho estable.
- Ticket fijo, footer visible, scroll interno de catálogo/ticket y cards compactas mediante filas de tamaño intrínseco.
- Colores de categoría configurables, sincronizados a SQLite y con fallback.
- Layout operativo compacto para baja altura: header de una línea (48 px), catálogo/ticket horizontal desde 900 px de ancho y ≤700 px de alto (breakpoint por viewport, no por plataforma), proporción fluida, footer del ticket fijo (TOTAL + Confirmar venta siempre visibles) y modales con scroll interno. Cards de producto en grilla densa (`auto-fill`, ~115 px) en modo compacto. Avisos operativos (`announcements`) viven detrás de una campana 🔔 con badge en el header en vez de ocupar franja permanente; las confirmaciones transitorias (venta registrada, fichaje, etc.) son un toast que se autodescarta a los ~1.8 s sin bloquear la operación. Errores siguen mostrándose como banner persistente. Validado sin scroll global a 1024×600; también 1366×768 y 1920×1080 mantienen el layout espacioso original (breakpoint no aplica por altura >700 px).

## Performance Admin

Ya existen:

- instrumentación de tiempos por ruta (ahora también en `/admin/products` y `/admin/employees`);
- cache por request de `getAdminContext`, y desde el sprint 2026-09-16 resuelto en **una sola query** (embedded select `organization_members → roles/organizations`) en vez de auth + membership + role/org secuenciales;
- paralelización de varias consultas;
- reducción de `select("*")`;
- selecciones de columnas más acotadas.

Las rutas siguen siendo dinámicas por cookies/sesión (Next 15 sin `staleTimes` configurado: cada navegación re-ejecuta el layout y vuelve a resolver `getAdminContext`). El sidebar desactiva prefetch. El bundle no muestra librerías pesadas (charts/iconos) que justifiquen `dynamic import`; el First Load JS de todas las rutas ronda 103–110 kB.

### Cuello de botella `branch_stock_status` / RLS por fila — resuelto 2026-09-16

Medido localmente (Supabase local, ~60 días de ventas sintéticas, 2 sucursales, ~2.050–2.080 filas en `stock_movements`): la vista `branch_stock_status` (usada sin RPC en `/admin`, `/admin/branches` y `/admin/stock`) tardaba **1.1–2.2 s** por request. `EXPLAIN ANALYZE` mostró que el costo era casi todo `Filter` sobre un `Seq Scan` de `stock_movements`, evaluando `app_private.can_access_branch(...)` **una vez por fila del ledger completo** (≈2.050 evaluaciones) antes del `GROUP BY`.

Se agregó `public.get_branch_stock_status(p_branch_id uuid default null)` (migración `202609160023_get_branch_stock_status.sql`), RPC `SECURITY DEFINER` que sigue el mismo patrón que `get_replenishment_plan`: valida `app_private.require_permission('stock.read')` una vez, agrega directamente sobre `stock_movements`/`stock_levels` (la función es dueña `postgres`, con `BYPASSRLS`, igual que el resto de las RPC administrativas) y aplica `app_private.can_access_branch(...)` sólo contra `branches` (2 filas en el caso medido, no miles). Confirmado con `EXPLAIN ANALYZE` equivalente: la evaluación de autorización pasó de ~2.050 llamadas a 2. Tiempo de query medido: **1.485 s → 2.8 ms** (consulta SQL directa) y **8.3 ms** vía la función completa.

`/admin`, `/admin/branches` y `/admin/stock` migraron a la RPC. `branch_stock_status` (la vista) **no se eliminó**: `/admin/attention`, `/admin/branches/compare` y `components/branch-detail.tsx` (usado por `/admin/branches/[id]` y su modal) siguen leyéndola directamente y quedaron fuera de este cambio.

`stock_movements` sigue siendo la única fuente de verdad remota del stock; no se creó balance materializado ni tabla de stock corriente. RLS de las tablas base no cambió — la RPC reemplaza la evaluación por-fila por una validación explícita equivalente (documentada en el comentario de la migración): sólo el rol `admin` (que tiene todos los permisos, incluido `branches.read_all`) llega hoy a estas pantallas, así que el resultado es idéntico al de la vista para el único consumidor real; para un rol futuro más restringido la RPC es más estricta que la vista, no más débil (la vista nunca exigió `stock.read` en su propio chequeo de `branches`, sólo en `stock_movements`).

Tests: `supabase/tests/branch_stock_status_rpc.test.sql` (28 tests pgTAP: hardening de la función, stock positivo/cero/negativo sin clamping, producto sin movimientos, UNIT excluido, aislamiento entre organizaciones incluso pasando el `branch_id` de otra org, empleado sin acceso a una sucursal, sucursal inexistente, usuario sin membership, anónimo, y equivalencia byte-a-byte contra la vista vieja).

**Hallazgo colateral (no corregido, fuera de alcance):** al tipar el retorno de la RPC con el union real de `stock_status`, TypeScript marcó como comparación imposible el bug ya documentado de `/admin/stock` (compara contra `"CRITICAL"`/`"LOW"`, que nunca ocurren). Se mantuvo el tipo de retorno como `string` (igual que la vista) para no forzar ese fix fuera de alcance dentro de este sprint; la columna "Estado" de esa tabla sigue mostrando "NORMAL" siempre, sin cambios de comportamiento.

**Hallazgo colateral (no corregido, fuera de alcance):** al validar con `pnpm db:reset && pnpm db:test` (primera ejecución real del suite pgTAP contra Postgres — antes no se pudo correr por falta de Docker) aparecieron fallos preexistentes no relacionados: `internal_pos_employees.test.sql` aborta por `permission denied for table users`; `online_pos.test.sql` y `operational_pilot.test.sql` fallan en tests que esperan que `authenticated` NO pueda insertar directamente en `sales`/`sale_items`/`payments`/`stock_movements`, y en un error `40001: Product price changed` dentro de `complete_discounted_sale`. Se confirmó que reproducen idénticos con y sin la migración de este sprint (probado quitando y volviendo a poner el archivo nuevo). Quedan fuera de alcance de este sprint de performance; task de seguimiento creada.

Falta además un baseline autenticado real de producción (Vercel) y la región de Vercel no está versionada en el repositorio. No agregar índices ni caché larga sin medición.

## No implementado

- PWA Admin: sin manifest, iconos, service worker ni installability formal.
- Venta POS completa de productos `UNIT`.

## Balanza (KRETZ Novel Eco 2) — implementada 2026-09-16, smoke físico pendiente

`apps/pos/src-tauri/src/scale/` (Rust/Tauri, no Web Serial API): `parser.rs`
reensambla y parsea el protocolo documentado (STX + peso ASCII en kg + CR,
transmisión continua) a gramos enteros, puro y testeado sin hardware.
`mod.rs` mantiene `ScaleRuntimeState` con ciclo de vida
`DISCONNECTED → CONNECTING → CONNECTED/ERROR`, lee el puerto en un thread
dedicado (timeout 300 ms, nunca bloquea Tauri/React) y emite `scale://update`
al frontend (~2/s, igual que la transmisión real). `ScaleConfig.kind`
(`MANUAL` | `SIMULATED` | `KRETZ_NOVEL_ECO_2`) es la frontera de extensión:
agregar otro modelo es un nuevo `match` arm ahí, no un rediseño del flujo de
venta.

Crate elegida: `serialport = { version = "4", default-features = false }`
(Windows COM* + Linux `/dev/ttyUSB*`/`/dev/ttyS*`, incluye
`i686-unknown-linux-gnu`). `default-features = false` evita el backend
`libudev` de Linux; sin él, la enumeración de puertos usa el fallback de
`serialport` que recorre `/sys/class/tty` sin depender de `libudev-dev`
(no está en `apps/pos/src-tauri/linux/Dockerfile` y no se agregó). Detalle
completo, incluidos parámetros RS232 fijos del Kretz (9600 8N2), permisos
`dialout` en Linux y pasos de smoke test en `docs/SCALE_INTEGRATION.md`.

Configuración persistida sin migración/tabla nueva: JSON en la clave
`scale_config` de la tabla genérica `sync_metadata` (ya existente desde
`001_offline_core.sql`).

Integración con la venta: dentro del modal existente de ingreso de peso, si
hay una balanza no-manual configurada y con lectura vigente (TTL 4 s,
`isScaleReadingFresh` en `packages/business-logic/src/scale.ts`), aparece un
botón "Usar este peso" que copia el peso a gramos enteros al campo manual
existente; el empleado sigue confirmando la línea explícitamente (ninguna
pesada agrega sola una línea). El ingreso manual sigue disponible siempre;
desconectar la balanza no interrumpe la venta. Modo `SIMULATED` es una
herramienta de prueba dentro del modal de diagnóstico (fijar peso, simular
desconexión), no un modo operativo normal.

**REQUIERE VERIFICACIÓN**: no se conectó una Novel Eco 2 real ni se
compiló contra `i686-unknown-linux-gnu` en esta sesión (sin Docker/CI Linux
disponible). Validado sin hardware: 20 tests Rust nuevos (parser + estado,
ver "Validación actual"), 9 tests `vitest` de frescura de lectura, build
Windows NSIS x64 completo con el nuevo crate.

## Desposte / Producción — implementada 2026-09-22, corregida a Admin el mismo día

Primera versión funcional del módulo, sólo en Admin (online, ver D-031; el POS de mostrador nunca lo expuso funcionalmente — una primera pasada lo integró equivocadamente en el POS y se corrigió el mismo día tras revisión, antes de cualquier uso real):

- `production_batches`/`production_batch_outputs` (migraciones `202609220024`/`202609220025`), RLS por organización y sucursal (`app_private.can_access_branch`, mismo patrón que ventas).
- Cálculos de dominio puros y testeados en `packages/business-logic/src/production.ts`: costo de entrada, merma, rendimiento, valor potencial, asignación de costo por valor relativo de venta con redondeo determinístico exacto (los costos asignados siempre suman exactamente el costo del lote), márgenes.
- El servidor implementa la misma asignación (`app_private.compute_production_preview`) tanto para la vista previa en vivo de un borrador como para los valores que `complete_production_batch` congela como snapshot al finalizar.
- Snapshot de precio de venta vigente por output al finalizar (reutiliza `product_prices`); si falta un precio vigente, se bloquea la finalización y se informa qué producto lo necesita.
- Estados `DRAFT` (editable) / `COMPLETED` (histórico inmutable) / `CANCELLED` (sólo desde `DRAFT`). Reversión de un lote completado no está implementada (ver D-030).
- **Stock**: el ledger `stock_movements` ya existía en el repositorio (contrario a lo asumido al iniciar este sprint); el desposte lo integra en vez de dejarlo desacoplado, con dos tipos nuevos `PRODUCTION_CONSUME`/`PRODUCTION_YIELD` (ver D-029 y `docs/DOMAIN_RULES.md`). No se creó un segundo modelo de inventario.
- **Permisos**: `production.read`/`production.write` son exclusivos del rol `admin` (mismo patrón que `settlements.*`/`analytics.read`); el empleado no los recibe. `requireAdminContext()` además exige `role.key === 'admin'` para entrar a cualquier `/admin/*`, doble capa igual que el resto de Admin.
- UI: `/admin/production` (`apps/admin/src/app/admin/production/page.tsx`), Server Component + Server Actions en `apps/admin/src/app/admin/actions.ts` (mismo patrón que rendiciones/stock): listado con filtro por estado, alta, edición de borrador (datos de entrada y outputs), finalización, cancelación de borrador, resumen de rendimiento promedio por insumo. Reutiliza `formatCurrency`/`formatWeight` de `packages/business-logic`.
- Tests: 18 casos Vitest (`packages/business-logic/src/production.test.ts`, incluyendo el ejemplo numérico exacto de la media res) y 68 aserciones pgTAP (`supabase/tests/production_batches.test.sql`) cubriendo aislamiento por organización/sucursal, que el rol `employee` no tiene ningún acceso (ni siquiera en su propia sucursal), inmutabilidad post-finalización y la integración de stock.

**REQUIERE VERIFICACIÓN**: Docker Desktop no llegó a estar operativo en ninguna sesión de este sprint (mismo síntoma que sesiones previas, ver más abajo), por lo que `pnpm db:reset`/`pnpm db:test` no se pudieron ejecutar contra Postgres real; las migraciones y el suite pgTAP se revisaron manualmente pero no corrieron. `pnpm db:types` tampoco pudo regenerarse: `packages/database/src/database.types.ts` se actualizó a mano para las tablas/RPC/enum nuevos.

Confirmado: `202609220024_production_batches.sql` falló dos veces seguidas al aplicarse a Supabase remoto (`supabase db push`), corregido directamente en la misma migración cada vez (todavía no aplicada en ningún entorno, por lo que no se creó una migración `026`):

1. `app_private.compute_production_preview` mezclaba `batch.cost_total_cents` (columna sin agregar) con `sum(shares.floor_cents)` sin `GROUP BY` (SQLSTATE 42803) en el CTE `leftover`, reemplazado por una subconsulta escalar.
2. `compute_production_preview` y `get_production_catalog` reproducían el bug de precedencia de precio por sucursal ya corregido en `202609100004_fix_branch_price_precedence.sql` (faltaba `nulls last` al ordenar por `pp.branch_id = ...`, lo que hubiera preferido silenciosamente un precio global sobre uno de sucursal).
3. `app_private.round_ratio_half_up(bigint, bigint) does not exist` para `(numeric, integer)` (SQLSTATE 42883): `sum()` de una columna `bigint` en PostgreSQL devuelve `numeric`, no `bigint`; sin cast explícito eso se propagaba desde `totals.total_sale_value_cents` hasta `allocated.allocated_cost_cents`, llegando como `numeric` a la llamada final. Se agregaron casts `::bigint` en cada `sum()` de una expresión `bigint` (`totals`, `leftover` y los dos `SELECT INTO` en `complete_production_batch`/`get_production_batch_detail`, más el duplicado en `202609220025`).

Ninguno de los tres había sido detectado por la revisión manual previa a la primera versión de este sprint; la migración sigue sin validarse contra Postgres real.

No implementado en este sprint (ver `docs/TASKS.md`): reversión/ajuste de un lote completado; `apps/admin/src/components/branch-detail.tsx` no incluye `PRODUCTION_YIELD` en su widget de "ingresos recientes".

## Materias primas, sucursal productiva y Distribución — implementado 2026-09-22

Continuación del sprint de Desposte, sobre el mismo módulo:

- **Materia prima vs producto de venta**: `products.inventory_role` (`RAW_MATERIAL` | `SELLABLE` | `BOTH`, enum `product_inventory_role`, migración `202609220026`), default `SELLABLE` para no cambiar el comportamiento de ningún producto existente. El selector de insumo de Desposte (`get_production_catalog`, `create_production_batch`, `update_production_batch_header`) ahora exige `RAW_MATERIAL`/`BOTH`; el selector de outputs (`set_production_batch_output`) exige `SELLABLE`/`BOTH`. La migración promueve automáticamente a `BOTH` (no `RAW_MATERIAL`, para no quitarle capacidad de venta a nada) cualquier producto que ya apareciera como `source_product_id` en un `production_batches` existente, para no romper despostes ya creados. Admin: `ProductManageModal`/`ProductCreateModal` agregan dos checkboxes ("Producto de venta" / "Materia prima"); un producto creado como materia prima pura no exige costo/margen de venta (RPC `set_product_inventory_role`).
- **Sucursal habitual de producción**: `organizations.production_branch_id` (nullable, mismo patrón que `replenishment_target_days`), RPC `set_production_branch` (permiso `production.write`). Central sigue siendo una sucursal comercial real, no una ficticia; ver D-011 más abajo para la aclaración. `create_production_batch` ahora recibe `p_branch_id` opcional: si se omite, usa `organizations.production_branch_id`; si ninguno está configurado, bloquea la creación con un mensaje claro. `/admin/production` muestra un panel de configuración (colapsado una vez configurado) y el formulario de nuevo desposte ya no pregunta sucursal, sólo indica "Stock generado en: {sucursal}".
- **Varias unidades de materia prima por lote**: `production_batches.input_unit_count` (entero opcional, sólo trazabilidad; el cálculo de costo/stock sigue basado en `input_weight_grams`). Campo agregado a los formularios de creación/edición.
- **Editar y eliminar borradores**: ya se podía editar cabecera y outputs de un `DRAFT` (existente desde el sprint anterior). Se agregó `delete_production_batch` (hard delete, sólo `DRAFT`; `production_batch_outputs` cae por `on delete cascade`; un `COMPLETED` está protegido por el chequeo de estado y, como respaldo, por la FK `RESTRICT` de `stock_movements.production_batch_id`) y el botón "Eliminar desposte" con confirmación.
- **`create_production_batch`/`update_production_batch_header` cambiaron de firma** (se agregó `p_branch_id` opcional y `p_input_unit_count`): como agregar parámetros cambia la firma de tipos de una función Postgres, la migración `202609220026` hace `drop function` de las versiones de 6 argumentos y las recrea, en lugar de `create or replace` (que no puede cambiar la firma). Ninguna de las dos había sido aplicada nunca a un entorno real (ver más abajo), así que esto es DDL nuevo, no una edición de una migración ya aplicada.
- **Distribución / transferencias entre sucursales** (migración `202609220027`): tablas nuevas `stock_transfers` (cabecera: organización, sucursal origen, sucursal destino, notas, autor, fecha, peso total, cantidad de ítems) y `stock_transfer_items` (línea: producto, peso). RPC `create_stock_transfer` escribe en el ledger existente `stock_movements` usando los tipos `TRANSFER_OUT`/`TRANSFER_IN` que ya existían en el enum desde `202609100003` pero nunca se habían usado — no se creó un segundo modelo de inventario (D-010). Toda la operación corre dentro de una única función `plpgsql`, por lo que cualquier excepción (stock insuficiente, producto inválido, sucursal repetida) revierte todo lo insertado en esa llamada — atomicidad real de Postgres, no lógica de compensación manual. La validación de stock disponible toma el mismo lock consultivo por `(sucursal, producto)` que ya usa `record_stock_operation`/el trigger `stock_movements_serialize_product`, antes de leer el stock, para que sea segura ante escrituras concurrentes. Alcance de este sprint: sólo productos `WEIGHT` (coincide con todos los ejemplos del pedido y con la regla de no mezclar kg y unidades). RPC `list_stock_transfers` para el historial. Permisos: `stock.write`/`stock.read`, ya existentes; `stock.write` nunca se le otorgó al rol `employee` (confirmado en `202609100007`), así que Distribución queda administrativa igual que Desposte. UI: `/admin/transfers` (formulario con líneas dinámicas de producto/peso + historial con desglose por ítem); enlace "Distribuir ahora" desde un desposte `COMPLETED` que precompleta origen y líneas con los outputs recién producidos.
- **Aclaración de D-011** (no se cambió la decisión, sólo se registra la distinción para evitar confusión futura): D-011 dice que no se modela el "depósito/negocio principal del dueño" — un concepto de inventario centralizado del dueño que hoy se controla por otro sistema. Eso es distinto de Central: Central ya existe como una fila real en `branches`, con ventas y stock igual que cualquier otra sucursal (Chinos Janssen, Avenida). Configurarla como sucursal habitual de producción no crea ni modela ningún depósito nuevo; sólo automatiza a qué sucursal apunta `create_production_batch` por defecto.

**Migraciones `202609220026`/`202609220027`**: revisadas manualmente línea por línea, **no ejecutadas contra Postgres real** (mismo motivo que 024/025: sin Docker/CI Linux disponible en esta sesión). No se pudo confirmar con `supabase db push`/`migration list --linked` si 024–027 llegaron a aplicarse al remoto.

**Hallazgo colateral, no introducido por este sprint (deuda técnica preexistente)**: al reconvertir `packages/database/src/database.types.ts` de UTF-16LE (encoding con el que estaba guardado en el árbol de trabajo, probablemente por una redirección de PowerShell de una sesión anterior) a UTF-8 para poder editarlo de forma confiable, `pnpm typecheck`/`pnpm build` de `@carnicerias/admin` empezaron a fallar con errores `exactOptionalPropertyTypes` preexistentes (ese flag está en `tsconfig.base.json` desde el commit inicial del repo, confirmado con `git log`) en funciones y páginas que esta sesión no tocó: `saveCategoryAction`, `saveProductAction` (no usada por ninguna UI), `setPriceAction`, `recordPurchaseAction`, `recordReplenishmentFormAction`, `recordWasteAction`, `recordAdjustmentAction`, `manageMemberAction`, `createPosEmployeeAction`/`updatePosEmployeeAction`, y las páginas `/admin/analytics`, `/admin/employees`, `/admin/settlements`, `/admin/timekeeping`. El patrón común es pasar `null` explícito a un argumento de RPC opcional tipado sin `| null`. No se corrigieron: al menos `setPriceAction` usa `null` con un significado propio ("cerrar el precio sin fijar uno nuevo") que **no** es intercambiable con omitir el argumento para un parámetro Postgres sin `default` — una corrección mecánica global sería insegura sin revisar cada RPC, y tocaría precios/reposición/empleados/rentabilidad/rendiciones/horas trabajadas, fuera del alcance de este sprint. El código propio de este sprint (Desposte, materias primas, transferencias) sí compila y lintea limpio de forma aislada (verificado). Queda como tarea de seguimiento en `TASKS.md`.

## Gestión de sucursales y pre-production reset — implementado 2026-09-22

- Admin → Sucursales ahora permite crear, editar y activar/desactivar
  sucursales (`save_branch`, `set_branch_active`, migración
  `202609220028_branch_management.sql`). El permiso `branches.write` y las
  policies RLS de insert/update en `branches` ya existían desde
  `202609100001` sin usarse; esta migración sólo agrega las RPC y un trigger
  de auditoría (`branches_audit`, mismo patrón que `categories`/`products`)
  que faltaba. UI: `/admin/branches/new` (crear) y el detalle de sucursal
  (`components/branch-detail.tsx`, pestaña "Otros") para editar/activar,
  desactivar o eliminar. El listado (`/admin/branches`) ahora también
  muestra sucursales inactivas (antes las ocultaba por completo, lo que
  hacía imposible reactivarlas desde la UI) con un filtro "Inactivas".
- `delete_branch` (hard delete) sólo procede si la sucursal no tiene ninguna
  fila en ventas, stock, rendiciones, turnos, dispositivos, despostes,
  transferencias, auditoría o precios propios; si tiene, rechaza y pide
  desactivar en su lugar (D-005, D-035).
- `scripts/pre-production-reset.sql` (manual, una sola vez, ver D-036 y
  `docs/PRE_PRODUCTION_RESET.md`): limpia ventas, pagos, stock, rendiciones,
  turnos, dispositivos, empleados internos y sucursales ficticias
  preservando organización, admin/owner, catálogo y `product_prices`.
  Aborta si detecta un precio específico de una sucursal a eliminar (la
  FK `product_prices.branch_id → branches` es `on delete restrict`, así que
  esto también es un requisito técnico, no sólo una precaución). No se
  ejecutó contra ningún entorno en esta sesión — el usuario debe correrlo
  manualmente siguiendo `docs/PRE_PRODUCTION_RESET.md` (incluye backup, cómo
  revisar antes de confirmar, y verificación posterior).
- **REQUIERE VERIFICACIÓN**: igual que el resto de las migraciones desde
  `202609220024`, Docker Desktop no estuvo operativo en esta sesión (mismo
  síntoma: `dockerDesktopLinuxEngine` no responde), así que
  `202609220028_branch_management.sql` se revisó manualmente pero no corrió
  contra Postgres real, y `database.types.ts`/`database.rpc-null-overrides.ts`
  se actualizaron a mano (mismo patrón ya usado para 024–027) en vez de con
  `pnpm db:types`. `pnpm typecheck`/`lint`/`test`/`build` sí corrieron limpio
  en todo el monorepo con estos cambios incluidos.

## Migraciones locales confirmadas

### Supabase/PostgreSQL

1. `202609100001_initial_identity_catalog.sql`
2. `202609100002_grant_authenticated_table_access.sql`
3. `202609100003_online_pos_sales_stock.sql`
4. `202609100004_fix_branch_price_precedence.sql`
5. `202609100005_offline_pos_sync.sql`
6. `202609100006_remove_sync_function_shadow.sql`
7. `202609100007_operational_pilot.sql`
8. `202609100008_commercial_configuration.sql`
9. `202609100009_grant_catalog_write_to_admin.sql`
10. `202609100010_sync_discounted_offline_sales.sql`
11. `202609110011_restore_sale_sync_compatibility.sql`
12. `202609130012_price_formation_cash_discount.sql`
13. `202609130013_fix_function_lint_errors.sql`
14. `202609130014_payment_discount_category_colors.sql`
15. `202609130015_smart_replenishment.sql`
16. `202609130016_weekly_settlements.sql`
17. `202609130017_profitability_analytics.sql`
18. `202609130018_pos_operator_timekeeping.sql`
19. `202609130019_harden_pos_operator_authorization.sql`
20. `202609130020_audit_employee_deactivation.sql`
21. `202609130021_review_stale_offline_clockins.sql`
22. `202609140022_internal_pos_employees.sql`
23. `202609160023_get_branch_stock_status.sql`
24. `202609220024_production_batches.sql`
25. `202609220025_production_batch_stock_integration.sql`
26. `202609220026_raw_materials_and_production_branch.sql`
27. `202609220027_stock_transfers.sql`
28. `202609220028_branch_management.sql`

### SQLite POS

1. `001_offline_core.sql`
2. `002_commercial_config.sql`
3. `003_discount_sale_snapshots.sql`
4. `004_cash_discount_snapshots.sql`
5. `005_category_colors.sql`
6. `006_pos_operators_timekeeping.sql`

### Estado remoto

`REQUIERE VERIFICACIÓN`: el repositorio está vinculado al proyecto Supabase, pero no se ejecutó `migration list --linked` ni se aplicaron las migraciones 022–023 al remoto. No afirmar que 001–023 están aplicadas hasta comprobarlo autenticadamente.

## Validación actual

- `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`: **OK en todo el monorepo** (`packages/*`, `apps/admin`, `apps/pos`), confirmado 2026-09-22 en una sesión de seguimiento. Esto incluye corregir dos clases de error preexistentes, no introducidas por el sprint de materias primas/Distribución, que aparecieron al normalizar la codificación de `database.types.ts` (ver más abajo):
  - **Nullability de argumentos/retornos de RPC que `exactOptionalPropertyTypes` (en `tsconfig.base.json` desde el commit inicial) rechazaba**: varios RPC (`save_category`, `save_product`, `set_product_price`, `manage_existing_member`, `record_stock_operation`, `confirm_settlement`, `get_profitability_analytics`, `get_settlement_history`, `get_timekeeping_report`, `list_organization_members`) reciben o devuelven `null` con un significado propio en SQL (crear vs. editar, "sin sucursal" = precio/turno global, `default null`, un `LEFT JOIN` sin fila) que el generador de tipos de Supabase no puede inferir por sí solo — no existe "not null" a nivel de parámetro/columna de retorno en Postgres, así que cada regeneración lo vuelve a perder. La solución persistente: `packages/database/src/database.rpc-null-overrides.ts` (overrides locales, uno por RPC, con comentario de por qué cada `null` es válido) fusionado sobre el tipo generado en `packages/database/src/database.merged.ts`, que es lo que `index.ts` exporta como `Database`. `database.types.ts` en sí queda intacto — exactamente lo que produciría `pnpm db:types` — así que una regeneración futura no pierde nada silenciosamente ni requiere volver a tocar el archivo generado.
  - **RPCs sin argumentos llamadas con `{}`**: `list_organization_members`/`get_employee_security_status` tienen `Args: never`; `supabase.rpc(nombre, {})` no es asignable a eso. Corregido en los 3 sitios (`apps/admin/src/app/admin/employees/page.tsx`, `apps/admin/src/app/admin/timekeeping/page.tsx`) llamando `supabase.rpc(nombre)` sin segundo argumento.
  - Además, el primer diseño del override (`Omit<Functions, keyof Overrides> & Overrides`) rompía la resolución de los overloads genéricos de `SupabaseClient<Database>.rpc()` para **toda** la tabla de funciones, no sólo las corregidas — se manifestaba como errores `Argument ... not assignable to parameter of type 'undefined'` en `apps/pos` (RPCs que ni siquiera están en el override). Se resolvió reemplazándolo por un mapped type homomórfico (`{ [K in keyof Functions]: K extends keyof Overrides ? Overrides[K] : Functions[K] }`), que preserva el mismo conjunto de claves. Confirmado revirtiendo temporalmente a la exportación directa del tipo generado y viendo desaparecer los errores de `apps/pos`, y volviendo a aparecer limpio con el mapped type.
- El lint de `/admin/employees:63` (`@typescript-eslint/no-unnecessary-condition` sobre `member.email ?? "Cuenta Auth"`) tenía la misma causa: `list_organization_members` devuelve `email` como `string` no nullable en el tipo generado, pero la SQL real (`left join auth.users ... on auth_user.id = profile.auth_user_id`) da `null` para un empleado interno sin cuenta Auth — el propio código ya lo trataba como posible-nulo en dos lugares (`??` en la línea 63, `member.email ?    ` en la línea 88). Corregido con el mismo mecanismo de overrides (`email: string | null`), sin tocar la lógica de la página ni desactivar la regla.
- POS: sin cambios funcionales este sprint (Desposte/materias primas/transferencias son exclusivamente Admin, ver D-031); su build/typecheck se re-ejecutaron igual porque comparten `@carnicerias/database` y su tipo `Database` fusionado.
- Vitest: monorepo completo (`pnpm test`) OK — 45 tests en `packages/business-logic`, 6 en `packages/sync`, 28 en `apps/admin`, 4 en `apps/pos`. Este sprint no agregó funciones puras nuevas a `packages/business-logic` (transferencias y materias primas son lógica de servidor/SQL sin cálculo adicional en TypeScript), por lo que no había nada nuevo que cubrir ahí; la cobertura nueva vive en pgTAP.
- Migraciones `202609220024`–`202609220027` (Desposte/Producción, materias primas, sucursal productiva, transferencias) y `supabase/tests/production_batches.test.sql` (103 aserciones)/`supabase/tests/stock_transfers.test.sql` (49 aserciones): revisadas manualmente línea por línea, **no ejecutadas**; Docker Desktop no llegó a estar operativo en ninguna sesión hasta ahora. Pendiente correr `pnpm db:reset && pnpm db:test` y regenerar `pnpm db:types` en un entorno con Docker/CI Linux funcional — la versión actual de `database.types.ts` sigue editada a mano.
- Rust: 26 tests OK (6 preexistentes + 14 de `scale/parser.rs` — frame completo/dividido/concatenado, basura previa, CR incompleto, frame sobredimensionado, 0 g, 500 g, 1.250 kg, 12.345 kg, caracteres inválidos, sin punto decimal, frame vacío — + 6 de `scale/mod.rs` — desconexión limpia, generación obsoleta no sobrescribe lectura, config sobrevive guardado/recarga, config corrupta cae a `MANUAL`).
- Tauri desktop Windows completo (NSIS x64) tras separar config por plataforma: OK; reconfirmado 2026-09-16 con la dependencia `serialport` agregada (mismo instalador `Carnicerías POS_0.1.0_x64-setup.exe`).
- Validación de viewport sin sesión: caja no autorizada y configuración administrativa sin overflow a 1024×600, 1366×768 y 1920×1080.
- POS Linux i386: pipeline (`pnpm build:pos:linux:i386`, contenedor Debian 12 i386) implementado; **no se pudo ejecutar** en esta sesión porque el motor de Docker Desktop no llegó a estar operativo (API respondía 500 tras varios minutos). `REQUIERE VERIFICACIÓN`: generar el `.deb` real y el smoke test de `docs/LINUX_POS.md` en un entorno con Docker/CI Linux funcional y, después, en hardware Atom real. Ahora incluye además el crate `serialport` (balanza): sin Docker/CI Linux disponibles en esta sesión, no se corrió `cargo check --target i686-unknown-linux-gnu` dentro del contenedor; la elección de `default-features = false` para evitar `libudev-dev` se validó por análisis de la crate (ver `docs/SCALE_INTEGRATION.md`), no por una compilación real i386.
- La suite pgTAP se ejecutó por primera vez el 2026-09-16 (Docker disponible): `branch_stock_status_rpc.test.sql` (nuevo, 28/28 OK), `initial_schema`, `offline_sync`, `price_formation`, `profitability_analytics`, `settlements` OK. `internal_pos_employees`, `online_pos` y `operational_pilot` tienen fallos preexistentes no relacionados con este sprint (reproducidos con y sin la migración nueva, contra `pnpm db:reset` limpio) — ver "Performance Admin" arriba y la tarea de seguimiento creada.
- SQL remoto: no ejecutado; migraciones 022–023 pendientes de dry-run/push autenticado.
- `/admin/branch-stock`: validado por typecheck/lint/build/tests unitarios; **no verificado visualmente contra datos Supabase reales de producción** (sí contra Supabase local con datos sintéticos, sesión 2026-09-16). `REQUIERE VERIFICACIÓN`: smoke manual con sesión admin real de producción, varias sucursales y productos WEIGHT/UNIT.
