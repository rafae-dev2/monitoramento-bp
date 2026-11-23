# Monitoramento BP — PWA para Netlify

PWA instalável que **abre direto no monitoramento** (`#!/details/analytic-map-v4`) da unidade
Branco Peres, **sem tela de login**: a sessão é obtida automaticamente com o seu usuário e senha
guardados **apenas no servidor** (Netlify Environment Variables).

O app **não é uma cópia do site**: ele carrega o micro-frontend oficial do mapa da Solinftec
(`solinftec-frontends.saas-solinftec.com/solinftec-pwa-mapv4-prod`) dentro dele e entrega a essa
tela exatamente o mesmo pacote de dados (`props`) que o próprio portal entrega — só que obtido
programaticamente, com login automático.

Foi testado de ponta a ponta com a conta real: mapa com talhões, equipamentos em operação e todos
os painéis de camadas renderizando a partir de um domínio que **não** é da Solinftec.

Desde então ganhou a **Central de Alertas** (seção 13): pop-up + voz no navegador para velocidade
excedida, RPM máxima do motor, equipamento preso em troca de turno e motor ocioso, com histórico,
exportação CSV e trilha no Supabase. Testada com a frota real do tenant.

---

> **Capturas de tela não estão neste repositório.** as imagens do app mostram nomes reais de
> operadores, matrículas de máquina e posição no campo — dado pessoal e dado operacional de
> terceiros. Elas ficam fora do git por padrão (veja `.gitignore`); para publicar uma, gere a
> captura com dado fictício (botão *Testar pop-up e voz* da central) ou rasure antes.

---

## 1. Por que não dá para simplesmente colocar o site dentro de um iframe

| Tentativa | O que acontece |
|---|---|
| `<iframe src="https://branco-peres-cana.saas-solinftec.com/#!/details/analytic-map-v4">` | **Bloqueado.** O portal responde `Content-Security-Policy: frame-ancestors 'self'`. |
| Login feito pelo navegador de quem acessa | **Bloqueado na prática:** a tela de login é AngularJS com estado `#!/login`, e você não controla esse DOM de outro domínio. |
| Senha escrita no front-end (arquivo JS/HTML no Netlify) | **Não faça isso.** Qualquer pessoa com a URL copia a senha do código-fonte. |
| **Login feito pela Netlify Function + iframe do micro-frontend do mapa** | **Funciona.** Foi o caminho implementado. As APIs aceitam o token no header `X-Auth-Token` e respondem `Access-Control-Allow-Origin: *`, então os dados carregam de qualquer origem. |

A senha fica só em variável de ambiente do Netlify. O navegador do usuário nunca vê a senha; ele
recebe apenas o token já emitido.

## 2. O que faz a Netlify Function (`netlify/functions/session.mjs`)

1. `POST {AUTH_API}/auth-sgpa/create` com `{language, login, password, owner, time:604800, environment:"BROWSER"}`
   — mesma chamada que a tela de login do portal faz. **Sem captcha.** Devolve um JWT de ~327 caracteres,
   válido por 7 dias.
2. `GET {SGPA_API}/user/byUsername/<usuario>` → `cdGrupo` (vai como `userGroupId`).
3. `GET {SGPA_API}/unidade` → unidade ativa, nome e fuso (vão como `cdUnidadeRegional`, `descUnidade`, `timeZone`).
4. Monta as `props` **campo a campo iguais** às que o shell do portal entrega ao iframe `#map-v4-iframe`
   (o micro-frontend confere só os tipos: `cdCliente` número, `cdUnidadeRegional` lista de números,
   `token`/`locale`/`urlServiceGo`/`urlTileServiceGo`/`urlInterpolationServiceGo` strings, `grupo` e
   `userGroupId` números). Não há validação de origem no `postMessage`.
5. Cacheia o resultado por 5 dias por instância (o token dura 7) e limita 40 requisições/min por IP.

## 3. Deploy no Netlify (5 minutos)

### Situação atual deste projeto (site no ar)

