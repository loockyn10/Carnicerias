# Importaciones (migración desde SimplyGest y futuras fuentes)

Estado: **infraestructura implementada 2026-09-30 (migraciones `202609300041`–`044`); no se importó ningún dato real.** Decisiones: D-046, D-047, D-048. Reglas de dominio: `DOMAIN_RULES.md` ("Códigos de barras", "Stock migrado").

## Principios

- **Genérico, sin acoplar a SimplyGest.** La base sólo conoce `source_system` (texto, ej. `simplygest`) y payloads canónicos. Leer el CSV/Excel y mapear columnas → payload es trabajo de un mapper **fuera de la base** (próximo sprint).
- **Nunca INSERTs manuales.** Todo pasa por RPCs con permisos/RLS (`imports.read`/`imports.write`, sólo `admin`). Sin `service_role` en el cliente.
- **Vista previa obligatoria.** Nada se escribe hasta confirmar; lo que se confirma es exactamente lo previsualizado.
- **Sin duplicados por diseño.** Una importación nunca escribe en una entidad que no creó ella misma o que no se le permitió vincular explícitamente.
- **Sin segunda fuente de verdad.** El stock migrado entra al ledger `stock_movements`; no existe `current_stock`.

## Modelo

| Tabla | Rol |
|---|---|
| `import_batches` | Una corrida/archivo. `source_system`, `entity_type` (`category` · `product` · `stock_opening_balance`), `branch_id` (**sucursal destino**: obligatoria en `product` y `stock_opening_balance`, prohibida en `category`), `file_sha256`, `options`, `status` (`STAGING → READY → APPLIED` \| `CANCELLED`), `preview_summary`, `applied_summary`. Historial: no se borra. |
| `import_rows` | Filas en staging: `raw` (fila original, auditoría), `payload` (canónico), `content_hash` (sha256 del payload), y tras el preview `action` (`CREATE`/`UPDATE`/`IGNORE`/`ERROR`) + `reason_code` + `message`. |
| `external_entity_links` | `(organization_id, source_system, entity_type, external_id) → internal_id` + `content_hash` de la última importación aplicada. **La PK es la garantía anti-duplicado.** Hoy `category` y `product`; `customer`/`supplier` se agregan ampliando el `check`. |
| `product_barcodes` | Ver D-048. |

Las tres primeras son de sólo lectura para el cliente (`select` con `imports.read`); se escriben únicamente vía las RPCs.

## Flujo / API (todo `security definer`, autorizado por `imports.*` + permiso de la entidad)

```
create_import_batch(source_system, entity_type, file_name?, file_sha256?, branch_id?, options?) → batch_id
stage_import_rows(batch_id, rows[])   -- ≤1000 filas por llamada y por lote; idempotente por rowNumber
preview_import_batch(batch_id)        -- clasifica, NO escribe datos de negocio → resumen
apply_import_batch(batch_id, skip_errors=false)  -- atómico; idempotente si ya fue aplicado
cancel_import_batch(batch_id)
get_import_batch(batch_id)            -- estado + resumen + sameFileAlreadyApplied
```

`rows[i] = { rowNumber, externalId, payload, raw? }`. Reintentar un chunk no duplica (upsert por `(batch, rowNumber)`); cualquier `stage` invalida el preview y vuelve el lote a `STAGING`.

**Preview** (`summary`): `{ totalRows, pending, create, update, ignore, error, byReason, errors[≤50] }` — p. ej. "800 filas · 650 nuevos · 120 actualizaciones · 15 ignorados · 15 errores". El detalle completo por fila está en `import_rows` (`action`, `reason_code`, `message`, `internal_id` = entidad destino). **Apply** no corre sin preview vigente, rechaza un lote con errores salvo `skip_errors=true` (las filas `ERROR` quedan sin aplicar), y antes de escribir re-clasifica cada fila `CREATE/UPDATE`: si algo cambió desde el preview (otro usuario creó un SKU, etc.) aborta con `40001` y pide regenerar el preview. Después escribe todo en **una** transacción (falla una fila → rollback total).

Límite por lote: 1000 filas (las RPC corren bajo el `statement_timeout` de la API). Medido en Postgres real (PGlite, más lento que nativo) con 1000 productos sobre 3000 preexistentes: preview 0,3 s, apply 2,2 s. Un archivo mayor se parte en varios lotes, aplicando en orden (categorías → productos → stock).

## Payloads canónicos (`packages/types`: `ImportCategoryPayload`, `ImportProductPayload`, `ImportStockOpeningPayload`)

