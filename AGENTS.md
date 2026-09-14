# AGENTS.md

Instrucciones permanentes para Codex.

## Antes de trabajar

1. Leer:
   - `docs/PROJECT_CONTEXT.md`
   - `docs/PRODUCT.md`
   - `docs/DOMAIN_RULES.md`
   - `docs/ARCHITECTURE.md`
   - `docs/CURRENT_STATE.md`
   - `docs/TASKS.md`
2. Leer `docs/DECISIONS.md` si la tarea afecta reglas globales.
3. Inspeccionar el código real relacionado.
4. No asumir que la documentación refleja implementación si contiene `REQUIERE VERIFICACIÓN EN REPO`.
5. Si código y docs contradicen, detener esa parte y reportar la contradicción.

## Fuente de verdad

- Estado técnico actual: código, esquema, migraciones y tests.
- Decisiones vigentes: `docs/PRODUCT.md`, `docs/DOMAIN_RULES.md` y `docs/DECISIONS.md`.
- La especificación actual define el alcance de la tarea.

Una diferencia entre código y regla de producto es una contradicción que debe registrarse en `CURRENT_STATE.md`; no autoriza a cambiar la regla silenciosamente.

## Alcance

- Modificar sólo lo necesario para la tarea.
- No realizar refactors globales oportunistas.
- No cambiar arquitectura, pricing, permisos, sync o reglas de negocio fuera de alcance.
- No editar migraciones ya aplicadas.
- No borrar datos para simplificar una migración.
- No usar hard-delete donde la documentación exige trazabilidad.

## Seguridad

Preservar:

- RLS;
- tenant isolation;
- branch isolation;
- backend permission checks;
- idempotencia;
- snapshots;
- PIN no plaintext.

Nunca “optimizar” eliminando controles de seguridad.

## Dinero y cantidades

- cents enteros;
- gramos enteros;
- evitar floats para dinero;
- respetar `docs/DOMAIN_RULES.md`.

## Offline

Todo cambio que toque POS debe considerar:

- reinicio;
- modo offline;
- reconnect;
- duplicados;
- outbox;
- SQLite existente;
- sync idempotente.

No dar por cerrada una modificación POS sólo porque funciona online.

## Migrations

- incrementales;
- dry-run antes de push cuando corresponda;
- no modificar migraciones remotas;
- SQLite incremental;
- actualizar tipos generados si el repo lo requiere.

## Validación

Ejecutar la validación más amplia razonable para el alcance:

- typecheck;
- lint;
- tests;
- build del paquete afectado;
- Rust/Tauri checks si toca desktop;
- DB lint si toca SQL.

Si una prueba no puede ejecutarse por tooling externo, reportarlo con precisión.

## Documentación

Actualizar `/docs` cuando el cambio:

- introduce una regla de negocio;
- cambia arquitectura;
- cambia modelo de datos relevante;
- cambia permisos;
- invalida `CURRENT_STATE.md`;
- completa/elimina una tarea de `TASKS.md`.

No convertir `/docs` en changelog.

## Reporte final

Responder corto y operativo:

- qué cambió;
- archivos/migraciones;
- validaciones ejecutadas;
- resultados;
- comandos que debe ejecutar el usuario;
- pendientes reales;
- cualquier contradicción detectada.

No afirmar “completo” si falta smoke/manual validation requerida.
