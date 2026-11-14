-- Allow fractional top-ups (0.1 coin = TZS 100) while preserving existing top-up records.
ALTER TABLE "mw_coin_topups" ALTER COLUMN "coins" TYPE numeric(14,1) USING "coins"::numeric(14,1);
