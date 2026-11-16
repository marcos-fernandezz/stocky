# Stocky · stock en góndola y alertas de reposición

MVP del Equipo 2 para el Desafío 02 del Hackatón Retail Chain 4.0 (caso Red Faro).
Especificación: [`specs/spec-00-reposicion-gondola.md`](specs/spec-00-reposicion-gondola.md).

El repositor informa cuántas unidades dejó en la góndola; cada comprobante de caja las descuenta;
cuando un producto llega a su umbral (calculado por producto y franja horaria), el repositor recibe un aviso urgente.

**Stack:** Next.js 16 (App Router) en Vercel · Postgres de Supabase · Supabase Realtime (Broadcast) · `pg_cron`.

## Deploy (Supabase + Vercel)

### 1. Supabase
1. Crear un proyecto.
2. **SQL Editor** → ejecutar en orden:
   - `supabase/migrations/0001_init.sql` (esquema)
   - `supabase/seed.sql` (datos del pizarrón: S1 Leche/Arroz/Agua/Carne · S2 Leche)
   - `supabase/seed_history.sql` (opcional: 4 semanas de ventas sintéticas para que el umbral varíe por franja)
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
y `<CRON_SECRET>` por el mismo valor de Vercel. Detecta conteos vencidos, productos que dejaron de venderse (R3)
y recalcula umbrales al cambiar de franja. Sin este paso, todo lo demás funciona igual.

### Verificar
- `https://<app>/repositor` en el celular y `https://<app>/encargado` en la compu.
- El punto del encabezado se pone **verde** cuando el tiempo real está conectado.
- Si queda rojo: revisar `NEXT_PUBLIC_SUPABASE_*` y que en Supabase → Realtime → Settings **no** esté activado "solo canales privados".

## Desarrollo local

```bash
npm install
cp .env.example .env.local          # con las keys de Supabase, o:
DATABASE_URL=pglite://memory npm run dev   # sin Supabase: Postgres en memoria con seed + historial
npm test                            # 27 tests (dominio + rutas) sobre Postgres en proceso (PGlite)
npm run simulate -- --url http://localhost:3000 --sucursal S1 --cada 2   # caja simulada
```

Con `pglite://memory` los datos viven mientras corre el proceso y no hay tiempo real (las pantallas se refrescan cada 30 s).
Sirve también como plan B offline en el hackatón.

## Guion de demo (spec-00 §12)
1. Repositor: **Contar** Leche → 12.
2. Encargado: −1 nueve veces → la leche queda "3 de 12", llega el aviso **ALTA**.
3. −1 tres veces más → "0 de 12", el aviso escala a **URGENTE**.
4. Repositor: **Repuse** → 12. La alerta se cierra y el nivel vuelve a 100%.

## API

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/api/sucursales/{s}/conteos` | `{producto_id, unidades, repositor_id, tipo?, created_at?, confirmar_capacidad?}` |
| `POST` | `/api/ventas` | `{comprobante_id, sucursal_id, emitido_at, tipo?: VENTA\|ANULACION, comprobante_ref?, lineas:[{linea, producto_id, cantidad}]}` |
| `GET` | `/api/sucursales` | Sucursales |
| `GET` | `/api/sucursales/{s}/productos` | Estado, nivel, umbral, depósito y alertas por producto |
| `GET` | `/api/sucursales/{s}/reposicion` | Lista priorizada + minutos totales |
| `GET` | `/api/sucursales/{s}/alertas?destinatario=` | Alertas abiertas |
| `PATCH` | `/api/alertas/{id}` | Descartar con `{motivo}` |
| `GET/POST` | `/api/cron/tick` | Revisión periódica (`Authorization: Bearer $CRON_SECRET`) |

Tiempo real: canal Broadcast `sucursal:<id>` con eventos `producto.actualizado`, `alerta.creada`, `alerta.cerrada`.
Horarios: ISO local de Argentina (`YYYY-MM-DDTHH:MM:SS`); los valores con zona horaria se convierten.

## Estructura

```
src/lib/stock.ts        dominio: conteos, ventas atómicas, umbral, estados y alertas
src/lib/db.ts           acceso a Postgres (Supabase) y PGlite (tests / modo local)
src/lib/realtime.ts     publica eventos (servidor) · realtime-client.ts los escucha (navegador)
src/app/api/**          rutas de la API
src/components/         pantallas del repositor y del encargado
supabase/               esquema, seeds y cron
tests/                  vitest + PGlite
```

## Límites del MVP

- **Sin autenticación:** cualquiera con la URL puede registrar conteos y ventas. Antes de usarlo con datos reales: login para repositores y una API key para la caja.
- El aviso es una notificación del navegador (la pantalla del repositor debe estar abierta); push nativo queda para producción.
- En producción, la caja de Red Faro debe enviar cada comprobante al emitirlo (hoy consolida a medianoche).
