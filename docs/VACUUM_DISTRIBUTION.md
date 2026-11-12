# Distribución de envasados a supermercados

Área `Admin → Envasados → Distribución` (`/admin/vacuum/distribution`). Producir en Central → identificar cada paquete → preparar entregas → distribuir → conciliar ventas → recibir devoluciones → controlar el inventario. Está integrada en Envasados (mismos paquetes, mismo ledger de stock, mismos permisos y RLS); no es otra aplicación ni otra contabilidad. Los supermercados venden con sus propios sistemas: **no hay integración con sus POS ni facturación electrónica** en esta etapa.

## Migraciones (en orden)

| Migración | Qué hace | Estado verificado |
| --- | --- | --- |
| `202611070095_vacuum_pos_sales.sql` | Estado de los paquetes, venta desde el POS | **Sin aplicar** (2026-11-07). El 2026-11-12 `supabase migration list --linked` respondió 403 (el login de la CLI perdió privilegios): **no se pudo reverificar**. Confirmar antes de aplicar. |
| `202611070096_vacuum_station.sql` | RPC de lectura de la estación | Sin aplicar (2026-11-07) |
| `202611120097_vacuum_distribution.sql` | Supermercados, identificador logístico, entregas, estados nuevos, stock `DISTRIBUTION_OUT` | Sin aplicar (nueva) |
| `202611120098_vacuum_distribution_returns.sql` | Conciliación, devoluciones, estadísticas, stock `DISTRIBUTION_RETURN` | Sin aplicar (nueva) |

Orden: `supabase migration list --linked` → `supabase db push --dry-run` (debe listar sólo lo que falte, en este orden) → `supabase db push` → desplegar el Admin → `pnpm db:types` (comparar con la edición manual de `database.types.ts`). Las dos nuevas **no modifican** migraciones anteriores: reemplazan funciones con `create or replace` y agregan constraints nuevos. Dependen de la 095 (estado de paquetes): no se pueden aplicar sin ella.

## Modelo de inventario (una sola contabilidad)

- **Ubicación/estado físico de cada paquete**: `vacuum_package_state` (la tabla de la 095), con estados nuevos. Un paquete tiene UN estado: no puede estar disponible en dos lugares.

| Categoría pedida | Estado en la base |
| --- | --- |
| Disponible en Central | `AVAILABLE` con `current_branch_id` = Central |
| Reservada para entregar | `RESERVED` (en una entrega en borrador) |
| Despachada a supermercados | `DISPATCHED` |
| Vendida | `SOLD` (caja del POS) · `SOLD_EXTERNAL` (informado por el supermercado) · línea `SOLD_FIRM` (venta mayorista firme, sigue `DISPATCHED`) |
| Devuelta en cuarentena | `QUARANTINE` |
| Autorizada para reingresar | devolución `APPROVED`: la aprobación y el reingreso ocurren en la misma transacción → vuelve a `AVAILABLE` |
| Descartada | `DISCARDED` |

- **Cantidades de stock**: el ledger `stock_movements` de siempre. Confirmar una entrega escribe UN movimiento `DISTRIBUTION_OUT` por producto (gramos reales, sucursal de origen, vinculado a la entrega) con índice único por (entrega, producto): confirmar dos veces no duplica. Un reingreso aprobado escribe un `DISTRIBUTION_RETURN` por devolución (índice único). Rechazar o descartar no mueve stock (ya salió al despachar). Envasar sigue sin mover stock (D-091). Si el stock de la sucursal queda negativo al despachar se informa, no se bloquea (el ledger puede ir atrasado respecto de lo envasado).
- **Físico vs comercial vs facturación vs cobranza**: sólo se modela el movimiento físico y el resultado comercial por paquete (`outcome`: `PENDING`, `SOLD_FIRM`, `SOLD_REPORTED`, `RETURNED`). En **venta mayorista firme** la operación comercial ocurre al despachar (`SOLD_FIRM`); en **consignación** despachar NO es vender (`PENDING` hasta que el supermercado informe). No hay precio mayorista propio: los valores son el **precio comercial de góndola** del paquete (el del EAN). Una devolución de una venta firme queda marcada `credit_required` (pendiente de nota de crédito); no se emite nada.
- **Convivencia con el POS (095)**: el POS sólo ofrece los `AVAILABLE` de su sucursal, así que reservados, despachados y en cuarentena no llegan a las cajas. Si una caja offline igual vendiera uno, la venta se registra (nunca se pierde) con el conflicto nuevo `DISTRIBUTED` (`sync_vacuum_package_line` reemplazada con ese único cambio). `move_vacuum_packages` y `void_vacuum_package` siguen exigiendo `AVAILABLE`.
- **Clientes**: `poultry_customers` es específico del módulo avícola (listas de precios de pollo): no se reutiliza. `distribution_clients` (la empresa: CUIT validado con dígito verificador, razón social, modalidad por defecto) y `distribution_sites` (establecimientos: dirección, localidad, teléfono, contacto, día habitual de reposición 1–7, modalidad propia opcional). Los establecimientos de un supermercado NO son las sucursales internas.

## Identificador logístico (≠ EAN-13 comercial)

Cada paquete tiene un código de 9 caracteres (alfabeto de Crockford sin I/L/O/U: 8 aleatorios + 1 de control), único por organización, en `vacuum_package_logistics` (1 a 1 con `vacuum_packages`, que es inmutable; también se asigna a los paquetes anteriores). Se lee tolerando mayúsculas, guiones y O/I/L. Se codifica en **Code 128 B** (134 módulos; módulo de 0,25 mm = 2 puntos a 203 dpi). Un EAN-13 NO identifica un paquete (dos pueden compartirlo): la pantalla lo rechaza en entregas, devoluciones y conciliación. El formato del EAN-13 no cambió (la etiqueta de precio es idéntica con o sin código logístico: hay test).

