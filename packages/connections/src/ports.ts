/**
 * What `@harbour/connections` needs from the deployment, as small ports so each target (and each test) supplies its
 * own: where secrets are kept (the vault), how it reaches the network, and the deployment's public origin and
 * pre-registered OAuth clients.
 */
import type { Actor, ConnectionOwner, ConnectionSessionScope, OrganisationId } from "@harbour/contracts";

/** Who a stored secret belongs to: a connection's owner, or the deployment for a platform OAuth client's secret. */
export type SecretOwner = ConnectionOwner | { readonly kind: "platform" };

/**
 * Where connection secrets live: access tokens, refresh tokens, keys and OAuth client secrets. Write-only from the
 * API's side: values go in, and only `open` takes one out, for one request to one of the secret's hosts.
 * `vaultCredentials` (vault-store.ts) keeps them in the Harbour vault; `memoryCredentials` (testing.ts) in memory.
 */
export interface CredentialStore {
	/** Stores a new secret, bound to `hosts` (exact, lower-case host names). Resolves an opaque reference. */
	put(input: {
		readonly owner: SecretOwner;
		readonly name: string;
		readonly hosts: readonly string[];
		readonly value: string;
		/** Who it is stored for, for the vault's audit record. */
		readonly createdBy: Actor;
	}): Promise<string>;
	/** Replaces a stored secret's value in place: a refreshed token or a rotated key. */
	replace(ref: string, value: string): Promise<void>;
	/**
	 * Opens a secret for one request to `host`, which must be one of its hosts. `scope` is the session it is for, if
	 * any (absent for Harbour's own token exchanges and refreshes). Recorded as a vault use; refused with `refused` when
	 * the host is not bound or the session is blocked or ended.
	 */
	open(input: {
		readonly ref: string;
		readonly host: string;
		readonly organisationId: OrganisationId;
		readonly scope?: ConnectionSessionScope;
		/** Why, for the record, such as `connection conn_1: tools/call`. */
		readonly purpose: string;
	}): Promise<string>;
	/** Deletes a secret. Removing one already gone is not an error. */
	remove(ref: string): Promise<void>;
}

/** A pre-registered OAuth client the deployment supplies from its configuration (the `platform` tier). */
export interface PlatformOAuthClient {
	/** The template it is for, such as `github`, or an authorisation server's issuer for one with no template. */
	readonly templateId?: string;
	readonly issuer?: string;
	readonly clientId: string;
	/** The client secret, if it is a confidential client. Kept in the credential store on first use, never returned. */
	readonly clientSecret?: string;
	readonly scopes?: readonly string[];
	readonly label?: string;
}

/** What the deployment tells the connections service about itself. */
export interface ConnectionsDeployment {
	/**
	 * The public origin people reach Harbour at, such as `https://harbour.example.com`, with no trailing slash. Redirect
	 * URIs, connect URLs and the client ID metadata document's URL are built from it.
	 */
	readonly origin: string;
	/**
	 * Whether `GET {origin}/v1/connections/oauth/client-metadata.json` is reachable without signing in (on Cloudflare,
	 * a Cloudflare Access Bypass policy on that path). Only then is CIMD offered to authorisation servers.
	 */
	readonly clientMetadataPublic: boolean;
	/** The deployment's pre-registered OAuth clients. */
	readonly platformClients?: readonly PlatformOAuthClient[];
	/** The name shown on consent screens. Default `Harbour`. */
	readonly clientName?: string;
}

/**
 * How the service reaches the network: MCP discovery, client registration, token exchanges and the session's
 * requests. Never follows redirects on its own (`redirect: "manual"` is set by callers).
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
