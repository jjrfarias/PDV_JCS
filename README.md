# PDV JCS

**Versão 0.1.0 · produção inicial em Railway/PostgreSQL · emissão fiscal ainda não ativa.**

Este projeto implementa o primeiro fluxo operacional do PDV JCS: login, loja/terminal, produtos, abertura e fechamento de caixa, venda em dinheiro, estoque, auditoria e idempotência. A aplicação está implantada na Railway com PostgreSQL, mantendo o modo SQLite local apenas para desenvolvimento e testes.

Produção atual:

```text
https://pdvjcs-production.up.railway.app
```

Consulte também [docs/OPERACAO.md](docs/OPERACAO.md) para deploy, migrations e validação operacional.

## Começar no Windows

1. Instale uma versão atualizada do **Node.js 24 LTS**. O código usa o módulo nativo `node:sqlite`; o mínimo declarado neste pacote é Node.js 22.16. A versão 22.13.1 não atende ao mínimo do pacote.
2. Extraia o ZIP em uma pasta nova, por exemplo `C:\Projetos\pdv-jcs-incremento-01`.
3. Abra `INICIAR-PDV.bat`, ou execute no terminal dessa pasta:

```powershell
node --version
npm.cmd start
```

4. Abra `http://127.0.0.1:3000` no navegador. Mantenha o terminal aberto.
5. No primeiro início, o servidor cria o banco e gera senhas aleatórias. Os acessos aparecem no terminal e em `data/ACESSOS-LOCAIS.txt`. Entre com empresa `demo`, e-mail `gerente@jcs.local` e a senha gerada correspondente.

Para desenvolvimento local SQLite, não precisa configurar PostgreSQL ou Railway. O navegador deve abrir o endereço do servidor; não abra `public/index.html` diretamente.

O arquivo de acessos contém senhas em texto para uso local inicial. Não publique, não coloque no Git e não o envie ao cliente. O banco armazena os hashes das senhas, não esse texto. As permissões de arquivo POSIX não equivalem às ACLs do Windows.

No Linux/macOS, use `npm start` e `npm test` no lugar de `npm.cmd`.

## Primeiro teste pela tela

Faça este roteiro em um banco de demonstração novo, usando o gerente:

| Ação | Resultado esperado |
|---|---|
| Selecione Loja A / Caixa 01 e abra com `10000` | Fundo inicial R$ 100,00 |
| Leia/digite `7890000000017` e pressione Enter duas vezes | Duas unidades do produto de R$ 25,00 |
| Digite desconto `500` e um motivo | Total R$ 45,00 |
| Informe dinheiro entregue `5000` | Troco R$ 5,00 |
| Confirme a venda | Comprovante marcado TESTE — SEM VALOR FISCAL |
| Confira Produtos e Movimentos de estoque | Saldo 8, com baixa registrada de 2 |
| Confira o caixa | Vendas R$ 45,00; esperado R$ 145,00 |
| Feche contando `145,00` | Diferença zero no histórico de fechamentos |
| Consulte a Loja B | Continua com 30 unidades |

O produto de teste, as lojas, as pessoas e os códigos são fictícios. O código de barras é somente uma entrada de demonstração: não valida origem, registro GS1 nem compatibilidade do leitor físico.

O operador `operador@jcs.local` tem acesso apenas à Loja A e não pode conceder descontos. Para testar esse perfil, feche o caixa do gerente, saia e entre com a senha própria do operador. Existe outro contratante de teste, `outra`, com e-mail `gerente@outra.local` e senha própria.

## O que funciona neste incremento