- **category**: `{ name, sortOrder?, active? }`.
- **product**: `{ name, unitType: WEIGHT|UNIT, sku?, barcodes?[], categoryExternalId? | categoryName?, priceCents?, costCents?, active?, inventoryRole? }`. Dinero en centavos enteros. Precio/costo omitidos = no se tocan. `WEIGHT` → precio por kg; `UNIT` → por unidad (convención existente de `product_prices`). `slug` lo genera la base. Sin categoría resoluble ni `options.defaultCategoryId` → `ERROR`.
- **stock_opening_balance** (lote de **una sucursal**, que además debe tener el producto habilitado): `externalId` = código externo del **producto**; `{ quantityGrams }` para `WEIGHT` o `{ quantityUnits }` para `UNIT` (exactamente uno; el tipo incorrecto es `ERROR UNIT_MISMATCH`, atrapa el clásico kg-vs-unidades).

**Sucursal destino y surtido (D-049):** para la migración `destinationBranch = CENTRAL`. Un lote de `product` exige la sucursal; cada producto que **crea** queda habilitado sólo en ella (Avenida/Janssen no ven nada nuevo); un producto que sólo **actualiza** conserva su surtido. El `stock_opening_balance` escribe únicamente el ledger de la sucursal del lote (nunca toca otras) y marca `NOT_IN_ASSORTMENT` si el producto no está habilitado ahí.

`options`: `linkExistingBy` (`product`: `sku`/`barcode`/`name`; `category`: `name`) y `defaultCategoryId`. Opciones desconocidas se rechazan.

## Cómo se evitan duplicados

1. **Mismo código externo → mismo registro.** Resolver por `external_entity_links` (no por nombre). Si el hash del payload coincide con el de la última importación aplicada → `IGNORE (UNCHANGED)`: re-importar el mismo archivo da 0 nuevos. Si difiere → `UPDATE` del mismo registro (precio/costo sólo si el valor cambió: sin filas de historial redundantes). Si el registro enlazado ya no existe → se recrea y se re-vincula.
2. **Choques con datos que la importación no creó son errores, no fusiones**: `SKU_CONFLICT`, `BARCODE_CONFLICT`, `NAME_CONFLICT`, `UNIT_TYPE_LOCKED` (forma de venta con historial, regla D-040), `CATEGORY_NOT_FOUND`. Para adoptar productos ya existentes (carnicería cargada a mano) se declara explícitamente `options.linkExistingBy`; más de un candidato → `AMBIGUOUS_MATCH`, ya vinculado a otro código → `ALREADY_LINKED`.
3. **Dentro del archivo** (gana la primera fila): `DUPLICATE_EXTERNAL_ID`, `DUPLICATE_SKU_IN_FILE`, `DUPLICATE_BARCODE_IN_FILE`, `MISSING_EXTERNAL_ID`, `DUPLICATE_TARGET` (dos filas que apuntan al mismo producto existente).
4. **Reintentos**: apply sobre un lote `APPLIED` devuelve el resultado guardado sin escribir; `file_sha256` repetido se informa (`sameFileAlreadyApplied`) pero no bloquea (corrección legítima de un archivo).
5. Red de seguridad en la base: `unique (org, sku)`, `unique (org, barcode)`, PK de links, índice único de apertura de stock.

Una importación **no** pisa lo editado a mano si el archivo no cambió (hash igual = `IGNORE`); si el archivo sí cambió, los campos presentes en el payload se sobrescriben — el mapper debe omitir lo que no quiera sincronizar (p. ej. `priceCents` en re-importaciones).

## Stock inicial sin romper el ledger

- Tipo de movimiento nuevo `OPENING_BALANCE` (cantidad > 0, columna `import_batch_id` para trazabilidad) en `stock_movements`: es una fila más del ledger; `stock_levels`, `get_branch_stock_status`, `get_pos_branch_stock` y reposición la suman sin cambios.
- **Una apertura por (sucursal, producto) en toda la historia** (índice único parcial). Si el producto ya tiene cualquier movimiento en esa sucursal → `IGNORE ALREADY_HAS_STOCK_HISTORY` (corregir = ajuste por conteo físico existente, no otro "stock inicial"). Cantidad 0 → `IGNORE`; negativa → `ERROR`.
- No dispara avisos de reposición (`log_restock_event` excluye `OPENING_BALANCE`).
- Requiere que los productos ya estén importados (`PRODUCT_NOT_IMPORTED` si no).

## Pendiente para importar de verdad (ver `TASKS.md`)

Mapper SimplyGest (CSV/Excel → payloads) + UI `/admin/imports`; regla de alertas para productos de almacén sin stock; clientes/proveedores/listas de precio. (Hechos en la ronda 2: surtido por sucursal, barcodes en el pull del POS/SQLite + scanner, stock/transferencias `UNIT` en Admin.) Antes de cualquier importación real: probar el flujo completo en un proyecto Supabase descartable.
