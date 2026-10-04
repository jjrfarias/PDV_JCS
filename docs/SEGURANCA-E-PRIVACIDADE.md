# Política simplificada de segurança e privacidade

Versão 1.0 — 4 de outubro de 2026

## Escopo e responsabilidades

Esta política cobre o PDV JCS, seus bancos de dados, implantação, contas administrativas, suporte e fornecedores. A empresa cliente controla os dados inseridos na operação da loja. A Jordão Consultoria e Soluções opera esses dados conforme contrato e controla os dados necessários à contratação, suporte e segurança da própria plataforma.

Antes da expansão comercial, o contrato deve identificar razão social, CNPJ, endereço, canal de privacidade, responsáveis, fornecedores e eventual transferência internacional. Mudanças de fornecedor ou finalidade exigem revisão deste documento e do aviso público.

## Controles obrigatórios

- Acesso individual; é proibido compartilhar contas.
- Menor privilégio por perfil, empresa e loja. Acesso de suporte a dados operacionais não existe por padrão.
- Senha forte, sessão limitada e encerramento de acessos ao desligar uma pessoa.
- MFA TOTP está disponível para administradores da plataforma e gerentes e deve ser ativado nas contas privilegiadas.
- Segredos ficam somente no cofre da plataforma, nunca no Git, em mensagens ou arquivos de demonstração.
- Produção usa HTTPS, PostgreSQL com RLS e usuário runtime sem superusuário, `BYPASSRLS` ou propriedade das tabelas.
- Dados pessoais opcionais de clientes permanecem criptografados. A chave deve ter cópia segura e acesso restrito.
- Logs não devem conter senha, cookie, token de sessão, token de recuperação ou conteúdo completo de campos pessoais.
- Dependências e imagens de execução devem ser atualizadas após avaliação e teste.
- Exportações devem ser acessíveis apenas a pessoas autorizadas e armazenadas em local controlado.

## Inventário e minimização

O responsável pelo produto deve manter registro das categorias tratadas, finalidade, base legal definida pelo controlador, origem, compartilhamentos, prazo de retenção e medida de segurança. Campos opcionais de clientes só devem ser preenchidos quando houver finalidade operacional informada.

## Retenção e descarte

| Categoria | Regra operacional inicial |
|---|---|
| Sessões | Expiram automaticamente; sessões antigas devem ser removidas por rotina de manutenção. |
| Registros de acesso (`access_events`) | Login, falha de login e logout com IP e horário, exigidos pelo Marco Civil por no mínimo 6 meses. A aplicação só insere e lê; o descarte após o prazo definido pelo controlador é feito com conexão administrativa. |
| Tokens de recuperação e convite | Uso único; registros expirados podem ser removidos após o período necessário à auditoria. |
| Usuários e permissões | Durante o vínculo e pelo prazo necessário para auditoria e defesa de direitos; desativar imediatamente no desligamento. |
| Clientes | Enquanto houver finalidade válida; depois, eliminar ou anonimizar os campos pessoais opcionais. |
| Vendas, caixa, pagamentos e estoque | Conforme obrigações fiscais, contábeis, contratuais e de defesa de direitos definidas pelo controlador e sua assessoria. |
| Auditoria e incidentes | Conforme finalidade de segurança; incidentes com dados pessoais devem ter registro preservado por pelo menos cinco anos. |
| Backups | Prazo documentado na política de backup; eliminação segura ao vencer. |

Nenhum prazo fiscal ou contábil deve ser inventado pelo software. A empresa cliente deve definir esses prazos com sua assessoria. Quando uma venda precisar ser preservada, os dados opcionais do cliente devem ser desvinculados ou anonimizados quando juridicamente possível.

## Minimização na tela

Listas de clientes mostram nome, documento e telefone com os quatro últimos dígitos e e-mail mascarado. Observações não saem na lista. O cadastro completo só é carregado ao abrir a edição, para usuário com acesso à loja, e cada consulta gera `CUSTOMER_VIEWED` na auditoria.

## Direitos dos titulares

Solicitações devem receber protocolo, verificação proporcional de identidade, responsável e registro da decisão. O fluxo deve permitir localizar, corrigir, exportar, bloquear, anonimizar ou eliminar dados quando aplicável, sem alterar livros financeiros imutáveis. Consumidores procuram a empresa onde compraram; pedidos recebidos pela JCS devem ser encaminhados ao controlador sem demora.

## Fornecedores e mudanças

Antes de contratar hospedagem, e-mail, observabilidade ou suporte, registrar dados acessados, localização, suboperadores, retenção, controles, notificação de incidentes e condições de encerramento. Nova coleta, analytics, publicidade ou integração financeira exige avaliação de privacidade antes da implantação.

## Verificação periódica

Trimestralmente: revisar usuários privilegiados, dependências, fornecedores, alertas, tentativas de login e restauração de backup. Anualmente: revisar esta política, o aviso público, o inventário de tratamento e a necessidade de relatório de impacto. Registrar data, responsável, achados e correções.

## Pendências para liberação comercial ampliada

1. Procedimento seguro de recuperação do MFA quando o administrador ou gerente perde o autenticador. Administradores e gerentes já dispõem de MFA TOTP.
2. Backup criptografado com restauração homologada e evidência periódica.
3. Executar e registrar periodicamente a rotação versionada já implementada, conforme o procedimento operacional.
4. Rate limit compartilhado entre instâncias. O IP real já vem do cabeçalho `X-Real-IP` da borda da Railway, aceito só em produção na Railway; o contador ainda é em memória e reinicia a cada deploy.
5. Alertas de segurança. Exportações de relatórios já registram usuário, loja, período e seção na auditoria.
6. Dados jurídicos e canal formal de privacidade no aviso e nos contratos.
7. Validação jurídica das bases legais, prazos e cláusulas controlador-operador.