O app está publicado em **`https://sgpa-solinftec-bpa.netlify.app/`** (projeto Netlify
`sgpa-solinftec-bpa`). As variáveis obrigatórias já estão cadastradas lá; a tabela completa e o
passo a passo de conferência estão em [`docs/VARIAVEIS-NETLIFY.md`](docs/VARIAVEIS-NETLIFY.md).
Regra de ouro: depois de mexer em variável, **reimplante** (item 4) — variável nova não entra na
função que já está publicada.

### Opção A — arrastar e soltar
1. Compacte a pasta `monitoramento-pwa` (ou use o `.zip` deste pacote).
2. Netlify → **Add new site** → **Deploy manually** → solte o `.zip`.
3. **Site configuration → Environment variables** → adicione:

   | Variável | Valor |
   |---|---|
   | `SOLINF_USER` | `SEU-USUARIO-DO-PORTAL` |
   | `SOLINF_PASS` | sua senha (veja o item 6 antes de colocar) |
   | `CLIENT_OWNER` | `branco_peres_cana` |
   | `CLIENT_NAME` | `branco-peres-cana` |
   | `SUPABASE_URL` | `https://<ref-do-projeto>.supabase.co` (historico de alertas; opcional) |
   | `SUPABASE_KEY` | chave **anon** ou **service_role** (veja a nota de segurança abaixo) |

   As demais (`AUTH_API`, `SGPA_API`, `SERVICE_API`, `TILE_API`, `INTERP_API`, `MAP_URL`,
   `PORTAL_URL`, `CD_CLIENT`) já vêm com o valor correto deste tenant no `.env.example`.
   Cole os valores **sem aspas** e sem espaços sobra (`SOLINF_USER=SEU-USUARIO-DO-PORTAL`). Na interface
   atual do Netlify o menu pode estar como **Environment secrets** — é o mesmo lugar. Não marque
   "Preview only": a função precisa ver a variável no deploy de produção.

   **Sobre a chave do Supabase:** a função só *insere* linhas (auditoria de acesso e alertas). Em
   vez de entregar a `service_role` (que manda em tudo), rode a migration
   `supabase/escrita-append-only.sql`: ela libera `INSERT` para o papel `anon` nas tabelas
   `pwa_alertas`/`pwa_acessos` e tira qualquer outro direito. Aí a `SUPABASE_KEY` pode ser a chave
   **anon** (Dashboard → API Keys → *Project API keys* → `anon` / `publishable`). Se preferir a
   `service_role`, ela também funciona sem alteração de código.
4. **Deploys → ⋯ (Options) → Redeploy → Deploy latest production / Clear cache and rebuild.**
   Passo obrigatório: variável criada depois do deploy **não** entra na função já publicada.
5. Confira no navegador: `https://<seu-site>.netlify.app/.netlify/functions/session` deve
   responder `200` com `"props": {...}`. Se vier `501`, as variáveis não chegaram na função.
6. Abra `https://<seu-site>.netlify.app/?tela=analytic-map-v4` → cai direto no mapa.

### Sem variável no Netlify? Existe o modo local

Se você ainda não configurou (ou não quer colocar a senha no Netlify), o app tem um segundo
caminho: ele mesmo faz o login do navegador, direto no endpoint oficial de auth da Solinftec.
Isso funciona porque essa API responde `Access-Control-Allow-Origin: *` e libera o header
`request-origin` no preflight — medido de um domínio externo antes de entregar.

- Quando a função responde `501` (sem variáveis), o app abre a tela **"Entrar no monitoramento"**.
- Você digita usuário/senha **uma vez**; marcando *Lembrar neste aparelho*, eles ficam no
  `localStorage` daquele aparelho e as próximas aberturas entram direto, sem servidor.
- A senha nunca é enviada para a Netlify nesse modo — só para o `auth-api.saas-solinftec.com`.
- **Trade-off honesto:** no servidor a senha fica no painel do Netlify (visível para quem tem
  acesso ao site); no modo local ela fica no navegador de cada aparelho (visível para quem mexer
  naquele aparelho, e **não** criptografada). Para um celular/PC só seu, o modo local é o mais
  simples. Para várias pessoas/aparelhos, prefira a variável de ambiente.
- Para reverter: ⚙ → **Esquecer este aparelho**. Para trocar de conta: ⚙ → **Entrar com minha senha**.

