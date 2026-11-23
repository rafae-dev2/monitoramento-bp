# Avaliação de infraestrutura para Web Push

**Data:** 23 de novembro de 2026

**Inspeção inicial:** somente leitura. As alterações de infraestrutura e publicação executadas depois estão registradas na seção “Próximo passo”.

## Supabase: armazenamento disponível, mas há pausa no plano Free

O conector Supabase confirma a organização no plano **Free** e o projeto **ACTIVE_HEALTHY**. A captura do ciclo atual (**28 out–28 nov 2026**) informa que a cota não foi excedida e mostra banco **0.032/0.5 GB (6%)**, armazenamento **0.002/1 GB**, ingestão de logs **0.001/1 GB**, egress **0.002/5 GB**, egress em cache **0/5 GB**, usuários ativos mensais **0/50,000**, usuários terceirizados **0/50,000** e pico de conexões Realtime **0/200**. A consulta somente leitura pelo MCP retornou `pg_database_size` de **16,551,059 bytes** (~16.55 MB) e **0** tabelas `pwa_push%` em `public`. O valor SQL e o medidor agregado de 32/500 MB medem aspectos diferentes do uso; para a cota mensal, uso o medidor do painel. As tabelas existentes têm 92 acessos, 1,223 alertas e 2 configurações; ainda não há tabela de inscrições Push nem Edge Functions. O espaço para algumas inscrições por dispositivo e estado de deduplicação é pequeno frente à margem restante. [1]

As capturas do projeto mostram estado Healthy e, em duas leituras da última hora, 315 e 321 requisições totais com 100% de sucesso; o painel exibe 24 chamadas Postgres, CPU 3%, disco 3%, RAM 43% e 7 de 60 conexões. Isso confirma atividade e folga naquele momento, mas não garante disponibilidade contínua por toda a semana. Projetos Free com atividade baixa durante sete dias podem ser pausados; o monitor pode gerar tráfego de banco, mas a documentação não oferece garantia de SLA 24/7 para essa configuração. [2]

O Supabase inclui 500,000 invocações de Edge Functions no Free. Uma alternativa com uma chamada por minuto consumiria 43,200 invocações em 30 dias, ou 8.64% da cota. Uma chamada a cada 10 segundos consumiria 259,200, ou 51.84%. O projeto não tem Edge Functions no momento e `pg_cron`/`pg_net` estão disponíveis, mas não instalados. O Cron do Supabase aceita agendas de um segundo a um ano, mas essa alternativa exigiria escolher onde ficarão as credenciais de monitoramento e como enviar Push mantendo a chave privada VAPID no Netlify, conforme a autorização dada. [3] [4]

## Netlify: Personal pago; saldo atual confirmado pelas capturas

O MCP Netlify confirmou a equipe `UniCesumar` (`bugname621`) e tipo `Personal`, mas não expõe valores de billing. As capturas **Usage & billing** enviadas pelo usuário em 23 nov. de 2026 mostram o plano **Personal pago, US$ 9/mês**, efetivo desde 12 nov., com **1,000 créditos/mês**. O painel mostra **337.6 créditos consumidos** e **662.4/1,000 restantes**, com vencimento em 11 dez. de 2026, além de **270.1/500 créditos restantes sem expiração**. A recarga automática está desativada. O detalhamento do período indica 21 deploys de produção (315 créditos), IA 0, 28,703 requisições web (5.7 créditos), compute 0.7 e bandwidth 16.2, totalizando 337.6. Portanto, o saldo total atualmente visível é 932.5 créditos, dos quais 662.4 pertencem ao lote mensal com vencimento. [5] [6]

As Scheduled Functions do Netlify estão disponíveis em todos os planos, usam cron em UTC e têm limite de execução de 30 segundos. Elas só executam em deploy publicado; não podem ser chamadas diretamente por URL em produção. A menor cadência suportada por cron de cinco campos é um minuto. Uma agenda de um minuto geraria **43,200 execuções em 30 dias**. [7]

