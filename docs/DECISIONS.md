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

**Status:** Superseded by D-037

El flujo normal configuraba costo + porcentaje de ganancia sobre costo, y el precio de lista se obtenía por gross-up del descuento elegible.

**Motivo (histórico):** preservar el precio objetivo luego del descuento.

---

## D-007 — Descuento por medio de pago

**Status:** Superseded by D-044

Elegibles: CASH, TRANSFER, OTHER.

No elegibles: DEBIT, CREDIT.

El nombre técnico histórico `cash_discount` no redefine la regla de producto.

**Corrección 2026-09-24:** esta decisión describía la regla al revés de la intención real del
negocio. D-044 la reemplaza: el precio cargado en Productos ya es el precio de
CASH/TRANSFER/OTHER (sin ajuste), y DEBIT/CREDIT pagan ese precio más un recargo. La partición de
métodos (misma de siempre) y el nombre técnico `cash_discount` se conservan; sólo cambia qué lado
recibe el ajuste y en qué dirección.

---

## D-008 — Descuentos secuenciales

**Status:** Active (paso 2 reinterpretado por D-044)

Orden:

1. lista;
2. ajuste por medio de pago (recargo por tarjeta desde D-044; antes, un descuento — ver D-007);
3. promoción;
4. final.

Los porcentajes no se suman. El orden en sí (lista → medio de pago → promoción → final) no cambió con D-044, sólo la fórmula del paso 2.

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

## D-037 — Precio de venta manual; costo derivado de desposte o compra directa

**Status:** Active

El precio de venta (`product_prices`) deja de derivarse de costo + markup (D-006, ahora superseded). Pasa a ser una decisión manual del administrador (compite por precio de mercado), cargada directamente vía `set_product_price`/`bulk_set_product_prices` (migración `202609220030`). Cambiar el costo, el descuento por medio de pago o cualquier otra configuración comercial **nunca** recalcula ni sobrescribe un precio de venta ya cargado.

El costo (`product_costs`) pasa a ser el lado derivado: automático al finalizar un desposte (`complete_production_batch`, migración `202609220029`, alimenta `product_costs` con el costo asignado por valor relativo de venta de cada output) o manual vía `set_product_cost` para productos comprados ya terminados (sin desposte). Un producto puede tener precio sin tener costo todavía; eso es válido y se muestra como "costo no disponible", nunca se inventa.

`save_product_pricing`/`calculate_product_price`/`set_cash_discount_and_reprice` (D-006, migración `202609130012`) quedan intactas en la base de datos (historial, D-005) pero ninguna UI vuelve a llamarlas: el descuento por medio de pago se sigue configurando (`set_cash_discount`, migración `202609220030`), pero ya no repricea ningún producto.

**Motivo:** el negocio real fija precio mirando la competencia, no calculándolo desde un costo cargado a mano; el costo real surge de la producción (desposte) o de la compra, no al revés.

---

## D-038 — Desposte: outputs por peso, y opcionalmente también por unidad

**Status:** Active

Todo output de un lote de desposte (`production_batch_outputs`) registra su **peso real producido** (`output_weight_grams`, siempre obligatorio, para cualquier tipo de producto) — migración `202609220029`. Un output cuyo producto se vende por unidad (`UNIT`) registra **además** la cantidad de unidades obtenidas (`output_quantity_units`, obligatoria sólo en ese caso).

Dos usos distintos y no intercambiables del mismo lote:

- **Valor comercial / asignación de costo** (D-028): para un output `WEIGHT`, peso × precio/kg; para un output `UNIT`, cantidad × precio/unidad. El peso real de un output `UNIT` (p. ej. 2 arrollados = 2,640 kg) **nunca** interviene acá — la asignación de costo por valor relativo de venta (`allocateProductionCost`/`compute_production_preview`) ya era agnóstica al tipo de medida, sólo necesita el valor de venta potencial en centavos.
- **Merma/rendimiento**: `waste_grams = input_weight_grams - SUM(output_weight_grams de TODOS los outputs, sean WEIGHT o UNIT)`. Un output `UNIT` sigue siendo materia física del lote y su peso real debe contar para este balance, aunque no determine su valor comercial.

