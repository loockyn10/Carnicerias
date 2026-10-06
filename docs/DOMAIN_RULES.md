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

Sólo las ventas `COMPLETED` se consideran activas para métricas comerciales y recaudación. Una anulación conserva la venta y el pago y compensa stock mediante movimientos `RETURN`; no borra historia.

`PENDING_PAYMENT` (D-055): venta Mercado Pago cuyo pago todavía no fue acreditado. **No es dinero cobrado**: no suma a rendiciones, dashboard, analítica ni reposición, pero su stock queda reservado (descontado). Pasa a `COMPLETED` cuando el backend confirma la acreditación y a `CANCELLED` (stock restituido una sola vez) si el cobro se cancela o vence sin acreditar.

## Formación de precio

**Precio de lista = costo ÷ (1 − margen)** (D-068, supersede la «decisión manual» de D-037 cuando hay margen configurado). El **margen** es el margen real sobre el PRECIO DE VENTA (no un markup sobre el costo) y es una configuración global de la organización (`organization_pricing_settings.margin_bps`; Admin → Productos → Precios → Configuración de precios, junto con «Dto llevando 3u», «Dto por pack» y «Recargo por tarjeta»). Costo $10.000 con margen 30 % → $14.285,71 (no $13.000). Centavos y basis points enteros, half-up: `round_half_up(costo × 10.000 ÷ (10.000 − margen_bps))`, que es el gross-up existente (`calculate_product_price` con markup 0; `app_private.list_price_from_margin`). Margen válido `0 < % < 100`.

Mientras el margen no esté configurado el precio sigue siendo el que cargó el administrador y cambiar un costo no lo toca. Con el margen configurado:

- guardar un **costo nuevo** (`set_product_cost`, `bulk_set_product_costs`) abre la vigencia de costo y la de precio de lista en la **misma transacción**;
- guardar un **margen distinto** recalcula en el servidor, de una vez y tras una vista previa con confirmación (`save_pricing_config`), el precio de lista de todos los productos activos y vendibles con costo vigente `> 0`; cada cambio abre una vigencia nueva de `product_prices` y la anterior queda en el historial. **Sin costo no se inventa ni se borra el precio** (nunca $0). Un precio global programado a futuro y los precios por sucursal no se tocan;
- el **precio manual** sólo es el **fallback** cuando no hay costo o no hay margen configurado (o el producto es inactivo/materia prima): con costo válido + margen el Admin no lo acepta (D-068). Excepciones: el **Quick Create del POS** sin costo conocido (precio de emergencia; al cargarse después un costo, el precio pasa a formarse solo) y el **precio manual por línea de Central** (D-061), que se resuelve en la venta y no toca costo, lista ni margen ni dispara recálculo;
- los **precios por sucursal** (`product_prices.branch_id`) siguen ganando sobre el global en esa sucursal: el recálculo informa cuántos hay y permite **cerrarlos** (fin de vigencia, nunca borrar) para que valga el global;
- cambiar el dto de pack, el «llevando 3u» o el recargo de tarjeta **nunca** cambia un precio de lista;
- el **Desposte** (`complete_production_batch`) escribe el costo y **no reprecia** (un cambio de margen sí recalcula el producto si tiene costo vigente); la **importación** forma el precio desde costo + margen cuando la fila trae costo y ya hay margen (el precio del archivo no gana; sólo-precio o sin margen conserva el comportamiento anterior); el alta rápida del POS no reprecia.

El flujo anterior de costo + markup por producto (D-006: `product_pricing_settings`, `save_product_pricing`, `set_cash_discount_and_reprice`) sigue superseded y sin uso: sus tablas/RPC se conservan en la base por el historial.

**Costo = evidencia derivada**, nunca un input manual acoplado al precio:

