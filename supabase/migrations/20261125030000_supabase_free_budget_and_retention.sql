-- ============================================================================
-- Otimização para Supabase Free (500 MB disco / 5 GB egress / sem pg_cron):
--   1. Cacheia o token SGPA no estado privado do monitor (evita 1.440 logins/dia
--      em cold starts e compartilha a sessão por até 5 dias via Vault RPC);
--   2. Remove o array `activeOccurrences` não utilizado do retorno de
--      `synchronize_alarms`, cortando >95% do egress mensal da função agendada;
--   3. Corrige baseline de novos aparelhos contra relógio de bordo adiantado
--      usando `o.first_seen_at <= s.created_at`;
--   4. Executa limpeza automática horária em lotes limitados (LIMIT 500), sem
--      depender de `pg_cron`, mantendo `pwa_push_occurrences` (14d),
--      `pwa_alertas` (90d) e `pwa_acessos` (60d) sempre enxutos.
-- ============================================================================

alter table pwa_private.pwa_push_monitor_state
  add column if not exists cached_token text,
  add column if not exists cached_unit_id text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists last_cleanup_at timestamptz;

create index if not exists pwa_push_occurrences_resolved_cleanup_idx
  on pwa_private.pwa_push_occurrences (resolved_at)
  where resolved_at is not null;

create or replace function public.pwa_push_rpc(
  p_secret text,
  p_action text,
  p_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pwa_private, public
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
  v_last_cleanup timestamptz;
  v_cached_token text;
  v_cached_unit text;
  v_token_exp timestamptz;
  v_has_subs boolean;
  v_pending_deliveries jsonb := '[]'::jsonb;
  v_subscriptions jsonb := '[]'::jsonb;
  v_status text;
  v_attempts integer;
  v_changed integer;
  v_count integer;
  v_error text;
begin
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

      delete from pwa_private.pwa_push_deliveries as d
       using pwa_private.pwa_push_occurrences as o
       where d.occurrence_id = o.episode_id
         and d.device_id = v_device_id
         and d.status = 'filtered'
         and o.resolved_at is null;

      return jsonb_build_object('ok', true);

    when 'delete_subscription', 'remove_subscription' then
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
      v_has_subs := exists (select 1 from pwa_private.pwa_push_subscriptions);
      if not v_has_subs then
        return jsonb_build_object('ok', true, 'hasSubscriptions', false);
      end if;

      select m.cached_token, m.cached_unit_id, m.token_expires_at
        into v_cached_token, v_cached_unit, v_token_exp
        from pwa_private.pwa_push_monitor_state as m
       where m.singleton is true;

      if v_cached_token is not null and v_token_exp is not null
         and v_token_exp > clock_timestamp() + interval '2 minutes' then
        return jsonb_build_object(
          'ok', true,
          'hasSubscriptions', true,
          'cachedToken', v_cached_token,
          'cachedUnitId', coalesce(v_cached_unit, '1'),
          'tokenExpiresAt', v_token_exp
        );
      end if;

      return jsonb_build_object('ok', true, 'hasSubscriptions', true);

    when 'save_monitor_session' then
      if nullif(btrim(p_data->>'token'), '') is null
         or length(p_data->>'token') > 4096 then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;
      v_cached_token := btrim(p_data->>'token');
      v_cached_unit := left(coalesce(nullif(btrim(p_data->>'unitId'), ''), '1'), 16);
      v_token_exp := coalesce(
        nullif(btrim(p_data->>'expiresAt'), '')::timestamptz,
        clock_timestamp() + interval '5 days'
      );

      insert into pwa_private.pwa_push_monitor_state
        (singleton, baseline_complete, cached_token, cached_unit_id, token_expires_at, updated_at)
      values
        (true, false, v_cached_token, v_cached_unit, v_token_exp, clock_timestamp())
      on conflict (singleton) do update
        set cached_token = excluded.cached_token,
            cached_unit_id = excluded.cached_unit_id,
            token_expires_at = excluded.token_expires_at,
            updated_at = clock_timestamp();

      return jsonb_build_object('ok', true);

    when 'synchronize_alarms' then
      if jsonb_typeof(p_data->'alarms') is distinct from 'array' then
        return jsonb_build_object('ok', false, 'error', 'invalid_data');
      end if;

      v_count := jsonb_array_length(p_data->'alarms');
      if v_count > 5000 then
        return jsonb_build_object('ok', false, 'error', 'too_many_alarms');
      end if;

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

      insert into pwa_private.pwa_push_monitor_state (singleton, baseline_complete)
      values (true, false)
      on conflict (singleton) do nothing;

      select s.baseline_complete, s.last_cleanup_at
        into v_monitor_baseline, v_last_cleanup
        from pwa_private.pwa_push_monitor_state as s
       where s.singleton is true
       for update;
      v_initial_baseline := not v_monitor_baseline;

      update pwa_private.pwa_push_occurrences as o
         set resolved_at = clock_timestamp(),
             last_seen_at = clock_timestamp()
       where o.resolved_at is null
         and not exists (
           select 1
             from jsonb_array_elements(p_data->'alarms') as a(value)
            where btrim(a.value->>'alarmKey') = o.alarm_key
         );

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

      -- Supressão de baseline resistente a relógio de bordo adiantado (`first_seen_at <= s.created_at`).
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
             and (o.first_seen_at <= s.created_at or o.started_at is null or o.started_at <= s.created_at)
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
        v_pending_deliveries := '[]'::jsonb;
      else
        update pwa_private.pwa_push_deliveries
           set status = 'failed',
               next_attempt_at = clock_timestamp(),
               last_error = left(coalesce(last_error, 'sending lease expired'), 2000),
               updated_at = clock_timestamp()
         where status = 'sending'
           and attempts < 3
           and updated_at <= clock_timestamp() - interval '5 minutes';

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

      -- Retenção automática horária em lotes curtos (protege os 500 MB do Supabase Free sem pg_cron).
      if v_last_cleanup is null or v_last_cleanup <= clock_timestamp() - interval '1 hour' then
        update pwa_private.pwa_push_monitor_state
           set last_cleanup_at = clock_timestamp(),
               updated_at = clock_timestamp()
         where singleton is true;

        delete from pwa_private.pwa_push_occurrences
         where ctid in (
           select ctid
             from pwa_private.pwa_push_occurrences
            where resolved_at is not null
              and resolved_at < clock_timestamp() - interval '14 days'
            limit 500
         );

        begin
          delete from public.pwa_alertas
           where ctid in (
             select ctid
               from public.pwa_alertas
              where quando < clock_timestamp() - interval '90 days'
              limit 500
           );
        exception when undefined_table then
          null;
        end;

        begin
          delete from public.pwa_acessos
           where ctid in (
             select ctid
               from public.pwa_acessos
              where criado_em < clock_timestamp() - interval '60 days'
              limit 500
           );
        exception when undefined_table then
          null;
        end;
      end if;

      return jsonb_build_object(
        'ok', true,
        'initialBaseline', v_initial_baseline,
        'activeCount', v_count,
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
  return jsonb_build_object('ok', false, 'error', 'invalid_data');
end;
$pwa_push_rpc$;

revoke all on function public.pwa_push_rpc(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pwa_push_rpc(text, text, jsonb) to anon, authenticated;
