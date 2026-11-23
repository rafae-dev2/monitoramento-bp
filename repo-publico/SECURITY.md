# Reportando um problema

Encontrou uma falha, um segredo exposto ou um dado pessoal publicado?

1. **Não abra uma issue pública.** Fale diretamente com o mantenedor do projeto.
2. Nunca cole em issue: senha, token de sessão (`X-Auth-Token`), chave do Supabase,
   `.env`, keystore `.jks`, print com nome de operador ou coordenada de máquina.
3. Se um segredo já foi publicado, ele **deve ser trocado** — apagar o arquivo não basta, o
   histórico do git continua público: troque a senha do portal, gere nova `SOLINF_PASS`, nova
   service_role key, e refaça o push com histórico limpo (`git filter-repo` + force-push).

Itens que este projeto já trata por construção:

- senha só em variável de ambiente do servidor (ou digitada no aparelho, no modo local);
- token de sessão nunca é cacheado nem vai para o banco;
- o app **não escreve** no sistema do fornecedor — nada de justificar alarme por robô;
- auditoria antes de publicar: `tools/audit.py` (senha literal, referências quebradas) e
  `tools/sanitizar.py` (nomes de pessoas, dumps de dados reais, segredos do ambiente);
- limite de requisições respeitado (10 req/min/IP medido no servidor do fornecedor).
