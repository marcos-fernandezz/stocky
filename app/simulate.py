"""POS simulator: sends random receipts to POST /ventas (spec-00 §10)."""
import argparse
import json
import random
import time
import uuid
from datetime import datetime
from urllib.request import Request, urlopen

from .seed import GONDOLA, VENTA_HORA


def main():
    ap = argparse.ArgumentParser(description="Simulador de caja")
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--sucursal", default="S1")
    ap.add_argument("--cada", type=float, default=2.0, help="segundos entre comprobantes")
    ap.add_argument("--n", type=int, default=0, help="cantidad de comprobantes (0 = infinito)")
    args = ap.parse_args()

    productos = [p for s, p, *_ in GONDOLA if s == args.sucursal]
    pesos = [VENTA_HORA[p] for p in productos]
    enviados = 0
    while not args.n or enviados < args.n:
        elegidos = set(random.choices(productos, pesos, k=random.randint(1, 3)))
        body = {"comprobante_id": f"SIM-{uuid.uuid4().hex[:10]}", "sucursal_id": args.sucursal,
                "emitido_at": datetime.now().isoformat(timespec="seconds"),
                "lineas": [{"linea": i, "producto_id": p, "cantidad": 1} for i, p in enumerate(sorted(elegidos), 1)]}
        req = Request(f"{args.url}/ventas", json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urlopen(req) as r:
            print(r.status, body["comprobante_id"], ", ".join(sorted(elegidos)))
        enviados += 1
        time.sleep(args.cada)


if __name__ == "__main__":
    main()
