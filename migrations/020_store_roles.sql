-- Perfil por loja: cada vínculo pessoa-loja tem o seu perfil e o seu acesso.
-- users.role passa a ser o resumo da conta (MANAGER se gerente em alguma loja), usado para exigir MFA.
-- O vínculo não é apagado: vendas, caixas e auditoria apontam para ele. Remover acesso = active 0.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'CASHIER' CHECK (role IN ('MANAGER','CASHIER'));
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1));
UPDATE memberships m SET role = u.role FROM users u WHERE u.tenant_id = m.tenant_id AND u.id = m.user_id;
