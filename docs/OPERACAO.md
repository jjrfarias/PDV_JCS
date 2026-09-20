# Operacao do PDV JCS

## Estado atual

- Aplicacao em producao: https://pdvjcs-production.up.railway.app
- Plataforma: Railway, servico `PDV_JCS`.
- Banco: PostgreSQL Railway, servico `Postgres`.
- Branch de deploy: `master` do repositorio `jjrfarias/PDV_JCS`.
- CI: GitHub Actions executa `npm ci`, `npm run check` e `npm test`.

O endpoint publico de verificacao e:

```text
GET /health
```

Resposta esperada:

```json
{"status":"ok","mode":"production","database":"postgres","fiscal":false}
```

## Variaveis obrigatorias na Railway

No servico `PDV_JCS`:

- `NODE_ENV=production`
- `DATABASE_ENGINE=postgres`
- `DATABASE_URL`: URL do usuario runtime da aplicacao, nao do dono/admin do banco.
- `PORT=3000`
- `PUBLIC_ORIGIN=https://pdvjcs-production.up.railway.app`
- `JCS_FIELD_ENCRYPTION_KEY`: 32 bytes em Base64 ou 64 caracteres hexadecimais para criptografia de dados pessoais de clientes.

O usuario da aplicacao deve ser membro de `pdv_runtime` e nao pode ser superuser, `BYPASSRLS` nem dono das tabelas. O servidor valida isso ao iniciar.

Guarde `JCS_FIELD_ENCRYPTION_KEY` em cofre/backup seguro. Perder essa chave torna os dados de clientes criptografados irrecuperáveis. Troca/rotação de chave ainda não está implementada.

## Migrations

As migrations ficam em `migrations/` e sao aplicadas por:

```powershell
npm.cmd run migrate:postgres
```

Para Railway, rode com uma conexao admin/tunelada ao banco. Nao use a `DATABASE_URL` runtime para migrations de schema.

Fluxo recomendado:

1. Abrir tunel para o Postgres privado:

```powershell
railway connect Postgres --tunnel-only --port 55433
```

2. Em outro terminal, apontar `DATABASE_URL` para o endereco local exibido pelo tunel.
3. Rodar:

```powershell
npm.cmd run migrate:postgres
```

4. Fechar o tunel com `Ctrl+C`.

## Deploy

O deploy normal e por GitHub:

```powershell
git push origin master
```

O push no `master` dispara CI e deploy automatico na Railway.

Use `railway up` apenas para emergencia ou validacao manual. Depois de qualquer deploy manual, mantenha o GitHub sincronizado.

## Validacao minima apos deploy

```powershell
Invoke-WebRequest -UseBasicParsing https://pdvjcs-production.up.railway.app/health
```

Ou rode o smoke test automatizado:

```powershell
$env:PDV_SMOKE_TENANT = "jcs"
$env:PDV_SMOKE_EMAIL = "admin@jcs.local"
$env:PDV_SMOKE_PASSWORD = "<senha do usuario>"
npm.cmd run smoke:production
```

O smoke test valida `/health`, login e `/api/me`. Nao commite senha nem coloque esse valor em arquivos do repositorio.

Tambem validar:

- login com usuario autorizado;
- `GET /api/me`;
- uma leitura de estado da loja;
- uma mutacao pequena com CSRF e chave de idempotencia, quando apropriado.

## Reset operacional de senha

Senhas existentes nao sao recuperaveis: o banco guarda apenas hash. Quando um acesso de producao for perdido, use reset com conexao administrativa/migration ao PostgreSQL. Nao use a `DATABASE_URL` runtime da aplicacao.

```powershell
$env:PG_MIGRATION_DATABASE_URL = "<url admin/tunelada do Postgres>"
$env:PDV_RESET_TENANT = "jcs"
$env:PDV_RESET_EMAIL = "admin@jcs.local"
$env:PDV_RESET_NEW_PASSWORD = "<nova senha forte>"
$env:PDV_RESET_CONFIRM = "RESET_PASSWORD"
npm.cmd run reset:password:postgres
Remove-Item Env:\PDV_RESET_NEW_PASSWORD
Remove-Item Env:\PG_MIGRATION_DATABASE_URL
```

O script exige senha forte, atualiza somente o hash, invalida sessoes abertas do usuario e registra auditoria `PASSWORD_RESET_ADMIN`. Ele nao imprime a nova senha.

## Limites conhecidos

- Fiscal ainda desativado: sem NFC-e/NF-e.
- Sem PIX automático, TEF, cartão integrado ou impressora fiscal. PIX/cartão são apenas registro manual após confirmação externa.
- Sem tela administrativa completa de usuarios, redefinicao de senha por e-mail ou MFA. O usuario autenticado consegue trocar a propria senha, e gerente consegue cadastrar usuario para a loja selecionada.
- Sem backup/restauracao homologados registrados neste repositorio.
- A senha inicial salva em `.codex-validation/` e local e nao deve ser commitada.

## Regras de seguranca que nao devem ser removidas

- Tenant sempre derivado da sessao autenticada.
- RLS ativo e forcado nas tabelas multi-tenant.
- Mutacoes com idempotencia e efeitos gravados na mesma transacao.
- Dinheiro em centavos inteiros.
- Host, Origin, CSRF e limite de corpo HTTP preservados.
- Runtime PostgreSQL sem superuser, sem `BYPASSRLS` e sem propriedade das tabelas.
