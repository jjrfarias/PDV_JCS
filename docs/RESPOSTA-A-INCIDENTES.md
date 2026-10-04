# Plano de resposta a incidentes

Versão 1.0 — 4 de outubro de 2026

## Acionamento

Qualquer suspeita de conta comprometida, acesso indevido, vazamento, perda, alteração, indisponibilidade relevante ou envio incorreto de dados abre um incidente. Registrar imediatamente data, relator, sistemas, empresas possivelmente afetadas e evidências disponíveis. Não incluir senhas ou tokens no registro.

## Resposta

1. **Conter:** revogar sessões, desativar contas, bloquear a origem, preservar banco e logs, suspender integração afetada e trocar segredos comprometidos.
2. **Avaliar:** identificar dados, titulares, empresas, período, volume, causa, possibilidade de recuperação e consequências.
3. **Comunicar internamente:** responsável técnico, direção, controlador afetado e responsável por privacidade.
4. **Decidir comunicação externa:** o controlador avalia risco ou dano relevante e documenta a decisão. Quando aplicável, comunica ANPD e titulares no prazo regulamentar, com informações claras e medidas adotadas.
5. **Recuperar:** corrigir a causa, restaurar de fonte confiável, validar isolamento, integridade e fluxos críticos antes de reabrir.
6. **Revisar:** registrar causa raiz, linha do tempo, impacto, medidas e responsáveis. Acompanhar ações até conclusão.

## Evidências mínimas

- Identificador e datas do incidente.
- Quem detectou e quem coordenou.
- Categorias e quantidade aproximada de dados e titulares.
- Empresas, lojas, sistemas e fornecedores envolvidos.
- Controles que falharam e medidas de contenção.
- Avaliação de risco ou dano relevante.
- Comunicações realizadas e respectivos horários.
- Correções, testes de recuperação e aceite de encerramento.

Registros de incidentes com dados pessoais devem ser conservados por pelo menos cinco anos, inclusive quando a conclusão for pela não comunicação. O acesso ao registro fica restrito aos responsáveis técnicos, jurídicos e de privacidade.

## Preparação

- Manter contatos dos clientes e fornecedores fora do sistema afetado.
- Ter procedimento para revogar todas as sessões e rotacionar segredos.
- Manter backup criptografado e testar a restauração.
- Preparar modelos de comunicação à ANPD, ao controlador e aos titulares.
- Executar exercício simulado pelo menos uma vez por ano.

## Lacuna atual

Este repositório ainda não contém automação de backup/restauração, MFA, rotação de chave nem plataforma externa de alertas. Esses controles permanecem bloqueadores para uma expansão comercial sem piloto controlado.
