-- Verification by phone call, while sign-in codes cannot be texted.
-- An analyst who has called a visitor back and confirmed the number records
-- it on the lead (who and when); that lead's Dossiers and Deeper Traces then
-- read CALL_VERIFIED. During the same call the analyst may issue a one-time
-- sign-in code and read it out: issued_by marks such a challenge, which is
-- the only kind the site accepts while SMS delivery is unavailable.
-- Additive only: new nullable columns.

ALTER TABLE leads_and_inquiries
  ADD COLUMN call_verified_at TIMESTAMPTZ(6),
  ADD COLUMN call_verified_by UUID REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE otp_challenges
  ADD COLUMN issued_by UUID REFERENCES users (id) ON DELETE SET NULL;
