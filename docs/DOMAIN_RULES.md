# Domain Rules

Este archivo contiene reglas de negocio que no deben reinterpretarse durante una implementación.

## Unidades y precisión

- Dinero: **integer cents**.
- Peso: **integer grams**.
- No usar floats para dinero.
- `WEIGHT`: se vende por peso; UI en kg cuando corresponda.
- `UNIT`: se vende por unidades. Soportado end-to-end en el POS (online y offline): la línea se carga por cantidad entera (mínimo 1), nunca por balanza; `sale_items.quantity_units`/`stock_movements.quantity_grams` (reutilizado como contador de unidades con signo, mismo precedente que `PRODUCTION_YIELD`, ver D-038) registran unidades, nunca gramos. `approx_weight_grams` nunca interviene en stock/venta de `UNIT`.
- No mezclar kg y unidades en un único total sin separar semánticamente.
- Corregir la forma de venta (`WEIGHT ↔ UNIT`) de un producto ya creado sólo se permite si no tiene historial operativo (ventas, movimientos de stock, producción, promociones — ver D-040); precio/costo no bloquean por sí solos. Nunca se reinterpreta una cantidad ya registrada (gramos no pasan a leerse como unidades).

## Estados de venta

Sólo las ventas `COMPLETED` se consideran activas para métricas comerciales y consumo de stock. Una anulación conserva la venta y el pago y compensa stock mediante movimientos `RETURN`; no borra historia.

## Formación de precio

**Precio de venta = decisión manual.** El administrador carga directamente el precio de lista vigente (`product_prices`, vía `set_product_price`/`bulk_set_product_prices`) mirando mercado/competencia. No se pide costo ni margen para fijarlo, y no se recalcula automáticamente cuando cambia el costo, el descuento por medio de pago o cualquier otra configuración comercial (ver D-037). El flujo anterior de costo + markup → gross-up (D-006) quedó superseded; las tablas/RPC de ese flujo (`product_pricing_settings`, `save_product_pricing`, `calculate_product_price`, `set_cash_discount_and_reprice`) se conservan en la base para no perder historial, pero ninguna pantalla vigente vuelve a escribirlas.

**Costo = evidencia derivada**, nunca un input manual acoplado al precio:

- automático: al finalizar un desposte, el costo asignado por valor relativo de venta de cada output pasa a ser el costo vigente de ese producto (`product_costs`);
- manual: para un producto comprado ya terminado (no producido por desposte), se carga directo (`set_product_cost`), sin markup;
- puede no existir todavía: un producto con precio pero sin costo es válido; se muestra como costo no disponible, nunca se inventa.

Un producto puede tener precio de lista y no tener costo (todavía no se produjo/compró con costo registrado); la venta no se bloquea por eso.

## Recargo por tarjeta (D-044)

Decisión vigente (invierte la regla anterior, ver D-007/D-044):

El precio cargado manualmente en Productos (`product_prices.price_cents`) **es** el precio de:

- `CASH`
- `TRANSFER`
- `OTHER`

sin ningún ajuste. `DEBIT`/`CREDIT` ("Tarjeta" en el POS) pagan ese mismo precio **más un recargo** (porcentaje configurado en Admin → Productos → Precios → "Recargo por tarjeta").

Ejemplo: precio cargado $10.000, recargo configurado 10% → CASH = $10.000, TRANSFER = $10.000, DEBIT = $11.000, CREDIT = $11.000.

El nombre técnico histórico sigue conteniendo `cash_discount` (`organization_cash_discounts.cash_discount_bps`, `sale_items.cash_discount_bps`), pero la regla de producto vigente es **recargo por tarjeta**, nunca un descuento por ningún medio de pago. `sale_items.cash_discount_cents` queda siempre en 0 para toda venta nueva (ningún medio da descuento); el monto real del recargo se registra en `sale_items.card_surcharge_cents` (`>= 0`). Backend, POS online, POS offline y sync aplican la misma regla.

**PACK_FIXED_TOTAL SÍ lleva recargo por tarjeta** (corregido 2026-09-24, sin excepción): el total de un pack (ver "Promociones" abajo) sigue siendo invariante al peso/cantidad real, pero no al medio de pago — pagar con tarjeta recarga el total completo del pack. Ejemplo: "Vacío 2kg por $18.000" con tarjeta = $19.800. Para un pack `UNIT` con remanente, el recargo se aplica al total comercial completo (packs enteros + remanente juntos), nunca sólo al remanente: 45 hamburguesas (1 pack de 40 a $28.000 + 5 sueltas a $800 = $32.000 en efectivo) con tarjeta = $35.200, no $28.000 + 5×$880.

## Orden de ajustes

Orden vigente:

