-- Saved posts ("Save" on a feed post). They used to be written straight to the Supabase table mw_saves, where a
-- missing row-level security policy refused every insert. Saves now go through the site API, which checks the
-- signed-in Supabase session and writes here, so they no longer depend on that policy.
CREATE TABLE IF NOT EXISTS "mw_post_saves" (
	"user_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mw_post_saves_pkey" PRIMARY KEY ("user_id", "post_id")
);
CREATE INDEX IF NOT EXISTS "mw_post_saves_user_recent" ON "mw_post_saves" ("user_id", "created_at" DESC);
