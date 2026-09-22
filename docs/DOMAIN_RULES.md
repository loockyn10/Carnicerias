# Domain Rules

Este archivo contiene reglas de negocio que no deben reinterpretarse durante una implementación.

## Unidades y precisión

- Dinero: **integer cents**.
- Peso: **integer grams**.
- No usar floats para dinero.
- `WEIGHT`: se vende por peso; UI en kg cuando corresponda.
- `UNIT`: se vende por unidades.
- No mezclar kg y unidades en un único total sin separar semánticamente.

## Estados de venta

Sólo las ventas `COMPLETED` se consideran activas para métricas comerciales y consumo de stock. Una anulación conserva la venta y el pago y compensa stock mediante movimientos `RETURN`; no borra historia.

## Formación de precio

El flujo normal es:

1. costo;
2. ganancia deseada sobre costo;
3. precio objetivo descontado;
4. gross-up para obtener precio de lista.

La “ganancia %” configurada es **markup sobre costo**, no margen financiero sobre venta.

Ejemplo:

- costo: $10.000;
- markup: 30%;
- precio objetivo: $13.000.

Si el descuento elegible es 10%:

`precio_lista = precio_objetivo / (1 - 0,10)`

Resultado aproximado:

- lista: $14.444,44;
- luego 10% de descuento: $13.000.

No usar simplemente `precio_objetivo × 1,10`.

## Descuento por medio de pago

Decisión vigente:

Elegibles:

- `CASH`
- `TRANSFER`
- `OTHER`

No elegibles:

- `DEBIT`
- `CREDIT`

El nombre técnico histórico puede seguir conteniendo `cash_discount`, pero la regla de producto es **descuento por medio de pago elegible**. Backend, POS online, POS offline y sync aplican la misma elegibilidad.

## Orden de descuentos

Orden vigente:

1. precio de lista;
2. descuento por medio de pago elegible;
3. promoción por cantidad/regla comercial;
4. precio final.

Los porcentajes son secuenciales, no se suman.

Ejemplo:

- lista $14.444,44;
- -10% medio de pago → $13.000;
- -5% promoción → $12.350.

## Promociones

Tipos conocidos:

- porcentaje;
- precio fijo por kg.

Las promociones conservan snapshots suficientes para reconstruir la venta histórica. `PERCENTAGE` se aplica después del descuento por pago. `FIXED_PRICE_PER_KG` fija el precio final por kg y se rechaza si supera el precio posterior al descuento por pago.

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
- La suma de los costos asignados debe ser **exactamente igual** al costo total del lote. Se distribuye el residuo de redondeo determinísticamente (mayor resto primero, empate por `product_id`), nunca se acepta una diferencia de centavos.
- Al finalizar se toma un snapshot del precio de venta vigente de cada output (reutilizando `product_prices`, no un sistema paralelo). Si un output no tiene precio vigente, se bloquea el cálculo y se informa cuál producto lo necesita.
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
