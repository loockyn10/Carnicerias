# Tasks

Sólo trabajo próximo. Eliminar cada tarea al completarla.

## P0 — Etiquetas en lote: aplicar y probar con papel (acción del usuario)

Implementado 2026-10-07 (D-073). **Migración pendiente: `202610070070_product_label_groups.sql`** (tablas nuevas vacías, sin tocar nada existente; va después de la 069 si ésta tampoco se aplicó).

1. `supabase db push --dry-run` (debe listar sólo las pendientes: 069 y/o 070) y `supabase db push` antes de desplegar el Admin → `git push` (Vercel). Dependencia nueva: `pdf-lib` (+ `@pdf-lib/standard-fonts`).
2. Productos → Etiquetas → «Nuevo grupo» (nombre + sucursal) → «+ Agregar productos» (buscar, «Seleccionar todos los resultados», agregar) → «Seleccionar todos» → «Generar PDF».
3. Imprimir el PDF en una impresora común **al 100 % / tamaño real** (sin «ajustar a la página»): medir una etiqueta con regla (70 × 50 mm), comprobar que el precio y los textos no se cortan en las columnas de los bordes y que el corte por las guías es cómodo. Si la impresora recorta mucho el borde, subir `LABEL_PAD_X_MM` en `lib/label-spec.ts`.
4. Cambiar un precio (o la promoción) → volver a la pantalla: ese producto debe decir «Precio cambió»; «Seleccionar precios cambiados» + «Generar PDF» imprime sólo ese y el grupo vuelve a «Actualizada».
5. Pendiente de producto (no urgente): promociones por peso en la etiqueta WEIGHT, código de barras, descargar de nuevo un PDF histórico, reordenar productos del grupo, `pnpm db:types` real (los tipos se parchearon a mano).

## P0 — Cartelería digital: aplicar y probar en un televisor (acción del usuario)

Implementado 2026-10-07 (D-072). **Migración pendiente: `202610070069_digital_signage.sql`** (tablas nuevas vacías; no toca nada existente).

1. `supabase db push --dry-run` (debe listar sólo la 069) y `supabase db push` antes de desplegar el Admin → `git push` (Vercel).
2. Productos → Cartelería → crear la pantalla (nombre + sucursal) y **copiar el enlace en ese momento** (no se vuelve a mostrar; si se pierde: «Regenerar enlace»). Cargar 3–4 productos, «Guardar y publicar» y abrir el enlace en el navegador del TV (o «Abrir vista TV» en la PC).
3. Verificar en el TV: precio igual al del POS de esa sucursal, «llevando 3 unidades» sólo donde corresponde, rotación en bucle y que un cambio de precio/orden aparece solo en < 1 min.
4. Cortar el Wi-Fi del TV 1–2 min: debe seguir mostrando las ofertas sin error y recuperarse solo.
5. Pendiente de producto (no urgente): foto del producto en la plantilla, exportar PNG/WhatsApp, más plantillas, promociones `PACK_FIXED_TOTAL`/packs en la cartelería y permiso propio.

## P0 — Precio por margen global: aplicar, configurar y probar (acción del usuario)

Implementado 2026-10-06 (D-068) y 2026-10-07 (D-069 categorías excluidas, `CURRENT_STATE.md`). La `065` ya está aplicada; **migraciones pendientes: `202610070066_pricing_excluded_categories.sql` (si todavía no se aplicó) y `202610070067_product_custom_margin.sql` (D-070, margen personalizado por producto; la tabla nace vacía)**. No recalcula nada: hasta que alguien guarde la configuración, el sistema se comporta como hoy.

1. `supabase db push --dry-run` (debe listar sólo las pendientes: 067, y la 066 si no está aplicada) y `supabase db push` (antes de desplegar el Admin: la pantalla lee una tabla nueva) → `git push` (Vercel). Instalar el POS nuevo sólo si se va a usar **pack global 0 %**; para un % de pack distinto de 20 % alcanza un build con SQLite `019` (commit `31f7b55` o posterior). Un POS anterior vende todo pack al 20 % y su venta se rechazaría si el global es otro.
2. Antes de configurar, decidir los 4 valores reales y revisar los packs existentes: al guardar, TODOS pasan al «Dto por pack» global (versión nueva en cada uno, precios sin cambio).
3. Productos → Precios → Configuración de precios: **marcar primero Vaca, Cerdo y Pollo en «Categorías excluidas del margen automático»** (en el MISMO guardado que el margen: la primera configuración recalcula todo producto automático con costo); guardar; revisar la vista previa (precios que cambian, productos sin costo, **precios por sucursal que quedarían ganando**; el checkbox para cerrarlos viene marcado) y confirmar. Spot-check de 3–4 productos (costo ÷ (1 − margen)).
4. Smoke de la carga masiva de costos (2–3 costos → precio recalculado), de un alta con costo (el precio sale solo) y de una importación con costos.
5. Recargo de tarjeta offline: una caja sin conexión que vende con tarjeta antes y sincroniza después de un cambio de recargo debe quedar válida.
6. **Decisiones a confirmar (D-068):** (a) un cambio de margen reprecia también los cortes de desposte salvo los de categorías excluidas; el desposte al finalizar NO reprecia; (b) con costo + margen el Admin no deja escribir el precio a mano; (c) la primera configuración reemplaza el % propio de cada pack.

## P0 — Desactivación masiva de productos: desplegar y probar (acción del usuario)

Implementado 2026-10-06 (`CURRENT_STATE.md`). La migración `202610060064` ya está aplicada en Supabase; falta `git push` (Vercel) y el smoke de UI.

1. Smoke en `/admin/products`: «Seleccionar» → marcar 2–3 productos → «Desactivar productos» → confirmar; desaparecen de «Activos», aparecen en «Inactivos» con sus precios/código de barras, y el POS los saca del catálogo en el próximo sync.
2. Probar el checkbox del encabezado (50 filas), «Cancelar», y cambiar de filtro/página con selección activa (se descarta).

## P0 — Sucursales: ventas por rango y «Qué llevar ahora»: aplicar y probar (acción del usuario)

Implementado 2026-10-06 (D-067, `CURRENT_STATE.md`), **sin aplicar**. Orden: `supabase db push` (aplica `202610060063`; antes de desplegar el Admin: la pantalla llama a RPC nuevas) → `git push` (Vercel). Sin instalador nuevo del POS (no se tocó el POS). Después `pnpm exec supabase gen types typescript --linked` y comparar con la edición manual de `database.types.ts`; donde haya Docker, `pnpm db:reset && pnpm db:test` corre por primera vez `branch_sales_and_carry_plan.test.sql` (84) contra Supabase real.

1. **Confirmar que `organizations.production_branch_id` apunta a Central**: sin eso «Qué llevar ahora» responde «Configurá la sucursal productiva…» (fail-closed).
2. Smoke en Admin → Sucursales: Hoy/Ayer a las 21:00–23:59 hora local (no deben correrse por UTC), un rango de varios días, comparar el total de una sucursal con Ventas; una venta cancelada/pendiente de pago no suma.
3. Smoke de «Calcular qué llevar ahora» en Avenida con ventas reales de la semana: comparar 3–4 productos a mano (vendido 7d, stock, sugerido); probar editar «A llevar ahora» (coma decimal, valor inválido, 0) y «Mostrar sin necesidad». Confirmar que en Admin → Distribución y Stock no aparece ningún movimiento nuevo.
4. Confirmar las decisiones de D-067: ventana = 7 días calendario con hoy incluido; stock negativo cuenta como 0; orden pesados → unidades; sin tope por stock de Central.
- Pendiente a futuro (no hecho a propósito): botón «Crear transferencia con estas cantidades» (la estructura de cantidades `carry-plan.ts` ya valida kg/unidades; falta decidir cómo se registra la transferencia y qué pasa si Central no tiene lo sugerido); `/admin/sales` usa un offset fijo `-03:00` en vez de la zona de la organización.

