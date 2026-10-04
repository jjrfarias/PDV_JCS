# Dump externo criptografado

Este serviço executa `pg_dump` em formato customizado, valida o catálogo com `pg_restore --list`, criptografa o arquivo com `age` e envia o dump e seu SHA-256 para um destino S3 compatível fora do projeto principal.

Variáveis obrigatórias:

- `DATABASE_URL`: referência privada ao PostgreSQL.
- `BACKUP_S3_URI`: destino, por exemplo `s3://cofre-pdv/producao`.
- `BACKUP_AGE_RECIPIENT`: chave pública `age1...`; a chave privada não deve entrar no Railway.
- Credenciais exigidas pelo AWS CLI, como `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` e, para provedores compatíveis, configuração de endpoint.

Execute como serviço cron diário após o fechamento das lojas. Configure retenção/versionamento no próprio bucket e alertas para falha da execução. A aceitação só termina após baixar um dump, validar o checksum, descriptografar e restaurar em banco isolado.

Nunca grave dumps, chaves privadas ou credenciais no Git. O destino deve pertencer a outra conta ou projeto administrativo para sobreviver à exclusão do projeto principal.
