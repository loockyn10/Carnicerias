# Ticket digital por WhatsApp (Cloud API oficial de Meta)

Decisiones: D-059 (infraestructura, envío iniciado por el negocio) y **D-060 (flujo principal: el cliente inicia la conversación con un QR)** en `docs/DECISIONS.md`. Estado de implementación: `docs/CURRENT_STATE.md`.

## Flujo principal (D-060): el cliente escanea un QR

```text
POS (online)                      Edge Functions / Postgres                     WhatsApp
1. venta COMPLETED → "Ticket por WhatsApp"
2. whatsapp-create-claim  →  wa_create_claim: dispositivo + operador + venta real COMPLETED
                             (+ pago CONFIRMED); token aleatorio de 128 bits, SÓLO su hash se guarda; vence en 24 h
                          ←  { link: https://wa.me/<número comercial>?text=TICKET%20<token>, expiresAt }
3. el POS dibuja el QR del link (generado localmente, sin servicios externos)
4. el cliente escanea → se abre SU WhatsApp con "TICKET <token>" → toca Enviar ───────────────────────────→
5.                        whatsapp-webhook (X-Hub-Signature-256) ← message.id, from, "TICKET <token>"
                          wa_redeem_claim: dedupe por message.id, valida token/vencimiento/estado de la venta,
                          crea ticket_deliveries (PENDING) con el teléfono del REMITENTE de Meta
6.                        reconstruye el ticket en el servidor (mismo builder) y responde con un mensaje de
                          servicio (texto libre, SIN plantilla) ─────────────────────────────────────────→ cliente
7.                        wa_record_send_result → SENT; los estados sent/delivered/read/failed siguen por el webhook
```

El POS **no pide ni escribe ningún teléfono** y no conoce credenciales de Meta. Sin Internet no se crea ningún claim (*Ticket por WhatsApp requiere conexión a Internet.*) y nada entra a la outbox offline. En una venta Mercado Pago el botón aparece recién cuando el backend confirmó el cobro.

### Claim: reglas

- **Token:** 32 caracteres hexadecimales (128 bits de `gen_random_bytes`), no secuencial y **sin relación con el `sale_id`**. En Postgres sólo vive `token_hash` (SHA-256); el token en claro se devuelve una vez al POS (dentro del link del QR).
- **Una venta por claim.** Sólo se crea para `COMPLETED` (con todo pago verificado `CONFIRMED`); `PENDING_PAYMENT`, `CANCELLED`, `REFUNDED` y `DRAFT` no generan ticket. Si la venta deja de estar completada después de emitir el claim, el canje responde que no se puede emitir el comprobante.
- **Vence a las 24 h.** Un claim vencido responde "Este enlace venció…" sin datos de la venta.
- **Reabrir el QR** genera un token **nuevo** (no se puede reconstruir uno viejo: sólo hay hash); los anteriores siguen válidos hasta vencer o canjearse. Tope: 20 claims por venta en 24 h. Si ya se había entregado un ticket de esa venta, el modal lo avisa.
- **Canje:** lo hace el primer teléfono que envía el mensaje y queda asociado a él. **El mismo teléfono** puede volver a enviarlo (reenvío idempotente, hasta 3 entregas por claim; después responde "Ya te enviamos este ticket"). **Otro teléfono** recibe "Este código ya fue utilizado" sin datos. Conocer un `sale_id` no sirve para nada.
- **Idempotencia del webhook:** cada mensaje entrante se deduplica por `message.id` de Meta (tabla `ticket_delivery_events`, clave `in|<message.id>`); un reenvío del mismo evento no provoca otro ticket. Los estados se deduplican por mensaje + estado + timestamp (como antes).
- **Si Meta rechaza la respuesta:** el intento queda `FAILED` con el código de Meta y el webhook igual contesta `200` (no se reintenta solo, para no duplicar). El cliente puede volver a enviar el mismo mensaje (mismo teléfono = reenvío permitido).
- Sólo se responden mensajes `TICKET <token>`. Cualquier otro texto del cliente se **ignora** (no es un chatbot); un `TICKET` mal formado recibe "No pudimos validar este código…". El teléfono recibido **no** crea ni actualiza clientes.

### Formato del mensaje (un solo mensaje de WhatsApp)

```text
🧾 *Carnicerías Fran*
Sucursal Avenida

Ticket #f7000000
02/10/2026 14:35

• Vacío 1,250 kg x $10.000/kg = $12.500
• Hamburguesa 4 u. x $1.000 c/u = $4.000

*TOTAL: $16.500*
Medio de pago: Efectivo
```