### Opção B — CLI
```bash
cd monitoramento-pwa
npm i -g netlify-cli
netlify login
netlify env:set SOLINF_USER 'SEU-USUARIO-DO-PORTAL'
netlify env:set SOLINF_PASS 'SUA_SENHA'
netlify env:set CLIENT_OWNER 'branco_peres_cana'
netlify env:set CLIENT_NAME 'branco-peres-cana'
netlify deploy --build --prod
```

### Opção C — Git
Suba a pasta para um repositório e conecte no Netlify. Build command vazio, publish directory
`public`, functions em `netlify/functions` (já configurado no `netlify.toml`).

## 4. Instalar como aplicativo

Abra a URL no Chrome/Edge (desktop) ou Chrome (Android) e toque em **Instalar** (botão na barra
superior) ou no ícone de instalação da barra de endereço. No iOS: Compartilhar → *Adicionar à Tela
de Início*. Depois de instalado, o ícone abre direto no monitoramento, em janela própria, sem abas.

Para instalar em vários tablets de cabine sem interação: publique a URL e use o MDM, ou
`adb install` do Chrome com `--es override_url` — o app em si é web, não precisa assinar nada.

### 4.1 Marca (brasão, favicon, ícones)

O logotipo da Branco Peres aparece na barra do app, nos cartões de carregando/erro/login/sobre,
na aba do navegador (favicon 16/32/48), no ícone instalado (192/512 + maskable) e no
`apple-touch-icon` (iOS). Os arquivos vivem em `public/icons/`:

- `logo.png` — brasão como veio (512×512, fundo branco);
- `logo-mark.png` — brasão recortado com **fundo transparente**, usado na interface;
- os demais são gerados a partir dele.

Para trocar por outra arte, salve o novo PNG em `public/icons/logo.png` e rode:

```bash
python3 tools/make-icons.py public/icons/logo.png
```

O script remove o fundo branco em volta do brasão, centraliza a arte e reescreve favicon
(16/32/48), ícones "any" (192/512), "maskable" (192/512) com o brasão dentro da **zona segura**
de 66% que os launchers do Android recortam, e o `apple-touch-icon-180` do iOS. Depois, aumente o número
em `public/sw.js` (`bperes-shell-vN`) para que quem já instalou baixe os arquivos novos, e
reimplante. As cores do brasão (`#d82424`, `#f0cc0c`, `#006c30`) estão nas variáveis
`--bp-*` do `styles.css` — é de lá que sai o filete tricolor embaixo da barra.

Na barra, o brasão aparece com halo claro (para não sumir no fundo escuro) e, em telas de
até 480 px, a barra encolhe o nome e esconde o usuário — ele continua legível em ⚙ → *Sobre*.

No Android, o nome que aparece embaixo do ícone instalado vem de `short_name` do manifest
(hoje `Monitoramento BP`). Se o ícone instalado continuar o antigo depois do reimplante, é o
cache do launcher: reinstale o app ou limpe os dados do site.

## 5. Trocar a tela de destino

A tela vem do parâmetro `?tela=` do `start_url` do manifest:

| Valor | O que abre |
|---|---|
| `analytic-map-v4` (padrão) | O mapa analítico de monitoramento, **embedado** |
| `dashboard`, `connectivity`, `alarm`, qualquer outro | Abre o portal oficial numa aba (o portal não permite iframe) |
| `monitplus` | Abre o Monit+ com a sua sessão (`monitplus.saas-solinftec.com/?token=…`) |

Quer outra tela embutida de verdade? Só se ela também for um micro-frontend sem
`frame-ancestors` — me diga qual e eu testo o handshake dela do mesmo jeito.

## 6. Segurança e contrato — leia antes de publicar

- **A senha fica no Netlify, em claro, nas variáveis de ambiente.** Elas ficam legíveis para quem
  tem acesso ao painel do site. Se o seu Netlify for compartilhado, use um site só seu.
- **Proteja a URL do app.** Sem proteção, qualquer pessoa que descobrir o endereço consome a sua
  função e obtém um token válido. Opções, da mais simples à melhor:
  1. Netlify → Site configuration → **Access control → Password protection** (define uma senha
     antes de servir qualquer página);
  2. **IP allow-list** (se a fazenda tem IP fixo);
  3. `APP_KEY` no `.env.example` — barreira fraca, porque a chave aparece no front-end.
