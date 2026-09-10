# POS offline-first

## Flujo y persistencia

La aplicación Tauri guarda su archivo `carnicerias-pos.sqlite` en el directorio privado de datos de la aplicación. React no recibe acceso SQL: usa comandos Rust con argumentos tipados. La migración SQLite `001_offline_core.sql` crea identidad de dispositivo, autorización cacheada, catálogo efectivo, ventas, ítems, pagos, ledger de stock, outbox y metadata de cursor.

Confirmar una venta siempre empieza y termina en una única transacción SQLite. Se asignan UUID a la venta, cada ítem, pago, movimiento y evento antes de persistir. El ticket se considera confirmado cuando esa transacción finaliza; ninguna solicitud de red participa en ese resultado.

## Push e idempotencia

El evento queda `PENDING`, pasa a `SYNCING` durante un intento y termina `SYNCED` o `FAILED`. Un fallo conserva payload y error, incrementa `attempts` y agenda el siguiente intento con backoff exponencial de 2 segundos hasta un máximo de 5 minutos. Al reiniciar, cualquier evento que quedó `SYNCING` se recupera como `FAILED`.

`sync_offline_sale` valida la sesión, membresía, permiso, dispositivo y sucursal. También valida UUID, sumas, pesos, pago, movimientos y el precio histórico vigente en el instante de la venta. `pos_sync_receipts.event_id` y los UUID primarios hacen que repetir el mismo evento devuelva éxito sin insertar otra fila. Reutilizar el evento con un payload diferente se rechaza.

## Pull y conflictos

Los triggers de catálogo escriben un cursor monotónico. `pull_pos_state` entrega únicamente productos afectados desde el cursor local, más tombstones para los que dejaron de estar disponibles. Un primer pull con cursor cero carga el estado completo de la sucursal.

- Catálogo y precios futuros: gana Supabase.
- Venta confirmada: append-only; conserva nombre, precio y hora locales.
- Stock: ledger; cada venta aporta movimientos con UUID propios.
- Precio cambiado durante el corte: la venta anterior sincroniza contra el historial vigente en su timestamp; el nuevo precio se usa después del próximo pull.
- Corte durante push o respuesta 500: el evento permanece y se reintenta.
- Cierre con pendientes: SQLite conserva venta y outbox; el arranque recupera intentos incompletos.

## Dispositivo y autorización offline

El primer login es Supabase Auth normal y requiere Internet. El servidor vincula el `device_id` persistente a una sola organización y sucursal; todas las RPC vuelven a comprobar esa asociación, por lo que editar el cliente no permite subir ventas a otra sucursal.

Después de un pull correcto se cachean usuario, sucursal, rol y vencimiento de autorización por 24 horas. No se guarda la contraseña. Sin una validación previa no existe acceso offline. Si se revoca usuario, sucursal o dispositivo mientras está desconectado, el POS puede operar solo hasta vencer la autorización; al reconectar, el servidor rechaza la operación, invalida el acceso local y conserva los eventos para resolución administrativa.

La pantalla de diagnóstico muestra Internet, Supabase, SQLite, última sincronización, pendientes, último error, identidad de dispositivo y sucursal. “Reenviar último evento” permite comprobar manualmente la deduplicación del servidor.
