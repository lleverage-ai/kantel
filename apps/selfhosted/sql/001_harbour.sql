-- Harbour self-hosted control tables (M0 spike). Idempotent: every session
-- host runs this at boot under an advisory lock.
-- Pi Durable's own tables live in one schema per session (pi_<hash>), created
-- by its storage migrations through the Postgres adapter.

CREATE SCHEMA IF NOT EXISTS harbour;

-- Session directory.
CREATE TABLE IF NOT EXISTS harbour.sessions (
	id            text PRIMARY KEY,
	workspace_id  text NOT NULL,
	pi_schema     text NOT NULL,
	status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'active', 'failed')),
	-- Earliest Pi Durable sleep, so an idle host can be woken (the wake queue).
	wake_at       timestamptz,
	created_at    timestamptz NOT NULL DEFAULT now(),
	updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_by_status ON harbour.sessions (status, wake_at);

-- One live owner per session. `fence` grows on every takeover; every durable
-- write checks it inside its own transaction, so a deposed owner cannot commit.
CREATE TABLE IF NOT EXISTS harbour.session_leases (
	session_id   text PRIMARY KEY REFERENCES harbour.sessions (id),
	owner        text NOT NULL,
	owner_url    text NOT NULL,
	fence        bigint NOT NULL,
	expires_at   timestamptz NOT NULL,
	acquired_at  timestamptz NOT NULL DEFAULT now()
);

-- Workspace heads. Blobs and manifests live in MinIO; the head pointer lives
-- here so it moves under the same fence as the session's transcript.
CREATE TABLE IF NOT EXISTS harbour.workspaces (
	id          text PRIMARY KEY,
	version     text NOT NULL,
	seq         bigint NOT NULL,
	updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harbour.workspace_versions (
	workspace_id  text NOT NULL REFERENCES harbour.workspaces (id),
	seq           bigint NOT NULL,
	version       text NOT NULL,
	base          text NOT NULL,
	tier          text NOT NULL,
	changed       jsonb NOT NULL,
	session_id    text,
	fence         bigint,
	created_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, seq)
);

-- Per-sandbox tokens a container presents to the vault proxy (as proxy
-- credentials), so the vault knows which session a request is for. A token is
-- not a credential for anything else and dies with its container.
CREATE TABLE IF NOT EXISTS harbour.sandbox_tokens (
	token       text PRIMARY KEY,
	session_id  text NOT NULL,
	tier        text NOT NULL,
	expires_at  timestamptz NOT NULL
);

-- Append-only audit events: lease changes, sandbox escalations, vault decisions.
CREATE TABLE IF NOT EXISTS harbour.audit_events (
	id          bigserial PRIMARY KEY,
	at          timestamptz NOT NULL DEFAULT now(),
	session_id  text,
	actor       text NOT NULL,
	kind        text NOT NULL,
	detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_by_session ON harbour.audit_events (session_id, id);
