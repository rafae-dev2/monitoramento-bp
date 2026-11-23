# Central de alertas SGPA — atualização de 23/11/2026

A central passa a usar exclusivamente o alarme oficial do SGPA para velocidade. Uma leitura de telemetria acima de 51 km/h, por si só, não gera mais aviso de velocidade. Quando o SGPA emitir um alarme desse tipo, o aplicativo o incorpora à central e entrega os canais escolhidos pelo usuário. A fala do equipamento lê cada algarismo: “Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.” A medição vem primeiro do alarme; se faltar, o app tenta uma leitura recente da telemetria. Se nenhuma fonte trouxer um valor válido, informa o alarme sem inventar velocidade.

## Escolha dos alertas

Em Central de alertas → configurações, as chaves selecionam velocidade, RPM, motor ocioso, troca de turno, condições combinadas do motor, espera por caminhão e demais alarmes oficiais. A seção de tipos individuais permite procurar por nome ou código SGPA e silenciar cada tipo. A seleção de um tipo depende também da chave de sua categoria.

As chaves são salvas automaticamente neste navegador/aparelho. Os controles gerais de leitura, fontes e canais continuam com botão Salvar preferências. Desligar as notificações de um tipo não o remove da central nem do histórico; o cartão informa que seus avisos estão desligados. Preferências antigas de canais, limites complementares e escopo são preservadas. A preferência antiga “incluir outros” desligada mantém a categoria de demais alarmes silenciada, mas não descarta mais esses eventos. Novas instalações começam com todas as categorias habilitadas.

Velocidade não tem mais campo de limite local. RPM, ociosidade e troca de turno mantêm cálculo complementar opcional. Os códigos 2697 e 2699 ficam como condição combinada do motor; seus valores não são narrados como velocidade pura.

## O que foi auditado no SGPA

A consulta do cadastro confirmou **2.972 tipos gerais de alarme, 38 regras cadastradas e 39 expressões**. Os filtros do histórico apresentaram 23 nomes de tipos, todos encontrados no catálogo. Esses conjuntos não são equivalentes: a existência de um tipo no catálogo geral não comprova que esteja configurado ou ativo nesta unidade. Correspondência entre nomes de regra e tipo é exibida como correspondência de nome, não como vínculo confirmado.

Todas as 39 expressões aparecem no inventário de consulta dentro das configurações. O arquivo `public/sgpa-alert-catalog.json` contém o catálogo selecionável e esse inventário sanitizado. `docs/AUDITORIA-ALERTAS-SGPA.json` contém os nomes, tipos de equipamento, campos usados nas condições e comparações de velocidade de cada expressão. Não inclui token, equipamentos individuais, operadores, filtros pessoais ou SQL completo.

Treze expressões incluem velocidade. Para caminhão de apoio, os limiares observados são 52, 41, 44 e 23 km/h; a condição de 44 também envolve operação de vinhaça. Para caminhão canavieiro, aparecem 40 km/h e duas expressões de 23 km/h. Para o tipo cadastral TRATOR DE PNEU LEVE/MAG 100, aparecem 62, 65 e 51 km/h, além de condições de 30 km/h relacionadas a operador e de 5 km/h relacionada ao grupo Equipamento Inativo. Essas condições não devem ser reduzidas a um limite único de 51 km/h. Não foi encontrado campo explícito de pavimento; o nome RURAL não comprova estrada de terra.

Todos os tipos de alarme oficialmente recebidos, inclusive tipos desconhecidos do mapeamento inicial, entram na central com seu nome original. As expressões continuam executadas no SGPA, não são recriadas no aplicativo. Isso evita inventar os predicados ou a associação entre expressão e código de alarme que o cadastro consultado não expôs.

## Tratores e transbordos aguardando caminhão

O rastreio usa o tipo de equipamento e `descOperacao` da telemetria. A comparação aceita diferenças de maiúsculas, acentos, espaços, prefixo numérico com hífen e os sufixos HD/HR. Exige a operação “Aguardando Caminhão”; “Aguardando Carregamento” e “Aguard Bascul Transbo” não são tratados como sinônimos.

O aviso inclui o equipamento e `descGrupoEquipamento`, apresentado como frente/grupo porque nem todos os rótulos desse campo são uma frente numerada. Se o campo estiver vazio, informa que a frente não foi informada. O rastreio funciona mesmo se o cálculo complementar de RPM/ociosidade/turno estiver desligado. Respeita as leituras de confirmação e o cooldown configurados; duas leituras fora da operação encerram o episódio e uma nova entrada pode gerar novo aviso.

O retrato de telemetria auditado tinha 271 equipamentos, dos quais 162 com tipo contendo trator ou transbordo. **Nenhum estava em “Aguardando Caminhão” naquele retrato.** O detector foi validado com fixtures isoladas, não com um evento real dessa operação. Da mesma forma, não havia alarme oficial de velocidade ativo na consulta anterior; a integração de velocidade foi testada com fixtures, sem afirmar validação ao vivo que não ocorreu.

## Validação e funcionamento

