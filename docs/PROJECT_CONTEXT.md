# Carnicerías — Project Context

## Qué es

Carnicerías es una plataforma de operación y administración para una cadena de carnicerías. Actualmente el caso real parte de pocas sucursales, pero el diseño debe seguir siendo multi-sucursal y preparado para crecer sin rehacer la arquitectura base.

El producto tiene dos superficies principales:

- **POS de sucursal**: aplicación de escritorio Windows, offline-first, usada por empleados para vender y operar aun sin Internet.
- **Admin**: aplicación web para el dueño/administradores, usada para controlar ventas, stock, reposición, precios, rentabilidad, rendiciones, personal y dispositivos.

## Problema que resuelve

El objetivo no es “tener un sistema de ventas” sino **reducir trabajo manual y carga mental del dueño**. El sistema debe permitirle, con pocas acciones:

- saber qué mercadería llevar a cada sucursal;
- controlar ventas y stock teórico;
- reemplazar rendiciones en papel + calculadora;
- entender qué productos venden y cuáles dejan más ganancia;
- gestionar empleados, accesos, horas trabajadas y pago estimado por horas;
- investigar excepciones sólo cuando exista una señal relevante;
- mantener operación del POS aunque se corte Internet.

## Principio de producto

**Automatización primero; intervención humana por excepción.**

No introducir tareas manuales recurrentes si no generan valor claro. Se descartaron como flujo normal:

- conteos físicos periódicos obligatorios;
- stock central duplicado del negocio del dueño;
- controles “policiales” permanentes;
- dependencia del historial de chats para entender el sistema.

## Fuente de verdad

Hay dos dimensiones distintas:

- **Estado técnico actual:** código, esquema, migraciones y tests del repositorio.
- **Comportamiento objetivo:** `PRODUCT.md`, `DOMAIN_RULES.md` y `DECISIONS.md`.

Las conversaciones anteriores son sólo contexto auxiliar. Si implementación y decisión vigente se contradicen, registrar la diferencia en `CURRENT_STATE.md`; no cambiar la decisión para acomodar el código ni afirmar que el código ya cumple el objetivo.

## Estado general

El repositorio tiene implementados POS offline-first, ventas, stock, administración comercial, reposición, rendiciones, rentabilidad y control horario. La auditoría técnica de migración documental se cerró el 14 de septiembre de 2026.

Las diferencias entre decisiones vigentes e implementación se registran explícitamente en `CURRENT_STATE.md`; no deben resolverse reinterpretando las reglas de producto.
