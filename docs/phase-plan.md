# Plan de implementación continuable

## 1A — Fundación (esta entrega)

- Monorepo y configuración estricta.
- Supabase local y migración inicial.
- Auth, perfiles, roles, permisos, organizaciones y sucursales.
- Categorías, productos e historial de precios.
- RLS, seeds y documentación operativa.

## 1B — Núcleo local del POS

- Shell nativo Tauri y migraciones SQLite.
- Modelo local de catálogo, ventas, ítems, pagos, stock ledger y outbox.
- Reglas puras de ticket por peso y transacción atómica local.
- Inicio de sesión online y política explícita de sesión offline segura.
- Tests de totales, stock, anulación e idempotencia local.

## 1C — Sincronización

- Push idempotente de ventas y movimientos mediante RPC transaccional.
- Pull incremental de catálogo/precios mediante cursor/versionado.
- Reintentos, backoff, recuperación tras cierre y diagnóstico.
- Tests de duplicados, orden, errores parciales y reconexión.

## 1D — Operación y administración básica

- POS manual por peso y estado de sincronización.
- Stock ledger remoto y venta completa offline demostrable.
- Admin: login, sucursales, catálogo, precios y dashboard agregado básico.
- Auditoría de operaciones relevantes.

## 2 — Hardware y operación ampliada

- Adaptadores manual, HID/teclado y serial configurables.
- Peso estable, diagnóstico y fallback manual.
- Mermas, ingresos, alertas y reposición determinística.
- Dashboards comparativos y métricas avanzadas.

## 3 — Expansión

- Transferencias, proveedores, compras y reportes avanzados.
- Optimización de agregaciones y Realtime solo donde agregue valor.
- Endurecimiento operativo, observabilidad y despliegues productivos.

