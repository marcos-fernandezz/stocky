# Feature: stock-gondola-mvp
MVP del sistema de stock en góndola y alertas de reposición definido en `specs/spec-00-reposicion-gondola.md`.
Rama: `feat/stock-gondola-mvp` · Entrega: ask-on-risk · Stack: Python 3 stdlib (http.server + sqlite3), HTML/JS sin build · Tests: `python3 -m unittest`.

## Specs

- **S1** — "los repositores se encarguen de al momento de reponer productos actualicen el sistema para que se tenga data en tiempo real del estado de la sucursal" → spec-00 RF-01 (conteo).
- **S2** — "los repositores puedan tener data fresca de que productos deben reponer" → spec-00 RF-05 (lista de reposición en vivo).
- **S3** — "que la alerta al acceder el umbral notifique al repositor que ese producto se debe reponer con urgencia" → spec-00 §6 (umbral) + RF-04 (alertas).
- **S4** — "cada producto debe tener una metrica de cuantos productos tiene respecto a los que tenia notificados por el repositor" → spec-00 RF-03 (nivel).
- **S5** — "que por cada ticket generado en caja se descuente esa cantidad que el repositor habia notificado" → spec-00 RF-02.
- **S6** — "por cada compra se genera una orden de compra en nuestro sistema que cuando el comprobante se genere; descuente esa orden de compra de los productos en gondola actuales" → acordado: entidad `venta` = comprobante, descuento atómico, idempotente por `comprobante_id` (spec-00 RF-02).
- **S7** — Vista del encargado y simulador de ventas para la demo → spec-00 RF-06, §10, §12.

Asumido para el MVP: sin autenticación (el repositor se identifica con un nombre); el push es una notificación del navegador vía SSE (no FCM); el modo sin conexión de la app (RNF-04) queda como cola local simple.

## Features

| ID | Feature | Qué hace |
|---|---|---|
| F1 | Datos base | Esquema SQLite (catálogo, stock general Red Faro de solo lectura, góndola, conteos, ventas, alertas, períodos vacíos) y seed de la demo (S1/S2 · Leche, Arroz, Agua, Carne), con historial opcional |
| F2 | Conteo | Registra las unidades en góndola; reinicia lo vendido desde el conteo; guarda esperado/diferencia; valida la capacidad; cierra las alertas REPONER/VERIFICAR/RECONTAR |
| F3 | Ventas | Recibe el comprobante completo y lo guarda atómico (todo o nada), idempotente por `comprobante_id`; maneja anulaciones; los productos desconocidos quedan como "sin conteo" |
| F4 | Estado, nivel y umbral | Calcula stock góndola, desvío, nivel %, depósito, horas a vacío, a reponer, umbral por franja horaria (promedio de 4 semanas excluyendo horas vacías) y estado |
| F5 | Alertas | Evalúa REPONER / SIN_DEPOSITO / VERIFICAR / RECONTAR después de cada evento y en un tick periódico; una alerta abierta por tipo; escala de Alta a Urgente con nueva notificación; cierre automático |
| F6 | API + tiempo real | Endpoints de spec-00 §8 y un stream SSE por sucursal |
| F7 | App repositor | Web móvil: lista priorizada en vivo con minutos totales, conteo en ≤ 3 toques (con confirmación si supera la capacidad), notificaciones del navegador, cola sin conexión |
| F8 | Encargado + simulador | Tabla de la sucursal con filtro por estado y botones para simular ventas/anulaciones; script CLI de simulación |

## Tasks

| ID | Specs | Features | Ruta | Estado | Commit |
|---|---|---|---|---|---|
| T1 | S1, S3, S4, S5, S6 | F1–F5 dominio + tests de aceptación §12 | inline (sin trigger de writer: una unidad secuencial) | pendiente | — |
| T2 | S2, S3 | F6 API + SSE + tick | inline | pendiente | — |
| T3 | S2, S3, S7 | F7 + F8 UIs y simulador | inline | pendiente | — |
| T4 | — | README de ejecución | inline | pendiente | — |

## Log

- **L1** (2026-11-16, verbatim): "definime bien que hace cada una de las features a implementar y comenza la implementacion"
- **L2**: Spec de referencia: `specs/spec-00-reposicion-gondola.md` (pedido original verbatim: "generes la especificacion para generar un sistema donde los repositores se encarguen de al momento de reponer productos actualicen el sistema para que se tenga data en tiempo real del estado de la sucursal para que los repositores puedan tener data fresca de que productos deben reponer y que la alerta al acceder el umbral notifique al repositor que ese producto se debe reponer con urgencia; ademas cada producto debe tener una metrica de cuantos productos tiene respecto a los que tenia notificados por el repositor; que por cada ticket generado en caja se descuente esa cantidad que el repositor habia notificado").
- **L3**: Decisión de stack: Python stdlib sin dependencias (no hay fastapi/pytest instalados; corre en cualquier máquina del hackatón). `vendido_desde_conteo` se **deriva** de las ventas (emitido_at > conteo_at, no anuladas) en lugar de un contador: la llegada tardía y las anulaciones quedan bien sin lógica extra, y la atomicidad se reduce a insertar el comprobante en una transacción.
- **L4**: Corrección a la spec: RF-01 decía cerrar alertas "VACIO" (no es un tipo de alerta) → VERIFICAR. Anulación = anula la venta completa referenciada.
