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
| T1 | S1, S3 | Esquema SQL + seed + dominio TS + tests vitest/PGlite | inline | ✅ hecho | 9b849a5 |
| T2 | S1, S2 | Route handlers API + broadcast + cron tick | inline | ✅ hecho | 6ee4767 + fix |
| T3 | S2 | Pantallas repositor/encargado en React + cliente realtime | delegado (writer en paralelo con T1: superficies disjuntas, varios archivos) | ✅ hecho | b695ee1 |
| T4 | S1 | README de deploy (Supabase + Vercel), quitar Python | inline | ✅ hecho | 6c5c480 |

## Log

- **L1** (2026-11-16, verbatim): "no podes migrarlo a nextjs?"
- **L2** (2026-11-16, verbatim): "pasalo a supabase la db; lo deployamos en vercel y pongo las keys de supabase ahi"
- **L3**: Decisiones de arquitectura arriba. Docs verificadas: Supabase `channel.httpSend()` (supabase-js ≥ 2.76) y `POST /realtime/v1/api/broadcast/{topic}/events/{event}`.
- **L4**: Verificación: 28 tests vitest sobre PGlite (dominio §12, rutas con códigos HTTP, cron con secreto, publish nunca falla tras commit). `next build` OK. E2E local con `DATABASE_URL=pglite://memory` + capturas de ambas pantallas. Bug encontrado: `random()` en un WHERE del seed de historial se evaluaba una vez por franja → sorteo en CTE materializado + test de distribución.
- **L5**: RDD: la revisión del cambio completo se detuvo con `lens_context_budget_exceeded` (package-lock) → revisión del tramo API/UI (base 9b849a5, lentes risk + resilience): **aprobada y acusada** (lineage review-1ae041eeedd9ea22). Hallazgos no bloqueantes: corregidos R4-publish-on-commit-path y R1-no-body-size-limit; pendientes como trabajo futuro: escritura sin autenticación (R1), broadcast público falsificable con la anon key (R1), aviso urgente solo por tiempo real y no por polling (R4), cola offline que descarta conteos ante 5xx (R4, preexistente).
- **L6**: Pendiente del usuario: crear proyecto Supabase, ejecutar SQL, cargar variables en Vercel y deploy (README).
