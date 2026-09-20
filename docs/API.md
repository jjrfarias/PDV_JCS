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

As quatro rotas de negócio abaixo exigem `Idempotency-Key` com 16 a 100 caracteres `[a-zA-Z0-9_-]`; um UUID atende. A primeira confirmação retorna 201. A repetição da mesma chave, mesmo autor e mesmo payload normalizado retorna 200, com a mesma resposta e `replayed: true`. Outra operação ou payload na mesma chave retorna 409.

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
  "tenderedCents":5000
}
```

Subtotal, preco e total sao calculados no servidor. `paymentMethod` aceita `CASH`, `PIX` ou `CARD`; quando omitido, assume `CASH`. PIX/cartao sao apenas registro manual apos confirmacao externa, sem TEF/gateway. `priceCents`, `totalCents`, `tenantId` e outros campos desconhecidos sao recusados. O gerente pode conceder desconto ate 20%; operador nao pode. Quantidades repetidas do mesmo produto devem estar agrupadas em uma linha.

## Fechar caixa

`POST /api/cash/close`

```json
{"storeId":"store-a","cashSessionId":"ID_DO_CAIXA","countedCents":14500,"reason":null}
```

Uma diferença exige motivo com pelo menos três caracteres. O operador de abertura deve ser o operador do fechamento.

## Cadastrar produto

`POST /api/products`

```json
{"storeId":"store-a","sku":"CAD-001","barcode":"0012345","name":"Caderno de teste","priceCents":1290,"initialQuantity":5}
```

Somente gerente. SKU e código de barras não podem se repetir dentro do contratante. `barcode` pode ser null. Estoque inicial zero é permitido; nesse caso não há movimento de quantidade zero.

## Consultas

| Rota | Retorno |
|---|---|
| `GET /api/stores/:storeId/state` | Produtos e saldo, terminais, caixas abertos, últimas 30 vendas, 50 movimentos e 20 fechamentos |
| `GET /api/sales/:saleId` | Venda com snapshots, pagamento e dados de comprovante de teste |
| `GET /api/operations/:key` | Resultado persistido de uma operação do próprio usuário |
| `GET /health` | Estado local, `mode=local-test`, `fiscal=false` |

A consulta de operacao nao expoe a resposta de outro operador. A visualizacao de venda depende de autorizacao para sua loja. Nao ha rotas de cancelamento, devolucao ou emissao fiscal. Nao ha integracao PIX, cartao, TEF ou maquininha; apenas registro manual do metodo de pagamento.
