# PDV JCS

**VersÃ£o 0.1.0 Â· produÃ§Ã£o inicial em Railway/PostgreSQL Â· emissÃ£o fiscal ainda nÃ£o ativa.**

Este projeto implementa o primeiro fluxo operacional do PDV JCS: login, loja/terminal, produtos, abertura e fechamento de caixa, venda em dinheiro, estoque, auditoria e idempotÃªncia. A aplicaÃ§Ã£o estÃ¡ implantada na Railway com PostgreSQL, mantendo o modo SQLite local apenas para desenvolvimento e testes.

ProduÃ§Ã£o atual:

```text
https://pdvjcs-production.up.railway.app
```

Consulte tambÃ©m [docs/OPERACAO.md](docs/OPERACAO.md) para deploy, migrations e validaÃ§Ã£o operacional.

## ComeÃ§ar no Windows

1. Instale uma versÃ£o atualizada do **Node.js 24 LTS**. O cÃ³digo usa o mÃ³dulo nativo `node:sqlite`; o mÃ­nimo declarado neste pacote Ã© Node.js 22.16. A versÃ£o 22.13.1 nÃ£o atende ao mÃ­nimo do pacote.
2. Extraia o ZIP em uma pasta nova, por exemplo `C:\Projetos\pdv-jcs-incremento-01`.
3. Abra `INICIAR-PDV.bat`, ou execute no terminal dessa pasta:

```powershell
node --version
npm.cmd start
```

4. Abra `http://127.0.0.1:3000` no navegador. Mantenha o terminal aberto.
5. No primeiro inÃ­cio, o servidor cria o banco e gera senhas aleatÃ³rias. Os acessos aparecem no terminal e em `data/ACESSOS-LOCAIS.txt`. Entre com empresa `demo`, e-mail `gerente@jcs.local` e a senha gerada correspondente.

Para desenvolvimento local SQLite, nÃ£o precisa configurar PostgreSQL ou Railway. O navegador deve abrir o endereÃ§o do servidor; nÃ£o abra `public/index.html` diretamente.

O arquivo de acessos contÃ©m senhas em texto para uso local inicial. NÃ£o publique, nÃ£o coloque no Git e nÃ£o o envie ao cliente. O banco armazena os hashes das senhas, nÃ£o esse texto. As permissÃµes de arquivo POSIX nÃ£o equivalem Ã s ACLs do Windows.

No Linux/macOS, use `npm start` e `npm test` no lugar de `npm.cmd`.

## Primeiro teste pela tela

FaÃ§a este roteiro em um banco de demonstraÃ§Ã£o novo, usando o gerente:

| AÃ§Ã£o | Resultado esperado |
|---|---|
| Selecione Loja A / Caixa 01 e abra com `10000` | Fundo inicial R$ 100,00 |
| Leia/digite `7890000000017` e pressione Enter duas vezes | Duas unidades do produto de R$ 25,00 |
| Digite desconto `500` e um motivo | Total R$ 45,00 |
| Informe dinheiro entregue `5000` | Troco R$ 5,00 |
| Confirme a venda | Comprovante marcado TESTE â€” SEM VALOR FISCAL |
| Confira Produtos e Movimentos de estoque | Saldo 8, com baixa registrada de 2 |
| Confira o caixa | Vendas R$ 45,00; esperado R$ 145,00 |
| Feche contando `145,00` | DiferenÃ§a zero no histÃ³rico de fechamentos |
| Consulte a Loja B | Continua com 30 unidades |

O produto de teste, as lojas, as pessoas e os cÃ³digos sÃ£o fictÃ­cios. O cÃ³digo de barras Ã© somente uma entrada de demonstraÃ§Ã£o: nÃ£o valida origem, registro GS1 nem compatibilidade do leitor fÃ­sico.

O operador `operador@jcs.local` tem acesso apenas Ã  Loja A e nÃ£o pode conceder descontos. Para testar esse perfil, feche o caixa do gerente, saia e entre com a senha prÃ³pria do operador. Existe outro contratante de teste, `outra`, com e-mail `gerente@outra.local` e senha prÃ³pria.

## O que funciona neste incremento

