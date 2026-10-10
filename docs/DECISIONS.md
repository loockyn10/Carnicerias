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

**Status:** Active — **en lo que dice "cambiar el costo nunca recalcula el precio" quedó superseded por D-068** (con el margen global configurado, un costo nuevo deriva el precio de lista). El resto (el precio manual sigue existiendo, el costo se alimenta de desposte/compra directa, un producto puede tener precio sin costo) sigue vigente.

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

**Status:** Superseded by D-064 (2026-10-04: vuelve a UNA categoría por producto; `product_category_assignments` queda como proyección de `products.category_id`). Se conserva como historia.

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

Una categoría con al menos una asignación real (`product_category_assignments`, sea principal o secundaria) entra en el directorio y genera su tab con su propio nombre/color, sin depender de si algún producto la tiene como principal. Una categoría sin ninguna asignación puede omitirse. **Desde D-064 no existen asignaciones secundarias:** el directorio sigue siendo explícito y sincronizado, pero lista las categorías de los productos habilitados en la sucursal (la categoría única de cada uno). `products.category_id` (categoría principal) sigue existiendo sin cambios para color/etiqueta de la card de un producto individual y para consumidores legacy de una sola categoría — pero deja de ser la única fuente de qué tabs existen.

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


---

## D-062 — Purga controlada (hard delete) de productos importados cuyo stock ORIGINAL de SimplyGest era <= 0

**Status:** Active (procedimiento preparado, **no ejecutado** contra producción)

- **Qué es:** una limpieza de datos de una sola pasada, no una función del Admin. La política general sigue siendo desactivar, no borrar (`PRODUCT.md`); esta es una excepción acotada que se pidió explícitamente: sacar de `products` los productos de almacén que se importaron sin stock. No hay botón "Eliminar definitivamente" en ninguna pantalla.
- **Fuente de verdad: la `CANTIDAD` ORIGINAL del archivo de SimplyGest, jamás el ledger de Supabase.** La importación no cargó el stock (D-058), así que el ledger no dice nada sobre ese dato. La lista de candidatos sale del archivo (`buildPurgeCandidates`, mismas reglas y misma deduplicación "gana la primera fila" que el importador, para no mirar la ocurrencia equivocada de un código repetido); `CANTIDAD` vacía o ilegible **no** es evidencia de "sin stock" y nunca es candidata; `> 0` jamás es candidata, ni en el script ni en el servidor (`purge_validate_candidates` rechaza el lote entero).
- **Identificación por código, nunca por nombre:** `external_entity_links` (`source_system` + `entity_type = 'product'` + `external_id`).
- **Sólo lo que creó esa importación:** el producto tiene que ser el resultado de una fila `CREATE` aplicada de un lote `APPLIED` del mismo origen (`import_rows.internal_id`). Los productos de carnicería cargados antes, los adoptados con `linkExistingBy` (fila `UPDATE`) y los del alta rápida del scanner **no** se tocan (`NOT_CREATED_BY_IMPORT`).
- **Bloqueos (se informan con código, nombre y motivo; no se borra ni se archiva nada):** ventas (`sale_items`), cualquier movimiento de stock, operaciones y transferencias de stock, producción (insumo u output), eventos de reposición, habilitado en una sucursal que no sea Central (Avenida/Janssen), vinculado a otro sistema de origen. Una referencia FK que el clasificador no conozca se atrapa por producto (sub-transacción): ese producto queda intacto y se informa `UNEXPECTED_REFERENCE`.
- **Qué se borra junto con el producto (relaciones puramente de catálogo):** precios, costos, markup, códigos de barras, proveedor del producto (no el proveedor), surtido, categorías asignadas, política de stock, promociones del producto y los vínculos externos. Proveedores, categorías y el historial de importación (`import_rows`) se conservan.
- **Seguridad del procedimiento:** preview obligatorio (`preview_import_product_purge`, no escribe) → `purge_import_products` exige el conteo del preview (`p_expected_delete_count`, aborta con `40001` si cambió), una purga a la vez por organización (advisory lock), `imports.write` + `products.write` (sólo admin), un registro de auditoría `PRODUCTS_IMPORT_PURGE` por producto borrado (con el producto completo, el código externo y la cantidad original). Repetirla es inocuo (lo ya borrado ya no tiene vínculo: `NOT_LINKED`; un vínculo huérfano se limpia).
- **Sync del POS:** un producto borrado ya no existe en `products`, así que `pull_pos_state` nunca lo habría incluido en `removedProductIds`; ahora los ids `PRODUCT` del log del cursor que ya no existen se agregan a `removedProductIds` (el POS lo desactiva y borra sus barcodes/pack locales).
- **Operación:** `apps/admin/scripts/purge-simplygest` (`preview` por defecto; `apply` exige `--confirm-count` y `--yes-delete-permanently`), con el administrador autenticado por RLS (nada de `service_role`). Pasos en `docs/IMPORTS.md`.
- **Consecuencia a tener presente:** al borrar el vínculo, volver a importar el mismo archivo **recrearía** esos productos como nuevos. Después de la purga hay que importar con un archivo que ya no los incluya.
- **Modo por precio vigente $0 (2026-10-05, migración `202610050062`, no ejecutado):** extensión pedida de esta misma purga: `--zero-current-price` toma como candidatos los productos importados con un precio **vigente existente** de $0 (la ausencia de precio no cuenta) y los clasifica con el mismo clasificador y las mismas protecciones; sólo `DELETE_SAFE` se borra. Detalle en `IMPORTS.md`. Decisión no pedida: un $0 vigente con otro precio vigente > 0 se bloquea (`HAS_POSITIVE_CURRENT_PRICE`) en vez de borrarse.
- **Decisiones no pedidas explícitamente (revisar):** (a) un producto habilitado en otra sucursal además de Central se bloquea en vez de borrarse; (b) las promociones por producto (`product_weight_discounts`) se consideran configuración de catálogo y se borran con el producto (si hubiera ventas, el producto ya estaría bloqueado por `sale_items`); (c) `product_restock_events` bloquea aunque nazca de un movimiento de stock que ya bloquea.

**Motivo:** quitar ~miles de productos sin stock de la base de Central sin tocar la historia ni los productos de carnicería, con una lista verificable antes de borrar y sin dejar un botón peligroso en el Admin.


---

## D-063 — Pack de productos UNIT (unidades reales) y promoción global por sucursal

**Status:** Active (aplicado a producción el 2026-10-03; **ajustado por D-064** el 2026-10-04: el 20 % fijo pasó a ser un porcentaje por producto, la promoción es "desde N" sobre toda la línea y la versión del pack incluye el porcentaje)

- **Pack (`products.pack_size_units`, entero >= 2, sólo UNIT, NULL = sin pack):** una unidad operativa de carga rápida, **no** una promoción, **no** `PACK_FIXED_TOTAL` y sin precio propio. Se edita en el modal de producto del Admin ("Unidades por pack" + "Descuento del pack", RPC `set_product_pack_size`) y viaja con el producto por el cursor del catálogo (`packSizeUnits`; tabla SQLite `catalog_product_packs`).
- **Vender como Pack hace dos cosas:** (1) convierte `cantidad de packs × pack_size_units` en **unidades reales** (stock, precio y venta trabajan siempre con unidades; el pack no es una unidad de inventario: `stock_movements` registra 8/16/…); (2) aplica **el descuento del pack de ese producto a todas esas unidades** (`products.pack_discount_bps`; hasta D-064 era una constante de 20 %). El descuento es exactamente ese porcentaje del subtotal de lista de la línea (half-up, una sola vez), no el porcentaje por unidad redondeada: al 20 %, 8 × $1.000 → $6.400; 2 packs → 16 u → $12.800.
- **Promoción global por sucursal (`branch_promotions`):** "**desde** N unidades del MISMO producto, X % de descuento sobre TODAS las unidades de la línea" (D-064; nació como "cada N", sólo grupos completos) para todos los productos UNIT de **una** sucursal (sin una fila por producto; `branch_id`, nunca "Central" por nombre). Desde 3 → 15 %: 1–2 u sin descuento, 3 → las 3, 4 → las 4, 8 → las 8 con 15 %. Nunca suma productos distintos. Sólo UNIT. Una vigente por sucursal; **editar crea una versión nueva** (la fila vieja se cierra y conserva sus valores) para que una venta offline pueda validarse contra la regla exacta que usó. Admin → Productos → Promociones → "Promoción por sucursal" (RPC `save_branch_promotion`, permiso `catalog.write`). Llega al POS como foto completa en cada `pull_pos_state` (`branchPromotions`, como el directorio de categorías) y se lee de SQLite sin red.
- **Precedencia de una línea UNIT (un solo descuento por línea, nunca se acumulan):** 1) precio manual (D-061) → 2) venta explícita como Pack (con el % de ese producto; no recibe además promoción específica ni de sucursal) → 3) venta normal: promoción específica del producto aplicable (`PACK_FIXED_TOTAL`, que manda sobre la de sucursal en toda la línea) → si no aplica, promoción de sucursal → 4) medio de pago: recargo de tarjeta (D-044) **una sola vez sobre el total comercial ya descontado de la línea** (igual que un pack UNIT con remanente) → 5) descuento general del ticket de Central (D-061) sobre la suma final. Una línea sin descuento sigue el cálculo de siempre (recargo redondeado por unidad).
- **Scanner:** escanear agrega **una unidad normal**, nunca un Pack. Al modificar la cantidad de esa línea aparece "Pack · N unidades · X% OFF" (el % real de ese producto); tocarla la convierte (1 pack = N unidades reales). Agregar desde la grilla/buscador usa el **mismo componente** (`UnitQuantityFields`) para alta y edición, con la opción Pack antes de agregar. Un producto sin pack no la muestra.
- **Una línea por producto y modo:** agregar unidades de un producto que ya está en el ticket (grilla o scanner) suma a su línea normal, y los packs a su línea Pack; así "desde N" cuenta todas las unidades del mismo producto. Una línea con precio manual no se fusiona desde la grilla (el scanner sí, como antes).
- **Versiones del pack (`product_pack_versions`, mismo enfoque que `branch_promotions`):** filas inmutables `(product_id, pack_size_units, discount_bps, valid_from, valid_to)`; un trigger sobre `products.pack_size_units`/`pack_discount_bps` (D-064) cierra la versión vigente y abre otra en cada cambio de CUALQUIERA de los dos (RPC, importación o SQL), una sola abierta por producto. `products.pack_size_units` y `pack_discount_bps` siguen siendo el valor vigente que edita el Admin. `pull_pos_state` entrega al POS el tamaño, el porcentaje **y el id de la versión vigente** (`packSizeUnits` + `packDiscountBps` + `packConfigId`); SQLite los guarda juntos (`catalog_product_packs.pack_config_id`) y **sin versión no se ofrece Pack**. Cada línea Pack guarda `pack_config_id`.
- **Snapshot histórico por línea (`sale_items`, nunca se relee del producto):** `sold_as_pack`, `pack_config_id`, `pack_size_units_snapshot`, `pack_count`, `pack_discount_bps`, `pack_discount_cents` y, para la promoción de sucursal, `branch_promotion_id`/`_every_units`/`_discount_bps`/`_discounted_units`/`_discount_cents`. `promotion_discount_cents` lleva el descuento (reportes, rentabilidad, ticket de WhatsApp); `price_per_kg_cents` es el promedio por unidad. Si mañana el pack pasa de 8 a 12, una venta vieja sigue siendo "1 pack × 8 u, 20 %".
- **Revalidación:** el servidor (`sync_offline_sale_core`) y SQLite (`insert_sale`) recalculan con la misma aritmética que el POS (centavos y basis points, half-up) y rechazan lo que no cierra: porcentaje distinto del de la versión del pack vendida, unidades que no son packs × tamaño, descuento que no es el porcentaje, una versión del pack (`packConfigId`) que no existe, que es de **otro producto**, cuyo tamaño o porcentaje no coinciden con el snapshot, que todavía no existía cuando se hizo la venta o que se cerró hace más de 24 h + 10 min (la autorización offline del POS dura 24 h desde su último sync, así que un dispositivo que todavía la tenía no pudo venderla después) — **nunca se compara contra `products.pack_size_units`/`pack_discount_bps` actuales**: una venta offline hecha con un pack de 8 al 20 % sincroniza bien aunque el Admin ya lo haya pasado a 12 o al 25 % —, promoción de sucursal que no descuenta TODAS las unidades de una línea que llegó al mínimo (o que se reclama por debajo del mínimo), regla de promoción que no es de esa sucursal o no tiene esos valores, acumulación con precio manual / promoción específica / la otra, y líneas WEIGHT. El POS no consulta al servidor para calcular una venta.
- **Ticket de WhatsApp / Admin → Ventas:** muestran "pack 1x8 u -25%" / "promo desde 3: 8 u -15%" y el detalle por línea.
- **Decisiones no pedidas explícitamente (revisar):** (a) el servidor valida el pack contra la **versión** con la que se vendió (ver arriba), no contra el valor actual; SQLite compara versión y tamaño con el catálogo local que tiene HOY el dispositivo, así que una línea Pack armada con una versión que el catálogo reemplazó antes de cobrar se rechaza con un error y hay que volver a agregarla (carrera poco frecuente: cambio del pack con un ticket abierto); (b) el POS web de desarrollo (`complete_discounted_sale`) no ofrece Pack ni promociones de sucursal; (c) límites: pack 2–10.000 u, mínimo de la promoción 2–1.000 u, descuento 0,01–99,99 %; (d) el recargo de tarjeta de una línea con descuento se redondea una vez sobre el total (la línea sin descuento conserva su redondeo por unidad); (e) la tolerancia de reloj para validar una promoción es de 10 min; (f) el precio manual conserva la "memoria" de Pack de la línea (para "Usar precio normal"), pero cobra y envía como manual.

**Motivo:** vender más unidades de almacén con descuentos por volumen claros (Pack con su % por producto, "desde 3") sin crear miles de promociones, sin acumular descuentos por accidente y sin tocar el stock (siempre en unidades reales) ni el orden de precios vigente.

---

## D-064 — Ajuste de D-063: Pack con descuento por producto, una sola categoría y promoción "desde N"

**Status:** Active (implementado 2026-10-04, **sin aplicar a producción**; `059`/`060` ya estaban aplicadas y no se tocaron)