O teste de política cobre categorias, seleção por tipo, migração de preferências, identificadores com zeros iniciais, valores ausentes e frases. O teste integrado passou 30 grupos de comportamento, incluindo velocidade oficial com leitura recente e com consulta agrupada à telemetria, mensagem sem valor inventado quando nenhuma fonte mede, foco no iframe sem link externo, deduplicação stream/REST, independência dos tipos oficiais, preservação de central/histórico, gates de desligamento, espera por caminhão e encerramento de episódio, manutenção de RPM complementar, persistência das chaves e layout móvel sem overflow horizontal. Não houve erro JavaScript nem chamada de rede ou escrita de produção nos testes. Comandos: `node tools/test-alerts-policy.cjs` e `python3 tools/test-alerts-integrated.py`.

O espelho oficial e a telemetria são lidos a cada 45 segundos por padrão; o stream pode antecipar os eventos. Falha de telemetria não bloqueia a consulta dos alarmes oficiais. O mesmo tipo de alarme do mesmo equipamento é deduplicado entre as duas fontes; tipos diferentes continuam independentes. A central e o espelho desligados bloqueiam também o caminho de stream. Os exemplos de teste não alteram a frota consolidada nem são enviados ao Supabase.

A versão da central é **1.2.1**, com cache **bperes-shell-v16**. A fala depende de voz disponível no navegador ou da ponte AndroidTTS do APK. Notificações do sistema exigem permissão; no PWA móvel são entregues via service worker. Não foi implementado Web Push com coleta autônoma no servidor: o navegador/aplicativo precisa estar em execução e o sistema operacional pode suspender a atividade em segundo plano. Não há promessa de avisos com o app totalmente fechado.

Nenhuma regra, justificativa ou cadastro do SGPA foi alterado e não houve migração de banco nesta atualização. As preferências continuam locais. Eventos reais continuam usando a auditoria Supabase já existente; habilitar mais tipos pode aumentar o volume de histórico.

## Referências

[1]: https://sgpa-api-br.saas-solinftec.com/slf03/tipo-alarme "Cadastro autenticado SGPA de tipos de alarme"
[2]: https://sgpa-api-br.saas-solinftec.com/slf03/regra "Cadastro autenticado SGPA de regras"
[3]: https://sgpa-solinftec-bpa.netlify.app/.netlify/functions/session?acao=dados&rota=%2Fregra-expressao "Proxy autorizado de expressões SGPA"
[4]: https://sgpa-api-br.saas-solinftec.com/slf03/alarmeOnline/alarme-filtros "Filtros autenticados do histórico de alarmes SGPA"

As contagens e condições acima foram obtidas por leitura dos cadastros [1] [2] [3] [4] em 23/11/2026. A telemetria foi analisada somente em campos estritamente necessários e relatada de forma agregada.

## Publicação verificada

A versão 1.2.0 foi publicada no site existente https://sgpa-solinftec-bpa.netlify.app/. O Netlify informou o deploy `6b043b0d83f5c3af4c09bff4` como ready, em contexto production, publicado em 23/11/2026. HTML, motor, política, CSS, service worker e catálogo responderam HTTP 200 com hashes iguais aos arquivos locais validados. As rotas de leitura de tipos e filtros responderam HTTP 200, retornando respectivamente 2.972 tipos e 23 nomes de filtros.

## Pedido complementar do usuário — 23/11/2026

Na consulta somente leitura à rota pública mediada `https://sgpa-solinftec-bpa.netlify.app/.netlify/functions/session?acao=dados&rota=%2FalarmeOnline%3Fativo=true%26idioma=pt-br`, HTTP 200, havia cinco alarmes ativos e nenhum de velocidade; portanto, não foi possível verificar um payload real de excesso de velocidade naquele momento. A documentação do tenant descreve `vlAlarme` como valor medido do alarme e também registra `vlAlarmeMaximoAtingido`; a implementação usa esses campos primeiro e a leitura recente `vlVelocidade` da telemetria SGPA como complemento, sem converter `vlPeso` em velocidade. Fonte local: `docs/NOTAS-ALERTAS.md`, itens 1 e 4.

No mapa, `app.js` fornece `session.mapUrl` como URL completa para o iframe. Os envios usam a origem (`new URL(mapUrl).origin`). “Ver no mapa” envia `props.rastroBI.equipment` ao mapa incorporado, fecha o painel após o envio e nunca abre URL externa; se o iframe não estiver pronto, exibe um aviso dentro do app.

## Correção complementar implementada — 23/11/2026

Para o gatilho exclusivamente oficial de velocidade, o app tenta `vlAlarme`, depois `vlAlarmeMaximoAtingido`; se ambos faltarem, só usa `e.velocidade` quando `velocidadeTs` indica uma leitura recente. Quando necessário, uma única consulta compartilhada à telemetria atualiza os alertas pendentes. O número é apresentado em km/h e falado como valor normal; se nem o alarme nem a telemetria fornecerem medição válida, o alerta oficial permanece sem número. O valor recebido depois também atualiza o cartão e o histórico, com fala/notificação conforme as preferências, sem criar duplicata de auditoria.

Testes com fixtures cobriram a leitura recente em memória, a consulta complementar agrupada e o foco do equipamento no mapa incorporado; nenhum teste chamou rede ou gravou dados de produção. A consulta ao vivo da rota de alarmes, no momento registrado acima, não continha evento de velocidade: a correção de medição foi validada com fixtures, não com um evento real.
