-- Where an issuer's registrar (RTA) was read, e.g. "named on https://… (read 2026-11-02)". Additive only.
ALTER TABLE "source_register" ADD COLUMN IF NOT EXISTS "registrar_basis" TEXT;
