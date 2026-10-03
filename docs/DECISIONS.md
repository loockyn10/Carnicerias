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

La distribución de stock entre sucursales (`stock_transfers`/`stock_transfer_items`, RPC `create_stock_transfer`) escribe en `stock_movements` usando `TRANSFER_OUT`/`TRANSFER_IN`, tipos que existían en el enum desde el sprint de ventas online pero nunca se habían usado. No se crea un segundo modelo de inventario. Alcance original: sólo productos `WEIGHT` (ampliado a `UNIT` en D-051), transferencia inmediata y atómica (sin confirmación de recepción en dos etapas).

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

---

## D-045 — Heartbeat/lease de presencia para control horario: evidencia real habilita cerrar un turno sin esperar el máximo normal

**Status:** Active

**Contexto de la regresión (auditoría 2026-09-28)**: el control horario documentado (D-015/D-024) ya cubría el cierre normal de ventana (`CloseRequested`, JS y Rust, ambos idempotentes contra el mismo comando Tauri) con un clock-out local/outbox antes de cualquier red. Pero no existía ningún mecanismo — ni Rust ni JS — para el caso en que el proceso muere **sin** entregar `CloseRequested`: Task Manager, apagado forzado de Windows, corte eléctrico. En ese caso el turno quedaba `OPEN` sin ninguna señal de vida hasta que `app_private.mark_overdue_shifts` (el único mecanismo existente) se disparara — y esa función **no está agendada** (no hay `pg_cron`; corre sólo como efecto secundario de otro RPC: roster, próximo fichaje, o que un admin abra `/admin/timekeeping`). En la práctica, un turno huérfano podía seguir contando como `OPEN` durante horas si nadie disparaba esos RPCs, y el empleado quedaba bloqueado para volver a fichar (un solo turno abierto por empleado) hasta una corrección manual. No era un bug de un sprint anterior: era la brecha explícita que D-024 dejaba documentada ("shutdown, kill forzado, crash o corte eléctrico no garantizan ejecutar el handler").

**Decisión**: agregar una lease de presencia (`employee_shifts.last_heartbeat_at`, `local_employee_shifts.last_heartbeat_at`) actualizada cada ~30 s mientras el turno está `OPEN` — local siempre, reflejada al servidor (RPC `record_shift_heartbeat`) sólo cuando hay conexión, sin generar una fila histórica por tick. Grace de 90 s desde el último heartbeat recibido: pasado ese umbral, tanto el sweep server-side (`app_private.mark_overdue_shifts`, extendido) como la reconciliación al reiniciar el POS (`reconcile_stale_open_shifts` en Rust, corre en cada arranque) cierran el turno usando el **último heartbeat conocido** como `clock_out_at` — nunca "ahora" ni el momento de reconexión — y lo marcan `REQUIRES_REVIEW` + `auto_closed_by_heartbeat` (reutiliza el estado existente, no se inventa uno nuevo).

**Esto no contradice D-015/D-024, los precisa**: la regla "no inventar una hora de salida" sigue vigente para el caso sin evidencia (turno vencido con heartbeat todavía fresco — la app sigue viva, sólo se olvidaron de fichar salida: `clock_out_at` sigue quedando `null`, sin cambios). El heartbeat introduce un caso distinto: cuando SÍ hay evidencia real y reciente de presencia (el último tick antes de que el dispositivo dejara de responder), usar esa evidencia para fijar el fin efectivo del turno no es inventar — es la misma lógica que ya aceptaba el negocio para el cierre normal, aplicada al último punto de contacto conocido en vez de al momento del clic en "Salir". El usuario aceptó explícitamente la imprecisión resultante (un corte de luz puede dejar una hora aproximada al último heartbeat) a cambio de no acumular horas indefinidamente; Admin conserva la corrección con motivo para ajustar la hora exacta si se conoce.

**Capas**: Postgres (`202609280037_shift_heartbeat_lease.sql`: columnas nuevas + índice, `record_shift_heartbeat` nuevo, `mark_overdue_shifts`/`apply_employee_time_event`/`sync_offline_time_event`/`correct_employee_shift`/`get_timekeeping_report` vía `CREATE OR REPLACE`, mismo patrón que D-039/D-044), SQLite (`011_shift_heartbeat.sql`, columna nueva), Rust (`record_shift_heartbeat_local`, `reconcile_stale_open_shifts` — corre en cada arranque de `initialize_connection`, antes de que se pueda seleccionar operador), POS (`apps/pos/src/App.tsx`, tick cada 30 s mientras `shift.status==='OPEN'`, local siempre + remoto best-effort), Admin (`/admin/timekeeping`: badge "Cierre automático (heartbeat perdido)" y el formulario de corrección prellena la hora inferida).

**Motivo:** el negocio no puede tolerar que un turno siga contando horas después de que el empleado dejó físicamente de operar el POS, pero tampoco quiere perder la capacidad de revisión/corrección existente ni arriesgar horas inventadas para el caso genuinamente sin evidencia.

---

## D-046 — Importador genérico: nunca pisa ni fusiona lo que no creó; preview obligatorio

**Status:** Active

La migración desde SimplyGest (y cualquier fuente futura) pasa por una capa genérica en base de datos: `import_batches` → `import_rows` (staging) → `external_entity_links` (`source_system + entity_type + external_id → UUID interno`), con RPCs `create/stage/preview/apply/cancel_import_batch`. El esquema no conoce SimplyGest; el mapeo de columnas vive en un mapper fuera de la base. Reglas:

- **Preview obligatorio y fiel**: `apply` no corre sin un preview vigente y re-clasifica cada fila antes de escribir; si algo cambió, aborta (`40001`). Todo el lote se escribe en una transacción.
- **Idempotencia por código externo, no por nombre**: el mismo `external_id` siempre resuelve al mismo registro; un archivo sin cambios (hash igual) da `IGNORE`.
- **Sin fusiones silenciosas**: un SKU/barcode/nombre que choca con un registro no creado por la importación es `ERROR`; adoptar registros existentes requiere declarar `options.linkExistingBy`. Dos filas que apuntan al mismo registro → la segunda es `ERROR`.
- Reutiliza las RPCs existentes (`save_product`, `set_product_price`, `set_product_cost`, `set_product_categories`, …): todas las guardas (D-040), historial append-only y triggers de sync del POS aplican igual que a una edición manual.
- Permisos nuevos `imports.read`/`imports.write` (sólo `admin`); además se exige el permiso de la entidad (`products.write`/`stock.write`). Tope de 1000 filas por lote por el `statement_timeout` de la API.
- **Sucursal destino (actualizado, D-049):** un lote de productos exige sucursal destino y los productos que **crea** quedan habilitados sólo ahí (los que sólo actualiza no cambian su surtido); el stock inicial va sólo al ledger de su sucursal y exige el producto habilitado en ella.

**Motivo:** una migración masiva que duplica productos o pisa precios corregidos a mano es peor que no migrar; el dueño debe ver "650 nuevos / 120 actualizaciones / 15 errores" antes de confirmar y poder re-ejecutar sin miedo.

---

## D-047 — Stock migrado entra al ledger como `OPENING_BALANCE`; no existe `current_stock`

**Status:** Active

El stock actual de otro sistema se convierte en un movimiento `OPENING_BALANCE` (positivo, `import_batch_id`) de `stock_movements`, el mismo ledger de D-029/D-034. No se agrega ninguna columna mutable de stock. Una apertura por (sucursal, producto) en toda la historia (índice único parcial): si el producto ya tiene movimientos en la sucursal, la fila se ignora; corregir es un ajuste por conteo físico. No genera eventos de reposición. Tipo propio (no `PURCHASE`/`ADJUSTMENT_POSITIVE`) para distinguir arrastre de stock en el corte de compras reales y de correcciones.

**Motivo:** una segunda fuente de verdad divergiría del ledger; un tipo propio mantiene trazables y separables los informes.

---

## D-048 — Códigos de barras en tabla propia; `sku` sigue siendo el código interno

**Status:** Active

`product_barcodes(organization_id, product_id, barcode)` con `unique (organization_id, barcode)`: un producto puede tener varios códigos y un código resuelve exactamente a un producto. `products.sku` no cambia (código interno, único por organización). Se guardan normalizados (trim, sin espacios, mayúsculas). RPCs `set_product_barcodes` (reemplaza el conjunto, idempotente) y `resolve_product_barcode`. Un cambio de barcodes registra un cambio `PRODUCT` en `pos_catalog_changes` para que viaje por el cursor de sync existente.

Alcance: el POS todavía **no** recibe ni usa barcodes (siguiente sprint: `barcodes` en `pull_pos_state`, tabla SQLite, resolución local offline y alta al ticket). Los productos por peso de carnicería no cambian (cero barcodes).

**Motivo:** un escáner emite el código del empaque; modelarlo aparte del SKU evita ambigüedad y permite múltiples códigos sin tocar el catálogo de carnicería.

---

## D-049 — Surtido por sucursal: relación propia, distinta de stock y de política de stock

**Status:** Active

Qué productos vende cada sucursal es `branch_product_assortment(branch_id, product_id)` (presencia = habilitado). **No** se reutilizó `branch_product_stock_settings`: esa tabla es una política de reposición (mínimo/objetivo) cuyas filas sólo existen si alguien configuró un umbral y cuya ausencia significa "sin política", no "no se vende"; usarla (o usar "tiene stock") como surtido haría desaparecer un producto del POS al agotarse y habilitaría productos por configurar un mínimo. Reglas:

- habilitado + stock > 0 → visible y vendible; habilitado + stock <= 0 → visible como "Sin stock" (la fila sigue existiendo) **salvo en el POS de Central, donde la disponibilidad no depende del stock (D-058)**; no habilitado → no llega al POS de esa sucursal (`pull_pos_state`/`get_pos_catalog` filtran; lo que deja de estar habilitado viaja en `removedProductIds`; las tabs de categoría sólo listan categorías con algún producto habilitado).
- Migración de datos: todo producto existente queda habilitado en toda sucursal existente (las carnicerías conservan exactamente su catálogo).
- Un producto **nuevo** no se habilita solo: Admin lo pide al crearlo (por defecto todas las sucursales marcadas) y el importador lo habilita sólo en la sucursal destino (D-046). Una sucursal **nueva** empieza sin surtido; al crearla se puede copiar el de otra (`copy_branch_assortment`).
- Deshabilitar borra la fila (configuración, no historia: ventas, stock y precios conservan sus snapshots) y queda auditado; si el producto aún tiene stock ahí, la RPC lo informa y el stock se conserva en el ledger.
- Las ventas ya hechas offline no se validan contra el surtido al sincronizar (una venta real no se rechaza por un cambio de catálogo posterior). Sí se exige surtido en el **destino** de una transferencia y para cargar stock inicial (`NOT_IN_ASSORTMENT`), para que el stock nunca aterrice donde el producto no se vende.
- Stock, reposición y alertas de Admin sólo consideran los productos habilitados en cada sucursal.

**Motivo:** Central es carnicería + almacén; Avenida y Janssen sólo carnicerías. Un catálogo cuyo alta masiva no inunde las otras sucursales exige un concepto explícito de "qué vende cada una".

---

## D-050 — Escáner de código de barras en el POS: resolución local, sin llamadas por escaneo

**Status:** Active

