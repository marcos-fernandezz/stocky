# SPEC-01 · Rondas por período y alertas de venta anómala

**Proyecto:** Stocky · Equipo 2 · Hackatón Retail Chain 4.0 (caso Red Faro)
**Estado:** implementado en el MVP · **Fecha:** 2026-11-16 · **Reemplaza:** el modelo de stock estimado de la spec-00 (§1, §4-§7, §12)

---

## 1. Por qué cambia

El advisor indicó que no conviene separar el stock en "góndola" y "depósito" (un segundo depósito calculado
con conteos menos ventas): depende de que el repositor cuente bien y seguido, y un conteo erróneo arrastra todas las alertas.
En su lugar:

1. Cada cierto tiempo se avisa al repositor que haga una **pasada** y revise si hay quiebres.
2. Se detectan los productos que **no venden lo esperado** (ej.: promedio de 7 shampoos y no se vendió ninguno) para revisar la góndola.

## 2. Conceptos

| Término | Definición |
|---|---|
| **Pasadas por día** | Las define el encargado de cada sucursal (1-24), junto con el horario de apertura y cierre |
| **Período** | El horario comercial dividido en partes iguales, una por pasada. Ej.: 08-20 h con 3 pasadas → 08-12, 12-16, 16-20 |
| **Umbral** | Promedio de unidades vendidas en ese período, el mismo día de la semana, en las últimas 4 semanas. Se alimenta solo del historial de ventas |
| **Esperado hasta ahora** | Promedio vendido en el mismo tramo ya transcurrido del período (respeta los picos dentro del período) |
| **Quiebre** | Lapso con la góndola vacía. Empieza en la última venta del producto y termina cuando el repositor repone o vuelve a venderse |

Los períodos con quiebre **no entran en el promedio**: si no, un quiebre bajaría el umbral y el sistema "aprendería" a esperar menos justo cuando falló.

## 3. Reglas

| ID | Regla |
|---|---|
| R1 | Al empezar cada período se abre una alerta **RONDA** (prioridad MEDIA) para el repositor. Si la ronda anterior seguía abierta, se cierra como *pasada no realizada*. Una sola ronda por período. |
| R2 | El repositor cierra la ronda con **Terminé la pasada**. En la ronda, cada producto muestra "Dejá al menos ⌈umbral⌉". |
| R3 | **VENTA_ANOMALA** (ALTA, repositor) cuando `P(Poisson(esperado) ≤ vendido en el período) < 5 %`. Ej.: esperado 7 → vendido 0 alerta (0,09 %), vendido 2 alerta (3 %), vendido 5 no (30 %). Una por producto por período; no se evalúa si el producto ya tiene un quiebre abierto. |
| R4 | El repositor responde un producto con: **OK** (la góndola estaba bien), **REPUSE** (estaba vacía y la repuso: registra el quiebre desde la última venta hasta ahora) o **SIN_STOCK** (vacía y sin mercadería: el quiebre queda abierto y se abre **SIN_STOCK** para el encargado). |
| R5 | Un quiebre abierto se cierra con REPUSE o con una venta del producto (si alguien lo compró, había). Ambos cierran la alerta SIN_STOCK. |
| R6 | Sin historial de ventas el umbral es "—" y no hay alerta de venta anómala. Fuera del horario no hay períodos, rondas ni alertas. |

El tick (`/api/cron/tick`, cada minuto con `pg_cron`) aplica R1 y R3. Las ventas se siguen recibiendo igual que en la spec-00 (atómicas e idempotentes por `comprobante_id`).

## 4. Datos

- `sucursal (id, pasadas_por_dia, apertura, cierre)`: configuración del encargado.
- `vacio_periodo`: los quiebres (desde, hasta; `hasta` nulo = abierto).
- `alerta.tipo`: `RONDA` (sin producto), `VENTA_ANOMALA`, `SIN_STOCK`.
- Se eliminan `conteo` y las columnas de conteo, capacidad y estado de `gondola_item` (migración `0002_rondas.sql`).

## 5. API

| Método | Ruta | Uso |
|---|---|---|
| `GET/PATCH` | `/api/sucursales/{s}` | Configuración `{pasadas_por_dia, apertura, cierre}` |
| `GET` | `/api/sucursales/{s}/ronda` | Período actual, ronda abierta y alertas del repositor |
| `POST` | `/api/sucursales/{s}/reportes` | `{producto_id, resultado: OK\|REPUSE\|SIN_STOCK, repositor_id}` |
| `PATCH` | `/api/alertas/{id}` | `{estado: "ATENDIDA", por}` cierra la ronda; `{motivo}` descarta |

## 6. Límites conocidos

- Poisson supone ventas independientes: compras mayoristas pueden dar falsas alarmas (ajustar `P_ANOMALIA`).
- El inicio del quiebre es una estimación (última venta); el repositor solo informa cuándo lo vio.
