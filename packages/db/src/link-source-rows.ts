import type { PrismaClient } from "./generated/prisma/client.js";

/** Rows per UPDATE; keeps each statement's parameter arrays small. */
const LINK_BATCH = 10_000;

/**
 * Links each source row of a document to the holder record it fed (folio ids
 * exist only after the merge).
 *
 * Two steps on purpose. One UPDATE … FROM a join of source_rows and
 * unclaimed_folios is planned inside the import's transaction, before any
 * statistics cover the rows it just wrote: Postgres then expects about one
 * source row, drives the loop from source_rows and rescans every folio
 * partition per row (minutes per 7,000-row statement, ~4 billion row checks).
 * Reading the (row → record) pairs first and updating by primary key gives
 * the planner nothing else to drive from, so each row is one key lookup.
 */
export async function linkSourceRows(
  db: Pick<PrismaClient, "$queryRaw" | "$executeRaw">,
  documentId: string,
): Promise<number> {
  const pairs = await db.$queryRaw<{ row_id: string; id: string; state: string }[]>`
    SELECT unnest(f.source_row_ids)::text AS row_id, f.id::text AS id, f.state::text AS state
      FROM unclaimed_folios f
     WHERE f.source_document_id = ${documentId}::uuid`;
  let linked = 0;
  for (let k = 0; k < pairs.length; k += LINK_BATCH) {
    const batch = pairs.slice(k, k + LINK_BATCH);
    linked += await db.$executeRaw`
      UPDATE source_rows r SET folio_id = x.id, folio_state = x.state::"IndianState"
        FROM unnest(${batch.map((p) => p.row_id)}::uuid[],
                    ${batch.map((p) => p.id)}::uuid[],
                    ${batch.map((p) => p.state)}::text[]) AS x(row_id, id, state)
       WHERE r.id = x.row_id
         AND r.source_document_id = ${documentId}::uuid
         AND r.folio_id IS NULL`;
  }
  return linked;
}
