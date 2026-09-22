# Current State

Estado verificado contra el repositorio el 15 de septiembre de 2026. Las decisiones normativas viven en `PRODUCT.md`, `DOMAIN_RULES.md` y `DECISIONS.md`.

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

## Desposte / Producción — implementada 2026-09-22

Primera versión funcional del módulo, sólo en POS (online, todavía sin SQLite/offline):

- `production_batches`/`production_batch_outputs` (migraciones `202609220024`/`202609220025`), RLS por organización y sucursal (`app_private.can_access_branch`, mismo patrón que ventas).
- Cálculos de dominio puros y testeados en `packages/business-logic/src/production.ts`: costo de entrada, merma, rendimiento, valor potencial, asignación de costo por valor relativo de venta con redondeo determinístico exacto (los costos asignados siempre suman exactamente el costo del lote), márgenes.
- El servidor implementa la misma asignación (`app_private.compute_production_preview`) tanto para la vista previa en vivo de un borrador como para los valores que `complete_production_batch` congela como snapshot al finalizar.
- Snapshot de precio de venta vigente por output al finalizar (reutiliza `product_prices`); si falta un precio vigente, se bloquea la finalización y se informa qué producto lo necesita.
- Estados `DRAFT` (editable) / `COMPLETED` (histórico inmutable) / `CANCELLED` (sólo desde `DRAFT`). Reversión de un lote completado no está implementada (ver D-030).
- **Stock**: el ledger `stock_movements` ya existía en el repositorio (contrario a lo asumido al iniciar este sprint); el desposte lo integra en vez de dejarlo desacoplado, con dos tipos nuevos `PRODUCTION_CONSUME`/`PRODUCTION_YIELD` (ver D-029 y `docs/DOMAIN_RULES.md`). No se creó un segundo modelo de inventario.
- UI: `apps/pos/src/features/production/ProductionView.tsx` (listado, alta, edición de borrador, finalización, resumen de rendimiento promedio por insumo).
- Tests: 18 casos Vitest (`packages/business-logic/src/production.test.ts`, incluyendo el ejemplo numérico exacto de la media res) y 65 aserciones pgTAP (`supabase/tests/production_batches.test.sql`) cubriendo aislamiento por organización/sucursal, inmutabilidad post-finalización y la integración de stock.

**REQUIERE VERIFICACIÓN**: Docker Desktop no llegó a estar operativo en esta sesión (mismo síntoma que sesiones previas, ver más abajo), por lo que `pnpm db:reset`/`pnpm db:test` no se pudieron ejecutar contra Postgres real; las migraciones y el suite pgTAP se revisaron manualmente pero no corrieron. `pnpm db:types` tampoco pudo regenerarse: `packages/database/src/database.types.ts` se actualizó a mano para las tablas/RPC/enum nuevos.

No implementado en este sprint (ver `docs/TASKS.md`): reversión/ajuste de un lote completado; Admin no tiene pantalla propia del módulo (alcance pedido era sólo POS); `branch-detail.tsx` (Admin) no incluye `PRODUCTION_YIELD` en su widget de "ingresos recientes".

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

- Admin typecheck/lint/build: OK (incluye `/admin/branch-stock`, ruta nueva compilada y prerenderizada; sin cambios de Admin en el sprint de desposte).
- POS typecheck/lint/build web: OK (incluye la UI de balanza y la nueva vista de Desposte).
- Vitest: monorepo completo (`pnpm test`) OK — 45 tests en `packages/business-logic` (incluye 18 nuevos de `production.test.ts`), 6 en `packages/sync`, 28 en `apps/admin`, 4 en `apps/pos`.
- Migraciones `202609220024`/`202609220025` (Desposte/Producción) y `supabase/tests/production_batches.test.sql` (65 aserciones pgTAP): revisados manualmente línea por línea, **no ejecutados**; Docker Desktop no llegó a estar operativo en esta sesión (ver "Desposte / Producción" arriba). Pendiente correr `pnpm db:reset && pnpm db:test` y regenerar `pnpm db:types` en un entorno con Docker/CI Linux funcional.
- Rust: 26 tests OK (6 preexistentes + 14 de `scale/parser.rs` — frame completo/dividido/concatenado, basura previa, CR incompleto, frame sobredimensionado, 0 g, 500 g, 1.250 kg, 12.345 kg, caracteres inválidos, sin punto decimal, frame vacío — + 6 de `scale/mod.rs` — desconexión limpia, generación obsoleta no sobrescribe lectura, config sobrevive guardado/recarga, config corrupta cae a `MANUAL`).
- Tauri desktop Windows completo (NSIS x64) tras separar config por plataforma: OK; reconfirmado 2026-09-16 con la dependencia `serialport` agregada (mismo instalador `Carnicerías POS_0.1.0_x64-setup.exe`).
- Validación de viewport sin sesión: caja no autorizada y configuración administrativa sin overflow a 1024×600, 1366×768 y 1920×1080.
- POS Linux i386: pipeline (`pnpm build:pos:linux:i386`, contenedor Debian 12 i386) implementado; **no se pudo ejecutar** en esta sesión porque el motor de Docker Desktop no llegó a estar operativo (API respondía 500 tras varios minutos). `REQUIERE VERIFICACIÓN`: generar el `.deb` real y el smoke test de `docs/LINUX_POS.md` en un entorno con Docker/CI Linux funcional y, después, en hardware Atom real. Ahora incluye además el crate `serialport` (balanza): sin Docker/CI Linux disponibles en esta sesión, no se corrió `cargo check --target i686-unknown-linux-gnu` dentro del contenedor; la elección de `default-features = false` para evitar `libudev-dev` se validó por análisis de la crate (ver `docs/SCALE_INTEGRATION.md`), no por una compilación real i386.
- La suite pgTAP se ejecutó por primera vez el 2026-09-16 (Docker disponible): `branch_stock_status_rpc.test.sql` (nuevo, 28/28 OK), `initial_schema`, `offline_sync`, `price_formation`, `profitability_analytics`, `settlements` OK. `internal_pos_employees`, `online_pos` y `operational_pilot` tienen fallos preexistentes no relacionados con este sprint (reproducidos con y sin la migración nueva, contra `pnpm db:reset` limpio) — ver "Performance Admin" arriba y la tarea de seguimiento creada.
- SQL remoto: no ejecutado; migraciones 022–023 pendientes de dry-run/push autenticado.
- `/admin/branch-stock`: validado por typecheck/lint/build/tests unitarios; **no verificado visualmente contra datos Supabase reales de producción** (sí contra Supabase local con datos sintéticos, sesión 2026-09-16). `REQUIERE VERIFICACIÓN`: smoke manual con sesión admin real de producción, varias sucursales y productos WEIGHT/UNIT.
