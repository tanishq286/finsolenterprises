-- Intake without a sign-in code. While SMS delivery is unavailable a visitor
-- can still download a Valuation Dossier, request a Deeper Trace or ask for a
-- verification call. Their contact details are kept as given, never treated as
-- verified: the rows say PENDING_CALL_VERIFICATION until an analyst confirms the
-- number by phone. Additive only: new nullable or defaulted columns, and two
-- lead fields a visitor may not have told us yet become optional.

ALTER TABLE leads_and_inquiries
  ALTER COLUMN relationship_to_holder DROP NOT NULL,
  ALTER COLUMN physical_cert_status DROP NOT NULL,
  ADD COLUMN intake_source TEXT,
  ADD CONSTRAINT leads_intake_source_known
    CHECK (intake_source IS NULL OR intake_source IN ('VALUATION_DOSSIER', 'DEEPER_TRACE', 'CALLBACK_REQUEST'));

ALTER TABLE valuation_reports
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN contact_verification TEXT NOT NULL DEFAULT 'LOGIN_OTP',
  ADD COLUMN lead_id UUID REFERENCES leads_and_inquiries (id) ON DELETE SET NULL,
  ADD CONSTRAINT valuation_reports_contact_verification_known
    CHECK (contact_verification IN ('LOGIN_OTP', 'PENDING_CALL_VERIFICATION', 'CALL_VERIFIED')),
  -- A report has an account or a lead behind it.
  ADD CONSTRAINT valuation_reports_owner_known CHECK (user_id IS NOT NULL OR lead_id IS NOT NULL);

ALTER TABLE trace_requests
  ADD COLUMN contact_verification TEXT NOT NULL DEFAULT 'LOGIN_OTP',
  ADD COLUMN lead_id UUID REFERENCES leads_and_inquiries (id) ON DELETE SET NULL,
  ADD CONSTRAINT trace_requests_contact_verification_known
    CHECK (contact_verification IN ('LOGIN_OTP', 'PENDING_CALL_VERIFICATION', 'CALL_VERIFIED'));

CREATE INDEX leads_and_inquiries_intake_idx ON leads_and_inquiries (intake_source, created_at DESC)
  WHERE intake_source IS NOT NULL;