- **Troque a senha do portal** se ela já circulou em conversas ou e-mails. O app para de funcionar até
  você atualizar `SOLINF_PASS` — é o único ajuste necessário.
- **Isto é uso interno.** O app não deve ser distribuído publicamente nem usado como produto: os
  dados, o mapa e a marca continuam sendo da Solinftec. Antes de expor para terceiros, confira o
  contrato/licença de uso do SaaS (normalmente veda acesso automatizado e cessão de credencial).
- O painel de monitoramento em si é o software da Solinftec; este app só automatiza a entrada.

## 7. Banco de dados (opcional, Supabase)

O app funciona sem banco. O Supabase entra quando você quer **histórico consultável**: quais
alertas dispararam, em qual equipamento, com que valor/limite e quem estava logado — coisa que a
tela mostra só na sessão atual. Rode `supabase/schema.sql` no SQL Editor e depois
`supabase/escrita-append-only.sql`; no Netlify preencha `SUPABASE_URL` + `SUPABASE_KEY`.

- `public.pwa_alertas` — um registro por alerta disparado (regra, severidade, equipamento,
  operador, valor, limite, texto, frase falada, fonte `app`/`stream`, `quando`, `inicio`);
- `public.pwa_alertas_diario` — contagem por dia e regra, para painel;
- `public.pwa_alertas_top_equipamento` — ranking dos equipamentos que mais alarmam;
- `public.pwa_acessos` — quem abriu, quando, com que resultado. **Nunca guarda senha nem token**;
- `public.pwa_config` — `clientOwner`, `cdCliente`, telas, etc.
- retenção: há um `cron` comentado no fim do `schema.sql` para apagar o que é mais velho que 90 dias.

Não precisa descomentar bloco nenhum: a função já grava em `pwa_alertas` quando o navegador chama
`POST /.netlify/functions/session?acao=alerta` (em lote, um INSERT por rajada), e registra o login
em `pwa_acessos`. Se `SUPABASE_URL`/`SUPABASE_KEY` não existirem, ela simplesmente não grava — o
alerta na tela e a voz continuam funcionando.

Com a migration *append-only*, a `SUPABASE_KEY` pode ser a chave **anon**: ela só consegue inserir
nessas duas tabelas. Veja `docs/VARIAVEIS-NETLIFY.md`.

## 8. Se aparecer tela de erro

| Mensagem | Causa | Correção |
|---|---|---|
| `faltam as variáveis SOLINF_USER e SOLINF_PASS no Netlify` (501) | variáveis não cadastradas **ou** cadastradas sem reimplante | faça o item 3 e o **Redeploy** do item 4 — ou use o **modo local** (seção 3) |
| `401 em /auth-sgpa/create` | usuário ou senha errados | ajuste `SOLINF_USER`/`SOLINF_PASS` e reimplante |
| `400 em /auth-sgpa/create` | `CLIENT_OWNER` errado (o header `request-origin` é obrigatório) | confira o valor |
| `usuário ou senha não aceitos pelo portal` (modo local) | senha digitada errada ou senha foi trocada | digite de novo; se trocou a senha, não precisa reimplante nada |
| `502` com `detalhe` vazio | Mudaram as URLs de API | compare com `.env.example` / peça novo mapeamento |
| Mapa abre cinza/sem dados | token expirou (7 dias) sem reabrir o app | ⟳ Recarregar, ou ⚙ → *Nova sessão* |
| Mapa em branco e app sumiu | micro-frontend do mapa mudou de contrato | me mande a URL que eu re-engenho o handshake |
| `Failed to read the 'localStorage' property from 'Window': Access is denied` no console | é do **micro-frontend do mapa** (`solinftec-frontends…`), que roda em iframe de terceiros e tem o storage bloqueado pelo navegador | **ignorar.** Medido com o iframe bloqueado de propósito: o erro some, e o nosso shell continua com `localStorage = object`. Não afeta alerta, voz nem histórico (que usam o storage da *nossa* origem) |

