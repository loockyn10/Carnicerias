# POS en Linux (Debian 12 i386)

Plataforma adicional para cajas de bajo recurso (ej. Intel Atom N270, 2 GB RAM,
pantalla ~1024×600). Es el mismo POS (React/Vite + Tauri 2 + Rust + SQLite),
sólo cambia el empaquetado. Ver `docs/DECISIONS.md` (decisión Linux i386).

## Plataforma soportada

- Debian 12 (Bookworm), arquitectura i386, con entorno de escritorio XFCE.
- WebKitGTK 4.1 + GTK3 (Tauri usa WebKitGTK en Linux, no WebView2).

## Dependencias de runtime (en la netbook)

Sólo dependencias de ejecución, nunca de desarrollo:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0
```

`apt install` del `.deb` resuelve estas dependencias automáticamente si hay
acceso a los repositorios de Debian; si la netbook está sin red, instalarlas
antes desde un pendrive/mirror local.

La netbook **no** necesita Node, pnpm, Rust, Cargo, ni el código fuente.

## Cómo generar el `.deb`

El build corre en la máquina de desarrollo (o CI), no en la netbook:

```bash
pnpm build:pos:linux:i386
```

Esto ejecuta `scripts/build-pos-linux-i386.sh`, que:

1. Compila el frontend con el Node/pnpm del repo (`apps/pos/dist`). Debian 12
   i386 trae Node 18 por defecto y Vite 7 exige Node ≥20.19/≥22.12, así que el
   frontend nunca se compila dentro del contenedor ni en la netbook.
2. Construye una imagen Docker Debian 12 **i386 nativa** (`--platform
   linux/386`, emulada con QEMU si la máquina de build es x86_64) con Rust,
   Tauri CLI y las libs de desarrollo de WebKitGTK/GTK3.
3. Corre `cargo tauri build --target i686-unknown-linux-gnu --bundles deb`
   dentro de ese contenedor.

Requiere Docker con soporte `linux/386` (Docker Desktop lo trae; en Linux
puro instalar `qemu-user-static`/`binfmt-support`).

## Dónde queda el artefacto

```text
apps/pos/src-tauri/target/i686-unknown-linux-gnu/release/bundle/deb/carnicerias-pos_0.1.0_i386.deb
```

## Copiar e instalar

```bash
scp carnicerias-pos_0.1.0_i386.deb usuario@netbook:/tmp/
ssh usuario@netbook
sudo apt install /tmp/carnicerias-pos_0.1.0_i386.deb
```

(`apt install <archivo.deb>` en vez de `dpkg -i` para que resuelva
dependencias automáticamente.)

## Actualizar

Repetir `apt install` con el `.deb` nuevo; misma versión de paquete
sobrescribe, versión distinta actualiza. El identificador de la app
(`com.carnicerias.pos`) no cambia, así que los datos locales se conservan.

## Desinstalar

```bash
sudo apt remove carnicerias-pos
```

Esto no borra la base SQLite del usuario (ver más abajo); para borrarla
también hay que eliminar el directorio de datos manualmente.

## Datos locales (SQLite)

El POS resuelve el directorio de datos con la API de Tauri
(`app.path().app_data_dir()`), que en Linux sigue XDG y usa el identificador
`com.carnicerias.pos`:

```text
~/.local/share/com.carnicerias.pos/carnicerias-pos.sqlite
```

Mismas migraciones SQLite que Windows (`001`–`006`); el binario Linux abre y
aplica exactamente el mismo esquema, no hay una versión distinta.

## Logs

Ejecutando manualmente desde una terminal se ven stdout/stderr directamente:

```bash
/usr/bin/carnicerias-pos
```

## Iniciar manualmente

Desde el menú de aplicaciones XFCE ("Carnicerías POS") o:

```bash
/usr/bin/carnicerias-pos
```

## Autostart (opcional, reversible)

Usa el mecanismo estándar XDG Desktop Autostart (`~/.config/autostart/`), que
XFCE respeta de forma nativa; no depende de ningún entorno de escritorio en
particular. Copiar el `.desktop` de autostart incluido en el repo:

```bash
mkdir -p ~/.config/autostart
cp apps/pos/src-tauri/linux/carnicerias-pos-autostart.desktop ~/.config/autostart/
```

Para desactivarlo, borrar ese archivo o poner `X-GNOME-Autostart-enabled=false`.
Esto **no** es kiosk mode: la netbook sigue mostrando el escritorio XFCE
normal y el POS se abre como una ventana más.

## Procedimiento de prueba (build)

1. `pnpm build:pos:linux:i386` en la máquina de desarrollo.
2. Confirmar que aparece el `.deb` en la ruta de arriba.
3. `apt install` el `.deb` en una VM/contenedor Debian 12 i386 limpio y
   confirmar que abre sin errores de librerías faltantes.

Ver `docs/CURRENT_STATE.md` para qué de esto está **validado** vs sólo
**implementado**, y el checklist de hardware real más abajo.

## Checklist de smoke test en hardware real (Atom N270 u equivalente)

No asumir que compilar implica que funciona bien en el hardware real.
Ejecutar y registrar resultado de cada punto:

- [ ] Arranca la app sin errores visibles.
- [ ] SQLite abre (no hay error de "caja no autorizada" por fallo de datos).
- [ ] El dispositivo se identifica (o pide configuración, según corresponda).
- [ ] El catálogo carga tras sincronizar.
- [ ] Selección de empleado + PIN funciona.
- [ ] Marcar entrada (clock-in) funciona.
- [ ] Venta offline se registra y queda en outbox.
- [ ] Venta online se registra y sincroniza.
- [ ] Reconexión sincroniza el outbox pendiente exactamente una vez.
- [ ] Reinicio de la netbook: vuelve a pedir operador/PIN y recupera el turno abierto.
- [ ] Resolución 1024×600: sin cortes de footer/ticket, sin scroll bloqueado, modales usables.
- [ ] RAM aproximada en uso (reportar valor).
- [ ] CPU en reposo (reportar valor aproximado).
- [ ] Cierre normal de la ventana persiste el clock-out antes de cerrar.

No cambiar reglas de negocio como resultado de este smoke test; cualquier
hallazgo de producto pasa por `docs/DECISIONS.md`.
