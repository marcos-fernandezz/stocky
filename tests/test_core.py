import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.core import ConflictError, DomainError, Stock, iso
from app.db import connect
from app.seed import seed

T0 = datetime(2026, 11, 16, 10, 0, 0)


class Base(unittest.TestCase):
    def setUp(self):
        self.st = Stock(connect(":memory:"))
        seed(self.st.conn)
        self.n = 0

    def tearDown(self):
        self.st.conn.close()

    def contar(self, s, p, unidades, t=T0, **extra):
        return self.st.registrar_conteo(s, {"producto_id": p, "unidades": unidades, "repositor_id": "ana", **extra}, t)

    def vender(self, s, lineas, t, cid=None, **extra):
        self.n += 1
        cid = cid or f"C{self.n}"
        body = {"comprobante_id": cid, "sucursal_id": s, "emitido_at": iso(t),
                "lineas": [{"linea": i, "producto_id": p, "cantidad": c} for i, (p, c) in enumerate(lineas, 1)], **extra}
        return self.st.registrar_venta(body, t)

    def snap(self, s, p, t=T0):
        return self.st.snapshot(s, p, t)

    def abiertas(self, s, p):
        return {a["tipo"]: a for a in self.st.alertas(s) if a["producto_id"] == p}


class AceptacionDemo(Base):
    """spec-00 §12, in order."""

    def test_ciclo_completo_leche_s1(self):
        # 1. count 12 -> 12 of 12 (100%)
        self.contar("S1", "ID-1", 12)
        s = self.snap("S1", "ID-1")
        self.assertEqual((s["stock_gondola"], s["conteo_informado"], s["nivel"], s["estado"]), (12, 12, 100, "OK"))
        self.assertEqual(s["umbral"], 3)  # no history: max(2, ceil(12 * 0.25))

        # 2. nine sales of 1 -> 3 of 12, BAJO, REPONER ALTA notified once
        creadas = []
        for i in range(9):
            _, _, ev = self.vender("S1", [("ID-1", 1)], T0 + timedelta(minutes=i + 1))
            creadas += [e for e in ev if e["type"] == "alerta.creada"]
        s = self.snap("S1", "ID-1", T0 + timedelta(minutes=10))
        self.assertEqual((s["stock_gondola"], s["nivel"], s["estado"]), (3, 25, "BAJO"))
        self.assertEqual(len(creadas), 1)
        self.assertEqual((creadas[0]["data"]["tipo"], creadas[0]["data"]["prioridad"]), ("REPONER", "ALTA"))
        self.assertEqual(creadas[0]["data"]["unidades_sugeridas"], 9)  # min(12 - 3, deposito 18)

        # 3. three more -> 0 of 12, escalates to URGENTE and notifies again
        ev_total = []
        for i in range(3):
            _, _, ev = self.vender("S1", [("ID-1", 1)], T0 + timedelta(minutes=20 + i))
            ev_total += ev
        escaladas = [e for e in ev_total if e["type"] == "alerta.creada"]
        self.assertEqual(len(escaladas), 1)
        self.assertTrue(escaladas[0]["data"]["escalada"])
        self.assertEqual(self.abiertas("S1", "ID-1")["REPONER"]["prioridad"], "URGENTE")
        self.assertEqual(self.snap("S1", "ID-1", T0 + timedelta(minutes=23))["estado"], "VACIO")

        # 4. recount 12 -> alert closed by the repositor, 100%, diferencia +12
        t4 = T0 + timedelta(minutes=30)
        res, ev = self.contar("S1", "ID-1", 12, t4)
        self.assertEqual((res["esperado"], res["diferencia"]), (0, 12))
        self.assertEqual(self.abiertas("S1", "ID-1"), {})
        cerrada = self.st.q1("SELECT * FROM alerta WHERE tipo = 'REPONER'")
        self.assertEqual((cerrada["estado"], cerrada["atendida_por"]), ("ATENDIDA", "ana"))
        self.assertEqual(self.snap("S1", "ID-1", t4)["nivel"], 100)
        # the empty-shelf period was recorded and closed
        periodo = self.st.q1("SELECT * FROM vacio_periodo")
        self.assertEqual((periodo["desde"], periodo["hasta"]), (iso(T0 + timedelta(minutes=22)), iso(t4)))

    def test_5_venta_reenviada_no_descuenta_dos_veces(self):
        self.contar("S1", "ID-1", 12)
        st1, _, _ = self.vender("S1", [("ID-1", 2)], T0 + timedelta(minutes=1), cid="X1")
        st2, res, ev = self.vender("S1", [("ID-1", 2)], T0 + timedelta(minutes=1), cid="X1")
        self.assertEqual((st1, st2, res["duplicado"], ev), (201, 200, True, []))
        self.assertEqual(self.snap("S1", "ID-1", T0 + timedelta(minutes=2))["stock_gondola"], 10)

    def test_6_fallo_a_mitad_de_venta_no_cambia_nada_y_reintento_aplica_una_vez(self):
        self.contar("S1", "ID-1", 12)
        self.contar("S1", "ID-2", 15)
        t = T0 + timedelta(minutes=1)
        real = Stock._insert_linea

        def falla_en_arroz(self_, cid, linea):
            if linea["producto_id"] == "ID-2":
                raise RuntimeError("fallo simulado")
            return real(self_, cid, linea)

        with mock.patch.object(Stock, "_insert_linea", falla_en_arroz):
            with self.assertRaises(RuntimeError):
                self.vender("S1", [("ID-1", 1), ("ID-2", 1)], t, cid="X2")
        self.assertEqual(self.snap("S1", "ID-1", t)["stock_gondola"], 12)
        self.assertIsNone(self.st.q1("SELECT * FROM venta WHERE comprobante_id = 'X2'"))

        status, _, _ = self.vender("S1", [("ID-1", 1), ("ID-2", 1)], t, cid="X2")
        self.vender("S1", [("ID-1", 1), ("ID-2", 1)], t, cid="X2")
        self.assertEqual(status, 201)
        self.assertEqual(self.snap("S1", "ID-1", t)["stock_gondola"], 11)
        self.assertEqual(self.snap("S1", "ID-2", t)["stock_gondola"], 14)

    def test_7_anulacion_devuelve_unidades(self):
        self.contar("S1", "ID-1", 12)
        t = T0 + timedelta(minutes=1)
        self.vender("S1", [("ID-1", 2)], t, cid="V1")
        self.assertEqual(self.snap("S1", "ID-1", t)["stock_gondola"], 10)
        status, _, _ = self.st.registrar_venta(
            {"comprobante_id": "A1", "sucursal_id": "S1", "tipo": "ANULACION", "comprobante_ref": "V1",
             "emitido_at": iso(t + timedelta(minutes=1))}, t + timedelta(minutes=1))
        self.assertEqual(status, 201)
        self.assertEqual(self.snap("S1", "ID-1", t + timedelta(minutes=1))["stock_gondola"], 12)

    def test_8_s2_sin_deposito_alerta_al_encargado(self):
        # 12 sold before anyone counted, then the repositor counts 3: deposit = 15 - 12 - 3 = 0
        for i in range(12):
            self.vender("S2", [("ID-1", 1)], T0 + timedelta(minutes=i))
        self.contar("S2", "ID-1", 3, T0 + timedelta(minutes=30))
        s = self.snap("S2", "ID-1", T0 + timedelta(minutes=30))
        self.assertEqual((s["deposito"], s["stock_gondola"], s["estado"]), (0, 3, "SIN_DEPOSITO"))
        a = self.abiertas("S2", "ID-1")
        self.assertIn("SIN_DEPOSITO", a)
        self.assertEqual(a["SIN_DEPOSITO"]["destinatario"], "ENCARGADO")
        self.assertNotIn("REPONER", a)
        self.assertEqual(self.st.reposicion("S2", T0 + timedelta(minutes=30))["items"], [])

    def test_9_venta_sin_conteo_pide_recontar(self):
        self.vender("S1", [("ID-4", 1)], T0)
        self.assertEqual(self.snap("S1", "ID-4")["estado"], "SIN_CONTEO")
        self.assertEqual(self.abiertas("S1", "ID-4")["RECONTAR"]["prioridad"], "BAJA")


class Conteo(Base):
    def test_supera_capacidad_pide_confirmacion(self):
        with self.assertRaises(ConflictError):
            self.contar("S1", "ID-1", 13)
        res, _ = self.contar("S1", "ID-1", 13, confirmar_capacidad=True)
        self.assertTrue(res["aplicado"])

    def test_rechaza_negativo_y_no_numerico(self):
        for malo in (-1, "5", 2.5, True, None):
            with self.assertRaises(DomainError):
                self.contar("S1", "ID-1", malo)

    def test_conteo_offline_viejo_no_pisa_al_nuevo(self):
        self.contar("S1", "ID-1", 10, T0)
        res, _ = self.contar("S1", "ID-1", 4, T0 + timedelta(minutes=5),
                             created_at=iso(T0 - timedelta(minutes=5)))
        self.assertFalse(res["aplicado"])
        self.assertEqual(self.snap("S1", "ID-1", T0 + timedelta(minutes=5))["stock_gondola"], 10)
        self.assertEqual(self.st.q1("SELECT COUNT(*) FROM conteo")[0], 2)

    def test_conteo_cierra_verificar_y_recontar(self):
        self.vender("S1", [("ID-1", 1)], T0)  # no count -> RECONTAR
        self.contar("S1", "ID-1", 1, T0 + timedelta(minutes=1))
        self.vender("S1", [("ID-1", 3)], T0 + timedelta(minutes=2))  # sold more than counted -> VERIFICAR
        self.assertIn("VERIFICAR", self.abiertas("S1", "ID-1"))
        self.contar("S1", "ID-1", 8, T0 + timedelta(minutes=3))
        self.assertEqual(set(self.abiertas("S1", "ID-1")), set())


class Ventas(Base):
    def test_venta_anterior_al_conteo_no_descuenta(self):
        self.contar("S1", "ID-1", 12, T0)
        self.vender("S1", [("ID-1", 2)], T0 - timedelta(minutes=5))  # arrives late
        self.assertEqual(self.snap("S1", "ID-1")["stock_gondola"], 12)

    def test_venta_mayor_al_conteo_queda_en_cero_con_desvio(self):
        self.contar("S1", "ID-1", 2)
        status, _, _ = self.vender("S1", [("ID-1", 5)], T0 + timedelta(minutes=1))
        s = self.snap("S1", "ID-1", T0 + timedelta(minutes=1))
        self.assertEqual((status, s["stock_gondola"], s["desvio"]), (201, 0, 3))
        self.assertIn("VERIFICAR", self.abiertas("S1", "ID-1"))

    def test_lineas_repetidas_se_suman(self):
        self.contar("S1", "ID-1", 12)
        self.vender("S1", [("ID-1", 1), ("ID-1", 2)], T0 + timedelta(minutes=1))
        self.assertEqual(self.snap("S1", "ID-1", T0 + timedelta(minutes=1))["stock_gondola"], 9)

    def test_producto_desconocido_no_rechaza_la_venta(self):
        self.contar("S1", "ID-1", 12)
        status, _, _ = self.vender("S1", [("ID-1", 1), ("ZZZ", 1)], T0 + timedelta(minutes=1))
        self.assertEqual(status, 201)
        self.assertEqual(self.snap("S1", "ZZZ", T0 + timedelta(minutes=1))["estado"], "SIN_CONTEO")
        self.assertEqual(self.snap("S1", "ID-1", T0 + timedelta(minutes=1))["stock_gondola"], 11)

    def test_validaciones(self):
        casos = [
            {"comprobante_id": "B1", "sucursal_id": "S1", "emitido_at": iso(T0), "lineas": []},
            {"comprobante_id": "B2", "sucursal_id": "S1", "emitido_at": iso(T0),
             "lineas": [{"linea": 1, "producto_id": "ID-1", "cantidad": 0}]},
            {"comprobante_id": "B3", "sucursal_id": "S1", "emitido_at": "ayer",
             "lineas": [{"linea": 1, "producto_id": "ID-1", "cantidad": 1}]},
            {"comprobante_id": "B4", "sucursal_id": "S1", "tipo": "ANULACION", "comprobante_ref": "NOPE",
             "emitido_at": iso(T0)},
        ]
        for body in casos:
            with self.subTest(body=body["comprobante_id"]), self.assertRaises(DomainError):
                self.st.registrar_venta(body, T0)
        self.assertEqual(self.st.q1("SELECT COUNT(*) FROM venta")[0], 0)

    def test_anular_dos_veces_rechaza(self):
        self.vender("S1", [("ID-1", 1)], T0, cid="V1")
        anul = {"sucursal_id": "S1", "tipo": "ANULACION", "comprobante_ref": "V1", "emitido_at": iso(T0)}
        self.st.registrar_venta({"comprobante_id": "A1", **anul}, T0)
        with self.assertRaises(DomainError):
            self.st.registrar_venta({"comprobante_id": "A2", **anul}, T0)


