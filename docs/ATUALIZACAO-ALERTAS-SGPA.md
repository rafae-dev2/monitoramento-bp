# Central de alertas SGPA — atualização de 23/11/2026

A central passa a usar exclusivamente o alarme oficial do SGPA para velocidade. Uma leitura de telemetria acima de 51 km/h, por si só, não gera mais aviso de velocidade. Quando o SGPA emitir um alarme desse tipo, o aplicativo o incorpora à central e entrega os canais escolhidos pelo usuário. A fala do equipamento lê cada algarismo: “Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.” A medição vem primeiro do alarme; se faltar, o app tenta uma leitura recente da telemetria. Se nenhuma fonte trouxer um valor válido, informa o alarme sem inventar velocidade.

## Escolha dos alertas

Em Central de alertas → configurações, as chaves selecionam velocidade, RPM, motor ocioso, troca de turno, condições combinadas do motor, espera por caminhão e demais alarmes oficiais. A seção de tipos individuais permite procurar por nome ou código SGPA e silenciar cada tipo. Um tipo explicitamente marcado prevalece sobre a chave geral de categoria; tipos não selecionados herdam a categoria e tipos explicitamente desmarcados permanecem silenciados.

As chaves são salvas automaticamente neste navegador/aparelho. Os controles gerais de leitura, fontes e canais continuam com botão Salvar preferências. Desligar as notificações de um tipo não o remove da central nem do histórico; o cartão informa que seus avisos estão desligados. Preferências antigas de canais, limites complementares e escopo são preservadas. A preferência antiga “incluir outros” desligada mantém a categoria de demais alarmes silenciada, mas não descarta mais esses eventos. Novas instalações começam com todas as categorias habilitadas.

Velocidade não tem mais campo de limite local. RPM, ociosidade e troca de turno mantêm cálculo complementar opcional. Os códigos 2697 e 2699 ficam como condição combinada do motor; seus valores não são narrados como velocidade pura.

## O que foi auditado no SGPA

A consulta do cadastro confirmou **2.972 tipos gerais de alarme, 38 regras cadastradas e 39 expressões**. Os filtros do histórico apresentaram 23 nomes de tipos, todos encontrados no catálogo. Esses conjuntos não são equivalentes: a existência de um tipo no catálogo geral não comprova que esteja configurado ou ativo nesta unidade. Correspondência entre nomes de regra e tipo é exibida como correspondência de nome, não como vínculo confirmado.

Todas as 39 expressões aparecem no inventário de consulta dentro das configurações. O arquivo `public/sgpa-alert-catalog.json` contém o catálogo selecionável e esse inventário sanitizado. `docs/AUDITORIA-ALERTAS-SGPA.json` contém os nomes, tipos de equipamento, campos usados nas condições e comparações de velocidade de cada expressão. Não inclui token, equipamentos individuais, operadores, filtros pessoais ou SQL completo.

Treze expressões incluem velocidade. Para caminhão de apoio, os limiares observados são 52, 41, 44 e 23 km/h; a condição de 44 também envolve operação de vinhaça. Para caminhão canavieiro, aparecem 40 km/h e duas expressões de 23 km/h. Para o tipo cadastral TRATOR DE PNEU LEVE/MAG 100, aparecem 62, 65 e 51 km/h, além de condições de 30 km/h relacionadas a operador e de 5 km/h relacionada ao grupo Equipamento Inativo. Essas condições não devem ser reduzidas a um limite único de 51 km/h. Não foi encontrado campo explícito de pavimento; o nome RURAL não comprova estrada de terra.

Todos os tipos de alarme oficialmente recebidos, inclusive tipos desconhecidos do mapeamento inicial, entram na central com seu nome original. As expressões continuam executadas no SGPA, não são recriadas no aplicativo. Isso evita inventar os predicados ou a associação entre expressão e código de alarme que o cadastro consultado não expôs.

## Tratores e transbordos aguardando caminhão