El costo asignado a un output `UNIT` se expresa igual como costo/unidad (nunca costo/kg) al alimentar `product_costs`, porque así se cotiza ese producto en todo el resto del sistema (precio, ventas).

`products.approx_weight_grams` (opcional, migración `202609220029`) es distinto de lo anterior: es una referencia informativa **por producto**, no ligada a ningún lote (p. ej. "cabeza entera, aprox 5 kg" en la ficha del producto); nunca se usa en ningún cálculo de precio, costo, asignación o balance de merma — para eso siempre se usa el peso real cargado en el lote (`output_weight_grams`).

**Motivo:** el negocio real desposta piezas que se venden por unidad (cabeza entera, arrollado) junto con cortes por peso en el mismo lote, y esas piezas siguen siendo materia física real del animal: omitir su peso subestimaría la merma real del lote. El modelo de asignación por valor comercial ya soportaba el caso `UNIT` matemáticamente; sólo faltaba conservar también su peso físico para el balance.

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

---

## D-039 — Promociones: PACK_FIXED_TOTAL junto a THRESHOLD

**Status:** Active

`product_weight_discounts` gana `promotion_mode` (`THRESHOLD` | `PACK_FIXED_TOTAL`, default `THRESHOLD`). THRESHOLD es exactamente el modelo anterior (porcentaje/precio fijo por kg desde una cantidad mínima), sin cambios de comportamiento ni de columnas. PACK_FIXED_TOTAL es una cantidad concreta a precio total fijo (ej. "Vacío 2kg por $18.000", "Hamburguesa 40u por $28.000"): columnas nuevas `pack_quantity_grams`/`pack_quantity_units` (una sola, según `unit_type` del producto, mismo patrón que `production_batch_outputs`) y `pack_price_cents`. No es un umbral "desde X": no escala con la cantidad, no admite tolerancia inventada. `save_weight_discount` (migración `202609230031`) ganó parámetros opcionales al final, sin romper la firma existente.

Decisiones de negocio confirmadas por el usuario:
- **WEIGHT**: el pack cobra su precio total configurado sin importar el peso real pesado (una pieza prearmada nunca da el peso nominal exacto); el peso real sigue registrándose para stock/trazabilidad. Guarda de cordura: el precio del pack no puede superar el precio de **lista** para el peso realmente pesado (nunca compara contra el precio ya descontado por medio de pago); en la práctica no se dispara con la variación real de una pieza prearmada.
- **UNIT**: aplica automáticamente en múltiplos exactos (80 = 2×40); el resto se vende a precio normal, sin descuento inventado para una cantidad parcial.

El POS de mostrador conecta ambos modos al flujo de venta real (ver D-042 para el detalle de la venta `UNIT`): pack **WEIGHT** vía toggle explícito "Vender como pack" en el modal de peso; pack **UNIT** automático por múltiplos exactos de la cantidad tipeada. `complete_discounted_sale`/`sync_offline_sale`/`insert_sale` (Rust) validan el precio del pack server-side, igual online y offline.

**Motivo:** el negocio real vende piezas prearmadas y packs de cantidad a un precio comercial fijo, no un descuento por kg calculado a mano; forzar ese caso dentro del modelo de umbral hubiera exigido inventar una semántica ("desde 2kg cuesta $9.000/kg") que no es lo que el dueño realmente ofrece.

---

## D-040 — Corregir forma de venta (WEIGHT ↔ UNIT) sólo sin historial operativo

**Status:** Active

