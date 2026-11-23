# Ranking de paradas improdutivas no SGPA (Branco Peres)

**Fonte:** relatório Power BI "Corte, Carregamento e Transporte (CCT)" do SGPA (`#!/details/PBIHarvesterTruckTransshipmentReport`), unidade BRANCO PERES, todos os 302 equipamentos, período de **23/10/2026 a 22/11/2026**. As tabelas de colhedora e transbordo foram exportadas do próprio Power BI (somente leitura); a dos caminhões foi lida na tela.

No período, o grupo **IMPRODUTIVA soma 41,5% do tempo** registrado (2.023 h no agregado do gráfico), contra 21,7% de PRODUTIVA. Manutenção fica com 11,7%, Inativo com 9,9%, Auxiliar com 8,9% e Clima com 3,4%.

## 1. Transbordos (total de 19.344 h apontadas)

| # | Operação | Horas | % do tempo | Horas com motor ligado |
|---|---|---:|---:|---:|
| 1 | FILA ÚNICA | 2.712,4 | 14,0% | 370,2 |
| 2 | 983 – AG COLHEDORA PARADA RÁPIDA | 1.125,6 | 5,8% | **519,0** |
| 3 | REFEIÇÃO E/OU CAFÉ | 414,4 | 2,1% | 5,2 |
| 4 | AGUARDANDO COLHEDORA ALOCADA | 365,4 | 1,9% | 134,3 |
| 5 | 905 – AGUARDANDO CAMINHÃO | 331,0 | 1,7% | 24,0 |
| 6 | TRANSBORDO ALOCADO | 295,3 | 1,5% | 113,3 |
| 7 | AGUARD. REBOQUE CAMINHÃO | 279,6 | 1,4% | 26,9 |
| 8 | 911 – PARADA INDUSTRIAL – DH | 133,0 | 0,7% | 3,0 |
| 9 | EQUIPAMENTO ENCALHADO | 129,2 | 0,7% | 45,8 |
| 10 | AGUARD BASCUL TRANSBORDO | 102,3 | 0,5% | 35,8 |
| 11 | 953 – SEM APONTAMENTO | 77,2 | 0,4% | **63,2** |
| 12 | FALTA OPERADOR | 49,5 | 0,3% | 0,4 |

Para comparar: Chuva teve 4.102 h, Reboque 3.076 h e Deslocamentos 4.046 h. Equipamento em manutenção ficou com 660 h.

## 2. Colhedoras (total de 8.184 h apontadas)

| # | Operação | Horas | % | Horas com motor ligado |
|---|---|---:|---:|---:|
| 1 | FALTA DE TRANSBORDO | 209,0 | 2,6% | 75,2 |
| 2 | TROCA DE TURNO | 90,6 | 1,1% | **81,3** |
| 3 | AG. SEQUENC. DE TRABALHO | 73,9 | 0,9% | 0,8 |
| 4 | AGUARDANDO MANOBRA DE TRANSBORDO | 69,7 | 0,9% | **67,8** |
| 5 | 953 – SEM APONTAMENTO | 54,9 | 0,7% | 45,2 |
| 6 | 911 – PARADA INDUSTRIAL – DH | 40,5 | 0,5% | 1,4 |
| 7 | REFEIÇÃO E/OU CAFÉ | 31,4 | 0,4% | 2,5 |
| 8 | EQUIPAMENTO ENCALHADO | 24,8 | 0,3% | 11,2 |
| 9 | INDETERMINADO | 100,9 | 1,2% | 0 |

Para comparar: a colheita teve 3.331 h (40,7%), Chuva 1.624 h, Manobra 1.166 h e Manutenção 665 h. Cada colhedora colheu em média 9,8 h por dia, com 1,5 h parada de motor ligado.

## 3. Caminhões (total de 18.600 h)

| # | Operação | Horas | % |
|---|---|---:|---:|
| 1 | AGUARDANDO CARREGAMENTO – HD | 2.610,7 | 14,0% |
| 2 | AG. SEQUENC. DE TRABALHO | 1.693,9 | 9,1% |
| 3 | AGUARD LIBERAR TRÁFEGO | 1.555,1 | 8,4% |
| 4 | MANUT. OFICINA TERCEIRO | 1.259,3 | 6,8% |
| 5 | TROCA DE TURNO / COMPUTADOR DE BORDO DESLIGADO | — | 0,5% / 0,2% do improdutivo |

## 4. Os maiores ofensores do CCT

1. **Fila / aguardando carregamento**, com cerca de 5.300 h somando a Fila Única do transbordo e o Aguardando Carregamento do caminhão. É sinal de excesso de caminhões e transbordos para a capacidade de corte, ou de colhedoras paradas.
2. **983 – AG Colhedora Parada Rápida**, com 1.126 h no transbordo, das quais 519 h com motor ligado. É o maior desperdício de diesel entre as paradas.
3. **AG. Sequenc. de Trabalho e Aguard. Liberar Tráfego** nos caminhões, cerca de 3.250 h. São problemas de logística e de despacho.
4. **Falta de transbordo e Aguardando manobra de transbordo** na colhedora, 279 h. Toda hora parada da colhedora trava a frente inteira.
5. **905 – Aguardando caminhão**, 331 h, e **Aguard. reboque caminhão**, 280 h.
6. **953 – Sem apontamento**, 132 h somando transbordo e colhedora, com cerca de 108 h de motor ligado.
7. **Refeição**, 446 h somando transbordo e colhedora.
8. **911 – Parada industrial**, 174 h.

## 5. O que sugiro levar para o app

| Código / operação | Situação no app | Sugestão de alerta |
|---|---|---|
| 905 Aguardando caminhão | já alerta na hora (v1.2.9) | manter |
| 953 Sem apontamento | já alerta com 5 min (v1.2.x) | manter |
| Refeição | já tem controle por grupo (v1.2.8) | manter |
| **983 AG Colhedora Parada Rápida** | não alerta | alertar quando passar de 10 min ou quando o motor estiver ligado |
| **Falta de transbordo (colhedora)** | não alerta | alertar na hora, informando a frente |
| **Aguardando manobra de transbordo** | não alerta | alertar quando passar de 5 min |
| **Fila única / Aguardando carregamento** | não alerta | alertar quando passar de 20–30 min ou quando houver mais de N caminhões na fila por frente |
| **Troca de turno com motor ligado** | não alerta | alertar quando passar de 15 min |
| **911 Parada industrial** | não alerta | aviso informativo por frente |
| Aguard. reboque caminhão / Aguard. basculamento | não alerta | alertar quando passar de 15 min |

**Observação:** o filtro "Improdutiva" do relatório não restringe a tabela exportada. Por isso separei as operações improdutivas manualmente, deixando de fora as produtivas, a manutenção e o clima. As planilhas brutas estão em `/home/ubuntu/paradas/`.