- **Descuento del Pack por producto.** Ya no es "siempre 20 %": `products.pack_discount_bps` (basis points enteros, `0 < bps < 10000`, decimales posibles: 12,5 % = 1250) es propio de cada producto UNIT con pack (Leche A 20 %, Leche B 25 %, Producto C de 12 u al 15 %). `pack_size_units` y `pack_discount_bps` son **las dos cosas o ninguna** (check de tabla: sin pack no hay descuento y con pack es obligatorio). Los packs existentes migraron a 20 % sin crear versiones nuevas (el `packConfigId` se conserva). El Admin muestra "Unidades por pack" y "Descuento del pack (%)" juntos, sólo para productos por unidad (`ProductPackFields`). `set_product_pack_size(producto, unidades, descuento_bps)` hace un solo UPDATE (una sola versión); una llamada anterior de dos argumentos (Admin sin actualizar) conserva el % del pack o, si es nuevo, usa el 20 % histórico.
- **Versionado histórico.** `product_pack_versions` versiona ahora **ambos** valores: cambiar el tamaño, el porcentaje o los dos cierra la versión vigente, abre otra y da un `packConfigId` nuevo. El check "`discount_bps = 2000`" se reemplazó por un rango (1..9999); las versiones viejas conservan su 20 %. El servidor valida cada línea Pack contra **su** versión (existe, es del producto, tamaño y % coinciden con el snapshot, vigencia histórica con la tolerancia de D-063) y recalcula el descuento: una venta offline del Día 1 (8 u al 20 %) sincroniza el Día 2 (pack al 25 %) y queda al 20 %; la venta nueva usa 25 %. Un snapshot manipulado (otro %, otro tamaño, versión de otro producto) se rechaza. SQLite/Rust comparan con el pack que el dispositivo tiene hoy (`catalog_product_packs`: tamaño + versión + %). El POS muestra el % real del producto ("Pack · 8 unidades · 25% OFF").
- **Una categoría por producto.** `products.category_id` es la única categoría válida; D-041 queda reemplazada. `product_category_assignments` se conserva por compatibilidad interna pero es una **proyección**: la migración borró las asignaciones secundarias, hay a lo sumo una fila por producto (`unique (product_id)`), un trigger sobre `products` la mantiene (alta y cambio de categoría reemplazan la fila, no agregan otra) y un trigger `BEFORE INSERT/UPDATE` rechaza cualquier fila cuya categoría no sea `products.category_id` (cualquier ruta, incluida SQL directa). `set_product_categories` conserva su firma pero rechaza ids distintos de la principal; el Admin ya no la llama ni muestra "También aparece en". `categoryIds` sigue existiendo en los contratos (`pull_pos_state`, `get_pos_catalog`, alta rápida, SQLite) y vale **siempre `[category_id]`**; el POS filtra por la categoría del producto. El importador pasa `[categoría]` y no crea secundarias (test en `import_infrastructure`).
- **Promoción global "DESDE N".** La interpretación "cada N" (grupos completos) era incorrecta: desde `minimum_units` unidades del mismo producto, el descuento cae sobre **todas** las de la línea. Fórmula: `si cantidad >= mínimo → descuento = round_half_up(precio_lista × cantidad × bps / 10000)` sobre las `cantidad` unidades; si no, sin descuento (nunca `floor(cantidad / N) × N`). `branch_promotions.every_units` se renombró a `minimum_units` (la regla desplegada 3 / 15 % se conserva y pasa a significar "desde 3 → 15 % a toda la línea"); el Admin muestra "15% OFF desde 3 unidades". `sale_items.branch_promotion_every_units` conserva su nombre histórico y guarda la cantidad mínima. El payload nuevo usa `branchPromotionMinimumUnits` y `branchPromotionDiscountedUnits = quantityUnits`.
- **Promoción: cómo se distingue "cada N" de "desde N" (compatibilidad con cajas sin actualizar).** Antes de 061 la venta guardaba el id de la regla y sus valores, pero **nada identificaba la semántica**. Ahora cada regla lleva `branch_promotions.semantics`: `EVERY_GROUP` ("cada N", las anteriores a 061) o `FROM_MINIMUM` ("desde N"). La migración **cierra** la regla vigente de cada sucursal (3 / 15 % "cada 3") y abre otra igual, `FROM_MINIMUM`, con id nuevo; `save_branch_promotion` siempre crea `FROM_MINIMUM`. Entonces: (a) una venta nueva (`branchPromotionMinimumUnits`) sólo valida contra una regla `FROM_MINIMUM`; (b) el formato anterior (`branchPromotionEveryUnits`, sólo grupos completos) sólo valida contra una regla `EVERY_GROUP` y únicamente si la venta es anterior al cierre de la regla o posterior por menos de 24 h 10 min (la autorización offline del POS dura 24 h desde su último sync: una caja que no sincronizó todavía no pudo saber del cambio); pasado eso, o contra la regla nueva, se rechaza con "update the POS"; (c) la venta conserva el id de su regla, así que su semántica queda identificada para siempre. Las ventas offline hechas antes de 061 sincronizan con su semántica histórica. **El POS anterior recibe `branchPromotions` siempre vacío** (la regla nueva viaja bajo la clave nueva `branchPromotionsFromMinimum`, que sólo lee el POS actual): una caja sin actualizar deja de aplicar promoción de sucursal en el mostrador en vez de generar ventas con la semántica anterior; no hay error ni ventas rechazadas, sólo desaparece el descuento hasta instalar el POS nuevo. El POS nuevo descarta en su SQLite (migración 019) las reglas guardadas por el anterior y vende sin promoción hasta su primer sync post-061. Un POS **anterior** vende cualquier Pack al 20 % fijo: mientras exista alguno, no hay que configurar un pack con otro porcentaje (el servidor rechazaría su venta contra la versión nueva).
- **Precedencia (sin cambios, un solo descuento por línea):** precio manual > Pack (con el % de ese producto) > promoción específica del producto > promoción de sucursal "desde N" > medio de pago > descuento general del ticket. Pack y promoción global no se acumulan: con 8 u de $1.000, pack 25 % y global 15 % desde 3, la venta normal de 8 cuesta $6.800 y como Pack $6.000, nunca −25 % y después −15 %.
- **Decisiones no pedidas explícitamente (revisar):** (a) se mantuvieron los nombres físicos `sale_items.branch_promotion_every_units` y `local_sale_items.branch_promotion_every_units` (histórico; renombrar tocaba reportes y el Admin viejo); `branch_promotions.every_units` pasó a `minimum_units` pero queda una columna **generada de sólo lectura** `every_units` para el Admin ya desplegado, y `save_branch_promotion` conserva su parámetro público **`p_every_units`** (con la semántica "desde N"): el Admin anterior sigue pudiendo leer y guardar la promoción durante la ventana entre el `db push` y el deploy del Admin nuevo (mostrará "Cada N" en su texto hasta entonces); retirar el alias cuando ya no haya clientes anteriores; (b) el RPC `set_product_pack_size` acepta el 20 % histórico como valor por omisión sólo para llamadores anteriores; (c) las asignaciones secundarias se **borraron** (no se archivaron): la migración es irreversible para esos datos; (d) `product_category_assignments` no se eliminó (la consumen `pull_pos_state`/`get_pos_catalog`/alta rápida hasta que se reescriban, y varios scripts de limpieza).

**Motivo:** el negocio quiere un descuento de pack distinto por producto, volver a una sola categoría y que "desde 3" signifique lo que dice el cartel, sin tocar el orden de descuentos, el ledger de stock ni la idempotencia del sync offline.

## D-065 — Ticket impreso NO fiscal desde el POS de Central (impresora local, ESC/POS RAW, snapshots de la venta)

**Status:** Active (implementado 2026-10-04; **sin probar con impresora física**; sin cambios en Supabase)

- **Qué es.** Un detalle de compra para el cliente, impreso con la leyenda explícita `COMPROBANTE NO FISCAL`. No hay CAE, factura A/B/C ni ARCA, y no reemplaza al ticket por WhatsApp (D-060), que sigue igual.
- **Dónde.** Sólo el POS de escritorio de la sucursal productiva (`centralPos`, la misma capacidad del servidor que habilita precio manual/alta rápida: nunca `branch.name`). La capa de impresión no conoce sucursales: habilitarla en otra es cambiar esa condición en `App.tsx`.
- **La impresora es de la computadora, no de la organización.** Configuración en SQLite local (`sync_metadata`, clave `printer_settings`, mismo patrón que la balanza): habilitada, nombre de la impresora de Windows, ancho de papel (80 mm), imprimir sola, cortar, juego de caracteres y nombre del encabezado. Nunca viaja a Supabase.
- **Actualización 2026-10-07 (58 mm, todas las sucursales).** El ticket se compone para papel de **58 mm / 32 columnas** (`RECEIPT_PAPER_WIDTH_MM`/`RECEIPT_COLUMNS` en `receipt-render.ts`; ya no se lee el ancho guardado, así una caja con "80" de antes imprime igual a 58). Encabezado fijo **SUPER OFERTAS** (doble tamaño) en todas las sucursales; el renderer **no imprime** el nombre de la sucursal ni el "nombre en el ticket" configurable (`branch_id` sigue guardado en la venta). La impresión (botón, auto-print, Reimprimir) la habilita sólo el escritorio (`printerVisible = desktop`): ya no depende de `centralPos`/`production_branch_id`; cada caja imprime en la impresora configurada en SQLite local. Las reglas comerciales de Central (`centralPos`) no cambian. Líneas UNIT: `3 u x $5.400`; WEIGHT: `2,000 kg x $11.000`.
- **Impresión directa, sin navegador.** TypeScript arma el documento (líneas de texto ya alineadas por columnas + estilo) y Rust lo codifica a ESC/POS (CP858 por defecto; WPC1252 como alternativa) y lo entrega como trabajo `RAW` al spooler de Windows por la API nativa (`winspool.drv`: `OpenPrinterW` → `StartDocPrinterW` → `WritePrinter`). Sin `window.print()`, sin PowerShell ni procesos externos. El backend es un `trait` (`PrinterBackend`): en otros sistemas responde `PRINTER_UNSUPPORTED`.
- **Sólo snapshots.** El ticket se arma únicamente desde `local_sales` / `local_sale_items` / `local_payments` (`get_sale_receipt_source`): precio de lista de entonces, Pack (cantidad, tamaño y % de esa versión), promoción de sucursal, precio manual cobrado, recargo de tarjeta y descuento general. Nunca lee el catálogo, los precios ni los packs vigentes, así una reimpresión histórica no cambia.
- **Un ticket final es una venta COMPLETED con el cobro confirmado.** Medios manuales: al registrarse. Mercado Pago: sólo con `verification_status = CONFIRMED`; `PENDING`/`ERROR`, `CANCELLED`, `EXPIRED`, `MISMATCH` y `REFUNDED` nunca se imprimen como ticket final (ni como reimpresión).
- **Un error de impresión nunca toca la venta.** La impresión no escribe en SQLite ni en la outbox; si falla, la barra post-venta dice «Venta completada, pero no se pudo imprimir el ticket» y ofrece «Reintentar impresión».
- **Offline.** Todo el camino es local (SQLite → ESC/POS → spooler): no hay request a Supabase ni chequeo de `navigator.onLine`.
- **Impresión automática:** una vez por venta (y una venta Mercado Pago recién cuando el backend confirmó el cobro). **Reimpresión** desde «Ventas recientes» con `*** REIMPRESION ***` arriba.
- **SQLite `020`:** `local_sales.operator_name_snapshot` y `branch_name_snapshot` (nulas; sólo para el ticket, no viajan al servidor). Las ventas anteriores usan el nombre actual del operador/dispositivo como respaldo.
- **Sin cambios** en pricing, orden de descuentos, métodos elegibles, ledger de stock, sync offline, RLS ni snapshots de venta existentes.
- **Decisiones no pedidas explícitamente (revisar):** (a) el encabezado del ticket (`Carnicerías Fran` por defecto) es un dato local editable porque la organización no se guarda en SQLite; (b) 42 columnas para 80 mm (32 para 58 mm) y fuente A, valores a ajustar con la impresora real; (c) corte parcial (`GS V 1`) tras avanzar 5 líneas, o sólo avanzar 4 si no corta; (d) «Reimprimir ticket» siempre marca `REIMPRESION`, también si nunca se había impreso (p. ej. un cobro Mercado Pago confirmado por el barrido de reconciliación); (e) la impresión automática se controla en memoria por sesión: tras reiniciar el POS no se reimprime nada solo; (f) las líneas se muestran con el precio de lista y el descuento restado (o, sin descuento, con el precio cobrado, que ya incluye un recargo de tarjeta); el recargo es una fila aparte sólo cuando la línea tiene descuento.

**Motivo:** darle al cliente un comprobante de compra impreso en el mostrador de Central sin depender de Internet ni del navegador, sin inventar un sistema fiscal y sin que una impresora pueda afectar una venta.

## D-066 — POS de Central: sin descuento general manual, aviso de venta temporal y alta de producto con «+»

- **Descuento general manual retirado de la UI del POS.** Toda venta nueva sale con descuento general 0 (no se manda `ticketDiscount`). Se conserva el soporte de contrato/backend/SQLite/reportes (D-061) y las ventas históricas siguen mostrándose; no hay migración. Precio manual por línea, promociones, packs y descuento del medio de pago no cambian.
- **«Venta completada» es un toast** flotante (no empuja el layout): se cierra solo a los 5 s o con la ×, y contiene Imprimir ticket / Ticket por WhatsApp. No espera mientras se imprime ni tras un error de impresión (queda hasta la ×). Cerrarlo no afecta la venta: la reimpresión sigue en «Ventas recientes». «Nueva venta» desapareció (el POS ya queda listo solo).
- **Botón «+» (Nuevo producto)** en el encabezado, sólo con la capacidad de Central (`centralPos`): abre el mismo `QuickProductModal`/`create_pos_quick_product` de la alta por scan. El código de barras sigue siendo obligatorio (lo exige la RPC y es la protección anti-duplicados): sin scan previo se escribe o escanea dentro del modal.
- **Layout:** columna del ticket al 40 % del ancho (tope 640 px; 380–600 px en pantallas bajas), footer compactado y lista de artículos con scroll interno para que TOTAL y Confirmar venta nunca salgan de pantalla.

## D-067 — Sucursales: ventas por rango de fechas y «Qué llevar ahora» (informe, sin movimientos)

**Status:** Active (implementado 2026-10-06; migración `202610060063` **sin aplicar**)