O rastreio usa o tipo de equipamento e `descOperacao` da telemetria. A comparação aceita diferenças de maiúsculas, acentos, espaços, prefixo numérico com hífen e os sufixos HD/HR. Exige a operação “Aguardando Caminhão”; “Aguardando Carregamento” e “Aguard Bascul Transbo” não são tratados como sinônimos.

Desde a versão 1.8.1, a frente de colheita vem de `descFrente` (por exemplo, “Frente 1”) e `descGrupoEquipamento` permanece separado como grupo cadastral. A fala do caminhão em “Aguardando Carregamento” usa a frente de colheita; se ela não vier informada, o app diz que a frente de colheita não foi informada em vez de anunciar o grupo como frente. Os filtros antigos por grupo continuam compatíveis. O rastreio funciona mesmo se o cálculo complementar de RPM/ociosidade/turno estiver desligado e respeita as leituras de confirmação e o cooldown configurados; duas leituras fora da operação encerram o episódio e uma nova entrada pode gerar novo aviso.

O retrato de telemetria auditado tinha 271 equipamentos, dos quais 162 com tipo contendo trator ou transbordo. **Nenhum estava em “Aguardando Caminhão” naquele retrato.** O detector foi validado com fixtures isoladas, não com um evento real dessa operação. Da mesma forma, não havia alarme oficial de velocidade ativo na consulta anterior; a integração de velocidade foi testada com fixtures, sem afirmar validação ao vivo que não ocorreu.

## Validação e funcionamento

O teste de política cobre categorias, seleção por tipo, migração de preferências, identificadores com zeros iniciais, valores ausentes e frases. O teste integrado passou 33 grupos de comportamento, incluindo velocidade oficial com leitura recente e com consulta agrupada à telemetria, mensagem sem valor inventado quando nenhuma fonte mede, foco no iframe sem link externo, fala de tipos individuais explicitamente selecionados mesmo com categoria geral desligada, deduplicação stream/REST, independência dos tipos oficiais, preservação de central/histórico, gates de desligamento, espera por caminhão e encerramento de episódio, manutenção de RPM complementar, persistência das chaves e layout móvel sem overflow horizontal. Não houve erro JavaScript nem chamada de rede ou escrita de produção nos testes. Comandos: `node tools/test-alerts-policy.cjs` e `python3 tools/test-alerts-integrated.py`.

O espelho oficial e a telemetria são lidos a cada 45 segundos por padrão; o stream pode antecipar os eventos. Falha de telemetria não bloqueia a consulta dos alarmes oficiais. O mesmo tipo de alarme do mesmo equipamento é deduplicado entre as duas fontes; tipos diferentes continuam independentes. A central e o espelho desligados bloqueiam também o caminho de stream. Os exemplos de teste não alteram a frota consolidada nem são enviados ao Supabase.

A versão publicada descrita nesta seção é a **1.2.2**, com cache **bperes-shell-v17**. A versão local atualizada no final deste relatório é a 1.2.4 e ainda não foi publicada. A fala depende de voz disponível no navegador ou da ponte AndroidTTS do APK. Notificações do sistema exigem permissão; no PWA móvel são entregues via service worker. Não foi implementado Web Push com coleta autônoma no servidor: o navegador/aplicativo precisa estar em execução e o sistema operacional pode suspender a atividade em segundo plano. Não há promessa de avisos com o app totalmente fechado.

Nenhuma regra, justificativa ou cadastro do SGPA foi alterado e não houve migração de banco nesta atualização. As preferências continuam locais. Eventos reais continuam usando a auditoria Supabase já existente; habilitar mais tipos pode aumentar o volume de histórico.

As contagens e condições acima foram obtidas por leitura dos cadastros [1] [2] [3] [4] em 23/11/2026. A telemetria foi analisada somente em campos estritamente necessários e relatada de forma agregada.

## Publicação verificada

