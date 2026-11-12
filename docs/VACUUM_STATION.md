# Estación de producción de Envasados

Pantalla `Admin → Envasados → Estación de producción` (`/admin/vacuum/station`). Pensada para envasar durante horas con la menor intervención posible: se elige el corte una vez, se apoya el paquete en la balanza y la estación **detecta el peso estable, registra el paquete, imprime la(s) etiqueta(s) configuradas (hoy sólo la comercial) y espera el retiro** antes de aceptar el siguiente. Es la misma aplicación web (sin Tauri, sin servicio local, sin otra base): registra EXACTAMENTE el mismo paquete que el formulario manual (`create_vacuum_package`, tabla `vacuum_packages`, misma configuración EAN, PLU, vida útil, precio vigente y permisos). El formulario manual sigue funcionando.

## Flujo y estados

`ESPERANDO PAQUETE → DETECTANDO → ESTABILIZANDO → REGISTRANDO → IMPRIMIENDO → ESPERANDO RETIRO → ESPERANDO PAQUETE`, más `PAUSADO` (motivo: manual, balanza desconectada, sin servidor, registro fallido, impresión fallida).

La decisión vive en un reductor puro (`apps/admin/src/lib/vacuum-station/machine.ts`) con tests; `controller.ts` ejecuta los efectos (registrar, imprimir) y devuelve los resultados con el número de ciclo.

Reglas que garantiza (cada una con su test):

- **Un ciclo de pesado = un registro.** Al capturar el peso se exige el retorno ESTABLE a cero (por defecto ≤ 10 g durante 500 ms) antes de aceptar otro. Un paquete apoyado minutos u horas no genera nuevos registros ni impresiones, aunque la lectura vibre dentro de la tolerancia, se desconecte y reconecte la balanza, se pause y reanude o se reintente algo.
- **Estabilidad.** Si la balanza informa estabilidad (`ASCII_LINE`: `ST`/`US`), esa señal manda: «inestable» nunca estabiliza. Si no la informa (el frame del KRETZ Novel Eco 2 no la trae documentada: **no se asume**), se usan lecturas consecutivas dentro de ± 5 g (contra la PRIMERA lectura, para que una deriva lenta no se cuele) durante 800 ms. Un silencio de más de 2 s entre lecturas reinicia la cuenta. Todo configurable.
- **Peso mínimo** (50 g), **tara** opcional y rechazo de pesos negativos, cero, NaN o fuera de rango (> 99,999 kg).
- **Cambio de corte con peso encima**: ese paquete NO se registra con el corte nuevo; se espera el cero. Un registro ya en vuelo conserva SU corte.
- **Al (re)conectar la balanza** se exige ver el cero: no se sabe qué hubo encima mientras estuvo desconectada.
- **Registro e impresión son operaciones separadas.** Si el paquete se registró y la impresión falla: no se registra otro, se pausa, se muestra el error y se puede **reimprimir las mismas etiquetas** (o continuar sin imprimir; el paquete sigue en «Envasados recientes»).
- **Sin Internet / sin servidor**: se pausa sola (evento `offline` del navegador + un latido cada 20 s que consulta el resumen del día) y se reanuda al volver. No se imprimen etiquetas de un paquete que no quedó registrado.
- **Idempotencia**: cada ciclo usa una `request_key` única; un fallo de red se reintenta (2 veces) y al reanudar se reintenta con la **misma clave**: el servidor devuelve el paquete que ya creó en vez de crear otro. No se imprime un segundo juego por un reintento.

## Conectar la balanza (Web Serial)

Requisitos: Chrome o Edge de escritorio, página por **https** (o `localhost`), balanza por RS232/USB. El navegador no permite elegir el puerto sin una acción del usuario.

1. Abrir la estación y tocar **Conectar balanza** → el navegador muestra la lista de puertos COM → elegir el de la balanza.
2. **Dispositivos** (⚙) → Balanza: protocolo y parámetros. Valores del KRETZ Novel Eco 2 (los del POS): 9600 baudios, 8 bits, sin paridad, 2 bits de parada. La balanza tiene que estar en **transmisión continua de peso** (ver `docs/SCALE_INTEGRATION.md`). Cambiar los parámetros requiere volver a conectar.
3. La estación recuerda la identificación USB del puerto y, al abrirla de nuevo, intenta reconectar **sin diálogo** sólo si el navegador conserva el permiso; si no se puede, lo avisa y hay que tocar «Conectar balanza» otra vez. Si se corta el cable la detecta y reconecta sola (espera creciente) mientras el puerto siga autorizado.
4. Si el puerto está ocupado (el POS u otro programa lo tiene abierto) lo dice; un puerto serie sólo lo abre un programa a la vez.

Si el navegador no tiene Web Serial, la pantalla muestra un mensaje claro de incompatibilidad (no hay alternativa en Firefox, Safari ni celular).