Promociones y recargo de tarjeta van en cada línea (`(promo -$500, recargo tarjeta +$600)`) y resumidos antes del total. Nunca costo, proveedor, margen, stock ni datos del empleado (lista blanca en `parseTicketSource`). Los caracteres de formato de WhatsApp (`* _ ~` y comillas invertidas) se quitan de los nombres. Si la venta es enorme se recorta el detalle (`… y N productos más`) para entrar en un mensaje; el total es siempre el real.

## Secrets / configuración (sólo servidor)

| Nombre | Para qué | Dónde se obtiene |
|---|---|---|
| `WHATSAPP_BUSINESS_PHONE_E164` | **Número comercial visible** en formato internacional (ej. `+5493496000000`) que abre el QR. **No es el `Phone number ID`.** Para las pruebas, el número de prueba de Meta tal como figura en *API Setup* | API Setup / el número real de Fran |
| `WHATSAPP_ACCESS_TOKEN` | Responder (Cloud API) | Usuario del sistema → token **permanente** con `whatsapp_business_messaging` (en pruebas sirve el temporal de 24 h) |
| `WHATSAPP_PHONE_NUMBER_ID` | Qué número envía (ID interno de la Cloud API) | developers.facebook.com → tu app → WhatsApp → API Setup |
| `WHATSAPP_GRAPH_VERSION` | Versión de la Graph API (ej. `v21.0`; **no está fija en el código**) | API Setup / changelog de Graph |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Verificación del GET de alta (lo inventás vos) | — |
| `WHATSAPP_APP_SECRET` | Validar la firma `X-Hub-Signature-256` del webhook (App Secret de la app, no el verify token) | Configuración → Básica → Clave secreta |
| `WHATSAPP_PROVIDER=mock` | **Sólo desarrollo**: no envía nada (el QR y el canje funcionan; las respuestas se simulan) | — |
| `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_WABA_ID` | **Ya no hacen falta** para el flujo del QR (sólo el fallback de plantilla, abajo; la WABA no se usa en el código) | — |

```bash
pnpm exec supabase secrets set WHATSAPP_BUSINESS_PHONE_E164=<+54…> WHATSAPP_ACCESS_TOKEN=<pegar> WHATSAPP_PHONE_NUMBER_ID=<pegar> WHATSAPP_GRAPH_VERSION=<vigente> WHATSAPP_WEBHOOK_VERIFY_TOKEN=<inventar> WHATSAPP_APP_SECRET=<pegar> --project-ref <PROJECT_REF>
```

Sin `WHATSAPP_BUSINESS_PHONE_E164` válido `whatsapp-create-claim` responde `503 WHATSAPP_NOT_CONFIGURED` **sin crear claims**. Sin los secrets de la Cloud API el webhook responde `500` ante un mensaje `TICKET` **sin canjear nada** (Meta reintenta).

## Despliegue (orden)

```bash
pnpm exec supabase db push --dry-run     # revisar: 202610020056 y 202610020057
pnpm exec supabase db push
pnpm exec supabase functions deploy whatsapp-create-claim --project-ref <PROJECT_REF> --no-verify-jwt
pnpm exec supabase functions deploy whatsapp-webhook --project-ref <PROJECT_REF> --no-verify-jwt
# whatsapp-send-ticket (fallback por plantilla) es opcional: no lo usa el POS
```

No requiere Docker. Instalar el POS nuevo recién después.

## Webhook en Meta

Developers → tu app → WhatsApp → Configuración → Webhook → *Editar*:

- **URL de devolución de llamada:** `https://<PROJECT_REF>.supabase.co/functions/v1/whatsapp-webhook`
- **Token de verificación:** el valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- *Verificar y guardar* y **suscribirse al campo `messages`**: por ahí llegan los mensajes del cliente **y** los estados `sent/delivered/read/failed`.

**Ahora el webhook es imprescindible**: sin él, el mensaje `TICKET …` del cliente nunca llega al backend y no hay ticket (antes era un canal complementario).

## Probar con el número de prueba de Meta

