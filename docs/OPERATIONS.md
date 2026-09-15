# Operations

## Requisitos

- Node.js 22 o superior.
- pnpm 11.19.0, según `packageManager`.
- Rust stable MSVC, C++ Build Tools y WebView2 para POS desktop Windows.
- Docker con soporte `linux/386` (QEMU) para empaquetar POS Linux i386; ver `docs/LINUX_POS.md`.
- Docker Desktop para Supabase local/pgTAP.
- Sesión válida de Supabase CLI para operaciones `--linked`.

## Variables

Admin, en `apps/admin/.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

POS, en `apps/pos/.env.local`:

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Nunca colocar `service_role` ni secret keys en variables públicas.

## Desarrollo

```bash
pnpm install --frozen-lockfile
pnpm dev:admin
pnpm dev:pos
pnpm dev:pos:desktop
```

## Validación

Validación completa del monorepo:

```bash
pnpm check
pnpm build
```

Admin:

```bash
pnpm --filter @carnicerias/admin typecheck
pnpm --filter @carnicerias/admin lint
pnpm --filter @carnicerias/admin build
```

POS web:

```bash
pnpm --filter @carnicerias/pos typecheck
pnpm --filter @carnicerias/pos lint
pnpm --filter @carnicerias/pos build
```

POS desktop:

```bash
pnpm build:pos:desktop
```

El script raíz ejecuta `@carnicerias/pos build:desktop`. Si el ejecutable está bloqueado en Windows, cerrarlo antes del build. No borrar SQLite para actualizar.

POS Linux (Debian 12 i386):

```bash
pnpm build:pos:linux:i386
```

Genera el `.deb` en un contenedor Debian 12 i386 nativo, no en la netbook de destino. Ver `docs/LINUX_POS.md` para requisitos, artefacto resultante e instalación.

## Supabase local

```bash
pnpm db:start
pnpm db:reset
pnpm db:test
pnpm db:types
pnpm db:stop
```

`db:reset` es destructivo para la base local de desarrollo y carga el seed. No usar contra datos remotos ni como solución para una instalación POS.

Si Docker no está disponible, reportar pgTAP como no ejecutado; no confundir el fallo del daemon con un fallo de aplicación.

## Supabase vinculado

```bash
pnpm exec supabase migration list --linked
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
pnpm exec supabase db lint --linked --level warning --fail-on error
```

Todas las operaciones `--linked` requieren `supabase login` válido o `SUPABASE_ACCESS_TOKEN`. Hacer dry-run antes del push, usar sólo migraciones incrementales y no editar migraciones ya aplicadas.

El inventario local llega hasta PostgreSQL 022 y SQLite 006. El estado remoto debe verificarse con `migration list --linked`; no asumir que la migración 022 está aplicada hasta confirmarlo.

## Deploy Admin

El Admin se despliega como web en Vercel. No existe `vercel.json` en el repositorio: Root Directory, rama, región y variables se administran en Vercel. Debe configurarse `apps/admin` y las dos variables públicas anteriores.

Antes de desplegar:

```bash
pnpm install --frozen-lockfile
pnpm --filter @carnicerias/admin typecheck
pnpm --filter @carnicerias/admin lint
pnpm --filter @carnicerias/admin build
```

## Smoke POS mínimo

1. Abrir online y sincronizar.
2. Confirmar dispositivo/sucursal.
3. Seleccionar operador e ingresar PIN.
4. Clock-in y venta; verificar atribución al empleado.
5. Reiniciar: volver a pedir operador/PIN y recuperar el turno abierto.
6. Vender offline y comprobar outbox pendiente.
7. Reconectar y verificar sync exactamente una vez.
8. Clock-out y revisar el turno en Admin.

## Datos que no deben borrarse para reparar problemas

- SQLite del POS;
- ventas y outbox;
- stock ledger;
- historiales de precios, costos y tarifas;
- snapshots;
- auditoría;
- turnos;
- rendiciones.