## P0 — Ticket impreso no fiscal: smoke con la impresora física en Central (acción del usuario)

Implementado 2026-10-04 (D-065, `CURRENT_STATE.md`); la salida real nunca se probó. `pnpm build:pos:desktop`, instalar el POS en Central, instalar el driver de la térmica de 80 mm (queda como impresora de Windows) y:

1. Header «🖨 Impresora» → elegir la térmica → «Imprimir prueba»: deben salir `ñ á é í ó ú`, `$ %` y cortar. Si las tildes salen mal, Opciones avanzadas → «Windows-1252» y repetir. Si no corta o corta mal, probar con «Cortar papel automáticamente» apagado y revisar el avance (`escpos.rs`: `FEED_LINES_*`).
2. Ancho: el ticket usa 42 columnas; si la impresora imprime 48, queda margen (ajustar `columnsForPaperWidth`).
3. Vender en efectivo con «Imprimir automáticamente» activado: un solo ticket; con Mercado Pago, que no imprima mientras está pendiente y sí (una vez) al confirmarse; cancelar/vencer un cobro MP no debe imprimir.
4. Probar un ticket con Pack, promoción «15% OFF desde 3», producto por peso y precio manual; reimprimirlo desde Ventas recientes (`*** REIMPRESION ***`).
5. **Sin Internet** (cortar la red antes de abrir el POS): vender e imprimir/reimprimir.
6. Apagar/desconectar la impresora y vender: la venta queda completada y la barra ofrece «Reintentar impresión». Desinstalar la impresora configurada: el modal avisa y permite elegir otra.
- Pendiente a futuro (no hecho a propósito): otras sucursales, logo, cajón de dinero, QR, impresora Linux/CUPS (hoy `PRINTER_UNSUPPORTED`).

## P0 — Ajuste Pack por producto + categoría única + promoción "desde N": aplicar, instalar y probar (acción del usuario)

Implementado 2026-10-04 (D-064, `CURRENT_STATE.md`), **sin aplicar**. `059`/`060` ya están en producción (Pack al 20 %, promoción 3 / 15 %). Orden obligatorio:

1. `supabase db push` (aplica `202610040061`). **Cambia datos:** los packs existentes quedan al 20 %; **se borran las categorías secundarias** de `product_category_assignments` (cada producto conserva `products.category_id`; no hay vuelta atrás para esas asignaciones); la promoción de Central se cierra y se reabre como "desde 3 → 15 % a toda la línea" (id nuevo). Hacer antes un backup (Supabase → Database → Backups o `supabase db dump --linked -f backup.sql`) y, si se quiere conservar la lista de categorías secundarias, `select product_id, category_id from product_category_assignments a join products p on p.id = a.product_id where a.category_id <> p.category_id`. Después `pnpm exec supabase gen types typescript --linked` y comparar con la edición manual de `database.types.ts` / `database.rpc-null-overrides.ts`.
2. `git push` (Vercel despliega el Admin). Entre el `db push` y el deploy, el Admin anterior sigue pudiendo guardar y leer la promoción por sucursal (conserva `p_every_units` y `every_units`; su texto dice "Cada N"); sólo falla al editar un producto con "También aparece en" tildado (las categorías extra ya no existen): son minutos.
3. `pnpm build:pos:desktop` e instalar el POS nuevo en Central (y Avenida/Janssen). Las cajas anteriores siguen vendiendo y sus packs al 20 % sincronizan, pero **dejan de recibir la promoción de sucursal** (el servidor les entrega `branchPromotions` vacío: sin descuento "cada N" en el mostrador hasta instalar el POS nuevo; sus ventas offline hechas antes del cambio, o hasta 24 h después si no sincronizaron, sí sincronizan con su semántica "cada N"; pasado eso se rechazan con "update the POS"). **No configurar un % de pack distinto de 20 % hasta que todas las cajas tengan el POS nuevo**: un POS anterior vende el Pack al 20 % fijo y el servidor rechazaría esa venta contra la versión nueva.
4. Configurar: Admin → Productos → Administrar → «Unidades por pack» + «Descuento del pack (%)» (ej.: Leche A 8 / 20, Leche B 8 / 25, Producto C 12 / 15). Esperar un sync (o reiniciar el POS).
5. Smoke físico en Central: leche A: escanear (1 u normal) → «Modificar cantidad» → «Pack · 8 unidades · 20% OFF»; leche B: «Pack · 8 unidades · 25% OFF» → 1 pack = 8 u, $6.000 si cuesta $1.000 (base $8.000, descuento $2.000); sueltas: 1 y 2 u sin descuento, 3 → 15 % en las 3, 4 → $3.400, 8 → $6.800 (no 6 + 2); 2 leches + 1 coca sin promoción; precio manual anula pack/promo; tarjeta recarga después; descuento general después. **Cambio de % con ventas pendientes:** con el POS de Central sin Internet vender 1 pack de leche B (25 %, queda en la outbox); en el Admin pasar la leche B a 30 %; reconectar → la venta sincroniza (`SYNCED`) al 25 % y una venta nueva después del sync usa 30 %. Admin: el editor de producto muestra un solo selector «Categoría» (sin «También aparece en») y las dos casillas del pack sólo en productos por unidad; Promociones → «15% OFF desde 3 unidades». POS: las pestañas de categoría muestran cada producto sólo en su categoría. Cobrar online y **sin Internet** (cerrar y reabrir antes de reconectar) y ver el detalle en Admin → Ventas, el ticket de WhatsApp, Rendiciones y Rentabilidad.
6. Donde haya Docker: `pnpm db:reset && pnpm db:test` corre por primera vez contra Supabase real `pack_discount_threshold_promotions.test.sql` (134), `single_product_category.test.sql` (45), `unit_packs_and_branch_promotions.test.sql` (151), `import_infrastructure.test.sql` (127), además de `import_product_purge.test.sql` (64) de la 059.
7. **Purga (sólo cuando se decida y con la exportación original de SimplyGest con `CANTIDAD`):** (a) backup de la base; (b) ensayar todo en un proyecto descartable; (c) `pnpm --filter @carnicerias/admin purge:simplygest -- preview --file <exportación> --quantity-column CANTIDAD` (con `PURGE_ADMIN_EMAIL`/`PURGE_ADMIN_PASSWORD` y las variables de Supabase), revisar el CSV (candidatos, bloqueados y motivos); (d) `… apply --file <exportación> --confirm-count <N del preview> --yes-delete-permanently`; (e) comprobar en un POS de Central que los productos borrados desaparecen tras el sync y que los bloqueados siguen; (f) **no** reimportar el archivo completo (volvería a crearlos). **Purga por precio $0 (sin archivo):** después del `db push` (aplica `202610050062`) y con backup, `node --env-file=.env.local scripts/purge-simplygest/index.mts preview --zero-current-price` (desde `apps/admin`); revisar el CSV y recién con autorización `apply --zero-current-price --confirm-count <DELETE_SAFE> --yes-delete-permanently` (`IMPORTS.md`, "Segundo modo").
8. Confirmar las decisiones no pedidas explícitamente (listas en D-062, D-063 y D-064): p. ej. una línea Pack armada con una versión que el catálogo reemplazó antes de cobrar se rechaza en el POS y hay que volver a agregarla; un producto habilitado en otra sucursal queda bloqueado; las promociones por producto se borran con el producto; las categorías secundarias se borraron en vez de archivarse.

