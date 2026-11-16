-- Every minute, Supabase calls the app's periodic re-evaluation (hour-slot thresholds, stale counts, R3).
-- Vercel Cron on the Hobby plan runs at most once a day, so the schedule lives in the database.
-- Replace <APP_URL> with the PRODUCTION domain (preview URLs are behind Vercel Authentication)
-- and <CRON_SECRET> with the same value set in Vercel. Run in Supabase → SQL Editor.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('stocky-tick') where exists (select 1 from cron.job where jobname = 'stocky-tick');

select cron.schedule(
  'stocky-tick',
  '* * * * *',
  $$
  select net.http_get(
    url := '<APP_URL>/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  );
  $$
);

-- Check: select status_code, created from net._http_response order by created desc limit 5;
