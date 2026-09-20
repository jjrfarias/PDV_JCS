# EvidÃªncias de validaÃ§Ã£o â€” 18/09/2026

## Resultado executado

**48 testes passaram; zero falhas, cancelamentos ou testes ignorados.**

Comandos realmente executados na pasta do projeto:

```text
npm run check
npm test
node --test --test-concurrency=1 'tests/*.test.mjs'
```

O terceiro comando tambÃ©m verificou o glob sem depender da expansÃ£o de `*` pelo shell. NÃ£o Ã© uma execuÃ§Ã£o no Windows.

A saÃ­da integral da execuÃ§Ã£o principal estÃ¡ em `TESTES.tap`. A verificaÃ§Ã£o de sintaxe estÃ¡ em `CHECK.log`. O cÃ³digo nÃ£o possui dependÃªncias npm externas.

Ambiente real: Linux x64, Node.js **22.16.0**, SQLite **3.49.1** fornecido pelo `node:sqlite`. O aviso experimental do SQLite foi preservado no log. NÃ£o foi executado Node.js 24 neste ambiente; a linha 24 LTS Ã© a recomendaÃ§Ã£o de instalaÃ§Ã£o para o usuÃ¡rio, nÃ£o uma versÃ£o que estamos alegando ter testado.

## DomÃ­nio e banco â€” 31 testes

Foram executados os cenÃ¡rios numerados no arquivo `tests/pos.test.mjs`:

- CenÃ¡rio principal R$100 de abertura, R$50 de subtotal, R$5 de desconto, R$45 de venda, R$5 de troco, estoque final 8, caixa R$145 e fechamento sem diferenÃ§a.
- RepetiÃ§Ã£o da mesma chave, conflito de payload, consulta apÃ³s resposta perdida e rollback antes do commit com conferÃªncia das tabelas afetadas.
- Estoque insuficiente, caixa fechado, desconto proibido, motivo/limite de desconto, dinheiro insuficiente, PIX/cartão manual sem alterar dinheiro esperado do caixa e bloqueio de campos financeiros vindos da tela.
- AutorizaÃ§Ã£o por loja, isolamento entre contratantes, referÃªncia cruzada de produto/caixa e impossibilidade de outro usuÃ¡rio recuperar a operaÃ§Ã£o privada do autor.
- ValidaÃ§Ã£o de quantidades e valores, abertura/fechamento idempotentes, responsabilidade do operador e registro de diferenÃ§a.
- Cadastro com movimento inicial, cÃ³digo duplicado, snapshots comerciais, gatilhos de imutabilidade e chaves estrangeiras compostas.
- Fechar e reabrir a conexÃ£o do banco em disco preserva venda e saldo; seed nÃ£o repÃµe estoque. Este Ã© teste de reinÃ­cio de conexÃ£o, nÃ£o de corte de energia.
- Duas conexÃµes SQLite independentes, em workers liberados por uma barreira comum, disputam a Ãºltima unidade: exatamente uma confirma, outra recebe estoque insuficiente, saldo fica zero e hÃ¡ uma venda.
- RejeiÃ§Ã£o de callback assÃ­ncrono no invÃ³lucro de transaÃ§Ã£o.

## HTTP e autenticaÃ§Ã£o â€” 13 testes

RequisiÃ§Ãµes reais via TCP loopback para a aplicaÃ§Ã£o, sem framework mockando a API:

- Login, cookie HttpOnly/SameSite, usuÃ¡rio e lojas autorizadas.
- AutenticaÃ§Ã£o obrigatÃ³ria, validaÃ§Ã£o de Origin e CSRF.
- Abertura/venda/recuperaÃ§Ã£o idempotente pela API.
- Bloqueio de loja nÃ£o autorizada, logout e expiraÃ§Ã£o de sessÃ£o.
- Senha invÃ¡lida sem enumeraÃ§Ã£o explÃ­cita de conta e limite de tentativas.
- Bloqueio de Host arbitrÃ¡rio, arquivos privados nÃ£o publicados, limite de corpo e Content-Type.

TambÃ©m foi iniciado o servidor real com diretÃ³rio de dados de teste separado; `/health` retornou `status: ok`, `mode: local-test`, `fiscal: false`.

## NÃ£o executado / nÃ£o aprovado

**Interface no navegador:** o Chromium disponÃ­vel recusou a navegaÃ§Ã£o ao endereÃ§o local por polÃ­tica administrativa (`ERR_BLOCKED_BY_ADMINISTRATOR`). A automaÃ§Ã£o parou antes do login; logo, nÃ£o alegamos teste visual, venda pela interface ou recuperaÃ§Ã£o apÃ³s recarga do navegador como concluÃ­dos. NÃ£o desativamos a polÃ­tica do navegador. Os scripts de interface passaram somente pela verificaÃ§Ã£o de sintaxe nesta preparaÃ§Ã£o. O roteiro manual do README precisa ser executado no computador do usuÃ¡rio.

**Windows e arquivo BAT:** nÃ£o executados em Windows. O sistema de testes foi Linux. A inicializaÃ§Ã£o por `INICIAR-PDV.bat` foi fornecida como conveniÃªncia, nÃ£o como instalador homologado.

**Hardware:** nenhuma impressora, gaveta, balanÃ§a, leitor fÃ­sico ou maquininha foi conectado. Leitura por cÃ³digo na interface nÃ£o equivale a equipamento homologado.

**Fiscal/pagamento:** nenhuma emissÃ£o fiscal, cobranÃ§a PIX, cartÃ£o, TEF, API financeira ou certificado foi testado, pois nÃ£o estÃ¡ implementado.

**Infraestrutura comercial:** nÃ£o foram testados PostgreSQL, RLS, Railway, multi-instÃ¢ncia distribuÃ­da, sincronizaÃ§Ã£o offline, backups/restauraÃ§Ã£o, falta de energia, disco cheio/defeituoso, latÃªncia WAN ou carga de produÃ§Ã£o.

**SeguranÃ§a:** nÃ£o houve auditoria externa/pentest. Os controles implementados e os testes aprovados nÃ£o sÃ£o garantia de seguranÃ§a completa.

## CritÃ©rio de uso

Resultado suficiente para estudo e desenvolvimento local com dados fictÃ­cios. **Insuficiente para liberar um caixa de cliente em produÃ§Ã£o.**