- Login individual, sessão com expiração, autorização por loja, perfil de gerente/operador e proteção de origem/CSRF nas gravações.
- Troca da própria senha com confirmação da senha atual e encerramento das demais sessões do mesmo usuário.
- Cadastro, edição, ativação/inativação e reset de senha temporária por gerente, com vínculo à loja selecionada.
- Cadastro, edição e inativação de clientes por loja. Nome, documento, telefone, e-mail e observação ficam criptografados no banco; hashes protegidos são usados apenas para duplicidade/busca interna.
- Produtos por unidade, código interno, código de barras opcional, preço, saldo inicial, edição/inativação gerencial e ajuste manual de estoque com motivo.
- Seleção entre lojas e terminais fictícios. Estoque separado por loja, sem transferência ou sincronização de máquinas.
- Abertura, sangria, suprimento e fechamento de caixa pelo próprio operador, com fundo inicial, valor contado, diferença e justificativa.
- Venda com preço consultado no servidor, desconto autorizado até 20% e motivo. Dinheiro calcula valor entregue e troco; PIX/cartão são registrados manualmente após confirmação externa.
- Resumo do caixa por forma de pagamento calculado no backend: dinheiro, PIX, cartão e total vendido.
- Venda, itens, pagamento, movimentos, auditoria e chave de repetição confirmados na mesma transação local.
- Cancelamento gerencial de venda confirmada, com motivo, devolução de estoque, estorno de dinheiro quando aplicável e registro auditável.
- Relatório por período com vendas, pagamentos, produtos, operadores, fechamentos e exportação compatível com Excel.
- Bloqueio de saldo negativo e proteção para requisições com a mesma chave.
- Histórico de vendas, movimentos de estoque, fechamentos e reabertura do comprovante existente.
- Comando de impressão do navegador. Não existe driver ESC/POS, impressão silenciosa ou homologação de impressora.
- Recuperação de operação incerta: a tela mantém a mesma chave no armazenamento local antes de enviar e reutiliza essa chave na recuperação.

## O que NÃO está entregue

Não há emissão de NFC-e/NF-e, PIX automático, cartão integrado, TEF, integração de maquininha, certificado digital, impressora fiscal, vínculo de cliente na venda, contas a pagar/receber, troca, inventário completo, transferência entre lojas, sincronização com nuvem, gestão consolidada de várias máquinas, contingência fiscal, empacotamento Electron, instalador comercial, restauração/backup homologado nem atualização automática.

A autenticação não tem redefinição de senha por e-mail, troca obrigatória no primeiro login, MFA ou vínculo a múltiplas lojas pela tela. O usuário autenticado consegue alterar a própria senha, e gerentes conseguem administrar usuários da loja selecionada. Os usuários iniciais são criados por seed ou provisionamento operacional. A autorização do gerente significa **o próprio gerente autenticado concede o desconto**; não há fluxo de aprovação por senha do supervisor em uma venda de outro operador.

## Decisão técnica desta entrega

**JavaScript ESM + Node.js + PostgreSQL em produção + SQLite local para desenvolvimento + HTML/CSS/JavaScript.** O adaptador PostgreSQL preserva os contratos do domínio, usa transações reais, bloqueios de linha/advisory lock para idempotência e RLS como defesa adicional de isolamento multi-tenant.

O `node:sqlite` continua existindo para execução local e testes sem infraestrutura externa. Ele usa o módulo nativo experimental do Node; não é o armazenamento de produção.

Em produção, o servidor exige `DATABASE_ENGINE=postgres` e valida que `DATABASE_URL` usa role runtime sem superuser, sem `BYPASSRLS` e sem propriedade das tabelas. O usuário admin/dono do banco deve ficar restrito a migrations e tarefas operacionais controladas.

Cadastros de clientes exigem `JCS_FIELD_ENCRYPTION_KEY` com 32 bytes em Base64 ou 64 caracteres hexadecimais. Sem essa chave, o servidor bloqueia gravação/leitura de dados pessoais em vez de persistir em texto puro. A chave precisa ser preservada em backup seguro: sem ela os dados criptografados não são recuperáveis.

Não compartilhar o arquivo SQLite por pasta de rede nem sincronizá-lo por Dropbox/OneDrive/Google Drive enquanto estiver aberto.

## Estrutura

