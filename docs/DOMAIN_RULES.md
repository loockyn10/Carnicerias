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
