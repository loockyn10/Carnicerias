# Integración de balanza (POS)

Balanza → peso → POS. La balanza sólo aporta peso; precio, promociones,
descuentos y totales siguen siendo responsabilidad exclusiva del POS (ver
`docs/DOMAIN_RULES.md`). Todo funciona local y offline: no depende de
Internet, Supabase ni ningún servidor.

## Modelo inicial soportado

KRETZ Novel Eco 2, conexión RS232 DB-9 (pin 2 Tx, pin 3 Rx, pin 5 GND). Modo
usado: **transmisión continua de peso**. La balanza transmite ~2 veces por
segundo mientras el peso neto está estable.

No se implementó peso/precio/importe desde la balanza, programación de
PLUs, escritura de precios, JDataGate, iTegra ni Bluetooth: fuera de
alcance de este sprint (ver `docs/DECISIONS.md` si eso cambia).

## Protocolo y parámetros RS232

- 9600 baudios, ASCII, 8 data bits, sin paridad, 2 stop bits.
- Frame documentado: `STX (0x02) + peso neto ASCII en kg con punto decimal + CR (0x0D)`.
  Ejemplo conceptual: `0x02 "01.250" 0x0D` = 1,250 kg.
- Estos parámetros son fijos para este modelo y no son configurables desde
  el POS (evita exponer detalle técnico innecesario al empleado).

El parser (`apps/pos/src-tauri/src/scale/parser.rs`) es puro y no depende
de hardware: reensambla frames que llegan divididos entre varias lecturas
seriales, soporta varios frames concatenados en una misma lectura, descarta
basura antes del primer `STX` y resincroniza si un frame nunca cierra con
`CR`. Convierte a **gramos enteros** inmediatamente (nuestro dominio nunca
usa floats para peso); rechaza explícitamente frames vacíos, con
caracteres inválidos, sin punto decimal o con más de 3 dígitos enteros/3
decimales — nunca clampea ni inventa un valor. No se documentó
representación de peso negativo por tara; si el equipo real llegara a
enviarlo, el parser actual lo descarta como frame inválido (no se inventó
una regla de signo).

## Arquitectura

La comunicación serial vive en Rust/Tauri (`apps/pos/src-tauri/src/scale/`),
nunca en Web Serial API ni en el hilo de UI:

- `parser.rs`: `KretzFrameParser`, puro, testeado sin hardware (frame
  completo, dividido, concatenado, basura previa, CR incompleto, 0 g,
  500 g, 1.250 kg, 12.345 kg, caracteres inválidos — ver sus tests).
- `mod.rs`: estado compartido (`ScaleRuntimeState`), ciclo de vida de
  conexión (`DISCONNECTED → CONNECTING → CONNECTED / ERROR`), lectura en un
  thread dedicado con timeout de 300 ms (nunca bloquea Tauri/React), y los
  comandos Tauri que expone el frontend.

No existe una interfaz `trait` explícita, pero la frontera es la misma que
pedía el diseño: `connect_scale`/`disconnect_scale` despachan según
`ScaleConfig.kind` (`MANUAL` | `SIMULATED` | `KRETZ_NOVEL_ECO_2`) y el resto
del POS sólo conoce `ScaleSnapshot` (config + estado de conexión + última
lectura). Agregar una balanza nueva es un nuevo `match` arm ahí, sin tocar
el flujo de venta.

Cada lectura válida y cada cambio de estado se emiten al frontend por el
evento Tauri `scale://update` (nunca a cientos de Hz: como máximo ~2/s,
igual que la transmisión real). El frontend nunca hace polling agresivo.

### Crate serial elegida: `serialport`

Se eligió [`serialport`](https://docs.rs/serialport) (`serialport = { version = "4", default-features = false }`
en `apps/pos/src-tauri/Cargo.toml`) porque:

- soporta Windows (COM*) y Linux (`/dev/ttyUSB*`, `/dev/ttyS*`) con la misma
  API, incluyendo `i686-unknown-linux-gnu`;
