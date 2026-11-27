-- ============================================================================
-- Monitoramento BP — Cofre de Presets Operacionais COA & FLOW na Nuvem (v6.5.0)
-- ----------------------------------------------------------------------------
-- Permite que operadores das mesas Controle COA e Controle FLOW salvem, listem
-- e recuperem suas configurações completas (2.972 códigos SGPA individuais,
-- críticos ⭐, categorias, frentes, grupos, tempos, paradas, líderes, vozes e
-- temas) diretamente no banco Supabase usando um código de perfil (ex.:
-- "RAFAEL-COA", "FLOW-TURNO-A"), sem jamais armazenar senhas ou chaves de API.
--
-- Otimizado para Supabase Free:
--   • 1 linha compacta por código de perfil (UPSERT idempotente);
--   • Limite rígido de 96 KB por preset e retenção automática de no máx. 200
--     perfis ativos na unidade (remove os mais antigos sem uso se exceder);
--   • RPC `SECURITY DEFINER` (`public.pwa_presets_rpc`) executável pela Netlify
--     Function com `SUPABASE_ANON_KEY` ou `SUPABASE_KEY`, sem expor tabelas em
--     leitura aberta ao navegador.
-- ============================================================================

create table if not exists public.pwa_presets (
  codigo        text        primary key
                check (codigo ~ '^[A-Z0-9_-]{2,48}$'),
  nome          text        not null
                check (char_length(nome) between 1 and 120),
  setor         text        not null default 'todos'
                check (setor in ('todos', 'COA', 'FLOW')),
  autor         text,
  unidade       text,
  versao_app    text,
  checksum      text,
  tema          text,
  painel_fixo   boolean     not null default false,
  resumo        jsonb       not null default '{}'::jsonb,
  config        jsonb       not null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table public.pwa_presets is
  'Perfis e presets operacionais COA/FLOW salvos na nuvem para recuperação rápida e compartilhamento entre parceiros de turno. Nunca armazena senhas nem chaves de API.';

create index if not exists pwa_presets_atualizado_idx
  on public.pwa_presets (atualizado_em desc);

create index if not exists pwa_presets_setor_idx
  on public.pwa_presets (setor, atualizado_em desc);

alter table public.pwa_presets enable row level security;
revoke all on table public.pwa_presets from public, anon, authenticated;

create or replace function public.pwa_presets_rpc(
  p_action text,
  p_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $pwa_presets_rpc$
declare
  v_codigo text;
  v_nome text;
  v_setor text;
  v_autor text;
  v_unidade text;
  v_versao text;
  v_checksum text;
  v_tema text;
  v_painel_fixo boolean;
  v_resumo jsonb;
  v_config jsonb;
  v_row public.pwa_presets%rowtype;
  v_lista jsonb;
begin
  if p_action is null or p_data is null or jsonb_typeof(p_data) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_data');
  end if;

  case p_action
    when 'salvar' then
      v_codigo := btrim(regexp_replace(upper(coalesce(p_data->>'codigo', '')), '[^A-Z0-9_-]+', '-', 'g'), '-');
      v_nome := left(btrim(coalesce(p_data->>'nome', '')), 120);
      v_setor := case
        when upper(coalesce(p_data->>'setor', '')) = 'COA' then 'COA'
        when upper(coalesce(p_data->>'setor', '')) = 'FLOW' then 'FLOW'
        else 'todos'
      end;
      v_autor := nullif(left(btrim(coalesce(p_data->>'autor', '')), 80), '');
      v_unidade := nullif(left(btrim(coalesce(p_data->>'unidade', '')), 80), '');
      v_versao := nullif(left(btrim(coalesce(p_data->>'versaoApp', '')), 24), '');
      v_checksum := nullif(left(btrim(coalesce(p_data->>'checksum', '')), 64), '');
      v_tema := nullif(left(btrim(coalesce(p_data->>'tema', '')), 24), '');
      v_painel_fixo := coalesce((p_data->>'painelFixo')::boolean, false);
      v_resumo := case when jsonb_typeof(p_data->'resumo') = 'object' then p_data->'resumo' else '{}'::jsonb end;
      v_config := p_data->'config';

      if length(v_codigo) < 2 or length(v_codigo) > 48
         or length(v_nome) < 1
         or jsonb_typeof(v_config) is distinct from 'object'
         or octet_length(v_config::text) > 98304 then
        return jsonb_build_object('ok', false, 'error', 'invalid_preset');
      end if;

      -- Remove qualquer campo sensível acidental antes de gravar
      v_config := v_config - 'geminiKey' - 'apiKey' - 'token' - 'password' - 'senha';

      insert into public.pwa_presets (
        codigo, nome, setor, autor, unidade, versao_app, checksum, tema, painel_fixo, resumo, config, atualizado_em
      ) values (
        v_codigo, v_nome, v_setor, v_autor, v_unidade, v_versao, v_checksum, v_tema, v_painel_fixo, v_resumo, v_config, now()
      )
      on conflict (codigo) do update set
        nome = excluded.nome,
        setor = excluded.setor,
        autor = coalesce(excluded.autor, public.pwa_presets.autor),
        unidade = coalesce(excluded.unidade, public.pwa_presets.unidade),
        versao_app = excluded.versao_app,
        checksum = excluded.checksum,
        tema = excluded.tema,
        painel_fixo = excluded.painel_fixo,
        resumo = excluded.resumo,
        config = excluded.config,
        atualizado_em = now()
      returning * into v_row;

      -- Mantém no máximo 200 perfis na tabela para proteger o plano Supabase Free
      delete from public.pwa_presets
       where codigo in (
         select p.codigo
           from public.pwa_presets as p
          order by p.atualizado_em desc
          offset 200
       );

      return jsonb_build_object(
        'ok', true,
        'codigo', v_row.codigo,
        'nome', v_row.nome,
        'setor', v_row.setor,
        'atualizadoEm', v_row.atualizado_em
      );

    when 'carregar' then
      v_codigo := btrim(regexp_replace(upper(coalesce(p_data->>'codigo', '')), '[^A-Z0-9_-]+', '-', 'g'), '-');
      if length(v_codigo) < 2 or length(v_codigo) > 48 then
        return jsonb_build_object('ok', false, 'error', 'invalid_code');
      end if;

      select *
        into v_row
        from public.pwa_presets as p
       where p.codigo = v_codigo
       limit 1;

      if not found then
        return jsonb_build_object('ok', false, 'error', 'not_found');
      end if;

      return jsonb_build_object(
        'ok', true,
        'preset', jsonb_build_object(
          'codigo', v_row.codigo,
          'nome', v_row.nome,
          'setor', v_row.setor,
          'autor', v_row.autor,
          'unidade', v_row.unidade,
          'versaoApp', v_row.versao_app,
          'checksum', v_row.checksum,
          'temaVisual', v_row.tema,
          'painelFixo', v_row.painel_fixo,
          'resumo', v_row.resumo,
          'config', v_row.config,
          'atualizadoEm', v_row.atualizado_em
        )
      );

    when 'listar' then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'codigo', sub.codigo,
            'nome', sub.nome,
            'setor', sub.setor,
            'autor', sub.autor,
            'temaVisual', sub.tema,
            'resumo', sub.resumo,
            'atualizadoEm', sub.atualizado_em
          )
          order by sub.atualizado_em desc
        ),
        '[]'::jsonb
      )
      into v_lista
      from (
        select codigo, nome, setor, autor, tema, resumo, atualizado_em
          from public.pwa_presets
         order by atualizado_em desc
         limit 40
      ) as sub;

      return jsonb_build_object('ok', true, 'presets', v_lista);

    when 'excluir' then
      v_codigo := btrim(regexp_replace(upper(coalesce(p_data->>'codigo', '')), '[^A-Z0-9_-]+', '-', 'g'), '-');
      if length(v_codigo) < 2 or length(v_codigo) > 48 then
        return jsonb_build_object('ok', false, 'error', 'invalid_code');
      end if;
      delete from public.pwa_presets where codigo = v_codigo;
      return jsonb_build_object('ok', true, 'codigo', v_codigo);

    else
      return jsonb_build_object('ok', false, 'error', 'unsupported_action');
  end case;
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rpc_failure');
end;
$pwa_presets_rpc$;

revoke all on function public.pwa_presets_rpc(text, jsonb) from public;
grant execute on function public.pwa_presets_rpc(text, jsonb) to anon, authenticated, service_role;
