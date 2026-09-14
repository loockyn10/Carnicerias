# Plataforma de gestión para carnicerías

Monorepo multiempresa y multisucursal con dos aplicaciones:

- Admin web: Next.js + Supabase.
- POS Windows: React/Vite + Tauri + SQLite, offline-first.

La fuente canónica de contexto, reglas, arquitectura y estado está en [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md), [`docs/DOMAIN_RULES.md`](docs/DOMAIN_RULES.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md).

## Requisitos

- Node.js 22 o superior.
- pnpm 11.19.0.
- Docker Desktop para Supabase local.
- Rust stable MSVC, C++ Build Tools y WebView2 para POS desktop.

## Inicio rápido

```bash
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:reset
pnpm dev:admin
```

En otra terminal, para POS desktop:

```bash
pnpm dev:pos:desktop
```

Crear las variables a partir de:

- `apps/admin/.env.example` → `apps/admin/.env.local`;
- `apps/pos/.env.example` → `apps/pos/.env.local`.

Usar únicamente URL y publishable key. Nunca exponer `service_role` o secret keys.

## Validación

```bash
pnpm check
pnpm build
pnpm build:pos:desktop
pnpm db:test
```

Para comandos detallados, Supabase vinculado, variables, deploy y smoke POS, consultar [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Estructura

```text
apps/admin              Admin Next.js
apps/pos                POS React/Vite/Tauri
packages/business-logic Reglas puras de dominio
packages/database       Cliente Supabase y tipos
packages/sync           Contratos de sincronización
packages/types          Tipos compartidos
packages/ui             UI compartida
supabase/migrations     Esquema PostgreSQL incremental
supabase/tests          Pruebas SQL/pgTAP
docs                    Fuente de verdad documental
```

## Estado importante

El POS ya opera offline con ventas, stock, pricing, promociones, outbox y control horario. Existe una contradicción pendiente: el empleado POS objetivo no debe necesitar Auth individual, pero la implementación actual todavía depende de `auth.users`. No crear una interpretación alternativa; seguir [`docs/TASKS.md`](docs/TASKS.md).
