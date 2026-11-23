# Variáveis Netlify para Web Push

O monitor usa apenas alarmes oficiais ativos do SGPA. O nome e o valor de cada segredo ficam fora do repositório. Em Netlify, configure todas as variáveis abaixo no contexto Production e com escopo Functions.

| Variável | Natureza | Uso |
| --- | --- | --- |
| `SOLINF_USER` | segredo | Usuário SGPA já usado pela função de sessão existente. |
| `SOLINF_PASS` | segredo | Senha SGPA já usada pela função de sessão existente. |
| `SUPABASE_URL` | pública | URL do projeto Supabase que contém a RPC Push. |
| `SUPABASE_ANON_KEY` | chave publicável | Chama somente a função RPC protegida; não concede acesso direto às tabelas privadas. |
| `PUSH_DB_SECRET` | segredo | Token aleatório compartilhado entre a função Netlify e a RPC; fica também no Supabase Vault com nome `pwa_push_rpc_auth`. |
| `VAPID_PUBLIC_KEY` | pública | Chave VAPID pública devolvida ao navegador para criar inscrição. |
| `VAPID_PRIVATE_KEY` | segredo | Chave privada VAPID usada exclusivamente no monitor Netlify. |
| `PUSH_SGPA_UNIT_ID` | pública/opcional | Unidade enviada à rota `alarmeOnline`; valor atual do tenant: `1`. |

`AUTH_API`, `SGPA_API`, `CLIENT_OWNER` e `CLIENT_NAME` podem usar os defaults fixados no monitor ou os valores já configurados para a função `session`. A API pública `/api/push` não recebe nem devolve credenciais SGPA. O monitor lê usuário e senha do ambiente Functions; o token temporário é usado somente durante sua invocação.

Não coloque a VAPID privada, `PUSH_DB_SECRET`, senha SGPA, token SGPA ou uma chave `service_role` em JavaScript do navegador, documentação com valores ou arquivos versionados. O botão no aplicativo pede permissão somente depois do toque do usuário. O monitor executa em intervalo de um minuto e pode atrasar até aproximadamente esse intervalo; o serviço de Push não garante entrega instantânea.

Antes de consultar o SGPA, o monitor chama a RPC privada `has_subscriptions`. Se nenhum aparelho estiver inscrito, ele encerra rapidamente sem autenticar nem solicitar alarmes ao SGPA. Uma agenda de um minuto representa cerca de 43.200 execuções em 30 dias. Na tarifa Netlify publicada de 10 créditos por GB-hora e alocação padrão de 1 GB, cada segundo médio de execução em todas essas invocações equivale a aproximadamente 120 créditos mensais de compute; 2 s ≈ 240 e 5 s ≈ 600. São cenários, não uma previsão: use o consumo medido após implantação. Com o saldo verificado em 23/11/2026 e recarga automática desligada, monitore o saldo do site; se os créditos se esgotarem, a documentação Netlify informa que projetos do time podem ser pausados.
