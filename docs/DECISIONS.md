# Decisions

Registro compacto de decisiones vigentes. No conservar discusiones reemplazadas.

## D-001 — POS offline-first

**Status:** Active

El POS debe seguir vendiendo sin Internet y sincronizar después de forma idempotente.

**Motivo:** continuidad operativa de sucursal.

---

## D-002 — Admin online-first

**Status:** Active

El Admin permanece web. No se replica la arquitectura SQLite/outbox del POS.

**Motivo:** necesita datos frescos; no existe necesidad suficiente para asumir complejidad offline administrativa.

---

## D-003 — Dispositivo determina sucursal

**Status:** Active

Un POS está enrolado en una sucursal. Cambiar de empleado no cambia la sucursal.

Un empleado puede estar autorizado a varias sucursales.

**Motivo:** aislar SQLite/outbox/stock/ventas por sucursal y simplificar offline.

---

## D-004 — Empleado POS no requiere Auth individual

**Status:** Active / implementación confirmada

Los empleados normales deben crearse desde Admin como entidades internas con nombre, PIN y sucursal(es).

Supabase Auth queda para accesos administrativos/dispositivo según arquitectura real. Los perfiles con Auth conservan un vínculo opcional; las identidades POS internas mantienen UUID propio y el mismo contrato histórico de operador.

**Motivo:** operación rápida y gestión simple cuando se contrata/despide personal.

---

## D-005 — Desactivar, no borrar historia

**Status:** Active

Empleados, productos y otras entidades con referencias históricas se desactivan en vez de hard-delete.

**Motivo:** preservar ventas, stock, turnos y auditoría.

---

## D-006 — Pricing por costo + markup

**Status:** Active

El flujo normal configura costo + porcentaje de ganancia sobre costo.

El precio de lista se obtiene por gross-up del descuento elegible.

**Motivo:** preservar el precio objetivo luego del descuento.

---

## D-007 — Descuento por medio de pago

**Status:** Active

Elegibles: CASH, TRANSFER, OTHER.

No elegibles: DEBIT, CREDIT.

El nombre técnico histórico `cash_discount` no redefine la regla de producto.

---

## D-008 — Descuentos secuenciales

**Status:** Active

Orden:

1. lista;
2. descuento de medio de pago;
3. promoción;
4. final.

Los porcentajes no se suman.

---

## D-009 — Snapshots históricos

**Status:** Active

Ventas conservan precios, descuentos, promociones y costo histórico suficiente para no reinterpretar el pasado con configuración actual.

---

## D-010 — Stock por ledger

**Status:** Active

El stock teórico se deriva del ledger/movimientos.

No introducir fuentes paralelas sin decisión explícita.

---

## D-011 — No stock central

**Status:** Active

No modelar actualmente el inventario del negocio/depósito principal del dueño.

**Motivo:** ya se controla por otro sistema y duplicaría trabajo; el dueño no tiene hoy tiempo de registrar ventas/movimientos ahí de forma sistemática, y preferimos una solución parcialmente automatizada pero confiable antes que una conceptualmente completa que nadie mantenga.

La vista "Stock por sucursal" (`/admin/branch-stock`) compara el stock conocido por el sistema entre sucursales operativas reales; no incluye la Central. Podrá incorporarse como sucursal/ubicación real en el futuro si empieza a mantener stock dentro del sistema.

**Aclaración (2026-09-22):** esta decisión es sobre no crear una entidad/depósito ficticio nuevo. No es una prohibición sobre sucursales reales existentes: Central ya es una fila real en `branches`, con ventas y stock igual que cualquier otra sucursal, y su stock se registra en `stock_movements` como el de cualquier sucursal desde que existen ventas online. D-033 configura Central como sucursal habitual de producción/recepción; eso no reintroduce el depósito que esta decisión descarta.

---

## D-012 — No inventarios físicos rutinarios obligatorios

**Status:** Active

La aplicación prioriza automatización y señales de excepción.

---

## D-013 — Reposición orientada a cobertura

**Status:** Active / implementación confirmada con limitación conocida

La app debe sugerir qué llevar por sucursal usando stock teórico + velocidad de venta + cobertura, preservando mínimo manual.

La ventana actual divide por siete días completos. El tratamiento de productos nuevos con poca historia queda pendiente de evidencia de uso real.

---

## D-014 — Ganancia bruta, no neta

**Status:** Active

Analítica comercial usa `revenue - costo histórico de mercadería`.

No llamar “ganancia neta” mientras no se modelen costos operativos completos.

---

## D-015 — Turnos no se autocorrigen

**Status:** Active

Si un empleado olvida marcar salida y supera el máximo normal, el turno pasa a revisión.

No inventar hora de salida.

---

## D-016 — Tarifa horaria histórica

**Status:** Active

Cambiar tarifa no modifica períodos anteriores.

---

## D-017 — Admin PWA antes que Admin nativo

**Status:** Active

Mantener despliegue web y agregar PWA.

No migrar Admin a Tauri sin una necesidad nativa concreta.

