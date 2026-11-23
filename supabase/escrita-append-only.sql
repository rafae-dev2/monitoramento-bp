-- Monitoramento BP — escrita sem expor a service_role
-- =====================================================================
-- A Netlify Function (`netlify/functions/session.mjs`) precisa apenas
-- ACRESCENTAR registros: um por login (pwa_acessos) e um por alerta
-- disparado (pwa_alertas). Ela nunca lê, altera nem apaga nada.
--
-- Rodando este script, a variável SUPABASE_KEY do Netlify pode ser a
-- chave **anon** (ou a nova *publishable*), que é a menos pior de vazar:
-- com ela ninguém consegue ler os alertas nem os acessos de ninguém.
--
-- Como aplicar: Supabase → SQL Editor → cole tudo → RUN.
-- Pode rodar mais de uma vez (é idempotente).
-- =====================================================================

alter table public.pwa_alertas  enable row level security;
alter table public.pwa_acessos  enable row level security;

-- 1) só o esquema é visível para o papel anon; nenhuma tabela outra
grant usage on schema public to anon;
grant usage, select on all sequences in schema public to anon;

-- 2) derruba qualquer direito amplo que exista e concede SOMENTE insert
revoke all on table public.pwa_alertas from anon;
revoke all on table public.pwa_acessos from anon;
grant insert on table public.pwa_alertas to anon;
grant insert on table public.pwa_acessos to anon;

-- 3) RLS: deixa passar apenas INSERT; select/update/delete ficam vetados
drop policy if exists app_acrescenta_alerta on public.pwa_alertas;
create policy app_acrescenta_alerta
    on public.pwa_alertas for insert to anon with check (true);

drop policy if exists app_acrescenta_acesso on public.pwa_acessos;
create policy app_acrescenta_acesso
    on public.pwa_acessos for insert to anon with check (true);

-- 4) conferência rápida: deve listar as duas policies e "anon" como papel
select c.relname as tabela, p.polname as policy, p.polcmd as comando
from pg_policy p join pg_class c on c.oid = p.polrelid
where c.relname in ('pwa_alertas', 'pwa_acessos')
order by 1, 2;

-- ---------------------------------------------------------------------
-- Para REVERTER (voltar a exigir a service_role na SUPABASE_KEY):
--   drop policy if exists app_acrescenta_alerta on public.pwa_alertas;
--   drop policy if exists app_acrescenta_acesso on public.pwa_acessos;
--   revoke insert on table public.pwa_alertas from anon;
--   revoke insert on table public.pwa_acessos from anon;
-- ---------------------------------------------------------------------
