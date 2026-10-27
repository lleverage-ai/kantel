-- Harbour's `Workspaces` contract over Postgres + MinIO (PostgresWorkspaces in
-- src/workspaces.ts). Idempotent. Prefixed `ws_` so they stay apart from the
-- spike's harbour.workspaces / harbour.workspace_versions.
--
-- File bodies are content-addressed blobs in MinIO and each version's tree is
-- an immutable JSON object there; Postgres holds the record and the head, and
-- a commit moves the head with a compare-and-set on `head`.

CREATE SCHEMA IF NOT EXISTS harbour;

CREATE TABLE IF NOT EXISTS harbour.ws_records (
	id               text PRIMARY KEY,
	organisation_id  text NOT NULL,
	owner            jsonb NOT NULL,
	session_id       text,
	head             integer NOT NULL,
	-- Pinned mounts, in creation order; `remount` replaces one in place.
	mounts           jsonb NOT NULL DEFAULT '[]'::jsonb,
	seed             jsonb,
	seed_readiness   text NOT NULL,
	-- Epoch milliseconds from the injected clock, not the database's.
	created_at       bigint NOT NULL,
	updated_at       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ws_records_by_organisation ON harbour.ws_records (organisation_id, id);

CREATE TABLE IF NOT EXISTS harbour.ws_versions (
	workspace_id  text NOT NULL REFERENCES harbour.ws_records (id),
	version       integer NOT NULL,
	at            bigint NOT NULL,
	actor         jsonb NOT NULL,
	changed       jsonb NOT NULL,
	message       text,
	-- The MinIO key of this version's tree; NULL for the empty tree (version 0).
	tree_key      text,
	PRIMARY KEY (workspace_id, version)
);
