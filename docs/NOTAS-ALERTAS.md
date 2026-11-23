# Motor de alertas — achados de engenharia reversa (2026-11-23)

Tenant BRANCO PERES (cdCliente=204, cdUnidadeRegional=1, cdGrupo/usuário=4060, userGroupId 4060,
stage P, timezone America/Sao_Paulo). Token: `X-Auth-Token` obtido em
`POST https://auth-api.saas-solinftec.com/auth-api-03/v2/auth-sgpa/create` (body
`{language:'pt-br', login, password, owner:'branco_peres_cana', time:604800,
environment:'BROWSER'}`; resposta = JSON `{token}`). Base dos dados:
`https://sgpa-api-br.saas-solinftec.com/slf03` (é o `urlSgpa`/`apiRootUrlWeb` do portal).
Quase toda rota exige `?buId=<unidade>&language=pt-br` (o `httpService` do portal anexa sozinho;
sem isso dá 400/500). Rotas do mapa enviam também o header `locale: 1`.

## 1. Alarmes ativos (fonte primária — o servidor já calcula)

`GET {base}/alarmeOnline?idioma=1&ativo=true&buId=1&language=pt-br` → 200, array curto (só os
**online/agora**). Sem `ativo=true` vem o histórico completo (989 KB, ~13 mil itens) — nunca usar
sem filtro. Item:

```
{"cdId":4674575,"dtHrLocal":[2026,11,23,6,39,52],"cdEquipamento":"74073",
 "descEquipamento":"PV JACTO UNIPORT 3030","fgTpEquipamento":40,
 "cdTpAlarme":4,"descTpAlarme":"RPM MAXIMA MOTOR","fgOnline":true,
 "vlAlarme":"1600","cdOperacao":986,"descOperacao":"Equipamento em Manutencao",
 "cdOperador":31003902,"nomeOperador":"OPERADOR-07",
 "vlAlarmeMaximoAtingido":"1600","dtHrUTC":1795426792.0,
 "countAlarmeOnlineValores":0,"countHistoricoMensagem":0, ...}
```

- `vlAlarme` = valor medido (RPM 1600; em alarmes de tempo vem a duração).
- `nomeOperador` já vem pronto → serve para a fala.
- `dtHrLocal` = array `[ano,mes(1..12),dia,hora,min,seg]` do tenant (America/Sao_Paulo).
- `POST {base}/alarmeOnline/ocorrencias` com `{}` → 200, contagem por tipo no período
  (ex.: RPM MAXIMA MOTOR 1205, VELOCIDADE 19, DIGITAR_OP_VL 15, Controle_Vel_Canavieiro 1).
- `POST {base}/alarmeOnline/filtrados?page=0&size=N` com `{}` → 200, página Spring (`content[]`).
- `GET {base}/alarmeOnline/valores/{cdTpAlarme}` → série de valores; `GET .../alarmeOnline/justificativas`.
- `GET {base}/alarmeOnline/por-equipamento/{id}` → **404** (não existe neste stage/host).

## 2. Tipos de alarme que interessam (catálogo `/tipo-alarme`, 2972 itens)

`cdTpAlarme` | `descTpAlarme` | classe | especial
---|---|---|---
4  | RPM MAXIMA MOTOR | 2 | 3
6  | RPM MOTOR EM PARADA | 2 | 5
8  | RPM MOTOR EM MANOBRA | 2 | 6
11 | MOTOR OCIOSO | 2 | 19
2343 | MOTOR OCIOSO (var. canavieiro) | 2 | 9
2207 | MODO OCIOSO | 2 | 95
5  | VELOCIDADE | 2 | 4
2203 | VELOCIDADE EXCEDIDA | 2 | 91
2685 | Velocidade máxima | 2 | 182
2697/2699 | Motor ligado (velocidade alta e rpm baixa) | 2 | 188/189
1641 | VELOCIDADE EM DESLOCAMENTO | 2 | 27
2849 | Tempo Excedido Troca de Turno - HR | 3 | 925
2851 | Alerta Troca de Turno - HR | 4 | 925
10820 | Controle_Vel_Canavieiro | — | —
12480 | Desvio de Rota | 1 | 510

