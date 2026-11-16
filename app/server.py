"""HTTP API + Server-Sent Events (spec-00 §8). Stdlib only."""
import argparse
import json
import queue
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .core import DomainError, Stock
from .db import connect
from .seed import seed

STATIC = Path(__file__).parent / "static"
TICK_SEG = 60
MAX_BODY = 1_000_000


def now():
    return datetime.now().replace(microsecond=0)


class Bus:
    """Fan-out of domain events to SSE subscribers, per branch."""

    def __init__(self):
        self.subs = {}
        self.lock = threading.Lock()

    def subscribe(self, s):
        q = queue.Queue(maxsize=1000)
        with self.lock:
            self.subs.setdefault(s, set()).add(q)
        return q

    def unsubscribe(self, s, q):
        with self.lock:
            self.subs.get(s, set()).discard(q)

    def publish(self, eventos):
        with self.lock:
            for e in eventos:
                for q in self.subs.get(e["sucursal_id"], ()):
                    try:
                        q.put_nowait(e)
                    except queue.Full:
                        pass  # slow client: it reloads state on reconnect


ROUTES = []


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn))
        return fn
    return deco


class Handler(BaseHTTPRequestHandler):
    stock: Stock = None
    bus: Bus = None
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, status, payload, ctype="application/json; charset=utf-8"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise DomainError("body demasiado grande")
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise DomainError("JSON inválido")
        if not isinstance(data, dict):
            raise DomainError("se esperaba un objeto JSON")
        return data

    def _dispatch(self, method):
        url = urlparse(self.path)
        for m, rx, fn in ROUTES:
            match = rx.match(url.path)
            if m == method and match:
                try:
                    return fn(self, *match.groups(), query=parse_qs(url.query))
                except DomainError as e:
                    return self._send(e.status, {"error": str(e)})
        if method == "GET":
            return self._static(url.path)
        self._send(404, {"error": "ruta inexistente"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def _static(self, path):
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (STATIC / name).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self._send(404, {"error": "no encontrado"})
        ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}.get(f.suffix, "application/octet-stream")
        self._send(200, f.read_bytes(), f"{ctype}; charset=utf-8")


@route("GET", r"/sucursales")
def listar_sucursales(h, query):
    with h.stock.lock:
        h._send(200, [r[0] for r in h.stock.q("SELECT DISTINCT sucursal_id FROM gondola_item ORDER BY 1")])


@route("POST", r"/sucursales/([\w-]+)/conteos")
def post_conteo(h, s, query):
    res, ev = h.stock.registrar_conteo(s, h._body(), now())
    h.bus.publish(ev)
    h._send(201 if res["aplicado"] else 200, res)


@route("POST", r"/ventas")
def post_venta(h, query):
    status, res, ev = h.stock.registrar_venta(h._body(), now())
    h.bus.publish(ev)
    h._send(status, res)


@route("GET", r"/sucursales/([\w-]+)/productos")
def get_productos(h, s, query):
    with h.stock.lock:
        data = h.stock.productos(s, now())
    h._send(200, data)


@route("GET", r"/sucursales/([\w-]+)/reposicion")
def get_reposicion(h, s, query):
    with h.stock.lock:
        data = h.stock.reposicion(s, now())
    h._send(200, data)


@route("GET", r"/sucursales/([\w-]+)/alertas")
def get_alertas(h, s, query):
    with h.stock.lock:
        data = h.stock.alertas(s, (query.get("destinatario") or [None])[0])
    h._send(200, data)


@route("PATCH", r"/alertas/(\d+)")
def patch_alerta(h, alerta_id, query):
    res, ev = h.stock.descartar_alerta(int(alerta_id), h._body(), now())
    h.bus.publish(ev)
    h._send(200, res)


@route("GET", r"/sucursales/([\w-]+)/stream")
def stream(h, s, query):
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream")
    h.send_header("Cache-Control", "no-store")
    h.send_header("Connection", "close")
    h.end_headers()
    h.close_connection = True
    q = h.bus.subscribe(s)
    try:
        h.wfile.write(b": conectado\n\n")
        h.wfile.flush()
        while True:
            try:
                e = q.get(timeout=15)
                msg = f"event: {e['type']}\ndata: {json.dumps(e['data'], ensure_ascii=False)}\n\n"
            except queue.Empty:
                msg = ": keepalive\n\n"
            h.wfile.write(msg.encode())
            h.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        h.bus.unsubscribe(s, q)


def make_server(db_path, port, host="0.0.0.0", tick=True):
    stock = Stock(connect(db_path))
    bus = Bus()
    handler = type("H", (Handler,), {"stock": stock, "bus": bus})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    if tick:
        def loop():
            stop = threading.Event()
            while not stop.wait(TICK_SEG):
                bus.publish(stock.tick(now()))
        threading.Thread(target=loop, daemon=True).start()
    return srv, stock, bus


def main():
    ap = argparse.ArgumentParser(description="Stocky: stock en góndola y alertas de reposición")
    ap.add_argument("--db", default="stocky.db")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--seed", action="store_true", help="cargar datos de la demo")
    ap.add_argument("--historial", action="store_true", help="con --seed: 4 semanas de ventas sintéticas")
    args = ap.parse_args()
    srv, stock, _ = make_server(args.db, args.port)
    if args.seed:
        seed(stock.conn, now(), historial=args.historial)
    print(f"Stocky en http://localhost:{args.port}  (repositor: /repositor.html · encargado: /encargado.html)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