## P0 — Pricing flexible en Central: aplicar, instalar y probar (acción del usuario)

Implementado 2026-10-02 (D-061, `CURRENT_STATE.md`), **sin aplicar**. Orden obligatorio:

1. `supabase db push` (aplica `202610020058`; antes van `056`/`057` si todavía no estaban). **Antes** de instalar el POS nuevo: un POS nuevo con precio manual o descuento contra un servidor sin `058` deja la venta en `FAILED` en la outbox (el total no cierra); un POS viejo contra el servidor nuevo no cambia. Después `pnpm exec supabase gen types typescript --linked` y comparar con la edición manual de `database.types.ts`.
2. `pnpm build:pos:desktop` e instalar el POS nuevo en Central (Avenida/Janssen no cambian, pero conviene actualizarlos con el mismo instalador). `git push` para el Admin (Ventas muestra el detalle).
3. Donde haya Docker: `pnpm db:reset && pnpm db:test` corre por primera vez `flexible_pricing_central.test.sql` (101) contra Supabase real.
4. **Confirmar que `organizations.production_branch_id` apunta a Central**: sin eso el POS no ofrece nada de esto (fail-closed) y el servidor lo rechazaría.
5. Smoke físico en Central: ticket nuevo arranca en Efectivo y vuelve a Efectivo tras vender/cancelar; Tarjeta recarga sólo las líneas normales; "Editar precio" en una línea `UNIT` y una `WEIGHT` (con balanza), "Usar precio normal", editar peso/cantidad conservando el precio; descuento 5 / 12,5 / 0; combinación manual + descuento + Tarjeta; cobrar online y **sin Internet** (cerrar y reabrir el POS antes de reconectar) y ver en Admin → Ventas el detalle y en Rendiciones/Rentabilidad el total final; Mercado Pago con descuento (el QR cobra el total final); ticket de WhatsApp de una venta con descuento. En Avenida: sin "Editar precio" ni "Descuento" y arranca sin medio elegido.
6. Confirmar las decisiones no pedidas explícitamente (lista en D-061): precio manual mayor al normal permitido, `complete_discounted_sale` sin soporte (POS web de desarrollo), el descuento acepta `0 <= % < 100`.

## P0 — Ticket por WhatsApp (QR del cliente): secrets, deploy y prueba con el número de prueba (acción del usuario)

Implementado 2026-10-02 (D-059/D-060, `docs/WHATSAPP.md`), **sin desplegar y sin credenciales**. Orden:

1. Meta: anotar el número de prueba (visible), su Phone number ID, el token y el **App Secret**. **No hace falta crear ninguna plantilla** para este flujo.
2. `supabase db push` (aplica `202610020056` y `202610020057`), `supabase secrets set …` (lista en `docs/WHATSAPP.md`, incluye `WHATSAPP_BUSINESS_PHONE_E164`), `supabase functions deploy whatsapp-create-claim` y `whatsapp-webhook` con `--no-verify-jwt`, y registrar el webhook `https://<PROJECT_REF>.supabase.co/functions/v1/whatsapp-webhook` suscripto a `messages` (imprescindible).
3. `pnpm exec supabase gen types typescript --linked` para reemplazar la edición manual de `database.types.ts`; `pnpm build:pos:desktop` e instalar el POS nuevo.
4. Probar con el número de prueba (pasos en `docs/WHATSAPP.md`); recién después conectar el número real de Fran.
5. Donde haya Docker: `pnpm db:reset && pnpm db:test` corre por primera vez `whatsapp_ticket_deliveries.test.sql` (67) y `whatsapp_ticket_claims.test.sql` (58) contra Supabase real.
- Mejoras identificadas (no urgentes): que el POS muestre "ticket entregado" (sondeo del claim), pantalla Admin de envíos, PDF, número por sucursal, barra post-venta también cuando el cobro Mercado Pago se confirma por el barrido de reconciliación.

## P0 — Desplegar proveedores + importación real SimplyGest + Central sin stock (acción del usuario)

Implementado 2026-10-02 (ver `CURRENT_STATE.md` "Proveedores + importación real…", D-056/D-057/D-058). **No se importó ningún dato real.** Orden obligatorio:

1. `supabase db push` (aplica `202610020053`–`055`; si Mercado Pago `051`/`052` todavía no estaban, van antes, en orden). Después `pnpm exec supabase gen types typescript --linked` y comparar con la edición manual de `database.types.ts` (+ `database.rpc-null-overrides.ts`: `save_supplier`, `set_product_primary_supplier`, `list_suppliers_page`).
2. `pnpm build:pos:desktop` (Linux: `pnpm build:pos:linux:i386`) e **instalar el POS nuevo en Central ANTES de importar**: hay Rust/SQLite nuevos (`015`, `PRICE_REQUIRED`) y un POS viejo no puede guardar un producto de precio 0 (rompe el pull del catálogo). Avenida/Janssen no reciben productos importados, pero conviene actualizarlos igual (mismo instalador).
3. `git push` (Vercel despliega el Admin con Proveedores y el importador nuevo).
4. `pnpm db:reset && pnpm db:test` donde haya Docker: corre por primera vez contra Supabase real `suppliers.test.sql` (61), `import_suppliers_and_zero_price.test.sql` (56) y `pos_set_product_price.test.sql` (40).
5. Ensayar en un proyecto descartable con el CSV final (`codigo, barcode, nombre, categoria, tipo_venta, precio_venta, costo, proveedor[, proveedor_codigo]`): preview (proveedores nuevos/reutilizados, errores) → confirmar → **reimportar el mismo archivo (debe dar 0 nuevos, 0 proveedores nuevos, sin precios nuevos)**.
6. Smoke físico en Central (escáner USB): producto con stock 0 → se ve, se escanea y se vende (stock queda en -1); producto de precio 0 → tocar y escanear abren "Producto sin precio", $1800 → se agrega y el próximo escaneo ya vale $1800; sin Internet → aviso, no se vende a $0 y un producto con precio vende offline normal; Avenida/Janssen: un producto sin stock sigue gris y bloqueado.
7. Confirmar las decisiones del sprint no pedidas explícitamente (lista en `CURRENT_STATE.md`): la caja sólo fija precio de un producto que no tiene precio, y sólo en Central.

## P0 — Mercado Pago en Avenida: aplicar el ciclo de vida de la venta (acción del usuario)

Producción ya cobra y detecta pagos reales por polling (2026-10-02). Implementado en el repo, sin aplicar (D-055, `docs/MERCADOPAGO.md`): `supabase db push` (`202610020051`, `202610020052`), redeploy de `mp-create-order`, `mp-order-status`, `mp-cancel-order`, instalar el POS nuevo y repetir la prueba (pagado / cancelado / vencido; Admin muestra el estado real; Avenida sin "Transferencia").

