# Informe · Desafío 02 — Disponibilidad y reposición en góndola

**Caso:** Red Faro (Hackatón Retail Chain 4.0 · Bahía Blanca, 16/11/2026)
**Objetivo del informe:** identificar los dolores del proceso actual y los factores que la propuesta debe respetar.
**Fuentes:** `Hackaton_Retail_Chain_4.0_Red_Faro_Caso_Marco.docx.pdf` y `Hackaton_Retail_Chain_4.0_Red_Faro_Desafios.docx.pdf`. Todas las cifras del caso son ficticias.

---

## 1. El problema en una frase

Red Faro sabe cuánto stock tiene **dentro de la tienda**, pero no sabe cuánto hay **a la venta en la góndola**. La venta se pierde entre el depósito y el estante, y nadie la registra.

> Pregunta disparadora: *¿Cómo puede Red Faro reducir los quiebres de góndola y el trabajo improductivo de reposición, manteniendo la disponibilidad con recursos limitados?*

Alcance: el inventario ya está en la tienda. **No** se trata de pedir mejor a proveedores (eso es el Desafío 01), sino de visibilidad, oportunidad y ejecución de la reposición.

---

## 2. Dolores (AS IS)

### D1 · El sistema no distingue góndola de depósito
El sistema central muestra el stock total por SKU y sucursal. Arroz en RF-03 figura con 30 unidades, pero la góndola está en 0. Para el sistema **no hay problema**; para el cliente, el producto no existe.
**Consecuencia:** la disponibilidad teórica oculta los quiebres reales.

### D2 · La información llega una vez por día
Las ventas se consolidan cerca de la medianoche. Durante el día no hay ninguna señal que avise que una góndola se está vaciando, justamente en las franjas de mayor demanda.
**Consecuencia:** cualquier reacción depende de que alguien lo vea.

### D3 · Los quiebres no se registran
No existe un registro uniforme de cuándo se vacía una góndola, cuánto tiempo permanece vacía ni cuándo se repone.
**Consecuencia:** no se puede medir el problema, priorizar con datos, ni demostrar mejoras. Lo que no se mide no se gestiona.

### D4 · Reposición reactiva y dependiente de la persona
Se repone por recorridas y observación, según el criterio de cada colaborador. Dos personas en la misma situación pueden priorizar distinto.
**Consecuencia:** resultados inconsistentes entre turnos y tiendas; el conocimiento queda en la cabeza de quien recorre.

### D5 · La reposición compite con tareas más urgentes
Cuatro personas asignadas por tienda, con hasta tres presentes a la vez. Las mismas personas cobran, atienden, reciben proveedores, reponen, controlan inventario y arman pedidos digitales. En la franja de mayor venta, la caja tiene prioridad.
**Consecuencia:** la góndola se vacía más rápido justo cuando hay menos tiempo para reponer.
Dato de referencia (Bonus): 20 reposiciones/día × 8 min = **160 min diarios** sólo de reposición.

### D6 · Trabajo improductivo
Sin saber qué falta, la recorrida incluye pasillos que no lo necesitan, viajes al depósito para buscar mercadería y reposiciones de productos que todavía tenían cobertura.
**Consecuencia:** minutos gastados que no evitan ningún quiebre.

### D7 · Ventas perdidas invisibles
Cuando el cliente no encuentra el producto, la venta no ocurre y no queda rastro. El P&L no muestra una línea de "venta perdida por quiebre".
**Consecuencia:** el costo del problema está subestimado y no compite por recursos.

### D8 · La demanda registrada está distorsionada
Si el arroz estuvo vacío medio día, la venta registrada muestra menos demanda de la real (demanda censurada). Ese dato alimenta las solicitudes de reposición.
**Consecuencia:** el quiebre de hoy genera pedidos más bajos mañana. Conecta directamente con el Desafío 01.

### D9 · Stock teórico posiblemente inexacto
El stock teórico se calcula a partir de ventas. Mermas, roturas, robos o errores de recepción no registrados hacen que el sistema crea tener unidades que no existen.
**Consecuencia:** incluso con visibilidad góndola/depósito, el dato de base puede ser falso. Conviene validarlo con conteos puntuales.

