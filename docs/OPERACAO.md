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

Para recuperação de senha por e-mail (opcional; sem elas o pedido é aceito, mas nenhum e-mail sai e o servidor registra um aviso):

- `RESEND_API_KEY`: chave do provedor Resend, só no painel da Railway.
- `EMAIL_FROM`: remetente verificado no Resend, por exemplo `PDV JCS <noreply@jordaoconsultoria.com>`, no mesmo domínio já usado pelo Cuidar. Use uma chave própria do PDV na mesma conta Resend, não a chave do Cuidar.

Somente o e-mail do usuário e o link de recuperação são enviados ao provedor. A migration `011_password_resets` precisa estar aplicada antes do deploy desta versão.

O usuario da aplicacao deve ser membro de `pdv_runtime` e nao pode ser superuser, `BYPASSRLS` nem dono das tabelas. O servidor valida isso ao iniciar.

Guarde `JCS_FIELD_ENCRYPTION_KEY` em cofre/backup seguro. Perder essa chave torna os dados de clientes e os segredos MFA irrecuperáveis.

### Rotação da chave de campos

1. Gere e guarde uma nova chave de 32 bytes no cofre, sem remover a atual.
2. Pare o serviço da aplicação para impedir leituras com a chave antiga durante a troca.
3. Aplique todas as migrations com a conexão administrativa.
4. Em um terminal seguro, informe `PG_MIGRATION_DATABASE_URL`, `JCS_OLD_FIELD_ENCRYPTION_KEY`, `JCS_NEW_FIELD_ENCRYPTION_KEY`, `PDV_ROTATION_MAINTENANCE=CONFIRM_APP_STOPPED` e `PDV_ROTATION_CONFIRM=ROTATE_FIELD_KEY`.
5. Execute `npm.cmd run rotate:field-key:postgres`. O comando bloqueia as tabelas, recriptografa clientes e MFA, recalcula hashes de busca e registra apenas IDs de chave e contagens em `security_maintenance_events`.
6. Atualize `JCS_FIELD_ENCRYPTION_KEY` no serviço para a nova chave e inicie a aplicação.
7. Valide login com MFA, leitura de cliente e duplicidade de documento. Preserve a chave antiga em cofre até concluir a validação e o backup pós-rotação.

Qualquer erro desfaz a transação inteira. Nunca registre as chaves em arquivo, Git, chamado ou mensagem.

**Evidência de 04/10/2026:** antes da primeira rotação foi criado um backup manual de volume de 970 MB, com PITR ativo. A migration de auditoria foi aplicada e a aplicação foi interrompida. A rotação recriptografou 1 cliente e o segredo MFA de 1 administrador da plataforma, recalculou os hashes de busca e gravou `FIELD_KEY_ROTATED`. A validação com a chave nova conferiu todos os campos criptografados e hashes; depois o serviço voltou com PostgreSQL saudável, `/health`, página inicial e aviso de privacidade respondendo HTTP 200. Nenhum valor de chave foi incluído nos logs da operação ou neste documento.

## Migrations

Consulte `docs/BACKUP-E-RESTAURACAO.md` para a proteção ativa, a evidência do teste real de restauração e as pendências de recuperação.

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

## Recuperação operacional do MFA

Se um administrador ou gerente perder o autenticador, use uma conexão administrativa pelo túnel PostgreSQL e execute `npm.cmd run reset:mfa:postgres`. Defina `PDV_MFA_TARGET` como `platform` ou `manager`, `PDV_MFA_EMAIL`, `PDV_MFA_TENANT` para gerente e `PDV_MFA_CONFIRM=RESET_MFA`. O comando remove o segredo, encerra todas as sessões e registra auditoria. Confirme a identidade da pessoa por procedimento interno antes de executar; nunca use a conexão runtime.

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

## Administrador do sistema

A migration `012_platform_admins` precisa estar aplicada. Para criar um administrador, com o túnel aberto e a URL admin do banco:

```powershell
$env:PG_MIGRATION_DATABASE_URL = "<url admin pelo túnel>"
$env:PDV_ADMIN_EMAIL = "nome@jordaoconsultoria.com"
$env:PDV_ADMIN_NAME = "Nome Sobrenome"
$env:PDV_ADMIN_CONFIRM = "CREATE_PLATFORM_ADMIN"
npm.cmd run create:platform-admin
```

A conta nasce sem senha utilizável. O administrador abre `/admin`, usa "Esqueci minha senha" e define a senha pelo link do e-mail. Rodar o script de novo com o mesmo e-mail não altera nada.

## Limites conhecidos

- Fiscal ainda desativado: sem NFC-e/NF-e.
- Sem PIX automático, TEF, cartão integrado ou impressora fiscal. PIX/cartão são apenas registro manual após confirmação externa.
- A redefinicao de senha e os convites por e-mail dependem da configuracao do provedor. Administrador da plataforma e gerentes podem ativar MFA TOTP; ainda nao ha troca obrigatoria no primeiro login nem recuperacao automatica do autenticador.
- Sem backup/restauracao homologados registrados neste repositorio.
- A senha inicial salva em `.codex-validation/` e local e nao deve ser commitada.

## Regras de seguranca que nao devem ser removidas

- Tenant sempre derivado da sessao autenticada.
- RLS ativo e forcado nas tabelas multi-tenant.
- Mutacoes com idempotencia e efeitos gravados na mesma transacao.
- Dinheiro em centavos inteiros.
- Host, Origin, CSRF e limite de corpo HTTP preservados.
- Runtime PostgreSQL sem superuser, sem `BYPASSRLS` e sem propriedade das tabelas.
