# API local â€” incremento 01

Base local padrÃ£o: `http://127.0.0.1:3000`. Exemplos usam somente dados fictÃ­cios. `tenantId` e `userId` nÃ£o sÃ£o aceitos no corpo: vÃªm da sessÃ£o.

## AutenticaÃ§Ã£o

`POST /api/login`

```json
{"tenant":"demo","email":"gerente@jcs.local","password":"SENHA_GERADA_NO_SEU_COMPUTADOR"}
```

CabeÃ§alho `Origin` igual ao endereÃ§o local acessado, incluindo porta. `Content-Type: application/json`. A resposta define cookie HttpOnly e retorna `csrfToken`. Nas mutaÃ§Ãµes seguintes enviar cookie e `X-CSRF-Token`. NÃ£o enviar senhas em query string.

`GET /api/me` retorna usuÃ¡rio, contratante, lojas autorizadas e token CSRF. `POST /api/logout` invalida a sessÃ£o. Uma sessÃ£o expira em 12 horas.

## MutaÃ§Ã£o e repetiÃ§Ã£o

As quatro rotas de negÃ³cio abaixo exigem `Idempotency-Key` com 16 a 100 caracteres `[a-zA-Z0-9_-]`; um UUID atende. A primeira confirmaÃ§Ã£o retorna 201. A repetiÃ§Ã£o da mesma chave, mesmo autor e mesmo payload normalizado retorna 200, com a mesma resposta e `replayed: true`. Outra operaÃ§Ã£o ou payload na mesma chave retorna 409.

Formato:

```json
{"data":{"id":"identificador-gerado"},"replayed":false}
```

Erros:

```json
{"error":{"code":"INSUFFICIENT_STOCK","message":"Estoque insuficiente: ..."}}
```

Falha de conexÃ£o, timeout, 500 ou 503 deve ser tratada como resultado incerto: repetir **a mesma chave e os mesmos dados** ou consultar a operaÃ§Ã£o. NÃ£o inventar outra chave para tentar novamente.

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

Uma diferenÃ§a exige motivo com pelo menos trÃªs caracteres. O operador de abertura deve ser o operador do fechamento.

## Cadastrar produto

`POST /api/products`

```json
{"storeId":"store-a","sku":"CAD-001","barcode":"0012345","name":"Caderno de teste","priceCents":1290,"initialQuantity":5}
```

Somente gerente. SKU e cÃ³digo de barras nÃ£o podem se repetir dentro do contratante. `barcode` pode ser null. Estoque inicial zero Ã© permitido; nesse caso nÃ£o hÃ¡ movimento de quantidade zero.

## Consultas

| Rota | Retorno |
|---|---|
| `GET /api/stores/:storeId/state` | Produtos e saldo, terminais, caixas abertos, Ãºltimas 30 vendas, 50 movimentos e 20 fechamentos |
| `GET /api/sales/:saleId` | Venda com snapshots, pagamento e dados de comprovante de teste |
| `GET /api/operations/:key` | Resultado persistido de uma operaÃ§Ã£o do prÃ³prio usuÃ¡rio |
| `GET /health` | Estado local, `mode=local-test`, `fiscal=false` |

A consulta de operacao nao expoe a resposta de outro operador. A visualizacao de venda depende de autorizacao para sua loja. Nao ha rotas de cancelamento, devolucao ou emissao fiscal. Nao ha integracao PIX, cartao, TEF ou maquininha; apenas registro manual do metodo de pagamento.
