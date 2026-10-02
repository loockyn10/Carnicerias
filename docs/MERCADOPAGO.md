# Mercado Pago (QR) — cobros digitales conciliados contra el POS

Decisión: D-054 (`docs/DECISIONS.md`). Estado de implementación: `docs/CURRENT_STATE.md`.

## Qué resuelve

Una venta declarada "Mercado Pago" ya no puede darse por cobrada porque la empleada lo diga. El backend crea una orden QR por el importe, Mercado Pago avisa por webhook, el backend **consulta la orden a Mercado Pago** y recién ahí marca el pago como verificado. Todo lo no acreditado queda identificable (hora, sucursal, monto) para el cierre diario y la revisión de cámaras.

## Flujo

```text
POS (online)                    Edge Functions (Supabase)                   Mercado Pago
1. Mercado Pago + Confirmar  →  venta local (SQLite) con payment.provider=MERCADOPAGO, method=TRANSFER
2. mp-create-order            →  mp_prepare_order (reserva idempotente, valida dispositivo/operador/sucursal)
                                POST /v1/orders (type qr, external_reference = sale_id, X-Idempotency-Key)  →  orden
3. el cliente escanea el QR de la caja ───────────────────────────────────────────────→ paga
4.                              ←  webhook order.* (x-signature HMAC) → GET /v1/orders/{id} → mp_apply_order_state
5. mp-order-status (poll 3 s) →  estado real (CREATED / CONFIRMED / EXPIRED / CANCELLED / ERROR)
6. outbox → sync_offline_sale →  payments.provider=MERCADOPAGO, verification_status=PENDING → CONFIRMED al conciliar
```

La venta se registra primero (stock y outbox como siempre) y el cobro viene después. Sin Internet **no se puede iniciar** un cobro Mercado Pago (el botón queda deshabilitado: sin orden no hay nada que pagar); si Internet se corta *durante* el cobro, la venta ya está guardada y el estado se resuelve al reconectar (el webhook confirma en el servidor aunque el POS esté offline).

## Modelo de datos (migración `202610010050`)

| Objeto | Rol |
|---|---|
| `payments.provider / verification_status / verified_at / verified_amount_cents` | Verificación del pago de la venta. Sólo las escribe el backend (trigger de guarda + funciones `SECURITY DEFINER`). `TRANSFER` manual queda `NOT_REQUIRED`. |
| `mercadopago_orders` | Un intento de cobro por fila. `sale_id` = `external_reference` del intento 1 (`<sale_id>-<n>` en reintentos). Un solo intento vivo por venta (índice único parcial). Sin FK a `sales` (la venta puede sincronizar después). |
| `mercadopago_branch_pos` | Caja de Mercado Pago por sucursal (`external_pos_id`, modo QR, vencimiento). `enabled = false` por defecto. |
| `mercadopago_webhook_events` | Auditoría deduplicada de notificaciones (sólo metadata segura). |

Estados de verificación de la venta: `PENDING`, `CONFIRMED`, `EXPIRED`, `CANCELLED`, `ERROR`, `MISMATCH`, `REFUNDED` (+ `NOT_REQUIRED`). Un pago sólo es `CONFIRMED` si Mercado Pago informó `processed` + `accredited` **y** lo acreditado, lo esperado y el total validado de la venta coinciden.

Pago combinado (ej. $45.000 MP + $30.000 efectivo): hoy una venta tiene un único pago. La estructura ya es por-pago (`payments` + `mercadopago_orders.expected_amount_cents`), así que cuando exista el pago combinado cada pago MP tendrá su orden sin cambiar este modelo; no se implementó.

## Funciones (Edge Functions)

| Función | Quién la llama | Autenticación |
|---|---|---|
| `mp-create-order` | POS | JWT del dispositivo + token de operador (lo exige `mp_prepare_order`) |
| `mp-order-status` | POS (poll) | JWT del dispositivo; refresca contra MP si hace falta (máx. 1 consulta / 8 s) |
| `mp-cancel-order` | POS | JWT del dispositivo; cancela y **re-consulta** (si ya pagó, queda `CONFIRMED`) |
| `mp-webhook` | Mercado Pago | firma `x-signature` (HMAC-SHA256); sin JWT |
| `mp-admin-setup` | Admin (rol admin) | JWT + permiso `payments.manage`; **dry-run por defecto** |

`verify_jwt = false` en todas (ver `supabase/config.toml`): el gateway sólo valida JWT legacy; la autenticación real la hace cada función/RPC. El código vive en `supabase/functions/_shared/` (lógica pura testeada en `packages/business-logic`).

## Variables / secrets (sólo servidor, jamás `VITE_*` ni el repo)

| Nombre | Para qué | Dónde se obtiene |
|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Llamar a la API de Mercado Pago | Panel de Mercado Pago → tu app **Carniceria-POS** → Credenciales de producción |
| `MERCADOPAGO_WEBHOOK_SECRET` | Validar la firma del webhook | Panel → tu app → Webhooks → Configurar notificaciones → clave secreta |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Las inyecta Supabase en cada Edge Function | (automáticas, no se cargan a mano) |

