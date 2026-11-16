import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS producto (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL DEFAULT 0
);

-- Read-only mirror of Red Faro's central system (updated nightly).
CREATE TABLE IF NOT EXISTS stock_general (
    sucursal_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    unidades INTEGER NOT NULL,
    PRIMARY KEY (sucursal_id, producto_id)
);

CREATE TABLE IF NOT EXISTS gondola_item (
    sucursal_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    capacidad INTEGER CHECK (capacidad IS NULL OR capacidad > 0),
    minimo_exhibicion INTEGER NOT NULL DEFAULT 2,
    tiempo_reposicion_min INTEGER NOT NULL DEFAULT 6,
    conteo_informado INTEGER,
    conteo_at TEXT,
    conteo_por TEXT,
    estado TEXT NOT NULL DEFAULT 'SIN_CONTEO',
    PRIMARY KEY (sucursal_id, producto_id)
);

CREATE TABLE IF NOT EXISTS conteo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    repositor_id TEXT NOT NULL,
    unidades INTEGER NOT NULL,
    esperado INTEGER,
    diferencia INTEGER,
    tipo TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venta (
    comprobante_id TEXT PRIMARY KEY,
    sucursal_id TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('VENTA', 'ANULACION')),
    comprobante_ref TEXT,
    anulada_por TEXT,
    emitido_at TEXT NOT NULL,
    procesada_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venta_linea (
    comprobante_id TEXT NOT NULL REFERENCES venta(comprobante_id),
    linea INTEGER NOT NULL,
    producto_id TEXT NOT NULL,
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    PRIMARY KEY (comprobante_id, linea)
);
CREATE INDEX IF NOT EXISTS ix_linea_producto ON venta_linea (producto_id);
CREATE INDEX IF NOT EXISTS ix_venta_sucursal ON venta (sucursal_id, emitido_at);

CREATE TABLE IF NOT EXISTS alerta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    prioridad TEXT NOT NULL,
    destinatario TEXT NOT NULL,
    unidades_sugeridas INTEGER,
    creada_at TEXT NOT NULL,
    atendida_at TEXT,
    atendida_por TEXT,
    motivo TEXT,
    estado TEXT NOT NULL DEFAULT 'ABIERTA'
);
-- At most one open alert per type and product.
CREATE UNIQUE INDEX IF NOT EXISTS ux_alerta_abierta
    ON alerta (sucursal_id, producto_id, tipo) WHERE estado = 'ABIERTA';

-- Periods with an empty shelf: excluded from demand estimation.
CREATE TABLE IF NOT EXISTS vacio_periodo (
    sucursal_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    desde TEXT NOT NULL,
    hasta TEXT
);
"""


def connect(path):
    # isolation_level=None: transactions are managed explicitly with BEGIN IMMEDIATE.
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn
