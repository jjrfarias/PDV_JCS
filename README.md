# PDV JCS — primeiro código executável

**Versão 0.1.0 · laboratório local · somente dados fictícios · não liberado para uso comercial.**

Este projeto implementa o primeiro fluxo em dinheiro. Não modifica Mordomê, CR Smart, Cuidar, Railway nem qualquer sistema de cliente. Nenhum desses repositórios foi auditado nesta entrega.

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

**Não precisa executar npm install.** O pacote não tem dependências externas. Não precisa de Docker, PostgreSQL ou Railway para este laboratório. O navegador deve abrir o endereço do servidor; não abra `public/index.html` diretamente.

O arquivo de acessos contém senhas em texto para uso local inicial. Não publique, não coloque no Git e não o envie ao cliente. O banco armazena os hashes das senhas, não esse texto. As permissões de arquivo POSIX não equivalem às ACLs do Windows.

No Linux/macOS, use `npm start` e `npm test` no lugar de `npm.cmd`.

## Primeiro teste pela tela

Faça este roteiro em um banco de demonstração novo, usando o gerente:

| Ação | Resultado esperado |
|---|---|
| Selecione Loja A / Caixa 01 e abra com `100,00` | Fundo inicial R$ 100,00 |
| Leia/digite `7890000000017` e pressione Enter duas vezes | Duas unidades do produto de R$ 25,00 |
| Digite desconto `5,00` e um motivo | Total R$ 45,00 |
| Informe dinheiro entregue `50,00` | Troco R$ 5,00 |
| Confirme a venda | Comprovante marcado TESTE — SEM VALOR FISCAL |
| Confira Produtos e Movimentos de estoque | Saldo 8, com baixa registrada de 2 |
| Confira o caixa | Vendas R$ 45,00; esperado R$ 145,00 |
| Feche contando `145,00` | Diferença zero no histórico de fechamentos |
| Consulte a Loja B | Continua com 30 unidades |

O produto de teste, as lojas, as pessoas e os códigos são fictícios. O código de barras é somente uma entrada de demonstração: não valida origem, registro GS1 nem compatibilidade do leitor físico.

O operador `operador@jcs.local` tem acesso apenas à Loja A e não pode conceder descontos. Para testar esse perfil, feche o caixa do gerente, saia e entre com a senha própria do operador. Existe outro contratante de teste, `outra`, com e-mail `gerente@outra.local` e senha própria.

## O que funciona neste incremento

- Login individual, sessão com expiração, autorização por loja, perfil de gerente/operador e proteção de origem/CSRF nas gravações.
- Produtos por unidade, código interno, código de barras opcional, preço e saldo inicial com movimento identificado.
- Seleção entre lojas e terminais fictícios. Estoque separado por loja, sem transferência ou sincronização de máquinas.
- Abertura e fechamento de caixa pelo próprio operador, com fundo inicial, valor contado, diferença e justificativa.
- Venda em dinheiro com preço consultado no servidor, desconto autorizado até 20% e motivo, valor entregue e troco separados.
- Venda, itens, pagamento, movimentos, auditoria e chave de repetição confirmados na mesma transação local.
- Bloqueio de saldo negativo e proteção para requisições com a mesma chave.
- Histórico de vendas, movimentos de estoque, fechamentos e reabertura do comprovante existente.
- Comando de impressão do navegador. Não existe driver ESC/POS, impressão silenciosa ou homologação de impressora.
- Recuperação de operação incerta: a tela mantém a mesma chave no armazenamento local antes de enviar e reutiliza essa chave na recuperação.

## O que NÃO está entregue

Não há emissão de NFC-e/NF-e, PIX, cartão, TEF, integração de maquininha, certificado digital, impressora fiscal, cadastro completo de clientes, cadastro administrativo de funcionários, contas a pagar/receber, sangria, suprimento, devolução, troca, inventário completo, transferência entre lojas, sincronização com nuvem, gestão consolidada de várias máquinas, contingência fiscal, empacotamento Electron, instalador comercial, restauração/backup homologado, atualização automática nem operação em produção.

A autenticação não tem redefinição de senha, troca obrigatória no primeiro login, MFA ou administração de usuários pela interface. Os três usuários são criados no seed de demonstração. A autorização do gerente significa **o próprio gerente autenticado concede o desconto**; não há fluxo de aprovação por senha do supervisor em uma venda de outro operador.

## Decisão técnica desta entrega

**JavaScript ESM + Node.js + SQLite local + HTML/CSS/JavaScript.** Não é TypeScript/PostgreSQL. É um recorte executável para validar as regras e a primeira transação, sem instalação de banco externo. A arquitetura compartilhada com PostgreSQL permanece uma evolução separada, não uma funcionalidade concluída.

O `node:sqlite` é um módulo nativo com status experimental na versão Node 22.16 utilizada nos testes. O alerta emitido nesse runtime não é ocultado. Não tratar o módulo como garantia de estabilidade nem o laboratório como seleção definitiva do armazenamento comercial.

As operações do `DatabaseSync` são síncronas. Este serviço não foi dimensionado para alta concorrência de um SaaS. SQLite usa `BEGIN IMMEDIATE`, não `SELECT FOR UPDATE` ou RLS do PostgreSQL. Não copiar o SQL e assumir equivalência automática entre bancos.

Antes de migrar para a nuvem, preservar os contratos de domínio e reimplementar transações, concorrência, isolamento no banco e recuperação no adaptador PostgreSQL; executar novamente a suíte em PostgreSQL real. Não compartilhar o arquivo SQLite por pasta de rede nem sincronizá-lo por Dropbox/OneDrive/Google Drive enquanto estiver aberto.

## Estrutura

```text
src/
  server.mjs       Inicialização local, dados fictícios e bloqueio de produção.
  http.mjs         Rotas, sessão, CSRF, política de origem e arquivos públicos.
  security.mjs     scrypt, tokens aleatórios, login e expiração.
  database.mjs     Conexão, migração inicial e transação SQLite.
  schema.sql       Tabelas STRICT, restrições e referências compostas.
  demo.mjs         Dados fictícios, sem reset automático a cada início.
  pos.mjs          Regras de produtos, caixa, venda e idempotência.
public/
  index.html      Tela de acesso e frente de caixa.
  app.mjs         Interface, recuperação e comprovante de teste.
  money.mjs       Conversão de valores decimais para centavos.
  style.css       Interface monocromática e estilo de impressão.
tests/
  pos.test.mjs    Regras e persistência, incluindo concorrência real em SQLite.
  http.test.mjs   Requisições HTTP reais contra o servidor local.
  race-worker.mjs Duas conexões independentes disputando a última unidade.
  helpers.mjs    Bancos temporários e dados dos testes.
docs/
  API.md          Contratos de entrada e exemplos.
  DECISOES.md     Limites, riscos e sequência de evolução.
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

Foram executados 44 testes de domínio e HTTP, sem falhas, no ambiente de preparação. A navegação automatizada da interface não pôde ser concluída porque o Chromium disponível bloqueou a abertura dos endereços de teste por política administrativa. Isso não é teste visual aprovado. Execute o roteiro manual acima no seu computador antes de demonstrar a interface.

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
