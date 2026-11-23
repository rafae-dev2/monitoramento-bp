# Central de Alertas — relatório consolidado
Branco Peres · Monitoramento BP (PWA + APK) · 23/11/2026

## 1. O que foi pedido
> "Todo equipamento selecionado no mapa que gere alerta de **velocidade excedida**, **RPM máxima
> do motor**, **preso em troca de turno mais de 4 minutos** (o operador esquece de dar a baixa),
> **motor ocioso**, com **pop-up na tela** e **opção de fala** — ex.: *'veículo 8833 operador
> Rafael excedeu a velocidade verificar'* — de forma premium e profissional."

## 2. O que foi entregue
| Item | Estado |
|---|---|
| Motor de alertas no PWA (`public/alerts.js`, ~1 900 linhas) | pronto e validado com frota real |
| Stream ao vivo (`public/alerts-stream.js`, Web Worker NDJSON) | conectado, sem polling |
| Interface premium (sino + badge, central lateral, toasts, tela de regras, CSV) | `public/alerts.css` |
| Voz pt-BR no navegador (`speechSynthesis`) + ponte nativa no APK | frase no formato pedido |
| APK v1.3 (versionCode 4) apontando para o PWA, com TTS e vibração | assinado, 121 KB |
| Trilha no Supabase (`pwa_alertas`) + Function em lote | `supabase/schema.sql` |
| Proxy de dados na Function (`?acao=dados`) para redes que bloqueiam CORS | whitelist de rotas |
| Empacotamento + auditoria do zip | 5 550 KB, 49 arquivos, sem senha literal |

## 3. Regras e limiares (padrões ajustáveis na tela "Regras")
| Regra | Dispara quando | Padrão |
|---|---|---|
| Velocidade excedida | leitura ≥ limiar | **51 km/h** (regra do tenant `VELOCIDADE_EXCEDIDA_50_VL`); opcional 23 km/h canavieiro (off) |
| RPM máxima do motor | RPM ≥ limiar **ou** alarme oficial de RPM | **2 000 RPM** local; limite de fábrica chega pelo espelho oficial |
| Preso em troca de turno | operação `925 - Troca de Turno - HR` por ≥ N min | **4 min** (portal usa 3); alerta se estiver sem operador |
| Motor ocioso | motor ligado, vel ≤ 1 km/h, RPM ≤ 900 por ≥ N min | **5 min** |

Anti-ruído: histerese (2 leituras contrárias encerram o episódio), cooldown de 10 min por
equipamento+regra, filtro de dados defasados (> 20 min sem comunicação) e controle de rajada
(máximo 4 falas por ciclo; o restante entra mudo na lista).

## 4. Fontes de dados medidas (engenharia reversa)
| Rota | Para que serve |
|---|---|
| `POST api-usa…/monitoramento/v2/subscribe-live` (NDJSON) | telemetria em tempo real: operação, operador, estado, direção, tipo de alarme — push, ~35-49 quadros/16 s |
| `GET api-br…/estatistica/monitoramento` | **única** rota com velocidade e RPM (271 linhas; 10 req/min/IP) |
| `GET api-br…/alarmeOnline?ativo=true&idioma=pt-br` | espelho oficial (limite de RPM por tipo de máquina) |
| `GET api-br…/alarmeTempoEquipamento` | duração já contada pelo servidor (semente das regras de tempo) |
| `POST …/monitoramento/v2/actual-state` | fotografia inicial dos 296 equipamentos (sem vel/RPM) |

Nada escreve no portal: justificar alarme continua sendo ato humano no sistema oficial.

## 5. Validação com dados reais
**Desktop (1366×768)** — 1º ciclo: 10 alertas, inclusive `8833` a 71 km/h e `6614` a 81 km/h;
com limiares de demonstração (`vel 12 · rpm 32 · ocioso 17 · turno 5`) as quatro regras
dispararam juntas sobre ~160 equipamentos vigiados; histórico de 74 eventos; 23 frentes listadas.

**Celular (390×844)** — 5 pop-ups simultâneos no 1º ciclo; por regra `rpm 27 · ocioso 19 ·
velocidade 14 · turno 3`; zero requisições com erro; zero HTTP 429.

**Fala gerada (exemplo real):**
> "Veículo 8833, operador Gilmar Pereira Rodrigues, excedeu a velocidade: 71 quilômetros por hora,
> limite 51 quilômetros por hora. Verificar."

**Teste de fumaça após os últimos ajustes:** sino e CSS carregados, badge com 7 alertas,
**zero erros de console**.

Ruído conhecido: `Failed to read the 'localStorage'` vem do iframe do mapa (armazenamento de
terceiros bloqueado no Chromium headless) — não é do nosso código; em Chrome normal não aparece.

