-- Demo data from the team whiteboard. Run after the migrations. Safe to run more than once.
insert into producto (id, nombre, precio) values
  ('ID-1', 'Leche 1 L', 1200),
  ('ID-2', 'Arroz 1 kg', 1500),
  ('ID-3', 'Agua 1,5 L', 900),
  ('ID-4', 'Carne picada 1 kg', 7000)
on conflict (id) do update set nombre = excluded.nombre, precio = excluded.precio;

insert into stock_general (sucursal_id, producto_id, unidades) values
  ('S1', 'ID-1', 30), ('S1', 'ID-2', 20), ('S1', 'ID-3', 25), ('S1', 'ID-4', 40), ('S2', 'ID-1', 15)
on conflict (sucursal_id, producto_id) do update set unidades = excluded.unidades;

-- S1: 3 rounds a day 08-20 h (08-12, 12-16, 16-20). S2: 2 rounds (08-14, 14-20).
insert into sucursal (id, pasadas_por_dia, apertura, cierre) values ('S1', 3, 8, 20), ('S2', 2, 8, 20)
on conflict (id) do update set pasadas_por_dia = excluded.pasadas_por_dia, apertura = excluded.apertura, cierre = excluded.cierre;

insert into gondola_item (sucursal_id, producto_id) values
  ('S1', 'ID-1'), ('S1', 'ID-2'), ('S1', 'ID-3'), ('S1', 'ID-4'), ('S2', 'ID-1')
on conflict do nothing;
