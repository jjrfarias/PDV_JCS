# Decisões, limites e próximas etapas

## Natureza do pacote

A solicitação foi avançar para o primeiro código. Como não foi fornecido um repositório-alvo, o incremento foi criado separado. O roteiro anterior propunha avaliar sistemas existentes antes de reutilização. Essa auditoria não aconteceu: esta base não incorpora código desses sistemas nem permite concluir que devam ser substituídos.

JavaScript ESM e SQLite são a escolha deste laboratório, não uma migração aprovada de todos os produtos da JCS. Não há mudanças nos sistemas já vendidos ou em implantação.

## Invariantes implementadas

1. Cada requisição obtém contratante e usuário de uma sessão validada. O corpo não pode escolher `tenantId`, preço ou total.
2. A autorização por loja ocorre no serviço, não somente na tela. As referências compostas do banco bloqueiam relações entre registros de contratantes diferentes.
3. O estoque de uma loja não é o estoque de outra. O catálogo é do contratante; o saldo é por loja.
4. Uma venda possui snapshots de SKU, nome, quantidade e preço. Mudanças futuras de cadastro não reescrevem o histórico.
5. Dinheiro é representado por centavos inteiros e limites explícitos. Quantidades são inteiras; venda fracionada não está implementada.
6. Desconto requer gerente, motivo e limite de 20%. A regra é fixa neste experimento; não é uma política comercial aprovada para todos os clientes.
7. Fundo inicial não é venda; entregue menos troco é o valor efetivamente acrescentado ao caixa.
8. `BEGIN IMMEDIATE` protege a operação contra outro escritor local. Condição `quantity >= quantidade` e CHECK de saldo não negativo reforçam a regra.
9. Chave não nula, autor, loja, tipo e payload normalizado determinam a recuperação. Chave já utilizada com outra operação recebe 409, sem reaproveitar seus efeitos.
10. A resposta de uma operação só entra no livro de operações na mesma transação que os efeitos. Se a resposta HTTP se perder, o resultado pode ser consultado ou reenviado com a mesma chave.
11. Falha de impressão não executa venda. A impressão vem de um registro já confirmado.
12. Venda, pagamento e fiscal possuem estados separados; o fiscal permanece `TEST_NOT_ISSUED`.
13. Nenhuma chamada de rede ou `await` é permitida dentro da transação síncrona.
14. Registros de venda, pagamento, movimentos, devolução, operação e auditoria não têm edição/remoção pela API e possuem gatilhos de imutabilidade. Cancelamentos e devoluções são eventos compensatórios, sem alterar a venda original.

## Segurança e limites reais

Sessões de 12 horas com token aleatório cujo hash é guardado no banco; cookie HttpOnly e SameSite=Strict. Para este endereço local HTTP, não há atributo Secure. Produção exigiria HTTPS e nova revisão de sessão, domínio, proxy e cookies. Há validação de Host e Origin, token CSRF, limite de corpo e de login, consultas parametrizadas e CSP. Isso não é um pentest nem prova de ausência de falhas.

O arquivo local pode ser acessado por quem tem permissão no sistema operacional. Separação por contratante no backend e referências compostas NÃO equivalem a RLS: um processo com acesso direto ao arquivo pode ler todos os dados. Use apenas dados fictícios.

O rate limit é em memória e de uma instância local; não é distribuído e reinicia com o processo. Controles comerciais por perfil são mínimos: gerente/operador, permissão por loja e dono do caixa. Usuários autorizados para uma loja podem consultar seus produtos e históricos; não existe RBAC granular financeiro.

O aplicativo utiliza JavaScript síncrono no acesso SQLite. Um escritor pode bloquear outro temporariamente. Em alta concorrência há necessidade de outra arquitetura. Não rodar várias instâncias HTTP apontando para um arquivo em rede.

A idempotência protege a mesma chave; criar propositalmente uma nova chave representa outra operação. O estado de pendência no navegador não é sincronização offline comercial, não é proteção contra usuário malicioso e não garante recuperação após limpeza de dados ou em outro navegador.

Testes de concorrência foram feitos com duas conexões SQLite em workers independentes. Não foram testes de PostgreSQL, várias máquinas, rede de loja, escala, falta de energia ou armazenamento defeituoso.

## Ordem sugerida de evolução

**Gate 1 — conferir esta base:** executar testes no PC, validar interface e recuperação, revisar código, confirmar as regras de desconto, abertura e fechamento. Não usar dados reais.

**Gate 2 — decidir o produto e a implantação:** definir repositório-alvo, ramo, estabelecimentos, lojas/terminais, equipamentos e provedores. Avaliar formalmente aproveitamento de Mordomê e CR Smart. Decidir TypeScript e a divisão entre API central e frente de caixa.

**Gate 3 — PostgreSQL e identidade comercial:** criar migrations PostgreSQL, adaptador, autenticação/gestão de usuários de produção e testes reais de isolamento/concorrência. API operacional não deve usar superusuário/BYPASSRLS. Testar migração, backup e restauração.

**Gate 4 — integrações:** validar um provedor/maquininha específico, pagamento confirmado e resultado incerto; emissão fiscal em homologação conforme estado e responsável fiscal; impressão e leitor físicos. Não tratar simuladores como integração real.

**Gate 5 — operação ampliada:** clientes, compras/recebimentos, ajustes com auditoria, contas a pagar/receber, trocas/devoluções, sangria/suprimento, transferências e relatórios. Projetar sincronização/contingência segundo o fluxo efetivo.

Liberar produção somente após revisão de segurança, aceite funcional/fiscal, equipamentos, recuperação, backup restaurado e piloto controlado.
