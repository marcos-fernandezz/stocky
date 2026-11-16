# Feature: rondas-por-periodo
Replace the estimated shelf-stock model (counts − sales, shelf vs. back room) with periodic rounds per branch and sales-anomaly alerts.
Branch: `feat/rondas-periodo` · Delivery: ask-on-risk · Tests: `npm test` (vitest + PGlite).

## Specs

- **S1** — "no hagamos un segundo deposito dividiendo los productos a los que estan en caja y los que estan en deposito" → remove the estimated shelf stock, back-room estimate, counts, and the REPONER / SIN_DEPOSITO / RECONTAR alerts.
- **S2** — "cada sucursal sera gestionada por un encargado que va a identificar cuantas pasadas se haran por dia para reponer stock; a partir de ello se generan periodos" → per-branch config `pasadas_por_dia` (plus business hours) editable by the encargado; business hours are split into that many equal periods.
- **S3** — "cada cierto tiempo alertar a un repositor que haga una pasada y revise que haya quiebres de stock" → at the start of each period a RONDA alert opens for the repositor; an unfinished previous RONDA is closed as "pasada no realizada".
- **S4** — "el umbral es el promedio que vendes por periodo; que es alimentado por los datos que se van cargando en el historial de ventas" → umbral = average units sold in the same period and weekday over the last 4 weeks; periods with a recorded quiebre are excluded (agreed).
- **S5** — "teniamos una venta promedio de 7 shampoos y no venidmos ninguno; entonces alertar esto para analizar la gondola" → VENTA_ANOMALA for the repositor when P(Poisson(expected so far) ≤ sold so far) < 5%; at most one per product per period.
- **S6** — "como lo marca el repositor?" → agreed: the repositor reports a product as OK / REPUSE (it was empty, restocked) / SIN_STOCK (empty, nothing in the back room → escalates to the encargado). Quiebre start = last sale; end = REPUSE (or a later sale).

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S6 | inline | in progress | domain + schema + API + UI + tests + docs, one behavior change |

## Log

- **L1** (2026-11-16) — "tenemos un problema; nuestro advisor nos dijo que no hagamos un segundo deposito dividiendo los productos a los que estan en caja y los que estan en deposito; sino que cada cierto tiempo alertar a un repositor que haga una pasada y revise que haya quiebres de stock; y que evalue situaciones donde por ejemplo la venta promedio de cierto producto no se este realizando como se espera; es decir que por ejemplo teniamos una venta promedio de 7 shampoos y no venidmos ninguno; entonces alertar esto para analizar la gondola"
- **L2** — "a tener en cuenta es que cada sucursal sera gestionada por un encargado que va a identificar cuantas pasadas se haran por dia para reponer stock; a partir de ello se generan periodos que seran evaluados para aumentar o dosminuir el umbral; de forma tal que prevenimos el quiebre de stock"
- **L3** — "el umbral es el promedio que vendes por periodo; que es alimentado por los datos que se van cargando en el historial de ventas"
- **L4** — "como indica el repositor el quiebre? es decir en teoria de esta forma no deberiamos tener quiebre pero en caso que ocurre como lo marca el repositor?" → agreed design in S6.
- **L5** — "si, me cierra, arranca con la implementacion"
- **L6** — Decisions: anomaly is evaluated continuously in the tick against the expected sales of the same elapsed window (not only at period close), so it fires earlier and equals the close evaluation at the end. A sale during an open quiebre closes it. Schema change via `0002_rondas.sql` (drops `conteo` and the count columns).