### D10 · No escala con la expansión
El modelo depende del criterio local. Pasar de 12 a 24 o 32 tiendas multiplica los puntos de falla sin mayor visibilidad central.
**Consecuencia:** cualquier solución tiene que ser replicable sin depender del "buen encargado".

---

## 3. Lectura del escenario de RF-03 (15 minutos disponibles)

Supuesto: horario de 10 h/día (referencia del Bonus) y venta pareja durante el día. En una franja de alta demanda el ritmo real es mayor, por lo que estas coberturas son **optimistas**.

| Producto | Góndola | Depósito | Venta/día | Venta/hora | Cobertura en góndola | Tiempo reposición | Unidades vendidas por minuto invertido |
|---|---|---|---|---|---|---|---|
| Arroz 1 kg | 0 | 30 | 12 | 1,2 | **0 h (quiebre activo)** | 8 min | 1,5 |
| Agua 1,5 L | 4 | 48 | 18 | 1,8 | **~2,2 h** | 6 min | 3,0 |
| Shampoo 400 ml | 2 | 12 | 4 | 0,4 | ~5 h | 7 min | 0,6 |

**Hechos clave:**
- Reponer los tres requiere **21 min**; hay **15**. Hay que elegir.
- Combinaciones posibles: Arroz + Agua = 14 min · Arroz + Shampoo = 15 min · Agua + Shampoo = 13 min.
- El arroz ya está perdiendo ventas; el agua es el producto de mayor rotación y se vacía antes del fin de la franja; el shampoo tiene medio día de cobertura.
- **Prioridad defendible: Arroz → Agua (14 min), con 1 min de margen.** El shampoo pasa a la siguiente ventana.
- Restricción no informada: capacidad de góndola. Es probable que las 48 unidades de agua no entren; reponer "todo" no es el objetivo, sino llenar hasta la capacidad.

Esto muestra el criterio que la propuesta tiene que formalizar: **urgencia** (horas hasta quiebre) × **impacto** (venta/hora, margen) ÷ **costo** (minutos).

---

## 4. Factores a tener en cuenta

### 4.1 Restricciones duras
- **Tiempo:** 15 min de personal en la franja; el colaborador debe seguir disponible para tareas críticas (caja, atención).
- **Capacidad de góndola:** limita cuánto se puede reponer por intervención.
- **Personal:** sin aumento de dotación. Cualquier propuesta que sume tareas debe quitar otras.
- **Tecnología actual:** stock consolidado de noche, sin dato góndola/depósito. No asumir sistemas que Red Faro no tiene.

### 4.2 Criterios de priorización a definir
| Criterio | Pregunta | Dato necesario |
|---|---|---|
| Urgencia | ¿Cuánto falta para que se vacíe? | Unidades en góndola ÷ venta/hora |
| Impacto | ¿Cuánto se pierde por hora vacía? | Venta/hora × precio o margen |
| Costo | ¿Cuántos minutos lleva? | Tiempo de reposición por SKU |
| Sustituibilidad | ¿El cliente compra otra marca o se va? | Rol de categoría (básico vs. especialidad) |
| Disponibilidad en depósito | ¿Hay con qué reponer? | Stock en depósito |

Falta información de **precios y márgenes por SKU**; hay que declararlo como supuesto (por ejemplo, margen bruto promedio del 30%).

### 4.3 No todo quiebre es una venta perdida
Ante un faltante, el cliente puede sustituir por otra marca o tamaño, postergar la compra, comprar en otro comercio o no comprar. Sólo las dos últimas son pérdida directa para Red Faro.
Referencia bibliográfica para usar con cautela y validar: Gruen, Corsten y Bharadwaj (2002), estudio global sobre quiebres en retail, reportan una tasa promedio de quiebre cercana al 8% y que una parte relevante de los clientes sustituye en la misma tienda. Las propuestas deben estimar la venta recuperable con un **factor de pérdida** explícito, no asumir el 100%.