- Webhook (opcional, no bloquea nada): configurarlo en el panel de Mercado Pago y cargar `MERCADOPAGO_WEBHOOK_SECRET`.
- **Confirmar la decisión de precio:** pago con tarjeta vía QR de Mercado Pago = precio de contado, sin recargo (D-054).
- `pnpm exec supabase gen types typescript --linked` para reemplazar la edición manual de `database.types.ts`.
- Mejoras identificadas (no urgentes): cambiar el medio de pago de una venta pendiente sin anularla, pantalla Admin de conciliación/configuración, reembolso al anular una venta cobrada, anular a mano desde Admin una venta `PENDING_PAYMENT`, QR dinámico en pantalla, una caja por dispositivo, pago combinado.

## P0 — Desplegar el alta rápida de producto desde el scanner (acción del usuario)

Implementado 2026-09-30 (ver `CURRENT_STATE.md` "Alta rápida de producto…", D-052). Pendiente (usuario):

- `git push` y `supabase db push` (aplica `202609300048`; **antes** de instalar el POS nuevo). Un POS viejo contra el servidor nuevo no cambia; un POS nuevo contra un servidor sin `048` no abre el alta (no sabe que es Central).
- **Confirmar que `organizations.production_branch_id` apunta a Central** (Admin → sucursal productiva); sin eso el alta y la excepción de stock quedan deshabilitadas (fail-closed).
- `pnpm db:reset && pnpm db:test` donde haya Docker (corre `pos_quick_product.test.sql`, 83 aserciones, por primera vez contra Supabase real) y `pnpm db:types` (comparar con la edición manual).
- **Instalador nuevo del POS** (`pnpm build:pos:desktop`; Linux i386 `pnpm build:pos:linux:i386`): hay React nuevo; Rust/SQLite sin cambios.
- Smoke físico en Central con escáner USB: código desconocido → modal → crear con y sin costo → queda +1 en el ticket → cobrar (online y offline); volver a escanear el mismo código (sin modal, suma); producto existente activo que Central no tenía → se habilita y se suma sin modal (y no aparece en Avenida/Janssen); producto inactivo → aviso, no se reactiva; producto habilitado con stock 0 → se agrega con aviso "Stock no registrado" mientras su tarjeta sigue gris; sin Internet + código desconocido → el modal avisa "Sin conexión"; Avenida/Janssen: código desconocido sigue "Producto no encontrado" y nunca ven el producto nuevo.

## P0 — Validar y desplegar Central como almacén: surtido, scanner POS y stock `UNIT` (acción del usuario)

Implementado 2026-09-30, ronda 2 (ver `CURRENT_STATE.md` "Central como almacén…", D-049/050/051). **No se importó ningún dato real.** Pendiente (usuario):

- `git push` y `supabase db push`: aplica `045`–`047` (y `041`–`044` si todavía no estaban). **Aplicarlas ANTES de instalar el POS nuevo** (un POS viejo contra el servidor nuevo funciona; un POS nuevo contra un servidor sin `045` no recibe barcodes).
- `pnpm db:reset && pnpm db:test` donde haya Docker: corre por primera vez contra Supabase real `branch_assortment.test.sql` (96), `import_infrastructure.test.sql` (120) y los fixtures actualizados (`branch_stock_status_rpc`, `offline_sync`, `online_pos`, `stock_transfers`). Los fallos preexistentes de otros archivos ya documentados no se relacionan.
- `pnpm db:types` (con Docker): `database.types.ts` se editó a mano; comparar y ajustar `database.rpc-null-overrides.ts` (`create_import_batch`, `resolve_product_barcode`, `list_products_page`, `get_branch_stock_status`, `search_products`).
- **Instalador nuevo del POS** (`pnpm build:pos:desktop`; Linux i386 con `pnpm build:pos:linux:i386`): hay Rust nuevo (SQLite `013`, barcodes en el pull) y UI nueva (scanner, grid por tramos).
- Smoke físico (escáner USB real, Central + Avenida + Janssen): Coca Cola habilitada sólo en Central → escanea y suma en Central, "Producto no encontrado" en Avenida/Janssen; Vacío en las tres y sigue por peso; código desconocido; producto habilitado con stock 0 ("Sin stock"); cortar Internet, cerrar y reabrir el POS y repetir (todo sale de SQLite); confirmar que el escáner no interfiere con el PIN, el peso ni el buscador. Si el escáner envía `Tab` en vez de `Enter`, o es más lento que 80 ms por tecla, ajustar `lib/scanner.ts`.
- Antes de importar: decidir la regla de alertas para productos de almacén sin stock (ver "Brechas" en `CURRENT_STATE.md`), y ensayar el flujo completo del importador (categorías → productos con `destinationBranch = Central` → stock) en un proyecto Supabase descartable.

## P0 — Validar y desplegar la foundation de almacén/importador (acción del usuario)

Implementado 2026-09-30 (ver `docs/IMPORTS.md`, `CURRENT_STATE.md` "Foundation de almacén e importaciones", D-046/047/048). **No se importó ningún dato real.** Pendiente (usuario):

- `git push` y `supabase db push`: aplica `202609300041`–`044` en orden (la 041 es un `ALTER TYPE` aislado a propósito; no fusionarla con la 043). Sin ellas nada cambia para el POS/Admin actuales.
- `pnpm db:reset && pnpm db:test` donde haya Docker: corre `supabase/tests/import_infrastructure.test.sql` (120 aserciones) por primera vez contra Supabase real. Sólo se validó contra Postgres 18 (PGlite) con un shim de pgTAP. Los fallos preexistentes de otros archivos ya documentados no se relacionan.
- `pnpm db:types` cuando haya Docker: `database.types.ts` recibió a mano las tablas/RPC/enum nuevos; comparar y, si difiere, actualizar `database.rpc-null-overrides.ts` (`create_import_batch`, `resolve_product_barcode`).
- No hace falta instalador nuevo del POS (Rust/SQLite/React sin cambios).
- Antes de cualquier importación real: ensayar el flujo completo en un proyecto Supabase descartable y conseguir exportaciones reales de SimplyGest (productos, rubros, códigos de barras, stock por sucursal) para escribir el mapper.

## P0 — Desplegar y ensayar la pantalla de importación de productos (acción del usuario)

Implementada 2026-10-01 (ver `docs/IMPORTS.md` "Pantalla de importación", D-053). **No se importó ningún dato real.** Pendiente (usuario):

- `supabase db push` primero (aplica `202609300049`) y `git push` después (Vercel despliega el Admin): la pantalla pasa `createMissingCategories`/`runId`, que una base sin `049` rechaza como "Opción desconocida". Si todavía no estaban, `041`–`048` van antes, en orden.
- Confirmar que `organizations.production_branch_id` apunta a Central (Admin → Desposte) y que existe la categoría "Almacen" (la crea `048` en organizaciones existentes); sin eso la pantalla se bloquea con un mensaje claro.
- `pnpm db:reset && pnpm db:test` donde haya Docker (corre `import_ui_support.test.sql`, 64 aserciones, por primera vez contra Supabase real) y `pnpm db:types` (esta migración no cambia firmas: no debería haber diferencias).
- **Ensayo en un proyecto Supabase descartable** (o branch) con la exportación real de SimplyGest: analizar → revisar errores/adopciones → confirmar → reimportar el mismo archivo (debe dar 0 nuevos). Medir el tiempo de apply de un lote de 1000 contra Supabase real (el límite de 60 s por acción en Vercel no se probó fuera del Postgres emulado).
- Exportación de SimplyGest a pedir: **productos** con código interno, descripción, código(s) de barras, rubro/familia, precio de venta (el de contado, sin recargo), costo y —en una segunda tanda— stock **sólo de Central**, en CSV/XLSX con encabezado.

