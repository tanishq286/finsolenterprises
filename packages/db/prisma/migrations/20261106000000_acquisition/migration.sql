-- Nationwide acquisition: source register, discovered documents, a durable
-- job queue, dividend events kept apart from shareholding snapshots,
-- auditable verification states and assisted traces. Additive only.

-- ── 1. Source register: one row per issuer (current or historical) ──────
CREATE TABLE "source_register" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- Stable key: ISIN when known, else "NSE:<symbol>", "BSE:<code>" or "CIN:<cin>".
    "company_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT '{}',
    "isin" TEXT,
    "nse_symbol" TEXT,
    "bse_code" TEXT,
    "cin" TEXT,
    "listing_status" TEXT NOT NULL DEFAULT 'LISTED', -- LISTED | SUSPENDED | DELISTED | MERGED | UNKNOWN
    "company_id" UUID,
    "website" TEXT,
    -- Where the website came from, e.g. "wikidata:Q123 (P856)" or "manual".
    "website_basis" TEXT,
    "ir_url" TEXT,
    "ir_url_basis" TEXT,
    "registrar" TEXT,
    "registrar_contact_url" TEXT,
    -- PUBLIC_STATUTORY_DISCLOSURE | LOOKUP_ONLY | AGREEMENT_REQUIRED | NOT_PUBLISHED | UNKNOWN
    "access_method" TEXT NOT NULL DEFAULT 'UNKNOWN',
    -- AVAILABLE | UNCERTAIN | RESTRICTED | REQUIRES_AGREEMENT | NOT_FOUND | NOT_ATTEMPTED
    "bulk_access" TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "permitted_use_note" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),
    -- OK | NO_WEBSITE | ROBOTS_DISALLOWED | BLOCKED_403 | HTTP_ERROR | NO_IR_PAGE | NO_DOCUMENTS | SCRIPT_RENDERED | ERROR
    "last_result" TEXT,
    "last_result_detail" TEXT,
    "next_review_at" TIMESTAMPTZ(6),
    "documents_found" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_register_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "source_register_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "source_register_key" ON "source_register" ("company_key");
CREATE INDEX "source_register_review_idx" ON "source_register" ("next_review_at");
CREATE INDEX "source_register_result_idx" ON "source_register" ("last_result");

-- ── 2. Documents found on issuer pages ──────────────────────────────────
CREATE TABLE "register_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "found_on" TEXT,
    -- UNCLAIMED_DIVIDEND_LIST | IEPF_PROPOSED_TRANSFER | IEPF_TRANSFERRED | SUSPENSE_DISCLOSURE
    -- | NOTICE | PROCEDURE | OTHER
    "doc_class" TEXT NOT NULL DEFAULT 'OTHER',
    "period_hint" TEXT,
    -- DISCOVERED | DOWNLOADED | NOT_HOLDER_DATA | OCR_REQUIRED | PARSE_FAILED | IMPORTED | FETCH_FAILED | SKIPPED
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "status_detail" TEXT,
    "http_last_modified" TEXT,
    "http_etag" TEXT,
    "sha256" TEXT,
    "bytes" INTEGER,
    "content_type" TEXT,
    "storage_path" TEXT,
    "source_document_id" UUID,
    "fetch_attempts" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetched_at" TIMESTAMPTZ(6),
    -- A new checksum at the same URL: the earlier version is kept, linked here.
    "previous_sha256" TEXT,
    CONSTRAINT "register_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "register_documents_register_fkey" FOREIGN KEY ("register_id") REFERENCES "source_register"("id") ON DELETE RESTRICT,
    CONSTRAINT "register_documents_source_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "register_documents_url_key" ON "register_documents" ("register_id", "url");
CREATE INDEX "register_documents_status_idx" ON "register_documents" ("status");

-- ── 3. Durable acquisition queue (SELECT … FOR UPDATE SKIP LOCKED) ───────
CREATE TABLE "acquisition_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL, -- DISCOVER | FETCH | PARSE
    "target_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | RUNNING | DONE | FAILED | DEAD
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "checkpoint" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "acquisition_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "acquisition_jobs_open_key" ON "acquisition_jobs" ("kind", "target_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE INDEX "acquisition_jobs_ready_idx" ON "acquisition_jobs" ("status", "run_after");

