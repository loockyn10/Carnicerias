# Plataforma de gestión para carnicerías

Sistema multi-sucursal y multiempresa. La **Fase 1C** convierte el POS React/Vite en una aplicación Tauri offline-first con SQLite, outbox e intercambio incremental con Supabase.

## Requisitos

- Node.js 22 o superior
- pnpm 11
- Docker Desktop (para Supabase local)
- Supabase CLI 2.x disponible como `supabase`
- Rust stable MSVC, Microsoft C++ Build Tools y WebView2 para compilar el POS de escritorio

## Puesta en marcha

```bash
pnpm install
cp .env.example .env.local
supabase start
supabase db reset
```

Para Admin, copiá `apps/admin/.env.example` a `apps/admin/.env.local`. Para POS, copiá `apps/pos/.env.example` a `apps/pos/.env.local`. En ambos casos completá la URL y la misma publishable key del proyecto. No copies una secret key ni la `service_role key` a variables `NEXT_PUBLIC_*` o `VITE_*`.

En dos terminales separadas:

```bash
pnpm dev:admin
pnpm dev:pos:desktop
```

- Admin: <http://localhost:3000>
- POS de escritorio: ventana Tauri; Vite usa internamente <http://localhost:1420>
- Supabase Studio: <http://localhost:54323>

El POS requiere una membresía `ACTIVE`. Los empleados deben tener además una fila activa en `branch_members`; los administradores pueden vincular el equipo a una sucursal autorizada. El primer ingreso y vinculación requieren Internet. Luego puede vender offline durante 24 horas desde la última validación.

## Crear el primer administrador local

1. Creá un usuario desde Authentication > Users en Supabase Dashboard.
2. La trigger de Auth crea automáticamente su fila en `profiles`.
3. En el SQL Editor local, concedé la membresía inicial:

```sql
insert into public.organization_members (
  organization_id,
  profile_id,
  role_id,
  status
)
select
  '20000000-0000-4000-8000-000000000001',
  id,
  '10000000-0000-4000-8000-000000000001',
  'ACTIVE'
from auth.users
where lower(email) = lower('admin@example.com')
on conflict (organization_id, profile_id) do update
set role_id = excluded.role_id,
    status = excluded.status;
```

Este bootstrap se realiza en un entorno servidor confiable. Un usuario recién registrado nunca se asigna a sí mismo una organización o un rol.

Para asignar un empleado, usá el rol `10000000-0000-4000-8000-000000000002` y agregá luego una fila en `branch_members` con el mismo `organization_id`, su `profile_id` y la sucursal autorizada.

## Verificación

```bash
pnpm check
pnpm build
pnpm build:pos:desktop
supabase db lint --local
pnpm db:test
```

`supabase db reset` aplica todas las migraciones desde cero y carga el catálogo de demostración. Los tipos TypeScript se pueden regenerar con la base local levantada:

```bash
pnpm db:types
```

## Estructura

```text
apps/
  admin/             Next.js, responsive, despliegue futuro en Vercel
  pos/               POS React/Vite/Tauri con SQLite local
packages/
  business-logic/    reglas puras, dinero y peso
  database/          cliente Supabase RLS-bound y tipos generados
  sync/              contratos, outbox, backoff y transformación de ventas
  types/             contratos de dominio sin dependencias de UI
  ui/                tokens y futuros componentes compartidos
supabase/
  migrations/        esquema PostgreSQL versionado y RLS
  seed.sql            organización, sucursales, productos y precios demo
docs/
  architecture.md    decisiones y límites técnicos
  phase-plan.md      secuencia continuable de implementación
```

## Datos de demostración

La organización `Carnicerías Demo` contiene `Sucursal Centro`, `Sucursal Norte`, tres categorías, ocho productos y precios globales en centavos de ARS. No se crean usuarios, contraseñas ni ventas simuladas. Las ventas reales se completan exclusivamente mediante la RPC transaccional `complete_sale`.

## Convenciones importantes

- Dinero persistido como centavos enteros (`bigint` en PostgreSQL, `bigint` en dominio TypeScript).
- Peso persistido como gramos enteros.
- Timestamps en UTC; presentación en `America/Argentina/Buenos_Aires`.
- Los precios son históricos: se cierra `valid_to` y se inserta una nueva fila; no se reescribe el importe anterior.
- El cliente usa solo la anon key y depende de RLS. La service-role key es exclusivamente servidor.

Consultá [la arquitectura](docs/architecture.md) antes de iniciar la siguiente fase.
Consultá [el diseño offline-first](docs/offline-first.md) para seguridad, conflictos y recuperación.
Para comprobar la Fase 1A contra el proyecto vinculado, seguí [la validación remota](docs/remote-validation.md).