## P1 — Plan de sprints para reemplazar SimplyGest (orden recomendado)

Cada sprint requiere decisión explícita antes de tocar pricing, orden de descuentos, ledger, sync offline o RLS (ver `CLAUDE.md`).

1. ~~**Almacén operable en Admin (`UNIT`)**~~ — hecho (ronda 2): stock/ajustes/mermas/transferencias `UNIT`, barcodes en el modal de producto, surtido por sucursal, catálogo paginado. Queda: selector con búsqueda en Desposte y Promociones (hoy `<select>` completo) y regla de alertas de almacén sin stock.
2. ~~**Importador real**~~ — pantalla hecha (2026-10-01, ver el P0 de arriba). Queda: ensayo con la exportación real en un proyecto descartable y luego producción; descarga de la lista de errores (hoy se ven en la tabla de la vista previa); varios códigos de barras por fila.
3. ~~**POS: escaneo de código de barras**~~ — hecho (ronda 2, D-050); falta el smoke físico con escáner real (P0 de arriba).
4. **Proveedores y compras**: ~~`suppliers` con importación vía `external_entity_links`~~ — hecho (2026-10-02, D-056: entidad, vínculo producto-proveedor, ABM en Admin, importador). Queda: compra/recepción → movimientos `PURCHASE` + costo vigente (`product_costs`), reemplazar `stock_operations.supplier` (texto libre) por `supplier_id` sin perder el historial, vínculos secundarios/`supplier_sku` en la UI, cuentas a pagar si se confirma el requisito.
5. **Clientes mayoristas y precios especiales**: `customers`, lista de precios y/o precio por cliente con vigencia append-only (mismo patrón que `product_prices`, precedencia definida), selección de cliente en el POS (con impacto offline: sincronizar clientes/listas a SQLite), cuenta corriente/cobranzas. **Requiere decisión explícita de dónde entra el precio de cliente en el orden de ajustes** (hoy: precio de lista → recargo tarjeta → promoción, D-044) y cómo interactúa con promociones.
6. **Corte (cutover) y cierre de SimplyGest**: conteo físico como `OPENING_BALANCE`, período en paralelo con conciliación (ventas/stock/caja), definición de qué historia se migra (propuesta: ventas históricas no se importan; SimplyGest queda como archivo de sólo lectura), y evaluación de facturación/comprobantes fiscales si hoy los emite SimplyGest (no cubierta por este repo).

## P0 — Desplegar "productos con stock primero" en el POS

Implementado 2026-09-30 (ver `docs/ARCHITECTURE.md`, "Stock en la pantalla de venta"). Pendiente (usuario):

- `git push` y `supabase db push` (aplica `202609300040_pos_branch_stock.sql`; sin ella el POS sigue igual que antes: stock "desconocido", nada se deshabilita).
- Nuevo instalador del POS (`pnpm build:pos:desktop`): hay Rust nuevo (SQLite `012`, comandos `apply_branch_stock`/`get_local_branch_stock`) y UI nueva.
- `pnpm db:reset && pnpm db:test` donde haya Docker para correr `supabase/tests/pos_branch_stock.test.sql` por primera vez (no corrió contra Postgres real).
- `pnpm db:types` cuando haya Docker: `database.types.ts` recibió a mano sólo la línea de `get_pos_branch_stock`.
- Smoke físico: Avenida con stock y Janssen en 0 del mismo producto; reposición 0 → +10 kg aparece disponible tras el próximo sync; vender el remanente lo pasa a "Sin stock"; repetir offline.

## P0 — Aplicar migración 038 (fix de ambigüedad de `apply_employee_time_event`) y re-smoke

**Causa raíz confirmada 2026-09-28** con el diagnóstico agregado en la vuelta anterior: el banner
mostró `[ONLINE_RPC] function app_private.apply_employee_time_event(...) is not unique`.
`202609280037_shift_heartbeat_lease.sql` agregó `p_inferred` a `apply_employee_time_event` vía
`create or replace function` — como eso cambia la lista de tipos declarados, Postgres NO reemplazó
la función original de 9 parámetros (`202609130018`); creó un segundo overload coexistiendo con
ella. `record_employee_time_event` (usado tanto para CLOCK_IN como CLOCK_OUT online) llama con
exactamente 9 argumentos posicionales — ambiguo entre ambos overloads, para las dos acciones por
igual. `sync_offline_time_event` no estaba afectado (ya llamaba con los 10 argumentos).

**Fix**: `202609280038_fix_apply_employee_time_event_overload.sql` (incremental, no edita `037`)
hace `DROP FUNCTION` del overload legacy de 9 parámetros por su firma exacta, dejando sólo el de
10. Test pgTAP nuevo `supabase/tests/shift_heartbeat_lease.test.sql` (24 aserciones: firma única,
CLOCK_IN/CLOCK_OUT online, heartbeat, CLOCK_IN offline + CLOCK_OUT inferido con reintento
duplicado, corrección admin) — revisado manualmente, no corrió contra Postgres real (Docker no
disponible en esta sesión, mismo bloqueo que el resto del historial). El diagnóstico agregado en
`apps/pos/src/App.tsx` (banner `[ETAPA] mensaje` + línea "Diagnóstico") se queda tal cual: fue lo
que permitió encontrar esto sin adivinar y sigue siendo útil para el próximo problema real.

Pendiente (usuario):

- Ejecutar `supabase db push` para aplicar `202609280038` al remoto (`037` ya está aplicada, no se
  tocó).
- Ejecutar `pnpm db:reset && pnpm db:test` en un entorno con Docker/CI Linux funcional para correr
  el pgTAP nuevo por primera vez contra Postgres real.
- Re-smoke con el instalador ya generado (no necesita recompilarse, el fix es 100% Postgres):
  PIN → Marcar entrada → confirmar clock-in exitoso → Admin muestra turno abierto → Salir → turno
  cerrado (checklist completo del sprint original en la sección de heartbeat más abajo).

## P1 — Validar heartbeat/lease de control horario (D-045) contra Postgres real y hardware

Implementado 2026-09-28 (ver `docs/CURRENT_STATE.md` y D-045 en `docs/DECISIONS.md`): heartbeat cada
~30 s mientras el turno está `OPEN` (local siempre + servidor si hay conexión), grace 90 s, cierre
inferido usando el último heartbeat conocido tanto server-side (`mark_overdue_shifts` extendido) como
al reiniciar el POS (`reconcile_stale_open_shifts`, Rust). Migraciones `202609280037_shift_heartbeat_lease.sql`
(Postgres) y `011_shift_heartbeat.sql` (SQLite). `cargo test` 49/49 OK (5 tests nuevos + 2 actualizados),
`pnpm check` OK en los 7 proyectos, `pnpm --filter @carnicerias/pos build`, `pnpm --filter @carnicerias/admin build`
y `pnpm --filter @carnicerias/pos build:desktop` (NSIS x64) OK. Docker Desktop no estuvo operativo en esta
sesión (mismo bloqueo que el resto del historial reciente): la migración Postgres se revisó manualmente
línea por línea pero no corrió contra Postgres real.

Pendiente:

- Ejecutar `pnpm db:reset && pnpm db:test` en un entorno con Docker/CI Linux funcional (no hay test pgTAP
  dedicado todavía para `record_shift_heartbeat`/el sweep extendido — agregar `supabase/tests/shift_heartbeat_lease.test.sql`
  cuando se pueda correr).