-- ── 4. Dividend events, separate from shareholdings ─────────────────────
-- One unclaimed amount for one holder line, for one declared dividend. The
-- same event republished in a later statement is one row with more sources;
-- different years are different rows. Corrections supersede, never delete.
CREATE TABLE "holder_dividend_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "folio_number_hash" TEXT NOT NULL,
    "holder_name_norm" TEXT NOT NULL,
    -- The event date as printed, else the financial year, else "undated".
    "event_key" TEXT NOT NULL,
    "amount" DECIMAL(14, 2) NOT NULL,
    "investment_type" TEXT,
    "source_document_ids" UUID[] NOT NULL DEFAULT '{}',
    "source_row_ids" UUID[] NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_by_id" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    CONSTRAINT "holder_dividend_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "holder_dividend_events_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "holder_dividend_events_key" ON "holder_dividend_events"
  ("company_id", "folio_number_hash", "holder_name_norm", "event_key", "amount");
CREATE INDEX "holder_dividend_events_company_idx" ON "holder_dividend_events" ("company_id", "event_key");

-- A share quantity as one statement reports it on one date: proposed for
-- IEPF transfer, transferred to IEPF, or held in a suspense account.
CREATE TABLE "shareholding_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "folio_number_hash" TEXT NOT NULL,
    "holder_name_norm" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    -- PROPOSED_IEPF_TRANSFER | TRANSFERRED_TO_IEPF | SUSPENSE_ACCOUNT
    "basis" TEXT NOT NULL,
    "as_of" DATE,
    "source_document_id" UUID NOT NULL,
    "source_row_id" UUID,
    "superseded_by_id" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shareholding_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shareholding_snapshots_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT,
    CONSTRAINT "shareholding_snapshots_source_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE RESTRICT,
    CONSTRAINT "shareholding_snapshots_basis_known" CHECK ("basis" IN ('PROPOSED_IEPF_TRANSFER','TRANSFERRED_TO_IEPF','SUSPENSE_ACCOUNT'))
);
CREATE UNIQUE INDEX "shareholding_snapshots_key" ON "shareholding_snapshots"
  ("company_id", "folio_number_hash", "holder_name_norm", "basis", "source_document_id");

-- ── 5. Verification states: append-only evidence, never a generic badge ─
CREATE TABLE "record_verifications" (
    "id" BIGSERIAL NOT NULL,
    "entity_type" TEXT NOT NULL, -- FOLIO | DIVIDEND_EVENT | SNAPSHOT | SOURCE_DOCUMENT | CLAIM
    "entity_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "reviewer_id" UUID,
    "verified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "record_verifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "record_verifications_state_known" CHECK ("state" IN (
      'OFFICIAL_SOURCE_LOCATED','EXTRACTION_VALIDATED','HISTORICAL_LISTING',
      'CURRENT_STATUS_NOT_CONFIRMED','CURRENT_STATUS_CONFIRMED','CLAIMANT_RELATIONSHIP_VERIFIED',
      'SUPERSEDED','DISPUTED','HELD_FOR_REVIEW'))
);
CREATE INDEX "record_verifications_entity_idx" ON "record_verifications" ("entity_type", "entity_id", "verified_at" DESC);
CREATE FUNCTION record_verifications_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'record_verifications is append-only';
END $$;
CREATE TRIGGER record_verifications_append_only BEFORE UPDATE OR DELETE ON record_verifications
  FOR EACH ROW EXECUTE FUNCTION record_verifications_append_only();

-- ── 6. Assisted traces for searches with no match ───────────────────────
CREATE TABLE "trace_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "user_id" UUID,
    "holder_name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    -- Contact and optional identifiers (father/spouse, old city or PIN, companies, years), AES-GCM.
    "details_enc" TEXT NOT NULL,
    "consent_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | NEEDS_DETAILS | IN_PROGRESS | CLOSED_FOUND | CLOSED_NOT_FOUND | WITHDRAWN
    "index_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trace_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trace_requests_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "trace_requests_reference_key" ON "trace_requests" ("reference");

-- Each authorised source checked for a trace, and what it said.
CREATE TABLE "trace_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trace_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "authorisation" TEXT NOT NULL,
    "outcome" TEXT NOT NULL, -- MATCH_FOUND | NO_MATCH | NEEDS_MORE_DETAILS | NOT_AVAILABLE
    "note" TEXT,
    "checked_by_id" UUID,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trace_checks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trace_checks_trace_fkey" FOREIGN KEY ("trace_id") REFERENCES "trace_requests"("id") ON DELETE RESTRICT
);
CREATE INDEX "trace_checks_trace_idx" ON "trace_checks" ("trace_id", "checked_at");

