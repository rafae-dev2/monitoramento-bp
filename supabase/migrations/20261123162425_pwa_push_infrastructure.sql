-- Infraestrutura privada de Web Push para o PWA.
-- O schema não deve ser incluído nos schemas expostos pelo PostgREST. Toda
-- operação de aplicação passa pela RPC public.pwa_push_rpc, autenticada pelo
-- segredo armazenado posteriormente no Supabase Vault.

create schema if not exists pwa_private;
revoke all on schema pwa_private from public, anon, authenticated, service_role;

create table if not exists pwa_private.pwa_push_subscriptions (
  device_id uuid primary key,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  baseline_complete boolean not null default false,
  constraint pwa_push_subscriptions_endpoint_nonempty check (length(btrim(endpoint)) > 0),
  constraint pwa_push_subscriptions_p256dh_nonempty check (length(btrim(p256dh)) > 0),
  constraint pwa_push_subscriptions_auth_nonempty check (length(btrim(auth)) > 0),
  constraint pwa_push_subscriptions_preferences_object check (jsonb_typeof(preferences) = 'object')
);

comment on table pwa_private.pwa_push_subscriptions is
  'Web Push subscriptions and per-device preferences; private to the definer RPC.';

create table if not exists pwa_private.pwa_push_occurrences (
  episode_id uuid primary key default gen_random_uuid(),
  alarm_key text not null,
  external_id text not null,
  payload jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  constraint pwa_push_occurrences_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint pwa_push_occurrences_alarm_key_nonempty check (length(btrim(alarm_key)) > 0),
  constraint pwa_push_occurrences_external_id_nonempty check (length(btrim(external_id)) > 0)
);

comment on table pwa_private.pwa_push_occurrences is
  'Idempotent alarm episodes; one unresolved episode per official alarm_key.';

create unique index if not exists pwa_push_occurrences_one_active_alarm_uq
  on pwa_private.pwa_push_occurrences (alarm_key)
  where resolved_at is null;
create index if not exists pwa_push_occurrences_active_seen_idx
  on pwa_private.pwa_push_occurrences (first_seen_at)
  where resolved_at is null;

create table if not exists pwa_private.pwa_push_deliveries (
  occurrence_id uuid not null
    references pwa_private.pwa_push_occurrences (episode_id) on delete cascade,
  device_id uuid not null
    references pwa_private.pwa_push_subscriptions (device_id) on delete cascade,
  status text not null,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (occurrence_id, device_id),
  constraint pwa_push_deliveries_status_check
    check (status in ('sending', 'sent', 'failed', 'filtered', 'baseline_suppressed')),
  constraint pwa_push_deliveries_attempts_check check (attempts between 0 and 3)
);

comment on table pwa_private.pwa_push_deliveries is
  'Per-episode/device deduplication, delivery state, retry timing, and baseline suppression.';

create index if not exists pwa_push_deliveries_retry_idx
  on pwa_private.pwa_push_deliveries (next_attempt_at)
  where status = 'failed';

