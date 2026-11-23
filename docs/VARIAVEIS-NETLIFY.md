# Variáveis de ambiente no Netlify — `sgpa-solinftec-bpa`

Guia curto do que vai no Netlify e de onde vem cada valor. Senhas e tokens ficam no painel do
Netlify e nunca vão para o repositório. `SUPABASE_KEY` é uma variável antiga da função de sessão;
ela não é usada pelo monitor Web Push. Não presuma que seu valor seja seguro para expor nem o
substitua por `service_role` sem uma decisão específica. As variáveis dedicadas do Push estão em
[`docs/WEB-PUSH-NETLIFY-ENV.md`](WEB-PUSH-NETLIFY-ENV.md).

Onde colocar: **Netlify → Projects → `sgpa-solinftec-bpa` → Project configuration → Environment
variables → Add a variable**. Depois de salvar, **reimplante** (Deploys → ⋯ → *Deploy latest
production / Clear cache and rebuild*), porque variável criada depois do deploy não entra na função
que já está publicada.

## 1. Obrigatórias (sem elas o app cai no "modo local")

| Variável | Valor | Onde achar | Situação |
|---|---|---|---|
| `SOLINF_USER` | `SEU-USUARIO-DO-PORTAL` | o próprio login do portal | ✅ já cadastrada |
| `SOLINF_PASS` | a senha do portal (*segredo*) | com você | ✅ já cadastrada — **troque a senha**, ela circulou em conversa |
| `CLIENT_OWNER` | `branco_peres_cana` | é o pedaço da URL `https://branco-peres-cana.saas-solinftec.com` | ✅ já cadastrada |
| `CLIENT_NAME` | `branco-peres-cana` | idem | ✅ já cadastrada |

Com só essas quatro o monitoramento já abre direto no mapa, com login automático.

## 2. Historico de alertas no Supabase (recomendado)

| Variável | Valor | Onde achar |
|---|---|---|
| `SUPABASE_URL` | `https://<ref-do-projeto>.supabase.co` | Supabase → seu projeto → **Project Settings → API Keys → Project URL** |
| `SUPABASE_KEY` | variável legada opcional da função `session`; não é usada por Web Push | Mantenha o valor atualmente configurado; não o copie para o navegador nem o use para a RPC Push |

Essas duas são **opcionais**: sem elas os alertas continuam aparecendo na tela, com voz e pop-up, e
só deixa de existir o registro no banco (o "histórico" consultável depois).

O histórico legado depende da configuração e das policies existentes no Supabase. Não use uma
requisição POST de teste nesse endpoint em produção: ela grava um evento real na tabela de
auditoria. Para Web Push, a função dedicada usa `SUPABASE_ANON_KEY` com RPC protegida por
`PUSH_DB_SECRET`; não requer nem deve receber `service_role`.

## 3. Web Push (versão 1.2.6)

Configure `SUPABASE_ANON_KEY`, `PUSH_DB_SECRET`, `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` em
Production, escopo Functions. `PUSH_DB_SECRET` e `VAPID_PRIVATE_KEY` devem ser marcadas como
secrets; a chave pública VAPID e a chave `anon` são publicáveis. O segredo compartilhado também é
guardado no Vault Supabase com o nome `pwa_push_rpc_auth`. Os valores não ficam neste documento;
veja `docs/WEB-PUSH-NETLIFY-ENV.md` para o contrato completo. A permissão do navegador só é
solicitada quando o usuário tocar em “Ativar notificações Push neste aparelho”.

O monitor agendado roda a cada minuto. Com 1 GB padrão, 43.200 execuções mensais custariam cerca
de 120 créditos por segundo médio de duração (mais o tráfego web e o uso normal do site); a duração
real precisa ser medida após ativação. Enquanto não houver inscrição Push, o monitor não consulta
o SGPA. Essa aproximação não é uma cobrança confirmada.

## 4. Opcionais (só mexe se a Solinftec mudar algo)

| Variável | Valor padrão no código | Para que serve |
|---|---|---|
| `AUTH_API` | `https://auth-api.saas-solinftec.com/auth-api-03/v2` | endpoint de login |
| `SGPA_API` | `https://sgpa-api-br.saas-solinftec.com/slf03` | dados de frota/estatística/alertas do fornecedor |
| `SERVICE_API` | `https://api-br.saas-solinftec.com/mapv4/service-7` | serviços do mapa |
| `TILE_API` | `https://api-br.saas-solinftec.com/mapv4/tile-service-7` | tiles do mapa |
| `INTERP_API` | `https://api-br.saas-solinftec.com/mapv4/interpolation-service-7` | interpolação (chuva/deque) |
| `MAP_URL` | `https://solinftec-frontends.saas-solinftec.com/solinftec-pwa-mapv4-prod/index.html` | micro-frontend do mapa |
| `PORTAL_URL` | `https://branco-peres-cana.saas-solinftec.com` | portal original |
| `CD_CLIENT` | `204` | código do cliente no fornecedor |
| `PROPS_TTL_SECONDS` | `432000` (5 dias) | tempo de cache da sessão na função (o token dura 7 dias) |
| `APP_KEY` | *(vazio)* | se você preencher, a função passa a exigir essa chave nas chamadas — barreira mínima contra terceiros usando a sua URL. O valor aparece no front-end, então **não** use uma senha sua aqui |

Lista completa com comentários: `.env.example`.

## 5. Como validar que pegou

```bash
U=https://sgpa-solinftec-bpa.netlify.app
curl -s -o /dev/null -w "funcao=%{http_code}\n" "$U/.netlify/functions/session?acao=props"   # 200
curl -s -o /dev/null -w "alerts=%{http_code}\n" "$U/alerts.js"                                # 200 = central de alertas publicada
curl -s "$U/sw.js" | grep -o 'bperes-shell-v[0-9]*'                                           # versão do shell
```

- `funcao=200` com `"props":{...}` → login automático funcionando.
- `funcao=501` → `SOLINF_USER`/`SOLINF_PASS` não chegaram (falta reimplantar).
- No celular, depois de reimplantar: **⚙ → Atualizar app** (ou feche e abra de novo) para o
  service worker trocar o cache velho.

## 6. Boas práticas que valem para este projeto

1. **Troque a senha do portal** antes de fixar `SOLINF_PASS`: ela foi escrita em conversa.
2. Marque a variável como **confidential/secret** no Netlify se quiser que o valor suma da tela
   (ele não consegue mais ser lido, só regravado).
3. Não conecte este repositório público ao Netlify com as variáveis do tenant se alguém puder
   abrir PR: qualquer deploy seu vê as variáveis. Prefira manter o deploy por arquivo.
4. O APK aponta para `https://sgpa-solinftec-bpa.netlify.app/`. Se você renomear o projeto no
   Netlify, o endereço muda — aí é preciso rebuildar o APK (v1.3 em diante) ou usar um domínio
   próprio, que é o recomendado para não depender do nome gerado.
