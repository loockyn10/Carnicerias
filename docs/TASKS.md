# Tasks

Sólo trabajo próximo. Eliminar cada tarea al completarla.

## P0 — Desacoplar Employee POS de Supabase Auth

- Crear empleados internos desde Admin con nombre, PIN, tarifa, estado y sucursales.
- Eliminar la dependencia obligatoria de una cuenta Auth individual para operadores normales.
- Preservar IDs y referencias históricas de ventas, stock, turnos, tarifas y auditoría.
- Mantener Auth para administradores y la autorización separada del dispositivo.
- Migrar incrementalmente, sin hard-delete ni pérdida de outbox/offline.

## P0/P1 — Múltiples sucursales por empleado

- Adaptar RPC y Admin para administrar varias asignaciones activas sobre `branch_members`.
- Mantener la sucursal operativa determinada por el dispositivo.
- Verificar roster, grants, desactivación y branch isolation.

Esta tarea puede resolverse junto con el desacople de Auth si la migración resultante sigue siendo acotada y segura.

## P1 — Performance Admin con evidencia de producción

- Medir rutas autenticadas en Vercel con la instrumentación existente.
- Confirmar región/runtime Vercel frente a Supabase `sa-east-1`.
- Optimizar sólo consultas, payloads o agregaciones demostradas como cuello.
- Evaluar prefetch e índices únicamente con medición/planes.
- No usar caché larga para ventas o stock.
- Buscar navegación caliente cercana o inferior a 700 ms cuando sea técnicamente razonable.

## P2 — PWA Admin

- Manifest, iconos, installability y modo standalone.
- Service worker conservador; Admin continúa online-first.
- Ejecutar después de estabilización y performance.

## P2/P3 — Capacidades opcionales según negocio

- Completar venta POS `UNIT` si se vuelve necesaria comercialmente.
- Incorporar frontera `ScaleAdapter` e integración Kretz cuando exista hardware para validar.
- Conservar como evidencia el timestamp/intento de clock-out offline anómalo, manteniendo el turno en `REQUIRES_REVIEW`.

No priorizar actualmente detección avanzada de inconsistencias.