## 6. Voz: o que fazer se não houver
No sandbox não há voz pt-BR instalada (`getVoices().length = 0`), então a validação foi da **frase
gerada**, não do áudio. Em produção:
- navegador de desktop → usa a voz do sistema; se não houver pt-BR, cai no som de campainha;
- **APK** → ponte `window.AndroidTTS` (`MainActivity.PonteVoz`) com `android.speech.tts`,
  português do Brasil com fallback para o idioma do aparelho, mais vibração (`VIBRATE`);
- em qualquer caso o pop-up e o registro no histórico funcionam.

## 7. Publicar (Netlify)
1. Pegar o pacote `MonitoramentoBP-PWA-Netlify.zip` e arrastar em app.netlify.com/drop (ou redeploy do site
   `sgpa-solinftec-bpa.netlify.app`).
2. Environment variables: `SOLINF_USER=SEU-USUARIO-DO-PORTAL`, `SOLINF_PASS=<nova senha>` e, se quiser trilha,
   `SUPABASE_URL` + `SUPABASE_KEY` (anon, com a migration de escrita append-only).
3. Rodar `supabase/schema.sql` no SQL Editor (cria `pwa_acessos`, `pwa_config`, `pwa_alertas`).
4. Redeploy. Cache: `SHELL bperes-shell-v13` garante que o app antigo não sirva a casca velha.
5. No celular, abrir o PWA e instalar (⋮ → Instalar aplicativo).

## 8. Riscos e cuidados
- A automação reutiliza **a sua conta** (`SEU-USUARIO-DO-PORTAL`): o log de acessos do portal vai marcar
  entradas vindas do Netlify. Se o contrato com a Solinftec proibir integração não oficial,
  solicite uma API/chave própria antes de escalar o uso.
- Trocar a senha que circulou neste chat (ela apareceu em texto) — o app continua funcionando
  depois de atualizar `SOLINF_PASS`.
- Limite de 10 req/min/IP medido no servidor da Solinftec: não reduzir o intervalo padrão para
  valores agressivos; o stream já entrega o tempo real sem custo de polling.
- Nada aqui burla captcha, MFA ou controle de acesso.

## 9. Arquivos
- Projeto: `/home/ubuntu/netlify/monitoramento-pwa/` (zip pronto em `/home/ubuntu/netlify/`)
- APK: `/home/ubuntu/solinftec/MonitoramentoBP-v1.3.apk` (v1.2 fica como backup)
- Variáveis do Netlify /Supabase: `docs/VARIAVEIS-NETLIFY.md`
- Dossiês técnicos: `docs/NOTAS-ALERTAS.md`, `docs/NOTAS-ALERTAS-2.md`, `docs/mapa-dados-ao-vivo.json`
- Evidências: `docs/out/alerta-desktop-*.png`, `docs/out/alerta-celular-*.png`,
  `docs/chapa-central-de-alertas.png`, relatórios `.txt`

## 10. Republicação no projeto `sgpa-solinftec-bpa` (23/11)

- Deploy publicado via API do Netlify a partir de `deploy-sgpa/` (23 arquivos, 1,1 MB de `public/`);
  shell agora em `bperes-shell-v14`. Endereço: `https://sgpa-solinftec-bpa.netlify.app/`.
- Variáveis conferidas no site: `SOLINF_USER`, `SOLINF_PASS`, `CLIENT_OWNER`, `CLIENT_NAME`,
  `SUPABASE_URL`, `SUPABASE_KEY`. A chave do Supabase usada é a **anon**, porque a migration
  `supabase/escrita-append-only.sql` libera só `INSERT` em `pwa_alertas`/`pwa_acessos` — sem
  expor a `service_role` no provedor de hospedagem.
- Teste de fumaça ao vivo, no navegador, contra o site publicado: motor ligado, 168 equipamentos
  vigiados / 65 ativos, stream `subscribe-live` sem *polling*, 9 alertas no 1º ciclo, frases de voz
  no formato pedido, 67 eventos no histórico do aparelho, **zero** requisição com erro e zero 429.
- Banco: 106 linhas em `pwa_alertas` escritas pela Function durante essa coleta (rpm 49, ocioso 44,
  velocidade 13; fontes `app` e `portal`), conferidas com `select … group by regra, fonte`.
- APK **v1.3 (versionCode 4)** reconstruído com `HOME_URL` no endereço novo e a lista de hosts
  aceitos levando os dois domínios; mesma assinatura, então instala por cima da v1.2.
- Conhecido e inocuamente: o único `pageerror` do teste (`Failed to read the 'localStorage'
  property`) vem do iframe do micro-frontend do mapa. Comprovado com `tools/probe-erro.py`, que
  abre o site com e sem o iframe do fornecedor: com o iframe bloqueado, o erro desaparece e o
  nosso shell continua enxergando o storage. Ainda assim a `v14` blinda os acessos do shell.
