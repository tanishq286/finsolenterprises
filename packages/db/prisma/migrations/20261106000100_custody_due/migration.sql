-- Shares a company lists as due for IEPF transfer are not yet with the IEPF.
ALTER TYPE "CustodyStatus" ADD VALUE IF NOT EXISTS 'DUE_FOR_IEPF_TRANSFER';
