# Central de alertas — construção e validação (2026-11-23, fase 2)

## Novas rotas medidas (acrescentar ao dossiê)

`POST https://api-usa.saas-solinftec.com/monitoramento/v2/actual-state?buId=1&language=pt-br`
- headers: `X-Auth-Token`, `Content-Type: application/json`, `request-origin: sgp-front`
- **corpo mínimo que funciona**: `{"cdCliente":[204],"cdUnidade":[1]}` → 200, 268 KB, 296 itens.
  Corpo com campos vazios (`cdEquipamento:""` etc. ou `null`) → **500**; arrays vazios → `[]`.
- campos por item: `cdUnidade descUnidade horimetro descFrente cdCliente cdEquipamento
  fgTpEquipamento dtHrLocal("23/11/2026 06:53:46") vlGrafico fgMonitoramentoAtivo descIcone
  descEquipamento cdOperador descOperador fgTipoOperac descOperacao descOperacaoCb vlDirecao
  cdEstado fgTpAlerta batteryPower batteryVoltage cdIdMissao cdEstadoMissao vlPontoMissao
  vlIndiceMissao vlPontoPassagemMissao vlIndicePassagemMissao geohash cdEquipe cdOperacao
  cdGrupoEquipamento cdGrupoAtividade cdGrupoOperacao cdProcesso cdImplemento`
- **sem velocidade e sem RPM** (isso só vem de `/estatistica/monitoramento`).

`POST .../monitoramento/v2/subscribe-live?buId=1&language=pt-br` — **STREAM NDJSON AO VIVO**
- headers iguais + `content-type: application/x-ndjson`; mesmo corpo do actual-state.
- linhas `{"type":"monitoramento","cdCliente":204,"cdEquipamento":"32305","dtHrLocal":"23/11/2026 06:53:46",
  "cdOperacao":"969","descOperacao":"969 - Aguard Bascul Transbo","cdOperador":"31003137",
  "descOperador":"31003137 - OPERADOR-117","cdEstado":"F","fgTpAlerta":"*NAO_DEFINIDO*",
  "vlGrafico":"#FF0000","vlDirecao":290.42,"fgMonitoramentoAtivo":"T","geohash":"6u5tz1uv8tmy","deleted":false}`
- só mudanças (push do servidor), ~26-49 quadros em 15-20 s. Também emite `type:"alarme"`.
- CORS para o navegador: `access-control-allow-origin: *` e
  `access-control-allow-headers: ... Content-Type ... x-auth-token, request-origin` → **pode chamar do browser**.
- o micro-frontend oficial mantém essa conexão num Web Worker filho, com reconnect de 1000 ms
  (`assets/monitoringWorker-190e5647.js` + `assets/subscribeLiveWorker-8212adab.js`).

`GET {sgpa}/alarmeOnline?ativo=true&idioma=pt-br&buId=1&language=pt-br` (locale:1) → 200, ~1 KB,
3 itens agora. **`idioma=pt-br` traz mais que `idioma=1`** e os textos já vêm traduzidos
(`descTpAlarme`, `descOperacao` sem o prefixo numérico).

`POST {sgpa}/alarmeOnline/filtrados/v2?page=0&size=3` com `{}` → 200, `totalElements: 1864` hoje;
campos + `descGrupoEquipamento`, `descJustificativa`.

`GET {sgpa}/alarmeTempoEquipamento?buId=1&language=pt-br` → 200:
`[{"cdEquipamento":"32304","tempo":"00:00:13","cdTpAlarme":4}, ...]` — duração corrente por alarme.

`GET {sgpa}/parametrosGerais/desc-param/EXIBE_ALARME_TELEMETRIA_MONITORAMENTO` → 200
`{"vlParametro":"F"}` (tenant não mostra alarmes de telemetria no monitoramento).

`GET {sgpa}/alarmeOnline/por-equipamento/{id}` → **404 no host BR** (existe no código do mapa,
não neste stage/host).