Los barcodes viajan en el catálogo (`pull_pos_state` → `barcodes` por ítem → SQLite `catalog_product_barcodes`, migración `013`) junto con el surtido y el snapshot de stock ya existentes; un escaneo nunca llama a Supabase y funciona offline con el último estado sincronizado. Flujo (scanner USB/HID tipo teclado, código + Enter): se detecta por cadencia de teclas (ráfaga ≤ 80 ms entre caracteres; el tipeo humano no cuenta) y sólo con la pantalla de venta activa, sin modal y sin foco en un campo de texto; si el escáner escribe dentro del buscador, Enter resuelve igual.

- código de un producto del catálogo de la sucursal, `UNIT`, con stock → suma **1 unidad** (un segundo escaneo del mismo producto incrementa su misma línea, con el mismo pricing/pack/recargo que la carga manual);
- `WEIGHT` → abre el flujo de peso/balanza existente; nunca se vende por unidad por accidente;
- habilitado pero sin stock → "<producto>: Sin stock", no se agrega (en **Central nunca ocurre: D-058** reemplazó la excepción de D-052 por una regla general);
- código desconocido **o** de un producto no habilitado en la sucursal → "Producto no encontrado", no se agrega (el POS de una sucursal sólo conoce su propio catálogo, así que ambos casos son indistinguibles por diseño y no se filtran códigos de otras sucursales).

**Motivo:** el mostrador no puede esperar red por cada botella, y el surtido por sucursal ya define qué existe en cada POS.

---

## D-051 — Stock `UNIT` en Admin sobre el mismo ledger; el catálogo grande se pagina en SQL

**Status:** Active

El ledger ya guardaba unidades enteras en `quantity_grams` para `UNIT` (D-038/D-042); Admin deja de asumir kilos: estado de stock, compras, mermas, ajustes y transferencias operan en **kg para `WEIGHT` y unidades enteras para `UNIT`**, decidido siempre por el `unit_type` real del producto en el servidor (no por el formulario). kg y unidades nunca se suman (transferencias: `total_weight_grams` sólo `WEIGHT`, `total_units` sólo `UNIT`). Esto amplía D-034 (antes sólo `WEIGHT`). `get_branch_stock_status` ganó `unit_type`, filtros y paginación; `get_branch_stock_summary` da los conteos para el dashboard.

Un catálogo de miles de productos (Central) no se carga entero: listados y selectores filtran/paginan en SQL (`list_products_page`, `search_products`, `get_branch_stock_status` con límite) o pasan por `fetchAllRows` (PostgREST trunca **en silencio** a `max_rows` = 1000). Las semánticas de estado de stock (crítico = sin stock, etc.) no cambiaron.

**Motivo:** el almacén sólo es operable si su stock se ve y se mueve en unidades, y las pantallas no pueden romperse ni perder filas al crecer el catálogo.

---

## D-052 — Alta rápida de producto desde el scanner en Central; excepción de stock sólo para el escaneo

**Status:** Active

En el POS de Central (almacén), un barcode desconocido abre un modal con nombre, costo (opcional) y precio; `create_pos_quick_product` crea todo en una única transacción de base de datos (producto `UNIT`/`SELLABLE`/activo sin SKU, categoría real `Almacen` resuelta por id en el servidor, barcode, surtido **sólo de la sucursal del dispositivo**, precio global, costo si vino, auditoría) y el POS lo suma al ticket. Reglas:

- **Autorización estrecha, sin elevar al dispositivo:** la cuenta Supabase del POS es técnica (rol empleado: sin `products.write`/`prices.write`). La RPC exige dispositivo activo + token de operador vigente (PIN) + permiso `products.quick_create` **del operador** (admin y employee) + dispositivo en la sucursal **productiva configurada** de la organización (`organizations.production_branch_id`, D-033; sin configurar = fail-closed). No reutiliza `save_product`/`set_product_price` (exigen permisos de Admin sobre `auth.uid()`); sí reutiliza los helpers privados compartidos con Admin y el importador (slug único, barcode normalizado/único, surtido).
- **Duplicados:** el POS sólo llama al servidor con un barcode desconocido localmente. Antes de abrir el modal, en línea, el POS pregunta al servidor (`resolve_pos_scan_barcode`) si el código ya existe en la organización; el servidor serializa por organización y busca el barcode antes de crear: si ya existe no crea nada. Si era un producto **activo, con precio y categoría activa que todavía no estaba en el surtido de Central, se habilita sólo en Central** (`branch_product_assortment`, auditado con el operador) y se devuelve para sumarlo al ticket sin modal (`EXISTS_ENABLED`; `EXISTS_SELLABLE` si ya se vendía ahí); un producto inactivo o sin precio **no se reactiva ni se habilita** (`EXISTS_UNSELLABLE`, sólo se informa). Esto es una excepción acotada a D-049, válida únicamente para el flujo de scanner de Central. La restricción única `(organization_id, barcode)` sigue siendo la última garantía. Repetir la llamada es idempotente.
- **Sin cola offline:** sin conexión el modal abre pero no permite crear. "Es Central" se recuerda localmente (`localStorage`, por sucursal, refresco cada ≤ 6 h vía `get_pos_device_capabilities`) para que el modal y la excepción funcionen offline y tras reiniciar.
- **Tras crear**, el POS hace un pull incremental y verifica que el producto esté en su SQLite antes de agregarlo (`confirm_local_sale` sólo vende productos del catálogo local).
- **Scan vs click (superado por D-058):** originalmente un escaneo con stock <= 0 se agregaba en Central con aviso "Stock no registrado" y el click seguía bloqueado. D-058 lo generaliza: en Central ni el escaneo ni el click ni la búsqueda dependen del stock, así que el aviso y la excepción de escaneo se eliminaron.

**Motivo:** Fran no debe ir al Admin por cada producto nuevo del almacén ni escanear dos veces, pero la caja no puede obtener permisos de catálogo ni un alta puede dejar productos a medias o duplicados.


