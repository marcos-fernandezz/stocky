# Feature: nextjs-supabase-migration
Migrar el MVP (Python stdlib + SQLite) a Next.js en Vercel con base de datos en Supabase, sin cambiar el comportamiento de spec-00.
Rama: `feat/nextjs-supabase` · Entrega: ask-on-risk · Tests: `npm test` (vitest + PGlite, Postgres en proceso).

## Specs

- **S1** — "pasalo a supabase la db; lo deployamos en vercel y pongo las keys de supabase ahi" → Postgres de Supabase como única base; configuración solo por variables de entorno que el usuario carga en Vercel.
- **S2** — "no podes migrarlo a nextjs?" → Next.js (App Router, TypeScript) reemplaza al servidor Python y a las páginas HTML.
- **S3** — El comportamiento de spec-00 (RF-01..RF-06, §12) se mantiene: se portan los 24 tests.

Decisiones (L3): tiempo real con Supabase Realtime **Broadcast** (el servidor publica vía REST, el cliente escucha con la anon key; no se exponen tablas). Revisión periódica con `pg_cron` + `pg_net` llamando a `/api/cron/tick` cada minuto (Vercel Cron Hobby corre como máximo una vez por día). Concurrencia: transacción + `pg_advisory_xact_lock` por sucursal (varias funciones serverless en paralelo).

## Tasks

| ID | Specs | Qué | Ruta | Estado | Commit |
|---|---|---|---|---|---|
| T1 | S1, S3 | Esquema SQL + seed + dominio TS + tests vitest/PGlite | inline | pendiente | — |
| T2 | S1, S2 | Route handlers API + broadcast + cron tick | inline | pendiente | — |
| T3 | S2 | Pantallas repositor/encargado en React + cliente realtime | delegado (writer en paralelo con T1: superficies disjuntas, varios archivos) | pendiente | — |
| T4 | S1 | README de deploy (Supabase + Vercel), quitar Python | inline | pendiente | — |

## Log

- **L1** (2026-11-16, verbatim): "no podes migrarlo a nextjs?"
- **L2** (2026-11-16, verbatim): "pasalo a supabase la db; lo deployamos en vercel y pongo las keys de supabase ahi"
- **L3**: Decisiones de arquitectura arriba. Docs verificadas: Supabase `channel.httpSend()` (supabase-js ≥ 2.76) y `POST /realtime/v1/api/broadcast/{topic}/events/{event}`.