A versão 1.2.0 foi publicada no site existente https://sgpa-solinftec-bpa.netlify.app/. O Netlify informou o deploy `6b043b0d83f5c3af4c09bff4` como ready, em contexto production, publicado em 23/11/2026. HTML, motor, política, CSS, service worker e catálogo responderam HTTP 200 com hashes iguais aos arquivos locais validados. As rotas de leitura de tipos e filtros responderam HTTP 200, retornando respectivamente 2.972 tipos e 23 nomes de filtros.

## Pedido complementar do usuário — 23/11/2026

Na consulta somente leitura à rota pública mediada `https://sgpa-solinftec-bpa.netlify.app/.netlify/functions/session?acao=dados&rota=%2FalarmeOnline%3Fativo=true%26idioma=pt-br`, HTTP 200, havia cinco alarmes ativos e nenhum de velocidade; portanto, não foi possível verificar um payload real de excesso de velocidade naquele momento. A documentação do tenant descreve `vlAlarme` como valor medido do alarme e também registra `vlAlarmeMaximoAtingido`; a implementação usa esses campos primeiro e a leitura recente `vlVelocidade` da telemetria SGPA como complemento, sem converter `vlPeso` em velocidade. Fonte local: `docs/NOTAS-ALERTAS.md`, itens 1 e 4.

No mapa, `app.js` fornece `session.mapUrl` como URL completa para o iframe e também a encaminha à central de alertas. “Ver no mapa” envia o `cdEquipamento` SGPA como string em `props.rastroBI.equipment`, usando a origem do iframe atual. A ação remove `rastroBI.start` e `rastroBI.end` para pedir a localização atual, não um rastro histórico; pelo contrato do mapa, isso chama `mapref.flyTo` com zoom 20 e abre o popup do equipamento, equivalente a selecioná-lo no portal [11]. O painel fecha após o envio e nunca abre URL externa; se o iframe realmente não estiver pronto, exibe um aviso dentro do app.

## Correção complementar implementada — 23/11/2026

Para o gatilho exclusivamente oficial de velocidade, o app tenta `vlAlarme`, depois `vlAlarmeMaximoAtingido`; se ambos faltarem, só usa `e.velocidade` quando `velocidadeTs` indica uma leitura recente. Quando necessário, uma única consulta compartilhada à telemetria atualiza os alertas pendentes. O número é apresentado em km/h e falado como valor normal; se nem o alarme nem a telemetria fornecerem medição válida, o alerta oficial permanece sem número. O valor recebido depois também atualiza o cartão e o histórico, com fala/notificação conforme as preferências, sem criar duplicata de auditoria.

Testes com fixtures cobriram a leitura recente em memória, a consulta complementar agrupada e o foco do equipamento no mapa incorporado; nenhum teste chamou rede ou gravou dados de produção. A consulta ao vivo da rota de alarmes, no momento registrado acima, não continha evento de velocidade: a correção de medição foi validada com fixtures, não com um evento real.

## Publicação da correção 1.2.1

A atualização foi publicada em produção no site existente `https://sgpa-solinftec-bpa.netlify.app/`. O Netlify confirmou o deploy `6b043f9a93c5975c614d2dfb` como **ready**, em contexto production, em 23/11/2026 às 13:29 UTC. A página inicial respondeu HTTP 200. `app.js`, `alerts.js` e `sw.js` servidos no site tiveram hashes idênticos aos arquivos locais validados; a versão servida é 1.2.1 e o cache do PWA é `bperes-shell-v16`.

## Correção adicional — 23/11/2026

A mensagem de mapa indisponível ocorria porque `ligarAlertas()` encaminhava `props` e a renovação da sessão, mas omitia `session.mapUrl`; assim, a central não sabia que o iframe que já estava aberto era o mapa. A inicialização agora encaminha essa URL e a ação “Ver no mapa” também consegue derivá-la do próprio iframe como fallback.

Tipos marcados individualmente em “Escolher tipos individuais do SGPA” agora prevalecem sobre a chave geral de categoria. Tipos não selecionados continuam herdando a categoria; um tipo desmarcado permanece silenciado. O switch reflete esse efeito, e a fala respeita o controle global “Falar alerta em português”. O teste integrado comprova que um alarme oficial selecionado é efetivamente enviado ao canal de voz.