---

## D-053 — Importación de productos desde Admin: archivo completo registrado, validación previa sobre todo el archivo, nada se escribe antes de confirmar

**Status:** Active

La pantalla `/admin/imports` (CSV/Excel → motor de D-046) agrega, sin cambiar sus reglas:

- **Todas las filas del archivo se stagean**, también las que el cliente ya sabe inválidas (`payload.invalidReason` → `ERROR INVALID_ROW`, id sintético `INVALID:<fila>`): la base conserva el archivo completo y la vista previa sale de una única fuente. El cliente valida sobre **todo** el archivo (repetidos de código/barcode/nombre, números, longitudes) porque el motor sólo ve ≤1000 filas por lote.
- **Categorías nuevas dentro del preview:** `createMissingCategories`; el preview las clasifica `CREATE` y se crean al aplicar (una sola vez por nombre normalizado). Antes habría que crearlas antes de previsualizar, o sea, escribir antes de confirmar.
- **Una importación lógica = varios lotes** con el mismo `runId`, aplicados en orden; cada lote es atómico, la corrida no (no hay transacción de varios lotes con el tope por `statement_timeout`). Reintentar el mismo archivo continúa sin duplicar.
- **Destino siempre Central, decidido en el servidor** (sucursal productiva, D-033/D-052); el stock que antes podía cargarse como `OPENING_BALANCE` en Central **ya no se ofrece desde la pantalla (D-058)**, y nunca una columna de stock (D-047).
- **Adopción de productos existentes** (`linkExistingBy` = barcode y SKU por defecto, nunca nombre) sólo si es inequívoca, requiere revisión explícita en la pantalla y no cambia la forma de venta (`UNIT_TYPE_MISMATCH`): la carnicería por kg no se convierte en `UNIT` por un SKU coincidente.
- Un **nombre repetido** en el archivo con otro código es error (gana la primera fila): el motor no lo impide dentro de un lote pero sí entre lotes, y el resultado no debe depender de dónde cae cada fila. **Stock negativo/fraccionado** invalida la fila entera mientras "Importar stock actual" esté marcado.

**Motivo:** que el dueño vea exactamente qué pasará con cada fila de un catálogo de miles de productos, sin duplicados, sin tocar las carnicerías y pudiendo reintentar sin miedo.

## D-054 — Mercado Pago (QR): cobro verificado por el backend, sobre el modelo de pagos existente

**Status:** Active

- **Sin segundo modelo de pagos.** `payments` sigue siendo el pago de la venta y gana la verificación (`provider`, `verification_status`, `verified_at`, `verified_amount_cents`). Los intentos de cobro viven en `mercadopago_orders` (trazabilidad `sale_id` = `external_reference` = `order_id` de Mercado Pago, un solo intento vivo por venta, reintento = `<sale_id>-<n>`).
- **El medio de pago de una venta Mercado Pago es `TRANSFER` con `provider = MERCADOPAGO`.** No se agregó un valor al enum de métodos: el precio (lista, sin recargo de tarjeta), el orden de ajustes (D-044), los métodos elegibles y las rendiciones quedan intactos. **Decisión de producto pendiente de confirmar por el dueño:** un cliente que paga con tarjeta a través del QR de Mercado Pago paga el precio de contado, sin recargo por tarjeta. Cambiarlo es una decisión de pricing explícita (no se tocó).
- **Nadie verifica a mano.** `verification_status` sólo lo escribe el backend (trigger de guarda + funciones `SECURITY DEFINER`/`service_role`). Un pago es `CONFIRMED` únicamente si Mercado Pago informó `processed` + `accredited` al consultar la orden **y** lo acreditado, lo esperado y el total validado de la venta coinciden (si no, `MISMATCH`).
- **El webhook es una notificación, no la fuente de verdad:** se valida la firma `x-signature` (HMAC-SHA256, manifiesto `id;request-id;ts`), se re-consulta la orden con el Access Token y recién ahí se aplica; el cuerpo y el POS nunca deciden estado ni monto. Idempotente (duplicados/reintentos convergen); los estados finales no retroceden salvo pago tardío (`EXPIRED/CANCELLED/ERROR → CONFIRMED`) y reembolso.
- **Offline-first sin romper la venta:** la venta se registra primero (SQLite, outbox, stock) con `payment.provider`; el cobro es posterior. Iniciar un cobro exige Internet y sesión real (sin orden no hay nada que pagar; no se ofrece "MP sin conexión"); una caída durante el cobro no pierde la venta y el servidor concilia por cualquiera de los dos caminos (orden primero o venta primero). `sync_offline_sale` pasó a ser un wrapper de `app_private.sync_offline_sale_core` (cuerpo y pricing sin cambios) para leer `payment.provider` sin duplicar 250 líneas de validación.
- **Secretos sólo en Edge Functions** (`MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`); nunca `VITE_*`, repo, logs, tests ni POS. Alta de Store/POS por API sólo vía `mp-admin-setup` (dry-run por defecto, `confirm: true` explícito).
- **Informe:** `get_mercadopago_reconciliation` (permiso `payments.read`) clasifica cada venta/orden (`VERIFIED`, `NO_ACCREDITATION`, `AMOUNT_MISMATCH`, `PAID_SALE_CANCELLED`, ...) con hora, sucursal y montos para el cierre y la revisión de cámaras.

**Motivo:** el dueño no podía comprobar que una "transferencia" declarada hubiera ingresado; ahora lo no acreditado queda identificable sin cambiar cómo se cobra ni se calcula el precio.

## D-055 — Mercado Pago: la venta no está cobrada hasta que el backend confirma la acreditación; sin transferencia manual donde Mercado Pago es obligatorio

**Status:** Active (enmienda D-054: la completa, no la reemplaza)

