-- Optional shareholder PAN from Deeper Trace intake, for analysts' manual verification.
-- AES-256-GCM ciphertext via encryptField (same key as folios); never plaintext.
-- Nullable without a default: a metadata-only change, no table rewrite.
ALTER TABLE trace_requests ADD COLUMN holder_pan_enc text;
ALTER TABLE trace_requests ADD CONSTRAINT trace_requests_holder_pan_enc_ciphertext
  CHECK (holder_pan_enc IS NULL OR holder_pan_enc LIKE 'v1:%');
-- No grant to finsol_app_client: that role has no privilege on trace_requests.