Nas últimas 24 horas, a observabilidade do site registrou 461 invocações da função `session` e 8 respostas 5xx. Os percentis apresentados foram p50 489,784,847; p75 835,748,356; p90 1,698,100,977; p99 4,559,530,453. Interpretando esses valores como nanossegundos, equivalem aproximadamente a 0.49 s, 0.84 s, 1.70 s e 4.56 s. Essa conversão é apenas indicativa: o esquema do MCP não informa a unidade e não há ainda medições do novo monitor. [8]

No plano Personal, o valor contratado é 1,000 créditos/mês. Para 43,200 execuções a cada minuto, as requisições consumiriam cerca de 8.64 créditos. Usando como cenários hipotéticos as durações p50, p75, p90 ou p99 observadas na função `session` (não no novo monitor), o custo estimado de compute mais chamadas seria **67, 109, 212 ou 556 créditos**, respectivamente. Os percentis não são a duração média nem previsão do gasto real. O painel observou 315 créditos em 21 deploys de produção; usando 15 créditos por deploy como referência observada, um deploy adicional para publicar o monitor acrescentaria cerca de 15. Assim, o monitor mais um deploy inicial somaria aproximadamente **82, 124, 227 ou 571 créditos** nesses cenários. Sobre os 337.6 já consumidos, o total mensal projetado ficaria em **419.6, 461.6, 564.6 ou 908.6 créditos**, deixando **580.4, 538.4, 435.4 ou 91.4** do lote mensal de 1,000, antes de novo uso do site, deploys posteriores e variação real da duração. O saldo mensal restante de 662.4 cobre esses quatro cenários isoladamente, mas o cenário p99 deixa pouca margem mensal; os 270.1 créditos sem expiração são uma reserva adicional visível. A recarga automática está desativada. [5] [6]

Se a mesma taxa de 461 invocações diárias da função `session` se mantivesse por 30 dias, ela somaria cerca de 13,830 invocações; com o monitor, o total seria aproximadamente 57,030 invocações de funções no período. Isso é apenas uma extrapolação de um dia, não o histórico de cobrança nem uma previsão de crédito; não inclui variação do tráfego do site, novos deploys ou outros usos.

As páginas atuais de cobrança Netlify confirmam 10 créditos por GB-hora; uma Netlify Function recebe 1 GB por padrão e o compute é duração × memória. Portanto, para 43,200 execuções, uma duração média de 1, 2 ou 5 segundos representa cerca de 120, 240 ou 600 créditos de compute por mês. A cobrança de requisições web é adicional. Esses números são cenários matemáticos, não previsão: a duração real do monitor ainda não existe e precisa ser medida após ativação. O novo código consulta primeiro a RPC `has_subscriptions`; quando não há aparelho inscrito, retorna sem fazer login nem consultar o SGPA. [11] [12]

## Recomendação e limitações do comportamento

A opção mais simples é um monitor Netlify a cada minuto, fazendo uma consulta agregada do SGPA para todos os dispositivos inscritos, não uma consulta por inscrição. Para complementar velocidade ausente no alarme oficial, poderá ser necessário consultar também a telemetria. A documentação interna do projeto registra limite do SGPA de 10 requisições por minuto por IP; uma ou duas leituras por minuto ficam abaixo dele, desde que o monitor seja único e tenha backoff em falhas. O estado de ocorrência e as entregas precisam ser persistidos para deduplicar entre execuções e dispositivos.

Com a página aberta, o aplicativo mantém o stream do mapa para resposta rápida. Com a página suspensa ou fechada, um polling de um minuto pode detectar o alarme com atraso de até aproximadamente um intervalo, mais a latência variável do serviço Push e do sistema operacional. Push pode acordar o service worker, mas não garante entrega instantânea ou disponibilidade contínua. [9] [10]