- **Estado de venta `PENDING_PAYMENT`.** Una venta Mercado Pago nace `PENDING_PAYMENT` (no `COMPLETED`): `PENDING_PAYMENT → COMPLETED` cuando Mercado Pago acredita el monto exacto, `PENDING_PAYMENT → CANCELLED` cuando el cobro se cancela o vence sin acreditación. Se eligió un valor nuevo del enum (no un campo paralelo) porque todo reporte/rendición/métrica/reposición ya filtra `status = 'COMPLETED'`: un pago sin acreditar queda fuera de la recaudación por construcción, sin tocar esas consultas. La anulación reutiliza el mecanismo de `cancel_sale` (movimientos `RETURN` del mismo ledger) y ocurre **una sola vez**, bajo lock de la fila de `sales`.
- **Una sola función de transición.** `app_private.mp_reconcile_sale` mueve pago y venta; la llaman polling, webhook, cancelación y llegada de la venta, siempre vía `mp_apply_order_state`. El **polling es suficiente**; el webhook es un canal adicional (llega aunque el POS esté cerrado) y no es obligatorio. Ambos producen el mismo estado final.
- **`CONFIRMED` siempre gana.** Una acreditación no retrocede; si llega después de una anulación **automática** (carrera cancelar-vs-pagar), la venta se restablece (`SALE` otra vez, una vez). Una anulación hecha a mano por un administrador (`cancel_sale`) nunca se revierte sola. `ERROR` (alta fallida) y `MISMATCH` (monto distinto) **no** anulan ni completan la venta: siguen `PENDING_PAYMENT` (el primero se reintenta o se anula con "Anular venta"; el segundo lo resuelve una persona). `REFUNDED` no cambia la venta.
- **Stock:** mientras está pendiente queda reservado (descontado); al confirmarse es definitivo; al cancelarse/vencer vuelve al ledger exactamente una vez. En el POS, un cobro CANCELLED/EXPIRED deja de contar en el stock local (derivado, sin segundo ledger).
- **Transferencia manual prohibida donde Mercado Pago es obligatorio.** `mercadopago_branch_pos.require_verified_digital_payments` (default `true`) más `enabled = true` ⇒ la sucursal no ofrece ni acepta `TRANSFER` sin proveedor. Es configuración de sucursal, nunca el nombre. Se hace cumplir en tres capas: botón oculto (`mp_get_branch_config.manualTransferAllowed`, recordado para el modo offline), SQLite local (no registra la venta) y trigger `payments_guard_manual_transfer` en el servidor (cubre sync, `complete_discounted_sale` e inserts directos; una venta Mercado Pago pasa porque se declara `payment.provider`). Central (sin Mercado Pago) conserva la Transferencia. Una corrección administrativa excepcional sería un flujo aparte y explícito, nunca el botón del cajero.
- **Datos existentes:** la migración lleva las ventas Mercado Pago anteriores no confirmadas a `PENDING_PAYMENT` y las reconcilia (las canceladas/vencidas se anulan y su stock vuelve); las `CONFIRMED` no se tocan.

**Motivo:** el objetivo de la integración es saber si el dinero llegó. Una venta "Mercado Pago" cancelada o vencida no puede figurar como cobrada ni como "Transferencia", y el empleado no debe poder declarar una transferencia que nunca ingresó.

---

## D-056 — Proveedores: entidad propia y vínculo N:M con productos; sólo el nombre es obligatorio

**Status:** Active

Un proveedor deja de ser un texto libre (`stock_operations.supplier`, que se conserva sin tocar) y pasa a ser `suppliers` (`organization_id`, `name`, `code`, `tax_id`, `phone`, `email`, `notes`, `active`) con `product_suppliers (product_id, supplier_id, is_primary, supplier_sku)`. Reglas:

- **Sólo `name` es indispensable** (SimplyGest puede no traer CUIT/teléfono). Un producto sin proveedor es válido.
- **Sin duplicados por normalización, no por `lower(name)`:** índice único `(organization_id, app_private.import_normalize_text(name))` — el mismo normalizador que ya usan productos y el importador (sin mayúsculas, acentos ni espacios repetidos) — más único `(organization_id, upper(code))` si hay código. Las RPC devuelven un error legible y la restricción es la última garantía (también ante dos importaciones concurrentes).
- **RLS por organización y permiso** `suppliers.read/write` (sólo admin: un proveedor lleva datos fiscales/contacto). Nadie escribe las tablas directo: `save_supplier`, `set_supplier_active`, `set_product_primary_supplier`, `list_suppliers_page` (SECURITY DEFINER, auditadas).
- **Un solo principal por producto** (índice único parcial). Cambiar de principal **degrada** al anterior a vínculo secundario (no pierde su código de proveedor); "sin proveedor" también sólo degrada: nunca se borra un vínculo. Por eso el contador de Admin es "productos como principal". Esta etapa la UI sólo administra el principal.
- **Se desactivan, no se borran** (D-005): un proveedor inactivo conserva sus productos y deja de ofrecerse al asignarlo.
- **Importador:** `payload.supplierName/supplierCode`. Se reutiliza por (vínculo externo `external_entity_links` tipo `supplier` → mismo código → mismo nombre normalizado) o se crea una sola vez; queda principal del producto. Proveedor vacío = producto sin proveedor y **no** le quita el que ya tuviera. Reimportar el mismo archivo no toca nada (la fila es `UNCHANGED`).
- **Fuera de alcance:** cuentas corrientes, pagos, órdenes de compra, balances, facturas de proveedor, recepción/compras (siguen en TASKS).

**Motivo:** SimplyGest asocia un proveedor a cada artículo y migrar sin esa información sería perderla; un modelo estructurado permite luego compras, múltiples proveedores y reportes sin migrar texto libre.

---

## D-057 — Producto con precio 0: válido, visible en Central, nunca se vende a $0; el cajero lo fija desde la caja