- `default-features = false` desactiva el backend opcional `libudev` de
  Linux. Sin él, `available_ports()` usa un fallback que recorre
  `/sys/class/tty` directamente (sin depender de `libudev-dev`), suficiente
  para listar `ttyUSB*`/`ttyS*`. Esto evita agregar `libudev-dev` a la
  imagen Debian 12 i386 (`apps/pos/src-tauri/linux/Dockerfile`), que hoy no
  la tiene y que el sprint pidió no engordar innecesariamente.
- no requiere ninguna dependencia de sistema nueva en Windows.

`cargo check`/`cargo test` (target nativo Windows x86_64 de esta sesión)
compilan limpio con esta configuración. **Pendiente**: no se pudo compilar
en esta sesión contra `i686-unknown-linux-gnu` dentro del contenedor Debian
12 i386 (requiere Docker o el workflow de GitHub Actions, ver
`docs/LINUX_POS.md`); antes del primer build real hay que confirmar que
`cargo check --target i686-unknown-linux-gnu` también compila ahí.

### Configuración local (persistencia)

No se creó una tabla ni una migración SQLite nueva. La configuración de
balanza es específica de cada caja y se guarda como JSON en la tabla
genérica clave/valor `sync_metadata` (ya existente desde
`001_offline_core.sql`, usada también para `catalog_cursor`,
`cash_discount_bps`, `max_shift_hours`, etc.) bajo la clave
`scale_config`:

```json
{ "kind": "MANUAL" | "SIMULATED" | "KRETZ_NOVEL_ECO_2", "port": "COM3" | "/dev/ttyUSB0" | null, "autoconnect": true | false }
```

Baudios/bits/paridad/stop bits del Kretz son constantes fijas en
`scale/mod.rs` (`KRETZ_BAUD_RATE = 9600`, 8 data bits, sin paridad, 2 stop
bits): no forman parte de la configuración persistida ni de la UI.

Si `autoconnect` es `true` y el tipo no es `MANUAL`, el POS intenta conectar
solo al iniciar (best-effort: si falla, sólo queda en `ERROR`/logea a
stderr, nunca bloquea el arranque de la app).

## Elegir puerto en el POS

Config → Diagnóstico (el mismo modal de diagnóstico técnico que ya existía)
→ sección "Balanza": tipo, puerto (con botón "Actualizar" que vuelve a
enumerar puertos vía `list_scale_ports`), autoconectar, Conectar/Desconectar.
No se hardcodea `COM3` ni `/dev/ttyUSB0`; si no hay puertos detectados se
muestra explícitamente "No se detectaron puertos serie."

Esto queda fuera del flujo normal del cajero (no aparece en la pantalla de
venta salvo el indicador chico de estado y el atajo dentro del modal de
peso).

## Windows

Enumeración de puertos vía `serialport::available_ports()`, sin
dependencias adicionales. No se tocó la config NSIS ni `tauri dev`.

## Linux (Debian 12 i386)

Puertos esperados: `/dev/ttyUSB0`, `/dev/ttyS0` (u otro numerado) para un
adaptador USB→RS232 o un puerto serie nativo. El usuario que ejecuta el POS
probablemente necesite pertenecer al grupo `dialout` para poder abrir el
puerto sin permisos de superusuario:

```bash
sudo usermod -aG dialout "$USER"
```

Este comando **no se ejecuta automáticamente** desde la aplicación (la app
no hace cambios de sistema por sí sola). Después de agregarlo al grupo hace
falta cerrar sesión y volver a iniciarla (o reiniciar) para que el cambio de
grupo tome efecto.

## USB → RS232

No confundir un adaptador **TTL** serial (3.3 V/5 V lógico) con un adaptador
**RS232** real (±12 V aprox.): son eléctricamente distintos y uno TTL no
funciona con la Novel Eco 2. Puede usarse RS232 nativo o un adaptador
USB→RS232 real; la aplicación no depende de ninguna marca específica de
adaptador, sólo de que el sistema operativo lo expone como un puerto serie
estándar (`COM*` en Windows, `/dev/ttyUSB*`/`/dev/ttyS*` en Linux).

## Diagnóstico básico

- "No se detectaron puertos serie": revisar cable/adaptador y, en Linux,
  permisos/grupo `dialout`.
- Estado `ERROR` tras conectar: mensaje de error del sistema operativo al
  abrir el puerto (puerto ocupado, no existe, permisos). El POS nunca se
  cae por esto: la venta sigue disponible con ingreso manual de peso.