---

## D-018 — Performance antes de expandir Admin

**Status:** Active

La lentitud actual del Admin es una prioridad real.

Optimizar con medición, no por intuición.

---

## D-019 — Detección avanzada de inconsistencias postergada

**Status:** Active

No invertir ahora en un centro avanzado de anomalías/fraude.

Se retomará si el uso real lo justifica.

---

## D-020 — Agentes no son fuente de verdad por sí solos

**Status:** Active

Un reporte de Codex/Claude no convierte una feature en “verificada”.

Código, tests, migraciones y documentación reconciliada determinan estado real.

---

## D-021 — Reautenticación de operador tras reinicio

**Status:** Active

La sesión y autorización del dispositivo pueden persistir. Después de reiniciar el POS se debe volver a seleccionar operador e ingresar PIN; no se restaura automáticamente el operador activo.

---

## D-022 — Rendición como snapshot inmutable

**Status:** Active

Una venta offline que sincroniza después de confirmar una rendición no recalcula silenciosamente el snapshot. El Admin debe advertir que existieron movimientos posteriores.

---

## D-023 — Sucursal productiva ligada al dispositivo

**Status:** Active

En producción, la sucursal operativa proviene del enrolamiento del dispositivo. Un selector manual sólo puede existir como herramienta de desarrollo, setup o simulación.

---

## D-024 — Sesión de operador ligada al fichaje

**Status:** Active / implementación confirmada

Después del PIN, un operador sin turno debe marcar entrada antes de operar. `Salir` termina el turno activo mediante persistencia local/outbox y vuelve al selector, sin cerrar la sesión Auth del dispositivo.

El cierre normal de la ventana aplica el mismo clock-out local idempotente antes de intentar sincronizar. Un cierre abrupto o un shutdown que la plataforma no entregue al proceso no permite inventar una hora de salida; el turno abierto conserva el tratamiento `REQUIRES_REVIEW`.

---

## D-025 — Auth técnico desacoplado del acceso diario POS

**Status:** Active / implementación confirmada

La sesión Supabase pertenece al aprovisionamiento técnico del dispositivo. El flujo diario visible del empleado es selección de nombre, PIN y fichaje; nunca requiere email ni contraseña. Una caja sin autorización válida muestra un estado administrativo y sólo expone Auth mediante una acción explícita de configuración.

El polling preventivo de estado remoto usa una cadencia de 60 segundos. El contador visual del turno se actualiza con precisión de minutos en un timer independiente y no dispara sincronización.

---

## D-026 — Windows 7 Legacy: evaluado y abandonado

**Status:** Abandoned

Windows 7 Legacy support was evaluated and abandoned. The project will not support Windows 7. El POS sólo distribuye el build moderno Windows x64 (`pnpm build:pos:desktop`).

---

## D-027 — Debian 12 i386 como plataforma adicional de bajo recurso

**Status:** Active / implementación preparada; smoke real pendiente

Carnicerías POS soporta Windows moderno y se incorpora Debian 12 i386 como
plataforma Legacy para cajas de bajo recurso (netbooks tipo Atom N270, 2 GB
RAM). Windows 7 no está soportado (ver D-026).

Es el mismo código Tauri/React/Rust/SQLite, sin fork: sólo cambia el target
de compilación (`i686-unknown-linux-gnu`) y el empaquetado (`.deb` en vez de
NSIS). El frontend se compila en la máquina de desarrollo; el binario/paquete
Linux se genera de forma nativa dentro de un contenedor Debian 12 i386, no
por cross-compilación desde otra arquitectura. Detalle en `docs/LINUX_POS.md`.

---

## D-028 — Desposte: costo asignado por valor relativo de venta

**Status:** Active

El costo por producto obtenido en un desposte se distribuye proporcionalmente a su valor potencial de venta (`peso × precio vigente`), no por una estimación técnica del corte.

**Motivo:** es el método estándar para costos conjuntos cuando no existe un costo de compra individual por corte. Debe presentarse siempre como "costo asignado", nunca como costo de compra real.

---

## D-029 — Desposte consume/produce stock en el ledger existente

**Status:** Active

Un desposte finalizado escribe en `stock_movements` (el mismo ledger que ventas y operaciones de stock), usando dos tipos nuevos: `PRODUCTION_CONSUME` (negativo, insumo de origen) y `PRODUCTION_YIELD` (positivo, cada output). No se crea un segundo modelo de inventario.

**Motivo:** D-010 prohíbe fuentes paralelas de stock; el ledger ya existía cuando se implementó el módulo, por lo que corresponde integrarlo en vez de dejarlo desacoplado.

---

## D-030 — Reversión de desposte completado pospuesta

**Status:** Active

Un lote de desposte `COMPLETED` es histórico e inmutable. Cancelar sólo es válido en estado `DRAFT` (no tocó stock todavía). Corregir un lote ya finalizado requerirá un flujo de reversión/ajuste que no se construyó en este sprint.