1. precio de lista (= precio de CASH/TRANSFER/OTHER, sin ajuste);
2. recargo por tarjeta (sólo DEBIT/CREDIT; D-044);
3. promoción por cantidad/regla comercial;
4. precio final.

Los porcentajes son secuenciales, no se suman.

Ejemplo (tarjeta):

- lista/efectivo $14.444,44;
- +10% tarjeta → $15.888,88;
- -5% promoción → $15.094,44.

Ejemplo (efectivo/transferencia): lista $14.444,44 → sin ajuste → -5% promoción → $13.722,22.

## Promociones

Dos modalidades (`promotion_mode`), ver D-039:

- **THRESHOLD** (umbral, "desde cierta cantidad"): porcentaje o precio fijo por kg, sin cambios respecto al modelo anterior. Sólo para productos `WEIGHT`.
- **PACK_FIXED_TOTAL** (pack a precio total, ej. "Vacío 2kg por $18.000", "Hamburguesa 40u por $28.000"): una cantidad concreta (no un umbral) a un precio total fijo, cargado directamente por el administrador — nunca un precio/kg o precio/unidad calculado a mano. Disponible para `WEIGHT` o `UNIT` según el tipo de venta del producto.

Las promociones conservan snapshots suficientes para reconstruir la venta histórica. `PERCENTAGE` se aplica después del descuento por pago. `FIXED_PRICE_PER_KG` fija el precio final por kg y se rechaza si supera el precio posterior al descuento por pago.

Reglas de `PACK_FIXED_TOTAL`:

- **WEIGHT**: el precio total se cobra siempre igual, sin importar el peso real pesado de la pieza (una pieza prearmada nunca da el peso nominal exacto); el peso real sigue registrándose para stock. Único control: el precio del pack no puede superar el precio de **lista** para el peso realmente pesado.
- **UNIT**: aplica en múltiplos exactos de la cantidad del pack (80 unidades = 2 packs de 40); el resto de unidades se cobra a precio normal, nunca un descuento inventado para una cantidad parcial.
- Un producto tiene como máximo una promoción `PACK_FIXED_TOTAL` activa por sucursal/global a la vez.
- El POS de mostrador vende ambos: pack `WEIGHT` (toggle explícito "Vender como pack", peso real siempre registrado) y pack `UNIT` (automático por múltiplos exactos de la cantidad tipeada, sin toggle — no tiene sentido pesar ni elegir, sólo llegar o no al múltiplo).

## Snapshots históricos

Una venta debe preservar los datos relevantes del momento:

- precio/lista aplicable;
- descuentos;
- promoción;
- costo histórico;
- cantidades;
- importes finales.

Nunca recalcular historia usando costo, precio o promociones actuales.

## Productos legacy

Puede haber ventas/productos anteriores al modelo de costo + markup.

Reglas:

- no inventar costo histórico;
- no completar historia con costo actual;
- si una venta no tiene costo snapshot, su facturación puede usarse pero su rentabilidad histórica no debe presentarse como conocida;
- los productos legacy no deben romper el POS mientras se migran al nuevo modelo.

## Categorías

Un producto tiene una categoría **principal** (`products.category_id`, sigue fijando color/nombre en pantallas que sólo necesitan una etiqueta) y puede además pertenecer a otras categorías (`product_category_assignments`, ver D-041). El POS filtra por cualquiera de las categorías asignadas; "Todos" nunca duplica un producto multicategoría.

Las tabs de categoría del POS **no se infieren desde los productos**: existe un directorio de categorías explícito (`get_pos_categories`/`categories` en `pull_pos_state`, tabla SQLite `catalog_categories`) con id/nombre/color/orden, independiente de qué producto sea principal de cada categoría. Una categoría con al menos una asignación (principal o secundaria) genera su tab con su propio nombre/color; una categoría sin ninguna asignación puede omitirse.

## Stock

Stock operativo = resultado del ledger/movimientos de stock.

Evitar estados derivados paralelos que puedan divergir.

Operaciones relevantes deben quedar trazables.

## Reposición

Objetivo de producto: el dueño debe saber rápidamente qué llevar a cada sucursal.

Lógica reportada:

- consumo reciente basado en ventas válidas;
- ventana de referencia de 7 días;
- promedio diario;
- cobertura = stock actual / consumo diario;
- crítico: sin stock o <1 día;
- alta prioridad: <2 días o debajo de mínimo;
- objetivo automático = promedio diario × días de cobertura;
- default reportado: 3 días;
- objetivo final = `max(objetivo_manual, objetivo_automático)`.

La implementación usa esa fórmula y esos umbrales. Limitación conocida: divide por la ventana completa de 7 días; un producto con sólo 1–2 días de historia puede tener demanda subestimada. No modificar la fórmula hasta contar con evidencia de uso real.

No modelar stock central del dueño.

## Rendiciones

La rendición compara:

