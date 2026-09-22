# Tasks

Sólo trabajo próximo. Eliminar cada tarea al completarla.

## P1 — Performance Admin con evidencia de producción

Hecho en el sprint 2026-09-16 (local, ver `CURRENT_STATE.md`):

- `getAdminContext` pasó de auth + membership + role/org (3 pasos) a auth + 1 query embebida.
- Instrumentación agregada a `/admin/products` y `/admin/employees`.
- `branch_stock_status` (el cuello de mayor impacto: 1.1–2.2 s por RLS evaluada fila a fila sobre `stock_movements`) resuelto con la RPC `get_branch_stock_status` (migración `202609160023`), siguiendo el mismo patrón que `get_replenishment_plan`. `/admin`, `/admin/branches` y `/admin/stock` migradas; medido **1.1–2.2 s → 130–240 ms**. `stock_movements` sigue siendo la única fuente de verdad; no se creó balance materializado. 28 tests pgTAP nuevos (`branch_stock_status_rpc.test.sql`).
- Confirmado que el bundle no tiene librerías pesadas que justifiquen `dynamic import`.

Pendiente:

- Migrar `/admin/attention`, `/admin/branches/compare` y `components/branch-detail.tsx` a `get_branch_stock_status` si en el futuro se mide que también son lentas (quedaron en la vista `branch_stock_status`, fuera de alcance de este sprint).
- Medir rutas autenticadas en Vercel con la instrumentación existente (baseline de producción sigue pendiente; lo hecho en este sprint es local/reproducible, no producción).
- Confirmar región/runtime Vercel frente a Supabase `sa-east-1`.
- Evaluar prefetch e índices únicamente con medición/planes adicionales.
- No usar caché larga para ventas o stock.
- Navegación caliente cercana o inferior a 700 ms: alcanzado localmente en `/admin`, `/admin/branches`, `/admin/stock` (130–240 ms); falta confirmar contra Vercel + Supabase `sa-east-1` reales.
- Investigar los fallos preexistentes del suite pgTAP hallados al correrlo por primera vez (`internal_pos_employees`, `online_pos`, `operational_pilot`) — no relacionados con este sprint, task de seguimiento ya creada.

## P2 — PWA Admin

- Manifest, iconos, installability y modo standalone.
- Service worker conservador; Admin continúa online-first.
- Ejecutar después de estabilización y performance.

## P1 — Smoke test físico de balanza KRETZ Novel Eco 2

Implementado en el sprint 2026-09-16 (ver `docs/CURRENT_STATE.md` y
`docs/SCALE_INTEGRATION.md`): parser, adaptadores manual/simulado/serial,
persistencia local, integración con el modal de peso existente, tests sin
hardware, build Windows.

Pendiente:

- Conectar una Novel Eco 2 real y seguir el checklist de smoke test de
  `docs/SCALE_INTEGRATION.md` (Windows y Linux).
- Confirmar `cargo check`/build contra `i686-unknown-linux-gnu` con el
  crate `serialport` agregado (requiere Docker o GitHub Actions).

## P1 — Validar Desposte / Producción / materias primas / Distribución contra Postgres real

Implementado en los sprints 2026-09-22 (ver `docs/CURRENT_STATE.md`): tablas,
RLS, RPCs, integración con `stock_movements`, cálculos de dominio, UI en
Admin (`/admin/production`, `/admin/transfers`, no en el POS — ver D-031) y
tests (Vitest + pgTAP) escritos y revisados manualmente. Docker Desktop no
llegó a estar operativo en ninguna sesión hasta ahora.

Pendiente:

- Ejecutar `pnpm db:reset && pnpm db:test` (`supabase/tests/production_batches.test.sql`,
  103 aserciones; `supabase/tests/stock_transfers.test.sql`, 49 aserciones) en un
  entorno con Docker/CI Linux funcional.
- Regenerar `packages/database/src/database.types.ts` con `pnpm db:types`
  (se editó a mano en varias sesiones) y confirmar que coincide con el schema real.
  Al regenerar, revisar `packages/database/src/database.rpc-null-overrides.ts`
  contra el nuevo archivo: si alguna migración tocada cambió el argumento/retorno
  real de una de las RPC ahí listadas, actualizar esa entrada para que coincida.
- Confirmar con `supabase migration list --linked` si 024–027 llegaron a
  aplicarse al remoto antes de asumir que están pendientes.
- Smoke manual en Admin: crear un desposte con varias medias res
  (`input_unit_count`), agregar/quitar outputs, editar y eliminar un
  borrador, finalizar, configurar la sucursal productiva desde cero (caso
  "no configurada todavía"), marcar un producto como materia prima desde
  `/admin/products` y confirmar que aparece/desaparece de los selectores
  correspondientes, y hacer una transferencia real Central → otra sucursal
  desde `/admin/transfers` (incluida "Distribuir ahora" desde un desposte
  recién finalizado). Confirmar que el rol `employee` no puede acceder a
  ninguna de las dos pantallas.

## P1 — Ejecutar pre-production reset y crear sucursales reales (acción del usuario)

Implementado 2026-09-22: `scripts/pre-production-reset.sql`, gestión de
sucursales en Admin (`/admin/branches/new`, editar/activar/desactivar/borrar
en el detalle), migración `202609220028_branch_management.sql`. No ejecutado
contra ningún entorno en esta sesión (requiere confirmación explícita del
usuario, ver `docs/PRE_PRODUCTION_RESET.md`).

Pendiente (usuario, no Claude/Codex):

- Backup del proyecto Supabase remoto.
- Correr `scripts/pre-production-reset.sql` siguiendo `docs/PRE_PRODUCTION_RESET.md`.
- Verificar el resultado (queries de la sección "Verificar que quedó limpio").
- Crear las sucursales reales desde Admin → Sucursales y autorizar cada
  dispositivo real a la suya.

Pendiente (agente, requiere Docker/CI Linux — mismo bloqueo que 024–027):

- Ejecutar `202609220028_branch_management.sql` contra Postgres real
  (`pnpm db:reset && pnpm db:test`) y regenerar `database.types.ts` con
  `pnpm db:types`.

## P2/P3 — Capacidades opcionales según negocio

- Completar venta POS `UNIT` si se vuelve necesaria comercialmente.
- Conservar como evidencia el timestamp/intento de clock-out offline anómalo, manteniendo el turno en `REQUIRES_REVIEW`.
- Reversión/ajuste de un desposte ya finalizado (hoy sólo puede cancelarse un borrador; ver D-030).
- Evaluar si `apps/admin/src/components/branch-detail.tsx` ("ingresos recientes") debería incluir `PRODUCTION_YIELD` junto a PURCHASE/RETURN/ADJUSTMENT_POSITIVE/TRANSFER_IN.

No priorizar actualmente detección avanzada de inconsistencias.