- Regenerar `packages/database/src/database.types.ts` con `pnpm db:types` (se editó a mano: columnas
  nuevas de `employee_shifts` y el RPC `record_shift_heartbeat`) y confirmar que coincide con el schema real.
- Confirmar con `supabase migration list --linked` si `202609280037` llegó a aplicarse al remoto antes de
  asumir que está pendiente.
- Smoke físico con el build nuevo instalado (usuario, no Claude/Codex):
  - marcar entrada, esperar >90 s con la app abierta y confirmar que el turno sigue `OPEN` (el heartbeat
    lo mantiene vivo);
  - matar el proceso por Administrador de tareas con el turno abierto; esperar >90 s; confirmar en
    `/admin/timekeeping` que el turno pasó a "Turnos pendientes de revisión" con el badge de cierre
    automático y una hora de salida cercana al momento del kill, no a cuando se revisó;
  - repetir el mismo kill estando el POS offline; reabrir la app (todavía offline) y confirmar que pide
    PIN de nuevo en vez de restaurar al operador activo, y que localmente el turno ya quedó cerrado;
    reconectar y confirmar que el servidor recibe la salida con la hora del último heartbeat local, no
    la de reconexión;
  - confirmar que "Salir" y el cierre normal de ventana (Alt+F4, botón cerrar) siguen sin regresiones
    (comportamiento sin cambios respecto a antes de este sprint);
  - corregir un cierre automático desde Admin y confirmar que el badge desaparece y `auto_closed_by_heartbeat`
    vuelve a `false`.

## P1 — Performance Admin con evidencia de producción

Hecho en el sprint 2026-09-16 (local, ver `CURRENT_STATE.md`):

- `getAdminContext` pasó de auth + membership + role/org (3 pasos) a auth + 1 query embebida.
- Instrumentación agregada a `/admin/products` y `/admin/employees`.
- `branch_stock_status` (el cuello de mayor impacto local: 1.1–2.2 s por RLS evaluada fila a fila sobre `stock_movements`) resuelto con la RPC `get_branch_stock_status` (migración `202609160023`), siguiendo el mismo patrón que `get_replenishment_plan`. `/admin`, `/admin/branches` y `/admin/stock` migradas; medido **1.1–2.2 s → 130–240 ms** local. `stock_movements` sigue siendo la única fuente de verdad; no se creó balance materializado. 28 tests pgTAP nuevos (`branch_stock_status_rpc.test.sql`).
- Confirmado que el bundle no tiene librerías pesadas que justifiquen `dynamic import`.

Hecho en el sprint 2026-09-22 (producción real, ver `CURRENT_STATE.md`):

- Causa dominante identificada y corregida: función serverless de Vercel ejecutando en `iad1` (EE. UU.) contra Supabase en `sa-east-1` (São Paulo). `apps/admin/vercel.json` fija la región a `gru1`. Medido con `fetch()` autenticado contra producción: navegación 3–12× más rápida (p. ej. `/admin/stock` 2.1–4.3 s → 0.51–0.61 s; `/admin/replenishment` 1.1–3.8 s → 0.36–0.37 s); navegación real de documento completo a `/admin/stock`: 355 ms.
- Se sacaron 9 llamadas a `router.refresh()`/`router.replace()+refresh()` redundantes después de Server Actions que ya revalidan la misma ruta (ver lista en `CURRENT_STATE.md`), evitando una segunda vuelta completa de auth+membership+queries después de cada "Guardar".
- Navegación caliente cercana o inferior a 700 ms: **alcanzado contra producción real** (todas las rutas medidas quedaron en 240–610 ms, salvo `/admin/sales` que varió 340 ms–1.13 s por sus 3 round-trips secuenciales genuinos).

Pendiente:

- Migrar `/admin/attention`, `/admin/branches/compare` y `components/branch-detail.tsx` a `get_branch_stock_status` si en el futuro se mide que también son lentas (quedaron en la vista `branch_stock_status`, fuera de alcance de este sprint).
- `/admin/sales` (0.34–1.13 s): tiene una dependencia genuina de datos (necesita `saleIds` antes de poder pedir items/payments/movements), no es trabajo redundante; si se mide que sigue siendo el cuello de botella percibido, evaluar particionar la carga de detalle por venta en vez de precargar todo.
- Evaluar `experimental.staleTimes` para reducir la doble llamada a `auth.getUser()` (middleware + layout) entre navegaciones consecutivas — requiere decisión explícita de producto por el trade-off de frescura de datos (ver nota en `CURRENT_STATE.md`); no se activó en este sprint.
- Prueba A/B de `prefetch={false}` en el sidebar (`admin-sidebar.tsx`) — no se tocó porque la causa dominante (región) ya está resuelta y el navegación quedó en rango aceptable sin ese cambio; sigue como mejora opcional de percepción, no de espera real.
- Agregar `loading.tsx` por ruta si después de la corrección de región alguna pantalla puntual sigue sintiéndose sin feedback (hoy sólo existe en `/admin` y el modal de sucursal).
- Investigar los fallos preexistentes del suite pgTAP hallados al correrlo por primera vez (`internal_pos_employees`, `online_pos`, `operational_pilot`) — no relacionados con este sprint, task de seguimiento ya creada.

## P1 — Smoke visual de la navegación Admin reorganizada (sidebar + tabs)

Implementado 2026-09-22 (ver `docs/CURRENT_STATE.md`, "Navegación Admin (sidebar + tabs)"):
sidebar consolidado a 9 entradas, tabs reusables en Ventas/Stock/Productos/Empleados,
`/admin/settings`, detalle de sucursal sin la pestaña "Operación" (contenido real
reubicado en Resumen/Stock). `pnpm typecheck`/`lint`/`test`/`build` OK.

Pendiente (requiere credenciales de una cuenta admin real o Docker/CI Linux para
levantar Supabase local — ninguno disponible en esta sesión, no se intentó adivinar
credenciales):

- Recorrer con sesión autenticada: sidebar, Inicio, Sucursales, detalle de sucursal
  (Resumen con Editar datos/Estado, Stock con Mermas/Reingresos, Ventas), Ventas
  con sus 3 tabs, Stock con sus 3 tabs, Productos con sus 3 tabs (incluida Precios
  vía `?tab=pricing`), Empleados con sus 2 tabs, Configuración, y navegación a
  Dispositivos/Avisos/Auditoría.
- Confirmar que el sidebar marca el grupo correcto estando en una subruta (p. ej.
  Rentabilidad → sidebar marca "Ventas"; Auditoría → sidebar marca "Configuración").
- Confirmar que ningún link quedó roto y que las rutas existentes
  (`/admin/settlements`, `/admin/analytics`, `/admin/branch-stock`,
  `/admin/replenishment`, `/admin/promotions`, `/admin/timekeeping`,
  `/admin/devices`, `/admin/announcements`, `/admin/audit`) siguen funcionando tal cual.

## P2 — PWA Admin

- Manifest, iconos, installability y modo standalone.
- Service worker conservador; Admin continúa online-first.
- Ejecutar después de estabilización y performance.

## P1 — Smoke test físico de balanza KRETZ Novel Eco 2

Implementado en el sprint 2026-09-16 (ver `docs/CURRENT_STATE.md` y
`docs/SCALE_INTEGRATION.md`): parser, adaptadores manual/simulado/serial,
persistencia local, integración con el modal de peso existente, tests sin
hardware, build Windows.

