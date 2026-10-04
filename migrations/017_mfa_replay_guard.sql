-- Último intervalo TOTP aceito por conta: um código de 6 dígitos só vale uma vez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS mfa_last_step bigint;
