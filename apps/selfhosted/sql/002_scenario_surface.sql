-- The shared spike scenario surface (spikes/scenario on the Cloudflare spike's branch): a
-- session can carry a scripted scenario, and every sandbox command is logged
-- with its tier, versions and timings. Idempotent.

ALTER TABLE harbour.sessions ADD COLUMN IF NOT EXISTS scenario jsonb;

CREATE TABLE IF NOT EXISTS harbour.execs (
	id          bigserial PRIMARY KEY,
	session_id  text NOT NULL,
	at          timestamptz NOT NULL DEFAULT now(),
	body        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS execs_by_session ON harbour.execs (session_id, id);
