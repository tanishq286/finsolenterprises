-- Drop redundant (company_id, folio_number_hash) index on unclaimed_folios:
-- unclaimed_folios_company_folio_holder_state_key on
-- (company_id, folio_number_hash, investor_full_name, state) already serves
-- exact (company_id, folio_number_hash) lookups via its leftmost prefix.
DROP INDEX IF EXISTS unclaimed_folios_company_folio_idx;

-- Drop any unattached non-unique (company_id, folio_number_hash) child index
-- on state partitions, leaving the unique 4-column index untouched.
DO $$
DECLARE
  idx record;
BEGIN
  FOR idx IN
    SELECT n.nspname AS schema_name, c_idx.relname AS index_name
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_inherits th ON th.inhrelid = t.oid
      JOIN pg_class c_idx ON c_idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c_idx.relnamespace
     WHERE th.inhparent = 'unclaimed_folios'::regclass
       AND NOT i.indisunique
       AND pg_get_indexdef(c_idx.oid) ~ 'USING btree \(company_id, folio_number_hash\)$'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', idx.schema_name, idx.index_name);
  END LOOP;
END $$;

-- Drop leftover one-off backup table from an earlier reprocess run.
DROP TABLE IF EXISTS backup_folios_20261105171747;
