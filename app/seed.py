"""Demo data from the team whiteboard (spec-00 §12)."""
import random
from datetime import timedelta

from .core import iso

PRODUCTOS = [  # id, nombre, precio
    ("ID-1", "Leche 1 L", 1200),
    ("ID-2", "Arroz 1 kg", 1500),
    ("ID-3", "Agua 1,5 L", 900),
    ("ID-4", "Carne picada 1 kg", 7000),
]
GONDOLA = [  # sucursal, producto, capacidad, minutos de reposición
    ("S1", "ID-1", 12, 6),
    ("S1", "ID-2", 15, 8),
    ("S1", "ID-3", 20, 6),
    ("S1", "ID-4", 10, 5),
    ("S2", "ID-1", 12, 6),
]
STOCK_GENERAL = [("S1", "ID-1", 30), ("S1", "ID-2", 20), ("S1", "ID-3", 25), ("S1", "ID-4", 40), ("S2", "ID-1", 15)]
VENTA_HORA = {"ID-1": 2.0, "ID-2": 1.0, "ID-3": 1.5, "ID-4": 0.5}  # average for synthetic history


def seed(conn, now=None, historial=False):
    conn.executemany("INSERT OR REPLACE INTO producto VALUES (?, ?, ?)", PRODUCTOS)
    conn.executemany("INSERT OR REPLACE INTO stock_general VALUES (?, ?, ?)", STOCK_GENERAL)
    conn.executemany(
        "INSERT OR IGNORE INTO gondola_item (sucursal_id, producto_id, capacidad, tiempo_reposicion_min) VALUES (?, ?, ?, ?)",
        GONDOLA)
    if historial:
        _historial(conn, now)


def _historial(conn, now):
    """4 weeks of synthetic sales, 08-20 h, peak at 18-20 h, so thresholds vary by hour slot."""
    rnd = random.Random(42)
    n = 0
    dia0 = now.replace(hour=0, minute=0, second=0) - timedelta(weeks=4)
    for d in range(28):
        for h in range(8, 20):
            pico = 2.0 if h >= 18 else 1.0
            for s, p, *_ in GONDOLA:
                unidades = sum(rnd.random() < VENTA_HORA[p] * pico / 4 for _ in range(4))
                for _ in range(unidades):
                    n += 1
                    t = dia0 + timedelta(days=d, hours=h, minutes=rnd.randrange(60))
                    cid = f"H-{n:06d}"
                    conn.execute("INSERT OR IGNORE INTO venta VALUES (?, ?, 'VENTA', NULL, NULL, ?, ?)",
                                 (cid, s, iso(t), iso(t)))
                    conn.execute("INSERT OR IGNORE INTO venta_linea VALUES (?, 1, ?, 1)", (cid, p))