class Umbral(Base):
    def test_umbral_con_historial_y_horas_vacias_excluidas(self):
        now = datetime(2026, 11, 16, 18, 30)
        # 4 previous Mondays at 18 h: 4, 4, 4 units and one hour with an empty shelf (0 units)
        for k, unidades in enumerate([4, 4, 4, 0], 1):
            t = now.replace(minute=10) - timedelta(weeks=k)
            for i in range(unidades):
                self.vender("S1", [("ID-1", 1)], t + timedelta(minutes=i))
        t_vacio = now.replace(minute=0) - timedelta(weeks=4)
        self.st.conn.execute("INSERT INTO vacio_periodo VALUES ('S1', 'ID-1', ?, ?)",
                             (iso(t_vacio), iso(t_vacio + timedelta(hours=1))))
        self.assertEqual(self.st.venta_hora_franja("S1", "ID-1", now), 4.0)  # censored hour skipped
        self.contar("S1", "ID-1", 12, now)
        # 4.0 * (0.5 h + 6/60 h) + 1 = 3.4 -> 4
        self.assertEqual(self.snap("S1", "ID-1", now)["umbral"], 4)

    def test_silencio_improbable_pide_verificar(self):
        now = datetime(2026, 11, 16, 18, 0)
        for k in range(1, 5):
            t = now - timedelta(weeks=k)
            for i in range(4):
                self.vender("S1", [("ID-1", 1)], t + timedelta(minutes=10 * i))
        self.contar("S1", "ID-1", 12, now)
        self.st.tick(now + timedelta(minutes=30))   # e^(-4 * 0.5) = 0.13: still plausible
        self.assertNotIn("VERIFICAR", self.abiertas("S1", "ID-1"))
        self.st.tick(now + timedelta(minutes=50))   # e^(-4 * 0.83) = 0.036 < 0.05
        self.assertIn("VERIFICAR", self.abiertas("S1", "ID-1"))

    def test_conteo_vencido_pide_recontar(self):
        self.contar("S1", "ID-1", 12)
        self.st.tick(T0 + timedelta(hours=25))
        self.assertIn("RECONTAR", self.abiertas("S1", "ID-1"))


class Reposicion(Base):
    def test_lista_priorizada_y_minutos(self):
        t = T0 + timedelta(minutes=5)
        self.contar("S1", "ID-4", 1)   # carne, will go empty -> URGENTE
        self.contar("S1", "ID-3", 3)   # agua, below threshold 5 -> ALTA
        self.contar("S1", "ID-1", 12)  # leche OK
        self.vender("S1", [("ID-4", 1)], t)
        lista = self.st.reposicion("S1", t)
        self.assertEqual([(i["producto_id"], i["prioridad"]) for i in lista["items"]],
                         [("ID-4", "URGENTE"), ("ID-3", "ALTA")])
        self.assertEqual(lista["total_minutos"], 5 + 6)
        self.assertEqual({i["estado"] for i in lista["items"]}, {"ABIERTA"})  # alert state, not product state


if __name__ == "__main__":
    unittest.main()