`save_product` (migración `202609230032`) bloquea un cambio de `unit_type` si el producto tiene cualquier fila en `sale_items`, `stock_movements`, `production_batch_outputs`/`production_batches.source_product_id`, o `product_weight_discounts` (activa o no). Precio y costo (`product_prices`/`product_costs`) **no** bloquean: son montos sin semántica de peso/unidad propia. Sin historial bloqueante, el cambio se aplica igual que antes (Admin ya lo permitía sin guarda alguna — el único freno real era que el modal de edición mandaba `unit_type` oculto). Ningún dato existente se reinterpreta: 3000 gramos nunca pasa a leerse como 3000 unidades.

**Motivo:** estamos pre-producción, así que corregir un producto creado con el tipo de venta equivocado es especialmente valioso ahora; pero `save_product` ya aceptaba el cambio sin ninguna protección apenas se habilitara el selector en el modal de edición, así que la guarda se agrega en el mismo cambio que habilita ese selector, no después.

---

## D-041 — Un producto puede tener varias categorías; una queda como principal

**Status:** Active

`product_category_assignments` (migración `202609230033`) es el set completo de categorías de un producto; `products.category_id` sigue siendo la categoría **principal** (color/nombre en las pantallas que sólo necesitan una etiqueta, sin cambios ahí). `set_product_categories` reconcilia ambos atómicamente y agrega la principal al set automáticamente si faltara, en vez de rechazar. El filtro por categoría del POS (`pull_pos_state`/`get_pos_catalog`, ambos con `categoryIds` nuevo) considera todas las categorías asignadas; "Todos" no cambia (ya es la lista completa sin iterar por categoría, nunca duplica un producto multicategoría). El filtro de `/admin/products` sigue usando sólo la categoría principal — el pedido sólo exigía multicategoría real en el POS.

**Corrección 2026-09-23 (ver D-043):** la limitación original ("el tab sale de la categoría principal de algún producto, una categoría 100% secundaria no tiene nombre/color propio") quedó resuelta: las tabs ahora vienen de un directorio de categorías explícito (`get_pos_categories`, tabla SQLite `catalog_categories`), no de ningún producto. Una categoría usada sólo como secundaria (ej. Embutidos, si ningún producto la tiene como principal) genera su tab igual, con su propio nombre/color reales.

**Motivo:** D-005/D-010 (no duplicar fuentes de verdad, desactivar en vez de reescribir) aplican igual acá: agregar multicategoría no debía significar dos modelos de "categoría de un producto" corriendo en paralelo sin reconciliación explícita.

---

## D-042 — Venta `UNIT` end-to-end en el POS (online y offline)

**Status:** Active

El POS de mostrador vende productos `UNIT` igual que `WEIGHT`, con el mismo motor comercial (D-008: lista → descuento por medio de pago → promoción → final) y sin balanza: tocar el producto abre un stepper de cantidad entera (`[-] 1 [+]` + input manual, mínimo 1), nunca el flujo de peso. El pack `UNIT` (D-039) se aplica automáticamente por múltiplos exactos de la cantidad tipeada, sin toggle (a diferencia del pack `WEIGHT`, que sí requiere confirmación explícita porque el peso real nunca calza exacto). "Modificar cantidad" edita la línea en el lugar, igual que "Modificar peso" para `WEIGHT`.

Stock: `sale_items` gana `quantity_units` (columna separada de `weight_grams`, ambas nullable, `CHECK` exige exactamente una de las dos — no se reutilizó `weight_grams` para no mezclar semánticas de kg/unidades en un mismo campo sin separar, ver regla de "Unidades y precisión"). `stock_movements.quantity_grams` sí se reutiliza como contador de unidades con signo para una venta `UNIT`, siguiendo el precedente ya existente de `PRODUCTION_YIELD` (D-038) — no se agregó una columna paralela en el ledger. `approx_weight_grams` nunca interviene en el cálculo ni en el stock de una venta `UNIT`.

Funciona igual online (`complete_discounted_sale`) y offline (SQLite `local_sale_items`/`insert_sale`, outbox, `sync_offline_sale`, reintento, idempotencia, recuperación tras reinicio) — mismo validador de negocio replicado en Rust y en SQL, no hay una ruta "sólo online".