### 4.4 Simplicidad y aplicabilidad (20% de la nota)
- Tiene que poder usarlo un equipo de 3–4 personas multitarea, sin capacitación larga.
- Preferir soluciones de bajo costo: umbral mínimo de exhibición por SKU, registro de quiebre desde el celular o una planilla, lista de reposición priorizada por franja.
- RFID, sensores o visión computacional pueden mencionarse como evolución, no como punto de partida.

### 4.5 Medición (Impacto 35% + Validación 15%)
Indicadores sugeridos por el caso, con definición operativa:

| Indicador | Definición | Hoy |
|---|---|---|
| Tiempo de góndola vacía | Horas acumuladas en 0 por SKU y día | No se mide (D3) |
| Quiebres evitados | Reposiciones hechas antes de llegar a 0 | No se mide |
| Minutos de reposición | Tiempo total y por intervención | Estimado: 160 min/día |
| Ventas recuperables | Horas vacías × venta/hora × factor de pérdida | Invisible (D7) |
| % de tareas críticas completadas | Tareas prioritarias hechas en su ventana / total | No existe la lista |

Para el antes/después alcanza con dos o tres de estos, con supuestos y límites explícitos.

### 4.6 Orden de magnitud económico
Base del P&L mensual (12 tiendas): ventas 1.200.000 UM, margen bruto 30%, resultado operativo 78.000 UM.

| Recuperación de ventas por menos quiebres | Ventas extra/mes | Margen bruto extra/mes | Efecto sobre resultado operativo |
|---|---|---|---|
| 0,5% | 6.000 UM | 1.800 UM | +2,3% |
| 1,0% | 12.000 UM | 3.600 UM | +4,6% |
| 2,0% | 24.000 UM | 7.200 UM | +9,2% |

Supuestos: margen bruto constante, sin costo adicional de personal (se reorganiza el tiempo existente). Son escenarios para dimensionar, no resultados. Por tienda compacta, 1% equivale a ~850 UM/mes de venta.

### 4.7 Interdependencias con otros desafíos
- **Desafío 01 (abastecimiento):** los quiebres de góndola distorsionan la demanda registrada (D8). Registrar quiebres mejora los pedidos.
- **Desafío 03 (mermas):** al reponer perecederos aplicar FEFO (primero lo que vence antes al frente).
- **Bonus (modelo operativo):** la reposición es una de las cargas que compiten por el mismo personal; la propuesta debe liberar tiempo, no agregarlo.

### 4.8 Validación y piloto
- Piloto acotado: RF-03, una categoría o un conjunto de SKU de alta rotación, 2–4 semanas.
- Línea base: una semana de registro manual de quiebres (hora de vaciado y de reposición) antes de cambiar el proceso.
- Datos que faltan: precio y margen por SKU, capacidad de góndola, curva de venta por hora, exactitud del stock teórico (conteo cíclico).
- Criterio de éxito definido de antemano (por ejemplo, −30% de horas de góndola vacía en los SKU piloto sin aumentar minutos de reposición).

---

## 5. Riesgos y trampas a evitar
- Proponer una plataforma completa en lugar de una decisión clara (el caso lo penaliza explícitamente).
- Resolver el problema de abastecimiento (Desafío 01) en vez del de ejecución en tienda.
- Asumir que todo quiebre es venta perdida.
- Agregar tareas de registro que el personal no puede sostener en hora pico.
- Presentar estimaciones como resultados comprobados.
- Ignorar la capacidad de góndola y la exactitud del stock teórico.

---

## 6. Resumen para el equipo
1. **Dolor central:** visibilidad cero entre depósito y góndola, sin registro de quiebres.
2. **Dolor operativo:** reposición reactiva, compitiendo con caja en la franja de mayor demanda.
3. **Dolor económico:** ventas perdidas invisibles y demanda distorsionada.
4. **Factor decisivo:** priorizar por urgencia × impacto ÷ minutos, dentro de capacidad de góndola y tiempo disponible.
5. **Prueba rápida del criterio:** en RF-03, Arroz + Agua en 14 de 15 minutos; Shampoo a la siguiente ventana.