### Já publicou e apareceu "faltam SOLINF_USER / SOLINF_PASS"?

Significa que o Netlify **não viu** as variáveis — não é bug do mapa nem da senha. Na ordem:

1. Netlify → **Site configuration** → **Environment variables** (ou *Environment secrets*) →
   **Add a variable**: `SOLINF_USER` = `SEU-USUARIO-DO-PORTAL`, `SOLINF_PASS` = sua senha. Sem aspas,
   sem espaço antes/depois, nomes em maiúsculo exatamente assim.
2. Se aparecer escolha de contexto, marque **Production** (e Preview também, se houver).
3. **Deploys → ⋯ → Redeploy → Deploy latest production build** (ou *Clear cache and rebuild*).
   Sem esse passo a função continua rodando com o ambiente antigo.
4. Teste `https://<seu-site>.netlify.app/.netlify/functions/session`: tem que vir JSON com
   `"props"`. Depois é só abrir o app.
5. Atalho pela linha de comando, se você usa o CLI:
   `netlify env:set SOLINF_USER SEU-USUARIO-DO-PORTAL && netlify env:set SOLINF_PASS 'SUA_SENHA' && netlify deploy --build --prod`
6. Quer sem tocar no Netlify? Reimplante este pacote atualizado e use o **modo local**: o app
   abre uma tela de login, você digita uma vez, e ele entra direto em qualquer abertura.

## 9. Testes que foram feitos antes de entregar

- Login programático real: `200` + JWT de 327 caracteres; `/auth-sgpa/check` → `true`.
- Token usado em API de dados: `mapv4/service-7/v1/extent/unidade/204/1` → `200` com bbox real;
  `slf03/user-preferences` → `200` com 183 KB de preferências do usuário.
- CORS das APIs: `Access-Control-Allow-Origin: *` e preflight liberando
  `x-auth-token`/`request-origin` → dados carregam de `*.netlify.app`.
- `frame-ancestors 'self'` no portal (iframe do portal impossível) e ausente no micro-frontend do
  mapa (iframe do mapa permitido) — medidos por cabeçalho real.
- Execução real do app completo no emulador (`tools/serve.mjs`) servido por HTTPS em domínio
  externo: mapa com 192 equipamentos, painel de camadas e filtros funcionando.
- PWA tido como instalável pelo Chrome (manifest válido + service worker + `beforeinstallprompt`).
- **Modo local testado de ponta a ponta em navegador real, sem nenhuma variável no servidor**: a
  tela de login apareceu sozinha, `auth-sgpa/create` → `200`, `user/byUsername` → `200`
  (`cdGrupo` 4060), `unidade` → `200`, mapa renderizando com talhões e equipamentos reais, e a
  reabertura entrou direto (credencial + sessão em cache). Vê-se em
  `docs/evidencia-modo-local-login.png` e `docs/evidencia-modo-local-mapa.png`.
- **Não testado:** Netlify Identity/IP allowlist reais (dependem do plano), deep-login do portal por
  token na URL (testado e **não** funciona: a tela fica em "CARREGANDO…"), iOS Safari (sem aparelho).
- **Validado no site publicado** (`https://sgpa-solinftec-bpa.netlify.app/`, shell `v13` na coleta,
  navegador real, telemetria ao vivo do tenant): motor ligado, 168 equipamentos vigiados, 65 ativos, stream
  `subscribe-live` ao vivo sem *polling*, 9 alertas no 1º ciclo (RPM máxima, motor ocioso,
  velocidade) com pop-up e frase de voz no formato pedido, 67 eventos no histórico do aparelho,
  23 frentes listadas, **nenhuma requisição com erro** e nenhum 429. A gravação no banco foi
  conferida de ponta a ponta: `POST ?acao=alerta` → `{"gravados":1}` → linha em `pwa_alertas`.
  Rode de novo com `BASE_URL=https://sgpa-solinftec-bpa.netlify.app/ python3 tools/teste-alertas.py`
  e descubra a origem de erros de console com `python3 tools/probe-erro.py`.
  O único `pageerror` reproduzido vem do iframe do fornecedor (seção 8); a `v14`, republicada
  logo depois, só endurece o acesso ao `localStorage` do nosso shell.
  O único `pageerror` visto é do iframe do fornecedor (ver seção 8). A `v14`, republicada depois da
  coleta, só endurece o acesso ao `localStorage` do nosso shell.