```text
src/
  server.mjs       Inicialização local ou produção PostgreSQL.
  http.mjs         Rotas, sessão, CSRF, política de origem e arquivos públicos.
  security.mjs     scrypt, tokens aleatórios, login e expiração.
  database.mjs     Conexão, migração inicial e transação SQLite.
  postgres*.mjs    Pool, transações e adaptador PostgreSQL do PDV.
  schema.sql       Tabelas STRICT, restrições e referências compostas.
  demo.mjs         Dados fictícios, sem reset automático a cada início.
  pos.mjs          Regras de produtos, caixa, venda e idempotência.
public/
  index.html      Tela de acesso e frente de caixa.
  app.mjs         Interface, recuperação e comprovante de teste.
  money.mjs       Conversão de valores digitados em centavos.
  style.css       Interface monocromática e estilo de impressão.
tests/
  pos.test.mjs    Regras e persistência, incluindo concorrência real em SQLite.
  http.test.mjs   Requisições HTTP reais contra o servidor local.
  race-worker.mjs Duas conexões independentes disputando a última unidade.
  helpers.mjs    Bancos temporários e dados dos testes.
docs/
  API.md          Contratos de entrada e exemplos.
  DECISOES.md     Limites, riscos e sequência de evolução.
  OPERACAO.md     Deploy, migrations e operação Railway/PostgreSQL.
  TESTES.md       Evidências e limitações da validação.
  TESTES.tap      Saída real dos testes automatizados.
```

O ponto central para estudar primeiro é `src/pos.mjs`, método `sell`. O método `mutate` envolve a operação na transação e faz a recuperação por chave. O navegador nunca determina o preço aceito pelo servidor.

## Testes automatizados

```powershell
npm.cmd run check
npm.cmd test
```

Os testes usam memória ou diretórios temporários criados especificamente para a suíte. Não apontam para `data/pdv.sqlite` e não removem seu banco de demonstração.

Foram executados 65 testes de domínio e HTTP, sem falhas, no ambiente de preparação. A navegação automatizada da interface não pode ser concluída porque o Chromium disponível bloqueou a abertura dos endereços de teste por política administrativa. Isso não é teste visual aprovado. Execute o roteiro manual acima no seu computador antes de demonstrar a interface.

## Persistência e manutenção local

As vendas continuam em `data/pdv.sqlite` após reiniciar o servidor. Não apague `data` para atualizar o código. Arquivos `-wal` e `-shm` podem existir durante a execução; não devem ser removidos manualmente.

Para iniciar outro laboratório sem apagar o atual, use outro diretório:

```powershell
$env:JCS_DATA_DIR = "$PWD\data-outro-laboratorio"
npm.cmd start
```

Isso cria **outro banco de teste**, não uma nova filial sincronizada. Para voltar ao padrão, em um terminal novo sem essa variável, execute normalmente.

Se a porta 3000 estiver ocupada, use outra porta local:

```powershell
$env:PORT = "3100"
npm.cmd start
```

Acesse o endereço exibido no terminal. O servidor escuta somente em `127.0.0.1`. Não o exponha à internet com túnel ou proxy. `NODE_ENV=production` provoca recusa explícita de inicialização; isso é um bloqueio de laboratório, não uma auditoria de segurança.

Uma falha de rede/servidor pode deixar resultado incerto. **Não limpe armazenamento do navegador, não abra outra venda com nova chave e não troque de navegador para repetir a cobrança.** Use Recuperar operação com o mesmo usuário. Se a sessão venceu, atualize, faça login no mesmo usuário e recupere. A perda/limpeza deliberada da chave no navegador não foi solucionada por um mecanismo de sincronização entre dispositivos neste pacote.

## Fontes técnicas primárias

Consultadas em 18/09/2026. Sustentam os mecanismos, não certificam este código:

- Node.js — linha LTS: https://nodejs.org/en/about/previous-releases
- Node.js — `node:sqlite`: https://nodejs.org/api/sqlite.html
- Node.js — criptografia: https://nodejs.org/api/crypto.html
- SQLite — transações: https://www.sqlite.org/lang_transaction.html
- SQLite — chaves estrangeiras: https://www.sqlite.org/foreignkeys.html
- PostgreSQL — bloqueios, referência para etapa futura: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL — RLS, referência para etapa futura: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