Grupos: `/grupo-alarme` (1=Alarmes Operacionais, 3=Tempo operação, 4=Alerta de Operação,
9=Alarme de Telemetria, 10=Parametro Rede Can). Níveis: `/nivel-alarme` (1 Crítico #f2170a,
2 Normal #11a60d, 23 Aviso, 81 Alarme, 82 Alerta, 83 Erro).
`/alarmeTipoEquipamento` (1094 linhas) liga tipo de alarme × tipo de equipamento: RPM MAXIMA
MOTOR em 14 tipos, MOTOR OCIOSO em 12 (+2343 em 7), etc.

## 3. Regras já cadastradas no tenant (`/regra` 38 itens, `/regra-expressao` 39 itens)

As regras usam SQL sobre a view `GEO_LAYER_MONITORAMENTO` ("Monitoramento Online"):

- `VELOCIDADE_EXCEDIDA_50_VL` → `VL_VELOCIDADE >= 51`
- `ALARME_CANAV_VEL_USINA_23` → `VL_VELOCIDADE >= 23`
- `EQUIP INATIVO TRABALHANDO` → `DESC_GRUPO_EQUIPAMENTO = 'Equipamento Inativo' AND VL_VELOCIDADE >= 5`
- `ABAST_INS_DESLIGAR_MOTOR_TPL` → `VL_ED_1 = '1' AND TO_NUMBER(REPLACE(VL_PARAMETRO_4,',','.')) >= 750 AND (DESC_OPERACAO = '933 ...' OR '981 ...') AND VL_TEMPO_SEC >= 60`
- **`OPERADOR NÃO DEFINIDO - TROCA DE TURNO`** → `DESC_OPERADOR = '9999 - OPERADOR GENÉRICO' AND DESC_OPERACAO = '925 - Troca de Turno - HR' AND VL_TEMPO_SEC >= 180` (é exatamente o caso "operador esqueceu na troca de turno"; no portal o corte é 180 s, o usuário quer 240 s)

Campos da view ⇒ **`VL_PARAMETRO_4` = RPM do motor** (comparado a 750), `VL_ED_1` = motor ligado,
`VL_VELOCIDADE` = velocidade, `VL_TEMPO_SEC` = segundos na operação atual, `DESC_OPERADOR`,
`DESC_OPERACAO`, `DESC_ESTADO`, `DESC_GRUPO_EQUIPAMENTO`. `cdTpAlarme 2214` no feed de tempo =
"SEM CONEXAO COM TELA".

## 4. Telemetria ao vivo por equipamento (fonte para calcular no cliente)

`GET {base}/estatistica/monitoramento?buId=1&language=pt-br` → 200, **271 linhas**, uma por
equipamento, campos:

`cdEquipamento, descEquipamento ("4462 - Caminhão Transp Edson José"), cdTpEquipamento,
descTpEquipamento, descFullTpEquipamento, fgTpEquipamento, cdImplemento, descGrupoEquipamento
("Frente 3", "Caminhões Canavieiro Terc"), cdOperacao/descOperacao ("925 - Troca de Turno - HR"),
descGrupoOperacao (PRODUTIVA/AUXILIAR/IMPRODUTIVA), descEstado (TRABALHANDO/DESLOCAMENTO/PARADA),
descFuncionario ("18251 - OPERADOR-87") = operador, cdFazenda, cdZona, cdTalhao,
descRegional, descUnidade, descCorporativo, dtHrLocal (array), dtHrFim, horas,
vlVelocidade (número, ex. 5.7), vlParametro2/4/7/8/9, vlEd1/2/3, vlHorimetroOdometro,
vlTempoSemComunicacao ("0 DIA(S)  00: 00: 08"), fgTpComunicacao (G/Z), fgMonitoramentoAtivo (T)`

Amostra: 270/271 com `descEstado`; 185 com `vlParametro7`; 69 com `vlParametro4`; 46 com
`vlVelocidade` ≠ 0.

Outras rotas úteis medidas:
- `GET /canbusOnline?equipamentos=<csv>` → 200, sinais CAN por equipamento
  (`vlBcParametro2..27`, `cdEstado`, `dtHrLocal` em epoch ms). `GET /canbusOnline/equipamento/{id}`
  pode voltar `[]`.
- `GET /patrimonioOnline` → 200 (152 KB), `vlPmParametro1..N`.
- `GET /alarmeTempoEquipamento` → 200, `[{"cdEquipamento":"57837","tempo":"02:34:29","cdTpAlarme":2214}]`
  (tempo acumulado do alarme ativo por equipamento).
- `GET /faixasHorarioTela` → 200, faixas de tempo→cor usadas pelo portal.
- `GET /monitoramento/equipamento` → **400** em todas as combinações tentadas
  (`buId`, `cdUnidadeRegional`, `equipamentos=csv`, `grupo`, `cdGrupo`). Ainda não resolvido;
  não é bloqueante — `/estatistica/monitoramento` cobre.
- `GET /operacao/parametros` → **400** (idem; `?cdOperacao=111`, `?cdTpEquipamento=3`).
- `GET /horarios-turno/turnos` → 200 porém `content: []` (este tenant não cadastrou turnos por
  frente); `/horarios-turno/horas` → 200 com 24 horas.
- `GET /tipoEquipamento/params` → 200 (22 KB) com flags por tipo de equipamento (sem nomes de
  parâmetro; RPM/ED ficam nas regras SQL da view).
- `POST https://api-usa.saas-solinftec.com/framestream/v3/aggregate/stream` → **503** daqui
  (host de produção do stream de posição; o mapa usa para `fleet/equipment_id/lat/lon/heading`
  com header `x-auth-token`). `.../mapv4/service-7/health` → 200 OK.

## 5. Decisão de arquitetura do motor de alertas

Duas camadas, porque o usuário relata que o alerta do portal "às vezes falha":

1. **EspeLHO DO SERVIDOR** — `GET /alarmeOnline?idioma=1&ativo=true` a cada ciclo: pega os
   alarmes que o próprio portal já disparou (RPM 4, VELOCIDADE 5/2203/2685/10820, MOTOR OCIOSO
   11/2343/2207, TROCA DE TURNO 2849/2851) com `vlAlarme`, `nomeOperador`, `dtHrLocal`.
2. **CALCULO LOCAL** — `GET /estatistica/monitoramento` a cada ciclo, aplicado às regras nossas
   (limiares configuráveis, default das regras do tenant: velocidade ≥ 51 km/h geral / ≥ 23 para
   canavieiro na usina, RPM ≥ limite configurável, motor ocioso = `vlEd1==1` + velocidade 0 +
   RPM em faixa ociosa por `minutos`, troca de turno = `descOperacao` começando com
   `925 - Troca de Turno` + `descFuncionario` genérico/`descEstado PARADA` por **> 4 min**,
   medido por nós com carimbo próprio).

Deduplicação por chave `equipamento|tipo` com cooldown configurável (default 5 min) e janela de
primeira-ocorrência; áudio via Web Speech API (fila, voz pt-BR, sem falar duas ao mesmo tempo),
popup premium com brasão, severidade, valor medido, operador, fazenda/talhão, "ver no mapa"
(deeplink `#!/details/analytic-map-v4?equipment=<cdEquipamento>` é o que o portal usa ao clicar
duas vezes na linha), histórico em localStorage + tabela opcional no Supabase.

## 6. Pendências de medição

- CORS do navegador em `sgpa-api-br` com header `x-auth-token` (preflight `allow-headers`).
- Como o micro-frontend do mapa recebe "selecione/centralize este equipamento" (postMessage ou
  só via hash do portal).
- Parâmetros de `/monitoramento/equipamento` e `/operacao/parametros` (fallback: usar
  `/estatistica/monitoramento`).
