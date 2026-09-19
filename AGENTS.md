# Regras para desenvolver este incremento

Leia README.md, docs/DECISOES.md e docs/TESTES.md antes de modificar. Este é um laboratório JavaScript/SQLite, não o SaaS comercial concluído.

- Não acessar produção, emitir documento fiscal, cobrar pagamento, executar deploy ou mexer em outros repositórios sem autorização específica.
- Não ler ou exibir senhas em data/ACESSOS-LOCAIS.txt, valores de cookies ou dados reais para montar contexto. Os testes têm credenciais fictícias próprias.
- Não apagar data/, remover logs de negócio, alterar movimentos confirmados nem resetar seed para fazer um teste passar.
- Preservar preço no servidor, centavos inteiros, estoque sem saldo negativo, autorização por loja, referências compostas e snapshots.
- Toda mutação deve ser idempotente por chave/payload/autor/loja e persistir resposta e efeitos na mesma transação.
- Não implementar o futuro PostgreSQL apenas trocando import. Ele exige migrations, isolamento e testes de concorrência reais próprios. Não substituir controles por testes mockados sem registrar o limite.
- Não remover proteção CSRF, Host, Origin, limite de corpo ou bloqueio de execução em produção para facilitar demonstração.
- Não colocar flags de falha ou bypass de autenticação na API para viabilizar testes.
- Não acrescentar modo offline, fiscal, cartão ou impressão silenciosa apenas com botões simulados.
- Executar npm run check e npm test. Explicitar separadamente o que foi planejado, implementado, testado e não verificado.
- Antes de incorporar novas dependências, justificar necessidade, fixar versões/lockfile e revisar manutenção/segurança. Este pacote inicial não tem dependências externas.
- A interface ainda precisa de validação no navegador do usuário: o navegador do ambiente de preparação bloqueou a navegação local.

Próxima tarefa segura: validar a interface e o fluxo de dinheiro neste laboratório, manter os 44 testes e acrescentar regressões para qualquer problema encontrado. Não pular automaticamente para implantação comercial.