## Publicação da correção 1.2.2

A versão **1.2.2** foi publicada em produção no site existente `https://sgpa-solinftec-bpa.netlify.app/`. O Netlify confirmou o deploy `6b0443f47f40372c914d2e21` como **ready/current**, em contexto production, em 23/11/2026 às 13:47 UTC; a função `session` também foi implantada. A página inicial e os arquivos `app.js`, `alerts.js`, `alerts-policy.js` e `sw.js` responderam HTTP 200 na URL imutável do deploy. Os quatro arquivos têm hashes SHA-256 idênticos aos arquivos locais; o cache servido é `bperes-shell-v17`. Commit de código `2cff302` enviado ao `origin/main`.


## Rodada local 1.2.4 — implementada, aguardando decisões do usuário (23/11/2026)

As descrições operacionais que o usuário acrescentou ao DOCX foram aplicadas às 20 entradas correspondentes. Os códigos e nomes originais do SGPA foram preservados; onde não há explicação, não foi inventada tradução. Nas falas de velocidade, os limiares fixos são tratados como referências, separados de uma velocidade realmente medida.

**Motor ocioso sem apontamento** exige tanto a condição configurada de motor ligado/ocioso quanto uma descrição atual e explícita de `descOperacao` reconhecida como “Sem Apontamento”. Descrição ausente ou antiga não é reutilizada, e “Não Apontar Aguardando Carregamento” permanece distinto. Somente esse alerta combinado pode ser falado, se a operação atual confirmar a condição. Ele não gera notificação do sistema, som, vibração ou pop-up local; outros cálculos locais permanecem sem fala e sem notificação. O alarme oficial “Motor Ocioso” isolado, inclusive no cenário de meia-chave com RPM zero, não é classificado como “Sem Apontamento”.

No APK, a opção **Instalar ou gerenciar vozes do Android** abre a tela nativa de vozes TTS e atualiza a lista ao voltar ao aplicativo. Isso só disponibiliza as vozes instaladas no aparelho; elas não são rotuladas como IA ou por gênero sem metadados confiáveis.

O usuário delegou a escolha do provedor; a recomendação é **Azure Speech Standard Neural**, cuja lista oficial inclui vozes pt-BR masculinas e femininas e cuja API expõe metadados de idioma e gênero [5] [6]. A página de preços lista 500 mil caracteres/mês no F0 e US$ 15 por milhão de caracteres no Standard Neural pay-as-you-go; são faixas separadas [7]. O usuário informou depois que não autoriza vozes pagas: portanto, S0 não está autorizado e não será habilitado nem usado. F0 também não foi configurado ou autorizado explicitamente; não há chave nem síntese em nuvem. A lista Android/Web de vozes locais continua disponível.

O screenshot do usuário confirmou que o alvo é o **“Gráfico de operação”** do portal, imediatamente acima da tabela de detalhes. Ele contém uma pizza de **Grupo de Operação**, cuja legenda mostra **IMPRODUTIVA**, e outra de **Operação**. O usuário esclareceu que não quer um gráfico duplicado: usa a pizza como referência para refinar o monitoramento. A PWA já mantém alarmes oficiais na Central e acompanha a operação atual da telemetria; o iframe externo aceita mensagens `props`, mas não documenta um canal para inserir contagens locais no gráfico. O gráfico permanece intacto, e nenhuma nova regra foi inferida apenas pelo rótulo “IMPRODUTIVA” [11].

A integração de alertas passou 52 grupos de verificações integradas, incluindo a fala excepcional sob confirmação atual, a rejeição de descrição ausente/antiga e a distinção do alarme oficial “Motor Ocioso” com meia-chave. Os testes usam fixtures locais: não foram feitas chamadas ao SGPA ao vivo nem gravações no Supabase, e não houve verificação em aparelho Android físico. A bateria completa de testes da sessão, sintaxe e diff foi repetida antes da entrega.