**Evaluación de la etiqueta informativa** (medido con el layout real): en **55 × 44 mm** incorporar el código obliga a achicar la tipografía un **12 %**: no se acepta (el tope es 8 %), así que la informativa queda **exactamente como era** y el código va en una **etiqueta logística adicional** (mismo papel que la informativa: corte, código grande con módulo de 0,3 mm, lote, peso, fechas y «uso interno · no es el código de venta»). En 58 × 40 tampoco entra; desde unos **50 mm de alto** (por ejemplo 58 × 50) entra en la informativa sin achicar nada. La estación puede imprimir la logística sola cuando la informativa no la lleva (Dispositivos → «Imprimir también la etiqueta logística…», apagada por defecto) y cada paquete se reimprime desde la entrega («Etiqueta logística»). Alternativa sin tocar nada: subir el alto en Envasados → Configuración.

## Flujo de trabajo

1. **Supermercados** (`/clients`): alta/edición de clientes y establecimientos.
2. **Nueva entrega** (`/new`): establecimiento + fecha → **borrador** (los paquetes agregados quedan RESERVADOS: ni otra entrega ni el POS los pueden tomar) → agregar por cantidad (primero los que vencen antes), escaneando el identificador, o de la lista → revisar el detalle (por producto, lotes, vencimientos, advertencia de vencimientos próximos) → **confirmar**. Sólo se ofrecen paquetes `AVAILABLE` en la sucursal de origen y **no vencidos a la fecha de entrega**. Confirmar es transaccional (una función = una transacción: revalida cada paquete, mueve el estado, escribe el stock y congela totales y datos del destinatario) e idempotente (repetir devuelve la entrega sin mover nada). Un borrador se puede cancelar (libera los paquetes); una entrega confirmada no (la mercadería ya salió).
3. **Remito operativo** (`/deliveries/[id]/remito`): hoja A4 imprimible con destinatario (datos congelados al confirmar), productos, paquetes con su identificador, kilos, lotes, vencimientos y firmas. Dice en el encabezado y al pie que **no es un remito ni una factura fiscal**.
4. **Reposición**: «Reposición: tomar como base la entrega anterior» propone las mismas cantidades por producto acotadas a lo disponible y muestra lo que falta. Es sólo una propuesta: nunca se crea ni se confirma una entrega sola.
5. **Conciliación** (`/deliveries/[id]`): ventas informadas de DOS maneras que no se mezclan — paquetes **identificados** (escaneando el código; el paquete pasa a `SOLD_EXTERNAL`) y ventas **sólo por cantidad** (se guardan como estimación y **no marcan ningún paquete**; no se pueden informar más que los pendientes). Pendientes = entregados − vendidos firmes − identificados − por cantidad − devueltos − devolución por recibir. Se detectan diferencias (informes de más, paquetes sin explicar, paquetes vencidos en el supermercado). Cerrar la conciliación con paquetes sin explicar exige una nota y deja la diferencia registrada; cerrada, no acepta más informes de venta (las devoluciones físicas sí).
6. **Devoluciones** (`/returns`): registrar (motivo; el paquete sigue siendo del supermercado) → **recibir en Central** (entra en `QUARANTINE`; se anota el estado del envase y si se verificó la conservación) → inspección → decisión con motivo obligatorio: **aprobar reingreso**, rechazar (queda en cuarentena) o descartar. Estados: Pendiente de recepción → Recibido en cuarentena → Pendiente de inspección → Aprobado para reingreso / Rechazado / Descartado. **Un paquete devuelto nunca vuelve solo a estar disponible**: la aprobación exige el permiso `distribution.approve_reentry`, que no esté vencido, envase `INTACT` y conservación verificada (la base lo valida y además lo garantiza con un check de la tabla: ningún SQL directo puede aprobar un envase dañado). Queda usuario, fecha y motivo. Las fechas de elaboración y vencimiento no se tocan (`vacuum_packages` es inmutable).
7. **Panel** (`/distribution`): supermercados activos, paquetes y kg entregados, vendidos confirmados (firmes + identificados), ventas por cantidad **estimadas** (se muestran aparte, con marca y borde distintos, nunca sumadas a lo confirmado), devueltos, pendientes, rotación (confirmada y, aparte, con la estimación), valor entregado, valor de ventas confirmadas, cortes más vendidos y con mayor devolución, por corte y por establecimiento, con filtros por supermercado, establecimiento, fecha, producto y categoría. Lo entregado no se presenta como facturación.

Permisos nuevos (se dan al rol administrador): `distribution.read`, `distribution.write` (clientes, entregas, conciliación, registrar/recibir devoluciones) y `distribution.approve_reentry` (decidir sobre devoluciones). RLS por organización en todas las tablas (lectura con permiso; las entregas además por sucursal de origen); escritura sólo por RPC.

## Límites conocidos

- No hay precio mayorista propio ni facturación/cobranza; el remito es operativo, no fiscal. Una devolución de venta firme sólo queda marcada para la nota de crédito.
- Un paquete informado como vendido no se puede «des-informar» desde la pantalla (corregirlo requiere SQL por ahora). Una entrega confirmada no se anula (se registran devoluciones).
- Una venta de caja offline de un paquete ya despachado se registra con conflicto `DISTRIBUTED` y descontó stock dos veces (al despachar y al vender): se resuelve a mano en Conflictos de venta (igual que D-091).
- El escaneo es por teclado (el lector HID escribe el código y Enter); no se probó con lector ni impresora físicos.
- Las estadísticas por categoría usan la categoría ACTUAL del producto.