create table if not exists pwa_private.pwa_push_monitor_state (
  singleton boolean primary key default true check (singleton),
  baseline_complete boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table pwa_private.pwa_push_monitor_state is
  'Singleton coordination row serializing official alarm synchronization and global baseline.';

insert into pwa_private.pwa_push_monitor_state (singleton, baseline_complete)
values (true, false)
on conflict (singleton) do nothing;

-- No direct table access for API roles (including service_role); the RPC owner
-- performs the necessary reads and writes under SECURITY DEFINER.
revoke all privileges on table
  pwa_private.pwa_push_subscriptions,
  pwa_private.pwa_push_occurrences,
  pwa_private.pwa_push_deliveries,
  pwa_private.pwa_push_monitor_state
from public, anon, authenticated, service_role;

alter table pwa_private.pwa_push_subscriptions enable row level security;
alter table pwa_private.pwa_push_occurrences enable row level security;
alter table pwa_private.pwa_push_deliveries enable row level security;
alter table pwa_private.pwa_push_monitor_state enable row level security;
-- Intentionally create no RLS policies: callers cannot access private tables directly.

create or replace function public.pwa_push_rpc(
  p_secret text,
  p_action text,
  p_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pwa_private
as $pwa_push_rpc$
declare
  v_rpc_secret text;
  v_device_id uuid;
  v_occurrence_id uuid;
  v_alarm_key text;
  v_external_id text;
  v_endpoint text;
  v_p256dh text;
  v_auth text;
  v_preferences jsonb;
  v_payload jsonb;
  v_started_at timestamptz;
  v_alarm jsonb;
  v_existing_external_id text;
  v_existing_episode_id uuid;
  v_monitor_baseline boolean;
  v_initial_baseline boolean;
  v_active_occurrences jsonb := '[]'::jsonb;
  v_pending_deliveries jsonb := '[]'::jsonb;
  v_subscriptions jsonb := '[]'::jsonb;
  v_status text;
  v_attempts integer;
  v_changed integer;
  v_count integer;
  v_error text;
begin
  -- Vault lookup is deliberately inside this function only. Missing Vault,
  -- missing secret, and incorrect secret all return the same response.
  begin
    select s.decrypted_secret
      into v_rpc_secret
      from vault.decrypted_secrets as s
     where s.name = 'pwa_push_rpc_auth'
     limit 1;
  exception when others then
    v_rpc_secret := null;
  end;

  if v_rpc_secret is null or length(v_rpc_secret) = 0
     or p_secret is null or p_secret is distinct from v_rpc_secret then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if p_action is null or p_data is null or jsonb_typeof(p_data) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_data');
  end if;

  case p_action
    when 'upsert_subscription' then
      if nullif(btrim(p_data->>'deviceId'), '') is null
         or nullif(btrim(p_data->>'endpoint'), '') is null
         or nullif(btrim(p_data->>'p256dh'), '') is null
         or nullif(btrim(p_data->>'auth'), '') is null
         or jsonb_typeof(p_data->'prefs') is distinct from 'object' then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;

      if length(p_data->>'deviceId') > 36
         or length(p_data->>'endpoint') > 8192
         or (p_data->>'endpoint') !~ '^https://[^[:space:]]+$'
         or length(p_data->>'p256dh') > 1024
         or length(p_data->>'auth') > 1024
         or octet_length((p_data->'prefs')::text) > 65536 then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;

      v_device_id := (p_data->>'deviceId')::uuid;
      v_endpoint := p_data->>'endpoint';
      v_p256dh := p_data->>'p256dh';
      v_auth := p_data->>'auth';
      v_preferences := p_data->'prefs';

      -- Serialize subscription creation/endpoint replacement with the global
      -- baseline pass, so no device is marked complete before it is included.
      perform 1
        from pwa_private.pwa_push_monitor_state as state
       where state.singleton is true
       for update;

      insert into pwa_private.pwa_push_subscriptions as existing
        (device_id, endpoint, p256dh, auth, preferences)
      values
        (v_device_id, v_endpoint, v_p256dh, v_auth, v_preferences)
      on conflict (device_id) do update
        set endpoint = excluded.endpoint,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            preferences = excluded.preferences,
            created_at = case
              when existing.endpoint is distinct from excluded.endpoint then clock_timestamp()
              else existing.created_at
            end,
            baseline_complete = case
              when existing.endpoint is distinct from excluded.endpoint then false
              else existing.baseline_complete
            end,
            updated_at = clock_timestamp();

      return jsonb_build_object('ok', true);

    when 'update_preferences' then
      if nullif(btrim(p_data->>'deviceId'), '') is null
         or jsonb_typeof(p_data->'prefs') is distinct from 'object'
         or octet_length((p_data->'prefs')::text) > 65536 then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;

      v_device_id := (p_data->>'deviceId')::uuid;
      v_preferences := p_data->'prefs';

      update pwa_private.pwa_push_subscriptions
         set preferences = v_preferences,
             updated_at = clock_timestamp()
       where device_id = v_device_id;
      get diagnostics v_changed = row_count;

      if v_changed = 0 then
        return jsonb_build_object('ok', false, 'error', 'not_found');
      end if;

      -- Filtered outcomes are preference-dependent. Clear only active episodes
      -- so the next synchronization can queue them for evaluation again.
      delete from pwa_private.pwa_push_deliveries as d
       using pwa_private.pwa_push_occurrences as o
       where d.occurrence_id = o.episode_id
         and d.device_id = v_device_id
         and d.status = 'filtered'
         and o.resolved_at is null;

      return jsonb_build_object('ok', true);

    when 'delete_subscription' then
      if nullif(btrim(p_data->>'deviceId'), '') is null
         or length(p_data->>'deviceId') > 36 then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;
      v_device_id := (p_data->>'deviceId')::uuid;
      delete from pwa_private.pwa_push_subscriptions where device_id = v_device_id;
      get diagnostics v_changed = row_count;
      return jsonb_build_object('ok', true, 'removed', v_changed > 0);

    when 'remove_subscription' then
      -- Used after a push provider returns HTTP 404 or 410. FK cascade removes
      -- its delivery dedupe rows; repeating this operation is harmless.
      if nullif(btrim(p_data->>'deviceId'), '') is null
         or length(p_data->>'deviceId') > 36 then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;
      v_device_id := (p_data->>'deviceId')::uuid;
      delete from pwa_private.pwa_push_subscriptions where device_id = v_device_id;
      get diagnostics v_changed = row_count;
      return jsonb_build_object('ok', true, 'removed', v_changed > 0);

    when 'list_subscriptions' then
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'deviceId', s.device_id,
                   'endpoint', s.endpoint,
                   'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth),
                   'preferences', s.preferences,
                   'createdAt', s.created_at,
                   'baselineComplete', s.baseline_complete
                 ) order by s.created_at, s.device_id
               ),
               '[]'::jsonb
             )
        into v_subscriptions
        from pwa_private.pwa_push_subscriptions as s;
      return jsonb_build_object('ok', true, 'subscriptions', v_subscriptions);

    when 'has_subscriptions' then
      return jsonb_build_object(
        'ok', true,
        'hasSubscriptions', exists (
          select 1 from pwa_private.pwa_push_subscriptions as s
        )
      );

    when 'synchronize_alarms' then
      if jsonb_typeof(p_data->'alarms') is distinct from 'array' then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;

      v_count := jsonb_array_length(p_data->'alarms');
      if v_count > 5000 then
        return jsonb_build_object('ok', false, 'error', 'too_many_alarms');
      end if;

      -- Validate before mutating rows. Duplicate alarmKey values are accepted
      -- but collapsed to the last supplied entry below, preventing duplicate
      -- episodes in a single official snapshot.
      if exists (
        select 1
          from jsonb_array_elements(p_data->'alarms') as a(value)
         where jsonb_typeof(a.value) is distinct from 'object'
            or nullif(btrim(a.value->>'alarmKey'), '') is null
            or length(a.value->>'alarmKey') > 512
            or nullif(btrim(a.value->>'externalId'), '') is null
            or length(a.value->>'externalId') > 512
            or (a.value ? 'payload' and a.value->'payload' <> 'null'::jsonb
                and jsonb_typeof(a.value->'payload') is distinct from 'object')
      ) then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;

      -- A singleton row lock serializes synchronizations, episode closure, and
      -- baseline establishment across concurrent monitor invocations.
      insert into pwa_private.pwa_push_monitor_state (singleton, baseline_complete)
      values (true, false)
      on conflict (singleton) do nothing;

      select s.baseline_complete
        into v_monitor_baseline
        from pwa_private.pwa_push_monitor_state as s
       where s.singleton is true
       for update;
      v_initial_baseline := not v_monitor_baseline;

      -- Resolve every active key absent from this complete official snapshot.
      update pwa_private.pwa_push_occurrences as o
         set resolved_at = clock_timestamp(),
             last_seen_at = clock_timestamp()
       where o.resolved_at is null
         and not exists (
           select 1
             from jsonb_array_elements(p_data->'alarms') as a(value)
            where btrim(a.value->>'alarmKey') = o.alarm_key
         );

      -- One input record per key (last occurrence wins). An external ID change
      -- closes the prior episode and creates a fresh UUID episode.
      for v_alarm in
        select d.value
          from (
            select a.value,
                   a.ordinality,
                   row_number() over (
                     partition by btrim(a.value->>'alarmKey')
                     order by a.ordinality desc
                   ) as rn
              from jsonb_array_elements(p_data->'alarms') with ordinality as a(value, ordinality)
          ) as d
         where d.rn = 1
         order by btrim(d.value->>'alarmKey')
      loop
        v_alarm_key := btrim(v_alarm->>'alarmKey');
        v_external_id := btrim(v_alarm->>'externalId');
        v_payload := case
          when v_alarm->'payload' is null or v_alarm->'payload' = 'null'::jsonb then '{}'::jsonb
          else v_alarm->'payload'
        end;
        v_started_at := nullif(v_alarm->>'startedAt', '')::timestamptz;

        select o.episode_id, o.external_id
          into v_existing_episode_id, v_existing_external_id
          from pwa_private.pwa_push_occurrences as o
         where o.alarm_key = v_alarm_key
           and o.resolved_at is null
         for update;

        if found and v_existing_external_id is distinct from v_external_id then
          update pwa_private.pwa_push_occurrences
             set resolved_at = clock_timestamp(),
                 last_seen_at = clock_timestamp()
           where episode_id = v_existing_episode_id;
          v_existing_episode_id := null;
        end if;

        if v_existing_episode_id is null then
          insert into pwa_private.pwa_push_occurrences
            (alarm_key, external_id, payload, started_at, first_seen_at, last_seen_at)
          values
            (v_alarm_key, v_external_id, v_payload, v_started_at, clock_timestamp(), clock_timestamp());
        else
          update pwa_private.pwa_push_occurrences
             set payload = v_payload,
                 started_at = coalesce(started_at, v_started_at),
                 last_seen_at = clock_timestamp()
           where episode_id = v_existing_episode_id;
        end if;
      end loop;

      -- First global sync is intentionally silent for every currently active
      -- episode, preventing a deployment-time notification burst. In later
      -- syncs, only a not-yet-baselined device receives silent baseline rows,
      -- and only for occurrences predating (or lacking) its created_at time.
      insert into pwa_private.pwa_push_deliveries as existing
        (occurrence_id, device_id, status, attempts, created_at, updated_at)
      select o.episode_id,
             s.device_id,
             'baseline_suppressed',
             0,
             clock_timestamp(),
             clock_timestamp()
        from pwa_private.pwa_push_occurrences as o
        cross join pwa_private.pwa_push_subscriptions as s
       where o.resolved_at is null
         and (
           v_initial_baseline
           or (
             not s.baseline_complete
             and (o.started_at is null or o.started_at <= s.created_at)
           )
         )
      on conflict (occurrence_id, device_id) do update
        set status = 'baseline_suppressed',
            attempts = 0,
            last_attempt_at = null,
            next_attempt_at = null,
            sent_at = null,
            last_error = null,
            updated_at = clock_timestamp()
      where existing.status <> 'sent';

      update pwa_private.pwa_push_subscriptions
         set baseline_complete = true,
             updated_at = clock_timestamp()
       where not baseline_complete;

      if v_initial_baseline then
        update pwa_private.pwa_push_monitor_state
           set baseline_complete = true,
               updated_at = clock_timestamp()
         where singleton is true;
        v_active_occurrences := '[]'::jsonb;
        v_pending_deliveries := '[]'::jsonb;
      else
        select coalesce(
                 jsonb_agg(
                   jsonb_build_object(
                     'occurrenceId', o.episode_id,
                     'alarmKey', o.alarm_key,
                     'externalId', o.external_id,
                     'payload', o.payload,
                     'startedAt', o.started_at,
                     'firstSeenAt', o.first_seen_at,
                     'lastSeenAt', o.last_seen_at
                   ) order by o.first_seen_at, o.alarm_key
                 ),
                 '[]'::jsonb
               )
          into v_active_occurrences
          from pwa_private.pwa_push_occurrences as o
         where o.resolved_at is null;

        -- Convert abandoned leases to due failures so this device-level queue
        -- can expose them on the next monitor pass. Five minutes is the lease.
        update pwa_private.pwa_push_deliveries
           set status = 'failed',
               next_attempt_at = clock_timestamp(),
               last_error = left(coalesce(last_error, 'sending lease expired'), 2000),
               updated_at = clock_timestamp()
         where status = 'sending'
           and attempts < 3
           and updated_at <= clock_timestamp() - interval '5 minutes';

        -- Work is returned per device only when no dedupe row exists or a
        -- failed attempt's backoff has elapsed. claim_delivery remains the
        -- atomic guard for overlapping workers and concurrent snapshots.
        select coalesce(
                 jsonb_agg(
                   jsonb_build_object(
                     'occurrenceId', o.episode_id,
                     'deviceId', s.device_id,
                     'endpoint', s.endpoint,
                     'p256dh', s.p256dh,
                     'auth', s.auth,
                     'preferences', s.preferences,
                     'payload', o.payload
                   ) order by o.first_seen_at, s.created_at, s.device_id
                 ),
                 '[]'::jsonb
               )
          into v_pending_deliveries
          from pwa_private.pwa_push_occurrences as o
          cross join pwa_private.pwa_push_subscriptions as s
          left join pwa_private.pwa_push_deliveries as d
            on d.occurrence_id = o.episode_id
           and d.device_id = s.device_id
         where o.resolved_at is null
           and (
             d.occurrence_id is null
             or (
               d.status = 'failed'
               and d.attempts < 3
               and d.next_attempt_at is not null
               and d.next_attempt_at <= clock_timestamp()
             )
           );
      end if;

      return jsonb_build_object(
        'ok', true,
        'initialBaseline', v_initial_baseline,
        'activeOccurrences', v_active_occurrences,
        'pendingDeliveries', v_pending_deliveries
      );

    when 'claim_delivery' then
      if nullif(btrim(p_data->>'occurrenceId'), '') is null
         or nullif(btrim(p_data->>'deviceId'), '') is null
         or length(p_data->>'occurrenceId') > 36
         or length(p_data->>'deviceId') > 36 then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;
      v_occurrence_id := (p_data->>'occurrenceId')::uuid;
      v_device_id := (p_data->>'deviceId')::uuid;

      insert into pwa_private.pwa_push_deliveries
        (occurrence_id, device_id, status, attempts, last_attempt_at, created_at, updated_at)
      select v_occurrence_id,
             v_device_id,
             'sending',
             1,
             clock_timestamp(),
             clock_timestamp(),
             clock_timestamp()
       where exists (
               select 1 from pwa_private.pwa_push_occurrences as o
                where o.episode_id = v_occurrence_id and o.resolved_at is null
             )
         and exists (
               select 1 from pwa_private.pwa_push_subscriptions as s
                where s.device_id = v_device_id
             )
      on conflict (occurrence_id, device_id) do nothing
      returning attempts into v_attempts;

      if found then
        return jsonb_build_object('ok', true, 'claimed', true, 'attempt', v_attempts);
      end if;

      select d.status, d.attempts
        into v_status, v_attempts
        from pwa_private.pwa_push_deliveries as d
       where d.occurrence_id = v_occurrence_id
         and d.device_id = v_device_id
       for update;

      if not found then
        return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'not_found');
      end if;

      if not exists (
           select 1 from pwa_private.pwa_push_occurrences as o
            where o.episode_id = v_occurrence_id and o.resolved_at is null
         )
         or not exists (
           select 1 from pwa_private.pwa_push_subscriptions as s
            where s.device_id = v_device_id
         ) then
        return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'not_found');
      end if;

      if v_attempts >= 3 then
        return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'attempt_limit');
      end if;

      v_attempts := null;

      if v_status = 'failed' then
        update pwa_private.pwa_push_deliveries
           set status = 'sending',
               attempts = attempts + 1,
               last_attempt_at = clock_timestamp(),
               next_attempt_at = null,
               last_error = null,
               updated_at = clock_timestamp()
         where occurrence_id = v_occurrence_id
           and device_id = v_device_id
           and status = 'failed'
           and attempts < 3
           and next_attempt_at is not null
           and next_attempt_at <= clock_timestamp()
        returning attempts into v_attempts;
      elsif v_status = 'sending' then
        -- A worker that died after claiming releases its lease after five
        -- minutes (well above the required one-minute retry backoff).
        update pwa_private.pwa_push_deliveries
           set attempts = attempts + 1,
               last_attempt_at = clock_timestamp(),
               next_attempt_at = null,
               last_error = null,
               updated_at = clock_timestamp()
         where occurrence_id = v_occurrence_id
           and device_id = v_device_id
           and status = 'sending'
           and attempts < 3
           and updated_at <= clock_timestamp() - interval '5 minutes'
        returning attempts into v_attempts;
      end if;

      if v_attempts is not null then
        return jsonb_build_object('ok', true, 'claimed', true, 'attempt', v_attempts);
      end if;
      return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'not_due');

    when 'complete_delivery' then
      if nullif(btrim(p_data->>'occurrenceId'), '') is null
         or nullif(btrim(p_data->>'deviceId'), '') is null
         or length(p_data->>'occurrenceId') > 36
         or length(p_data->>'deviceId') > 36
         or nullif(btrim(p_data->>'status'), '') is null
         or p_data->>'status' not in ('sent', 'failed', 'filtered') then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;
      v_occurrence_id := (p_data->>'occurrenceId')::uuid;
      v_device_id := (p_data->>'deviceId')::uuid;
      v_status := p_data->>'status';
      v_error := left(coalesce(p_data->>'error', ''), 2000);

      update pwa_private.pwa_push_deliveries as d
         set status = v_status,
             sent_at = case when v_status = 'sent' then clock_timestamp() else null end,
             next_attempt_at = case
               when v_status = 'failed' and d.attempts < 3 then
                 clock_timestamp() + make_interval(mins => case d.attempts
                   when 1 then 1 when 2 then 2 else 4 end)
               else null
             end,
             last_error = case
               when v_status = 'failed' and v_error <> '' then v_error
               else null
             end,
             updated_at = clock_timestamp()
       where d.occurrence_id = v_occurrence_id
         and d.device_id = v_device_id
         and d.status = 'sending';
      get diagnostics v_changed = row_count;
      return jsonb_build_object('ok', true, 'updated', v_changed > 0, 'status', v_status);

    else
      return jsonb_build_object('ok', false, 'error', 'unsupported_action');
  end case;
exception when others then
  -- Do not leak Vault, schema, or parsing details through the public endpoint.
  return jsonb_build_object('ok', false, 'error', 'invalid_data');
end;
$pwa_push_rpc$;

comment on function public.pwa_push_rpc(text, text, jsonb) is
  'Secret-authenticated SECURITY DEFINER RPC for private Web Push subscriptions, alarm episodes, and delivery claims.';

revoke all on function public.pwa_push_rpc(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pwa_push_rpc(text, text, jsonb) to anon, authenticated;