- **Rango de ventas.** `/admin/branches` (y el Resumen del detalle de sucursal) filtran por presets Hoy / Ayer / 7 días / 30 días o por Desde–Hasta arbitrarios (máx. 366 días). Son **días calendario de la organización** (`organizations.timezone`): `get_branch_sales_summary(p_from date, p_to date, p_branch_id)` convierte `[desde 00:00, hasta+1 00:00)` locales a instantes; el navegador nunca decide qué es «hoy» (los presets los resuelve el servidor de Next con la misma zona). Sólo ventas `COMPLETED`; devuelve por sucursal tickets, total, gramos (ítems WEIGHT), unidades (ítems UNIT) y el total del período inmediatamente anterior de igual duración (variación). Se agrega en SQL: ya no se traen ventas al navegador para sumarlas. No se extendió `get_profitability_analytics` (un solo bloque jsonb por sucursal, exige `analytics.read` y fin ≤ hoy, calcula rentabilidad que acá no hace falta).
- **«Qué llevar ahora».** `get_branch_carry_plan(p_branch_id)`: por sucursal NO productiva y producto habilitado en su surtido, `sugerido = max(vendido_7d − max(stock_actual, 0), 0)` (gramos para WEIGHT, unidades enteras para UNIT). **No se limita por el stock de la sucursal productiva** (no es confiable) ni escribe nada: no crea movimientos, transferencias ni toca `stock_levels`. La sucursal productiva (`organizations.production_branch_id`, nunca el nombre) es el origen y no aparece como destino; sin esa configuración la RPC se rechaza (fail-closed). «A llevar ahora» (editable, validado: sin negativos, kg con ≤3 decimales → gramos exactos, UNIT entero) vive sólo en el estado de la pantalla.
- **Un solo motor, no dos.** La base de datos de la reposición (ventas COMPLETED de la ventana, `stock_levels`, política mínimo/objetivo, surtido) se extrajo a `app_private.replenishment_rows`; `get_replenishment_plan` es ahora un envoltorio con exactamente el mismo contrato (verificado: salida idéntica a la anterior para 1/7/30 días sobre un fixture) y `get_branch_carry_plan` otro. Diferencia de **estrategia**: «Qué llevar hoy» (`/admin/replenishment`) sugiere para llegar al objetivo (máx. del objetivo manual y la cobertura en días); «Qué llevar ahora» sólo repone lo vendido en 7 días. Ambos coexisten y ninguno cambia al otro. El filtro de fechas de Sucursales es analítico y **independiente** de la ventana fija de 7 días de «Qué llevar ahora».
- **Surtido.** La fuente de verdad sigue siendo `branch_product_assortment` («Se vende en»): stock por sucursal, resumen de stock, reposición, matriz «Por sucursal», POS y el nuevo informe ya leían de ahí (045/047); no se agregó ningún campo ni sistema nuevo y el catálogo global no se altera.
- **Permisos.** Resumen de ventas: `sales.read` (el mismo permiso de la RLS de `sales`); informe: `dashboard.read` (como `get_replenishment_plan`). La organización sale de la sesión, nunca de un parámetro; `can_access_branch` filtra por sucursal; una sucursal de otra organización responde 42501.
- **Decisiones no pedidas explícitamente (revisar):** (a) la ventana de 7 días son 7 días calendario con hoy incluido (desde la medianoche local de hace 6 días hasta el momento del cálculo), igual que `get_replenishment_plan(7)`, no 168 horas móviles; (b) un stock negativo cuenta como 0 en la fórmula (si el ledger dice −2 kg y se vendieron 9 kg, se sugiere 9, no 11) y se muestra como faltante; (c) orden del informe: pesados antes que unidades, y dentro de cada grupo mayor sugerido primero (kg y unidades no son comparables); (d) el filtro y los tickets de `/admin/sales` siguen con un offset fijo `-03:00` (deuda preexistente, no tocada).

**Motivo:** poder controlar ventas por período y preparar qué mercadería llevar a Avenida/Janssen sin un segundo motor de reposición ni tocar pricing, ledger, offline, RLS ni snapshots.

---

## D-068 — Precio de lista derivado del costo con un MARGEN global (sobre el precio de venta); dto «llevando 3u», dto de pack y recargo de tarjeta como configuración global

**Status:** Active (implementado 2026-10-06; migración `202610060065` aplicada en Supabase; nada se recalcula hasta que el administrador guarde la configuración; **completada por D-069**: las categorías excluidas conservan su precio manual)

- **Regla final: costo → margen → precio.** `precio de lista = costo ÷ (1 − margen)` (margen real sobre el precio de venta, no markup): costo $10.000 al 30 % → $14.285,71; $4.000 al 30 % → $5.714,29; $10.000 al 50 % → $20.000. Centavos y basis points, half-up. **Reutiliza el gross-up existente** (`calculate_product_price` con markup 0): `app_private.list_price_from_margin` lo envuelve y `calculateListPriceFromMargin` es su gemela TS; no hay una segunda fórmula. Margen válido `0 < % < 100`. **Si hay costo válido y margen configurado, el precio de lista se deriva siempre.**
- **Dónde vive.** Tabla `organization_pricing_settings` (una fila por organización: `margin_bps`, `unit_bulk_discount_bps`, `pack_discount_bps`; auditada, RLS `prices.write`). **Sin fila / NULL = sin configurar**: la migración no recalcula nada ni cambia packs/promociones. El **recargo por tarjeta no se movió** (`organization_cash_discounts`, `set_cash_discount`, con historial). Todo es de la organización; la organización sale de la sesión.
- **Guardar la configuración** (`save_pricing_config(margen, 3u, pack, tarjeta, confirmar, cerrar_precios_sucursal)`, una llamada atómica). Con un margen distinto y sin confirmar **no escribe nada** y devuelve la vista previa; confirmado recalcula en el servidor. Permisos: `prices.write` + `catalog.write` si cambia 3u + `products.write` si cambia el pack. Rangos: margen `> 0` y `< 100`; 3u, pack y tarjeta `0 ≤ % < 100`.
- **Alcance del recálculo.** Productos **activos y vendibles** con costo vigente `> 0`; cada cambio abre una vigencia nueva (la anterior se conserva). **Sin costo: no se inventa precio, no se pone $0, no se pisa.** Un precio global programado a futuro se respeta; inactivos y materias primas no se recalculan.
- **Precio manual: sólo fallback.** En el Admin, con costo válido + margen configurado + producto activo/vendible **el precio manual NO gana**: en el alta se ignora (el formulario ni lo pide) y en la ficha el campo queda deshabilitado; sólo se escribe a mano cuando falta el costo o el margen (o el producto es inactivo/materia prima), y entonces se exige y se dice por qué. Costo nuevo (`set_product_cost`, `bulk_set_product_costs`, hasta 500) ⇒ vigencia de precio en la misma transacción. Se conservan las dos excepciones: **Quick Create del POS** (precio manual de emergencia si no se conoce el costo; cuando después se carga un costo y hay margen, el precio pasa a formarse solo) y el **precio manual por línea de Central** (D-061: se resuelve en la venta, no toca costo, lista ni margen y no dispara recálculo). `set_product_price` sigue existiendo en la base (la usa el fallback y el POS).
- **Precios por sucursal.** Un `product_prices` con `branch_id` **gana** sobre el global en el POS de esa sucursal (`pull_pos_state`, orden «sucursal primero»); ninguna pantalla vigente los crea (`setPriceAction` no tiene UI), pero pueden venir de cargas anteriores (producción no consultable desde esta máquina). Por eso: la **vista previa del margen informa cuántos hay** (`branchOverrides` de productos que se reprecian; `branchOverridesOther` de los que quedan fuera), la confirmación trae un **checkbox marcado por defecto para cerrarlos**, y hay una acción manual **«Cerrar precios por sucursal»** (`close_branch_price_overrides`). Cerrar = terminar la vigencia (`valid_to`), **nunca borrar**: la fila conserva su precio y queda en el historial; cerrados, el POS recibe el precio global. Una carga de costos informa si el producto tiene un precio de sucursal que sigue ganando. Un precio de sucursal programado a futuro no se toca. El sync offline **no relee `product_prices`**: el precio de lista de una venta es el snapshot que trae la caja.
- **Descuento de pack global; 0 % válido.** El producto sólo define las **unidades por pack**; el % sale de «Dto por pack» y se materializa en `products.pack_discount_bps` (el trigger de D-064 versiona cada pack). **0 % es válido**: el pack sigue existiendo (carga rápida de N unidades reales) sin descuento; no hay que quitar el pack para apagar el descuento. Se relajaron a `0..9999` los checks de `products`, `product_pack_versions`, `sale_items`, el sync del servidor y el POS (Rust/TS). Cambios 25 % → 0 % → 15 % abren una versión por cambio; cada venta conserva la suya (probado, incluidas ventas offline anteriores). `set_product_pack_size` ignora un % que le pasen cuando el global está configurado.
- **«Llevando 3u» global.** Se materializa como la regla de `branch_promotions` (`FROM_MINIMUM`, mínimo 3, toda la línea) en cada sucursal (versionada; las sucursales nuevas nacen con ella); el editor por sucursal desapareció (panel de sólo lectura). 0 = apagada.
- **Recargo de tarjeta (D-044) y descuentos.** El recargo **no es una promoción de línea** y no compite con ninguna: una línea tiene a lo sumo UN descuento (precio manual > Pack > promoción propia > «llevando 3u»; pack y promoción no se apilan) y **además** el recargo del medio de pago, una sola vez sobre el total ya descontado. Excepción vigente (D-061): la línea con precio manual de Central es el precio final, **sin descuento y sin recargo**. Fórmula sin cambios. Probado: normal, 3u, pack, pack 0 % y manual, con tarjeta y en efectivo (`card_surcharge_discount_precedence`, POS y business-logic).
- **Recargo de tarjeta OFFLINE validado contra la configuración de SU momento.** Antes el sync aceptaba cualquier % (incluso 0). Ahora `app_private.card_surcharge_bps_was_valid` exige que el % de la línea sea uno que `organization_cash_discounts` haya tenido desde 24 h 10 min antes de la venta (la autorización offline del POS dura 24 h: una caja que no recibió el cambio vende con el anterior) hasta 10 min después (reloj). **No se compara con la configuración de hoy:** una venta hecha antes de un cambio de recargo sincroniza válida y conserva su % como snapshot; un % inventado, o el de una configuración que todavía no existía, se rechaza (`22023`). Sin filas de configuración rige el 10 % por defecto (igual que la venta online). Efectivo/transferencia (bps 0) y las líneas manuales no se ven afectados.
- **Importación.** Fila con **costo > 0**, margen configurado y producto activo y vendible: el precio se forma desde el costo y **el precio del archivo se ignora** (también un $0); si el costo no cambió (reimport) no se escribe nada salvo que el producto no tenga precio, entonces se forma. Fila **sólo con precio**, o sin margen configurado, o producto no vendible: comportamiento anterior (precio del archivo, $0 = «sin precio definido»). Idempotencia y `external_entity_links` sin cambios (probado: mismo archivo ⇒ 5 ignoradas, sin vigencias nuevas).
- **Desposte: NO cambia.** Un costo **manual o masivo** sí recalcula el precio; un costo **generado por Desposte** (`complete_production_batch`) **NO dispara reprecio** (sale del valor relativo de venta, repreciar sería circular); un **cambio de margen global** sí recalcula todo producto con costo vigente, también los cortes de desposte. Importación y alta rápida del POS no reprecian solos (la importación sí forma el precio de una fila con costo + margen, ver arriba).
- **Offline, sync y snapshots.** El POS recibe el precio ya formado (nunca costo ni margen), el pack (tamaño + % + versión) y las reglas «desde 3»; cada venta conserva sus snapshots; la rentabilidad lee el costo snapshot de la venta. Una venta de Día 1 sincronizada después de cambiar margen/costo/pack/promoción queda intacta (probado).
- **Compatibilidad del POS.** El POS **sigue en versión 0.1.0** (no se inventó versionado). Para un **descuento de pack distinto de 20 %** hace falta un build que incluya la migración SQLite `019` (commit `31f7b55` «Descuentos por pack» o posterior): un POS anterior vende todo pack al 20 % fijo y el servidor rechaza su venta si el global es otro. Para un **pack global 0 %** hace falta un build que incluya este cambio (Rust/TS: un POS anterior simplemente no ofrece el pack con 0 %). El guard de compatibilidad del servidor (validar cada línea contra SU versión de pack/regla) no cambió.
- **Decisiones no pedidas explícitamente (revisar):** (a) la primera vez, guardar la configuración reemplaza el % propio de cada pack por el global; (b) guardar el mismo margen no recalcula; (c) con costo + margen no se puede escribir el precio a mano desde el Admin (para una excepción hay que quitar el costo o el margen, o cerrar/usar el flujo de sucursal); (d) el sync offline sigue sin validar el precio de lista contra `product_prices` (preexistente); (e) en tests el tiempo de una transacción no avanza (se usa `clock_timestamp()`).
- **Medición** (PGlite/WASM, cota conservadora): 3.000 productos → recálculo ≈ 1,7–2,0 s, vista previa ≈ 0,4–0,6 s, 500 costos ≈ 0,8 s; 10.000 productos → ≈ 10–11 s (el timeout de PostgREST para `authenticated` es de 8 s: medir contra el Supabase real si el catálogo crece).

**Motivo:** que el dueño cargue sólo los costos de la factura y el precio salga solo de un margen único, sin tocar el orden de descuentos, el ledger de stock, el sync offline ni los snapshots históricos.

## D-069 — Categorías excluidas del margen automático (precio manual en carnicería)

**Status:** Active (implementado 2026-10-07; migración `202610070066` **sin aplicar**; completa D-068). La 065 ya estaba aplicada en Supabase (`supabase migration list --linked`), por eso es una migración nueva y la 065 no se tocó.

- **Semántica.** El margen global (D-068) es el margen **automático** de los productos habilitados para pricing automático, no de toda la organización. Productos de una **categoría excluida** (hoy se elegirían Vaca / Cerdo / Pollo; **nada está hardcodeado**: se guardan **IDs** por organización): conservan su precio de lista vigente, el precio es manual y el **costo se sigue guardando** (rentabilidad). Sin exclusiones el comportamiento es el de D-068.
- **Modelo.** Tabla `organization_pricing_excluded_categories (organization_id, category_id)` (FK compuesta a `categories(id, organization_id)`: sólo categorías de la propia organización; auditada; RLS `prices.write`; sólo se escribe con `save_pricing_config`). Predicado `app_private.is_pricing_excluded(org, producto)`. **Una categoría por producto** (`products.category_id`; `product_category_assignments` es su proyección, unique desde D-064): no se inventó otro concepto, y «al menos una categoría excluida» equivale a «su categoría está excluida». **Sin categoría = automático** (no se excluye en silencio).
- **Automático vs manual.** Automático = producto activo/vendible cuya categoría **no** está en la lista (o sin categoría) con costo y margen. Manual = su categoría está en la lista. Un producto excluido sigue pudiendo recibir un precio manual (`set_product_price`) y sus promociones/packs/recargo siguen operando sobre el precio de lista que tenga (D-044/D-064/D-068 sin cambios).
- **Costo nuevo.** `apply_product_cost` (usada por `set_product_cost`, la carga masiva y la importación): automático → costo + precio derivado en la misma transacción; excluido → **sólo el costo** (`price_outcome = 'MANUAL_PRICE'`, sin vigencia de precio). `bulk_set_product_costs` informa `manualPrice`.
- **Cambio de margen.** El recálculo (`recalculate_prices_from_margin`) saltea los excluidos: no generan vigencia. La vista previa informa `recalculated`, `excludedByCategory`, `withoutCost` (sólo automáticos), `unchanged`, `branchOverrides` y hasta 10 precios de ejemplo (`sample`).
- **Cambiar la lista de exclusión.** `save_pricing_config(..., p_excluded_category_ids uuid[] default null)` (null = no tocar; el Admin ya desplegado sigue funcionando con 6 argumentos). **Agregar** una categoría: no pide confirmación, no reprecia, no revierte nada: deja de repreciarse desde ahí. **Sacar** una categoría (o cambiar el margen): **pide confirmación** (sin confirmar no escribe nada) con la vista previa de cuántos productos pasan a automáticos (`newlyAutomatic`) y qué precios cambian; confirmado, abre una vigencia nueva por producto y **sólo** de esas categorías si el margen no cambió (no pisa otros precios manuales). El historial nunca se modifica; automático → excluido no toca el precio vigente.
- **Alta/edición, carga masiva, importación, desposte.** Alta/edición: con categoría excluida el precio se escribe a mano (campo habilitado, obligatorio en el alta) aunque haya costo + margen; el costo se guarda igual. Carga masiva: filas excluidas con «Precio manual» (precio actual a la vista), las automáticas muestran el precio que va a formar el servidor. Importación: una fila con costo de un producto excluido guarda sólo el costo; si trae precio explícito se usa ese precio (compatibilidad); idempotente. Desposte: `complete_production_batch` ya no reprecia nunca y un cambio de margen tampoco toca a los cortes excluidos; el costo del corte se actualiza para la rentabilidad. Sin cambios en ledger, sync offline, snapshots ni RLS.
- **Para operar el primer margen:** configurar las categorías excluidas **en el mismo guardado** que el margen (la primera configuración recalcula todo producto automático con costo).

