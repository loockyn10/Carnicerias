# AI Workflow

## Roles

### ChatGPT — Arquitecto de Producto y Software

Responsabilidades:

- definir producto y UX;
- discutir alternativas;
- detectar requisitos faltantes;
- diseñar funcionalidades;
- dividir trabajo;
- elaborar especificaciones;
- elegir agente;
- revisar conceptualmente resultados;
- mantener coherencia de decisiones.

No es el implementador principal.

### Codex — Implementación

Responsabilidades:

- explorar repo;
- implementar;
- migraciones;
- tests;
- build;
- verificación técnica.

### Claude Code — Implementación / revisión

Responsabilidades:

- explorar repo;
- implementar;
- revisar trabajo previo;
- refactors acotados;
- performance;
- tests;
- verificación.

## Política de contexto

1. Una feature o problema importante = una tarea/contexto nuevo.
2. No depender de conversaciones largas como memoria.
3. El agente debe leer documentación relevante y luego inspeccionar repo.
4. Codex y Claude pueden trabajar sucesivamente sobre la misma funcionalidad si el segundo parte del código actualizado.
5. Si trabajan simultáneamente, usar tareas independientes o branches/worktrees separados.
6. No modificar arquitectura o reglas globales silenciosamente.
7. Decisiones nuevas importantes deben reflejarse en `/docs`.
8. Documentación compacta: estado y decisiones vigentes, no historial.
9. Código/repositorio tiene prioridad sobre recuerdos de chat respecto del estado técnico.
10. Si documentación y código contradicen, señalarlo antes de asumir cuál es correcto.

## Flujo normal

```text
Necesidad
  ↓
ChatGPT define producto/spec
  ↓
Tarea autocontenida
  ↓
Codex o Claude inspecciona docs + repo
  ↓
Implementación
  ↓
Tests/build
  ↓
Resultado corto
  ↓
Actualizar docs si cambió estado/decisión
```

## Revisión cruzada

Útil cuando el cambio es delicado:

```text
Agente A implementa
↓
commit/código actualizado
↓
Agente B revisa
↓
corrige sólo si encuentra problemas reales
```

No pedir al segundo agente que reimplemente todo por defecto.

## Trabajo paralelo

Permitido sólo si:

- tareas suficientemente independientes; o
- cada agente usa branch/worktree separado.

Nunca dos agentes escribiendo simultáneamente el mismo working tree sin coordinación.

## Selección de agente

Orientativo:

- cambios mecánicos/locales: cualquiera;
- auditoría amplia/performance/refactor multiarchivo: Claude Code o Codex fuerte;
- auth/sync/dinero/RLS/offline: modelo/agente de mayor capacidad;
- revisión de diff crítico: preferible segundo agente.

La elección no reemplaza validación técnica.

## Qué entra en documentación

Sí:

- reglas;
- arquitectura;
- estado actual;
- decisiones;
- comandos;
- próximos pasos.

No:

- prompts históricos;
- conversaciones;
- intentos fallidos irrelevantes;
- bugs ya resueltos sin valor operativo;
- listas infinitas de features hipotéticas.

## Cierre de tarea

Una tarea no se considera cerrada hasta que:

- implementación relevante existe;
- validaciones razonables pasan;
- migraciones están claras;
- smoke manual pendiente está identificado;
- docs reflejan cambios globales;
- `TASKS.md` no conserva trabajo terminado.