- Login individual, sessÃ£o com expiraÃ§Ã£o, autorizaÃ§Ã£o por loja, perfil de gerente/operador e proteÃ§Ã£o de origem/CSRF nas gravaÃ§Ãµes.
- Troca da prÃ³pria senha com confirmaÃ§Ã£o da senha atual e encerramento das demais sessÃµes do mesmo usuÃ¡rio.
- Cadastro de usuÃ¡rios por gerente, com vÃ­nculo Ã  loja selecionada e senha temporÃ¡ria definida no cadastro.
- Produtos por unidade, cÃ³digo interno, cÃ³digo de barras opcional, preÃ§o e saldo inicial com movimento identificado.
- SeleÃ§Ã£o entre lojas e terminais fictÃ­cios. Estoque separado por loja, sem transferÃªncia ou sincronizaÃ§Ã£o de mÃ¡quinas.
- Abertura e fechamento de caixa pelo prÃ³prio operador, com fundo inicial, valor contado, diferenÃ§a e justificativa.
- Venda com preco consultado no servidor, desconto autorizado ate 20% e motivo. Dinheiro calcula valor entregue e troco; PIX/cartao sao registrados manualmente apos confirmacao externa.
- Venda, itens, pagamento, movimentos, auditoria e chave de repetiÃ§Ã£o confirmados na mesma transaÃ§Ã£o local.
- Bloqueio de saldo negativo e proteÃ§Ã£o para requisiÃ§Ãµes com a mesma chave.
- HistÃ³rico de vendas, movimentos de estoque, fechamentos e reabertura do comprovante existente.
- Comando de impressÃ£o do navegador. NÃ£o existe driver ESC/POS, impressÃ£o silenciosa ou homologaÃ§Ã£o de impressora.
- RecuperaÃ§Ã£o de operaÃ§Ã£o incerta: a tela mantÃ©m a mesma chave no armazenamento local antes de enviar e reutiliza essa chave na recuperaÃ§Ã£o.

## O que NÃƒO estÃ¡ entregue

NÃ£o hÃ¡ emissÃ£o de NFC-e/NF-e, PIX, cartÃ£o, TEF, integraÃ§Ã£o de maquininha, certificado digital, impressora fiscal, cadastro completo de clientes, cadastro administrativo de funcionÃ¡rios, contas a pagar/receber, sangria, suprimento, devoluÃ§Ã£o, troca, inventÃ¡rio completo, transferÃªncia entre lojas, sincronizaÃ§Ã£o com nuvem, gestÃ£o consolidada de vÃ¡rias mÃ¡quinas, contingÃªncia fiscal, empacotamento Electron, instalador comercial, restauraÃ§Ã£o/backup homologado, atualizaÃ§Ã£o automÃ¡tica nem operaÃ§Ã£o em produÃ§Ã£o.

A autenticaÃ§Ã£o nÃ£o tem redefiniÃ§Ã£o de senha por e-mail, troca obrigatÃ³ria no primeiro login, MFA, ediÃ§Ã£o/desativaÃ§Ã£o de usuÃ¡rios pela interface ou vÃ­nculo a mÃºltiplas lojas pela tela. O usuÃ¡rio autenticado consegue alterar a prÃ³pria senha, e gerentes conseguem cadastrar novos usuÃ¡rios para a loja selecionada. Os usuÃ¡rios iniciais sÃ£o criados por seed ou provisionamento operacional. A autorizaÃ§Ã£o do gerente significa **o prÃ³prio gerente autenticado concede o desconto**; nÃ£o hÃ¡ fluxo de aprovaÃ§Ã£o por senha do supervisor em uma venda de outro operador.

## DecisÃ£o tÃ©cnica desta entrega

**JavaScript ESM + Node.js + PostgreSQL em produÃ§Ã£o + SQLite local para desenvolvimento + HTML/CSS/JavaScript.** O adaptador PostgreSQL preserva os contratos do domÃ­nio, usa transaÃ§Ãµes reais, bloqueios de linha/advisory lock para idempotÃªncia e RLS como defesa adicional de isolamento multi-tenant.

O `node:sqlite` continua existindo para execuÃ§Ã£o local e testes sem infraestrutura externa. Ele usa o mÃ³dulo nativo experimental do Node; nÃ£o Ã© o armazenamento de produÃ§Ã£o.

Em produÃ§Ã£o, o servidor exige `DATABASE_ENGINE=postgres` e valida que `DATABASE_URL` usa role runtime sem superuser, sem `BYPASSRLS` e sem propriedade das tabelas. O usuÃ¡rio admin/dono do banco deve ficar restrito a migrations e tarefas operacionais controladas.

NÃ£o compartilhar o arquivo SQLite por pasta de rede nem sincronizÃ¡-lo por Dropbox/OneDrive/Google Drive enquanto estiver aberto.

## Estrutura

