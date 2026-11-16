# SPEC-00 · Sistema de stock en góndola y alertas de reposición

**Proyecto:** Stocky · Equipo 2 · Hackatón Retail Chain 4.0 (caso Red Faro)
**Estado:** borrador para MVP · **Fecha:** 2026-11-16

---

## 1. Objetivo

Mantener en **tiempo real** el stock en góndola de cada producto por sucursal:

1. El **repositor** informa cuántas unidades dejó en la góndola cada vez que repone (conteo).
2. Cada **venta** (comprobante emitido en caja) descuenta de ese conteo, en una sola operación, las unidades de todas sus líneas.
3. Cuando un producto llega a su **umbral**, el sistema **notifica con urgencia** al repositor.
4. Cada producto muestra una **métrica de nivel**: unidades actuales respecto de las informadas en el último conteo.

## 2. Fuera de alcance (MVP)

- Pedidos a proveedores y abastecimiento (Desafío 01).
- Cámaras o visión artificial.
- Modelos de machine learning: el umbral se calcula con una fórmula (§6).
- Cambios en el sistema central de Red Faro: solo se **lee** de él.

## 3. Actores

| Actor | Rol |
|---|---|
| **Repositor** | Registra conteos, recibe alertas y consulta la lista de reposición |
| **Caja (POS)** | Envía cada comprobante emitido y cada anulación |
| **Encargado** | Recibe las alertas sin depósito y ve el estado de la sucursal |
| **Sistema central Red Faro** | Fuente del stock general por sucursal (lectura, actualización nocturna) |

## 4. Glosario

| Término | Definición |
|---|---|
| **Conteo** | Unidades que el repositor informa que hay en góndola después de reponer o verificar |
| **Stock góndola** | Último conteo − unidades vendidas desde ese conteo (nunca negativo) |
| **Nivel** | `stock góndola ÷ último conteo × 100` (%) |
| **Umbral** | Unidades a partir de las cuales el producto debe reponerse (§6) |
| **Depósito** | `stock general − vendido hoy − stock góndola` |
| **Venta** | Comprobante emitido en caja con todas sus líneas. Es la unidad de descuento: se aplica completa o no se aplica. *No confundir con orden de compra, que es el pedido al proveedor (fuera de alcance)* |
| **Desvío** | Unidades vendidas por encima del conteo informado (indica un conteo incorrecto o producto sin registrar) |

---

## 5. Modelo de datos

Clave de producto en góndola: **(sucursal_id, producto_id)**, la misma que usa el sistema central de Red Faro.

### 5.1 `gondola_item`
| campo | tipo | descripción |
|---|---|---|
| sucursal_id, producto_id | PK | Clave compartida con Red Faro |
| capacidad | int > 0 | Máximo de unidades en góndola |
| conteo_informado | int ≥ 0 | Unidades del último conteo |
| conteo_at | timestamp | Fecha y hora del último conteo |
| conteo_por | repositor_id | Quién hizo el último conteo |
| vendido_desde_conteo | int ≥ 0 | Unidades descontadas por ventas desde `conteo_at` |
| stock_gondola | int ≥ 0 | `max(0, conteo_informado − vendido_desde_conteo)` |
| desvio | int ≥ 0 | `max(0, vendido_desde_conteo − conteo_informado)` |
| umbral | int ≥ 0 | Calculado (§6) |
| minimo_exhibicion | int ≥ 0 | Por defecto 2 |
| tiempo_reposicion_min | int > 0 | Minutos que lleva reponer el producto |
| estado | enum | `OK` · `BAJO` · `VACIO` · `SIN_DEPOSITO` · `SIN_CONTEO` |

### 5.2 `conteo` (histórico, solo inserción)
`id, sucursal_id, producto_id, repositor_id, unidades, esperado, diferencia, tipo (REPOSICION | VERIFICACION | INICIAL), created_at`
- `esperado` = stock_gondola calculado justo antes del conteo.
- `diferencia` = `unidades − esperado` (sirve como métrica de pérdida o de error de conteo).

