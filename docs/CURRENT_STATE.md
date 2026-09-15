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

## Contradicciones vigentes

### Soporte `UNIT` incompleto en POS

El dominio, pricing, snapshots y analytics contemplan `UNIT`. El catálogo operativo del POS y los RPC de venta actualmente trabajan sólo con `WEIGHT`, gramos y precio/kg.

Estado: **soporte parcial confirmado; no prioritario salvo necesidad comercial**.

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
- Layout operativo compacto para baja altura: header de una línea, catálogo/ticket horizontal desde 900 px, proporción fluida, footer del ticket fijo y modales con scroll interno. Objetivo de validación: 1024×600; también 1366×768 y 1920×1080.

## Performance Admin

Ya existen:

- instrumentación de tiempos por ruta;
- cache por request de `getAdminContext`;
- paralelización de varias consultas;
- reducción de `select("*")`;
- selecciones de columnas más acotadas.

Las rutas siguen siendo dinámicas por cookies/sesión. Algunos loaders todavía transfieren conjuntos amplios y agregan en JavaScript, y el sidebar desactiva prefetch. Falta un baseline autenticado real de producción y la región de Vercel no está versionada en el repositorio. No agregar índices ni caché larga sin medición.

## No implementado

- PWA Admin: sin manifest, iconos, service worker ni installability formal.
- Balanza: sin `ScaleAdapter`, adaptadores manual/simulado/serial ni integración Kretz.
- Venta POS completa de productos `UNIT`.

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

### SQLite POS

1. `001_offline_core.sql`
2. `002_commercial_config.sql`
3. `003_discount_sale_snapshots.sql`
4. `004_cash_discount_snapshots.sql`
5. `005_category_colors.sql`
6. `006_pos_operators_timekeeping.sql`

### Estado remoto

`REQUIERE VERIFICACIÓN`: el repositorio está vinculado al proyecto Supabase, pero no se ejecutó `migration list --linked` ni se aplicó la migración 022 al remoto. No afirmar que 001–022 están aplicadas hasta comprobarlo autenticadamente.

## Validación actual

- Admin typecheck/lint/build: OK.
- POS typecheck/lint/build web: OK.
- Vitest: 36 tests OK.
- Rust: 6 tests OK.
- Tauri desktop Windows completo (NSIS x64) tras separar config por plataforma: OK.
- Validación de viewport sin sesión: caja no autorizada y configuración administrativa sin overflow a 1024×600, 1366×768 y 1920×1080.
- POS Linux i386: pipeline (`pnpm build:pos:linux:i386`, contenedor Debian 12 i386) implementado; **no se pudo ejecutar** en esta sesión porque el motor de Docker Desktop no llegó a estar operativo (API respondía 500 tras varios minutos). `REQUIERE VERIFICACIÓN`: generar el `.deb` real y el smoke test de `docs/LINUX_POS.md` en un entorno con Docker/CI Linux funcional y, después, en hardware Atom real.
- La suite pgTAP para identidades internas está agregada, pero no se ejecutó porque Docker Desktop no estaba disponible.
- SQL remoto: no ejecutado; migración 022 pendiente de dry-run/push autenticado.
