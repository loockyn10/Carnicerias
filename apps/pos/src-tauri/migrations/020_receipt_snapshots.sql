-- 020: snapshot LOCAL del nombre del operador y de la sucursal de cada venta, para que un ticket
-- reimpreso diga siempre lo mismo aunque después se renombre al empleado o a la sucursal.
-- Sólo columnas nulas (ADD COLUMN, sin reconstruir tablas): las ventas anteriores quedan en NULL y
-- su ticket usa, como respaldo, el nombre que tiene hoy el operador/dispositivo. No viaja en el
-- payload del outbox ni al servidor: es sólo para imprimir desde esta caja.
alter table local_sales add column operator_name_snapshot text;
alter table local_sales add column branch_name_snapshot text;
