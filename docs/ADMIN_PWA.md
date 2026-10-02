# Admin como aplicación instalable (PWA)

## Cómo funciona la sesión

- Supabase Auth con cookies (`@supabase/ssr`), persistentes (400 días), no cookies de sesión: cerrar la ventana o reiniciar Windows no cierra sesión.
- El middleware renueva el token en cada request (refresh automático). No hay login propio ni PIN extra; RLS y permisos no cambian.
- Todo se resuelve en el servidor: `/` y `/admin` redirigen a `/login` sólo si Supabase confirma que no hay sesión válida (sin cookie o token rechazado). Si no se puede verificar (sin red, 5xx) aparece "No se pudo cargar · Reintentar" en lugar del login. Mientras carga se muestra el splash.
- Se vuelve a pedir login sólo si: se pulsa `Salir`, el refresh token fue invalidado (cambio de contraseña, revocación, expiración según la configuración del proyecto Supabase: *Auth → Sessions*, time-box / inactivity timeout), o se borran los datos del navegador/PWA.

## Instalar (equipo de Fran)

1. Abrir la URL del Admin en Chrome o Edge e iniciar sesión una vez.
2. Chrome: menú ⋮ → *Transmitir, guardar y compartir* → *Instalar Administración Carnicerías*. Edge: menú … → *Aplicaciones* → *Instalar este sitio como aplicación*.
3. Marcar *Crear acceso directo en el escritorio* / *Anclar a la barra de tareas* (o hacerlo luego desde `chrome://apps` / `edge://apps`: clic derecho → *Crear acceso directo*, *Anclar a la barra de tareas*).
4. Desde entonces: doble clic en el icono → splash → Admin.

Usar siempre el mismo perfil de navegador y no instalar en equipos no confiables. Desinstalar la app o borrar datos del sitio cierra la sesión local.

## Deploy

Sólo requiere desplegar el Admin (Vercel). No hay migraciones ni cambios de variables de entorno. No hay service worker: el instalador de Chrome/Edge no lo exige y así no se cachean páginas autenticadas.