A rodada local 1.2.4 descrita acima resultou na versão 1.2.5, cuja publicação efetiva está registrada abaixo. Não houve APK compilado nessa rodada; o gráfico externo e a síntese Azure permanecem sem alteração.

## Ajuste responsivo da versão 1.2.5 — 23/11/2026

O painel de preferências agora tem um X acessível no topo, permanece disponível enquanto o conteúdo rola e retorna o foco a um controle visível do aplicativo ao fechar. A janela limita largura e altura à área visível; os controles se reorganizam em telas estreitas. A central impede que os cartões ativos encolham para caber à força: cada cartão mantém o espaço do conteúdo, quebra textos longos e a lista rola separadamente. A barra de ações do rodapé também se reorganiza em celular. Os toasts têm limite de altura e rolagem própria.

“Ver no mapa” usa o código SGPA atual do equipamento e limpa quaisquer datas de rastro herdadas antes de enviar `rastroBI`; isso força a seleção da posição atual e o comportamento oficial de voo, zoom 20 e popup. O teste integrado confirma o ID textual, a ausência de `start`/`end`, a preservação das demais propriedades e que nenhum link externo é aberto. A animação é definida pelo micro-frontend SGPA; não foi executado teste interativo autenticado no portal nesta rodada.

O teste integrado carrega a CSS real e verificou a janela e os cartões em 320×640, 412×915, 768×1024 e 1280×900, incluindo X visível, fechamento, ausência de overflow horizontal e cartões sem sobreposição. Os 52 grupos integrados passaram; as alterações desta rodada não chamam rede nem gravam dados de produção. A faixa paga de voz continua proibida conforme a instrução do usuário; não foi configurada síntese online. A alternativa F0 gratuita depende de autorização separada e credencial segura.

## Publicação verificada da versão 1.2.5

A versão **1.2.5** foi publicada no site Netlify existente `https://sgpa-solinftec-bpa.netlify.app/` e sincronizada com `origin/main` pelo commit `a852f7a`. O deploy `6b046c2d5408ad4644ee3a91` (build `6b046c2d5408ad4644ee3a8f`) foi confirmado como **ready/current**, contexto production; a Function `session` foi implantada. A versão servida é 1.2.5, o cache é `bperes-shell-v20` e os hashes dos arquivos críticos servidos conferiram com os arquivos locais. APK não compilado.

## Rodada local 1.2.6 — implementada e testada, ainda não publicada

Os toasts agora têm limite vertical de 40dvh/420px (38dvh/360px em telas estreitas), rolagem própria e deslocamento para o mais recente após sua criação. Em CSS real, o teste a 652×1050 confirmou cinco toasts roláveis, o mais novo inteiramente visível e sete alarmes preservados como ativos; os alarmes anteriores continuam acessíveis na Central/histórico.

A Central tem busca acessível para Ativos e Histórico por frota/identificação, operador, nome/código do alarme e texto/detalhe, sem distinção de caixa ou acentuação. A filtragem não remove registros nem altera os contadores; ela percorre todo o histórico armazenado e mostra até 150 resultados por vez. Limpar a busca restaura os cartões.

Ao retomar a página, o app verifica atualizações do service worker; `visibilitychange`, retorno de rede e `pageshow` persistido revalidam a sessão conforme a duração da suspensão, sincronizam as props e iniciam um ciclo de alertas. Quando um novo service worker controlador assume, a página recarrega uma única vez. A sessão SGPA continua mediada no servidor; nenhum token novo é armazenado indefinidamente no cliente. Testes de sessão com fixtures confirmaram renovação no `pageshow`, ausência de recarga redundante e uma única recarga após `controllerchange`.

