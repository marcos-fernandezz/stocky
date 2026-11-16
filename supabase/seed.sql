-- Demo data from the team whiteboard (spec-00 §12). Safe to run more than once.
insert into producto (id, nombre, precio) values
  ('ID-1', 'Leche 1 L', 1200),
  ('ID-2', 'Arroz 1 kg', 1500),
  ('ID-3', 'Agua 1,5 L', 900),
  ('ID-4', 'Carne picada 1 kg', 7000)
on conflict (id) do update set nombre = excluded.nombre, precio = excluded.precio;

insert into stock_general (sucursal_id, producto_id, unidades) values
  ('S1', 'ID-1', 30), ('S1', 'ID-2', 20), ('S1', 'ID-3', 25), ('S1', 'ID-4', 40), ('S2', 'ID-1', 15)
on conflict (sucursal_id, producto_id) do update set unidades = excluded.unidades;

insert into gondola_item (sucursal_id, producto_id, capacidad, tiempo_reposicion_min) values
  ('S1', 'ID-1', 12, 6), ('S1', 'ID-2', 15, 8), ('S1', 'ID-3', 20, 6), ('S1', 'ID-4', 10, 5), ('S2', 'ID-1', 12, 6)
on conflict do nothing;