**Migraciones:** Postgres `202609230034_unit_sale_support.sql` (columna `sale_items.quantity_units`, `complete_discounted_sale`/`sync_offline_sale` con la rama UNIT, y `CREATE OR REPLACE` de cuatro funciones preexistentes que ya asumían que `weight_grams` podía representar unidades — ver "Compatibilidad con RPCs preexistentes" abajo). SQLite `009_unit_sale_support.sql` (rebuild no destructivo de `local_sales`/`local_sale_items` para relajar `weight_grams`/agregar `quantity_units` preservando historial ya confirmado).

**Compatibilidad con RPCs preexistentes:** `get_profitability_analytics`, `get_replenishment_plan`, `cancel_sale` y `get_admin_dashboard` (todas de sprints anteriores a éste) ya leían `sale_items.weight_grams` asumiendo que ahí vendría también la cantidad de una venta `UNIT`. Separar `quantity_units` en una columna propia las hubiera roto — en particular `cancel_sale`, que habría crasheado con una violación NOT NULL en `stock_movements.quantity_grams` al anular cualquier venta con una línea `UNIT`. Las cuatro se reemplazaron (`CREATE OR REPLACE FUNCTION`, misma firma) usando `coalesce(weight_grams, quantity_units)` donde antes leían sólo `weight_grams`. Limitación cosmética aceptada y documentada: los widgets de "top productos por kg" del dashboard admin siguen etiquetando en kg un valor que para un producto `UNIT` es en realidad su cantidad de unidades; no afecta ranking por ingresos ni rentabilidad (que usan centavos, no gramos).

**Motivo:** el pedido original sólo modeló el pack `UNIT` en Admin/Promociones (D-039) y dejó la venta POS de `UNIT` fuera de alcance explícitamente. Este sprint la pide completa — "no implementar UNIT sólo para el POS conectado" — porque hay productos reales (hamburguesas) que se venden por unidad y hoy son invisibles en el mostrador.

---

## D-043 — Directorio de categorías del POS, independiente de la categoría principal de cualquier producto

**Status:** Active

Las tabs de categoría del POS no se infieren filtrando productos por `category_id` principal. Existe un directorio de categorías explícito y sincronizado: `get_pos_categories(p_branch_id)` (online) y la tabla SQLite `catalog_categories` (offline, poblada desde `categories` en `pull_pos_state`), con id/nombre/color/orden/activa. `apply_catalog_pull` (Rust) reconcilia esta tabla marcando todo inactivo y luego dando de alta el set fresco como activo (nunca `DELETE`, para no violar la FK de un producto local desactivado-no-borrado que todavía referencia una categoría vieja).

Una categoría con al menos una asignación real (`product_category_assignments`, sea principal o secundaria) entra en el directorio y genera su tab con su propio nombre/color, sin depender de si algún producto la tiene como principal. Una categoría sin ninguna asignación puede omitirse. `products.category_id` (categoría principal) sigue existiendo sin cambios para color/etiqueta de la card de un producto individual y para consumidores legacy de una sola categoría — pero deja de ser la única fuente de qué tabs existen.

**Motivo:** corrige una limitación real de D-041 (v1): una categoría usada sólo como secundaria (ej. "Embutidos", si ningún producto la tiene como principal — caso concreto: "Chorizo de cerdo" con principal Cerdo y secundaria Embutidos) no generaba tab propia. El pedido de este sprint lo señaló explícitamente: "no inferir las tabs solamente desde `products.category_id`".

---

## D-044 — Recargo por tarjeta en vez de descuento por efectivo: el precio cargado ES el precio de efectivo/transferencia

**Status:** Active

Corrige/invierte D-007: el precio manual cargado en Productos (`product_prices.price_cents`) es el precio de **CASH/TRANSFER/OTHER directamente, sin ningún ajuste**. **DEBIT/CREDIT** ("Tarjeta" en el POS) pagan ese mismo precio **más un recargo** configurado como porcentaje.

