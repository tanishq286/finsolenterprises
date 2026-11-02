/**
 * What counts as recoverable value in a holder record.
 *
 * Companies publish two kinds of rows. Share rows list shares that went to the
 * IEPF Authority, are due to go there, or sit in the company's unclaimed
 * suspense account: those shares themselves are unclaimed. Dividend rows list
 * an unpaid dividend, often with the shares it was paid on; the holder still
 * owns those shares, so only the dividend amount is unclaimed.
 *
 * A row's share value counts only when it is a share row in one of those three
 * custodies. Everything else contributes its listed amount and nothing more.
 * RECOVERABLE_SHARES_SQL is the same rule for queries over unclaimed_folios (f).
 */
import type { CustodyStatus } from "./enums.js";

export const SHARE_VALUE_CUSTODIES: readonly CustodyStatus[] = [
  "IEPF_AUTHORITY",
  "DUE_FOR_IEPF_TRANSFER",
  "COMPANY_SUSPENSE",
];

const DIVIDEND_LISTING = /dividend|amount|refund/i;

/** True when the investment type describes a dividend or another cash amount. */
export function isDividendListing(investmentType: string | null | undefined): boolean {
  return DIVIDEND_LISTING.test(investmentType ?? "");
}

/** Whether a record's shares count as recoverable value (see the module note). */
export function countsShareValue(r: {
  custodyStatus: string;
  investmentType: string | null | undefined;
  shares: number;
}): boolean {
  return (
    r.shares > 0 &&
    (SHARE_VALUE_CUSTODIES as readonly string[]).includes(r.custodyStatus) &&
    !isDividendListing(r.investmentType)
  );
}

/** SQL form of countsShareValue for rows aliased f. Keep the two in step. */
export const RECOVERABLE_SHARES_SQL = `(f.post_action_shares > 0
  AND f.custody_status::text IN ('IEPF_AUTHORITY', 'DUE_FOR_IEPF_TRANSFER', 'COMPANY_SUSPENSE')
  AND coalesce(f.investment_type, '') !~* '(dividend|amount|refund)')`;
