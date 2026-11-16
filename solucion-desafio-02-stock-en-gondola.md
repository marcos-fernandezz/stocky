# Solución · Desafío 02 — Disponibilidad y reposición en góndola

**Equipo 2 · Hackatón Retail Chain 4.0 · Caso Red Faro · Noviembre 2026**

> Red Faro sabe cuánto stock tiene en cada sucursal, pero no cuánto hay **a la venta en la góndola**.
> Proponemos llevar la cuenta de la góndola con el conteo del repositor y los tickets de caja,
> y avisar a tiempo qué reponer, cuánto y en qué orden.

---

## 1. Problema

| Dolor | Consecuencia |
|---|---|
| El sistema central muestra el stock total por sucursal, **sin distinguir góndola de depósito** | Puede figurar stock aunque la góndola esté vacía |
| Las ventas se consolidan **a medianoche** | Durante el día nada avisa que una góndola se está vaciando |
| **No hay registro** de cuándo se vacía una góndola ni de cuándo se repone | No se puede medir el problema ni priorizar con datos |
| La reposición depende de recorridas y del criterio del personal | Se repone tarde, o se repone lo que todavía tenía cobertura |

Resultado: hay ventas que se pierden entre el depósito y la góndola y no quedan registradas.

---

## 2. Solución propuesta

Flujo: **Stock → Góndola → Cliente**. El sistema se ocupa del paso góndola → cliente.

```
 Repositor ──(conteo en app)──▶ ┌──────────────────────────┐ ◀── Stock general Red Faro
                                │  Stock en góndola        │     (consulta, sin copiar)
 Caja ─────(ticket de venta)──▶ │  por sucursal + producto │
                                └────────────┬─────────────┘
                                             ▼
                                ┌──────────────────────────┐
                                │  Inferencia: umbral por  │──▶ Alerta ──▶ Repositor
                                │  producto y franja       │         └──▶ Encargado (sin depósito)
                                └──────────────────────────┘
```

1. **Conteo.** Desde la app, el repositor registra cuántas unidades hay en la góndola de cada producto.
2. **Descuento por venta.** Cada ticket de caja descuenta en el momento las unidades vendidas del stock en góndola.
3. **Umbral inteligente.** Cada combinación de producto y sucursal tiene un umbral, que se recalcula según la demanda de cada franja horaria.
4. **Alerta.** Cuando el stock en góndola llega al umbral o baja de él, se avisa al repositor qué reponer y cuántas unidades, ordenado por urgencia.

---

## 3. Modelo de datos

### 3.1 Stock general — sistema de Red Faro (existente)
Clave: **sucursal + producto**. Se actualiza a medianoche. El sistema **lo consulta y no lo copia**, para no tener dos versiones del mismo dato.

| sucursal | producto | stock general |
|---|---|---|
| S1 | ID-1 Leche | 30 |
| S1 | ID-2 Arroz | 20 |
| S1 | ID-3 Agua | 25 |
| S1 | ID-4 Carne | 40 |
| S2 | ID-1 Leche | 15 |

### 3.2 Stock en góndola — nuestro sistema (nuevo)
Usa la **misma clave** que Red Faro, para que cada producto pueda estar en varias sucursales.

| campo | qué guarda | quién lo escribe |
|---|---|---|
| sucursal, producto | Clave compartida con Red Faro | Alta inicial |
| stock góndola | Unidades a la venta ahora | Repositor (conteo) − tickets |
| capacidad | Máximo de unidades que entran en la góndola | Alta inicial / repositor |
| último conteo | Fecha y hora del último conteo real | App, automático |
| umbral | Nivel al que se dispara la alerta | Sistema (calculado) |

### 3.3 Datos derivados (se calculan, no se guardan)

```
vendido hoy   = suma de tickets del día (sucursal + producto)
depósito      = stock general (medianoche) − vendido hoy − stock góndola
a reponer     = mín( capacidad − stock góndola , depósito )
horas a vacío = stock góndola ÷ venta por hora de la franja
```

---

## 4. Umbral inteligente

```
umbral = máx( mínimo de exhibición,
              ⌈ venta/hora de la franja × (tiempo de respuesta + tiempo de reposición) + seguridad ⌉ )
```

| parámetro | definición | fuente |
|---|---|---|
| venta/hora de la franja | Promedio móvil por día de la semana y hora | Tickets históricos |
| tiempo de respuesta | Demora media en atender una alerta | Medido por la app |
| tiempo de reposición | Minutos que lleva reponer ese producto | Medición |
| seguridad | Margen ante la variabilidad de la demanda | Configurable (1 unidad) |
| mínimo de exhibición | Unidades por debajo de las cuales la góndola se ve vacía | Por categoría (2 unidades) |

Lo "inteligente": **cada producto tiene su propio umbral, más alto en las horas de mayor demanda y más bajo en las horas tranquilas**, que además se ajusta solo a medida que se acumulan ventas. Para el MVP alcanza con una fórmula transparente; el machine learning puede venir después, cuando haya historial real para validarlo.