**Actualizado 2026-09-28 (ronda 1)**: protocolo confirmado contra hardware
real (CH340 + CH341SER 3.5.2019.1, frame `00.410`→410 g) en una PC Windows
distinta a la de desarrollo — no en este build. Se agregó autodetección de
puerto (`detect_scale_port`, botón "Detectar balanza").

**Actualizado 2026-09-28 (ronda 2)**: smoke real con este build hecho —
encontró parpadeo del panel de peso (~2/s) y pidió cambiar el flujo a
auto-confirmación sin click. Corregido: nuevo motor de estabilidad
(`advanceWeightStability`) reemplaza la comparación contra reloj sondeado
que causaba el parpadeo; el modal ahora confirma sola la línea al
estabilizarse el peso (~600 ms, ±3 g). Detalle en `docs/CURRENT_STATE.md`
y `docs/SCALE_INTEGRATION.md`. Sin smoke físico todavía de este fix
puntual.

Pendiente:

- Smoke físico de la auto-confirmación nueva: abrir un producto `WEIGHT`,
  apoyar un peso real y confirmar que la línea se agrega sola sin
  parpadeo ni clicks, que 0 kg nunca confirma, y que sacar el producto de
  la balanza después de agregada la línea no la modifica.
- Probar `detect_scale_port` ("Detectar balanza") contra hardware real.
- Confirmar `cargo check`/build contra `i686-unknown-linux-gnu` con el
  crate `serialport` agregado (requiere Docker o GitHub Actions).

## P1 — Validar Desposte / Producción / materias primas / Distribución contra Postgres real

Implementado en los sprints 2026-09-22 (ver `docs/CURRENT_STATE.md`): tablas,
RLS, RPCs, integración con `stock_movements`, cálculos de dominio, UI en
Admin (`/admin/production`, `/admin/transfers`, no en el POS — ver D-031) y
tests (Vitest + pgTAP) escritos y revisados manualmente. Docker Desktop no
llegó a estar operativo en ninguna sesión hasta ahora.

Pendiente:

- Ejecutar `pnpm db:reset && pnpm db:test` (`supabase/tests/production_batches.test.sql`,
  103 aserciones; `supabase/tests/stock_transfers.test.sql`, 49 aserciones) en un
  entorno con Docker/CI Linux funcional.
- Regenerar `packages/database/src/database.types.ts` con `pnpm db:types`
  (se editó a mano en varias sesiones) y confirmar que coincide con el schema real.
  Al regenerar, revisar `packages/database/src/database.rpc-null-overrides.ts`
  contra el nuevo archivo: si alguna migración tocada cambió el argumento/retorno
  real de una de las RPC ahí listadas, actualizar esa entrada para que coincida.
- Confirmar con `supabase migration list --linked` si 024–027 llegaron a
  aplicarse al remoto antes de asumir que están pendientes.
- Smoke manual en Admin: crear un desposte con varias medias res
  (`input_unit_count`), agregar/quitar outputs, editar y eliminar un
  borrador, finalizar, configurar la sucursal productiva desde cero (caso
  "no configurada todavía"), marcar un producto como materia prima desde
  `/admin/products` y confirmar que aparece/desaparece de los selectores
  correspondientes, y hacer una transferencia real Central → otra sucursal
  desde `/admin/transfers` (incluida "Distribuir ahora" desde un desposte
  recién finalizado). Confirmar que el rol `employee` no puede acceder a
  ninguna de las dos pantallas.

## P1 — Ejecutar pre-production reset y crear sucursales reales (acción del usuario)

Implementado 2026-09-22: `scripts/pre-production-reset.sql`, gestión de
sucursales en Admin (`/admin/branches/new`, editar/activar/desactivar/borrar
en el detalle), migración `202609220028_branch_management.sql`. No ejecutado
contra ningún entorno en esta sesión (requiere confirmación explícita del
usuario, ver `docs/PRE_PRODUCTION_RESET.md`).

Pendiente (usuario, no Claude/Codex):

- Backup del proyecto Supabase remoto.
- Correr `scripts/pre-production-reset.sql` siguiendo `docs/PRE_PRODUCTION_RESET.md`.
- Verificar el resultado (queries de la sección "Verificar que quedó limpio").
- Crear las sucursales reales desde Admin → Sucursales y autorizar cada
  dispositivo real a la suya.

Pendiente (agente, requiere Docker/CI Linux — mismo bloqueo que 024–027):

- Ejecutar `202609220028_branch_management.sql` contra Postgres real
  (`pnpm db:reset && pnpm db:test`) y regenerar `database.types.ts` con
  `pnpm db:types`.

## P1 — Validar Pricing manual / Desposte UNIT contra Postgres real

Implementado 2026-09-22 (ver `docs/CURRENT_STATE.md` y `docs/DECISIONS.md` D-037/D-038):
precio de venta manual (`set_product_price`/`bulk_set_product_prices`), costo derivado de desposte
(`complete_production_batch` alimenta `product_costs`) o carga directa (`set_product_cost`),
descuento por pago sin reprecio (`set_cash_discount`), edición masiva de precios en
Productos → Precios, y outputs de desposte por peso o por unidad. Migraciones `202609220029`/
`202609220030` y tests (Vitest + pgTAP) escritos y revisados manualmente. Docker Desktop no estuvo
operativo en esta sesión (mismo bloqueo que 024–028).

Pendiente:

- Ejecutar `pnpm db:reset && pnpm db:test` (`supabase/tests/production_batches.test.sql` extendido,
  `supabase/tests/manual_pricing.test.sql` nuevo) en un entorno con Docker/CI Linux funcional.
- Regenerar `packages/database/src/database.types.ts` con `pnpm db:types` (se editó a mano) y
  revisar `packages/database/src/database.rpc-null-overrides.ts` contra el resultado.
- Confirmar con `supabase migration list --linked` si 029–030 llegaron a aplicarse al remoto.
- Smoke manual en Admin: cargar un precio individual y una tanda masiva en Productos → Precios,
  confirmar que cambiar el descuento por pago no modifica ningún precio de lista, finalizar un
  desposte con outputs mixtos WEIGHT+UNIT (cabeza entera + un corte por kg) y confirmar que
  Rentabilidad/ficha de producto muestran el costo estimado recién asignado.

## P1 — Validar Promociones pack / corrección WEIGHT-UNIT / multicategoría / venta POS UNIT contra Postgres real

Implementado 2026-09-23 en dos rondas (ver `docs/CURRENT_STATE.md` y
D-039/D-040/D-041/D-042/D-043 en `docs/DECISIONS.md`):

- Ronda 1: promoción `PACK_FIXED_TOTAL` (WEIGHT y UNIT, modelada en
  Admin/Promociones), guarda de cambio de forma de venta en `save_product`,
  multicategoría (`product_category_assignments`/`set_product_categories`).
  Migraciones `202609230031`–`202609230033` y SQLite `007`–`008`.
- Ronda 2: venta `UNIT` end-to-end en el POS (online y offline, D-042);
  directorio de categorías explícito para que una categoría sólo-secundaria
  también genere tab (D-043); fix de compatibilidad en cuatro RPCs
  preexistentes que asumían `weight_grams` para todo (incluye el fix de un
  crash real en `cancel_sale` al anular una venta con línea UNIT). Como las
  migraciones de ronda 1 todavía no estaban aplicadas, se **editaron
  directamente** en vez de parchear con una migración nueva; sólo la venta
  UNIT (genuinamente nuevo alcance) se agregó como migración nueva:
  `202609230034_unit_sale_support.sql` y SQLite `009_unit_sale_support.sql`.