### 5.3 `venta` y `venta_linea` (histórico, solo inserción)
- `venta`: `comprobante_id (PK), sucursal_id, tipo (VENTA | ANULACION), comprobante_ref (la venta que se anula), emitido_at, procesada_at`.
- `venta_linea`: `comprobante_id, linea, producto_id, cantidad > 0`.
- **`comprobante_id` es único**: la misma venta nunca se procesa dos veces.

### 5.4 `alerta`
`id, sucursal_id, producto_id, tipo (REPONER | SIN_DEPOSITO | VERIFICAR | RECONTAR), prioridad, unidades_sugeridas, creada_at, atendida_at, atendida_por, estado (ABIERTA | ATENDIDA | DESCARTADA)`.
Hay como máximo **una alerta abierta por tipo y producto**.

---

## 6. Umbral

```
umbral = max( minimo_exhibicion,
              ceil( venta_hora_franja × (tiempo_respuesta_h + tiempo_reposicion_h) + seguridad ) )
```
- `venta_hora_franja`: promedio de unidades vendidas por hora en el mismo día de la semana y franja horaria, sobre las últimas 4 semanas. **Se excluyen las horas en que el producto estuvo en estado `VACIO`**, para no subestimar la demanda.
- `tiempo_respuesta_h`: mediana de la demora entre una alerta y su atención en la sucursal (valor inicial: 0,5 h).
- `seguridad`: 1 unidad (configurable).
- Sin historial de ventas: `umbral = max(minimo_exhibicion, ceil(capacidad × 0,25))`.
- Se recalcula **al comienzo de cada franja horaria** y al registrar un conteo.

---

## 7. Requisitos funcionales

### RF-01 · Registrar conteo (repositor)
El repositor elige un producto (escaneando el código de barras o buscándolo) e ingresa las unidades que hay en la góndola.
- **Dado** el producto Leche en S1 con stock góndola calculado 3,
  **cuando** el repositor registra un conteo de 12,
  **entonces** `conteo_informado = 12`, `vendido_desde_conteo = 0`, `stock_gondola = 12`, `conteo_at = ahora`,
  y se guarda un `conteo` con `esperado = 3, diferencia = +9`.
- Un conteo **mayor que la capacidad** se acepta, pero se pide confirmación ("¿Superás la capacidad de 12?").
- Un conteo **negativo o no numérico** se rechaza.
- Al registrar el conteo, las alertas `REPONER`, `VERIFICAR` y `RECONTAR` abiertas de ese producto pasan a `ATENDIDA`, con `atendida_por` = repositor.
- Registrar un conteo debe llevar **≤ 3 toques** después de escanear el producto.

### RF-02 · Descontar stock por venta (comprobante)
Cuando la caja emite un comprobante, el sistema registra la `venta` y, **en una sola transacción**, suma la `cantidad` de cada línea a `vendido_desde_conteo` del producto en la sucursal de la venta. Si falla el descuento de cualquier línea, no se aplica ninguna (todo o nada). Un producto desconocido **no** es un fallo: la línea se registra y se trata como *producto sin conteo*.
- **Dado** Leche en S1 con `conteo_informado = 12` y `vendido_desde_conteo = 0`,
  **cuando** se emite un comprobante con 2 leches y 1 arroz,
  **entonces** Leche queda con `vendido_desde_conteo = 2`, `stock_gondola = 10`, `nivel = 83%`, y Arroz se descuenta en la misma transacción.
- **Idempotencia:** un `comprobante_id` ya procesado se ignora y responde `200` con el resultado original.
- **Líneas repetidas:** si el mismo producto aparece en varias líneas, se suman antes de descontar.
- **Anulación / devolución:** un comprobante `ANULACION` (sin líneas) anula **completa** la venta referenciada: sus unidades dejan de contar en `vendido_desde_conteo` (solo si esa venta había descontado del conteo vigente). Si la venta referenciada no existe o ya fue anulada, se rechaza con `422`.
- **Ventas posteriores al conteo:** solo descuentan las líneas con `emitido_at ≥ conteo_at` (una venta en el mismo segundo que el conteo descuenta: ante la duda, la alerta llega antes). Una venta anterior que llega tarde no descuenta del conteo nuevo.
- **Producto sin conteo:** la venta se registra, el estado queda `SIN_CONTEO` y se crea la alerta `RECONTAR`.
- **Venta mayor al conteo:** `stock_gondola` queda en 0, la diferencia se acumula en `desvio` y se crea la alerta `VERIFICAR`. La venta nunca se rechaza.

