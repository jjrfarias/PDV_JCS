# API local — incremento 01

Base local padrão: `http://127.0.0.1:3000`. Exemplos usam somente dados fictícios. `tenantId` e `userId` não são aceitos no corpo: vêm da sessão.

## Autenticação

`POST /api/login`

```json
{"tenant":"demo","email":"gerente@jcs.local","password":"SENHA_GERADA_NO_SEU_COMPUTADOR"}
```

Cabeçalho `Origin` igual ao endereço local acessado, incluindo porta. `Content-Type: application/json`. A resposta define cookie HttpOnly e retorna `csrfToken`. Nas mutações seguintes enviar cookie e `X-CSRF-Token`. Não enviar senhas em query string.

`GET /api/me` retorna usuário, contratante, lojas autorizadas e token CSRF. `POST /api/logout` invalida a sessão. Uma sessão expira em 12 horas.

## Mutação e repetição

As rotas de negócio abaixo exigem `Idempotency-Key` com 16 a 100 caracteres `[a-zA-Z0-9_-]`; um UUID atende. A primeira confirmação retorna 201. A repetição da mesma chave, mesmo autor e mesmo payload normalizado retorna 200, com a mesma resposta e `replayed: true`. Outra operação ou payload na mesma chave retorna 409.

Formato:

```json
{"data":{"id":"identificador-gerado"},"replayed":false}
```

Erros:

```json
{"error":{"code":"INSUFFICIENT_STOCK","message":"Estoque insuficiente: ..."}}
```

Falha de conexão, timeout, 500 ou 503 deve ser tratada como resultado incerto: repetir **a mesma chave e os mesmos dados** ou consultar a operação. Não inventar outra chave para tentar novamente.

## Abrir caixa

`POST /api/cash/open`

```json
{"storeId":"store-a","terminalId":"terminal-a","openingCents":10000}
```

## Vender

`POST /api/sales`

```json
{
  "storeId":"store-a",
  "cashSessionId":"ID_RETORNADO_NA_ABERTURA",
  "items":[{"productId":"product-25","quantity":2}],
  "discountCents":500,
  "discountReason":"Desconto de teste autorizado",
  "paymentMethod":"CASH",
  "tenderedCents":5000,
  "customerId":null
}
```

Subtotal, preço e total são calculados no servidor. `customerId` é opcional; quando informado, deve ser cliente ativo da loja da venda. `paymentMethod` aceita `CASH`, `PIX` ou `CARD`; quando omitido, assume `CASH`. PIX/cartão são apenas registro manual após confirmação externa, sem TEF/gateway. `priceCents`, `totalCents`, `tenantId` e outros campos desconhecidos são recusados. O gerente pode conceder desconto até 20%; operador não pode. Quantidades repetidas do mesmo produto devem estar agrupadas em uma linha.

## Cancelar venda

`POST /api/sales/cancel`

```json
{"storeId":"store-a","saleId":"ID_DA_VENDA","reason":"Cliente desistiu da compra"}
```

Somente gerente. O cancelamento não apaga a venda original: grava o cancelamento, devolve estoque por movimento de ajuste, registra auditoria e, se o pagamento foi em dinheiro, lança uma saída no caixa aberto da venda. A operação é idempotente por `Idempotency-Key`; tentar cancelar de novo com outra chave retorna conflito.

## Devolver venda

`POST /api/sales/return`

```json
{"storeId":"store-a","saleId":"ID_DA_VENDA","items":[{"productId":"product-25","quantity":1}],"reason":"Cliente devolveu um item"}
```

Somente gerente. A devolução pode ser parcial ou total, não apaga a venda original e não aceita venda já cancelada. O backend calcula o valor proporcional ao total pago, impede devolver quantidade acima do saldo disponível por item, recompõe estoque, audita o evento e, se a venda foi em dinheiro, lança uma saída no caixa aberto da venda. PIX/cartão permanecem como registro manual de estorno externo.

## Movimentar dinheiro do caixa

`POST /api/cash/move`

```json
{"storeId":"store-a","cashSessionId":"ID_DO_CAIXA","kind":"WITHDRAWAL","amountCents":5000,"reason":"Sangria para cofre"}
```

`kind` aceita `SUPPLY` para suprimento e `WITHDRAWAL` para sangria. O valor é sempre positivo no corpo; sangria é gravada como saída no livro do caixa. O motivo é obrigatório. O operador deve ser o mesmo que abriu o caixa.

## Fechar caixa

`POST /api/cash/close`

```json
{"storeId":"store-a","cashSessionId":"ID_DO_CAIXA","countedCents":14500,"reason":null}
```

Uma diferença exige motivo com pelo menos três caracteres. O operador de abertura deve ser o operador do fechamento.

## Detalhar caixa

`GET /api/cash/:cashId`

Retorna a conferência do caixa calculada no backend: dados do caixa, operador, terminal, totais por forma de pagamento, movimentos de dinheiro e vendas vinculadas. A consulta respeita tenant e lojas autorizadas do usuário autenticado.