Docker Desktop no estuvo operativo en ninguna de las dos rondas. La parte
offline (Rust/SQLite) sí se validó contra un motor real en ambas rondas:
`cargo test` 33/33 OK (28 de ronda 1 + 5 nuevos de UNIT/pack/migración en
ronda 2, incluido un test que detectó y confirmó el fix de un bug real de
`pragma foreign_keys` dentro de una transacción SQLite). `pnpm check`
(typecheck + lint + test) OK en los 7 proyectos del monorepo en ambas rondas.

Pendiente:

- Ejecutar `pnpm db:reset && pnpm db:test` (`supabase/tests/promotions_pack.test.sql`,
  `product_unit_type_guard.test.sql`, `product_multi_category.test.sql`,
  `unit_sale_support.test.sql`) en un entorno con Docker/CI Linux funcional.
- Regenerar `packages/database/src/database.types.ts` con `pnpm db:types` (se
  editó a mano en ambas rondas) y revisar
  `packages/database/src/database.rpc-null-overrides.ts` contra el resultado.
- Confirmar con `supabase migration list --linked` si 031–034 llegaron a
  aplicarse al remoto.
- Smoke manual en Admin: crear un pack WEIGHT ("Vacío 2kg/$18.000") y un pack
  UNIT ("Hamburguesa 40u/$28.000"), confirmar que ambos productos aparecen en
  el selector de Promociones; probar los buscadores de Precios y Promociones;
  cambiar la forma de venta de un producto sin historial (debe permitir) y de
  uno con ventas/stock (debe bloquear con mensaje claro); asignar categoría
  principal + adicionales a un producto (ej. Chorizo de cerdo → Cerdo +
  Embutidos) y confirmar en Admin y en el POS que aparece filtrando por
  cualquiera de sus categorías, una sola vez en "Todos", y que Embutidos
  genera su propia tab aunque ningún producto la tenga como principal.
- Smoke manual en POS (con hardware/build desktop real): vender un producto
  WEIGHT con pack activo (cobra el total fijo sin importar el peso real
  pesado) y un producto UNIT normal y en pack (40→1 pack, 45→1 pack + 5
  normal = $32.000, 39→sin pack), online y offline (reinicio + sync);
  cancelar una venta con línea UNIT y confirmar que la reversión de stock es
  correcta (antes de este sprint esto crasheaba en el servidor).
- Confirmar que el nombre "Hamburguesa" reportado como ausente de Promociones
  era realmente `unit_type='UNIT'` (no se pudo verificar contra datos reales
  en ninguna sesión, ver diagnóstico en `docs/CURRENT_STATE.md`).

## P1 — Validar Recargo por tarjeta (D-044) contra Postgres real

Implementado 2026-09-24, corregido el mismo día (ver `docs/CURRENT_STATE.md` y
D-044 en `docs/DECISIONS.md`): el precio cargado en Productos pasa a ser el
precio de CASH/TRANSFER/OTHER sin ajuste; DEBIT/CREDIT pagan ese precio más un
recargo configurado (`set_cash_discount`, sin cambio de firma). Orden: lista →
promoción/pack (siempre contra la lista) → recargo por tarjeta, aplicado al
total comercial completo **sin excepción de pack** (corrección del mismo día:
la primera versión dejaba un pack invariante al medio de pago; el usuario
aclaró que no hay excepción). Migración nueva `202609240035_card_surcharge_pricing.sql`
(no se editaron `202609230031`/`202609230034`: hay evidencia de que al menos
parte ya está aplicada en un entorno real; la corrección del mismo día sí se
aplicó sobre `202609240035` en el lugar, confirmando primero que seguía sin
aplicarse a ningún entorno) y SQLite `010_card_surcharge_pricing.sql`.
`cargo test` 39/39 OK, `pnpm check` OK en los 7 proyectos.

**Actualizado 2026-09-25** — se auditó el runtime real (no sólo el código) porque
el usuario probó el POS instalado y observó la regla vieja (tarjeta = precio
base, efectivo/transferencia = descuento). Causas encontradas, ninguna es un
bug de código nuevo:

1. El ejecutable/instalador en `apps/pos/src-tauri/target/release/` está
   compilado el 2026-09-24 02:14, **antes** de los commits `2ee343a` (D-044
   round 1) y `39113d2` (D-044 round 2/corrección) — corre código enteramente
   anterior a D-044. Requiere recompilar (`pnpm --filter @carnicerias/pos
   build:desktop`) y reinstalar.
2. `supabase migration list --linked` confirma que `202609240035` **sí** llegó
   a aplicarse al remoto — con el contenido de la primera versión (pack
   invariante al medio de pago), no con la corrección del mismo día. Editarla
   en el lugar (creyendo que seguía local-only) sólo actualizó el archivo
   local. Se agregó `202609250036_card_surcharge_pack_exception_fix.sql`
   (incremental, sólo `CREATE OR REPLACE FUNCTION` sobre
   `complete_discounted_sale`/`sync_offline_sale`, sin DDL nuevo) con los
   mismos cuerpos ya corregidos. **Todavía sin `db push`.**
3. `get_pos_commercial_config` en remoto ya devuelve `cashDiscountBps`
   correctamente (bug de la migración 031 ya corregido y desplegado); el valor
   configurado real es 1000 bps (10%).

Pendiente:

- Decidir y ejecutar `supabase db push` para `202609250036` (no se hizo en
  esta sesión, sin autorización explícita).
- Recompilar y reinstalar el POS Desktop con el código actual.
- Ejecutar `pnpm db:reset && pnpm db:test` (`supabase/tests/card_surcharge_pricing.test.sql`,
  32 aserciones) en un entorno con Docker/CI Linux funcional.
- Regenerar `packages/database/src/database.types.ts` con `pnpm db:types` (se
  editó a mano) y revisar `packages/database/src/database.rpc-null-overrides.ts`
  contra el resultado.
- Smoke manual en POS **con el build nuevo instalado**: cargar un producto a
  $10.000 con 10% de recargo configurado, confirmar que Efectivo y
  Transferencia muestran $10.000 y Tarjeta $11.000; ticket con dos líneas
  ($10.000 + $20.000) y togglear Efectivo→Tarjeta→Efectivo→Tarjeta,
  confirmando siempre $30.000/$33.000/$30.000/$33.000 sin residuo en ninguna
  línea; vender un pack WEIGHT ("Vacío 2kg/$18.000") con Tarjeta y confirmar
  que cobra $19.800 (no $18.000); vender un UNIT pack con remanente (45
  hamburguesas: pack de 40 a $28.000 + 5 sueltas) con Tarjeta y confirmar que
  cobra $35.200 sobre el total completo (no $32.400, que sería recargar sólo
  el remanente). Repetir offline (reinicio + sync) y confirmar que el servidor
  no rechaza el total ya validado localmente, y que online/offline coinciden
  centavo a centavo.

## P2/P3 — Capacidades opcionales según negocio

- Conservar como evidencia el timestamp/intento de clock-out offline anómalo, manteniendo el turno en `REQUIRES_REVIEW`.
- Reversión/ajuste de un desposte ya finalizado (hoy sólo puede cancelarse un borrador; ver D-030).
- Evaluar si `apps/admin/src/components/branch-detail.tsx` ("ingresos recientes") debería incluir `PRODUCTION_YIELD` junto a PURCHASE/RETURN/ADJUSTMENT_POSITIVE/TRANSFER_IN.

No priorizar actualmente detección avanzada de inconsistencias.
