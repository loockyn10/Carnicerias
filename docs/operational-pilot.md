# Piloto operativo

## Aplicación remota

Antes del piloto, verificar todas las migraciones incrementales pendientes; no asumir que el remoto termina en 007. Desde la raíz:

```powershell
pnpm exec supabase login
pnpm exec supabase migration list --linked
pnpm exec supabase db push --dry-run
pnpm exec supabase db lint --linked --level warning --fail-on error
pnpm exec supabase db push
pnpm exec supabase migration list --linked
pnpm exec supabase db lint --linked --level warning --fail-on error
pnpm exec supabase test db --linked supabase/tests/operational_pilot.test.sql
pnpm exec supabase test db --linked supabase/tests/online_pos.test.sql
pnpm exec supabase test db --linked supabase/tests/offline_sync.test.sql
pnpm exec supabase test db --linked supabase/tests/internal_pos_employees.test.sql
```

Los comandos `--linked` requieren autenticación Supabase. Después, desplegar el Admin con sus variables públicas. No usar `service_role`.

## Alta de empleados

1. Entrar al Admin con un administrador.
2. Abrir **Empleados** y cargar nombre, PIN, tarifa inicial, estado y una o varias sucursales.
3. Enrolar/autenticar el dispositivo en su sucursal fija.
4. Sincronizar y seleccionar al empleado mediante PIN en el POS.

El alta se ejecuta de forma transaccional con una RPC admin-only. El navegador no recibe una clave privilegiada y el empleado no necesita una cuenta Supabase Auth.

## Smoke test del piloto

1. En **Catálogo**, crear o editar un producto de tipo Peso y dejarlo activo.
2. Crear un precio global; opcionalmente crear un override para Sucursal Centro.
3. En Stock, configurar mínimo 10 kg y objetivo 25 kg.
4. Registrar una recepción de 25 kg, con o sin proveedor, y comprobar el stock derivado.
5. Registrar una merma de 1,2 kg con motivo y comprobar el historial.
6. Informar un conteo físico distinto y comprobar el ajuste firmado.
7. Crear un empleado POS interno con PIN, tarifa y acceso a Sucursal Centro.
8. Iniciar sesión en el POS y comprobar que sólo ve Centro y el precio vigente.
9. Completar una venta online y comprobarla en Ventas y Dashboard.
10. Desconectar Internet, completar otra venta, reiniciar el POS y comprobar que sigue pendiente.
11. Reconectar, esperar la sincronización automática y comprobar que la venta aparece una sola vez en Admin.
12. En Ventas, anular una venta con motivo. Comprobar estado ANULADA, pago conservado y movimiento de reposición.
13. Reabrir Auditoría y comprobar precio, stock, membresía, dispositivo y anulación.
14. Desactivar el dispositivo en POS; comprobar que no puede volver a sincronizar después de vencer su autorización offline temporal.

## Límite de esta entrega

No incluye balanza, ARCA, controlador fiscal, ecommerce, delivery, Mercado Pago, contabilidad ni transferencias avanzadas.
