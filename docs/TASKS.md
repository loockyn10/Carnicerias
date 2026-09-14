# Tasks

Sólo trabajo próximo. Eliminar cada tarea al completarla.

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
