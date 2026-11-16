import json
import threading
import unittest
from datetime import datetime
from http.client import HTTPConnection

from app.core import iso
from app.seed import seed
from app.server import make_server


class Api(unittest.TestCase):
    def setUp(self):
        self.srv, self.stock, _ = make_server(":memory:", 0, host="127.0.0.1", tick=False)
        seed(self.stock.conn)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.stock.conn.close()

    def call(self, method, path, body=None):
        c = HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=json.dumps(body) if body is not None else None,
                  headers={"Content-Type": "application/json"})
        r = c.getresponse()
        data = json.loads(r.read() or b"null")
        c.close()
        return r.status, data

    def venta(self, cid, cantidad=1):
        return self.call("POST", "/ventas", {
            "comprobante_id": cid, "sucursal_id": "S1", "emitido_at": iso(datetime.now()),
            "lineas": [{"linea": 1, "producto_id": "ID-1", "cantidad": cantidad}]})

    def test_conteo_venta_y_estado(self):
        self.assertEqual(self.call("POST", "/sucursales/S1/conteos",
                                   {"producto_id": "ID-1", "unidades": 12, "repositor_id": "ana"})[0], 201)
        self.assertEqual(self.venta("C1", 10)[0], 201)
        st, dup = self.venta("C1", 10)
        self.assertEqual((st, dup["duplicado"]), (200, True))
        _, productos = self.call("GET", "/sucursales/S1/productos")
        leche = next(p for p in productos if p["producto_id"] == "ID-1")
        self.assertEqual((leche["stock_gondola"], leche["nivel"], leche["estado"]), (2, 17, "BAJO"))
        _, lista = self.call("GET", "/sucursales/S1/reposicion")
        self.assertEqual([(i["producto_id"], i["tipo"]) for i in lista["items"]][0], ("ID-1", "REPONER"))

    def test_errores(self):
        st, err = self.call("POST", "/sucursales/S1/conteos", {"producto_id": "ID-1", "unidades": 99, "repositor_id": "a"})
        self.assertEqual(st, 409)
        self.assertIn("capacidad de 12", err["error"])
        self.assertEqual(self.call("POST", "/ventas", {"comprobante_id": "X"})[0], 422)
        self.assertEqual(self.call("PATCH", "/alertas/999", {"motivo": "x"})[0], 404)
        self.assertEqual(self.call("GET", "/../app/core.py")[0], 404)

    def test_descartar_alerta(self):
        self.venta("C1")  # no count -> RECONTAR
        _, alertas = self.call("GET", "/sucursales/S1/alertas")
        aid = alertas[0]["id"]
        self.assertEqual(self.call("PATCH", f"/alertas/{aid}", {})[0], 422)  # reason required
        self.assertEqual(self.call("PATCH", f"/alertas/{aid}", {"motivo": "producto discontinuado"})[0], 200)
        self.assertEqual(self.call("PATCH", f"/alertas/{aid}", {"motivo": "otra vez"})[0], 409)

    def test_stream_recibe_alerta(self):
        c = HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/sucursales/S1/stream")
        r = c.getresponse()
        self.assertEqual(r.headers["Content-Type"], "text/event-stream")
        r.readline(), r.readline()  # ": conectado" + blank line
        self.venta("C1")
        lineas = [r.readline().decode().strip() for _ in range(6)]
        c.close()
        self.assertIn("event: producto.actualizado", lineas)
        self.assertIn("event: alerta.creada", lineas)


if __name__ == "__main__":
    unittest.main()