---

## 5. Reglas de alerta

| # | Condición | Alerta | Destinatario |
|---|---|---|---|
| R1 | góndola ≤ umbral **y** depósito > 0 | **Reponer** *a reponer* unidades | Repositor |
| R2 | góndola ≤ umbral **y** depósito = 0 | **Sin mercadería** en la sucursal | Encargado / compras |
| R3 | Producto de alta rotación sin ventas en un lapso improbable (p < 5%) **y** góndola > 0 | **Verificar góndola** (posible faltante, producto mal ubicado o robo) | Repositor |
| R4 | último conteo con más de 24 h de antigüedad | **Recontar** | Repositor |

**Orden de la cola:** primero lo que tiene menos *horas a vacío*; si hay empate, el producto de mayor valor.

**Reconciliación:** cada vez que repone, el repositor registra cuántas unidades quedaron en la góndola. Ese conteo **reemplaza** al valor calculado y actualiza *último conteo*. La diferencia entre lo esperado y lo contado se guarda como métrica de pérdida.

---

<div style="page-break-before:always"></div>

## 6. Ejemplo con los datos del equipo

Supuestos: son las 12:00, el tiempo de respuesta es de 30 min, la seguridad es de 1 unidad y el mínimo de exhibición es de 2 unidades. Hay **15 minutos** de personal disponibles en S1.

| suc. | producto | general | vendido | góndola | depósito | capac. | venta/h | umbral | últ. conteo | h a vacío | alerta |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Carne | 40 | 3 | **0** | 37 | 10 | 0,5 | 2 | 08:10 | 0 | 🔴 R1 +10 |
| S1 | Agua | 25 | 6 | **2** | 17 | 20 | 1,5 | 2 | 09:30 | 1,3 | 🔴 R1 +17 |
| S1 | Leche | 30 | 8 | **3** | 19 | 12 | 2,0 | 3 | 10:40 | 1,5 | 🟠 R1 +9 |
| S1 | Arroz | 20 | 4 | 10 | 6 | 15 | 1,0 | 2 | 09:15 | 10 | 🟡 R3 |
| S2 | Leche | 15 | 12 | **3** | **0** | 12 | 2,5 | 3 | 11:05 | 1,2 | ⚫ R2 |

*+N = unidades a reponer. Arroz (R3): sin ventas desde las 09:05, improbable para 1 venta/h.*

Cálculo del umbral (S1 Leche): 2,0 × (0,5 h + 0,1 h) + 1 = 2,2 → se redondea hacia arriba a **3**.
Depósito (S1 Leche): 30 − 8 − 3 = **19**. A reponer: mín(12 − 3, 19) = **9**.

**Plan para los 15 minutos de S1:** carne (5 min) + agua (6 min) = 11 min. Leche, que se vacía en ~1,5 h, queda en el próximo hueco libre, y los 4 minutos restantes se usan en verificar la góndola de arroz.
En **S2** la leche llega al umbral, pero no hay unidades en depósito: reponer no es posible y la alerta va al encargado.

---

## 7. Indicadores de impacto

| Indicador | Cómo se mide |
|---|---|
| Horas de góndola vacía | Alertas R1/R2 abiertas hasta la reposición, antes y después |
| Venta perdida estimada | venta/hora × horas de góndola vacía |
| Minutos de reposición por día | Registro de la app (referencia actual: 20 × 8 min = 160 min/día) |
| Precisión de alertas | % de alertas confirmadas por el repositor |
| Desvío de conteo | Diferencia entre lo esperado y lo contado, por producto |

Al registrar las horas de góndola vacía también se **corrige la demanda subestimada**: esas horas se excluyen del cálculo de demanda para no pedir de menos (vínculo con el Desafío 01).

> Cifras ilustrativas sobre datos ficticios: sirven para comparar escenarios, no son resultados comprobados.

---

## 8. Piloto

1. **Alcance:** 1 sucursal, 20–30 productos de alta rotación, durante 2–4 semanas.
2. **Requisitos:** envío de tickets en tiempo real desde la caja, capacidad de cada góndola y conteo inicial.
3. **Línea base:** 1 semana con las recorridas habituales, registrando las góndolas vacías encontradas.
4. **Validación:** comparar las horas de góndola vacía y la precisión de las alertas contra la línea base.
5. **Fase 2 (opcional):** cámaras para confirmar el estado de la góndola en los productos con mayor desvío de conteo.

---

## 9. Supuestos y límites

- **Ticket en tiempo real:** es un cambio de proceso, porque hoy las ventas se consolidan a medianoche.
- El stock general de Red Faro puede tener errores; la reconciliación los acota, pero no los elimina.
- La regla R3 solo funciona en productos de alta rotación.
- La adopción depende de que cargar un conteo en la app lleve segundos.
