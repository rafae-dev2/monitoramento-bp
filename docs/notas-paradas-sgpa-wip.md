# WIP análise paradas improdutivas (23/11/2026)
- Portal: https://branco-peres-cana.saas-solinftec.com/ (sessão já logada no browser)
- Relatório PBI CCT: #!/details/PBIHarvesterTruckTransshipmentReport — filtros: Regional, Unidade, Grupo equip., Tipo equip., Equipamento(302), Grupo de operação, Operação, Período. Dados até 22/11.
- Outros: Tempo Médio #!/details/PBIAverageTimeReport; Eficiência #!/details/PBIEfficiencyCOAReport; Variáveis Operacionais #!/details/PBIoperationalVariablesReportCOA; Diário Geral #!/details/PBIgeneralDailyCaneReport
- Códigos vistos no filtro: 983 AG COLHEDORA PARADA RAPIDA, 710 Aguard Equip em Operacao, 911 Parada Industrial - DH, 909 Parado até 2ª ordem - HR, 953 Sem Apontamento; grupo 50-IMPRODUTIVA.
- Período escolhido: 23/10/2026 ~ 22/11/2026.
Caminhões (CCT, 23/10-22/11, tabela todas operações, total 18600 h): AGUARDANDO CARREG(AMENTO) - HD 2610.7h 14.0% med 03:22; TRANSPORTE DE CANA 1713.1 9.2%; AG. SEQUENC. DE TRABALHO 1693.9 9.1% (02:11); AGUARD LIBERAR TRAFEGO 1555.1 8.4% (02:00); TRANSPORTE DE CANA(2) 1427.7 7.7%; MANUT. OFICINA TERCEIRO 1259.3 6.8%; CHUVA-HR 1224.6 6.6%; CARREGANDO CANA 1162.0 6.2%.
Top5 improdutivas caminhão: Aguardando carregamento HD 17.5%, Ag. sequenc. trabalho 12.2%, Aguard liberar tráfego 11.2%, Troca de turno 0.5%, Computador de bordo desligado 0.2%.
Grupos (geral): IMPRODUTIVA 2023.4 (41.5%), PRODUTIVA 1059.2, MANUTENCAO 571.1, INATIVO 480, AUXILIAR 434.3, CLIMA 166.3, INDETERMINADO 102.8, INDUSTRIAL 35.0.
Transbordo: ~/paradas/transbordo.xlsx ; Colhedora: ~/paradas/colhedora.xlsx
