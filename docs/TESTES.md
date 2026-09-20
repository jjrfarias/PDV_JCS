# Evidências de validação — 18/09/2026

## Resultado executado

**54 testes passaram; zero falhas, cancelamentos ou testes ignorados.**

Comandos realmente executados na pasta do projeto:

```text
npm run check
npm test
node --test --test-concurrency=1 'tests/*.test.mjs'
```

O terceiro comando também verificou o glob sem depender da expansão de `*` pelo shell. Não é uma execução no Windows.

A suíte atual foi executada nesta rodada com `npm test`. Logs antigos em arquivos `.tap` ou `.log` são evidências históricas e não substituem a saída da execução atual. O código não possui dependências npm externas além das declaradas no projeto.

Ambiente real: Linux x64, Node.js **22.16.0**, SQLite **3.49.1** fornecido pelo `node:sqlite`. O aviso experimental do SQLite foi preservado no log. Não foi executado Node.js 24 neste ambiente; a linha 24 LTS é a recomendação de instalação para o usuário, não uma versão que estamos alegando ter testado.

## Domínio e banco — 37 testes

Foram executados os cenários numerados no arquivo `tests/pos.test.mjs`:

- Cenário principal R$100 de abertura, R$50 de subtotal, R$5 de desconto, R$45 de venda, R$5 de troco, estoque final 8, caixa R$145 e fechamento sem diferença.
- Repetição da mesma chave, conflito de payload, consulta após resposta perdida e rollback antes do commit com conferência das tabelas afetadas.
- Estoque insuficiente, ajuste manual de estoque com motivo, caixa fechado, desconto proibido, motivo/limite de desconto, dinheiro insuficiente, PIX/cartão manual sem alterar dinheiro esperado do caixa, resumo por forma de pagamento calculado no backend, cancelamento gerencial de venda com estorno, sangria/suprimento com motivo e bloqueio de campos financeiros vindos da tela.
- Autorização por loja, isolamento entre contratantes, referência cruzada de produto/caixa e impossibilidade de outro usuário recuperar a operação privada do autor.
- Validação de quantidades e valores, abertura/fechamento idempotentes, responsabilidade do operador e registro de diferença.
- Cadastro com movimento inicial, código duplicado, snapshots comerciais, gatilhos de imutabilidade e chaves estrangeiras compostas.
- Fechar e reabrir a conexão do banco em disco preserva venda e saldo; seed não repõe estoque. Este é teste de reinício de conexão, não de corte de energia.
- Duas conexões SQLite independentes, em workers liberados por uma barreira comum, disputam a última unidade: exatamente uma confirma, outra recebe estoque insuficiente, saldo fica zero e há uma venda.
- Rejeição de callback assíncrono no invólucro de transação.

## HTTP e autenticação — 17 testes

Requisições reais via TCP loopback para a aplicação, sem framework mockando a API:

- Login, cookie HttpOnly/SameSite, usuário e lojas autorizadas.
- Autenticação obrigatória, validação de Origin e CSRF.
- Abertura/venda/recuperação idempotente pela API.
- Cancelamento de venda por rota idempotente, com reposição de estoque e estorno de caixa.
- Bloqueio de loja não autorizada, logout e expiração de sessão.
- Senha inválida sem enumeração explícita de conta e limite de tentativas.
- Bloqueio de Host arbitrário, arquivos privados não publicados, limite de corpo e Content-Type.

Também foi iniciado o servidor real com diretório de dados de teste separado; `/health` retornou `status: ok`, `mode: local-test`, `fiscal: false`.

## Não executado / não aprovado

**Interface no navegador:** o Chromium disponível recusou a navegação ao endereço local por política administrativa (`ERR_BLOCKED_BY_ADMINISTRATOR`). A automação parou antes do login; logo, não alegamos teste visual, venda pela interface ou recuperação após recarga do navegador como concluídos. Não desativamos a política do navegador. Os scripts de interface passaram somente pela verificação de sintaxe nesta preparação. O roteiro manual do README precisa ser executado no computador do usuário.

**Windows e arquivo BAT:** não executados em Windows. O sistema de testes foi Linux. A inicialização por `INICIAR-PDV.bat` foi fornecida como conveniência, não como instalador homologado.

**Hardware:** nenhuma impressora, gaveta, balança, leitor físico ou maquininha foi conectado. Leitura por código na interface não equivale a equipamento homologado.

**Fiscal/pagamento:** nenhuma emissão fiscal, cobrança PIX, cartão, TEF, API financeira ou certificado foi testado, pois não está implementado.

**Infraestrutura comercial:** migrations e health check foram exercitados em Railway/PostgreSQL, mas não houve teste de carga, multi-instância distribuída, sincronização offline, backups/restauração, falta de energia, disco cheio/defeituoso ou latência WAN.

**Segurança:** não houve auditoria externa/pentest. Os controles implementados e os testes aprovados não são garantia de segurança completa.

## Critério de uso

Resultado suficiente para estudo e desenvolvimento local com dados fictícios. **Insuficiente para liberar um caixa de cliente em produção.**