## 10. Rodar localmente

```bash
cd monitoramento-pwa
SOLINF_USER=... SOLINF_PASS=... node tools/serve.mjs   # http://localhost:8079
```
O emulador serve `public/` e roteia `/.netlify/functions/session` para a função real.

## 11. Conteúdo do pacote

```
netlify.toml                              publish=public, functions, headers
netlify/functions/session.mjs             login + props + cache + rate limit
public/index.html                         shell do app (barra, iframe, overlays, menu)
public/app.js                             busca sessão, entrega props, rotas de tela, instalação
public/local.js                           modo local: login pelo navegador, sem servidor
public/alerts.js                          CENTRAL DE ALERTAS: regras, pop-up, voz, histórico, CSV
public/alerts-stream.js                   Web Worker do stream ao vivo (subscribe-live NDJSON)
public/alerts.css                         visual da central, toasts e tela de regras
public/styles.css                         visual
public/icons/logo.png                     brasão branco-peres (512, com fundo)
public/icons/logo-mark.png                brasão recortado, fundo transparente (usado na UI)
public/icons/favicon-16.png  -32  -48      abas do navegador
public/icons/icon-192.png  icon-512.png    ícone do launcher (transparente, "any")
public/icons/maskable-192.png              ícone adaptável Android, 192
public/icons/maskable-512.png              ícone adaptável Android (fundo claro, zona segura)
public/icons/apple-touch-icon-180.png      iOS
docs/alerta-*.png                         evidências da central de alertas (popup, central, regras)
docs/evidencia-modo-local-login.png       tela de login do modo local
docs/evidencia-modo-local-mapa.png        mapa carregando pelo modo local (dados reais)
docs/evidencia-marca-boot.png             carregando com o brasão
docs/evidencia-marca-mapa.png             mapa com a barra já marcada
docs/evidencia-marca-celular.png          app em 390x844 (celular) com a marca
docs/evidencia-marca-desktop.png          app em 1366x768 (desktop/TV) com a marca
docs/evidencia-marca-login.png            cartão de login do modo local com o brasão
public/manifest.webmanifest               nome, ícones, start_url com ?tela=
public/sw.js                             cache só do casco; sessão nunca é cacheada
supabase/schema.sql                       auditoria de acessos + config + pwa_alertas (opcional)
tools/serve.mjs                           emula o Netlify localmente
tools/make-icons.py                       regenera todos os ícones a partir do logo.png
tools/pack.sh                             gera o zip de envio ao Netlify e chama a auditoria
tools/audit.py                            confere o zip: senha literal, referências, ícones, shell
tools/marca-sheet.py                      monta a chapa de prova visual da marca
tools/teste-alertas.py                    teste ao vivo da central (chromium/Playwright, desktop e celular)
.env.example                              todas as variáveis, com os valores deste tenant
.gitignore                                não commitar .env / node_modules
```

## 12. Empacotar e auditar antes de enviar

```bash
cd monitoramento-pwa
./tools/pack.sh                       # escreve ../MonitoramentoBP-PWA-Netlify.zip e audita
AUDIT_[REDADATADO]' ./tools/audit.py ../MonitoramentoBP-PWA-Netlify.zip
```

A auditoria verifica quatro coisas e imprime uma linha por item:
- **senha literal ausente** — nenhum arquivo do pacote pode conter a senha (ela só vive em
  `SOLINF_USER`/`SOLINF_PASS` no Netlify, ou no armazenamento do aparelho quando você digita
  no modo local). O `audit.py` recebe a senha por variável de ambiente justamente para não
  precisar copiá-la para dentro do código;
- **referências quebradas: nenhuma** — todo `href`/`src`/`url()`/`icons[].src` apontando para
  `/...` existe no pacote;
- **shell: `bperes-shell-vN`** — confirme que o número subiu em relação à versão publicada,
  senão o Service Worker antigo continua servindo a marca velha;
