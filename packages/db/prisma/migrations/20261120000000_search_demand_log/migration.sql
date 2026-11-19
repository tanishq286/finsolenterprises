-- Zero-result searches, kept to decide which companies to ingest next.
-- Holds no holder names and no folio numbers: name_hash is a truncated keyed
-- HMAC (key derived from FOLIO_HASH_KEY, label "search-demand-v1"), so it can
-- count repeat searchers but cannot be joined to unclaimed_folios.folio_number_hash.
-- Pruned daily to 90 days and at most 75,000 rows (about 9 MB).
CREATE TABLE search_demand_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  search_mode   text NOT NULL CHECK (search_mode IN ('name', 'company_folio')),
  company_query text CHECK (char_length(company_query) <= 80),
  company_known boolean NOT NULL DEFAULT false,
  state         "IndianState",
  name_hash     bytea NOT NULL CHECK (octet_length(name_hash) = 16),
  result_count  smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Rows arrive in time order, so BRIN covers range scans in a few KB.
CREATE INDEX search_demand_log_created_brin ON search_demand_log USING brin (created_at);

-- Deliberately no grant to finsol_app_client: only the API's own role reads it.