- Balanza conectada pero sin lectura: el modo continuo sólo transmite con
  peso estable; confirmar que la balanza esté configurada en modo
  transmisión continua de peso (no "a pedido") según su manual.
- Un peso mostrado hace más de ~4 segundos (o después de desconectar) deja
  de ofrecerse como atajo: el empleado debe volver a colocar la mercadería
  o ingresar el peso a mano. Esto evita reutilizar el peso de un cliente
  anterior.

## Modo simulado

`kind = "SIMULATED"` es una herramienta de desarrollo/configuración, no un
modo operativo normal de venta. Permite fijar un peso (`set_simulated_scale_weight`)
y simular una desconexión (`simulate_scale_disconnect`) sin hardware, para
probar de punta a punta adapter → peso → UI → línea de venta. Su UI vive
sólo dentro del modal de diagnóstico, no en la pantalla normal del cajero.

## Integración con la venta

Sin cambios en pricing, promociones, descuentos ni snapshots. Dentro del
modal existente "Agregar al ticket" (mismo flujo de ingreso de peso que ya
existía) aparece, sólo si hay una balanza no-manual configurada, un panel
con el estado de conexión y, si la lectura está vigente, un botón "Usar
este peso" que copia el peso a gramos enteros al campo manual existente
(mismo formato que ya usa el campo `Peso manual en kg`). El empleado sigue
teniendo que tocar "Confirmar línea": ninguna pesada agrega una línea
automáticamente. Productos `UNIT` no muestran este panel (siguen sin usar
peso).

## Limitaciones conocidas

- Sólo se documentó y probó (sin hardware) el modo transmisión continua de
  peso; los demás modos del manual (peso/precio/importe, a pedido, datos)
  no se implementaron.
- Enumeración de puertos en Linux sin `libudev` no expone fabricante/modelo
  USB, sólo el nombre del dispositivo (`ttyUSB0`, etc.); es suficiente para
  elegir el puerto pero no identifica la marca del adaptador.
- No se documentó representación de peso negativo por tara; si aparece en
  la práctica, hoy se descarta como frame inválido.

## REQUIERE VERIFICACIÓN / prueba física pendiente

Todo lo de arriba se validó sin hardware: parser (tests Rust), estado de
conexión/reconexión/error (tests Rust sobre `ScaleRuntimeState`), frescura
de lectura (tests `vitest` en `packages/business-logic`), typecheck/lint/
build web y `cargo check`/`cargo test` nativos. **No se conectó una Novel
Eco 2 real.**

Pasos para el primer smoke test físico (mañana, con la balanza a mano):

1. Configurar la Novel Eco 2 en modo **transmisión continua de peso**
   siguiendo su manual (ver perilla/menú de configuración del equipo).
2. Conectar por RS232 DB-9 (nativo o adaptador USB→RS232 real, no TTL).
3. Windows: abrir el POS, Diagnóstico → Balanza → tipo "KRETZ Novel Eco 2",
   elegir el puerto `COM*` que aparezca, Conectar. Colocar un peso conocido
   y confirmar que "Usar este peso" muestre el valor correcto en kg.
4. Linux: confirmar que el dispositivo aparece como `/dev/ttyUSB*` o
   `/dev/ttyS*` (`ls /dev/tty*` antes/después de conectar el adaptador), que
   el usuario pertenece a `dialout` (`groups`), y repetir el paso 3 con
   `pnpm build:pos:linux:i386` o el artifact de GitHub Actions.
5. Probar desconexión física del cable con una venta en curso: confirmar
   que el estado pasa a `ERROR`/desconectado y que se puede seguir
   vendiendo con peso manual sin reiniciar el POS.
6. Probar reconexión: volver a conectar el cable, presionar "Conectar" de
   nuevo y confirmar que empiezan a llegar lecturas nuevas (no una lectura
   vieja reutilizada).
7. Registrar resultado de cada punto acá o en `docs/CURRENT_STATE.md`.

No cambiar reglas de negocio como resultado de este smoke test; cualquier
hallazgo de producto pasa por `docs/DECISIONS.md`.