### RF-03 · Métrica de nivel por producto
Cada producto expone:
- `nivel = stock_gondola ÷ conteo_informado × 100`, redondeado a entero (0% si el conteo es 0).
- Unidades actuales e informadas, en formato "3 de 12".
- Hora del último conteo y quién lo hizo.
- Horas hasta vaciarse = `stock_gondola ÷ venta_hora_franja`.

| Estado | Condición |
|---|---|
| `VACIO` | stock_gondola = 0 |
| `SIN_DEPOSITO` | stock_gondola ≤ umbral **y** depósito = 0 |
| `BAJO` | stock_gondola ≤ umbral |
| `OK` | stock_gondola > umbral |
| `SIN_CONTEO` | Nunca se contó (un conteo de más de 24 h no cambia el estado: genera la alerta `RECONTAR`) |

### RF-04 · Alerta urgente al llegar al umbral
Después de cada actualización (venta o conteo), el sistema evalúa:

| Condición | Alerta | Destinatario | Prioridad |
|---|---|---|---|
| stock_gondola ≤ umbral **y** depósito > 0 | `REPONER` · reponer `min(capacidad − stock_gondola, depósito)` unidades | Repositores de la sucursal | **Urgente** si stock_gondola = 0; si no, **Alta** |
| stock_gondola ≤ umbral **y** depósito = 0 | `SIN_DEPOSITO` | Encargado | Alta |
| desvío > 0, o producto de alta rotación sin ventas en un lapso con probabilidad < 5% | `VERIFICAR` | Repositores | Media |
| Sin conteo o conteo de más de 24 h | `RECONTAR` | Repositores | Baja |

- La notificación **push** se envía **una sola vez** por alerta abierta. Si la alerta pasa de Alta a Urgente, se vuelve a notificar.
- Texto de la alerta: `URGENTE · Leche (S1) · quedan 0 de 12 · reponer 9 u.`
- Una alerta `REPONER` abierta se cierra sola si un conteo deja stock_gondola por encima del umbral.

### RF-05 · Lista de reposición (datos frescos)
El repositor ve la lista de productos de su sucursal **con alerta abierta**, ordenada por:
1. Prioridad (Urgente > Alta > Media > Baja).
2. Horas hasta vaciarse, de menor a mayor.
3. Valor del producto, de mayor a menor.

Cada ítem muestra el producto, las unidades ("3 de 12"), el nivel, las unidades a reponer, el tiempo estimado y la hora del último conteo. La lista se **actualiza en vivo**, sin recargar, cuando llega una venta o un conteo.
Además muestra el **total de minutos** de la lista, para que el repositor sepa qué alcanza a reponer en el tiempo que tiene disponible.

### RF-06 · Vista del encargado
Tabla de todos los productos de la sucursal con estado, nivel, depósito, desvío acumulado del día y alertas abiertas, con filtro por estado.

---