Cargar los secrets (nada se escribe en archivos del repo; los valores se pegan en la terminal o en el Dashboard):

```bash
pnpm exec supabase secrets set MERCADOPAGO_ACCESS_TOKEN=<pegar-access-token> MERCADOPAGO_WEBHOOK_SECRET=<pegar-secreto-webhook> --project-ref <PROJECT_REF>
```

Alternativa por el Dashboard de Supabase: menú lateral **Edge Functions → Secrets** (del proyecto) → *Add new secret* (un secret por variable).

## Despliegue (orden)

```bash
pnpm exec supabase db push                                   # aplica 202610010050 (hacer dry-run antes: `supabase db push --dry-run`)
pnpm exec supabase functions deploy mp-create-order --project-ref <PROJECT_REF> --no-verify-jwt
pnpm exec supabase functions deploy mp-order-status --project-ref <PROJECT_REF> --no-verify-jwt
pnpm exec supabase functions deploy mp-cancel-order --project-ref <PROJECT_REF> --no-verify-jwt
pnpm exec supabase functions deploy mp-webhook --project-ref <PROJECT_REF> --no-verify-jwt
pnpm exec supabase functions deploy mp-admin-setup --project-ref <PROJECT_REF> --no-verify-jwt
```

Los deploys no requieren Docker (usan el bundler del servidor). **Instalar el POS nuevo recién después** de `db push` y de los deploys (un POS viejo contra el servidor nuevo sigue funcionando; el botón Mercado Pago sólo aparece con la caja habilitada).

## Configuración en Mercado Pago (panel)

1. **Webhook** (Tus integraciones → *Carniceria-POS* → Webhooks → Configurar notificaciones → pestaña **Modo productivo**):
   URL: `https://<PROJECT_REF>.supabase.co/functions/v1/mp-webhook` · evento: **Order (Mercado Pago)** (`order.processed`, `.canceled`, `.expired`, `.refunded`) → Guardar → copiar la clave secreta a `MERCADOPAGO_WEBHOOK_SECRET`.
2. **Sucursal (Store) y Caja (POS)** de Avenida. Dos caminos:
   - Panel de Mercado Pago (más simple): crear la sucursal y la caja con QR; anotar el **`external_id` de la caja** (alfanumérico, ≤ 40, p. ej. `AVENIDA01`).
   - Por API con `mp-admin-setup` (después de cargar los secrets y confirmar los datos reales de Avenida: dirección y coordenadas). Primero dry-run (muestra el payload exacto, no envía nada):
     ```json
     { "action": "store", "store": { "name": "Avenida", "externalId": "AVENIDA", "streetName": "...", "streetNumber": "...", "cityName": "...", "stateName": "...", "latitude": 0, "longitude": 0 } }
     ```
     y recién con `"confirm": true` crea el recurso real. Luego `{"action":"pos","pos":{"name":"Caja 1","externalId":"AVENIDA01","externalStoreId":"AVENIDA"},"confirm":true}` devuelve las URLs del QR estático para imprimir.
3. **Imprimir y pegar el QR estático** de la caja en el mostrador. El modo por defecto es `static` (el cliente escanea el QR fijo y Mercado Pago le muestra el importe de la orden vigente). `dynamic`/`hybrid` ya están soportados en el backend (devuelven `qr_data`) pero el POS todavía no dibuja un QR en pantalla.

## Habilitar Avenida (una vez creada la caja)

En el **SQL editor del Dashboard de Supabase** (corre como superusuario). Queda apagado hasta que se habilita explícitamente:

```sql
-- Cargar la caja de Avenida (reemplazar los ids reales de Mercado Pago) y habilitarla
insert into public.mercadopago_branch_pos
  (organization_id, branch_id, external_pos_id, mp_store_id, mp_pos_id, qr_mode, expiration_minutes, enabled)
select organization_id, id, 'AVENIDA01', '<STORE_ID_MP>', '<POS_ID_MP>', 'static', 15, true
from public.branches where name ilike '%avenida%'
on conflict (branch_id) do update
  set external_pos_id = excluded.external_pos_id, mp_store_id = excluded.mp_store_id, mp_pos_id = excluded.mp_pos_id, enabled = excluded.enabled;
```

Para deshabilitar: `update public.mercadopago_branch_pos set enabled = false where external_pos_id = 'AVENIDA01';` (el botón desaparece del POS en el próximo arranque/reconexión). Desde la app, un admin también puede usar la RPC `set_mercadopago_branch_pos(...)` (valida permiso y audita).

## Prueba real de producción con un monto chico