```text
src/
  server.mjs       InicializaÃ§Ã£o local ou produÃ§Ã£o PostgreSQL.
  http.mjs         Rotas, sessÃ£o, CSRF, polÃ­tica de origem e arquivos pÃºblicos.
  security.mjs     scrypt, tokens aleatÃ³rios, login e expiraÃ§Ã£o.
  database.mjs     ConexÃ£o, migraÃ§Ã£o inicial e transaÃ§Ã£o SQLite.
  postgres*.mjs    Pool, transaÃ§Ãµes e adaptador PostgreSQL do PDV.
  schema.sql       Tabelas STRICT, restriÃ§Ãµes e referÃªncias compostas.
  demo.mjs         Dados fictÃ­cios, sem reset automÃ¡tico a cada inÃ­cio.
  pos.mjs          Regras de produtos, caixa, venda e idempotÃªncia.
public/
  index.html      Tela de acesso e frente de caixa.
  app.mjs         Interface, recuperaÃ§Ã£o e comprovante de teste.
  money.mjs       ConversÃ£o de valores digitados em centavos.
  style.css       Interface monocromÃ¡tica e estilo de impressÃ£o.
tests/
  pos.test.mjs    Regras e persistÃªncia, incluindo concorrÃªncia real em SQLite.
  http.test.mjs   RequisiÃ§Ãµes HTTP reais contra o servidor local.
  race-worker.mjs Duas conexÃµes independentes disputando a Ãºltima unidade.
  helpers.mjs    Bancos temporÃ¡rios e dados dos testes.
docs/
  API.md          Contratos de entrada e exemplos.
  DECISOES.md     Limites, riscos e sequÃªncia de evoluÃ§Ã£o.
  OPERACAO.md     Deploy, migrations e operaÃ§Ã£o Railway/PostgreSQL.
  TESTES.md       EvidÃªncias e limitaÃ§Ãµes da validaÃ§Ã£o.
  TESTES.tap      SaÃ­da real dos testes automatizados.
```

O ponto central para estudar primeiro Ã© `src/pos.mjs`, mÃ©todo `sell`. O mÃ©todo `mutate` envolve a operaÃ§Ã£o na transaÃ§Ã£o e faz a recuperaÃ§Ã£o por chave. O navegador nunca determina o preÃ§o aceito pelo servidor.

## Testes automatizados

```powershell
npm.cmd run check
npm.cmd test
```

Os testes usam memÃ³ria ou diretÃ³rios temporÃ¡rios criados especificamente para a suÃ­te. NÃ£o apontam para `data/pdv.sqlite` e nÃ£o removem seu banco de demonstraÃ§Ã£o.

Foram executados 48 testes de dominio e HTTP, sem falhas, no ambiente de preparacao. A navegacao automatizada da interface nao pode ser concluida porque o Chromium disponivel bloqueou a abertura dos enderecos de teste por politica administrativa. Isso nao e teste visual aprovado. Execute o roteiro manual acima no seu computador antes de demonstrar a interface.

## PersistÃªncia e manutenÃ§Ã£o local

As vendas continuam em `data/pdv.sqlite` apÃ³s reiniciar o servidor. NÃ£o apague `data` para atualizar o cÃ³digo. Arquivos `-wal` e `-shm` podem existir durante a execuÃ§Ã£o; nÃ£o devem ser removidos manualmente.

Para iniciar outro laboratÃ³rio sem apagar o atual, use outro diretÃ³rio:

```powershell
$env:JCS_DATA_DIR = "$PWD\data-outro-laboratorio"
npm.cmd start
```

Isso cria **outro banco de teste**, nÃ£o uma nova filial sincronizada. Para voltar ao padrÃ£o, em um terminal novo sem essa variÃ¡vel, execute normalmente.

Se a porta 3000 estiver ocupada, use outra porta local:

```powershell
$env:PORT = "3100"
npm.cmd start
```

Acesse o endereÃ§o exibido no terminal. O servidor escuta somente em `127.0.0.1`. NÃ£o o exponha Ã  internet com tÃºnel ou proxy. `NODE_ENV=production` provoca recusa explÃ­cita de inicializaÃ§Ã£o; isso Ã© um bloqueio de laboratÃ³rio, nÃ£o uma auditoria de seguranÃ§a.

Uma falha de rede/servidor pode deixar resultado incerto. **NÃ£o limpe armazenamento do navegador, nÃ£o abra outra venda com nova chave e nÃ£o troque de navegador para repetir a cobranÃ§a.** Use Recuperar operaÃ§Ã£o com o mesmo usuÃ¡rio. Se a sessÃ£o venceu, atualize, faÃ§a login no mesmo usuÃ¡rio e recupere. A perda/limpeza deliberada da chave no navegador nÃ£o foi solucionada por um mecanismo de sincronizaÃ§Ã£o entre dispositivos neste pacote.

## Fontes tÃ©cnicas primÃ¡rias

Consultadas em 18/09/2026. Sustentam os mecanismos, nÃ£o certificam este cÃ³digo:

- Node.js â€” linha LTS: https://nodejs.org/en/about/previous-releases
- Node.js â€” `node:sqlite`: https://nodejs.org/api/sqlite.html
- Node.js â€” criptografia: https://nodejs.org/api/crypto.html
- SQLite â€” transaÃ§Ãµes: https://www.sqlite.org/lang_transaction.html
- SQLite â€” chaves estrangeiras: https://www.sqlite.org/foreignkeys.html
- PostgreSQL â€” bloqueios, referÃªncia para etapa futura: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL â€” RLS, referÃªncia para etapa futura: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
