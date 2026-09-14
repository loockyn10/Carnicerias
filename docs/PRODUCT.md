# Product

## Usuarios

### Dueño / Administrador

Necesita una visión rápida del negocio y acceso a:

- Inicio / dashboard.
- Sucursales.
- Ventas.
- Stock.
- Reposición.
- Productos y categorías.
- Formación de precios.
- Promociones.
- Avisos.
- Rendiciones.
- Rentabilidad / analítica.
- Empleados.
- Horas trabajadas.
- Dispositivos.
- Auditoría.

El Admin web conserva autenticación fuerte mediante cuenta administrativa.

### Empleado / Operador POS

Debe poder:

- identificarse rápidamente;
- vender;
- registrar peso/productos;
- seleccionar método de pago;
- trabajar offline;
- marcar entrada y salida;
- cambiar operador sin reiniciar la aplicación.

El empleado POS **no requiere una cuenta Supabase Auth individual** como modelo objetivo. La identidad operativa debe ser un empleado interno creado desde Admin con nombre, PIN, una o varias sucursales, tarifa histórica y estado.

Después de validar el PIN, el POS recupera el turno vigente. Si no existe uno, exige marcar entrada antes de habilitar la operación normal. Salir termina el turno activo y vuelve al selector de operador; no cierra la sesión Supabase del dispositivo.

## Sucursal y dispositivo

Decisión vigente:

- Un **dispositivo POS pertenece a una sucursal**.
- La sucursal operativa la determina el dispositivo, no el empleado.
- Un empleado puede estar autorizado para una o más sucursales.
- Si un empleado no está autorizado para la sucursal del dispositivo, no debe poder operar allí.
- SQLite/offline/outbox permanecen asociados a la sucursal del dispositivo.

La gestión Admin conserva varias asignaciones activas mediante `branch_members`.

## Filosofía UX

La aplicación debe sentirse simple incluso para usuarios no técnicos.

Principios:

- no exponer UUIDs ni detalles técnicos;
- tareas distintas, rutas distintas;
- edición puntual mediante modal/drawer cuando corresponda;
- evitar formularios gigantes permanentes;
- valores normales en neutros;
- rojo sólo para error/crítico;
- naranja para advertencia;
- verde para correcto;
- azul/teal para información/reposición;
- no usar bordó/rojo como color semántico universal.

### POS

- catálogo con scroll propio;
- ticket visible en todo momento;
- items del ticket pueden scrollear;
- total, pago y confirmación permanecen visibles;
- las cards de producto no deben estirarse para rellenar altura disponible;
- operación pensada para pocos pasos.
- el header muestra una sola identidad de operador y una única acción `Salir`;
- el cierre normal de la ventana persiste primero un clock-out local idempotente y lo deja en outbox antes de finalizar.

## Alcance vigente

### POS

- venta completa actual de productos `WEIGHT`;
- soporte de dominio, pricing y analytics para `UNIT`, con venta POS todavía parcial;
- precio/promociones configuradas desde servidor;
- operación offline;
- sync idempotente;
- historial local relevante;
- identidad de operador;
- fichaje entrada/salida;
- futura integración de balanza.

### Admin

- administración comercial;
- stock y reposición;
- rendiciones;
- rentabilidad;
- personal y dispositivos;
- configuración;
- auditoría.

## Fuera de alcance actual

- stock central/depósito del dueño;
- inventarios físicos obligatorios como rutina;
- sistema biométrico;
- análisis automático de cámaras;
- Admin offline-first con SQLite;
- app nativa independiente para Admin;
- detección avanzada de fraude como prioridad inmediata.

## Admin como PWA

Decisión vigente:

- mantener Admin como web;
- convertirlo formalmente en PWA;
- no reemplazarlo por Tauri salvo que aparezca una necesidad nativa concreta;
- la PWA no debe cachear agresivamente datos vivos como stock o ventas.

La prioridad previa es mejorar performance real del Admin.

## Borrado y conservación histórica

Datos operativos/históricos no deben desaparecer:

- ventas: cancelar/revertir, no borrar;
- empleados con historia: desactivar, no hard-delete;
- productos con historia: desactivar;
- precios: conservar historial;
- turnos: corregir con auditoría;
- rendiciones: conservar snapshot histórico.

La UI puede usar lenguaje simple, pero la persistencia debe preservar trazabilidad.
