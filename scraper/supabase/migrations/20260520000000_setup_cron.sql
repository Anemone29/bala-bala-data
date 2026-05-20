-- pg_cron schedule for the scrape-intraday Edge Function.
-- Triggers every 15 minutes during BEI trading hours (WIB):
--   Mon-Thu  09:00-12:00 and 13:30-15:30
--   Fri      09:00-11:30 and 14:00-15:30
-- WIB = UTC+7, so subtract 7 hours for the cron expression below.
--
-- Before applying, set the two project secrets used inside the function call:
--   alter database postgres set "app.settings.edge_function_url"
--     = 'https://<project-ref>.supabase.co/functions/v1/scrape-intraday';
--   alter database postgres set "app.settings.edge_function_key"
--     = '<service-role-or-anon-key>';

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unschedule any previous version of this job so re-running the migration is idempotent.
do $$
declare
  jid bigint;
begin
  for jid in select jobid from cron.job where jobname like 'scrape-intraday-%' loop
    perform cron.unschedule(jid);
  end loop;
end $$;

-- Helper that POSTs to the Edge Function with the service-role auth header.
create or replace function public.trigger_scrape_intraday()
returns void
language plpgsql
security definer
as $$
declare
  fn_url text := current_setting('app.settings.edge_function_url', true);
  fn_key text := current_setting('app.settings.edge_function_key', true);
begin
  if fn_url is null or fn_key is null then
    raise exception 'edge_function_url / edge_function_key not configured';
  end if;
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || fn_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;

-- Morning session: 09:00-12:00 WIB == 02:00-05:00 UTC, every 15 min.
select cron.schedule(
  'scrape-intraday-morning',
  '0,15,30,45 2-4 * * 1-5',
  $$select public.trigger_scrape_intraday()$$
);
-- Cover 05:00 UTC (12:00 WIB) close-of-morning tick.
select cron.schedule(
  'scrape-intraday-morning-close',
  '0 5 * * 1-5',
  $$select public.trigger_scrape_intraday()$$
);

-- Afternoon session: Mon-Thu 13:30-15:30 WIB == 06:30-08:30 UTC.
select cron.schedule(
  'scrape-intraday-afternoon-mt',
  '30,45 6 * * 1-4',
  $$select public.trigger_scrape_intraday()$$
);
select cron.schedule(
  'scrape-intraday-afternoon-mt-2',
  '0,15,30,45 7-8 * * 1-4',
  $$select public.trigger_scrape_intraday()$$
);

-- Afternoon session: Fri 14:00-15:30 WIB == 07:00-08:30 UTC.
select cron.schedule(
  'scrape-intraday-afternoon-fri',
  '0,15,30,45 7-8 * * 5',
  $$select public.trigger_scrape_intraday()$$
);