Escrita possível (NÃO usada de propósito): `POST {sgpa}/alarmeOnline/setJustificativas` —
justificar um alarme oficial. Ficou fora: não vamos escrever no sistema do cliente sem pedido explícito.

## Limites medidos
- sgpa-api: `x-ratelimit-limit: 10` por minuto por IP (header devolvido).
- Netlify Function (nosso serverless): 40 req/min por IP no nosso próprio rate limiter.
  Um disparo pode gerar dezenas de alertas → **auditoria em lote** (POST `{alertas:[...]}` a cada 20 s,
  pausa de 2 min em 429).

## Arquitetura implementada
`public/alerts.js` (motor, ~1 860 linhas) + `public/alerts-stream.js` (worker do stream) +
`public/alerts.css`; sino 🔔 com badge na barra; painel lateral (Ativos/Histórico), toasts
empilháveis com barra de tempo, tela de regras, CSV, notificação do sistema.
Fontes: stream (tempo real) + `/estatistica/monitoramento` (velocidade/RPM) +
`/alarmeOnline?ativo=true` (espelho oficial) + `/alarmeTempoEquipamento` (duração do servidor).
Fallback de rede: proxy `?acao=dados&rota=...` na Function (whitelist de rotas).

Regras e limiares padrão:
- `velocidade` ≥ 51 km/h (regra do tenant `VELOCIDADE_EXCEDIDA_50_VL`); opcional canavieiro 23 km/h (desligado)
- `rpm` ≥ 2000 no cálculo local; o limite correto é por tipo de máquina e chega pelo espelho oficial
  (oficial disparou em 1 089 e 2 199 RPM)
- `turno`: `descOperacao` `925 - Troca de Turno - HR` por ≥ **4 min** (pedido do usuário; o portal usa 3)
- `ocioso`: `vlEd1=1` + velocidade ≤ 1 + RPM ≤ 900 por ≥ 5 min

Histerese: `marcar()` (2 leituras negativas fecham o episódio) + `podeDisparar()` (cooldown 10 min).
`tique()` de 1 s avalia só regras de DURAÇÃO; as de LIMIAR são avaliadas depois de leitura nova.
Rajada: ao abrir o app nascem dezenas de alertas — só os `maxPorCiclo` (4) primeiros falam.
Tipos de alarme oficiais fora dos 4 pedidos ficam de fora, salvo `incluirOutros=true`.

## Validação AO VIVO (chromium + emulador, tools/teste-alertas.py)
- 1º ciclo com dados reais: 9 alertas, inclusive **8833 a 71-94 km/h (limite 51)**,
  32271 a 2.155 RPM, 6606 MOTOR OCIOSO pelo espelho oficial.
- Após 80 s com limiares de demonstração: **ocioso 17 · velocidade 12 · rpm 32 · turno 5** (as 4 regras).
- Frota real agora: 271 no feed, ~155 ativos; **7 máquinas em "925 - Troca de Turno - HR" com
  `9999 - OPERADOR INDEFINIDO`** (o cenário exato pedido pelo usuário); 34 com assinatura de motor ocioso.
- Campo `horas` do `/estatistica/monitoramento` é `0` para todos os ativos → não serve de duração;
  por isso a duração é o nosso relógio + `alarmeTempoEquipamento` + stream.
- Fala gerada (formato pedido): "Veículo 8833, operador Gilmar Pereira Rodrigues, excedeu a
  velocidade: 71 quilômetros por hora, limite 51 quilômetros por hora. Verificar."
- `classeFala` usa nome/frente antes do tipo (o cadastro do tenant traz "TRATOR DE PNEU LEVE"
  para um carro leve OROCH) → "Veículo 8833" em vez de "Trator 8833".
- `localStorage` OK na nossa origem; o `pageerror "Access is denied for this document"` vem do
  iframe do mapa (armazenamento de terceiros no headless) — não é do nosso código.
