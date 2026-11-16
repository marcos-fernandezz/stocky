-- Rounds per period (spec-01): no more estimated shelf stock or counts.
-- Each branch splits its business hours into `pasadas_por_dia` equal periods; the repositor walks the
-- shelves once per period. Run after 0001_init.sql.

create table if not exists sucursal (
  id text primary key,
  pasadas_por_dia integer not null default 3 check (pasadas_por_dia between 1 and 24),
  apertura integer not null default 8 check (apertura between 0 and 23),   -- hour the store opens
  cierre integer not null default 20 check (cierre between 1 and 24),      -- hour the store closes
  check (cierre > apertura)
);
insert into sucursal (id) select distinct sucursal_id from gondola_item on conflict do nothing;
alter table sucursal enable row level security;

-- The estimated shelf stock is gone: counts and their per-product state go with it.
drop table if exists conteo;
alter table gondola_item
  drop column if exists capacidad,
  drop column if exists minimo_exhibicion,
  drop column if exists tiempo_reposicion_min,
  drop column if exists conteo_informado,
  drop column if exists conteo_at,
  drop column if exists conteo_por,
  drop column if exists estado;

-- Count-era alerts no longer exist; RONDA alerts belong to the branch, not to a product.
delete from alerta where tipo in ('REPONER', 'SIN_DEPOSITO', 'RECONTAR', 'VERIFICAR');
alter table alerta alter column producto_id drop not null;
alter table alerta drop column if exists unidades_sugeridas;

-- vacio_periodo now holds the stock-outs (quiebres) the repositor reports; still excluded from the averages.
