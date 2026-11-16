# Stocky · stock en góndola y alertas de reposición

MVP del Equipo 2 para el Desafío 02 del Hackatón Retail Chain 4.0 (caso Red Faro).
Especificación vigente: [`specs/spec-01-rondas-por-periodo.md`](specs/spec-01-rondas-por-periodo.md)
(reemplaza el modelo de stock estimado de [`spec-00`](specs/spec-00-reposicion-gondola.md)).

El encargado define cuántas **pasadas** por día hace el repositor; el horario se divide en períodos y en cada uno
el repositor recibe un aviso de **ronda**. El **umbral** de cada producto es su promedio de ventas en ese período
(últimas 4 semanas, mismo día). Si un producto vende mucho menos de lo esperado, se alerta para **revisar la góndola**.
El repositor marca los quiebres: *Estaba OK*, *Vacía · repuse* o *Sin stock* (escala al encargado).

**Stack:** Next.js 16 (App Router) en Vercel · Postgres de Supabase · Supabase Realtime (Broadcast) · `pg_cron`.

## Deploy (Supabase + Vercel)

### 1. Supabase
1. Crear un proyecto.
2. **SQL Editor** → ejecutar en orden:
   - `supabase/migrations/0001_init.sql` y `supabase/migrations/0002_rondas.sql` (esquema)
   - `supabase/seed.sql` (datos del pizarrón: S1 Leche/Arroz/Agua/Carne · S2 Leche)
   - `supabase/seed_history.sql` (opcional: 4 semanas de ventas sintéticas para que haya umbral por período)
3. Anotar:
   - **Project Settings → Database → Connection string → Transaction pooler** (puerto 6543) → `DATABASE_URL`
   - **Project Settings → API** → URL, `anon` key y `service_role` key

### 2. Vercel
1. Importar el repositorio (framework: Next.js, sin configuración extra).
2. **Settings → Environment Variables** (Production y Preview):

| Variable | Valor |
|---|---|
| `DATABASE_URL` | Connection string del *transaction pooler* (con la contraseña de la base) |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key (pública: solo se usa para escuchar el canal de tiempo real) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**secreta**: solo la usa el servidor para publicar eventos) |
| `CRON_SECRET` | Cualquier texto largo aleatorio (`openssl rand -hex 32`) |

3. Deploy (las variables `NEXT_PUBLIC_*` se fijan en el build: si las cambiás, redeployá).

### 3. Revisión periódica cada minuto
En Supabase → SQL Editor, ejecutar `supabase/cron.sql` reemplazando `<APP_URL>` por el dominio de **producción** de Vercel
y `<CRON_SECRET>` por el mismo valor de Vercel. Abre la ronda de cada período y detecta ventas anómalas.
Sin este paso no hay rondas ni alertas de venta anómala.

### Verificar
- `https://<app>/repositor` en el celular y `https://<app>/encargado` en la compu.
- El punto del encabezado se pone **verde** cuando el tiempo real está conectado.
- Si queda rojo: revisar `NEXT_PUBLIC_SUPABASE_*` y que en Supabase → Realtime → Settings **no** esté activado "solo canales privados".

## Desarrollo local

```bash
npm install
cp .env.example .env.local          # con las keys de Supabase, o:
DATABASE_URL=pglite://memory npm run dev   # sin Supabase: Postgres en memoria con seed + historial
npm test                            # 26 tests (dominio, rutas, tiempo real) sobre Postgres en proceso (PGlite)
npm run simulate -- --url http://localhost:3000 --sucursal S1 --cada 2   # caja simulada
```

Con `pglite://memory` los datos viven mientras corre el proceso y no hay tiempo real (las pantallas se refrescan cada 30 s).
Sirve también como plan B offline en el hackatón.

## Guion de demo (spec-01)
Con el historial cargado (`pglite://memory` lo trae) y el tick corriendo:
1. Encargado: **Pasadas por día** = 3 → el período actual aparece como "Pasada N de 3".
2. Repositor: llega el aviso **Hora de la pasada**; cada producto muestra "Dejá al menos N". **Terminé la pasada**.
3. Sin ventas en el período, la leche (umbral ~8) aparece en **Revisar góndola**: "se esperaban ~5 y se vendieron 0".
4. Repositor: **Sin stock** → el encargado recibe el aviso. Encargado: −1 de leche → la venta cierra el quiebre.

## API

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/api/sucursales/{s}/reportes` | `{producto_id, resultado: OK\|REPUSE\|SIN_STOCK, repositor_id}` |
| `POST` | `/api/ventas` | `{comprobante_id, sucursal_id, emitido_at, tipo?: VENTA\|ANULACION, comprobante_ref?, lineas:[{linea, producto_id, cantidad}]}` |
| `GET` | `/api/sucursales` | Sucursales |
| `GET/PATCH` | `/api/sucursales/{s}` | Configuración: `{pasadas_por_dia, apertura, cierre}` |
| `GET` | `/api/sucursales/{s}/productos` | Estado, umbral y esperado del período, vendido y alertas por producto |
| `GET` | `/api/sucursales/{s}/ronda` | Período actual, ronda abierta y alertas para el repositor |
| `GET` | `/api/sucursales/{s}/alertas?destinatario=` | Alertas abiertas |
| `PATCH` | `/api/alertas/{id}` | `{estado: "ATENDIDA", por}` (pasada hecha) o descartar con `{motivo}` |
| `GET/POST` | `/api/cron/tick` | Revisión periódica (`Authorization: Bearer $CRON_SECRET`) |

Tiempo real: canal Broadcast `sucursal:<id>` con eventos `producto.actualizado`, `alerta.creada`, `alerta.cerrada`.
Horarios: ISO local de Argentina (`YYYY-MM-DDTHH:MM:SS`); los valores con zona horaria se convierten.

## Estructura

```
src/lib/stock.ts        dominio: períodos, ventas atómicas, umbral, rondas, quiebres y alertas
src/lib/db.ts           acceso a Postgres (Supabase) y PGlite (tests / modo local)
src/lib/realtime.ts     publica eventos (servidor) · realtime-client.ts los escucha (navegador)
src/app/api/**          rutas de la API
src/components/         pantallas del repositor y del encargado
supabase/               esquema, seeds y cron
tests/                  vitest + PGlite
```

## Límites del MVP

- **Sin autenticación:** cualquiera con la URL puede registrar reportes, ventas y cambiar la configuración. Antes de usarlo con datos reales: login para repositores y una API key para la caja.
- El aviso es una notificación del navegador (la pantalla del repositor debe estar abierta); push nativo queda para producción.
- En producción, la caja de Red Faro debe enviar cada comprobante al emitirlo (hoy consolida a medianoche).