**Status:** Active

SimplyGest tiene productos válidos con precio 0 (ya no se usan, o "Fran les pone el precio en el momento"). Reglas:

- **0 es un precio válido en la base** (`product_prices.price_cents >= 0`, antes `> 0`), sólo para representar "sin precio definido"; un precio negativo sigue imposible. `set_product_price` (Admin) sigue exigiendo > 0: Admin nunca fija un cero, sólo el importador. El importador acepta `priceCents >= 0`, **sólo crea la primera vigencia** de un 0 y nunca pisa un precio ya cargado (ni el que el cajero guardó): un 0 del archivo no es una baja de precio. Productos sin precio ni stock no se excluyen.
- **El POS lo muestra normalmente** (tarjeta "Sin precio") pero **nunca lo agrega al ticket a $0**: tocar la tarjeta, escanear, buscar o recibirlo del servidor abren el mismo modal "Producto sin precio" (`resolveProductRequest`, único punto de decisión). SQLite relaja `catalog_prices` a `>= 0` (migración `015`) y `insert_sale` rechaza una línea a $0 (`PRICE_REQUIRED`) aunque la UI fallara; `local_sale_items` conserva `> 0`.
- **El precio ingresado se guarda** (precio vigente, no temporal de esa venta): `set_pos_product_price(device, operador, token, producto, precio)` cierra la vigencia anterior (`valid_to`) e inserta la nueva (historial append-only), la cola de cambios del POS la entrega por el pull y la caja espera a tenerla en SQLite antes de vender. Idempotente (mismo precio = `UNCHANGED`).
- **Autorización estrecha, sin elevar a la caja:** dispositivo activo + token de operador vigente (PIN) + permiso `prices.pos_set_missing` **del operador** (admin y employee) + dispositivo en la sucursal productiva (Central, fail-closed) + producto activo y habilitado en esa sucursal. Además **sólo fija el precio de un producto que hoy no tiene precio** (vigente 0 o inexistente): cambiar el precio de uno que ya vale algo sigue siendo decisión de Admin (D-037).
- **Offline:** el modal sólo avisa "Este producto no tiene precio. Necesitás conexión para establecerlo."; no hay precio pendiente local ni venta a $0. Un producto con precio vende offline igual que siempre.
- Un producto `UNIT` recién fijado se agrega con 1 unidad (como un escaneo); uno `WEIGHT` abre el diálogo de peso con el precio nuevo.

**Motivo:** el dueño no puede cargar 2.700 precios antes de migrar, pero tampoco puede permitir ventas a $0 por un escaneo distraído; el cajero resuelve el precio una sola vez, queda auditado y el producto ya vale lo cargado en el siguiente escaneo.

---

## D-058 — Central no depende del stock; el stock histórico de SimplyGest no se importa

**Status:** Active (enmienda D-049, D-050, D-052 y D-053)

- **POS de Central (almacén + carnicería):** todo producto habilitado en `branch_product_assortment` es visible y vendible, con stock positivo, 0 o negativo: sin sección "Sin stock", sin tarjeta deshabilitada, con búsqueda, escaneo y venta manual normales. Vender con stock 0 puede dejar el ledger en -1 y es válido. Implementación: `stockForAvailability(stock, centralPos)` (`apps/pos/src/lib/catalog.ts`) devuelve `null` ("stock desconocido, no bloquear nada", semántica ya existente) para Central; el resto de la UI no cambia.
- **"Es Central"** se decide con la misma capacidad que el alta rápida (D-052): `get_pos_device_capabilities.quickProductCreate` ⇔ el dispositivo está en `organizations.production_branch_id`; se recuerda localmente (≤ 6 h). No hay otra definición ni nombre hardcodeado. Sin capacidad conocida (primer arranque sin sync) la caja se comporta como el resto de las sucursales hasta que se refresca.
- **Avenida y Janssen no cambian:** stock > 0 = disponible; 0, negativo o sin movimientos = gris, colapsado en "Sin stock" y no vendible (manual ni escaneo). El ledger, `get_pos_branch_stock`, reposición y alertas no cambian.
- **No se importa stock de SimplyGest** (no es confiable: muchos productos figuran en 0 aunque existan). La pantalla de importación ya no ofrece ni sugiere la columna de stock (aunque el archivo la traiga) y no se escribe ningún `OPENING_BALANCE`; los productos empiezan sin movimientos. El motor de apertura de stock sigue en la base para un futuro conteo físico (D-047).

**Motivo:** Fran no lleva stock confiable en Central; un catálogo de miles de productos "sin stock" gris sería inutilizable y bloquearía ventas reales.

---

## D-059 — Ticket digital por WhatsApp: Cloud API oficial, enviado y reconstruido por el backend

**Status:** Active