Ejemplo (el mismo de la aclaración original): precio cargado $10.000, recargo configurado 10% → CASH = $10.000, TRANSFER = $10.000, DEBIT = $11.000, CREDIT = $11.000.

Antes de esta decisión el precio cargado era el precio de lista sin descuento, CASH/TRANSFER/OTHER pagaban ese precio menos un descuento configurado, y DEBIT/CREDIT pagaban el precio de lista sin cambios. La partición de métodos (CASH/TRANSFER/OTHER de un lado, DEBIT/CREDIT del otro) es la misma de siempre — D-044 sólo invierte qué lado recibe el ajuste bps y en qué dirección (resta → suma).

**Orden de cálculo**: lista → promoción/pack (evaluada siempre contra la lista, nunca contra un precio ya recargado) → recargo por tarjeta, aplicado en un único paso multiplicativo sobre el resultado comercial completo. El recargo nunca se aplica antes de la promoción ni sólo a una parte del resultado.

**Nombres físicos conservados, sin migración destructiva de renombrado** (decisión explícita del pedido): `organization_cash_discounts.cash_discount_bps`, `sale_items.cash_discount_bps`/`cash_discount_cents`, y el helper `app_private.payment_method_receives_discount`/`payment_method_receives_discount` (Rust) mantienen sus nombres. `cash_discount_bps` ahora configura el **porcentaje de recargo**, no un descuento. `cash_discount_cents` (por línea) es **siempre 0** para toda venta posterior a este sprint — ningún medio de pago da descuento ya — pero se conserva sin tocar en cada fila histórica (D-005/D-009, snapshots inmutables). El concepto genuinamente nuevo (cuánto sumó la tarjeta) vive en una columna nueva: `sale_items.card_surcharge_cents`/`local_sale_items.card_surcharge_cents` (`>= 0`).

**PACK_FIXED_TOTAL: SIN excepción al recargo (corregido 2026-09-24)**: el total de un pack (D-039) sigue siendo invariante al peso/cantidad real (eso no cambió), pero **no** es invariante al medio de pago — pagar con tarjeta recarga el total completo del pack, sin excepción. Ejemplo obligatorio: "Vacío 2kg por $18.000" → DEBIT/CREDIT = $19.800 (18.000 × 1,10). Para un pack `UNIT` con remanente, el recargo se aplica al **total comercial completo** (packs enteros + remanente), nunca sólo al remanente: 45 hamburguesas (1 pack de 40 a $28.000 + 5 sueltas a $800 = $32.000 en efectivo) → tarjeta = $35.200 (32.000 × 1,10), **no** $28.000 + 5×$880 = $32.400.

**Historia de esta decisión (misma sesión, 2026-09-24)**: la primera implementación de D-044 asumió, por interpretación propia y no confirmada, que un pack debía quedar invariante al medio de pago igual que ya lo es al peso/cantidad real (mismo criterio conservador que D-039 aplicó a la ambigüedad de la promoción). El usuario corrigió esto explícitamente: "TODO lo que se pague con tarjeta lleva el porcentaje de recargo configurado. No hay excepción para promociones ni packs." Motivo de negocio: al comercio le cobran ese porcentaje sobre el importe real cobrado, sea cual sea ese importe — un pack no es una excepción a ese costo real. La migración `202609240035` (todavía no aplicada a ningún entorno en ese momento) se corrigió en el lugar en vez de crear una nueva.

