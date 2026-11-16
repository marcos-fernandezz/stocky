# Stocky · stock en góndola y alertas de reposición

MVP del Equipo 2 para el Desafío 02 del Hackatón Retail Chain 4.0 (caso Red Faro).
Especificación: [`specs/spec-00-reposicion-gondola.md`](specs/spec-00-reposicion-gondola.md).

El repositor informa cuántas unidades dejó en la góndola; cada comprobante de caja las descuenta en tiempo real;
cuando un producto llega a su umbral (calculado por producto y franja horaria), el repositor recibe un aviso urgente.

## Requisitos

Python 3.11+ — **sin dependencias** (solo biblioteca estándar).

## Correr la demo

```bash
python3 -m app.server --seed --historial          # http://localhost:8000
python3 -m app.simulate --sucursal S1 --cada 2    # opcional: caja simulada desde la terminal
```

| Pantalla | URL | Para |
|---|---|---|
| Repositor | `/repositor.html` | Lista de reposición en vivo, conteos, avisos (abrir en el celular, misma red) |
| Encargado | `/encargado.html` | Estado de la sucursal, alertas sin depósito, simulador de caja (botones −1/−3 y venta automática) |

`--seed` carga los datos del pizarrón (S1: Leche, Arroz, Agua, Carne · S2: Leche).
`--historial` agrega 4 semanas de ventas sintéticas para que el umbral varíe por franja horaria (pico 18–20 h).

### Guion de demo (spec-00 §12)
1. Repositor: **Contar** Leche → 12.
2. Encargado: −1 nueve veces → la leche queda "3 de 12", llega el aviso **ALTA**.
3. −1 tres veces más → "0 de 12", el aviso escala a **URGENTE**.
4. Repositor: **Repuse** → 12. La alerta se cierra y el nivel vuelve a 100%.

## API

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/sucursales/{s}/conteos` | `{producto_id, unidades, repositor_id, tipo?, created_at?, confirmar_capacidad?}` |
| `POST` | `/ventas` | `{comprobante_id, sucursal_id, emitido_at, tipo?: VENTA\|ANULACION, comprobante_ref?, lineas:[{linea, producto_id, cantidad}]}` |
| `GET` | `/sucursales/{s}/productos` | Estado, nivel, umbral, depósito y alertas por producto |
| `GET` | `/sucursales/{s}/reposicion` | Lista priorizada + minutos totales |
| `GET` | `/sucursales/{s}/alertas?destinatario=` | Alertas abiertas |
| `GET` | `/sucursales/{s}/stream` | SSE: `producto.actualizado`, `alerta.creada`, `alerta.cerrada` |
| `PATCH` | `/alertas/{id}` | Descartar con `{motivo}` |

## Tests

```bash
python3 -m unittest
```

## Estructura

```
app/core.py      dominio: conteos, ventas atómicas, umbral, estados y alertas
app/db.py        esquema SQLite
app/server.py    API HTTP + SSE + re-evaluación periódica (cada 60 s)
app/seed.py      datos de la demo
app/simulate.py  simulador de caja
app/static/      pantallas del repositor y del encargado
```

## Límites del MVP

- Sin autenticación: el repositor se identifica con su nombre.
- El aviso es una notificación del navegador (la pantalla del repositor debe estar abierta); push nativo (FCM) queda para producción.
- En producción, la caja de Red Faro debe enviar cada comprobante al emitirlo (hoy consolida a medianoche).