- **Canal oficial únicamente:** WhatsApp Cloud API de Meta, siempre desde una Edge Function (`whatsapp-send-ticket`). Nunca WhatsApp Web, `wa.me`, automatización del navegador/celular. El POS no conoce ni guarda credenciales; sólo manda `saleId` + teléfono (más la autenticación de dispositivo/operador, la misma de Mercado Pago).
- **El ticket lo arma el servidor** desde la venta real (`wa_prepare_ticket`) con una función pura reutilizable (`buildTicketModel`/`renderTicketText`/`buildTemplateParameters`); nada de lo que manda el POS (total, líneas, precios, texto) entra. Nunca costo, proveedor, margen, stock ni datos del empleado (lista blanca).
- **Sólo ventas cobradas:** `COMPLETED` (y, si hay pago de proveedor, `CONFIRMED`). `PENDING_PAYMENT`, `CANCELLED`, `REFUNDED`, `DRAFT` bloquean; una venta Mercado Pago no emite ticket hasta que el backend confirmó el cobro.
- **Plantilla UTILITY** (`ticket_compra`, `es_AR`, 7 variables de una sola línea) con nombre/idioma/versión de Graph API en secrets; proveedor detrás de una interfaz (`WhatsAppProvider`: Meta, mock, futuro PDF/documento).
- **Auditoría:** `ticket_deliveries` (un intento por fila, `PENDING → SENT → DELIVERED → READ | FAILED`), teléfono completo ilegible para `authenticated` (se muestra enmascarado), RLS por organización/sucursal. El teléfono **no** crea ni actualiza clientes.
- **Webhook** `whatsapp-webhook`: verificación GET con token, firma `X-Hub-Signature-256` con el **App Secret**, idempotente (clave mensaje+estado+timestamp), estados monótonos (un evento viejo o repetido no retrocede), eventos adelantados reaplicados al registrar el id. Mismos principios que `mp-webhook`; es complementario, el envío funciona sin él.
- **Online, explícito, no obligatorio:** sin Internet no hay envío (no entra a la outbox offline); la barra "Venta completada" no es un modal y desaparece al cargar el próximo producto; un ticket ya enviado pide confirmación antes de reenviar (también desde "Ventas recientes").
- **Decisiones no pedidas explícitamente (revisar):** (a) el POS manda además `deviceId`/`operatorProfileId`/`operatorToken` (autenticación, como Mercado Pago); (b) se aceptan números internacionales explícitos (`+` + otro país), no sólo Argentina; (c) el reenvío se detecta por **venta** (cualquier teléfono), no por número; (d) el envío sólo está en el POS de escritorio; (e) una única configuración de Meta para la organización (número por sucursal = futuro, `resolveWhatsAppConfig({ branchId })` es el punto de extensión); (f) se agregó el secret `WHATSAPP_APP_SECRET` (la firma del webhook se calcula con el App Secret, no con el verify token); `WHATSAPP_WABA_ID` queda sin uso en el código.

**Motivo:** entregar un comprobante digital al cliente sin exponer credenciales ni permitir que el POS invente importes, sobre el mismo patrón de seguridad e idempotencia ya usado en Mercado Pago.

---

## D-060 — Ticket por WhatsApp iniciado por el cliente (QR + claim); el envío por plantilla queda como fallback

**Status:** Active (enmienda D-059: cambia el flujo principal, conserva toda su infraestructura)

- **Flujo:** venta `COMPLETED` → POS "Ticket por WhatsApp" → QR → el cliente lo escanea → WhatsApp se abre con `TICKET <token>` → `whatsapp-webhook` recibe el mensaje y responde con el ticket. El POS **no pide teléfono** y el negocio no inicia la conversación.
- **Claim seguro (`whatsapp_ticket_claims`):** token aleatorio de 128 bits generado en Postgres, **sólo se guarda su hash SHA-256**, sin relación con el `sale_id`; una venta por claim; sólo para venta `COMPLETED` (pago verificado `CONFIRMED`); vence a las 24 h; cada apertura del QR genera un token nuevo (los anteriores siguen válidos hasta vencer/canjearse; tope 20 por venta/24 h). Tabla sin acceso para clientes; todo por RPC `SECURITY DEFINER` (`wa_create_claim` para el POS, `wa_redeem_claim` sólo `service_role`).
- **Canje:** el primer teléfono que lo envía lo toma; **el mismo teléfono** puede repetirlo (idempotente, hasta 3 entregas por claim); otro teléfono recibe "ya fue utilizado" sin datos. Idempotencia por `message.id` de Meta en `ticket_delivery_events` (`in|<message.id>`). El teléfono del destinatario sale **sólo** del remitente (`from`) del mensaje de Meta; sigue protegido/enmascarado en `ticket_deliveries` y **no** crea clientes.
- **Respuesta = mensaje de servicio (texto libre), no plantilla:** el cliente acaba de escribir (ventana de 24 h). Mismo builder del ticket (`buildTicketModel`) y misma elegibilidad que la plantilla; formato propio para WhatsApp (`renderWhatsAppMessage`, un solo mensaje, negritas, recorte con "y N productos más"). Rechazos breves (código inválido, vencido, ya usado, ya enviado, venta no disponible) sin datos de la venta. Cualquier otro mensaje del cliente se ignora (no es un chatbot).
- **QR generado localmente** en el POS (`qrcode-generator`, sin servicios externos) con el enlace oficial `https://wa.me/<número comercial>?text=TICKET%20<token>`. El número comercial visible es un secret nuevo, `WHATSAPP_BUSINESS_PHONE_E164`, distinto de `WHATSAPP_PHONE_NUMBER_ID` (ID interno de la Cloud API). Sin Internet no se crea claim ("Ticket por WhatsApp requiere conexión a Internet."); nada entra a la outbox.
- **Fallback conservado:** `whatsapp-send-ticket`, la plantilla `ticket_compra` y `WhatsAppTicketModal` siguen en el repo y probados, fuera de la UI normal. El flujo del QR **no necesita ninguna plantilla ni** `WHATSAPP_TEMPLATE_*`.
- **Consecuencia operativa:** el webhook (suscripto a `messages`) pasa de complementario a **imprescindible** para el ticket.
- **Decisiones no pedidas explícitamente (revisar):** (a) el claim se canjea por teléfono (primero gana), no es de un solo uso absoluto, para permitir el reenvío idempotente; tope 3 entregas; (b) reabrir el QR no invalida los tokens anteriores; (c) el POS no sondea si el cliente ya envió el mensaje; (d) si Meta rechaza la respuesta no se reintenta solo (el delivery queda `FAILED`; el cliente reenvía); (e) un mensaje `TICKET` mal formado recibe "código inválido", otros textos no reciben respuesta; (f) la migración 056 (no aplicada en ningún entorno) se dejó intacta y la 057 la complementa (`wa_prepare_ticket` pasa a usar los helpers nuevos con el mismo contrato).