**Motivo:** carnicería tiene otra lógica de precios (Vaca/Cerdo/Pollo no deben repreciarse por costo + margen), y la exclusión tiene que ser configurable y persistida por ID, no por nombre.

## D-070 — Margen de ganancia personalizado por producto (excepción opcional al margen global)

**Status:** Active (implementado 2026-10-07; migración `202610070067` **sin aplicar**; completa D-068/D-069, que no se tocaron).

- **Prioridad del margen efectivo** (helper único `app_private.effective_margin`, usado por costo nuevo, carga masiva, importación y edición del margen): 1) margen propio del producto → ese margen, **incluso en categoría excluida**; 2) sin propio y sin margen global → sin margen (el costo se guarda, el precio no cambia); 3) sin propio y categoría excluida → precio manual (D-069); 4) sin propio y categoría normal → margen global. Misma fórmula gross-up `costo ÷ (1 − margen)` (`list_price_from_margin`): no hay un segundo motor.
- **Modelo.** Tabla `product_custom_margins (product_id unique, custom_margin_bps 1..9999)`, **ausencia de fila = sin override** (se eligió tabla y no columna en `products` para que el margen no viaje en ninguna lectura de `products` ni al catálogo del POS: RLS `prices.write`, auditada, sólo se escribe con `set_product_custom_margin`). Basis points enteros, mismos límites que el global; nunca se copia el global al producto.
- **Poner/cambiar el margen propio** recalcula ese producto con su costo vigente (nueva vigencia de `product_prices`, historial append-only). **Quitarlo:** categoría normal → vuelve al global y recalcula; categoría excluida → vuelve a precio manual y **no** recalcula ni borra el precio vigente (`MANUAL_PRICE`). Sin costo (`NO_COST`), no vendible (`NOT_SELLABLE`) o precio futuro programado (`SCHEDULED`): se guarda el margen y no se inventa un precio.
- **Cambio de costo:** propio → `costo ÷ (1 − propio)`; sin propio normal → global; sin propio excluido → sólo el costo. **Cambio del margen global:** `recalculate_prices_from_margin` sólo toca a quien usa el global (excluye los de margen propio; informa `customMargin` aparte de `excludedByCategory`). `save_pricing_config` no cambió.
- **UI.** Se edita **sólo** desde «Administrar producto» (selector «Usar configuración general · Margen actual: X %» / «Precio manual» si la categoría está excluida / «Usar margen personalizado [ ] %»). La carga masiva de costos **no** tiene input de margen: sólo muestra la regla bajo el precio (`Global 40%` / `Propio 30%` / `Precio manual`). El alta de producto no tiene el selector (se edita después). Con margen propio el precio de la ficha se deriva del costo (campo deshabilitado), como con el global.
- **Sin cambios:** POS (recibe sólo el precio de lista; ni margen ni costo), analytics/snapshots de venta, promos, pack, dto 3u, recargo de tarjeta, precio manual por línea de Central.
- **Limitaciones conocidas:** `newlyAutomatic` de la vista previa al sacar una categoría de la exclusión también cuenta productos con margen propio (ya eran automáticos), porque `save_pricing_config` no se reescribió.

**Motivo:** que algunos productos (p. ej. yerba al 30 %, o un corte de Vaca al 25 %) tengan su propio margen sin romper la regla general ni la exclusión de carnicería.

## D-071 — Redondeo comercial a $50 del precio de lista calculado por margen

**Status:** Active (implementado 2026-10-07; migración `202610070068` **sin aplicar**; completa D-068/D-070, que no se tocaron).

- **Regla.** `costo → gross-up por margen (costo ÷ (1 − margen), half-up, sin cambios) → redondeo al múltiplo de $50 más cercano (half-up en el punto medio) → nueva vigencia`. En centavos enteros: `floor((precio + 2.500) ÷ 5.000) × 5.000`. 2.466,44 → 2.450; 2.424 → 2.400; 2.474,99 → 2.450; 2.475 → 2.500; 5.714,29 → 5.700; 5.726 → 5.750. **Piso de $50**: un costo mínimo nunca forma un precio de $0 ("sin precio"; `set_price_history` lo rechazaría y frenaría toda la carga masiva). El redondeo puede dejar un precio por debajo del costo sólo con costos de pocos pesos (decisión explícita del pedido; no se compensa).
- **Un solo helper.** SQL: `app_private.round_commercial_price_to_nearest_50`, llamado desde `app_private.list_price_from_margin` (por donde pasan costo individual, carga masiva, importación, cambio de margen global/propio, alta con costo y las vistas previas del servidor). TS: `roundCommercialPriceToNearest50`, aplicado dentro de `calculateListPriceFromMargin`; las pantallas (carga masiva, editor del producto, alta, ejemplo de configuración) sólo llaman a esa función, así que el precio proyectado es el que guarda el servidor.
- **No cambia.** `public.calculate_product_price` / `calculatePriceFormation` (gross-up genérico y sistema de markup anterior); precio manual y precio manual por línea de Central (D-061); categorías excluidas sin margen propio (D-069); snapshots y vigencias históricas (nada se reescribe: un precio ya guardado sigue igual hasta que un costo o margen nuevo lo vuelva a derivar; guardar el mismo margen no recalcula, D-068 b); dto 3u, pack, promociones y recargo de tarjeta, que se calculan desde el precio de lista ya redondeado y **no** se redondean a $50.

**Motivo:** precios de góndola comerciales (múltiplos de $50) sin tocar la fórmula de margen, el orden de descuentos ni el sync offline.

## D-072 — Cartelería digital: pantallas de TV públicas por token (sólo lectura), con el precio y la promoción vigentes del sistema

**Status:** Active (implementado 2026-10-07; migración `202610070069` **sin aplicar**). No toca pricing, orden de descuentos, stock, sync offline ni RLS existente.

- **Qué es.** Un televisor abre `/tv/<token>` (sin login) y rota en bucle las ofertas publicadas de SU pantalla (fundido, 3–60 s por slide, 8 por defecto). Se configura en Admin → Productos → Cartelería (`/admin/products/signage`): nombre, sucursal, duración, activa/desactivada, productos (buscar por nombre/SKU/código de barras; ↑ ↓ para ordenar; «Guardar y publicar» reemplaza la lista en una transacción). Varias pantallas por organización (máx. 20); nada hardcodeado por nombre de sucursal.
- **Modelo.** `digital_signage_displays` (organización, `branch_id` opcional = sucursal cuyo precio/promoción se muestra, nombre, `token_hash`, duración, `enabled`) y `digital_signage_slides` (pantalla, producto, posición). **Los slides no guardan precios ni textos**: apuntan al producto, así que cambiar un precio o una promoción llega solo al televisor. Sin tabla de imágenes ni columnas anticipadas (la foto del producto queda como `media` opcional de la plantilla).
- **Acceso.** Token de 256 bits (`gen_random_bytes(32)`, 64 hex); **sólo se guarda su SHA-256** (patrón de `whatsapp_ticket_claims`). El token en claro se devuelve **una sola vez**, al crear o al regenerar: el Admin muestra `/tv/••••` y «Regenerar enlace» (con confirmación) invalida el anterior (el TV que lo tenía abierto pasa a un cartel neutro «Pantalla no vinculada» en su próxima consulta). `get_signage_display(token)` (`SECURITY DEFINER`, ejecutable por `anon`) es la **única** superficie pública: valida el formato y el hash y devuelve sólo nombre, tipo de venta, precio de lista, regla «llevando N» o tramos de peso y el nombre de la organización. Nunca costo, margen, stock, ventas, empleados, SKU, ids de producto ni otra organización; token inexistente o mal formado ⇒ `NULL` (404). Las tablas no admiten escritura desde clientes (las RPC `create/save/regenerate_signage_*` exigen `catalog.write`), el hash no es legible (grants por columna) y el audit-log no lo copia (auditoría manual, sin trigger de fila).
- **Precio y promoción = POS.** Precio vigente con la misma precedencia que `pull_pos_state`: **precio de la sucursal > global**; «llevando 3u» = la regla vigente de `branch_promotions` de esa sucursal (sin sucursal: la configuración global D-068, mínimo 3). La base sólo entrega hechos; **la cuenta la hace el motor TS** (`calculateBranchPromotionLinePricing` para UNIT, `applyWeightDiscount` para WEIGHT) en `lib/signage.ts`; la plantilla no calcula nada. Producto sin promoción ⇒ «PRECIO UNITARIO» (nunca se inventa «llevando 3»); WEIGHT ⇒ `$ X / KG` y, si existe un tramo `THRESHOLD` limpio, «DESDE N KG». **Quedan fuera de v1:** promociones `PACK_FIXED_TOTAL` y packs. Un slide no se muestra (el Admin dice por qué) si el producto está inactivo/no vendible/categoría apagada, no está en el surtido de la sucursal o no tiene precio > 0 (D-057).
- **Pantalla.** Plantilla 16:9 de 1920 × 1080 px de diseño (`OfferSlide`, presentacional y reutilizable para un futuro PNG/WhatsApp), escalada con `transform` a la ventana real (letterbox negro, sin scroll, sin cursor, sin controles). `DigitalSignagePlayer` rota, consulta `/api/tv/<token>` cada 30 s (10 s tras un fallo) y se actualiza sin recargar; **si la consulta falla conserva la última presentación en memoria**; sin ofertas, desactivada o sin datos muestra «Próximamente nuevas ofertas». Recarga completa cada 6 h sólo si la última consulta salió bien. `/tv` y `/api/tv` no pasan por el refresco de sesión (middleware). «Abrir vista TV» abre `/tv-preview/<id>` (mismo reproductor, autenticado por la sesión del administrador, porque el token no se puede releer).
- **Decisiones no pedidas explícitamente (revisar):** (a) hash-only: si se pierde el enlace hay que regenerarlo; (b) permiso `catalog.write` para escribir y `products.read` para leer (no se creó un permiso nuevo); (c) la pantalla desactivada responde `DISABLED` (cartel de espera), no 404; (d) Etiquetas (`/admin/products/labels`) sigue usando sólo el precio global, la cartelería respeta la sucursal.

**Motivo:** cartelería de ofertas en televisores sin que el dueño reescriba precios ni reinicie nada, sin ampliar la superficie pública más allá de un token de sólo lectura.

## D-073 — Etiquetas de góndola en lote: grupos persistentes, PDF A4 real y detección de etiquetas desactualizadas

**Status:** Active (implementado 2026-10-07; migración `202610070070` **sin aplicar**). No toca pricing, orden de descuentos, stock, sync offline ni RLS existente. **Reemplaza el punto (d) de D-072**: Etiquetas ya no usa sólo el precio global; resuelve el de la sucursal del grupo, igual que el POS.

- **Grupos.** `product_label_groups` (organización, `branch_id` opcional = sucursal cuyo precio/promoción lleva la etiqueta, nombre único entre los activos de la organización, `active`: se **archiva, no se borra**) y `product_label_group_items` (grupo, producto, posición, `active`: quitar = desactivar, para no perder el vínculo con el historial). Alta y baja **en lote** (`set_label_group_products(group, add[], remove[])`, una transacción; máx. 500 productos por grupo, 100 grupos por organización). Todo escribe por RPC `SECURITY DEFINER` (`catalog.write`) y lee con `products.read`; las tablas no tienen grants de escritura. Nada hardcodeado por sucursal.
- **Historial.** `product_label_print_runs` (grupo, sucursal del grupo al generar, quién, cuándo, cantidad de etiquetas/productos) y `product_label_print_run_items` (**snapshot** por producto: nombre impreso, tipo, precio normal, precio promocional, mínimo y % de la oferta, copias). **Es historial/auditoría, nunca el precio vigente.** Inmutable (trigger: ningún UPDATE). No se guarda el PDF (ni bytes ni base64).
- **Detectar cambios.** `get_label_group` devuelve, por producto, el precio vigente de la sucursal, la regla «llevando N» y la **última impresión dentro de ese grupo**. `compareWithLastPrint` (`lib/label-changes.ts`) compara valores exactos (centavos, mínimo, bps, nombre impreso): **Nunca impresa** (NEW) · **Actualizada** (UPDATED) · **Cambió** (CHANGED: precio de lista, regla de la promoción o nombre; si sólo cambió la lista, el precio de oferta se mueve con ella y se informa una razón). «Seleccionar precios cambiados» marca CHANGED **y NEW** (la etiqueta física no existe todavía; ver «a revisar»). Reimprimir usa siempre el precio **actual** y la nueva generación pasa a ser la referencia.
- **Diseño y PDF compartidos.** `lib/label-spec.ts` (única especificación: 60 × 40 mm, márgenes internos 4 mm laterales, tipografía por rol, separaciones, grilla A4) → `lib/label-layout.ts` (geometría: primitivas de texto y líneas, en mm; mide con las métricas oficiales de Helvetica, `lib/label-font.ts`) → el **preview SVG** (viewBox en mm) y el **PDF** (pdf-lib, fuentes estándar, sin Chromium ni imágenes) dibujan ese mismo layout. Variantes de `ProductPriceLabel`: oferta UNIT con «llevando N» (OFERTA!!!, nombre ≤ 2 líneas, POR N UNIDADES subrayado, Descuento X%, precio promocional enorme, fila PRECIO NORMAL + precio normal), UNIT sin promoción (nombre, PRECIO, precio enorme, PRECIO UNITARIO; **nunca** se inventa una oferta) y WEIGHT (`$ X/kg`, PRECIO POR KILO; sin promociones por peso en v1). Todo en blanco y negro; nombres en mayúsculas y saneados a WinAnsi (nunca falla por un carácter raro). Precios con `formatCurrency` y el motor existente (`calculateBranchPromotionLinePricing`): sin redondeo comercial extra (5.312,50 se imprime 5.312,50).
- **Hoja.** A4 exacto (210 × 297 mm), 3 columnas × 7 filas de 60 × 40 mm = **21 por hoja**; el bloque de 180 × 280 mm queda con 15 mm laterales y 8,5 mm arriba y abajo; encabezado de control en el margen superior y marcas de corte a 75/135 mm; imprimir **al 100 %**. Orden: el del grupo (no el de los clics), con las copias consecutivas. Hasta 99 copias por producto y 500 etiquetas por PDF.
- **Generación (`POST /api/labels/pdf`).** El navegador sólo manda `{groupId, items: [{productId, copies}]}`. El servidor vuelve a leer el grupo (`get_label_group`: organización, permiso y sucursal los valida la RPC), arma las etiquetas, dibuja el PDF y **registra la generación con los mismos valores** (`record_label_print_run`) **antes** de entregar el archivo: si el registro falla no se entrega nada. Un producto fuera del grupo, inactivo, fuera del surtido de la sucursal o sin precio rechaza todo el pedido (nunca se imprime a $0).
- **A revisar (decisiones no pedidas explícitamente):** (a) «Seleccionar precios cambiados» incluye también los productos **nunca impresos**; (b) un cambio de **nombre** cuenta como etiqueta desactualizada; (c) `record_label_print_run` confía en los valores que le pasa el servidor Admin (un usuario con `catalog.write` podría registrar un snapshot falso llamando la RPC directamente; es auditoría, no afecta precios); (d) mismos permisos que cartelería (`catalog.write` / `products.read`, sin permiso nuevo); (e) el PDF histórico no se puede volver a descargar (sólo el detalle de lo impreso).