## 8. API (MVP)

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/sucursales/{s}/conteos` | RF-01. Body: `{producto_id, unidades, tipo}` |
| `POST` | `/ventas` | RF-02. Body: `{comprobante_id, sucursal_id, tipo, comprobante_ref?, emitido_at, lineas:[{linea, producto_id, cantidad}]}` |
| `GET` | `/sucursales/{s}/productos` | RF-03 / RF-06 |
| `GET` | `/sucursales/{s}/reposicion` | RF-05 |
| `GET` | `/sucursales/{s}/stream` | Server-Sent Events: `producto.actualizado`, `alerta.creada`, `alerta.cerrada` |
| `PATCH` | `/alertas/{id}` | Descartar una alerta (con motivo) |

`POST /ventas` aplica la venta completa de forma atómica y responde `201`; si el comprobante ya fue procesado, responde `200` (idempotente por `comprobante_id`). Una `VENTA` sin líneas o con cantidades ≤ 0 se rechaza con `422`.

---

## 9. Requisitos no funcionales

| ID | Requisito |
|---|---|
| RNF-01 | De la emisión del comprobante a la actualización de la lista: **≤ 5 s** (p95) |
| RNF-02 | Del umbral cruzado a la notificación push: **≤ 10 s** (p95) |
| RNF-03 | **Concurrencia:** las ventas y los conteos sobre el mismo producto se aplican de forma atómica, sin perder actualizaciones |
| RNF-04 | **Sin conexión:** la app del repositor guarda los conteos localmente y los sincroniza al reconectar, usando el `created_at` del dispositivo |
| RNF-05 | Si la caja pierde conexión, reenvía los comprobantes pendientes; la idempotencia evita contarlos dos veces |
| RNF-06 | La app es usable con una mano, en celular y con poca luz (botones grandes, alto contraste) |
| RNF-07 | Auditoría: cada conteo queda asociado a un repositor y a un horario |

---

## 10. Requisito externo (bloqueante)

Hoy **la caja consolida las ventas a medianoche**. El MVP requiere que el POS **envíe cada comprobante al emitirlo** (o en lotes de ≤ 1 min) a `POST /ventas`. Para la demo, un **simulador de ventas** reemplaza al POS.

---

## 11. Métricas del piloto

| Métrica | Fuente |
|---|---|
| Horas de góndola vacía por producto | Tiempo en estado `VACIO` |
| Venta perdida estimada | venta_hora_franja × horas en `VACIO` |
| Tiempo de respuesta a alertas | `atendida_at − creada_at` |
| Precisión de alertas | % de alertas `VERIFICAR` / `REPONER` confirmadas por un conteo |
| Diferencia de conteo | Promedio de `conteo.diferencia` por producto (pérdida o error) |
| Minutos de reposición por día | Suma de `tiempo_reposicion_min` de las alertas atendidas |

---

## 12. Criterios de aceptación del MVP (demo)

Datos iniciales: S1 → Leche (capacidad 12), Arroz (15), Agua (20), Carne (10); S2 → Leche (12). Stock general según la tabla de Red Faro (S1: 30/20/25/40; S2: 15).

1. El repositor registra el conteo Leche S1 = 12 → la lista muestra "12 de 12 · 100%".
2. El simulador emite 9 ventas de 1 leche en S1 → "3 de 12 · 25%", el estado pasa a `BAJO` y llega un push `REPONER` con prioridad Alta.
3. Otras 3 ventas → "0 de 12", la prioridad pasa a **Urgente** y se vuelve a notificar.
4. El repositor registra el conteo de 12 → la alerta se cierra sola, el nivel vuelve a 100% y queda guardado `diferencia = +12`.
5. Se reenvía una venta con el mismo `comprobante_id` → el stock no cambia.
6. Una venta de 1 leche + 1 arroz con un fallo simulado al descontar el arroz → ningún stock cambia (todo o nada), y al reintentar se aplica completa una sola vez.
7. Se anula una venta de 2 leches → la góndola suma 2 unidades.
8. En S2, con depósito en 0, la leche llega al umbral → se alerta `SIN_DEPOSITO` al encargado y no al repositor.
9. Se vende 1 carne sin conteo previo → el estado queda `SIN_CONTEO` y se crea la alerta `RECONTAR`.

---

## 13. Preguntas abiertas

- ¿El POS de Red Faro puede enviar cada comprobante en tiempo real? ¿Con qué formato de identificador de producto (EAN o código interno)?
- ¿La capacidad de cada góndola la carga el encargado una sola vez o la estima el repositor?
- ¿Las alertas se reparten entre los repositores por sector o las ven todos los de la sucursal?