- ventas del período;
- desglose por método;
- efectivo esperado;
- efectivo realmente recibido;
- diferencia.

**Efectivo esperado = CASH**, aunque otros medios puedan recibir descuento comercial.

Una rendición confirmada debe conservar snapshot histórico y no mutar silenciosamente por cambios futuros.

Una venta offline sincronizada después de confirmar la rendición no recalcula el snapshot. La UI advierte que existieron movimientos posteriores.

## Rentabilidad

Terminología:

- usar **Ganancia bruta**;
- no “ganancia neta” mientras no se modelen costos operativos completos.

Por producto/período:

- revenue = importe final real de venta;
- cost = costo snapshot de mercadería;
- gross profit = revenue - cost;
- rentabilidad sobre costo = gross profit / cost;
- ganancia por kg o unidad = gross profit / cantidad.

Rankings distintos:

- más vendido;
- mayor facturación;
- mayor ganancia bruta;
- mayor rentabilidad %;
- mayor ganancia por kg/unidad.

No asumir que “más vendido” = “más rentable”.

## Desposte / Producción

Un `production_batch` transforma un insumo de origen (peso, gramos enteros) en múltiples `production_batch_outputs` (productos reales del catálogo) más merma.

- Peso: gramos enteros. Dinero: centavos enteros. Sin excepciones.
- `merma = peso_entrada - suma(peso_outputs)`. No se permite finalizar si la suma de outputs supera el peso de entrada.
- `costo_promedio_kg_vendible = costo_total / kg_vendibles` es un promedio global; nunca se presenta como el costo real de un corte específico.
- El costo por output se distribuye por **valor relativo de venta** (`valor_output / valor_total × costo_total`). Es una asignación estimada, no el costo de compra individual del corte.
- Todo output registra su **peso real producido** (`output_weight_grams`), siempre obligatorio, sea el producto `WEIGHT` o `UNIT`. Un output cuyo producto se vende por unidad registra **además** la cantidad de unidades obtenidas (`output_quantity_units`, obligatoria sólo en ese caso) — ver D-038.
- El **valor comercial** (para asignar costo) usa una fórmula distinta según el tipo: `WEIGHT` = peso × precio/kg; `UNIT` = cantidad de unidades × precio/unidad. El peso real de un output `UNIT` (p. ej. 2 arrollados = 2,640 kg) **nunca** entra en esta cuenta, aunque siempre se registre.
- La **merma** es `input_weight_grams - SUM(output_weight_grams de TODOS los outputs, sean WEIGHT o UNIT)`: el peso real de un output `UNIT` sí cuenta para este balance físico, aunque no determine su valor comercial ni su costo asignado.
- `products.approx_weight_grams` (opcional) es distinto: una referencia informativa **por producto**, no ligada a ningún lote (p. ej. "cabeza entera, aprox 5 kg" en la ficha del producto); nunca interviene en precio, costo, asignación ni en el balance de merma de ningún lote — para eso siempre se usa el peso real cargado en ese lote.
- La suma de los costos asignados debe ser **exactamente igual** al costo total del lote. Se distribuye el residuo de redondeo determinísticamente (mayor resto primero, empate por `product_id`), nunca se acepta una diferencia de centavos.
- Al finalizar se toma un snapshot del precio de venta vigente de cada output (reutilizando `product_prices`, no un sistema paralelo). Si un output no tiene precio vigente, se bloquea el cálculo y se informa cuál producto lo necesita. Al mismo tiempo, el costo asignado de cada output pasa a ser el costo vigente de ese producto en `product_costs` (ver "Formación de precio" arriba y D-037): el costo se alimenta solo, nunca hay que cargarlo a mano para un producto producido.
- Estados: `DRAFT` (editable), `COMPLETED` (histórico, inmutable), `CANCELLED` (sólo permitido desde `DRAFT`; cancelar un lote completado requeriría una reversión que todavía no existe).
- Un lote completado nunca se reescribe silenciosamente.
- Es información administrativa (costo de compra, costo asignado, márgenes): pertenece a Admin, no al POS de mostrador. Los permisos `production.read`/`production.write` son exclusivos del rol `admin` (mismo patrón que `settlements.*`/`analytics.read`).

### Integración con stock

`stock_movements` es el único ledger de stock (ver sección "Stock" arriba); el desposte no introduce un segundo modelo. Al finalizar, un lote:

- consume el insumo de origen completo (`PRODUCTION_CONSUME`, negativo, por `input_weight_grams`);
- produce stock de cada output (`PRODUCTION_YIELD`, positivo, por su peso obtenido);
- la merma nunca es un movimiento de stock de ningún producto: es la diferencia aritmética, informativa (`production_batches.waste_grams`), no inventario.

Igual que WASTE/ADJUSTMENT_NEGATIVE, el stock resultante puede quedar negativo; no se clampea.

