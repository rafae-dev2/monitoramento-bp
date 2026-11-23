---

## 14. Estrutura do repositório

```
public/                     PWA (casca do app + central de alertas)
  index.html · app.js       barra, iframe do mapa, sessão automática
  alerts.js                 motor de regras (velocidade, RPM, troca de turno, motor ocioso)
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
