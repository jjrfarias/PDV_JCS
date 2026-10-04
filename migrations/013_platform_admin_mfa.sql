ALTER TABLE platform_admins ADD COLUMN mfa_secret_enc TEXT;
ALTER TABLE platform_admins ADD COLUMN mfa_pending_secret_enc TEXT;
ALTER TABLE platform_admins ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1));