## Impresión de etiquetas

### Diagnóstico del problema de la prueba física (avance de ~1 m de papel y etiqueta de costado)

Lo que se encontró en el código: el módulo manual generaba un **PDF** (una página por etiqueta, del tamaño exacto, 58 × 40 mm por defecto → apaisada) y lo imprimía con `iframe.contentWindow.print()` sobre el visor de PDF del navegador. Ese camino no le entrega al controlador de la impresora el tamaño de la etiqueta como hoja: el visor usa el papel que el controlador tenga por defecto y **gira y/o escala** la página para que «entre» (una etiqueta apaisada en un papel configurado vertical sale de costado). Si ese papel es «rollo continuo» o de mayor largo, el avance es el de ese papel, no el de la etiqueta. Los márgenes y los saltos de página del PDF eran correctos (0 mm, una página por etiqueta); el layout no era el problema.

**No se pudo confirmar la causa exacta sin la impresora** y no se asume un modelo. Hay dos causas posibles y pueden combinarse: (a) el camino PDF del navegador (corregido abajo); (b) la configuración de la impresora o del driver: tipo de papel «continuo» en vez de «etiquetas con separación», sensor de etiqueta sin calibrar (la impresora avanza hasta encontrar la marca) o papel del driver distinto de la etiqueta.

### Qué cambió

Cada etiqueta se imprime ahora como **su propio documento HTML** con un único SVG en milímetros y `@page { size: 58mm 40mm; margin: 0 }` (`lib/vacuum-station/label-print.ts`): el navegador le pasa al controlador exactamente ese tamaño, sin márgenes, sin escalado y sin saltos de página. Es el mismo layout (`vacuum-label-layout.ts`) que usan la vista previa y el PDF: el diseño no se tocó. La informativa y la de precio son dos trabajos (pueden tener alturas distintas). El formulario manual y los botones «Reimprimir» usan este camino y, si falla, vuelven al PDF de siempre.

Además hay un **giro de calibración** (0°/90°/180°/270°) por equipo: como cada controlador decide cómo entra el papel, si la etiqueta sale de costado se ajusta el giro en vez de tocar el diseño.

### Configurar la impresora (una vez, en la computadora de producción)

1. Instalar el driver del fabricante y poner la impresora como **predeterminada** de Windows.
2. En «Preferencias de impresión» crear o elegir un tamaño de papel **exactamente igual a la etiqueta** (por defecto 55 × 44 mm) y tipo de papel **etiquetas con separación (gap)** si el rollo las tiene.
3. **Calibrar el sensor de etiquetas** con la autocalibración de la impresora (cada fabricante tiene la suya). Un avance largo antes de imprimir casi siempre es sensor sin calibrar o papel «continuo».
4. En la estación: **Dispositivos → Imprimir etiqueta de prueba**. Se imprime el borde exacto, una regla (marcas cada 5 mm), los lados IZQ/DER y una flecha hacia ARRIBA. Verificar: borde completo, flecha hacia arriba, la regla mide lo que dice, el papel avanza una etiqueta. Si sale girada, cambiar el **giro** y repetir.
5. Tocar **La etiqueta salió bien**: se guarda la aprobación para esas medidas y ese giro.

### Etiqueta comercial 55 × 44 mm (D-095)

La operatoria actual imprime **sólo la etiqueta comercial** (Dispositivos → «Etiquetas que se imprimen por paquete» = «Sólo comercial»; es el valor por defecto de un equipo nuevo, un equipo que ya tenía «Ambas» guardado la conserva hasta cambiarla). La informativa sigue existiendo y se imprime a pedido («Ambas», «Sólo informativa» o los botones de reimpresión). Papel por defecto: **55 × 44 mm** (`VACUUM_LABEL_DEFAULTS`; la organización puede sobrescribirlo en Configuración y cada paquete conserva las medidas con las que se envasó).

Contenido, de arriba hacia abajo: corte · **precio total** (lo más grande) · peso neto (izq.) y precio/kg (der.) en una fila · `ELAB: DD/MM/AAAA` (izq.) y `VENCE: DD/MM/AAAA` (der.) en una fila, mismo tamaño, 8 → 6 pt como mínimo (si no entran en una fila se apilan; no se recortan) · EAN-13 con sus 13 dígitos. El EAN-13 no se modifica (mismo código, misma estructura); sólo se dibuja con el módulo en **puntos enteros de 203 dpi** (3 puntos ≈ 0,375 mm, mismo grosor en todas las barras), alto de 9 mm que crece hasta 11 mm con el espacio libre, y respeta las zonas de silencio (11 módulos a la izquierda y 7 a la derecha). El margen lateral de 4,5 mm deja el contenido dentro de los 48 mm imprimibles de una térmica de 58 mm.