1. Con Avenida habilitada y los secrets cargados, abrir el POS de Avenida (instalador nuevo), elegir operador, cargar un producto barato (≈ $100–$500).
2. Elegir **Mercado Pago** → *Confirmar y cobrar con Mercado Pago*. Debe aparecer *Esperando pago… $X*.
3. Pagar escaneando el QR de la caja con la app de Mercado Pago (otra cuenta). Debe pasar a **✓ Pago confirmado** en segundos.
4. Verificar en la base:
   ```sql
   select * from public.get_mercadopago_reconciliation(now() - interval '1 hour', now(), null, false);
   select status, expected_amount_cents, confirmed_amount_cents, mp_order_id, confirmed_at from public.mercadopago_orders order by created_at desc limit 3;
   select result, delivery_count, mp_status, mp_status_detail from public.mercadopago_webhook_events order by received_at desc limit 5;
   ```
   Esperado: `classification = VERIFIED`, `payments.verification_status = CONFIRMED`, un evento `APPLIED`.
5. Repetir **sin pagar** hasta que venza (15 min) y verificar `Cobro vencido` + clasificación `NO_ACCREDITATION`. Probar también *Cancelar cobro* y cortar Internet a mitad del cobro (la venta debe quedar registrada y resolverse al reconectar).
6. El pago debe hacerse desde **otra** cuenta de Mercado Pago (no se puede pagar a la propia cuenta cobradora).

## Informe (cierre diario / cámaras)

```sql
select occurred_at at time zone 'America/Argentina/Buenos_Aires' as hora, branch_name, sale_total_cents / 100.0 as monto,
       classification, order_status, mp_order_id
from public.get_mercadopago_reconciliation(date_trunc('day', now()), now(), null, true)   -- true = sólo problemas
order by occurred_at;
```

`classification`: `VERIFIED`, `PENDING` (< 20 min), `NO_ACCREDITATION` (vencida/cancelada/error/sin orden), `AMOUNT_MISMATCH`, `REFUNDED`, `PAID_SALE_CANCELLED` (cobrada pero la venta se anuló: devolver a mano), `AWAITING_SALE_SYNC`, `PAYMENT_WITHOUT_SALE`, `ORDER_WITHOUT_SALE`.

## Limitaciones del MVP

- **Cambiar el medio de pago de una venta ya registrada** no existe: si el cliente no puede pagar por QR, se cancela el cobro (la venta queda "sin acreditación") y el administrador anula la venta desde Admin; la empleada vuelve a cobrarla. Candidato a próxima mejora.
- **Anular una venta cobrada con Mercado Pago no devuelve el dinero** automáticamente (aparece como `PAID_SALE_CANCELLED`); el reembolso (`POST /v1/orders/{id}/refund`) se hace desde el panel de Mercado Pago.
- **Una sola caja QR por sucursal** (`mercadopago_branch_pos.branch_id` es único). Con QR estático, dos cobros simultáneos en la misma caja se pisarían; con varias cajas en una sucursal hará falta un POS de Mercado Pago por dispositivo.
- **No hay pantalla Admin** de conciliación ni de configuración: se usan las RPC/SQL de arriba.
- Venta completa pagada por MP únicamente (sin pago combinado). Sin offline (ver arriba). QR dinámico/híbrido no se dibuja en el POS.
- Si Mercado Pago contesta 409 por la idempotency key (respuesta perdida), el intento pasa a `ERROR` y el reintento abre un intento nuevo; la orden "perdida" se enlaza sola por `external_reference` si llega a pagarse.
- **No verificado contra la API real de Mercado Pago** (no hay credenciales en el repo): los formatos de request/response/webhook se implementaron según la documentación vigente (Orders API QR) y se probaron con mocks. Falta la prueba real descripta arriba. Cosas a confirmar en ella: comportamiento de dos órdenes seguidas en la misma caja estática, el valor exacto de `status_detail` de un pago acreditado (`accredited`) y que el webhook llegue con la firma esperada.

## Si el botón "Mercado Pago" no aparece

Abrí **Diagnóstico** (tocá el indicador de sincronización del encabezado): las filas *Sesión técnica* y *Mercado Pago* dicen el motivo exacto (y el código del error si la consulta falló).

- **"Sin sesión en línea (autorización en caché)"** (indicador ámbar *SIN SESIÓN EN LÍNEA*): hay Internet pero el webview no tiene la sesión técnica de Supabase, así que la caja vende con la autorización guardada, **no sincroniza** y no puede consultar Mercado Pago. Pasa con `pnpm dev:pos:desktop`: `tauri dev` sirve la app desde `http://localhost:1420`, otro origen que el instalador (`tauri://localhost`), y el `localStorage` donde Supabase guarda la sesión no es compartido (la SQLite sí). Solución: **Reconectar caja** (botón en la pantalla de operadores y en Diagnóstico) e iniciar sesión con la cuenta técnica del dispositivo; queda guardada para los próximos arranques de ese entorno.
- **"Mercado Pago no está habilitado para esta sucursal"**: falta `mercadopago_branch_pos.enabled = true` para esa sucursal (Central no debe tenerlo).
- **"No se pudo consultar la configuración…"** + `[código] mensaje`: error de la RPC `mp_get_branch_config` (p. ej. `42501` dispositivo no autorizado). En desarrollo también sale en la consola como `[pos] mp_get_branch_config_failed`.
- Sin Internet, si la caja ya supo que la sucursal tiene Mercado Pago, el botón se ve **deshabilitado** ("sin conexión" / "sin sesión").