**Motivo:** que el dueño arme una vez los productos con etiqueta física, imprima sólo lo que cambió y no tenga que recordar qué precio tenía cada cartel.

## D-074 — Cartelería: pieza «Producto protagonista» (TV / Feed / Story), foto comercial por producto en Supabase Storage y export PNG

**Status:** Active (implementado 2026-10-08; migración `202610080071` **sin aplicar**). No toca pricing, orden de descuentos, stock, sync offline ni RLS existente; **reutiliza** la cartelería de TV (D-072: sigue intacta en «Pantallas TV») y el motor de promociones.

- **Dónde.** Productos → **Cartelería** (`/admin/products/artwork`) tiene dos vistas: **Piezas** (nueva) y **Pantallas TV** (`/admin/products/signage`, D-072 sin cambios). Se elige producto + sucursal + titular y se ve UNA pieza que se adapta a TV 16:9 (1920 × 1080, sólo preview), Feed 4:5 (1080 × 1350) y Story/WhatsApp 9:16 (1080 × 1920); Feed y Story se descargan como PNG.
- **Foto comercial.** Una por producto, en el bucket **privado** `product-artwork` (5 MB, JPG/PNG) de Supabase Storage; en Postgres sólo la referencia (`product_artwork_photos`: ruta, tipo y peso; sin base64 ni blobs). Ruta `<organización>/<producto>/<uuid>.<ext>`: las políticas de `storage.objects` y los checks de la tabla aíslan por organización (`catalog.write` escribe, `products.read` lee). El navegador sube con su sesión y `set_product_artwork_photo` registra la foto leyendo tipo y peso de los **metadatos de Storage** (no del cliente); el servidor borra el objeto anterior/removido (mejor esfuerzo). Se edita en «Administrar producto → Foto para cartelería». **WebP se acepta al elegir el archivo pero se convierte a PNG en el navegador** (Satori no lo renderiza); fotos de más de 2.400 px o 5 MB se reducen antes de subir. Sin foto la pieza dibuja un panel de reemplazo sobrio.
- **Un modelo, tres renderers.** `OfferArtworkModel` (`lib/artwork.ts`) → `TvHeroOffer` / `FeedHeroOffer` / `StoryHeroOffer` (`components/artwork/hero-offer.tsx`). Colores, marca y medidas viven en `lib/artwork-tokens.ts` (BRAND_GREEN, PRICE_YELLOW, ACCENT_RED, BLACK, WHITE; un test impide colores sueltos en los componentes). Mismo componente en el **preview** (DOM, escalado con `transform`, sin scroll) y en el **PNG** (Satori), con la misma fuente embebida (Inter Black/Bold, OFL) y ajuste de texto determinístico por anchos reales de glifo (`lib/artwork-text.ts`): nada se corta ni se desborda y el resultado no depende del motor. Story respeta zonas seguras (250 px arriba, 340 px abajo).
- **Precio y promoción = POS.** `get_product_artwork(producto, sucursal)` entrega **hechos** (precio de la sucursal vigente > global; regla «llevando N» de la sucursal o la global D-068; tramos WEIGHT; disponibilidad) y `buildOfferSlide` (el helper de D-072: `calculateBranchPromotionLinePricing` / `applyWeightDiscount`) calcula la oferta. La pieza muestra **precio + condición** («$1.742,50 · LLEVANDO 3 UNIDADES · PRECIO NORMAL $2.050»), sin recalcular porcentajes; sin promoción sólo el precio vigente (nunca «llevando 3» ni descuento inventado); WEIGHT: `$17.900/KG` + «X KG» (o «DESDE N KG» con tramo real). Producto inactivo, fuera de la sucursal o sin precio ⇒ no se arma pieza (nunca a $0).
- **Titular.** Texto corto manual (default «OFERTA»; atajos X MAYOR / IMPERDIBLE / ESPECIAL), normalizado a mayúsculas, sin símbolos raros, ≤ 16 caracteres (20 desde D-075). **El precio no se escribe a mano.**
- **Export seguro (`POST /api/artwork/png`).** El navegador sólo manda `{productId, branchId, headline, format: feed|story}`; cualquier otro campo se ignora. El servidor vuelve a leer producto, foto (Storage, con la sesión del usuario; se comprueban los bytes reales: PNG/JPEG), precio, promoción y sucursal, y dibuja con `next/og` (Satori + resvg, ya incluido en Next; sin Puppeteer ni dependencias nuevas, Node runtime). Misma entrada ⇒ mismos bytes. `executeArtworkExport` devuelve además un `snapshot` (fecha, producto, sucursal, formato, titular, precio de lista/promocional en centavos) **que todavía no se persiste**: es lo que un historial de publicaciones tendría que guardar (Sprint 2).
- **Datos de contacto y logo.** *(Reemplazado por D-075: el logo real y el contacto por sucursal ya existen.)* En este sprint no había logo ni teléfono: la marca era el texto «SUPER OFERTAS» sobre una bandera verde y sólo se imprimía `branches.address`.
- **Fuera de alcance (Sprint 2+).** Slideshow con piezas en TV, grillas de productos, mayorista, publicación directa a Instagram/Facebook, WhatsApp automático, editor libre, IA/eliminación de fondo, historial de exportaciones, permiso propio (se usan `catalog.write` / `products.read`).
- **Decisiones no pedidas explícitamente (revisar):** (a) la marca va como constante de código y no desde la organización; (b) la Cartelería de TV de D-072 pasó a ser la subvista «Pantallas TV» (misma ruta, mismas tablas); (c) WebP se convierte a PNG en el navegador en vez de guardarse tal cual; (d) sin sucursal elegida se usa el precio general y la regla global D-068; la sucursal por defecto en pantalla es «Central» (o la primera activa); (e) las fuentes viajan embebidas en base64 en el código (~85 KB), también en el bundle del navegador del preview.

**Motivo:** piezas comerciales con la identidad del negocio, generadas desde el precio real del sistema y sin retocar nada a mano, listas para redes y WhatsApp.

## D-075 — Cartelería: identidad real (logo en la franja verde + contacto por sucursal) y plantilla «Collage» de 2 a 5 productos

**Status:** Active (implementado 2026-10-09; migración `202610090072` **sin aplicar**; depende del bucket `product-artwork` de la 071). No toca pricing, orden de descuentos, stock, sync offline ni RLS existente, ni la Cartelería de TV de D-072 (`offer-slide.tsx` y las pantallas públicas no cambian). **Mejora D-074**, no lo rehace.

- **Logo = asset de la organización en Storage.** No había ningún logo reutilizable (sólo los íconos PWA/POS). Tabla nueva `organization_artwork_logos` (una fila por organización: ruta, tipo, peso y medidas en px; sin base64/blobs) y el objeto vive en el **mismo bucket privado** `product-artwork`, carpeta `<organización>/branding/<uuid>.<png|jpg>` (las políticas de `storage.objects` de la 071 ya aíslan por la primera carpeta: `catalog.write` escribe/borra, `products.read` lee). RPC `set_organization_artwork_logo` (tipo/peso salen de los metadatos de Storage; las medidas las lee el **servidor** de la cabecera del archivo), `remove_organization_artwork_logo`. Se carga en Productos → Cartelería → Piezas → **Configurar identidad** (PNG transparente preferentemente, ≤ 5 MB; WebP se convierte a PNG en el navegador). Un logo apaisado se gira -90° dentro de la franja (se lee de abajo hacia arriba, como en las piezas actuales); uno vertical se deja. **Nunca se dibuja ni se recrea el logo**; si la organización aún no lo cargó, la franja imprime el nombre de la organización en vertical (último recurso) y Admin avisa.
- **Contacto = datos de la SUCURSAL.** Se reutiliza `branches.address` (la misma columna que edita «Sucursales»: una sola fuente de verdad) y se agregan `branches.phone` y `branches.city` (nullable, con checks). RPC `set_branch_artwork_contact` (permiso `branches.write`, el mismo que `save_branch`, que **no** cambió). La pieza imprime sólo lo cargado, nunca completa con datos de otra sucursal; sin sucursal («Precio general») o sin ningún dato no se dibuja el bloque. Se edita en el mismo modal **Configurar identidad** (botón compacto; no ocupa la pantalla).
- **`get_artwork_branding(sucursal)`** (`products.read`) entrega logo + contacto en un JSON; sucursal de otra organización ⇒ 42501. Precio y promoción siguen saliendo **sólo** de `get_product_artwork` (sin cambios; el collage lo llama una vez por producto).
- **Modelo y renderers compartidos.** `OfferArtworkModel { type: HERO|COLLAGE, headline, branch, branding, items[] }` (`lib/artwork.ts`) con `ArtworkBranding { businessName, logo, contact, colors }` (`lib/artwork-branding.ts`, geometría del logo `placeLogo`) y `OfferItem` (nombre, imagen, precio normal, precio promocional, condición, unidad). Piezas comunes en `components/artwork/artwork-parts.tsx` (lienzo, `BrandBand` con el logo, titular, nombre, foto, `PriceBadge`, `ContactBlock`): protagonista (TV/Feed/Story) y collage (Feed/Story) sólo las componen; `OfferArtwork` elige por tipo y lo usan el preview y el PNG. **`PRICE_BADGE_YELLOW`** / `PRICE_BADGE` en `lib/artwork-tokens.ts`: la pastilla amarilla (precio negro extra bold, ajustada al contenido) es la misma en ambas plantillas; sin el «99» flotante. TV no lleva contacto.
- **Collage.** De **2 a 5** productos distintos, en el orden elegido (↑ ↓, quitar, buscar por nombre/SKU/código de barras con el mismo selector de producto), con titular manual de la pieza (default «OFERTAS»; ≤ 20 letras, un solo titular, no por producto). Composición por cantidad en `lib/artwork-layout.ts`: 2 apilados · 3 = 2 + 1 grande · 4 = 2×2 · 5 = 2 + 2 + 1 ancho (compuesto de lado); Story usa las mismas composiciones dentro de las zonas seguras (250 px arriba / 340 px abajo). Cada ítem usa su foto comercial, nombre, **precio vigente de la sucursal**, precio promocional + condición («LLEVANDO 3 UNIDADES») y `/KG` si es por peso; ningún precio se escribe a mano. Un producto no disponible (inactivo, fuera de la sucursal, sin precio) **impide** armar/exportar el collage y se nombra en el mensaje (no se omite en silencio ni sale a $0). Un producto sin foto usa el panel de reemplazo y Admin avisa «N productos sin foto comercial» antes de exportar (no bloquea). Sin versión TV.
- **Export (`POST /api/artwork/png`).** El navegador sólo manda `{template, productId|productIds, branchId, headline, format: feed|story}` (el pedido anterior del protagonista sigue valiendo); logo, contacto, fotos, precios y promociones los resuelve el servidor con la sesión del usuario (una sucursal de otra organización responde 403; logo ilegible ⇒ 502, no se entrega una pieza sin el logo que la organización tiene registrado; bytes que no son PNG/JPG ⇒ 422). Misma entrada ⇒ mismos bytes. El `snapshot` (aún no persistido) ahora incluye plantilla, ítems con precios, `hasLogo` y contacto usados.
- **Ajuste de texto.** «X 3 KG», «X 2» y «250 GR» no se separan entre renglones (`groupWords`).
- **Fuera de alcance.** Publicar en Instagram/Facebook/WhatsApp, slideshow de collages en TV, editor tipo Canva, IA, historial de exportaciones, permiso propio (se usan `catalog.write` / `products.read` / `branches.write`).
- **Decisiones no pedidas explícitamente (revisar):** (a) el logo es de la **organización** y el contacto de la **sucursal** (si el negocio quisiera un teléfono único para todas, habría que cargarlo en cada sucursal); (b) el logo reutiliza el bucket `product-artwork` en vez de crear otro; (c) `MAX_HEADLINE_LENGTH` pasa de 16 a 20 para «OFERTAS DE POLLO»; (d) el protagonista dejó de usar la bandera «SUPER OFERTAS» y el precio ocupa una pastilla ajustada al contenido (antes, a todo el ancho); (e) teléfono/ciudad no están en el formulario de «Sucursales» (sólo en Configurar identidad) para no tocar `save_branch`.

**Motivo:** que las piezas representen la identidad real de SUPER OFERTAS (franja verde con el logo, contacto abajo, precio sobre amarillo, collages de varios cortes) sin que nadie retoque nada a mano.

## D-076 — Cartelería TV: la diapositiva usa la identidad de las piezas (foto, logo, precio amarillo) en 4 disposiciones rotativas

**Status:** Active (implementado 2026-10-10; migración `202610100073` **sin aplicar**; depende de la 069, 071 y 072). No toca pricing, orden de descuentos, stock, sync offline, tokens ni la infraestructura de Pantallas TV (token hasheado, polling de 30 s, rotación, duración, último estado ante un corte). **Reemplaza la presentación visual de D-072**; no cambia sus datos.

