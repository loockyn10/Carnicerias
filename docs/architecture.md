# Arquitectura base

## Objetivo de esta fase

Fase 1A establece límites estables sin anticipar implementaciones que todavía requieren decisiones de hardware u operación. Las únicas entidades persistidas son identidad, tenencia, autorización, catálogo y precios.

## Capas

```text
apps/admin ─┬─> packages/ui
            ├─> packages/business-logic
            ├─> packages/types
            └─> packages/database ─> Supabase/PostgreSQL

apps/pos ───┬─> packages/ui
            ├─> packages/business-logic
            ├─> packages/types
            ├─> packages/database (servidor remoto)
            └─> packages/sync (contrato; implementación posterior)
```

- Las apps componen flujos y presentación; no alojan reglas centrales.
- `business-logic` no depende de React, Supabase, SQLite ni Tauri.
- `database` contiene contratos de infraestructura remota, nunca service-role credentials.
- En la fase offline se agregará un adaptador SQLite separado bajo POS y `sync` coordinará pull/outbox sin contaminar el dominio.
- Hardware será una frontera propia del POS/Tauri, detrás de `ScaleAdapter`; no pertenece a React ni a `business-logic`.

## Tenencia y sucursales

`organizations` es la raíz de tenencia. Las entidades de negocio llevan `organization_id` aunque hoy exista una sola empresa. Las claves foráneas compuestas impiden asociar una categoría, producto, precio o sucursal de otra organización.

Un usuario tiene:

1. una identidad en `auth.users`;
2. un perfil global en `profiles`;
3. una membresía y rol en `organization_members`;
4. cero o más asignaciones operativas en `branch_members`.

Esto permite que un empleado cubra varias sucursales sin duplicar usuarios y que futuros roles organizacionales se agreguen sin modificar un enum.

## Autorización

Los roles son filas (`roles`), los permisos son capacidades estables (`permissions`) y `role_permissions` los relaciona. Los roles de sistema iniciales son `admin` y `employee`; el modelo admite roles personalizados por organización.

Las funciones de autorización dentro de `app_private` son pequeñas, `STABLE`, `SECURITY DEFINER`, tienen `search_path` vacío y no exponen datos. Se usan para evitar recursión entre policies de membresías.

Resumen de RLS:

| Recurso | Admin | Employee |
|---|---|---|
| Organización | lee y edita la propia | lee la propia |
| Sucursales | todas; administra | solo las asignadas |
| Miembros | lee y administra | solo su membresía |
| Categorías/productos | lee y administra | lee catálogo de su organización |
| Precios | todas las sucursales; crea/cierra | globales y de sus sucursales |
| Roles/permisos | lee los aplicables | lee los aplicables |

No hay políticas de creación de organizaciones ni de edición de roles desde clientes. El bootstrap y futuros flujos privilegiados deben ejecutarse en servidor confiable.

## Historial de precios

`product_prices` guarda centavos enteros, un rango `[valid_from, valid_to)` y una sucursal opcional. `branch_id = null` significa precio general. Una exclusión GiST impide rangos solapados para el mismo producto y alcance. Una trigger hace inmutables producto, sucursal, importe y comienzo; un cambio correcto cierra la fila vigente e inserta otra.

La futura venta guardará snapshots de nombre, precio, gramos y subtotal. Nunca dependerá del precio actual para reconstruir historia.

## Decisiones diferidas conscientemente

- SQLite y migraciones locales.
- Outbox, pull cursors, backoff e idempotencia.
- Ventas, pagos, ledger de stock, auditoría y dispositivos.
- Auth offline y almacenamiento seguro por plataforma.
- Tauri/Rust y protocolos de balanza.
- Consultas agregadas para dashboards.

Estas omisiones son límites de fase, no sustitutos temporales ni mocks.

## Reglas para continuar

- Cada migración es aditiva y versionada; no editar una ya desplegada.
- Regenerar `packages/database/src/database.types.ts` después de migrar.
- Toda tabla expuesta debe habilitar RLS y declarar policies antes de usarse.
- Todo identificador sincronizable se genera como UUID en el cliente.
- No importar APIs de infraestructura desde componentes visuales.
- Mantener cálculos monetarios y de peso con enteros.