As preferências de categoria, tipos individuais, frentes e equipamentos hoje estão no dispositivo. O backend terá de sincronizar os filtros necessários e respeitar a precedência já existente, na qual um tipo selecionado individualmente pode prevalecer sobre uma categoria desligada. As notificações Push devem continuar limitadas a alarmes oficiais do SGPA; alertas calculados localmente não devem passar a gerar notificação do sistema. Cada inscrição requer endpoint e chaves `p256dh`/`auth` no servidor; a chave privada VAPID deve permanecer em segredo no Netlify e nunca no navegador ou no conteúdo da notificação. [9]

O código local remove os registros antigos de senha/token, mantém a senha e a sessão somente em memória enquanto a página está aberta e lembra apenas o nome do usuário se a opção for marcada; `tools/test-local-credentials.mjs` passou com endpoints simulados. Essa correção ainda aguarda publicação. A documentação de variáveis foi corrigida: `SUPABASE_KEY` é uma variável legada da função `session`, não é usada pelo monitor Push e não deve ser tratada como chave RPC. A nova API usa `SUPABASE_ANON_KEY` publicável e `PUSH_DB_SECRET` server-side validado por uma RPC no Vault; não precisa de `service_role`.

## Próximo passo

O usuário aceitou a detecção em segundo plano com polling de um minuto e autorizou “Pode publicar tudo autorizado faça tudo”. O código local contém o opt-in explícito, preferências por dispositivo, o monitor Netlify, baseline silenciosa, deduplicação e o clique para focar o equipamento no mapa atual mesmo sem alerta local ativo. Os testes usam fixtures; não chamaram SGPA, Supabase de produção nem enviaram Push real. A migração de infraestrutura foi aplicada em 23/11/2026 e `pwa_push_rpc_auth` foi criado no Vault. `SUPABASE_URL` foi aceita no escopo Functions/Production; o Netlify retornou 403/erro de conexão nas gravações das outras quatro variáveis, inclusive em chamadas isoladas. Nenhum valor secreto existente foi consultado; `SUPABASE_KEY`, `SOLINF_USER` e `SOLINF_PASS` não foram alterados. O commit de implementação `dd83c16` foi enviado e confirmado em `origin/main`; o deploy automático `6b049ee3c639452f5d56f7dc` está `ready/current` e inclui `push-api` e o cron `push-monitor` de um minuto. O usuário informou ter cadastrado manualmente as variáveis; o deploy ativo foi criado antes dessa alteração e ainda responde `503 push-not-configured`, então é necessário um novo deploy para validar. A RPC Vault foi testada em modo read-only (`ok`, `hasSubscriptions:false`); não há aparelho inscrito e nenhum monitor foi invocado manualmente. Depois da publicação, o monitor poderá atrasar a detecção até aproximadamente um intervalo e a entrega externa continua sem garantia de instantaneidade. O custo real deve ser medido pelo uso após ativação.

## Referências

[1]: https://supabase.com/pricing/ "Supabase Pricing"
[2]: https://supabase.com/docs/guides/platform/free-project-pausing "Supabase Free Project Pausing"
[3]: https://supabase.com/docs/guides/functions/pricing "Supabase Edge Functions Pricing"
[4]: https://supabase.com/docs/guides/cron "Supabase Cron"
[5]: https://docs.netlify.com/build/functions/usage-and-billing/ "Netlify Functions Usage and Billing"
[6]: https://www.netlify.com/pricing/ "Netlify Pricing"
[7]: https://docs.netlify.com/build/functions/scheduled-functions/ "Netlify Scheduled Functions"
[8]: https://docs.netlify.com/manage/monitoring/function-metrics/ "Netlify Function Metrics"
[9]: https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription "MDN PushSubscription"
[10]: https://www.w3.org/TR/push-api/ "W3C Push API"
[11]: https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/ "Netlify credits and compute"
[12]: https://docs.netlify.com/build/functions/usage-and-billing/ "Netlify Functions Usage and Billing"
