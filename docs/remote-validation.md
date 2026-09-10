# Validación remota de Fase 1A

## Variables del Admin

Crear `apps/admin/.env.local` (no en la raíz) con:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Ambos valores están en Supabase Dashboard > Project Settings > API, o en el diálogo **Connect**. No usar secret key ni `service_role`.

## Procedimiento

1. Confirmar que el proyecto vinculado contiene la migración:

   ```bash
   pnpm exec supabase migration list --linked
   ```

2. En un remoto de desarrollo vacío, cargar el seed idempotente:

   ```bash
   pnpm exec supabase db push --include-seed
   ```

   No ejecutar seeds de demostración en producción.

3. Levantar Admin:

   ```bash
   pnpm dev:admin
   ```

4. En Supabase Dashboard > Authentication > Users, elegir **Add user**, crear `admin@example.com` con contraseña segura y marcarlo confirmado si la UI lo solicita.

5. En SQL Editor comprobar que la trigger creó el perfil:

   ```sql
   select u.id, u.email, p.display_name, p.active
   from auth.users u
   left join public.profiles p on p.id = u.id
   where lower(u.email) = lower('admin@example.com');
   ```

   Debe existir `display_name` y `active = true`.

6. Antes del bootstrap, iniciar sesión en <http://localhost:3000/login>. `/admin` debe mostrar **Auth correcto · acceso pendiente**: el perfil propio es visible, pero no hay organización accesible.

7. Cerrar sesión y ejecutar una vez en SQL Editor:

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

8. Verificar el bootstrap en SQL Editor:

   ```sql
   select
     u.email,
     p.display_name,
     om.status,
     o.name as organization_name,
     r.key as role_key
   from auth.users u
   join public.profiles p on p.id = u.id
   join public.organization_members om on om.profile_id = u.id
   join public.organizations o on o.id = om.organization_id
   join public.roles r on r.id = om.role_id
   where lower(u.email) = lower('admin@example.com');
   ```

   Debe devolver `ACTIVE`, `Carnicerías Demo` y `admin`.

9. Volver a iniciar sesión. `/admin` consulta con la sesión real (sin secret/service-role key) y debe mostrar perfil, organización, membresía, rol, dos sucursales, ocho productos y ocho precios.

10. Recargar la página: debe conservar la sesión. Abrir `/login`: debe redirigir a `/admin`. Cerrar sesión: `/admin` debe redirigir a `/login`.

Con esos resultados, la integración Auth, recuperación de sesión, trigger y acceso positivo por RLS de Fase 1A quedan validados. La pantalla previa al bootstrap verifica además que un usuario autenticado sin membresía no obtiene acceso organizacional.