**Las fechas no se generan al imprimir**: salen de `packed_on`/`expires_on` del paquete registrado (registro manual, estación semiautomática, impresión automática y reimpresión desde el historial usan el mismo snapshot), así que una reimpresión es idéntica a la original aunque hoy cambie la vida útil del corte. Si falta una fecha o no es válida (o el vencimiento es anterior a la elaboración) no se imprime nada y se muestra el motivo (`assertLabelDates`). La vista previa de un borrador sin fecha deja `--/--/----`. Una etiqueta = una página/un trabajo de impresión.

### Impresión automática y sin diálogo

`window.print()` **no imprime en silencio en un navegador convencional**: siempre abre el diálogo de Windows. Lo que sí existe es abrir Chrome o Edge en modo de impresión silenciosa, que manda directo a la impresora predeterminada. Pasos para la PC de producción:

1. Crear un acceso directo de Chrome con destino: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app=https://TU-DOMINIO/admin/vacuum/station` (o el equivalente de Edge con `--kiosk-printing`).
2. Abrir la estación **siempre** con ese acceso directo.
3. Hacer la prueba de impresión y aprobarla. Recién entonces se habilita el interruptor **«Imprimir las etiquetas automáticamente»** (queda apagado por defecto; cambiar las medidas de la etiqueta o el giro invalida la prueba y lo apaga).
4. Si el navegador abre el diálogo igual, la estación lo detecta (la llamada tarda) y muestra un aviso: en ese caso la impresión no es automática.

**Limitaciones que impone la PWA** (no se desarrolló ningún servicio ni app de escritorio): el navegador sólo informa que el trabajo se envió; **no sabe si salió físicamente** ni si falta papel. Por eso existen la prueba, «Reimprimir último» y la pausa ante un error de envío. Elegir otra impresora o cambiar el papel sigue requiriendo el diálogo de Windows (abrir Chrome sin `--kiosk-printing`). Una impresión verdaderamente garantizada (con estado de la impresora) exigiría un servicio local (por ejemplo un agente que hable RAW/ZPL), que queda fuera de esta versión.

Sin la prueba aprobada la estación **sigue registrando** los paquetes pero no imprime sola: se imprime con «Reimprimir».

## Parámetros de producción

- **Corte**: botones grandes con buscador, categorías, favoritos (★, por equipo) y orden por frecuencia (paquetes de los últimos 14 días en la sucursal). Queda seleccionado hasta elegir otro.
- **Elaboración**: hoy por defecto (sigue al día si la pantalla queda abierta); editable antes de producir.
- **Vencimiento**: elaboración + vida útil configurada del corte (la regla existente). **Si el corte no tiene vida útil no se inventa**: se pide cargarlo a mano y hasta entonces ese corte no se registra solo. Con vida útil, la estación manda `expiresOn = null` y lo calcula el servidor (nunca hace falta el permiso de corregirlo).
- **Lote**: automático del servidor (sucursal + día + número). No se carga a mano por paquete.
- **Sucursal** donde se registran (por defecto la de producción de la organización).

## Configuración por dispositivo

Guardada en `localStorage` del navegador (clave `vacuum-station:v1`), separada de la configuración comercial de Envasados (que es de toda la organización y vive en la base): sucursal, protocolo y parámetros del puerto, USB del puerto elegido, reconexión automática, afinado de estabilidad (tiempo, tolerancia, peso mínimo, tolerancia de cero, tiempo en cero, silencio máximo, tara), tipo de etiquetas, giro, aprobación de la prueba de impresión, impresión automática y favoritos. Todo se normaliza al leer: un valor corrupto vuelve al por defecto.

## Simulador de balanza (desarrollo y pruebas)

`lib/vacuum-station/simulator.ts` implementa la misma interfaz que la balanza real y reproduce lecturas inestables, estabilización, retiro y cortes de conexión. **No es un modo de producción**: el panel «Simulador» de Dispositivos sólo existe si el servidor lo habilita (`NODE_ENV !== "production"` o `NEXT_PUBLIC_VACUUM_SCALE_SIMULATOR=1` a propósito); no se activa con parámetros de la URL.

## Migración

`202611070096_vacuum_station.sql` (sólo lectura, no cambia tablas): `list_vacuum_station_products(branch)` y `get_vacuum_station_summary(branch, date)`. Depende de la `095` (estado de los paquetes, para no contar los anulados). **Ninguna de las dos está aplicada en Supabase** (verificado 2026-11-07 con `supabase migration list --linked`; `db push --dry-run` aplicaría la 095 y la 096). Ver `docs/TASKS.md`.

## Qué falta verificar con hardware real

Ver `docs/TASKS.md` (sección de la estación): lectura real de la KRETZ en la PC de producción, estabilidad con paquetes reales, impresión (avance, giro, márgenes, lector sobre la etiqueta), modo `--kiosk-printing`, reconexión tras desenchufar el cable USB y comportamiento ante falta de papel.