**Motivo:** evitar reescritura silenciosa de historia (ver D-005, D-009) sin comprometerse todavía a diseñar reversión de stock antes de que exista evidencia de necesidad real.

---

## D-031 — Desposte es administrativo: vive en Admin, no en el POS

**Status:** Active

Desposte/Producción se gestiona únicamente desde Admin (`/admin/production`). El POS de mostrador no lo expone: no muestra costos de compra, costo asignado ni rentabilidad. Los permisos `production.read`/`production.write` son exclusivos del rol `admin`, igual que `settlements.*`/`analytics.read`; el empleado no los recibe.

**Motivo:** el POS es para tareas operativas de mostrador (vender, pesar, cobrar); costos y márgenes son información de gestión del dueño/administrador, no del empleado que atiende. La primera versión (sprint 2026-09-22) se implementó incorrectamente en el POS y se corrigió a Admin el mismo día tras revisión.

---

## D-032 — Materia prima como rol de producto, no catálogo paralelo

**Status:** Active

Un producto tiene un `inventory_role`: `RAW_MATERIAL`, `SELLABLE` (default, preserva el comportamiento de todo producto existente) o `BOTH`. No se crea una tabla ni un catálogo separado para insumos.

**Motivo:** el catálogo (`products`) ya es la fuente de verdad de todo lo que existe en el negocio; separar "insumos" en otra tabla duplicaría categorías, precios y el resto de la infraestructura de catálogo sin necesidad. El selector de insumo de Desposte usa este rol para dejar de ofrecer productos de venta terminados (vacío, costilla) como si fueran materia prima.

---

## D-033 — Central como sucursal habitual de producción, configurable

**Status:** Active

`organizations.production_branch_id` define qué sucursal usa el Desposte por defecto cuando no se indica una explícitamente. Es configurable desde Admin, no una sucursal ficticia nueva: normalmente será Central, que ya existe como sucursal comercial real (ventas, stock, empleados) y además es donde llegan las materias primas y se realiza el desposte físicamente.

**Motivo:** D-011 prohíbe modelar un depósito/inventario centralizado ficticio del dueño; esa decisión es sobre no crear una entidad nueva, no sobre impedir que una sucursal real como Central tenga stock y sea el destino habitual de recepción/producción. Configurar esto evita que Fran tenga que elegir sucursal manualmente en cada desposte (ver D-023, mismo principio que la sucursal del dispositivo POS).

---

## D-034 — Transferencias entre sucursales sobre el ledger existente

**Status:** Active

La distribución de stock entre sucursales (`stock_transfers`/`stock_transfer_items`, RPC `create_stock_transfer`) escribe en `stock_movements` usando `TRANSFER_OUT`/`TRANSFER_IN`, tipos que existían en el enum desde el sprint de ventas online pero nunca se habían usado. No se crea un segundo modelo de inventario. Alcance de este sprint: sólo productos `WEIGHT`, transferencia inmediata y atómica (sin confirmación de recepción en dos etapas).

**Motivo:** D-010 prohíbe fuentes paralelas de stock. Reutilizar los tipos de movimiento ya reservados para esto es más simple que diseñar un modelo nuevo, y mantiene "stock por sucursal" y "stock" (que ya suman `stock_movements` sin filtrar por tipo) correctos automáticamente, sin cambios.

---

## D-035 — Gestión real de sucursales: hard-delete sólo sin historial

**Status:** Active

Admin puede crear, editar y activar/desactivar sucursales (`save_branch`,
`set_branch_active`, migración `202609220028`). El borrado físico
(`delete_branch`) sólo se permite si la sucursal no tiene ninguna fila en
ventas, stock, rendiciones, turnos, dispositivos, despostes, transferencias,
auditoría o precios propios; si tiene cualquiera de esas, la función rechaza
el borrado y exige desactivar (`active = false`) en su lugar.

**Motivo:** aplica D-005 (desactivar, no borrar historia) a una entidad que
hasta ahora sólo se sembraba manualmente. `branches.write` y las policies de
insert/update en `branches` ya existían desde `202609100001` sin usarse; esta
decisión es sobre cómo se usa ese permiso, no un cambio de RLS nuevo.

---

## D-036 — Pre-production reset es manual, nunca automático

**Status:** Active

`scripts/pre-production-reset.sql` limpia datos operativos ficticios
(ventas, stock, turnos, rendiciones, dispositivos, empleados internos y
sucursales de prueba) preservando organización, admin, catálogo y precios.
Es una operación de una sola vez, manual, sin migración ni RPC ni botón de
Admin asociado, y exige backup + confirmación explícita en sesión
(`SET app.confirm_pre_production_reset = 'YES-DELETE-TEST-DATA';`) antes de
ejecutarse.

**Motivo:** pasar de datos demo a producción real es un evento único e
irreversible sobre datos reales; automatizarlo (migración, RPC, botón)
crearía una superficie de borrado accidental que no se justifica para algo
que ocurre una sola vez por instalación. Ver `docs/PRE_PRODUCTION_RESET.md`.
