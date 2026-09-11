# Piloto operativo

## Aplicación remota

La migración `202609100007_operational_pilot.sql` debe aplicarse antes de desplegar el Admin actualizado. Desde la raíz:

```powershell
pnpm exec supabase login
pnpm exec supabase migration list
pnpm exec supabase db push --dry-run
pnpm exec supabase db lint --linked --level warning --fail-on error
pnpm exec supabase db push
pnpm exec supabase migration list
pnpm exec supabase db lint --linked --level warning --fail-on error
pnpm exec supabase test db --linked supabase/tests/operational_pilot.test.sql
pnpm exec supabase test db --linked supabase/tests/online_pos.test.sql
pnpm exec supabase test db --linked supabase/tests/offline_sync.test.sql
```

Después, desplegar el Admin con las mismas variables públicas ya usadas por Fase 1A. Esta fase no agrega secretos ni requiere `service_role`.

## Alta de empleados

1. Crear y confirmar el usuario en Supabase Dashboard → Authentication → Users.
2. Entrar al Admin con un administrador.
3. Abrir **Empleados** y asociar el email exacto, nombre, rol, estado y sucursal.
4. Iniciar sesión en el POS con ese usuario.

La asociación se ejecuta con una RPC admin-only. El navegador no consulta ni modifica `auth.users` y nunca recibe una clave privilegiada.

## Smoke test del piloto

1. En **Catálogo**, crear o editar un producto de tipo Peso y dejarlo activo.
2. Crear un precio global; opcionalmente crear un override para Sucursal Centro.
3. En Stock, configurar mínimo 10 kg y objetivo 25 kg.
4. Registrar una recepción de 25 kg, con o sin proveedor, y comprobar el stock derivado.
5. Registrar una merma de 1,2 kg con motivo y comprobar el historial.
6. Informar un conteo físico distinto y comprobar el ajuste firmado.
7. Asociar un usuario Auth como employee de Sucursal Centro.
8. Iniciar sesión en el POS y comprobar que sólo ve Centro y el precio vigente.
9. Completar una venta online y comprobarla en Ventas y Dashboard.
10. Desconectar Internet, completar otra venta, reiniciar el POS y comprobar que sigue pendiente.
11. Reconectar, esperar la sincronización automática y comprobar que la venta aparece una sola vez en Admin.
12. En Ventas, anular una venta con motivo. Comprobar estado ANULADA, pago conservado y movimiento de reposición.
13. Reabrir Auditoría y comprobar precio, stock, membresía, dispositivo y anulación.
14. Desactivar el dispositivo en POS; comprobar que no puede volver a sincronizar después de vencer su autorización offline temporal.

## Límite de esta entrega

No incluye balanza, ARCA, controlador fiscal, ecommerce, delivery, Mercado Pago, contabilidad ni transferencias avanzadas.