### Materia prima vs producto de venta

Un producto puede ser `RAW_MATERIAL` (sólo insumo de desposte), `SELLABLE` (sólo catálogo/POS, valor por defecto de todo producto existente) o `BOTH`.

- El selector de insumo de un desposte sólo ofrece productos `RAW_MATERIAL`/`BOTH`, activos y por peso.
- El selector de outputs de un desposte sólo ofrece productos `SELLABLE`/`BOTH`, activos y por peso.
- Un producto `RAW_MATERIAL` puro no necesita costo/margen de venta configurado (no se forma un precio de lista para algo que no se vende directo); su costo se registra en cada desposte donde se usa como insumo.
- Cambiar el rol de un producto no reescribe despostes ya creados: los outputs ya guardados de un lote en borrador no se invalidan retroactivamente si el rol del producto cambia después.

### Sucursal habitual de producción

`organizations.production_branch_id` es la sucursal donde un desposte genera stock por defecto cuando no se indica una explícitamente (normalmente Central, donde llegan las materias primas). No existe una sucursal ficticia "Depósito"; Central sigue siendo una sucursal comercial real (ver D-011 y D-033). Si no hay sucursal productiva configurada, crear un desposte sin indicar sucursal se bloquea con un mensaje claro; no se asume ninguna por defecto.

### Distribución / transferencias entre sucursales

Una transferencia mueve stock ya existente de una sucursal origen a una sucursal destino, dentro de la misma organización. No es lo mismo que un desposte: un desposte transforma insumo en productos; una transferencia sólo mueve stock ya producido. No se combinan en una sola operación: primero todo el resultado de un desposte queda en la sucursal productiva, después se distribuye.

- Reutiliza el ledger existente `stock_movements` con los tipos `TRANSFER_OUT` (negativo, origen) y `TRANSFER_IN` (positivo, destino), ya definidos en el enum desde el sprint de ventas pero sin usar hasta ahora. No se crea un segundo modelo de inventario.
- Alcance de este sprint: sólo productos `WEIGHT`. No mezclar kg y unidades en una misma transferencia (ver "Unidades y precisión").
- Origen y destino deben ser sucursales distintas de la misma organización.
- Un mismo producto no puede repetirse en los ítems de una misma transferencia.
- Debe validarse que la sucursal de origen tenga stock suficiente para cada ítem antes de aplicar la transferencia; la validación crítica vive en el servidor (RPC), no sólo en la UI.
- Es atómica: si cualquier ítem falla (stock insuficiente, producto inválido), no se aplica ningún movimiento de esa transferencia. La atomicidad la da que toda la operación corre dentro de una única función de base de datos (una excepción revierte la transacción completa), no una lógica de compensación manual en la aplicación.
- El stock global de un producto se conserva siempre: lo que baja en origen sube exactamente igual en destino.
- Queda historial suficiente para auditar: organización, sucursal origen, sucursal destino, fecha, usuario, productos, cantidades, notas opcionales. No se modela todavía una recepción en dos etapas (confirmar llegada en destino); la transferencia queda aplicada de forma inmediata y atómica.
- Es una operación administrativa: mismos permisos que Desposte (`stock.write`/`stock.read`, ya existentes), nunca otorgados al rol `employee`.

## Control horario

- el empleado marca entrada/salida;
- después del PIN, un empleado sin turno debe marcar entrada antes de operar normalmente;
- no escribe horas manualmente;
- online: hora autoritativa del servidor;
- offline: registrar hora local + origen offline + posterior sync;
- un empleado no puede tener dos turnos abiertos;
- un turno que supera el máximo normal no se auto-cierra;
- default reportado: 12 h;
- pasa a revisión;
- Admin corrige salida con motivo;
- corrección queda auditada.
- salir del operador o cerrar normalmente la ventana con un turno abierto registra primero el clock-out en SQLite/outbox y no cierra la sesión Auth del dispositivo;
- esa salida local es idempotente: repetir el cierre no crea dos clock-outs;
- crash, kill forzado o corte eléctrico no garantizan ejecutar lógica de cierre y no autorizan a inventar una hora de salida.

Limitación no prioritaria: si un clock-out offline excede el límite, es deseable conservar en el futuro el timestamp/intento como evidencia aunque el turno permanezca `REQUIRES_REVIEW`.

## Tarifa por hora

- tarifa con historial de vigencia;
- períodos históricos usan la tarifa vigente en su fecha;
- pago estimado = tiempo trabajado × tarifa aplicable;
- no representa liquidación laboral/legal completa.

## Eliminación de empleados

Empleado con historia:

- desactivar;
- revocar acceso/PIN;
- retirar de operadores disponibles;
- conservar ventas, turnos y auditoría.

No hard-delete si existen referencias históricas.
