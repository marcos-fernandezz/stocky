-- Optional: 4 weeks of synthetic sales (08-20 h, peak 18-20 h) so thresholds vary by hour slot.
-- Run after seed.sql. Re-running replaces the previous history.
delete from venta_linea where comprobante_id like 'H-%';
delete from venta where comprobante_id like 'H-%';

select setseed(0.42);

with base(producto_id, venta_hora) as (
  values ('ID-1', 2.0), ('ID-2', 1.0), ('ID-3', 1.5), ('ID-4', 0.5)
),
-- 4 draws per product/day/hour; each succeeds with p = rate * peak / 4.
slots as (
  select g.sucursal_id, g.producto_id, b.venta_hora,
         ((now() at time zone 'America/Argentina/Buenos_Aires')::date - 28 + d) + make_interval(hours => h) as hora,
         case when h >= 18 then 2.0 else 1.0 end as pico
  from gondola_item g
  join base b using (producto_id)
  cross join generate_series(0, 27) d
  cross join generate_series(8, 19) h
  cross join generate_series(1, 4) n
),
-- random() in the select list of a materialized CTE = one draw per row
-- (in a WHERE clause the planner may evaluate it once per hour slot).
sorteo as materialized (
  select s.*, random() as r, random() as m from slots s
),
unidades as materialized (
  select *, row_number() over () as rn from sorteo where r < venta_hora * pico / 4
),
ventas as (
  insert into venta (comprobante_id, sucursal_id, tipo, emitido_at, procesada_at)
  select 'H-' || lpad(rn::text, 7, '0'), sucursal_id, 'VENTA',
         to_char(hora + make_interval(mins => (m * 59)::int), 'YYYY-MM-DD"T"HH24:MI:SS'),
         to_char(hora, 'YYYY-MM-DD"T"HH24:MI:SS')
  from unidades
  returning comprobante_id
)
insert into venta_linea (comprobante_id, linea, producto_id, cantidad)
select 'H-' || lpad(rn::text, 7, '0'), 1, producto_id, 1 from unidades;