- automático: al finalizar un desposte, el costo asignado por valor relativo de venta de cada output pasa a ser el costo vigente de ese producto (`product_costs`); **no reprecia** (D-068: el costo asignado sale de los precios actuales, repreciar sería circular);
- manual: para un producto comprado ya terminado (no producido por desposte), se carga directo (`set_product_cost`, o en lote desde Productos → Precios) y, con el margen global configurado, deriva el precio de lista (D-068);
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

## Pagos verificados (Mercado Pago, D-054)

- Una venta Mercado Pago se registra como `TRANSFER` + `provider = MERCADOPAGO`: **mismo precio que efectivo/transferencia** (sin recargo de tarjeta; ver D-054 sobre la confirmación pendiente).
- **Una venta Mercado Pago no está cobrada hasta `CONFIRMED`** (D-055): nace `PENDING_PAYMENT` y sólo la acreditación confirmada por el backend la completa; `CANCELLED`/`EXPIRED` sin acreditación la anulan. El polling del POS alcanza; el webhook es complementario y ambos aplican la misma transición.
- Estado de verificación (`PENDING` → `CONFIRMED` | `EXPIRED` | `CANCELLED` | `ERROR` | `MISMATCH` | `REFUNDED`) lo decide **sólo el backend** tras consultar a Mercado Pago. Ninguna acción de empleado, POS o Admin lo marca como verificado.
- "Confirmado" exige acreditación real y que lo acreditado = lo esperado = total validado de la venta.
- El POS nunca muestra "Pago confirmado" antes de esa confirmación. Una venta Mercado Pago no acreditada no se oculta: queda como `NO_ACCREDITATION` (con hora y monto) para el cierre y la revisión de cámaras.
- Una transferencia manual (sin proveedor) sigue siendo un medio no verificable (`NOT_REQUIRED`); no se migra el historial. **En una sucursal con Mercado Pago habilitado y `require_verified_digital_payments`, la transferencia manual no existe** (ni en el POS ni en el servidor); en sucursales sin Mercado Pago (Central) se mantiene.

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

## Precio manual y descuento general (POS de Central, D-061)

Sólo en el POS de la sucursal productiva (la misma "Central" de D-058, decidida por el servidor, nunca por nombre). Cada ticket de Central arranca en `CASH`.

Orden de pricing completo de una venta de Central (el orden de arriba no cambia para las líneas normales):

1. **línea normal:** lista → promoción/pack → recargo por tarjeta (sólo DEBIT/CREDIT) → subtotal de línea;
2. **línea con precio manual:** el precio que fijó el operador (por kg o por unidad) × cantidad → subtotal de línea. **Sin** promoción, pack ni recargo; no cambia con el medio de pago;
3. **ticket:** suma de los subtotales de línea → **descuento general** (`round_half_up(subtotal × bps / 10.000)`) → **total cobrado**.

El precio manual no modifica `product_prices` ni afecta ventas futuras. El descuento general es un porcentaje libre (`0 <= % < 100`, hasta 2 decimales); se conserva al cambiar el medio de pago y se recalcula sobre el nuevo subtotal. Un total de $0 no existe (100 % se rechaza). `sales.total_cents`, el pago, rendiciones, Mercado Pago y el ticket de WhatsApp usan el total final. Rentabilidad usa el ingreso real: la parte del descuento general atribuida a cada línea (`sale_items.ticket_discount_cents`, mayor resto) se resta de su subtotal.

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

### Pack y promoción global por sucursal (productos UNIT, D-063)