**Motivo:** el negocio no tiene por qué tipear el teléfono ni iniciar conversaciones (plantilla Utility, costo y fricción); que el cliente inicie la conversación evita errores de tipeo, no requiere plantilla y deja el teléfono sólo donde Meta lo informa.

---

## D-061 — Pricing flexible en el POS de Central: efectivo por defecto, precio manual por línea y descuento general del ticket

**Status:** Active

- **Alcance:** sólo el POS de **Central**, es decir la sucursal productiva (`organizations.production_branch_id`; misma capacidad que decide `get_pos_device_capabilities` y que ya usan D-052/D-057/D-058): nunca se compara el nombre. Avenida y Janssen no cambian. No es sólo la UI: SQLite (`insert_sale`, bandera `flexible_pricing_branch` en `sync_metadata`) y Postgres (`sync_offline_sale_core`) rechazan una venta con precio manual o descuento general que no sea de la sucursal productiva (`FLEXIBLE_PRICING_NOT_ALLOWED`), sin dejar recibo, venta ni movimientos.
- **Efectivo por defecto:** cada ticket nuevo de Central arranca en `CASH` (también después de vender, cancelar, cerrar sesión de operador o cambiar de sucursal) y los precios se ven desde el primer producto. Tarjeta recalcula con la lógica de D-044 y volver a Efectivo recalcula de nuevo; Mercado Pago no cambia. En el resto de las sucursales el ticket sigue arrancando sin medio elegido.
- **Precio manual por línea:** el operador fija el precio de **esa línea de esa venta** (por kg si es `WEIGHT`, por unidad si es `UNIT`, `> 0`; "Usar precio normal" lo quita). No toca `product_prices` ni el catálogo y no afecta ventas futuras. La cantidad/peso sigue funcionando y editarlos conserva el precio manual.
- **Precedencia (decisión de producto): el precio manual es la decisión final de la línea.** No recibe promoción por umbral ni pack, ni recargo por tarjeta, ni ningún ajuste por medio de pago; cambiar Efectivo ↔ Tarjeta ↔ Transferencia **no lo mueve** (un precio acordado de $10.000 no vuelve a alterarse al tocar Tarjeta). Las demás líneas siguen recalculándose con el motor de siempre.
- **Descuento general del ticket:** input numérico libre en % (`0 <= % < 100`, hasta 2 decimales, sin atajos; 100% se rechaza con mensaje claro). Se aplica **después** de todo lo anterior, sobre la suma de los subtotales finales de las líneas (ya con precios manuales, promociones y recargo por tarjeta): `descuento = round_half_up(subtotal × bps / 10.000)`, `total = subtotal − descuento`. `0` o vacío lo elimina. El porcentaje se conserva al cambiar el medio de pago y se recalcula sobre el nuevo subtotal. Dinero en centavos y porcentaje en basis points, nunca floats. El modelo no admite ventas de total $0 (la base exige pagos `> 0`): por eso el input no acepta 100 % y, como defensa, un total que igual quedara en $0 no se cobra ni se sincroniza.
- **Orden de pricing vigente (Central):** línea normal = lista → promoción/pack → recargo por tarjeta → subtotal de línea; línea manual = precio manual → subtotal de línea; ticket = Σ subtotales → descuento general → total cobrado. `sales.total_cents`, el pago, Mercado Pago, rendiciones y WhatsApp usan ese total final.
- **Snapshot/auditoría:** `sale_items` guarda precio original (`original_price_per_kg_cents`), precio cobrado (`manual_unit_price_cents` = `price_per_kg_cents`), `manual_adjustment_cents` (diferencia de la línea) y `manual_price_applied`; `sales` guarda `ticket_discount_bps` y `ticket_discount_cents`; el operador sigue en `sales.profile_id`. Para que Rentabilidad atribuya el ingreso real por producto, el servidor reparte el descuento entre las líneas por mayor resto (empate: primera línea del ticket; suma exacta) en `sale_items.ticket_discount_cents`: ingreso de línea = `subtotal_cents − ticket_discount_cents`.
- **Offline/sync:** SQLite 016 y el payload del outbox llevan los campos nuevos (sólo cuando existen: una venta normal conserva su payload byte a byte); el servidor **no recalcula contra el catálogo vigente**, valida la aritmética del snapshot recibido y rechaza lo que no cierra (importes `> 0`, % entre 0 y 100, precio × cantidad, ajuste = subtotal − lista, descuento = % del subtotal, total/pago = subtotal − descuento). La identidad del operador/dispositivo la sigue validando `sync_pos_operator_offline_sale`. Una venta ya sincronizada no se puede alterar (recibo idempotente por payload).
- **Sin motivo obligatorio** en este sprint.
- **Decisiones no pedidas explícitamente (revisar):** (a) un precio manual mayor al normal también es válido (ajuste positivo); (b) un precio manual igual al normal igual bloquea promo y recargo (es una decisión explícita); (c) "Usar precio normal" quita sólo el override de precio: el estado "Vender como pack" de la línea `WEIGHT` (`TicketLine.sellAsPack`, local, nunca se envía) sobrevive al precio manual y se recupera intacto; (d) el descuento general rige para cualquier medio de pago, incluido Mercado Pago (se cobra el total final); (e) el RPC online `complete_discounted_sale` (POS web de desarrollo) no soporta precio manual ni descuento: Central opera con el POS de escritorio; (f) el "Descuentos de hoy" del detalle de sucursal suma también el descuento general.

**Motivo:** vender en el mostrador de Central con precios acordados y descuentos puntuales sin perder la auditoría, la consistencia entre POS/sync/servidor ni los totales de rendiciones y rentabilidad, y sin tocar el motor de precios de las demás sucursales.
