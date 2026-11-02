# Pan-India drop folder

Statements a person has downloaded from a company's own website. Everything in this folder
except this README is ignored by git: the files hold investors' personal data.

## Manifest

Every file must be listed in `manifest.json`, with the company and where the file came from.
A file without a source is not imported.

```json
[
  {
    "file": "ENGINERSIN__IEPF-2_as-on-2025-03-31.xlsx",
    "company": "ENGINERSIN",
    "sourceUrl": "https://engineersindia.com/…/169d201a….xlsx",
    "retrievedAt": "2026-11-02",
    "reportingPeriod": "IEPF-2 statement as on 31.03.2025"
  }
]
```

- `company`: NSE symbol, ISIN or CIN. A listed company not yet in the catalogue is added from
  NSE's equity list (name, ISIN, symbol only; contacts stay empty until a person verifies them).
- `shareBasis` (share lists only): `PROPOSED_IEPF_TRANSFER` or `TRANSFERRED_TO_IEPF`.

## Run

```sh
npm run build -w @finsol/db && npm run build -w @finsol/worker
npm run ingest:pan-india -- files --dry-run          # validate, write nothing
npm run ingest:pan-india -- files                    # import (DATABASE_URL, default local dev)
npm run ingest:pan-india -- rollback <batchRunId>    # undo one file's batch
npm run ingest:pan-india -- discover --rta kfintech,link_intime,priority [--enqueue]
```

A non-local `DATABASE_URL` is refused unless `--confirm-production` is passed.

- `.xlsx`/`.xlsm` and `.csv` stream in chunks (ExcelJS streaming reader, csv-parse). Postgres
  groups each holder's lines, so memory depends on the chunk size, not the file size.
- Legacy `.xls` is read whole (a BIFF sheet holds at most 65,536 rows). PDFs use the PDF table
  reader.
- Each file is one batch: an ingestion job whose id is on every holder record it writes, plus
  a source document (checksum, URL, retrieval date) and an encrypted source row per line. A file
  already imported is skipped. Rollback deletes only records the batch created; records it
  merged into are kept and counted for review.
- Registrar adapters (KFin Technologies, MUFG Intime) select issuers from the source register.
  The registrars' portals are per-holder CAPTCHA lookups and are never queried; statements
  come from each issuer's own website through the acquisition worker (robots.txt honoured,
  401/403/429 recorded, never bypassed).

## Measured (2 November 2026, local Postgres, aggregate counts only)

| File | Rows | Holder records | Peak RSS | Time |
| --- | --- | --- | --- | --- |
| Engineers India IEPF-2 as on 31.03.2025 (.xlsx, 12.7 MB) | 106,645 | 18,509 new | 410 MB with a 512 MB heap cap | 12.6 s |
| Action Construction Equipment IEPF-2 as on 31.03.2021 (.xls) | 10,531 | 6,157 new | ≈1.05 GB* | 7.2 s |
| JK Lakshmi Cement IEPF-2 2024-25 (.xlsx) | 8,681 | 8,681 new | ≈1.05 GB* | 6.5 s |
| BPCL unpaid 1st interim dividend 2021-22 (.xls) | 17,772 | 17,772 merged into existing | ≈1.07 GB* | 21.8 s |
| Lumax Industries IEPF-2 2013-14 (.pdf) | 4,084 | 0 (all held for review: amounts ambiguous in the PDF) | ≈1.1 GB* | 1.8 s |
| Generated 1.5 GB CSV, dry run, 256 MB heap cap | 9,181,888 | none (no writes) | 315 MB, flat | 59 s |

\* First run, before provenance rows moved from Prisma `createMany` to plain SQL; the heap was
uncapped and V8 collected lazily. The Engineers India re-run after that change is the bounded
figure. RSS includes about 300 MB of process baseline (Prisma, pdf.js).