- **Pack** (`products.pack_size_units` + `products.pack_discount_bps`, D-064; unidades entero >= 2, sólo UNIT, NULL = sin pack; ej. leche: 8 unidades): unidad operativa de carga rápida, **no** una promoción, sin precio propio y distinto de `PACK_FIXED_TOTAL`. Las dos cosas van **juntas o ninguna**; **el descuento ya no es propio de cada producto: sale de la configuración global «Dto por pack»** (D-068; basis points enteros, `0 <= % < 100`: **0 % es un pack sin descuento**, el pack no se elimina), que se materializa en `products.pack_discount_bps` de cada producto con pack — cada cambio abre una versión nueva (las versiones viejas conservan su porcentaje; Leche A 20 % y Leche B 25 % eran valores propios anteriores a D-068). Vender "N packs" registra N × pack_size_units **unidades reales** (el stock descuenta 8/16/…; el pack no es una unidad de inventario) y **todas** reciben el descuento de ese producto (exactamente ese % del subtotal de lista de la línea): 1 pack de 8 × $1.000 al 25 % → base $8.000, descuento $2.000, total $6.000.
- **Promoción de sucursal** (`branch_promotions`, desde D-068 configurada **una sola vez para la organización** como «Dto llevando 3u» —mínimo 3— y materializada en cada sucursal; sin editor por sucursal): "**desde** N unidades del **mismo** producto, X %" para todos los UNIT de una sucursal. Con N o más unidades de ese producto en la línea, el descuento cae sobre **todas** (no sobre grupos completos): desde 3 / 15 %: 1–2 u sin descuento, 3 → las 3, 4 → las 4, 8 → las 8 con 15 % (8 × $1.000 = $8.000 − $1.200 = $6.800); nunca suma productos distintos. Cada regla lleva su semántica (`semantics`: `FROM_MINIMUM` vigente, `EVERY_GROUP` = "cada N", sólo reglas cerradas anteriores a D-064): una venta nueva sólo vale contra `FROM_MINIMUM`; una venta hecha antes del cambio con "cada N" conserva su semántica histórica y sincroniza (hasta 24 h 10 min después del cierre de la regla).
- **Un solo descuento por línea, sin acumular.** Precedencia: precio manual > venta como Pack (con el % del producto) > promoción específica del producto aplicable (`PACK_FIXED_TOTAL`) > promoción de sucursal. Un Pack de 8 al 25 % recibe 25 % en las 8 unidades y **no** además el "desde 3"; las mismas 8 unidades vendidas sueltas reciben el 15 % y no el 25 %. Nunca −25 % y después −15 %. Después: recargo de tarjeta (una vez sobre el total comercial de la línea, ya descontado) y por último el descuento general del ticket de Central (D-061).
- El escaneo agrega 1 unidad normal (nunca un Pack); el Pack se elige en el modal de cantidad, al agregar o al modificar la línea. El pack (tamaño **y** porcentaje) está versionado (`product_pack_versions`): cambiar cualquiera de los dos abre una versión nueva; cada venta guarda la versión con la que se hizo (`pack_config_id`) y el servidor la valida contra ESA versión, nunca contra el tamaño ni el porcentaje actuales del producto. Cada venta guarda el snapshot (`sold_as_pack`, `pack_config_id`, `pack_size_units_snapshot`, `pack_count`, `pack_discount_bps/_cents`; `branch_promotion_*`): si el pack pasa de 8 a 12, o de 20 % a 25 %, una venta vieja sigue siendo "1 pack × 8 u, 20 %".

## Snapshots históricos

Una venta debe preservar los datos relevantes del momento:

- precio/lista aplicable;
- precio manual cobrado, ajuste manual y descuento general (porcentaje e importe) cuando existan (D-061);
- descuentos;
- promoción (incluido el Pack de productos UNIT y la promoción de sucursal que se aplicó, con sus valores);
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

Un producto tiene **una sola categoría**: `products.category_id` (D-064; la multicategoría de D-041 se eliminó). No hay categorías secundarias: el backend lo impide (`product_category_assignments` es sólo una proyección de la categoría del producto, con a lo sumo una fila por producto y siempre esa categoría; `set_product_categories` rechaza ids distintos). `categoryIds` se conserva en los contratos de sync/POS por compatibilidad y vale siempre `[category_id]`. Cambiar la categoría de un producto reemplaza la anterior. El POS filtra por esa categoría.

Las tabs de categoría del POS salen de un directorio explícito (`get_pos_categories`/`categories` en `pull_pos_state`, tabla SQLite `catalog_categories`) con id/nombre/color/orden: las categorías activas que son la categoría de al menos un producto habilitado en la sucursal.