- Chromium headless daqui tem 0 vozes pt-BR instaladas → no aparelho do usuário depende do sistema;
  no APK usamos a ponte nativa `AndroidTTS`.

## Como o mapa interage (do relatório do micro-frontend)
- `postMessage` aceito pelo iframe: **somente** `{type:'props', data:{...}}` (12 campos obrigatórios).
- Para centralizar/abrir popup de um equipamento: mandar `props` com **`rastroBI:{equipment:<cd>}`**
  sem start/end → o mapa faz `mapref.flyTo({center, zoom:20, offset:[-350,0]})` + abre o popup.
  Implementado em `abrirNoMapa()`.
- O iframe **emite** (como STRING JSON, targetOrigin `*`) só 4 eventos:
  `event-online-message`, `event-online-command`, `event-calibration-rtk`, `event-meteorology-click`,
  todos com `{cdEquipamento, descEquipamento}`. Não há "selecionado" genérico → o modo
  "alertar só do que foi clicado no mapa" usa esses eventos + a lista manual de equipamentos.
- Ganchos não documentados que existem: `window.mapref` (Mapbox GL), `window.mapref.__deck`,
  `document.querySelector('#app').__vue__` — não usamos (podem mudar a qualquer build).

## Pendências
1. `tools/teste-alertas.py`: capturar o pop-up logo após o 1º ciclo (o sleep de 80 s faz os
   toasts expirarem antes da captura).
2. APK v1.2: ponte `AndroidTTS` (`TextToSpeech` + `vibrar`) no MainActivity — WebView não tem
   `speechSynthesis`.
3. Supabase: tabela `pwa_alertas` no `supabase/schema.sql` + documentação.
4. Reempacotar zip (`tools/pack.sh` + `audit.py`), `SHELL bperes-shell-v10`, PDFs de evidência,
   README/LEIA-ME com a central de alertas.
5. Avisar o usuário: reenviar o zip ao Netlify, criar as env vars, trocar a senha que circulou no chat.

## Status final desta fase (23/11/2026)
1. ✅ Captura do pop-up logo após o 1º ciclo (`alerta-{sufixo}-01b-popup-inicial.png`) — 5 pop-ups no celular.
2. ✅ APK v1.2 (versionCode 3) com `MainActivity.PonteVoz` → `TextToSpeech` pt-BR + vibração
   (`permission VIBRATE`); `HOME_URL` agora aponta para o PWA do Netlify, que por sua vez abre o
   mapa do portal — o alerta com voz passa a funcionar dentro do app instalado. Assinado com o
   mesmo keystore (`CN=Monitoramento BP`), 124 KB.
3. ✅ `supabase/schema.sql` ganhou `pwa_alertas` (com `severidade`, `valor`, `limite`, `fonte`,
   `fala`), índices e as visões `pwa_alertas_diario` e `pwa_alertas_top_equipamento`; a Function
   grava exatamente esses campos.
4. ✅ `README.md` seção 13 (Central de Alertas) + `docs/RELATORIO-CENTRAL-DE-ALERTAS.md/.pdf`;
   zip final `MonitoramentoBP-PWA-Netlify.zip` (5 554 KB, 50 arquivos, auditoria OK,
   `SHELL bperes-shell-v13`).
5. Polimento: pilha de toasts limitada a 3 em telas curtas; vibração do navegador só depois do
   primeiro toque (elimina o aviso do console); campo `limite` registrado em cada alerta;
   chapa de evidências `docs/chapa-central-de-alertas.png`.

Teste de fumaça pós-ajustes: sino e CSS carregados, badge com 7 alertas, **zero erros de console**,
stream conectado. Falta só a evidência de áudio em Chrome com voz pt-BR (o sandbox não tem engine de
voz: `getVoices().length = 0`) — no APK isso é resolvido pela ponte nativa.