- **Un solo renderer.** `TvOfferSlide` (`components/artwork/tv-offer.tsx`) dibuja el mismo `OfferArtworkModel` que Piezas (franja verde + logo, titular rojo, nombre, foto comercial `object-fit: contain`, pastilla amarilla, con promoción «LLEVANDO N UNIDADES» + «PRECIO NORMAL»; sin contacto en TV). Lo usan el televisor, la vista previa de Piezas (formato TV, con selector de disposición) y el PNG. `OfferSlide` bordó y su prueba se eliminaron; también `nameFit`/`priceFitFor` (sólo los usaba ese diseño). `OfferSlideData` suma `unitType`, `regularPrice` e `imageUrl`; `slideToArtworkModel` la convierte al modelo de pieza con la **misma** conversión que Piezas (`slideToItemBase`): el precio sigue saliendo de `buildOfferSlide` (motor de pricing), sin fórmulas nuevas.
- **Disposiciones** (`lib/artwork-tv-layouts.ts`, `TV_LAYOUTS`, rectángulos puros): A foto izquierda · B foto derecha · C foto central (nombre abajo a la izquierda, precio a la derecha) · D diagonal (nombre arriba a la izquierda, foto abajo a la derecha, pastilla pegada a la foto). La diapositiva `n` usa la `n % 4` (determinístico, sin guardar nada ni migrar un «layout»). La foto ocupa 40–55 % del área útil. Titular: «OFERTA» (el TV no guarda titular por diapositiva).
- **Foto y logo en el TV.** Viven en el bucket **privado** `product-artwork`. Migración `202610100073`: `signage_payload` agrega `photo` (ruta + tipo) a cada diapositiva y `logo` al nivel superior; y una política de `storage.objects` **sólo `SELECT` para `anon`** sobre los objetos que una pantalla **habilitada** publica hoy (foto de un producto de sus diapositivas o logo de su organización), vía la función `public.signage_object_is_published` (en `public` porque `anon` no tiene uso sobre `app_private`). El navegador del TV nunca habla con Storage: pide `/api/tv/<token>/media/<id>` (y la vista previa del Admin `/api/tv-preview/<pantalla>/media/<id>` con la sesión); el servidor revalida el token con la RPC, toma la ruta **de la presentación** (nunca del pedido), descarga y comprueba que los bytes sean PNG/JPEG del tipo registrado. La URL lleva `?v=<archivo>` y se cachea (`immutable`). El JSON del TV no incluye rutas de Storage; el reproductor sólo acepta imágenes `/api/...`.
- **Fuera de alcance.** Editor de layout, collage en TV, titular por diapositiva, packs, historial, nuevos permisos.
- **Decisiones no pedidas explícitamente (revisar):** (a) la política anónima de Storage permite a `anon` leer (y listar) **nombres y bytes** de las fotos/logos de pantallas habilitadas: son las imágenes que ya muestra el TV público, con uuid no adivinable; la alternativa (clave de servicio en el Admin) se descartó por ampliar secretos; (b) la sala de espera del TV también adopta la identidad nueva (fondo blanco + franja verde); (c) sin logo cargado la franja imprime el nombre de la organización (respaldo ya existente en Piezas).

**Motivo:** que el televisor muestre publicidad de Super Ofertas y no una pantalla de caja, con una sola fuente visual para TV, Feed y Story.

## D-077 — Productos → Precios como pantalla de remito: buscador global, cantidad recibida, precio manual y guardado atómico

**Status:** Active (implementado 2026-10-11; migración `202610110074` **sin aplicar**; depende de la 065–068 y de `record_stock_operation`). No cambia pricing (fórmula, redondeo a $50, orden de descuentos), métodos de pago, el ledger `stock_movements`, la sucursal por dispositivo, el sync offline, RLS ni el POS (Central sigue vendiendo sin gate de stock, D-058). Reemplaza la planilla «carga masiva de costos» de D-068/D-070 (la RPC `bulk_set_product_costs` queda en la base sin uso desde el Admin).

- **Un solo buscador, en el servidor.** `list_pricing_rows(p_query, p_product_ids, p_limit ≤ 100, p_offset)` busca contra TODO el catálogo activo y de venta de la organización (cada palabra en nombre, categoría o SKU, sin acentos/mayúsculas; barcode exacto), pagina y devuelve por fila costo vigente, precio de lista global, regla de margen efectiva (`app_private.effective_margin`), margen propio y si la categoría está excluida. Permiso `prices.write`. La pestaña Precios ya no lista el catálogo (el formulario de filtros y la tabla de «Administrar» no se montan ahí, ni se piden sus consultas); el editor busca con debounce y «Mostrar más». Lo escrito vive por id de producto: cambiar la búsqueda no lo descarta (las filas con cambios fuera de la búsqueda se muestran aparte).
- **Tabla:** Producto · Categoría · Tipo de venta · Costo · Margen · Cantidad · Precio actual. Se eliminó el párrafo explicativo.
- **Cantidad = lo RECIBIDO en esta entrega** (`receivedQuantity`), nunca el stock total: se suma con `record_stock_operation('PURCHASE')` (tipo canónico de compra/recepción; no `OPENING_BALANCE`, no ajuste) en `organizations.production_branch_id` (sin sucursal productiva el lote entero se rechaza con mensaje claro; no hay selector de sucursal; el producto tiene que estar habilitado en esa sucursal). Un movimiento por producto. UNIT = entero positivo (12 → +12; 12,5 se rechaza); WEIGHT = kg con hasta 3 decimales → gramos enteros (12,500 → +12500 g), con el parser canónico `parseStockQuantityInput` y el tipo de venta de la base. Vacía = ningún movimiento.
- **Precio manual editable sólo donde no se deriva.** El precio se escribe a mano (nueva vigencia en `product_prices` vía `app_private.set_price_history`; la anterior queda cerrada) únicamente si NO se forma desde costo + margen efectivo, evaluado con el estado final de la fila: categoría excluida sin margen propio, organización sin margen, o producto sin costo. Con costo y margen efectivo (global o propio) el precio es automático y escribir uno se rechaza (no se crea una excepción ambigua). No se crean precios por sucursal; los vigentes se informan (`branchOverrides`). Un precio global programado a futuro no se pisa. **Reglas de Fran, todas por configuración de categorías excluidas (nunca por nombre):** Vaca y Pollo (no excluidas) = costo + margen automáticos; Cerdo (excluida) = precio manual, sin costo obligatorio; Cerdo con margen propio vuelve a ser automático.
- **Atomicidad:** UNA llamada `apply_pricing_receipt(p_request_key, p_items)` = una transacción para todo el lote. Orden por fila: margen propio (sin repreciar si trae costo) → costo + precio automático (`apply_product_cost`, el precio se forma UNA vez) → precio manual → al final el ingreso de stock. Un error en cualquier fila o en el stock revierte todo; Fran reintenta sin estados a medias. Las fórmulas y el stock viven sólo en SQL (React sólo proyecta con `calculateListPriceFromMargin`).
- **Idempotencia:** `pricing_receipt_requests` (organización + clave UUID generada por el navegador por intento + hash del pedido + resultado). La misma clave y el mismo pedido devuelven el resultado guardado con `replayed: true` sin volver a escribir (doble click, reintento de red); la misma clave con otros datos se rechaza. Dos pedidos simultáneos se serializan por el índice único. Una clave nueva (otra entrega) suma de nuevo. La UI además bloquea el botón y usa una bandera síncrona, vacía lo guardado (Cantidad vuelve a vacío) y refresca costo/precio/regla con filas frescas.
- **Alta de producto:** «Se vende en» arranca marcando sólo `organizations.production_branch_id`; el resto, destildado (sin nombres escritos a mano; sin sucursal productiva no se marca ninguna). La edición muestra exactamente el surtido guardado. Ambos modales comparten `ProductBranchChecklist`.
- **Decisiones no pedidas explícitamente (revisar):** (a) un campo escrito pero inválido (p. ej. 12,5 en un UNIT) bloquea el guardado en vez de ignorarse en silencio; (b) un producto automático SIN costo permite precio manual (no hay de dónde derivarlo; en cuanto se carga costo, deja de ser editable); (c) el ingreso exige que el producto esté habilitado en la sucursal productiva; (d) el importe acepta coma o punto decimal pero rechaza «3.500» (punto de miles) en vez de leerlo como 3,50.

**Motivo:** que Fran cargue la boleta del proveedor en UNA pantalla (buscar cualquier producto, costo, margen, cantidad recibida, precio manual) con un único «Guardar cambios» seguro ante errores y reintentos.

## D-078 — Auditoría por producto + sucursal: reconstruir el stock teórico desde el ledger, controlarlo contra las ventas y comparar con un conteo físico

**Contexto:** Avenida figuraba con 16,6 kg de Pata Muslo y físicamente no quedaba nada. Mostrar el stock actual no alcanza: hay que ver CÓMO se llegó a ese número y si las ventas y el ledger cuentan lo mismo. Sprint de **visibilidad**: no cambia POS, pricing, descuentos, Central, transferencias, el ledger ni movimientos históricos, y no crea un segundo stock.

**Decisión** (migración `202610120075`, sólo lectura):
- **Tres RPC** (`SECURITY DEFINER`, `STABLE`, organización derivada de la sesión con `require_permission`, ids de sucursal/producto validados contra esa organización, acceso por sucursal con `can_access_branch`): `get_product_sales_summary` (permiso `sales.read`), `get_stock_audit_summary` y `list_stock_audit_movements` (`stock.read`); más el helper privado `app_private.stock_audit_scope` (no ejecutable por clientes). Todo se agrega y pagina en el servidor.
- **Ventas por producto:** sólo `COMPLETED`, por `sales.completed_at` en días calendario de la zona horaria de la organización (el mismo criterio que `get_branch_sales_summary`); WEIGHT en gramos, UNIT en unidades; importe = subtotal − descuento general del ticket (igual que dashboard/Rentabilidad); tickets = ventas distintas, no líneas. Una fila por sucursal accesible.
- **Fórmula exacta del stock teórico:** `stock al inicio` (suma del ledger anterior al período) `+ Σ movimientos del período` (uno por tipo real) `= stock al cierre`; `+ movimientos posteriores` (0 si el período llega a hoy) `= stock teórico actual` (= `sum(quantity_grams)` de todo el ledger de la sucursal y el producto = `stock_levels`). El orden canónico y los límites del período son la tupla `(occurred_at, created_at, id)`: inicio inclusivo y fin exclusivo, sin huecos ni solapes aun con dos movimientos en el mismo instante.
- **Tipos reales del enum** (los 11 de `stock_movement_type`, sin inventar ninguno), agrupados en pantalla: Ingresos/recepciones = `PURCHASE`; Producción de desposte = `PRODUCTION_YIELD` (+); Saldo inicial = `OPENING_BALANCE` (+); Transferencias recibidas = `TRANSFER_IN`; Devoluciones/anulaciones de venta = `RETURN`; Ventas = `SALE`; Transferencias enviadas = `TRANSFER_OUT`; Mermas = `WASTE`; Consumo en desposte = `PRODUCTION_CONSUME` (−); Ajustes de conteo = `ADJUSTMENT_POSITIVE` / `ADJUSTMENT_NEGATIVE`. Un tipo que algún día falte en el mapa aparece como «Otros movimientos» y la fórmula sigue cerrando; las etiquetas son un `Record` exhaustivo del enum (si una migración agrega un tipo, el typecheck falla hasta decidir cómo mostrarlo).
- **Desde último ingreso:** el ancla es el último movimiento de entrada real (`PURCHASE`, `TRANSFER_IN`, `PRODUCTION_YIELD`, `OPENING_BALANCE`), inclusive, hasta hoy; se informa cuánto había antes del ingreso. Sin entradas registradas se muestra todo el historial. `RETURN` y `ADJUSTMENT_POSITIVE` no son recepciones y no mueven el ancla.
- **Control ventas vs. ledger, ticket por ticket:** lado ventas = `sale_items` del producto en cada venta; lado ledger = `-(Σ SALE + RETURN)` de ESA venta. Una venta `COMPLETED` debe descontar lo vendido; `PENDING_PAYMENT` ya reservó su stock (mismo criterio que Mercado Pago, D-055) y una `CANCELLED` debe netear 0 (`SALE` + `RETURN`); una restablecida por Mercado Pago (`SALE`, `RETURN`, `SALE`) también cierra. Cualquier ticket con diferencia, los `SALE` del período cuya venta no tiene ese producto (`orphanSaleMovements`) y la diferencia de titulares (ventas COMPLETED − descontado por ellas) se informan con un aviso y la lista de los 20 tickets más desviados. **No corrige nada.** `REFUNDED` no se controla (no existe un flujo de reembolso que defina su semántica).
- **Conteo físico:** escribir el valor sólo calcula `sistema / físico / diferencia` en el navegador. Registrarlo exige confirmar con un motivo y reutiliza el flujo existente (`record_stock_operation` `ADJUSTMENT`, que deja `ADJUSTMENT_POSITIVE/NEGATIVE` en el ledger); la acción del servidor rechaza si el stock del sistema cambió desde que se abrió la vista.
- **UI:** Ventas gana el filtro «Producto» (buscador del catálogo completo por nombre/SKU/código de barras, también inactivos), la tarjeta de métricas y el filtrado de la lista por producto con un embed PostgREST `!inner` (nunca ids por la URL); Stock → Por sucursal y el detalle de sucursal ganan «Ver movimientos» (y «Ver ventas» en el detalle del producto); `/admin/branch-stock/movements` es la pantalla de auditoría. Los enlaces conservan sucursal, producto y rango.

**Decisiones no pedidas explícitamente (revisar):** (a) el «Vendido» del resumen corto es neto de anulaciones (`SALE + RETURN`) para poder compararlo con las ventas COMPLETED; la tabla muestra ambos por separado; (b) el control usa `completed_at` de la VENTA y no el `occurred_at` del movimiento, así una venta offline sincronizada tarde cuenta en el día en que se hizo; (c) sólo `stock.read` alcanza para auditar el ledger; el control de ventas aparece únicamente con `sales.read` en esa sucursal; (d) la lista de Ventas sigue usando el offset fijo `-03:00` ya existente (pendiente histórico) mientras el resumen del producto usa la zona de la organización: coinciden para Buenos Aires; (e) un producto inactivo se puede auditar; (f) un rango manual se limita a 366 días como las demás RPC de ventas (el modo «desde el último ingreso» no tiene tope).

**Motivo:** poder decir, con el ledger y las ventas a la vista, si una diferencia de 16,6 kg viene de una merma no registrada, de una venta mal descontada o de mercadería que nunca llegó, antes de ajustar nada.

## D-079 — Resumen de sucursal como centro operativo: «Qué está pasando» con modales, sin pantallas nuevas

**Contexto:** Fran no quiere más pantallas, rutas ni pestañas. El Resumen debe contestar rápido qué se vende, qué llevar, qué casi no se vende, qué stock parece raro y cómo viene la sucursal. Sprint de **visibilidad**: no cambia POS, pricing, descuentos, el ledger, «qué llevar» (D-067) ni la auditoría (D-078), y no crea un segundo stock ni un segundo algoritmo.