## Códigos de barras

- `products.sku` es el código **interno** (texto, mayúsculas, único por organización). El código del empaque que emite un escáner es un **barcode** (`product_barcodes`): varios por producto, uno sólo resuelve a un producto dentro de la organización (D-048).
- Se normalizan (sin espacios, mayúsculas) y aceptan `A-Z 0-9 . _ -` (3 a 64 caracteres); no se valida dígito verificador (hay códigos internos de la fuente).
- Un producto `WEIGHT` ("Vacío") y uno `UNIT` ("Coca Cola 2.25 L", con barcode) conviven en el mismo catálogo; la forma de venta decide si el ticket pide peso o cantidad (ver "Unidades y precisión").

## Surtido por sucursal

Cada sucursal vende sólo los productos **habilitados** en ella (`branch_product_assortment`, D-049). Es independiente del stock y de la política de stock (mínimo/objetivo):

- habilitado + stock > 0 → visible y vendible en el POS;
- habilitado + stock <= 0 → visible como "Sin stock" (no se elimina del catálogo de la sucursal) **en Avenida y Janssen**; en el POS de **Central** la disponibilidad no depende del stock: habilitado = visible y vendible con stock positivo, 0 o negativo (D-058, ver "Stock en Central" abajo);
- no habilitado → no aparece en el POS de esa sucursal, ni en su stock/reposición/alertas de Admin.

Central = carnicería + almacén; Avenida y Janssen = sólo carnicerías: lo importado desde SimplyGest se habilita sólo en Central. Un producto se habilita/deshabilita desde Admin (Productos → Administrar → "Se vende en"); deshabilitar conserva el historial y el stock (ver D-049).

## Lectura de código de barras en el POS

Un escaneo resuelve **localmente** contra el catálogo de la sucursal (D-050): `UNIT` suma 1 unidad; `WEIGHT` abre el flujo de peso existente; desconocido/no habilitado = "Producto no encontrado".

**Stock <= 0 y scanner (D-058, reemplaza la excepción de D-052):** en el POS de **Central** el escaneo de un producto habilitado se agrega sin importar su stock (positivo, 0 o negativo), igual que la selección manual y la búsqueda; en el resto de las sucursales un escaneo sin stock sigue sin agregarse. Un producto sin precio nunca se agrega a $0 (ver "Productos sin precio").

**Alta rápida desde el scanner (D-052):** en Central, un barcode desconocido abre un modal mínimo (nombre, costo opcional, precio) y crea el producto en una sola operación atómica: categoría `Almacen`, `UNIT`, `SELLABLE`, activo, habilitado **sólo en Central**, precio global vigente, costo si se informó, stock 0; después lo agrega al ticket. Requiere conexión (no hay cola offline de altas).

## Stock en Central (D-058)

Central es almacén + carnicería y **no lleva stock confiable**. En su POS todo producto habilitado en su surtido se ve y se vende con stock positivo, 0 o negativo (sin "Sin stock", sin tarjeta gris, sin sección colapsada; búsqueda, escaneo y venta manual normales). Vender con stock 0 deja el ledger en -1 y es válido: no se inventa stock ni se genera reposición. La regla es **sólo del POS de Central** (la sucursal productiva configurada, la misma capacidad del alta rápida); Avenida y Janssen mantienen el bloqueo por falta de stock. Tampoco se importa el stock de SimplyGest: los productos importados empiezan sin movimientos.

## Productos sin precio (D-057)

