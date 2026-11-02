-- The last real quote seen for each listed equity, so the calculator can fall
-- back to it (with its timestamp) when a live fetch fails. Additive only.
ALTER TABLE "listed_equities"
  ADD COLUMN IF NOT EXISTS "last_price" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "last_price_quote_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_price_fetched_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_price_source" TEXT;