## Cadastrar produto

`POST /api/products`

```json
{"storeId":"store-a","sku":"CAD-001","barcode":"0012345","name":"Caderno de teste","priceCents":1290,"initialQuantity":5}
```

Somente gerente. SKU e código de barras não podem se repetir dentro do contratante. `barcode` pode ser null. Estoque inicial zero é permitido; nesse caso não há movimento de quantidade zero.

## Editar produto

`POST /api/products/update`

```json
{"storeId":"store-a","productId":"product-25","sku":"DEMO-EDIT","barcode":"7890000000999","name":"Produto editado","priceCents":3300,"active":1}
```

Somente gerente. Atualiza cadastro para vendas futuras ou inativa o produto com `active: 0`. Vendas já confirmadas preservam snapshots de nome, SKU, quantidade e preço. SKU e código de barras continuam únicos dentro do contratante.

## Ajustar estoque

`POST /api/stock/adjust`

```json
{"storeId":"store-a","productId":"product-25","quantity":-2,"reason":"Avaria na conferência"}
```

Somente gerente. `quantity` pode ser positivo ou negativo, mas não zero. O ajuste não pode deixar o saldo abaixo de zero nem acima do limite operacional. O motivo é obrigatório.

## Editar usuário

`POST /api/users/update`

```json
{"storeId":"store-a","userId":"ID_DO_USUARIO","email":"operador@jcs.local","name":"Operador","role":"CASHIER","active":1,"temporaryPassword":null}
```

Somente gerente. Atualiza nome, e-mail, perfil e status do usuário vinculado à loja. `temporaryPassword` é opcional; quando informado, é validado, convertido em hash no servidor e nunca retorna na resposta. Reset de senha, inativação ou mudança de perfil encerram sessões existentes do usuário. O gerente autenticado não pode inativar a própria conta nem remover seu próprio perfil de gerente.

## Cadastrar cliente

`POST /api/customers`

```json
{"storeId":"store-a","name":"Cliente Teste","document":"12345678901","phone":"11999990000","email":"cliente@jcs.local","note":"Observação operacional"}
```

Usuário autenticado com acesso à loja. Nome, documento, telefone, e-mail e observação são criptografados no servidor antes de persistir. A resposta da mutação não devolve dados pessoais para que a tabela de idempotência não armazene PII em texto; a tela recarrega a lista pela rota de estado. Documento, telefone, e-mail e observação são opcionais. Documento não pode duplicar dentro do contratante.

## Editar cliente

`POST /api/customers/update`

```json
{"storeId":"store-a","customerId":"ID_DO_CLIENTE","name":"Cliente Editado","document":"12345678901","phone":"11999990000","email":"cliente@jcs.local","note":null,"active":1}
```

Atualiza cadastro ou inativa o cliente com `active: 0`. Dados pessoais continuam criptografados em repouso e a auditoria registra apenas metadados mínimos, como status e presença de documento/e-mail.

## Relatórios

`GET /api/stores/:storeId/report?from=AAAA-MM-DD&to=AAAA-MM-DD`

Retorna totais por período calculados no backend: resumo de vendas, formas de pagamento, produtos vendidos, operadores, vendas com status, valores devolvidos e fechamentos de caixa. Vendas canceladas aparecem na lista, mas não entram nos totais ativos; devoluções reduzem o total líquido do resumo.

`GET /api/stores/:storeId/report.csv?from=AAAA-MM-DD&to=AAAA-MM-DD&section=pagamentos`

Exporta o relatório selecionado em CSV com separador `;`, BOM UTF-8 e cabeçalho `sep=;`, formato compatível com abertura direta no Excel. `section` aceita `resumo`, `pagamentos`, `produtos`, `operadores`, `vendas`, `fechamentos` ou `todos`. O período máximo é 366 dias.

## Consultas

| Rota | Retorno |
|---|---|
| `GET /api/stores/:storeId/state` | Produtos e saldo, clientes da loja, terminais, caixas abertos com totais por forma de pagamento, últimas 30 vendas com status de cancelamento/devolução, 50 movimentos de estoque, 50 movimentos de caixa e 20 fechamentos |
| `GET /api/cash/:cashId` | Conferência detalhada de caixa autorizada, com movimentos e vendas vinculadas |
| `GET /api/stores/:storeId/report` | Relatório operacional por período, com totais consolidados no backend |
| `GET /api/stores/:storeId/report.csv` | Exportação CSV compatível com Excel |
| `GET /api/sales/:saleId` | Venda com snapshots, pagamento e dados de comprovante de teste |
| `GET /api/operations/:key` | Resultado persistido de uma operação do próprio usuário |
| `GET /health` | Estado local, `mode=local-test`, `fiscal=false` |

A consulta de operação não expõe a resposta de outro operador. A visualização de venda depende de autorização para sua loja. Não há troca por outro produto no mesmo fluxo nem emissão fiscal. Não há integração PIX, cartão, TEF ou maquininha; apenas registro manual do método de pagamento.
