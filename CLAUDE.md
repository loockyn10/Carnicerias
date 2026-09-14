# CLAUDE.md

Instrucciones permanentes para Claude Code.

## Contexto inicial obligatorio

Antes de implementar, leer:

- `docs/PROJECT_CONTEXT.md`
- `docs/PRODUCT.md`
- `docs/DOMAIN_RULES.md`
- `docs/ARCHITECTURE.md`
- `docs/CURRENT_STATE.md`
- `docs/TASKS.md`

Leer `docs/DECISIONS.md` cuando la tarea afecte comportamiento global.

Después inspeccionar el repositorio real antes de proponer cambios.

## Regla de reconciliación

El código y las migraciones muestran el estado técnico real.

Los docs muestran las decisiones vigentes.

Si difieren:

- no corregir silenciosamente uno para que coincida con el otro;
- identificar la discrepancia;
- distinguir bug/deuda técnica de cambio deliberado de producto.

## Estilo de trabajo

- trabajar con contexto de tarea pequeño;
- explorar sólo superficies relevantes;
- hacer cambios acotados;
- evitar refactors no solicitados;
- validar después de modificar;
- mantener documentación compacta.

## Restricciones críticas

No cambiar sin decisión explícita:

- pricing;
- orden de descuentos;
- métodos elegibles;
- stock ledger;
- sucursal determinada por dispositivo;
- offline sync;
- RLS/tenant isolation;
- snapshots históricos;
- política de desactivación vs borrado.

## POS

Si toca POS, validar mental y técnicamente:

- online;
- offline;
- restart;
- reconnect;
- idempotencia;
- SQLite existente;
- operador;
- sucursal.

## SQL y migraciones

- incremental only;
- no editar migraciones aplicadas;
- no asumir que un reporte histórico implica que la migración existe;
- revisar schema real;
- ejecutar lint/validación disponible.

## Performance

Medir antes de optimizar.

No aceptar como mejora:

- sólo agregar skeleton;
- esconder latencia;
- cachear datos sensibles sin estrategia de invalidación;
- eliminar checks de auth/RLS.

## Documentación

Si cambia una decisión global o estado importante:

- actualizar el doc mínimo necesario;
- eliminar tareas completadas de `TASKS.md`;
- no registrar toda la historia de implementación.

## Resultado esperado

Entregar:

- diagnóstico breve;
- cambios;
- validación;
- migraciones;
- comandos del usuario;
- pendientes.

Si revisás trabajo de Codex, partir del código actualizado y revisar el diff/estado actual, no de una descripción antigua.