O PWA sozinho não garante polling contínuo quando o navegador suspende ou fecha a página: timers em abas ocultas podem sofrer throttling. Periodic Background Sync tem disponibilidade limitada e a cadência é decidida pelo navegador. A entrega independente exige Web Push: service worker ativo, permissão do usuário, inscrição do dispositivo e servidor para consultar o SGPA e enviar o push. Fontes oficiais: [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [Periodic Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API), [uso de notificações](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API) e [throttling de timers no Chrome](https://developer.chrome.com/blog/timer-throttling-in-chrome-88).

A rodada local 1.2.6 usa cache `bperes-shell-v23`. Passaram 54 grupos integrados da Central, 25 testes fixture-only de Web Push, sessão/UI, credenciais locais, sintaxe e `git diff --check`. Nenhum teste chamou SGPA/Supabase de produção ou enviou Push real. As alterações 1.2.6 ainda não foram commitadas, sincronizadas ou publicadas. O usuário autorizou a publicação e sincronização. A migração e o segredo Vault foram aplicados; `SUPABASE_URL` foi aceita em Functions/Production. As outras quatro variáveis permanecem pendentes após respostas 403/erro de conexão do Netlify. O commit `dd83c16` foi enviado a `origin/main` e gerou o deploy automático `6b049ee3c639452f5d56f7dc` (`ready/current`), com sete funções e cron `* * * * *` para `push-monitor`. O usuário informou ter cadastrado as variáveis manualmente. O deploy ativo foi criado antes dessa alteração e continua em `503 push-not-configured` até novo deploy, pois valores Netlify são congelados por implantação. A RPC Vault passou em chamada read-only e retornou `hasSubscriptions:false`; nenhum monitor foi invocado manualmente e nenhuma consulta ao SGPA ocorreu durante a validação. Nenhum gráfico, voz paga ou F0 foi adicionado/configurado; nenhum APK foi compilado.

## Web Push da versão 1.2.6 — implementação local

O botão “Ativar notificações Push neste aparelho” é o único fluxo que pede permissão ao navegador. A inscrição, categorias, tipos individuais, frentes/grupos, equipamentos e seleção do mapa são sincronizados por dispositivo. Um tipo SGPA explicitamente selecionado prevalece sobre uma categoria desligada. O servidor envia notificações apenas para alarmes oficiais ativos do `/alarmeOnline`; alertas calculados localmente continuam sem Push, som, vibração ou pop-up do sistema. O motor ocioso sem apontamento permanece somente a exceção de fala local previamente autorizada.

O monitor Scheduled Function roda uma vez por minuto, com tolerância de até aproximadamente um intervalo mais a latência do serviço Push; não garante entrega instantânea. Antes de autenticar, ele consulta a RPC `has_subscriptions` e não chama o SGPA enquanto nenhum aparelho estiver inscrito. A primeira sincronização cria baseline silenciosa para alarmes já ativos; a deduplicação por ocorrência e dispositivo persiste no Supabase. A chave privada VAPID e o segredo da RPC permanecem fora do cliente. Quando a notificação é tocada, o PWA envia o `cdEquipamento` textual às props do mapa incorporado, inclusive quando o app estava fechado, sem abrir URL externa.

O Netlify Personal tinha 662.4/1,000 créditos mensais restantes e 270.1 créditos sem expiração no retrato consultado em 23/11/2026; a recarga automática estava desligada. A tarifa oficial é 10 créditos por GB-hora e a função recebe 1 GB por padrão; com 43,200 execuções mensais, cada segundo médio de duração equivale a aproximadamente 120 créditos de compute, além do tráfego e dos outros usos do site. O gasto real deve ser medido após ativação. [12] [13]

## Referências

[1]: https://sgpa-api-br.saas-solinftec.com/slf03/tipo-alarme "Cadastro autenticado SGPA de tipos de alarme"
[2]: https://sgpa-api-br.saas-solinftec.com/slf03/regra "Cadastro autenticado SGPA de regras"
[3]: https://sgpa-solinftec-bpa.netlify.app/.netlify/functions/session?acao=dados&rota=%2Fregra-expressao "Proxy autorizado de expressões SGPA"
[4]: https://sgpa-api-br.saas-solinftec.com/slf03/alarmeOnline/alarme-filtros "Filtros autenticados do histórico de alarmes SGPA"
[5]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts "Azure Speech: suporte a idiomas e vozes TTS"
[6]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech "Azure Speech: API REST de síntese e lista de vozes"
[7]: https://azure.microsoft.com/en-us/pricing/details/speech/ "Azure Speech: preços oficiais"
[8]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits "Azure Speech: cotas e limites"
[9]: https://cloud.google.com/text-to-speech/pricing "Google Cloud Text-to-Speech: preços"
[10]: https://cloud.google.com/text-to-speech/docs/list-voices-and-types "Google Cloud Text-to-Speech: tipos e lista de vozes"
[11]: https://solinftec-frontends.saas-solinftec.com/solinftec-pwa-mapv4-prod/assets/index-38ecfd88.js "Microfrontend de mapa SGPA: contrato de mensagens e dados de alarmes"
[12]: https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/ "Netlify credits and compute"
[13]: https://docs.netlify.com/build/functions/usage-and-billing/ "Netlify Functions Usage and Billing"


> **Atualização 23/11/2026 20:42 UTC:** o deploy `6b04a350a594bc37a6716375` (commit `a6bd5bb`) passou a servir `/api/push` com HTTP 200 e a chave VAPID pública correta. Os logs do cron mostraram `Push database RPC failed (401)`: a `SUPABASE_ANON_KEY` cadastrada estava truncada (um caractere a menos, `exp` inválido). A variável foi corrigida em Functions/Production com a chave anon oficial do projeto (validada por RPC read-only: `ok:true`, `hasSubscriptions:false`). Este commit gera o redeploy que aplica o valor corrigido; com zero inscrições o monitor termina em `no-subscriptions` sem consultar o SGPA. Envio Push real ainda não testado: começa quando um aparelho ativar o Push e aceitar a permissão.

## Versão 1.2.7 — alerta “Sem apontamento” (23/11/2026)

Novo alerta calculado pelo app a partir da operação atual do SGPA (ex.: `953 - Sem Apontamento`), para casos em que o portal não emite alarme. Dispara depois de 5 minutos contínuos na operação (campo “Sem apontamento (min)” nas configurações), respeita frentes/grupos e equipamentos selecionados e tem chavinha própria na Central. Por exceção autorizada pelo usuário, usa fala, pop-up, som, vibração e notificação do sistema somente com o app aberto; não passa pelo Web Push. Se o equipamento já tiver o alerta combinado “Motor ocioso sem apontamento”, não repete a fala. Fala: “Veículo seis seis um quatro sem apontamento há 6 minutos. Frente/grupo VEICULO LEVE. Verificar.” Cache `bperes-shell-v24`. Testes: 25 Push fixture, 58 grupos integrados, sessão/UI.

## Versão 1.2.8 — Controle de refeições (23/11/2026)

Nova seção “Controle de refeições” nas configurações da Central. Cada grupo/frente recebe um tempo (Não controlar, 30 min, 45 min, 1 hora, 1h30) e um campo por equipamento (`6614=30, 8833=60`; `=0` desliga) prevalece sobre o grupo. A refeição é detectada pela operação atual do SGPA contendo “Refeição” (ex.: `REFEIÇÃO`, `REFEIÇÃO (1 HORA)`, `REFEIÇÃO_TPL`), almoço ou jantar. Ao ultrapassar o limite, gera o alarme “Refeição excedida” com duração e limite, repetido conforme o cooldown; tem chavinha própria e usa fala/pop-up/som/notificação somente com o app aberto (não passa pelo Web Push). Grupos sem tempo configurado não são monitorados. Cache `bperes-shell-v25`. Testes: 25 Push fixture, 63 grupos integrados, sessão/UI.

## 1.2.9 — Aguardando Caminhão (905) imediato

- O apontamento `905 - Aguardando Caminhão` (por código `cdOperacao=905` ou descrição) gera o alarme na primeira leitura, sem esperar as leituras de confirmação.
- Detecção ampliada para variações que começam com "Aguardando Caminhão".
- Repetição segue o intervalo de repetição configurado. Cache `bperes-shell-v26`.
