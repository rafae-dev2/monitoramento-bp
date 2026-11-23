# Variáveis de ambiente no Netlify — `sgpa-solinftec-bpa`

Guia curto do que vai no Netlify e de onde vem cada valor. **Nada aqui é segredo**, exceto os dois
valores marcados como *segredo* (senha do portal e chave do Supabase), que ficam só no painel do
Netlify — não vão para o GitHub nem para este repositório.

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
| `SUPABASE_KEY` | a chave **`anon`** (ou `publishable` / `service_role`) (*segredo*) | Supabase → **API Keys** → `anon` `legacy` / `sb_publishable_…` |

Essas duas são **opcionais**: sem elas os alertas continuam aparecendo na tela, com voz e pop-up, e
só deixa de existir o registro no banco (o "histórico" consultável depois).

A migration `supabase/escrita-append-only.sql` (já aplicada) faz a chave `anon` conseguir **só
inserir** em `pwa_alertas` e `pwa_acessos` — sem ler, alterar ou apagar nada. Assim não é preciso
colocar a `service_role` no Netlify. Se um dia você revogar essa policy, troque `SUPABASE_KEY` pela
`service_role` (Dashboard → API Keys → *Private*): o código não muda nada.

Conferência (roda do terminal, sem expor segredo):

```bash
U=https://sgpa-solinftec-bpa.netlify.app
curl -s -X POST "$U/.netlify/functions/session?acao=alerta" \
  -H 'Content-Type: application/json' \
  -d '{"usuario":"teste","alertas":[{"chave":"confere-1","regra":"velocidade","severidade":"alto","equipamento":"TESTE-0001","texto":"prova de escrita","fonte":"app"}]}'
# esperado: {"ok":true,"recebidos":1,"gravados":1}
```

Se vier `"gravados":0`, o problema é `SUPABASE_URL`/`SUPABASE_KEY` (chave errada, ou a policy de
INSERT não está aplicada). No Supabase: **Table Editor → pwa_alertas** para ver as linhas.

## 3. Opcionais (só mexe se a Solinftec mudar algo)

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

## 4. Como validar que pegou

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

## 5. Boas práticas que valem para este projeto

1. **Troque a senha do portal** antes de fixar `SOLINF_PASS`: ela foi escrita em conversa.
2. Marque a variável como **confidential/secret** no Netlify se quiser que o valor suma da tela
   (ele não consegue mais ser lido, só regravado).
3. Não conecte este repositório público ao Netlify com as variáveis do tenant se alguém puder
   abrir PR: qualquer deploy seu vê as variáveis. Prefira manter o deploy por arquivo.
4. O APK aponta para `https://sgpa-solinftec-bpa.netlify.app/`. Se você renomear o projeto no
   Netlify, o endereço muda — aí é preciso rebuildar o APK (v1.3 em diante) ou usar um domínio
   próprio, que é o recomendado para não depender do nome gerado.