Precio 0 = "sin precio definido" (SimplyGest: productos en desuso o que el cajero precia en el momento). Es válido en el catálogo y se ve en el POS de Central, pero **nunca se vende a $0**: al tocarlo o escanearlo el POS pide el precio (modal "Producto sin precio", precio > 0) y lo guarda como **precio vigente** del producto (historial append-only: se cierra la vigencia anterior, no se pisa), actualiza el catálogo local y agrega el producto. No hay precio temporal por venta. Sin conexión no se puede fijar el precio (aviso, sin venta a $0 ni precio pendiente). La caja sólo puede fijar el precio de un producto que hoy no tiene (0 o inexistente); un producto con precio se cambia desde Admin. Un 0 del archivo de importación nunca pisa un precio ya cargado.

## Proveedores (D-056)

`suppliers` + `product_suppliers`: sólo el nombre es obligatorio; duplicados evitados por nombre normalizado (sin mayúsculas/acentos/espacios) y por código; se desactivan, no se borran; un producto tiene a lo sumo un proveedor **principal** (el vínculo es N:M a futuro) y puede no tener ninguno. Al importar, el proveedor del archivo se reutiliza o se crea una sola vez y queda principal; vacío = sin proveedor. Sin cuentas corrientes, pagos ni órdenes de compra todavía.

## Stock

Stock operativo = resultado del ledger/movimientos de stock.

Evitar estados derivados paralelos que puedan divergir.

### Stock migrado (apertura)

El stock inicial traído de otro sistema es un movimiento `OPENING_BALANCE` del ledger (positivo, una vez por sucursal+producto, `WEIGHT` en gramos / `UNIT` en unidades), nunca una columna de stock actual (D-047). No es una compra ni dispara avisos de reposición. Ver `IMPORTS.md`. **El stock histórico de SimplyGest NO se importa** (no es confiable, D-058): la pantalla de importación no ofrece la columna y no crea `OPENING_BALANCE`.

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

- revenue = importe final real de venta (con precio manual y con la parte del descuento general atribuida a la línea, D-061);
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
- Productos `WEIGHT` (en gramos) y `UNIT` (en unidades enteras). kg y unidades se totalizan por separado, nunca juntos (ver "Unidades y precisión"; D-051).
- El producto debe estar habilitado (surtido) en la sucursal destino.
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
- crash, kill forzado o corte eléctrico no garantizan ejecutar lógica de cierre; no autorizan a inventar una hora de salida arbitraria (D-015/D-024 siguen vigentes para el caso sin evidencia), pero si existe una lease de heartbeat con evidencia real de presencia, esa evidencia sí puede usarse para fijar el fin efectivo del turno (ver D-045).

### Heartbeat / lease de presencia (D-045, 2026-09-28)

Mientras existe un operador activo con turno `OPEN`, el POS emite un heartbeat cada ~30 s (local siempre; reflejado al servidor de forma idempotente sólo si hay conexión). El heartbeat pertenece al turno/operador/dispositivo: actualiza un `last_heartbeat_at` en el propio turno, nunca genera una fila histórica nueva por tick.

Dos causas distintas de `REQUIRES_REVIEW`, no deben confundirse:

- **turno vencido, heartbeat vigente** (empleado sigue con la app abierta pasado el máximo normal, ver default 12 h abajo): sin cambios respecto al comportamiento previo — pasa a revisión, `clock_out_at` queda `null`, no hay evidencia de cuándo terminó.
- **heartbeat vencido** (el dispositivo dejó de emitir heartbeats: kill forzado, corte eléctrico, crash — grace ~90 s desde el último heartbeat recibido): el turno pasa a revisión y además se fija `clock_out_at` = último heartbeat conocido (nunca "ahora"/momento de reconexión), marcado `auto_closed_by_heartbeat` para que Admin lo distinga de una salida genuina. Libera al empleado para marcar entrada de nuevo de inmediato; Admin conserva la capacidad de corregir la hora exacta con motivo.

Detección server-side (`app_private.mark_overdue_shifts`, RPC `record_shift_heartbeat`) y detección local al reiniciar el POS después de un cierre no limpio (usa el último heartbeat persistido en SQLite, nunca inventa horas hasta la reconexión) son mecanismos independientes y complementarios; cualquiera de los dos alcanza para cerrar el turno.

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