**Decisión** (migración `202610140077`, sólo lectura):
- **Una sola superficie:** el Resumen existente. Cuatro bloques compactos (máx. 5 productos) y modales para profundizar; ninguna ruta nueva (un test lo verifica).
- **Dos RPC** (`SECURITY DEFINER`, `STABLE`, organización de la sesión, sucursal/producto validados contra ella, `can_access_branch`; permisos `sales.read` **y** `stock.read` porque mezclan ventas con stock): `get_branch_operations_summary(p_branch_id, p_from, p_to)` y `get_product_branch_activity(p_product_id)`. Una llamada por lote; nunca una consulta por producto ni miles de ventas al navegador.
- **Sólo productos activos del surtido** (`branch_product_assortment`) y con alguna señal (stock ≠ 0, ventas o diferencia); un producto sin stock ni movimiento no se devuelve.
- **Qué período usa cada bloque:** Más vendidos = el período elegido (ordena por facturación, como el bloque original, y muestra la cantidad; la tendencia compara la cantidad con el período anterior y se oculta en «Hoy» por ser un día incompleto); Qué llevar = **siempre** 7 días (`get_branch_carry_plan`, sin cambios); Baja rotación = 14 días; cobertura = `stock / (vendido 7d / 7)` (sin ventas: «Sin ventas últimos 7 días», nunca se divide por cero; stock negativo cuenta 0).
- **Baja rotación (regla simple, sin IA):** stock con sentido (≥ 1 kg / ≥ 2 u), último ingreso de hace ≥ 7 días, y (sin ventas en 14 días → «Baja rotación») o (vendió algo pero el stock alcanza ≥ 30 días al ritmo de 14 días → «Stock alto para su venta»). Es información, nunca una orden («no mandar»).
- **Requiere atención:** prioridad 0 vende bien y sin stock/negativo · 1 vende bien con < 1 día · 2 stock negativo / inconsistencia ventas-vs-ledger · 3 vende bien con 1–2 días · 4–5 agotado / bajo mínimo configurado (las alertas que ya existían). «Vende bien» = ≥ 3 kg o ≥ 5 u en 7 días. Un producto aparece una vez. «Stock sin rotación» vive sólo en Baja rotación (no se repite).
- **Inconsistencia:** misma regla que `get_stock_audit_summary` (COMPLETED y PENDING_PAYMENT esperan descontar lo vendido, CANCELLED 0, contra `-(SALE+RETURN)` por ticket), en lote y sobre los últimos 14 días; nunca se corrige nada. El modal calcula «Debería quedar» = stock antes del ingreso + ingresó − vendido por tickets − mermas ± ajustes − otras salidas, y la diferencia contra el stock del ledger.
- **Conteo físico:** el modal reutiliza `StockPhysicalCount` (escribir sólo calcula la diferencia; el ajuste exige motivo y confirmación y usa `record_stock_operation` ADJUSTMENT).
- **Sucursal productiva (Central):** sin Qué llevar ni Baja rotación; sin reglas de cobertura/inconsistencia; excluida de la comparación entre sucursales.

**Decisiones no pedidas explícitamente (revisar):** (a) los umbrales (1 kg, ≥ 7 días de ingreso, 30 días de cobertura, 3 kg/5 u de «vende bien», < 2 días) están en `INSIGHT_RULES` y son un primer criterio; (b) «Más vendidos» pasó del período fijo de 7 días al período elegido; (c) «Ver todas» de Requiere atención abre un modal en lugar de ir a `/admin/attention` (esa pantalla global sigue existiendo); (d) las 3 tarjetas de «Resumen de stock» pasaron a una línea; (e) el modal de producto enlaza al detalle de movimientos que ya existía; (f) «Qué llevar» se recalcula al abrir el modal (no viaja la lista completa en la página).

**Motivo:** que en 10–20 segundos se entienda qué pasa en la sucursal y qué hay que investigar, sin navegar a otro lado y sin duplicar lógica.

## D-080 — Completar costos faltantes de ventas: reparación de datos, no revaluación histórica

**Contexto:** el aviso «N líneas sin costo conocido» del Resumen de sucursal (D-079/migración `202610130076`) sólo informaba. Fran necesita saber qué líneas son, completarlas y que Ganancia/Margen bruto se recalculen, **sin tocar ningún costo histórico que ya exista**.