- **manifest** — nome curto e os 4 ícones (`any` 192/512 + `maskable` 192/512).

O `pack.sh` já chama a auditoria no final; ele também descarta `node_modules`, `.netlify`,
`out/`, `*.jks` e `*.bak`, para o keystore do APK nunca acabar dentro do pacote web.

---

## 13. Central de alertas SGPA (versão 1.2.0)

O sino abre a central com todos os alarmes oficiais recebidos do SGPA, independentemente de haver aviso habilitado para o tipo. Nas configurações, chaves por categoria e por código de tipo permitem escolher quais devem gerar pop-up, som, fala, vibração e notificação do sistema. As chaves são persistidas automaticamente neste aparelho; desligá-las não apaga os eventos da central nem do histórico.

**Velocidade é exclusivamente oficial.** A telemetria não gera mais alarme local de velocidade, nem existe limiar genérico de 51 km/h na interface. O aplicativo avisa quando o SGPA emitir o alarme e a seleção permitir. RPM, troca de turno e motor ocioso mantêm cálculo complementar opcional com os parâmetros anteriores. Os tipos combinados 2697/2699 são apresentados como condição do motor, não como velocidade pura.

Tratores/transbordos na operação exata **Aguardando Caminhão** geram um alerta na mesma lista, incluindo equipamento e frente/grupo. O matcher aceita acentos, caixa, prefixo numérico e sufixos HD/HR, sem equivaler outras operações. Duas leituras negativas encerram o episódio. Esse rastreio continua ativo com o cálculo complementar desligado.

A auditoria confirmou 2.972 tipos gerais, 38 regras e 39 expressões; 13 expressões têm condição de velocidade. O catálogo geral não significa que todos esses tipos estejam configurados para a unidade. A busca de tipos e o inventário das 39 expressões estão nas configurações. Veja [auditoria e comportamento detalhado](docs/ATUALIZACAO-ALERTAS-SGPA.md), `public/sgpa-alert-catalog.json` e `docs/AUDITORIA-ALERTAS-SGPA.json`. Os arquivos são sanitizados, sem equipamentos individuais, operadores ou tokens.

### Fontes e fala

O Web Worker recebe mudanças do stream `subscribe-live`. A consulta oficial `/alarmeOnline?ativo=true` e a telemetria `/estatistica/monitoramento` ocorrem a cada 45 segundos por padrão, de forma independente: falha de uma não impede a outra. `/alarmeTempoEquipamento` complementa a duração. A deduplicação oficial usa equipamento + tipo, unindo stream e REST da mesma ocorrência sem suprimir tipos diferentes.

O identificador é falado algarismo por algarismo, mas velocidade, RPM e minutos continuam valores normais:

> Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.

Sem medição oficial válida, informa o alarme sem inventar km/h. O navegador usa voz disponível em português; o APK usa a ponte AndroidTTS existente. Notificações móveis do PWA usam `serviceWorker.showNotification` quando há permissão. Não há Web Push/coleta autônoma: navegador/aplicativo deve estar em execução e o sistema pode suspendê-lo em segundo plano.

### Histórico e validação

Eventos reais continuam usando a auditoria `pwa_alertas` do Supabase e o histórico local exportável em CSV. Exemplos de teste não são enviados ao banco nem alteram a frota consolidada. Nenhuma regra/justificativa do SGPA ou esquema do banco foi alterado.

`node tools/test-alerts-policy.cjs` e `python3 tools/test-alerts-integrated.py` validam o comportamento com fixtures isoladas, rede de produção bloqueada e zero escrita de produção. O teste integrado cobre 26 grupos, inclusive seleção, fala, deduplicação, desligamento do stream, espera, persistência e layout móvel. O retrato de produção auditado não tinha equipamento em Aguardando Caminhão nem alarme oficial de velocidade ativo; portanto não se afirma validação ao vivo desses disparos. O teste antigo `tools/teste-alertas.py` documenta a fase anterior e não é evidência da política nova.

O APK 1.2 existente aponta para o PWA e aproveita a atualização web, sem novo APK nesta etapa. O casco de cache passa a `bperes-shell-v15`.

---

## 14. Estrutura do repositório

