-- One-time customer redemption codes for manually verified mobile-money top-ups.
ALTER TABLE "mw_coin_topups" ADD COLUMN IF NOT EXISTS "verification_code" text;
ALTER TABLE "mw_coin_topups" ADD COLUMN IF NOT EXISTS "code_redeemed_at" timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS "mw_coin_topups_verification_code_unique" ON "mw_coin_topups" ("verification_code") WHERE "verification_code" IS NOT NULL;
