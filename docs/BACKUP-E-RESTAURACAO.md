# Backup e restauração — evidência operacional

Última validação: 4 de outubro de 2026.

## Proteções ativas na Railway

- Backup de volume diário, semanal e mensal.
- Backup manual `baseline-after-restore-drill`, mantido sem expiração automática.
- Recuperação ponto a ponto (PITR) habilitada e bucket conectado.
- `JCS_FIELD_ENCRYPTION_KEY` presente no serviço da aplicação. O valor não foi lido nem copiado durante a validação.

Retenção oferecida atualmente pela Railway: diário por 6 dias, semanal por 27 dias e mensal por 89 dias. O PITR só terá uma janela efetiva depois que o primeiro backup-base e o arquivamento de WAL concluírem; o estado `enabled` não prova cobertura retroativa.

## Teste real de restauração

Foi criado um dump lógico em formato customizado com `pg_dump`, restaurado com `pg_restore --exit-on-error` em `pdv_jcs_restore_drill`, no mesmo servidor PostgreSQL e sem alterar o banco de produção `railway`.

As contagens conferidas entre origem e restauração foram idênticas:

| Conjunto | Registros |
|---|---:|
| Empresas | 1 |
| Lojas | 11 |
| Usuários | 1 |
| Vendas | 149 |
| Pagamentos | 149 |
| Sessões de caixa | 13 |
| Movimentos de estoque | 318 |
| Eventos de auditoria | 18 |
| Migrations | 14 |

O ciclo de dump, criação do banco e restauração terminou sem erro. A etapa de restauração levou aproximadamente 18 segundos neste volume. Depois da conferência, o banco temporário e o dump interno foram removidos.

## Procedimento de emergência

1. Impedir novas gravações se houver suspeita de corrupção.
2. Preservar o estado atual com backup manual.
3. Definir o ponto desejado e restaurar em serviço/banco separado.
4. Comparar migrations, contagens e registros recentes de vendas, pagamentos, caixas, estoque e auditoria.
5. Confirmar que `JCS_FIELD_ENCRYPTION_KEY` está disponível antes de liberar dados pessoais.
6. Fazer a troca da conexão somente após aceite técnico e operacional.
7. Registrar horários, responsável, origem do backup e resultado.

## Pendências

- Confirmar a primeira cobertura efetiva do PITR e a saúde do arquivador após o backup-base.
- Criar dump lógico criptografado e armazenado fora do mesmo projeto Railway.
- Guardar uma cópia controlada da chave de criptografia em cofre separado e testar sua recuperação sem revelar o valor.
- Automatizar alerta quando agenda, backup ou arquivamento falhar.