```
public/                     PWA (casca do app + central de alertas)
  index.html · app.js       barra, iframe do mapa, sessão automática
  alerts.js                 motor, central e seleção de alarmes oficiais
  alerts-policy.js          política pura de seleção, fala e espera por caminhão
  sgpa-alert-catalog.json    catálogo e inventário sanitizado das regras SGPA
  alerts-stream.js          Web Worker do stream NDJSON subscribe-live
  alerts.css · local.js     visual da central · modo local (login no navegador)
netlify/functions/          session.mjs — login, props, proxy de dados, auditoria em lote
supabase/schema.sql         pwa_acessos · pwa_config · pwa_alertas (+ visões de relatório)
android/                    fonte do APK (MainActivity com a ponte AndroidTTS), sem keystore
tools/                      emulador local, empacotador, auditoria, sanitização, testes
docs/                       dossiês técnicos (rotas medidas, protocolo do mapa, regras)
repo-publico/               LICENSE, SECURITY.md e os blocos usados pelo prepara-repo-publico.sh
```

## 15. Como continuar o projeto

```bash
cp .env.example .env                     # nunca faça commit do .env
node tools/serve.mjs 8080                # emula o Netlify local (lê .env ou ~/.solinf_creds)
MODELO=celular python3 tools/teste-alertas.py   # teste ao vivo da central de alertas
./tools/pack.sh                          # zip para arrastar no Netlify + auditoria
./tools/prepara-repo-publico.sh          # staging sanitizado pronto para push
cd android && KS_PASS=... ./build.sh release   # APK (keystore fica fora do git)
```

Mapa de evolução — o que já está pronto está marcado:

- [x] login automático serverless + `props` do mapa (sessão de 7 dias, cache e refresh)
- [x] stream ao vivo em Web Worker (`subscribe-live`) sem polling
- [x] regras de velocidade / RPM / troca de turno / motor ocioso com histerese e cooldown
- [x] pop-up, som, voz (navegador e `AndroidTTS`), vibração, notificação, CSV, trilha no Supabase
- [x] proxy `?acao=dados` com whitelist, para redes corporativas que travam CORS
- [ ] limiar de RPM **por tipo de máquina** lido de `regra-expressao` (hoje: espelho oficial)
- [ ] reconhecimento de voz para comandos ("parar", "repete 8833") dentro do APK
- [ ] limiares por horário (canavieiro de dia × pátio à noite)
- [ ] saída do alerta crítico (WhatsApp/Teams/e-mail) para o encarregado de turno
- [ ] teste offline com replay de gravação do stream, para rodar em CI sem tocar no portal

## 16. Privacidade, LGPD e contrato

- **Nenhum segredo vai ao git**: a senha do portal vive em `SOLINF_PASS` (Netlify Environment
  Variable), o keystore do Android fica fora do repositório, `.env` é ignorado. O `tools/audit.py`
  e o `tools/sanitizar.py` conferem isso antes de qualquer publicação.
- O app trata dado de **pessoas identificadas** (nome do operador de cada máquina). Para a LGPD
  isso é dado pessoal: use com finalidade operacional, defina retenção (o `schema.sql` traz um
  cron de 180 dias como exemplo) e comunique os operadores, conforme a política da empresa.
- Evidências com dado real (prints, dumps de API, relatórios de teste) ficam fora do repositório.
- A integração usa **a sua conta** no portal do fornecedor, com login automático. Antes de escalar
  para vários usuários, confirme no contrato com a Solinftec se integrações não oficiais são
  permitidas — e prefira solicitar uma API/chave própria. Nada aqui burla captcha, MFA ou
  controle de acesso, e nada escreve no sistema do fornecedor: a central **lê** e alerta.
- Respeite o limite medido no servidor (10 req/min/IP). O ciclo padrão é de 45 s com rodízio de
  rotas; não reduza para valores agressivos.

## 17. Licença e contato

Direitos reservados (ver `LICENSE`). Este repositório existe para dar continuidade ao projeto
interno: usar, modificar e distribuir para fora exige autorização do titular. Problemas de
segurança: veja `SECURITY.md` — não abra issue com credencial, token ou dado real de frota.
