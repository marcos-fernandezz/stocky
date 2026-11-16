-- Stocky schema (spec-00 §5). Run once in Supabase → SQL Editor, or `supabase db push`.
-- Timestamps are naive business-time ISO strings 'YYYY-MM-DDTHH:MM:SS' (America/Argentina/Buenos_Aires):
-- they sort lexicographically and the hour-slot logic needs local time, not UTC.

create table if not exists producto (
  id text primary key,
  nombre text not null,
  precio numeric not null default 0
);

-- Read-only mirror of Red Faro's central system (updated nightly).
create table if not exists stock_general (
  sucursal_id text not null,
  producto_id text not null,
  unidades integer not null,
  primary key (sucursal_id, producto_id)
);

create table if not exists gondola_item (
  sucursal_id text not null,
  producto_id text not null,
  capacidad integer check (capacidad is null or capacidad > 0),
  minimo_exhibicion integer not null default 2,
  tiempo_reposicion_min integer not null default 6,
  conteo_informado integer,
  conteo_at text,
  conteo_por text,
  estado text not null default 'SIN_CONTEO',
  primary key (sucursal_id, producto_id)
);

create table if not exists conteo (
  id integer generated always as identity primary key,
  sucursal_id text not null,
  producto_id text not null,
  repositor_id text not null,
  unidades integer not null,
  esperado integer,
  diferencia integer,
  tipo text not null,
  created_at text not null
);

create table if not exists venta (
  comprobante_id text primary key,
  sucursal_id text not null,
  tipo text not null check (tipo in ('VENTA', 'ANULACION')),
  comprobante_ref text,
  anulada_por text,
  emitido_at text not null,
  procesada_at text not null
);

create table if not exists venta_linea (
  comprobante_id text not null references venta (comprobante_id),
  linea integer not null,
  producto_id text not null,
  cantidad integer not null check (cantidad > 0),
  primary key (comprobante_id, linea)
);
create index if not exists ix_linea_producto on venta_linea (producto_id);
create index if not exists ix_venta_sucursal on venta (sucursal_id, emitido_at);

create table if not exists alerta (
  id integer generated always as identity primary key,
  sucursal_id text not null,
  producto_id text not null,
  tipo text not null,
  prioridad text not null,
  destinatario text not null,
  unidades_sugeridas integer,
  creada_at text not null,
  atendida_at text,
  atendida_por text,
  motivo text,
  estado text not null default 'ABIERTA'
);
-- At most one open alert per type and product.
create unique index if not exists ux_alerta_abierta
  on alerta (sucursal_id, producto_id, tipo) where estado = 'ABIERTA';

-- Periods with an empty shelf: excluded from demand estimation.
create table if not exists vacio_periodo (
  sucursal_id text not null,
  producto_id text not null,
  desde text not null,
  hasta text
);

-- The app connects with the database role (DATABASE_URL), not through the Data API.
-- RLS on with no policies = the public anon key cannot read or write these tables.
alter table producto enable row level security;
alter table stock_general enable row level security;
alter table gondola_item enable row level security;
alter table conteo enable row level security;
alter table venta enable row level security;
alter table venta_linea enable row level security;
alter table alerta enable row level security;
alter table vacio_periodo enable row level security;
