-- ============================================================================
-- Monitoramento BP (PWA) — script de banco opcional no Supabase
-- ----------------------------------------------------------------------------
-- O app FUNCIONA SEM BANCO. Este script existe para duas coisas que a operação
-- costuma pedir depois de colocar o painel no ar:
--   1) trilha de auditoria de quem abriu o app (o token nunca é armazenado);
--   2) guardar a configuração por usuário/unidade em vez de variável de ambiente;
--   3) guardar o histórico de alertas da Central de Alertas (pwa_alertas).
--
-- Como usar:
--   Supabase → SQL Editor → colar este arquivo → Run.
--   Depois, em Netlify → Environment variables, adicione:
--     SUPABASE_URL   = https://<projeto>.supabase.co
--     SUPABASE_KEY   = <service_role key>  (só no servidor; nunca no front)
--   e descomente o bloco "auditoria" em netlify/functions/session.mjs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Auditoria de acessos
-- ---------------------------------------------------------------------------
create table if not exists public.pwa_acessos (
  id          bigint generated always as identity primary key,
  criado_em   timestamptz not null default now(),
  usuario     text        not null,
  cliente     integer,
  unidade     text,
  tela        text        not null default 'analytic-map-v4',
  origem_ip   inet,
  user_agent  text,
  resultado   text        not null default 'sucesso'
              check (resultado in ('sucesso', 'falha_login', 'falha_redire', 'taxa_limitada')),
  detalhe     text
);

comment on table public.pwa_acessos is
  'Quem abriu o painel de monitoramento e com que resultado. Não guarda senha nem token.';

create index if not exists pwa_acessos_usuario_data_idx
  on public.pwa_acessos (usuario, criado_em desc);
create index if not exists pwa_acessos_data_idx
  on public.pwa_acessos (criado_em desc);

alter table public.pwa_acessos enable row level security;

-- Sem políticas de SELECT/INSERT anônimas: só a service_role (a Netlify Function) escreve.
-- Se quiser ler no Supabase Dashboard, basta autenticar-se como service_role ou criar
-- uma policy própria para o seu papel.

-- Visão pronta para um painel simples: acessos por dia por usuário.
create or replace view public.pwa_acessos_diario as
select
  date_trunc('day', criado_em)          as dia,
  usuario,
  unidade,
  count(*)                              as aberturas,
  count(*) filter (where resultado <> 'sucesso') as falhas,
  max(criado_em)                        as ultima_abertura
from public.pwa_acessos
group by 1, 2, 3
order by 1 desc, aberturas desc;

-- ---------------------------------------------------------------------------
-- 2. Configuração por usuário (alternativa às variáveis de ambiente)
-- ---------------------------------------------------------------------------
create table if not exists public.pwa_config (
  chave        text primary key,
  valor        jsonb not null,
  atualizado_em timestamptz not null default now()
);

comment on table public.pwa_config is
  'Configuração do tenant: CLIENT_OWNER, CLIENT_NAME, CD_CLIENT, MAP_URL etc. '
  'A senha do portal NÃO entra aqui — mantenha-a em Netlify Environment Variables '
  '(ou no Supabase Vault) e fora do código versionado.';

insert into public.pwa_config (chave, valor) values
  ('tenant', '{"clientOwner":"branco_peres_cana","clientName":"branco-peres-cana","cdCliente":204,"portalUrl":"https://branco-peres-cana.saas-solinftec.com"}'::jsonb),
  ('telas',  '{"padrao":"analytic-map-v4","embedaveis":["analytic-map-v4"],"noPortal":["dashboard","connectivity","alarm","monitplus"]}'::jsonb)
on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();

alter table public.pwa_config enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Trilha de alertas da Central de Alertas
--    A Netlify Function recebe os disparos EM LOTE (POST /api/session?acao=alerta)
--    e grava uma linha por alerta. Serve para prestar contas depois:
--    "quantos veículos passaram de 51 km/h ontem, quais ficaram em troca de turno".
-- ---------------------------------------------------------------------------
create table if not exists public.pwa_alertas (
  id           bigint generated always as identity primary key,
  criado_em    timestamptz not null default now(),
  quando       timestamptz not null default now(),  -- disparo no navegador
  inicio       timestamptz,                         -- início do episódio
  chave        text,                                -- regra:equipamento (para agrupar)
  regra        text        not null,                -- velocidade | rpm | turno | ocioso | servidor
  severidade   text,                                -- critica | alta | media
  equipamento  text        not null,                -- cdEquipamento (matrícula no mapa)
  descricao    text,                                -- nome do equipamento
  operador     text,                                -- nome limpo, sem o código
  valor        text,                                -- leitura que disparou (km/h, RPM, minutos)
  limite       text,                                -- limiar usado no momento do disparo
  texto        text,                                -- mensagem curta exibida no pop-up
  detalhe      text,                                -- contexto (frente, operação, duração)
  fala         text,                                -- frase dita pelo TTS
  fonte        text,                                -- local | servidor | stream
  usuario      text,
  unidade      text
);

comment on table public.pwa_alertas is
  'Alertas gerados pela Central de Alertas do PWA. Um registro = um disparo '
  '(respeitado o cooldown por equipamento/regra). Não contém token nem senha.';

create index if not exists pwa_alertas_quando_idx     on public.pwa_alertas (quando desc);
create index if not exists pwa_alertas_equip_data_idx on public.pwa_alertas (equipamento, quando desc);
create index if not exists pwa_alertas_regra_data_idx on public.pwa_alertas (regra, quando desc);
create index if not exists pwa_alertas_chave_idx      on public.pwa_alertas (chave, quando desc);

alter table public.pwa_alertas enable row level security;
-- Sem policies: só a service_role (Netlify Function) escreve e só você lê pelo Dashboard.

-- Relatório pronto: contagem por regra e por dia.
create or replace view public.pwa_alertas_diario as
select
  date_trunc('day', quando)              as dia,
  regra,
  count(*)                               as disparos,
  count(distinct equipamento)            as equipamentos,
  count(distinct nullif(operador, ''))   as operadores
from public.pwa_alertas
group by 1, 2
order by 1 desc, disparos desc;

-- Ranking dos últimos 7 dias: quem mais desrespeitou as regras.
create or replace view public.pwa_alertas_top_equipamento as
select
  equipamento,
  max(descricao)                                   as descricao,
  count(*) filter (where regra = 'velocidade')     as velocidade,
  count(*) filter (where regra = 'rpm')            as rpm,
  count(*) filter (where regra = 'turno')          as troca_turno,
  count(*) filter (where regra = 'ocioso')         as motor_ocioso,
  count(*)                                         as total,
  max(quando)                                      as ultimo_disparo
from public.pwa_alertas
where quando > now() - interval '7 days'
group by 1
order by total desc;

-- ---------------------------------------------------------------------------
-- 4. (Opcional) retenção: apaga trilha com mais de 180 dias
--    Requer pg_cron habilitado no projeto.
-- ---------------------------------------------------------------------------
-- select cron.schedule(
--   'pwa_alertas_180d', '20 3 * * *',
--   $$delete from public.pwa_alertas where quando < now() - interval '180 days'$$
-- );

-- ---------------------------------------------------------------------------
-- 5. (Opcional) retenção: acessos com mais de 180 dias
--    Requer pg_cron habilitado no projeto.
-- ---------------------------------------------------------------------------
-- select cron.schedule(
--   'pwa_acessos_180d', '15 3 * * *',
--   $$delete from public.pwa_acessos where criado_em < now() - interval '180 days'$$
-- );