**Decisión** (migración `202610150078`, depende de `202610130076`):
- **Dónde vive el costo histórico:** `sale_items.cost_cents_snapshot` (centavos **por medida**: $/kg para WEIGHT, $/u para UNIT; NULL = desconocido). El costo de la línea se deriva siempre con `app_private.sale_item_cost_cents` (sin cambios). Por eso el servidor guarda el costo por medida y **no** un total por línea: WEIGHT `round(3800 $/kg × 2,500 kg)` = $9.500 se calcula al leer, en enteros.
- **Regla:** sólo se completa lo que es NULL. El UPDATE exige `cost_cents_snapshot is null` y bloquea las filas antes de escribir: una línea que alguien completó entre abrir el modal y guardar **no se pisa** (se informa como «omitida»). Nunca se cambian cantidades, precios, totales, promociones, pagos, estado ni stock.
- **Dos RPC** (`SECURITY DEFINER`, organización de la sesión, nunca del cliente): `get_missing_sale_costs(p_from, p_to, p_branch_id)` (`analytics.read`; mismo universo que el aviso: COMPLETED, sucursal, días calendario de la organización; agrupa por producto; tope 5000 líneas con `truncated`) y `complete_missing_sale_costs(...)` (`prices.write` **y** `analytics.read` sobre la sucursal; una transacción **por producto**; valida organización/sucursal/producto/rango/estado de cada línea pedida y completa sólo las que siguen sin costo).
- **Costo vigente = acción aparte y explícita** (`p_also_set_current_cost`): usa el helper canónico `app_private.apply_product_cost` (el mismo de `set_product_cost`). **Ese flujo repricia** cuando el producto es vendible y tiene margen efectivo propio o global (`price_outcome = REPRICED`); con categoría excluida/precio manual o sin margen no toca el precio. El modal recibe `repricesOnCostChange`, el margen y el precio de hoy (sólo con `prices.write`): la casilla «Guardar también como costo actual» **viene destildada** si repreciaría (con un aviso), y tildada si no cambia ningún precio. Si el costo vigente ya es ese, no abre vigencia nueva. El costo vigente existente se muestra sólo como **sugerencia** («Usar $ 3.800»): Fran confirma, nunca se asume que era el costo histórico.
- **Auditoría:** `audit_logs` (`write_audit`) evento `SALE_COSTS_BACKFILLED`, entidad `sale_items`, `entity_id` = producto, sucursal, actor, y en `after_data`: costo aplicado, ids de las líneas realmente reparadas, período, importe, si se guardó el costo vigente y el `priceOutcome`. No se escribe auditoría si no cambió nada.
- **UI:** el aviso es un botón («Completar costos») que abre un modal del Resumen (sin ruta ni pantalla nuevas): tabla por producto (cantidad, líneas, facturación, costo $/kg o $/u), «Ver líneas» (fecha, cantidad, venta #, importe), confirmación por producto; el Resumen se refresca solo (ganancia, margen, contador e importe).

**Decisiones no pedidas explícitamente (revisar):** (a) una llamada atómica **por producto**, no un lote de todos los productos; (b) completar el costo histórico exige `prices.write` además de `analytics.read`; (c) con costo vigente + repricing se pide la acción con casilla destildada y aviso, no un diálogo de confirmación extra; (d) sin permiso de precios el modal es sólo lectura y no recibe costos/precios/márgenes; (e) tope de 5000 líneas por llamada.

**Motivo:** que el aviso sea una herramienta con la menor fricción posible, sin ningún camino por el que completar un dato faltante reescriba historia ni cambie un precio de venta sin que Fran lo decida.

## D-081 — Admin en el celular: 4 tareas simples sobre las mismas pantallas y el mismo backend, y Stock rápido idempotente

**Contexto:** Fran quiere usar el teléfono para muy pocas tareas y una persona no técnica tiene que entender al instante qué tocar. No se adapta todo el Admin: el escritorio sigue igual.

**Decisión:**
- **Presentación, no app nueva.** Debajo de `lg` (1024 px; también celulares en horizontal y tablets en vertical) el Admin muestra pantallas simples sobre las **mismas rutas**: `/admin` = Inicio con 4 tareas (Ver sucursales, Qué llevar, Stock rápido, Nuevo producto); `/admin/branches` = rendimiento; `/admin/branches/[id]` = detalle vertical; `/admin/branches?view=carry` = Qué llevar; `/admin/stock` = Stock rápido; `/admin/products?view=new` = Nuevo producto. **No hay `/m` ni `/mobile`.** `?view=` sólo lo mira el celular. Cada página renderiza ambas presentaciones y el CSS elige (`lg:hidden` / `max-lg:hidden`): el costo es que el servidor también arma lo que el celular no muestra (las consultas pesadas del escritorio corren igual); se aceptó para no depender del user-agent.
- **Navegación:** barra superior fija (Volver destino fijo, título claro, Inicio) y barra inferior (Inicio · Sucursales · Qué llevar · Stock · Más); el Inicio no lleva barra (ya es el menú). «Más» abre las pantallas completas del escritorio (pueden verse apretadas) y Cerrar sesión. Los pasos internos (lista → preparar → revisar; sucursal → productos) usan el historial del navegador: el «atrás» del celular vuelve al paso anterior.
- **Lenguaje del negocio** (Qué llevar, Stock rápido, Agregar, Quitar, Conteo); nada de ledger/movement/adjustment en pantalla.
- **Qué llevar** reutiliza `get_branch_carry_plan` (`calculateCarryPlanAction`): sin fórmula nueva. Es un informe: «Preparar carga» edita cantidades (kg con 3 decimales) y «Continuar» muestra la lista final; **«Registrar la carga» abre Distribución (`create_stock_transfer`) con origen, destino y cantidades cargados** (`/admin/transfers?from=&to=&items=`): el traslado real lo confirma esa pantalla, no ésta. *Decisión no pedida (revisar):* el sistema no mueve stock desde «Qué llevar».
- **Stock rápido** = cambios **pendientes** por sucursal (se conservan al cambiar de sucursal y en `localStorage` por usuario) que se guardan **todos juntos** tras un resumen. Agregar y Quitar son **deltas del ledger** (nunca «fijar el stock»); Conteo calcula la diferencia contra el stock del sistema y deja el ajuste auditado (stock anterior, conteo, diferencia). Buscar/paginar es siempre del servidor (`get_branch_stock_status`, de a 20; un código de barras exacto cae a `search_products`).
- **Backend (migración `202610160079`):** `apply_quick_stock_changes(p_request_key, p_items)` + tabla `quick_stock_requests`. No hay un segundo mecanismo de stock: llama a `record_stock_operation` (**Agregar = `PURCHASE`**; **Quitar y Conteo = `ADJUSTMENT`**, que deja `ADJUSTMENT_NEGATIVE/POSITIVE`). Quitar **no** es una merma (no ensucia el reporte de mermas) y se calcula en el servidor bajo el mismo lock por producto/sucursal (`stock actual − cantidad`); si no hay tanto stock ese producto falla (`INSUFFICIENT_STOCK`), nunca queda negativo. El conteo con `expectedSystemQuantity` no se aplica si el stock cambió desde que se mostró (`STOCK_CHANGED`), igual que el conteo de la auditoría. Un producto fuera del surtido de la sucursal falla (`NOT_IN_BRANCH`).
- **Resultado parcial seguro:** cada producto se valida por separado; los válidos se agrupan por (sucursal, tipo) en UNA operación del ledger (≤100 líneas) y un error inesperado revierte sólo ese grupo (subtransacción). La UI muestra «No pudimos actualizar N productos» con el motivo y deja los fallidos pendientes.
- **Doble toque:** (1) `SingleFlight` en la UI (un guardado a la vez, botón deshabilitado); (2) clave de idempotencia por pedido (`RequestKeyBook`: misma clave mientras el pedido no cambia y no hubo respuesta; nueva tras cualquier respuesta del servidor); (3) la RPC devuelve el resultado guardado si repite la clave con el mismo pedido (`replayed`) y rechaza la misma clave con otro pedido. *No existía idempotencia en `record_stock_operation`*; sólo en `apply_pricing_receipt` (D-077), cuyo patrón se siguió.
- **Nuevo producto** usa el MISMO alta (`createProductModalAction` → `create_product_with_pricing`): precio por costo + margen vigente o manual según `newProductPricingState` (categoría excluida / sin margen), sucursal productiva marcada por defecto y las demás destildadas (`defaultNewProductBranchIds`). Al terminar: «Crear otro» / «Volver al inicio».
- **Quedó sólo en escritorio:** importación, precios masivos, configuración, etiquetas/cartelería, auditoría, desposte, tablas grandes (accesibles desde «Más», sin rediseño).

**Motivo:** dar al dueño las cuatro tareas del día a día en una mano, sin tocar el modelo de datos ni duplicar reglas de stock, precios, surtido ni «qué llevar».

## D-082 — Costos operativos por sucursal y Resultado operativo (sin segundo motor de rentabilidad)

**Contexto:** Ganancia bruta (D-079) deja afuera sueldos, alquiler, servicios y gastos. Fran quiere ver en el Resumen de cada sucursal y en Inicio cuánto queda después de esos costos, sin una pantalla nueva por función.

**Decisión** (migración `202610170080`, depende de `202610130076`):
- **Fórmula:** `resultado operativo = ganancia bruta − costos operativos imputables al período` (ventas − costo HISTÓRICO de mercadería = ganancia bruta). Se llama **«Resultado operativo»**, nunca «ganancia neta» (todavía no es un resultado contable/impositivo). `operating_margin_bps = resultado / ventas` se calcula en el servidor (la tarjeta lo muestra como nota; el monto manda).
- **Un solo motor:** `get_branch_operating_result` **envuelve** `get_branch_profitability_summary` (mismas ventas COMPLETED, mismo snapshot de costo, misma zona horaria, mismo permiso `analytics.read` y acceso por sucursal) y le resta los costos. No recalcula ventas ni costo de mercadería; el aviso de líneas sin costo y «Completar costos» (D-080) siguen igual.
- **Costos incompletos = resultado PARCIAL:** si hay líneas vendidas sin costo histórico (`missing_cost_items > 0`) el resultado se marca `is_partial` y la tarjeta dice «⚠ Parcial: existen ventas sin costo». No se esconde la incertidumbre.
- **Dos tipos de costo por sucursal:** (1) **mensuales recurrentes** (`branch_recurring_costs` + `branch_recurring_cost_versions`): se configuran una vez y rigen **desde una fecha**; (2) **gastos puntuales** (`branch_expenses`): fecha, concepto, importe.
- **Histórico, append-only:** el importe mensual NUNCA es una columna de la sucursal. Cambiar el alquiler **cierra** la versión vigente en la fecha elegida y abre otra (un trigger prohíbe borrar o reescribir una versión; sólo se puede cerrar la abierta; la exclusión `gist` impide vigencias solapadas). Agosto sigue valiendo lo que valía en agosto. Una corrección del mismo día deja la versión anterior «vacía» (`valid_to = valid_from`) en el historial. No se acepta un importe que empiece antes que la versión vigente (no se reescribe una vigencia anterior); una baja deja el historial y se puede reactivar desde su fecha.
- **Prorrateo:** por **días calendario de la organización** (`organizations.timezone`): `importe_mensual × días_del_período_en_ese_mes ÷ días_de_ese_mes`, mes por mes (nunca 30 fijo), y se redondea half-up **una vez por concepto y período** (el desglose del modal suma exactamente el total). `$310.000` en un mes de 31 días, 1 día = `$10.000`; un rango que cruza meses calcula cada mes con su propia cantidad de días y con la versión que regía cada día. El período incluye el día de hoy completo.
- **Gasto puntual:** se imputa completo si su fecha cae dentro del período; no puede estar en el futuro; se **anula** (`voided_*`, motivo obligatorio), nunca se borra. Idempotente por `request_key` (doble clic / reintento = un solo gasto; igual el alta de un costo mensual).
- **Permisos:** leer = `analytics.read` + acceso a la sucursal; escribir = `operating_costs.write` (permiso nuevo, lo recibe el rol de administración) + acceso a la sucursal. Las tablas no tienen grants para ningún cliente (sólo RPC `SECURITY DEFINER`, organización de la sesión); toda escritura va a `audit_logs`.
- **UI sin pantallas nuevas:** una sola tarjeta **«Resultado operativo»** en el Resumen de sucursal (negativo en rojo, con la nota «Ganancia bruta − $X de costos operativos» y el botón **«Configurar costos»**) que abre el modal «Costos operativos — SUCURSAL» (costos mensuales con «Cambiar importe / Dar de baja / Ver historial» y otros gastos con «Anular»). En **Inicio**, una tarjeta compacta por sucursal activa + el total de las visibles, con el selector Hoy / Ayer / 7 días / 30 días (`?preset=`). La **Central** se trata como cualquier sucursal con ventas propias (la distribución de mercadería no es una venta: no hay doble conteo) y se rotula «Central».

**Decisiones no pedidas explícitamente (revisar):** (a) el resultado de Inicio es la suma de las sucursales activas que el usuario puede ver; (b) un costo nuevo se ofrece «desde el primer día del mes en curso» y un cambio de importe «desde hoy» (se pueden cambiar); (c) las altas/cambios de costos y gastos exigen un permiso aparte (`operating_costs.write`) en vez de `prices.write`; (d) el móvil (D-081) no incorpora estas tarjetas todavía.

**Motivo:** dar el número que le importa al dueño sin duplicar el motor de rentabilidad y sin reescribir nunca un mes ya cerrado.

## D-083 — Descuentos generales por cantidad con escalones configurables (generaliza «llevando 3u»)

**Contexto:** el «Dto llevando 3u» (D-068) era una sola regla «desde 3 unidades». Fran necesita `3 → 15 %` y `5 → 20 %` (y poder agregar más) sin hardcodear nada.

**Decisión** (migración `202610180081`):
- **Modelo:** una lista de escalones `(minimum_units, discount_bps)` por organización (`organization_quantity_discount_tiers`: cantidad entera ≥ 2, bps enteros 1..9999, sin cantidades repetidas, **descuento estrictamente creciente con la cantidad**, hasta 10; `unit_bulk_discount_bps` queda como espejo del escalón más bajo, NULL = sin configurar). Se materializa en `branch_promotions` de **cada sucursal**, una fila vigente por escalón (`FROM_MINIMUM`; el índice único pasa a `(branch_id, scope, minimum_units)`). Editar un escalón **cierra** la fila (`active=false, valid_until`) y abre otra con id nuevo: las ventas históricas conservan su snapshot y las ventas offline pendientes siguen validando contra SU regla.
- **Regla de aplicación:** se aplica el **MAYOR escalón alcanzado** por la línea (mismo producto UNIT): con 3 → 15 % y 5 → 20 %: 1–2 u → 0 %, 3–4 → 15 %, 5 o más → 20 %. **Nunca se acumulan** (5 unidades = 20 %, no 15 % + 20 %). Sólo UNIT (un WEIGHT no la recibe) y por línea (productos distintos no se suman).
- **Precedencia (sin cambios):** precio manual (Central) > venta como Pack (con el % del pack) > promoción específica del producto (`PACK_FIXED_TOTAL`) > **descuento por cantidad de la sucursal** (un solo descuento por línea, sin acumular). Después, recargo de tarjeta (una vez sobre el total comercial de la línea) y por último el descuento general del ticket de Central (D-061).
- **POS online/offline:** el servidor ya entregaba las reglas como **array** (`branchPromotionsFromMinimum`) y el POS las guardaba una por fila en `catalog_branch_promotions`: el POS elige el escalón con `selectQuantityTier` (en `business-logic`, el motor de siempre) **sin internet**, y cada línea guarda `branchPromotionId / MinimumUnits / DiscountBps / DiscountedUnits / DiscountCents` del escalón aplicado. Rust (`insert_sale`) y `sync_offline_sale_core` validan cada línea contra la fila de ESE escalón (id, sucursal, mínimo, porcentaje) y recalculan el descuento: **no cambiaron**. No se exige que la línea use el mayor escalón posible (un POS con configuración vieja cobra de menos, nunca de más).
- **Configuración:** Productos → Precios → Configuración de precios → **«Descuentos por cantidad»** (lista con Editar / Eliminar / + Agregar escalón, orden automático por cantidad), guardada junto con margen/pack/tarjeta en `save_pricing_config(p_quantity_tiers)` (compatible: sin el parámetro el Admin anterior sigue funcionando: su único «Dto llevando 3u» equivale a un escalón «desde 3»). Cambiar escalones exige `catalog.write` (como antes) y **nunca cambia un precio de lista**.
- **Textos:** «Llevando 3 o más: 15% dto.» / «Llevando 5 o más: 20% dto.» (diálogo de cantidad del POS) y «$ 850/u desde 3 u · $ 800/u desde 5 u» en el catálogo; en el carrito sólo se ve el descuento realmente aplicado. Las etiquetas de góndola, las piezas y la cartelería de TV siguen anunciando el escalón **más bajo** («llevando 3»), como antes (`get_label_group`, `get_product_artwork` y `signage_payload` toman el de menor cantidad).

**Brecha preexistente (no tocada, anotada):** `sync_offline_sale_core` valida una regla `FROM_MINIMUM` cerrada **sin límite superior de tiempo** (sólo las reglas `EVERY_GROUP` vencen a las 24 h 10 min, igual que las versiones de pack). Con escalones que se editan más seguido conviene tratarla igual; cambiar la validación del sync es una decisión aparte (ver `TASKS.md`).

**Motivo:** generalizar la regla existente sin tocar precedencias, snapshots ni el sync, y sin números hardcodeados.

## D-084 — Cartelería de TV con promociones ya cargadas y grupos de promociones

**Contexto:** una pantalla sólo rotaba productos (D-072/D-076); las promociones de Promociones (`product_weight_discounts`: umbral por kg o pack a precio total) no se podían reproducir sin volver a cargar la oferta.

**Decisión** (migración `202610190082`, depende de `202610180081`):
- **Una pantalla = lista ordenada de entradas** (`digital_signage_slides.kind`): un **producto**, una **promoción** o un **grupo de promociones**. Se guarda con `save_signage_display_entries` (`save_signage_display` de sólo productos sigue existiendo para el Admin anterior).
- **Grupos** (`signage_promotion_groups` + `_items`): una selección ordenada con nombre único por organización (sin importar mayúsculas). **No copian nada** (ni precio, ni nombre, ni foto): apuntan a la promoción por id. Crear, renombrar, agregar/quitar y ordenar (↑ ↓) con `save_signage_group`; `delete_signage_group` **no elimina un grupo que alguna pantalla usa** (explica en cuáles) y nunca borra las promociones. Un mismo grupo se reutiliza en todas las pantallas.
- **Precio vigente real:** cada lectura (`signage_payload`) resuelve la promoción y el precio de lista actuales: si cambia el precio promocional la TV muestra el nuevo sin recrear el grupo. El texto de la oferta lo arma el motor existente (`applyWeightDiscount` para umbral; el pack muestra su total fijo «POR 2 KG» / «POR 3 UNIDADES» contra el precio normal de **esa cantidad**; un pack más caro que llevar suelto no se anuncia como promoción).
- **Vigencia:** ACTIVA (`active` y dentro de `valid_from/valid_until`), PRÓXIMA (todavía no empezó: empieza a rotar sola ese día) o VENCIDA/desactivada. El selector ofrece **Activas por defecto** (pestañas Próximas / Vencidas; las vencidas son de consulta). El televisor **saltea** lo no vigente; el grupo conserva la referencia (para editar/historial) y el editor muestra el motivo (`PROMO_EXPIRED`, `PROMO_UPCOMING`).
- **Sucursal:** por ids, nunca por nombre. Una pantalla con sucursal sólo reproduce promociones globales o de ESA sucursal y de productos de su surtido; una pantalla sin sucursal sólo las globales (precio global). El mismo grupo en otra pantalla se filtra distinto.
- **Imágenes privadas:** el bucket `product-artwork` **sigue privado**. El televisor pide `/api/tv/<token>/media/<id>` (el id de una promoción es único en la presentación), el servidor valida el token, saca la ruta de la presentación publicada y devuelve los bytes; la política `anon` de Storage (`signage_object_is_published`) se amplió **sólo** a la foto de los productos de promociones/grupos de una pantalla habilitada. Sin foto: el renderer dibuja su reemplazo y el editor avisa «⚠ Sin foto» (no impide reproducir).
- **Renderer y playback sin cambios:** `TvOfferSlide` (fondo blanco, franja verde con el logo, titular, foto, pastilla amarilla), `/tv/<token>`, polling de 30 s, fundido, pantalla completa y conservación ante cortes. Las promociones son otra fuente de `OfferSlideData`.
- **UI:** dentro de Productos → Cartelería → Pantallas (sin ítems de menú nuevos): «+ Agregar promociones» (selector con pestañas), «Agregar grupo…», «Administrar grupos» (modal) y «Guardar como grupo» desde el selector.

**Decisión no pedida (revisar):** un grupo necesita al menos 1 promoción; el catálogo del editor incluye las vencidas de los últimos 90 días (y las que algún grupo conserva).

**Motivo:** reutilizar las ofertas ya cargadas sin duplicarlas y que la TV nunca muestre algo vencido ni de otra sucursal.

## D-085 — Costo de personal automático por horas fichadas dentro del Resultado operativo; descuentos del POS con color por escalón

**Contexto:** el Resultado operativo (D-082) pedía cargar el sueldo de las empleadas como costo mensual. Ya existían las horas (`employee_shifts`, con la sucursal de cada jornada) y el valor hora versionado (`employee_hourly_rates`): cargar además el sueldo a mano duplicaba trabajo y datos. Aparte, en la lista del POS los escalones por cantidad (3 u, 5 u) se veían iguales (D-083).

**Decisión — personal** (migración `202610200083`, depende de `202610170080`; **sin tablas ni columnas nuevas**):
- **Reutiliza** `employee_shifts` (horas y `branch_id` de la JORNADA, no la sucursal habitual) y `employee_hourly_rates` (valor hora con vigencia, append-only por exclusión `gist`; `set_employee_hourly_rate` cierra la vigente y abre otra: el costo de septiembre nunca se recalcula con el valor de octubre). `get_branch_operating_result` y `get_branch_operating_costs` suman el personal al costo operativo: **la misma RPC alimenta el Resumen de sucursal, el modal «Configurar costos» y el Inicio** (no hay otro cálculo).
- **Cálculo** (`app_private.branch_labor_cost_rows`, un solo lugar): cada fichada se **intersecta** con el período (días calendario de la zona horaria de la organización) y con cada vigencia del valor hora; costo = Σ segundos × valor hora ÷ 3600, redondeado half-up **una vez por persona y sucursal** (el desglose y el total coinciden). Duración **exacta** (6 h 30 min × $4.000 = $26.000), nada de horas enteras. Una fichada 20:00 → 02:00 aporta 4 h al primer día y 2 h al siguiente.
- **Fichada abierta:** fin provisorio = ahora. No hay cron ni registros por hora: la misma consulta devuelve más horas más tarde. Para que el costo no dependa de que otro proceso haya corrido el barrido, el fin de una fichada sin salida es el **menor** de: ahora · último latido si el dispositivo lleva más de 90 s sin latir (espejo de `mark_overdue_shifts`) · entrada + `max_shift_hours` (sin evidencia, no se acumula sin tope). Una fichada `REQUIRES_REVIEW` con salida inferida cuenta hasta esa salida y se informa aparte (`labor_review_shifts`). **Diferencia conocida:** `get_timekeeping_report` sólo estima el pago de fichadas `CLOSED`.
- **Sin valor hora** para parte de las horas: esas horas cuestan 0 y se informa `labor_rate_missing` («Hay horas de personal sin valor hora cargado»). Un costo de personal exacto **no** vuelve exacta una ganancia bruta incompleta: `is_partial` sigue marcando ventas sin costo de mercadería.
- **Compatibilidad:** `get_branch_operating_result` se recrea (hay que borrarla para cambiar las columnas) con las mismas columnas y cinco nuevas al final (`labor_*`); `operating_cost_cents` ahora **incluye** el personal. Un Admin viejo ignora las columnas nuevas; un Admin nuevo contra un servidor sin la migración las toma como 0.
- **Permisos:** el total entra con `analytics.read` (como todo el resultado); el desglose por persona con su valor hora sólo se entrega con `timekeeping.read`.
- **Doble conteo:** el personal es automático, así que un costo mensual manual «Sueldo…/Empleada…» lo duplicaría. **No se borra nada solo:** el modal marca «Posible duplicado» en los costos mensuales cuyo nombre parece un sueldo (y la sucursal tiene horas en el período) y la sección Personal dice que no se carguen sueldos a mano. Los costos mensuales quedan para alquiler, internet, luz…
- **UI (sin pantallas nuevas):** en «Configurar costos», sección **PERSONAL — automático** (persona, valor hora, horas y costo del período, «Trabajando ahora», total). La tarjeta del Resumen sigue siendo UNA («Resultado operativo»; sin tarjeta «Costo personal»). Con una fichada abierta la tarjeta y el Inicio se vuelven a pedir cada 2 minutos (`AutoRefresh`, sólo con la pestaña visible).

**Decisión — POS (sólo visual, sin tocar pricing/sync):** cada escalón por cantidad toma su color por **POSICIÓN** (1.º ámbar, 2.º verde, 3.º violeta, 4.º naranja, 5.º lima, luego se repite; dos consecutivos nunca se parecen), nunca por su cantidad mínima; el **Pack** es siempre azul. Cada condición es un chip propio («$ 1.402,50/u desde 3 u», «$ 1.320/u desde 5 u», «Pack 10 u · 25% OFF · $ 1.237,50/u») en la lista Central, la grilla y el diálogo de cantidad (que marca «✓ Aplicado» el escalón que el motor está usando). Una fila de la lista admite hasta 4 chips: con más, el Pack se conserva y el resto se agrupa en «+N». El ticket impreso no cambia.

**Decisiones no pedidas (revisar):** (a) el tope de `max_shift_hours` y el corte por latido vencido para fichadas sin salida; (b) `REQUIRES_REVIEW` con salida inferida sí cuenta (distinto del reporte de Horas); (c) refresco automático cada 2 min; (d) el Pack pasó de verde a azul en el diálogo de cantidad (el verde ahora es el 2.º escalón).

**Motivo:** que el costo laboral entre solo al resultado, con la sucursal correcta y el valor hora de cada fecha, sin cargar nada a mano ni duplicar el sueldo.