**Capas tocadas**: `packages/business-logic/src/pricing.ts` (`isCardSurchargePaymentMethod`, reemplaza `isDiscountEligiblePaymentMethod`; las tres funciones de pricing ganan `cardSurchargeCents`; el pack WEIGHT aplica el recargo a `packPriceCents` completo, el pack UNIT lo aplica a `packPriceCents × wholePacks + listPriceCents × remainderUnits` completo — nunca sólo al remanente), Postgres (`202609240035_card_surcharge_pricing.sql`, migración nueva — ver más abajo por qué no se editaron 031/034), Rust (`insert_sale`, mismos cuatro casos WEIGHT/UNIT × pack/normal, con el mismo orden lista→promoción→recargo y el mismo redondeo en dos pasos que la versión pura de TS para evitar que un redondeo directo sobre el total diverja del redondeo por unidad), SQLite (`010_card_surcharge_pricing.sql`), POS (`apps/pos/src/App.tsx`: ticket y modal muestran "Recargo tarjeta" en ámbar, incluida una línea pack; el efecto de recálculo al cambiar de método de pago vuelve a buscar el precio real del pack en la regla vigente en vez de reusar `line.subtotalCents`, que ahora puede venir ya recargado de un cálculo anterior con otro método — bug real encontrado y corregido durante esta misma corrección), Admin (`pricing-settings-modal.tsx`: copy "RECARGO POR TARJETA").

**Migración nueva, no edición de 031/034**: a diferencia de rondas anteriores del mismo sprint, esta vez se confirmó evidencia directa (una tarea previa de este mismo día) de que al menos parte de las migraciones `031`–`034` ya están aplicadas en un entorno real del usuario — por lo tanto no se editaron más; el cambio de este sprint se agregó como una migración nueva e incremental (`202609240035`), con `CREATE OR REPLACE FUNCTION` sobre las mismas firmas. La corrección del mismo día (pack sin excepción) se aplicó editando esa misma migración `202609240035` en el lugar, tras confirmar que seguía sin aplicarse en ningún entorno.

**Bug encontrado y corregido en la misma migración**: `get_pos_commercial_config` (tal como quedó después del `CREATE OR REPLACE` de la migración `202609230031`, que le agregó los campos de pack) había perdido por completo la clave `cashDiscountBps` del jsonb devuelto — el POS nunca recibía el porcentaje configurado. Corregido en `202609240035` junto con el resto del cambio (no es la causa raíz de la regla de negocio invertida, que era el motivo real y explícito del pedido, pero sí un bug real que hubiera impedido ver cualquier ajuste por medio de pago, en cualquier dirección, una vez esa migración se aplicara).

**Motivo:** el negocio real fija el precio mirando lo que cobra en efectivo/transferencia; la tarjeta cuesta más porque el comercio paga un arancel sobre el importe real cobrado, y ese costo se traslada como recargo explícito sobre ese mismo importe — sin excepciones para promociones o packs, porque el arancel tampoco hace esa excepción.

**Corrección de despliegue encontrada el 2026-09-25**: la suposición de la sesión anterior de que `202609240035` seguía "local-only" al momento de corregirla in-place era incorrecta. `supabase migration list --linked` (2026-09-25) muestra `202609240035` como aplicada tanto local como remotamente — es decir, ya se había hecho `db push` de la versión del round 1 (pack invariante al medio de pago) antes de la corrección del mismo día. Como Supabase no vuelve a ejecutar una versión de migración ya marcada como aplicada, editar `202609240035` en el lugar sólo actualizó el archivo local; el proyecto remoto real siguió corriendo la lógica de pack invariante hasta esta auditoría. Se agregó `202609250036_card_surcharge_pack_exception_fix.sql`, una migración nueva e incremental que vuelve a aplicar (`CREATE OR REPLACE FUNCTION`) exactamente los mismos cuerpos ya corregidos de `complete_discounted_sale` y `sync_offline_sale` de `202609240035` — sin cambios de DDL, porque las columnas nuevas ya están en remoto. Todavía no se hizo push de `202609250036`.

Además, se confirmó que el ejecutable/instalador del POS Desktop en `apps/pos/src-tauri/target/release/` fue compilado el 2026-09-24 02:14, antes de los commits `2ee343a` (03:08, round 1) y `39113d2` (2026-09-25 00:45, round 2/corrección) — cualquier instalación hecha con ese build corre la regla de negocio completamente anterior a D-044 (tarjeta = precio base, efectivo/transferencia = descuento). No es un bug de código: requiere recompilar y reinstalar.