1. App de Meta tipo *Business* con el producto WhatsApp. En *API Setup* aparecen el **número de prueba** (el que escribe el cliente), su `Phone number ID`, un token temporal y la lista de destinatarios de prueba: agregá tu celular.
2. Secrets: `WHATSAPP_BUSINESS_PHONE_E164` = **el número de prueba** (no el Phone number ID), `WHATSAPP_PHONE_NUMBER_ID` = su ID, token temporal, `WHATSAPP_GRAPH_VERSION`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. (Sin credenciales se puede ensayar la parte del POS con `WHATSAPP_PROVIDER=mock`, pero no hay ningún mensaje real.)
3. `db push`, desplegar `whatsapp-create-claim` y `whatsapp-webhook`, registrar el webhook (suscripto a `messages`).
4. POS (instalador nuevo): vender algo en efectivo → *Venta completada* → **Ticket por WhatsApp** → aparece el QR.
5. Con tu celular: escanear el QR (o abrir el link) → WhatsApp abre un chat con el número de prueba y el texto `TICKET …` → **Enviar**. En segundos debe llegar el ticket.
6. Verificar:
   ```sql
   select created_at, status, recipient_phone_masked, claim_id is not null as from_claim, provider_error_code, sent_at, delivered_at, read_at
   from public.ticket_deliveries order by created_at desc limit 10;
   select result, delivery_count, event_status, received_at from public.ticket_delivery_events order by received_at desc limit 15;
   select created_at, expires_at, redeemed_at is not null as redeemed from public.whatsapp_ticket_claims order by created_at desc limit 10;
   ```
   Esperado: delivery `SENT → DELIVERED → READ`, evento `INBOUND`/`CLAIM_ACCEPTED`.
7. Probar también: enviar otra vez el mismo mensaje (mismo teléfono: reenvía; a la 4.ª dice "Ya te enviamos…"), otro teléfono con el mismo QR ("ya fue utilizado"), un claim vencido (`update public.whatsapp_ticket_claims set expires_at = now() - interval '1 second' where …`), una venta Mercado Pago pendiente (no ofrece ticket), y el POS sin Internet.
8. Detalles de Meta a tener en cuenta: el cliente de prueba debe estar en la lista de destinatarios; el token temporal dura 24 h (`190`); la respuesta libre sólo se permite porque el cliente escribió en las últimas 24 h (error `131047` si no); en Argentina el `from` que informa Meta puede venir con o sin el `9` — el backend responde al mismo valor que recibió (REQUIERE VERIFICACIÓN con el número real).

## Qué falta para el número real de Fran

1. Portfolio comercial **verificado** en Meta, y un número que no esté registrado en la app común de WhatsApp (o migrarlo según Meta); nombre visible aprobado.
2. Agregarlo a la WABA y copiar su **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`; el número visible en E.164 → `WHATSAPP_BUSINESS_PHONE_E164` (es el que el cliente va a ver al escanear).
3. Token **permanente** de un usuario del sistema con acceso a esa WABA → `WHATSAPP_ACCESS_TOKEN`.
4. Webhook de la app apuntando a la URL de arriba. Un número por sucursal queda para más adelante (hoy una única configuración para la organización).
5. Revisar costos y límites en Meta: las respuestas dentro de la ventana de servicio iniciada por el cliente no usan plantilla.

## Fallback: envío iniciado por el negocio (D-059)

`whatsapp-send-ticket` + plantilla `ticket_compra` + `WhatsAppTicketModal` (teléfono) siguen en el repo, probados, **fuera de la UI normal del POS**: sirven si más adelante se quiere mandar un ticket a un número sin QR (requiere plantilla UTILITY aprobada: nombre `ticket_compra`, idioma `es_AR`, 7 variables; el cuerpo y los ejemplos están en el historial de D-059 y en `buildTemplateParameters`). Para el flujo del QR **no hace falta crear ni aprobar ninguna plantilla**.

## Ventas con precio manual o descuento general (D-061)

El ticket sale de la venta real del servidor: una línea con precio manual muestra el precio cobrado con la nota `(precio manual)` y, si hubo descuento general, una fila `Descuento general (5%): -$1.200` antes del TOTAL. La elegibilidad exige que **suma de líneas − descuento general = total** (`TOTAL_MISMATCH` si no cierra); `app_private.wa_sale_ticket_json` (migración `202610020058`) entrega `ticketDiscountBps`/`ticketDiscountCents` y `manualPriceApplied`. Un servidor sin esa migración no manda las claves nuevas: leen como "sin descuento" y una venta con descuento no emitiría ticket hasta aplicarla.

## Limitaciones

- El POS no se entera de que el cliente envió el mensaje (no hay sondeo): la pantalla del QR no muestra "enviado"; se consulta por SQL/`ticket_deliveries`.
- Sin PDF/imagen; un solo mensaje de texto. Sin campañas, marketing ni chatbot.
- Sin pantalla Admin de envíos ni de claims (el teléfono completo no es legible desde clientes; sólo enmascarado).
- Si el webhook crashea entre canjear y responder, el cliente debe reenviar el mensaje (mismo teléfono = permitido).
- Cualquiera que fotografíe el QR antes que el cliente puede canjearlo (primer teléfono gana): mitigado con vencimiento de 24 h y token por apertura; el QR vive sólo en la pantalla del POS.
