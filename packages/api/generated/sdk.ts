// Kantel's public API: the TypeScript SDK. Generated from packages/api/src/routes.ts by
// `pnpm --filter @kantel/api generate`; don't edit it by hand. CI fails while it is stale.

// Types

export interface AbortSessionBody {
	/** Recorded in the audit trail. */
	readonly reason?: string;
}

export type AccessKind = "read" | "write";

export interface AccessRequest {
	/** The request's ID. */
	readonly id: string;
	/** The organisation. */
	readonly organisationId: string;
	/** A resource, optionally at one revision. */
	readonly resource: ResourceSelector;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** Who a share is for: a project (its sessions, and its people within their role), an agent profile, a person, or one session (what a supervisor passes on). */
	readonly grantee: ShareGrantee;
	/** Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on. */
	readonly permission: SharePermission;
	readonly reason: string;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly requestedBy: Actor;
	/** The session the request came from. */
	readonly sessionId?: string;
	readonly agentId?: string;
	readonly status: AccessRequestStatus;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	readonly decision?: AccessRequestDecision;
}

export interface AccessRequestDecided {
	readonly request: AccessRequest;
	readonly share?: ResourceShare;
}

export interface AccessRequestDecision {
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly decidedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly decidedAt: number;
	readonly note?: string;
	/** The share a grant created. */
	readonly shareId?: string;
}

export interface AccessRequestPage {
	readonly items: readonly AccessRequest[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export type AccessRequestStatus = "pending" | "granted" | "rejected" | "withdrawn";

/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
export type Actor =
	| {
			readonly kind: "human";
			readonly userId: string;
	  }
	| {
			readonly kind: "service";
			readonly serviceId: string;
			readonly keyId?: string;
	  }
	| {
			readonly kind: "agent";
			readonly agentId: string;
			readonly sessionId: string;
	  }
	| {
			readonly kind: "system";
			readonly component: string;
	  };

export interface AssistantItem {
	readonly kind: "assistant";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly text: string;
	/** True while tokens are still arriving. */
	readonly streaming: boolean;
	readonly thinking?: string;
	/** The document the model is writing in a `create_document` call, while the answer streams. Gone once the answer is done. */
	readonly document?: DraftDocument;
}

/** How a session list groups the session: working, waiting on someone, or done. */
export type Attention = "working" | "waiting" | "done";

/** A relation tuple: `subject` has `relation` on `object`. */
export interface BindingBody {
	/** A resource, or a group (for `member`). */
	readonly object: BindingObject;
	readonly relation: BindingRelation;
	readonly subject: BindingSubject;
}

/** A resource, or a group (for `member`). */
export type BindingObject =
	| ResourceRef
	| {
			readonly kind: "group";
			readonly id: string;
	  };

export type BindingRelation = "maintainer" | "approver" | "member";

export type BindingSubject =
	| {
			readonly kind: "user";
			readonly userId: string;
	  }
	| {
			readonly kind: "service";
			readonly serviceId: string;
	  }
	| {
			readonly kind: "group";
			readonly groupId: string;
	  };

export interface BrowserEmbed {
	/** The page to frame. It holds its token after `#`, so the token reaches no server; treat the URL as a secret. */
	readonly url: string;
	readonly mode: "live" | "replay";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** What the page posts to its parent once its stream is over. */
	readonly endMessage?: string;
}

export interface BrowserGrantCard {
	readonly type: "browser.grant";
	readonly requestId: string;
	readonly reason: string;
	readonly status: "pending" | "granted" | "denied";
}

export type Card = ConnectionApprovalCard | VaultApprovalCard | QuestionCard | BrowserGrantCard;

export interface CardItem {
	readonly kind: "card";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly card: Card;
}

export interface CatalogueEntry {
	readonly id: string;
	readonly version: number;
	readonly name: string;
	readonly description: string;
	readonly icon: string;
	readonly docsUrl: string;
	readonly category: ProviderCategory;
	/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
	readonly kind: ConnectionKind;
	readonly authTypes: readonly ConnectionAuthType[];
	readonly mcpUrl?: string;
	readonly source: "shipped" | "deployment" | "organisation";
	/** `ready`: the caller can connect now. `needs_client`: it needs an OAuth app someone must register first. */
	readonly setup: "ready" | "needs_client";
	readonly clientTiers?: readonly OAuthClientTier[];
	/** How a template connects for the caller: `none` (nothing to set up), `public_client` (the deployment's client with no secret), `own_app` (an app the person or project registers), `host_client` (the deployment's or the organisation's client) or `key`. */
	readonly tier: SetupTier;
	/** For a ready OAuth connect: in a browser window, or by typing a code at the provider. */
	readonly signIn?: "browser" | "device";
	readonly scopeSets: readonly ScopeSet[];
	readonly clientGuidance?: string;
	/** The OAuth client a new connect would use. No secret. */
	readonly client?: ResolvedClientInfo;
	/** How to register an app for a template, with this deployment's values in it. */
	readonly guide?: SetupGuide;
}

export interface CataloguePage {
	readonly items: readonly CatalogueEntry[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface CheckSettings {
	/** Hours before a finding still present is raised again. Default 6. */
	readonly reraiseHours?: number;
	/** A finding whose value grows by this factor is raised again. Default 2. */
	readonly risingFactor?: number;
	/** Failed runs in a row before a `check-failed` finding is raised. Default 3. */
	readonly failuresBeforeRaise?: number;
	/** Severities, worst first, case-insensitive, for raising a finding that got worse as `escalated`. Default `urgent`, `high`, `medium`, `low`, `warn`, `info`. */
	readonly severityOrder?: readonly string[];
}

/** How Kantel gets an OAuth client: a pre-registered `client`, the deployment's client ID metadata document (`cimd`), or dynamic registration (`dcr`). */
export type ClientRegistration = "client" | "cimd" | "dcr";

export interface Concept {
	readonly spaceId: string;
	/** A stable path, such as `projects/harbour/binding-codes`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	/** Where a concept applies. A `job` concept is an exception for one job. */
	readonly scope: ConceptScope;
	/** What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs. */
	readonly sources: readonly string[];
	/** After this, recall marks it stale (epoch milliseconds). */
	readonly staleAfter?: number;
	/** A job exception's general concept. */
	readonly overrides?: string;
	/** Namespaced host data Kantel keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	readonly tags: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	/** Increases with every change. */
	readonly version: number;
	readonly status: ConceptStatus;
	readonly supersededBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface ConceptPage {
	readonly items: readonly Concept[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** Where a concept applies. A `job` concept is an exception for one job. */
export type ConceptScope =
	| {
			readonly kind: "global";
	  }
	| {
			readonly kind: "project";
			readonly project: string;
	  }
	| {
			readonly kind: "job";
			readonly job: string;
	  };

export type ConceptStatus = "active" | "superseded" | "forgotten";

/** One OAuth sign-in in progress. */
export interface ConnectAttempt {
	/** The attempt's ID. */
	readonly id: string;
	readonly organisationId: string;
	readonly status: "pending" | "completed" | "failed" | "expired";
	/** Open this to sign in. Present while pending; it expires and works once. */
	readonly connectUrl?: string;
	/** Who owns a connection: an organisation, a project or a person. */
	readonly owner: ConnectionOwner;
	readonly templateId?: string;
	readonly mcpUrl?: string;
	readonly forUserId?: string;
	/** Set once completed. */
	readonly connectionId?: string;
	readonly failure?: {
		readonly code: ConnectFailureCode;
		readonly message: string;
	};
	/** A sign-in with a code (the OAuth device flow), while pending. Each read of the attempt asks the provider, at most once per interval. */
	readonly device?: {
		/** The code the person types at `verificationUri`. */
		readonly userCode: string;
		readonly verificationUri: string;
		/** Seconds between asking after the attempt. */
		readonly interval: number;
	};
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	/** Epoch milliseconds, UTC. */
	readonly completedAt?: number;
}

export type ConnectFailureCode =
	| "user_mismatch"
	| "no_client"
	| "denied"
	| "invalid_state"
	| "exchange_failed"
	| "discovery_failed"
	| "registration_failed";

/** One authorisation against a provider or remote MCP server. No secret. */
export interface Connection {
	/** The connection's ID. */
	readonly id: string;
	readonly organisationId: string;
	/** Who owns a connection: an organisation, a project or a person. */
	readonly owner: ConnectionOwner;
	readonly name: string;
	readonly templateId?: string;
	readonly templateVersion?: number;
	/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
	readonly kind: ConnectionKind;
	readonly auth: "oauth2" | "key" | "none";
	readonly mcp?: {
		readonly url: string;
		readonly resource?: string;
	};
	/** Hosts the credential may be sent to. */
	readonly hosts: readonly string[];
	/** What a sandbox sends where the credential goes (#331). Not a secret: the egress gate swaps it for the credential, only for a session that may use the connection, only to one of its hosts. */
	readonly placeholder?: string;
	readonly account?: ConnectionAccount;
	readonly scopes: {
		readonly requested: readonly string[];
		readonly granted: readonly string[];
	};
	/** The OAuth client a connection is pinned to. */
	readonly client?: ConnectionClientRef;
	/** Where a connection may be used, by whom and in which sessions. */
	readonly usage: ConnectionUsage;
	/** For a person's connection: the projects its owner shared it with (#335). Any attended session there may use it. */
	readonly shares?: readonly ConnectionShare[];
	readonly status: ConnectionStatus;
	/** A connection's health, which Kantel sets from its token refreshes (#328), apart from its status. */
	readonly health?: ConnectionHealth;
	/** A credential's state. Never its value. */
	readonly credential: CredentialState;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface ConnectionAccount {
	readonly id?: string;
	readonly name?: string;
	readonly email?: string;
}

/** A connection request waiting on a person: a credential an agent asked to use. The secret is never part of it. */
export interface ConnectionApprovalCard {
	readonly type: "connection.approval";
	/** The connection request's ID. */
	readonly proposalId: string;
	readonly status: "pending" | "approved" | "denied" | "expired" | "withdrawn";
	readonly bindingCode: string;
	readonly what: string;
	readonly why: string;
	readonly host: string;
	readonly methods: readonly string[];
	readonly pathPrefix: string;
	readonly injectionTemplate?: string;
	readonly termsSource: "agent-proposed" | "approved";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	readonly link: string;
	/** For an approval of one exact request a rule asked about (#333). Its headers and body are on the connection request page. */
	readonly request?: ConnectionApprovalRequest;
	/** The tool call waiting on this approval: a connection call's `callId`, or for a request a `codemode` script made, the script's inner call (`<scriptCallId>/<key>`, such as `toolu_01/c9`). A client that renders that call may show the approval in it and leave this card out; one that doesn't still has the card. Absent on cards written before it. */
	readonly callId?: string;
}

/** For an approval of one exact request a rule asked about (#333). Its headers and body are on the connection request page. */
export interface ConnectionApprovalRequest {
	readonly connectionId: string;
	readonly connectionName: string;
	readonly kind: "http" | "mcp_call" | "mcp_tools";
	readonly method: string;
	/** The URL as it will be sent, query included. */
	readonly url: string;
	/** For an MCP tool call: the tool. */
	readonly tool?: string;
	/** The exact request's digest: only an identical request matches it. */
	readonly digest: string;
}

/** How a connection authenticates. */
export type ConnectionAuthType =
	| "oauth2"
	| "oauth2_client_credentials"
	| "bearer"
	| "header"
	| "query"
	| "basic"
	| "header_template"
	| "none";

/** The organisation's ceiling: no rule may allow or ask outside it. */
export interface ConnectionCeiling {
	/** `false`: the organisation has no ceiling, and nothing is bounded. */
	readonly set: boolean;
	readonly routes: readonly RouteScope[];
}

/** The OAuth client a connection is pinned to. */
export interface ConnectionClientRef {
	/** How Kantel gets an OAuth client: a pre-registered `client`, the deployment's client ID metadata document (`cimd`), or dynamic registration (`dcr`). */
	readonly via: ClientRegistration;
	readonly clientId: string;
	readonly oauthClientId?: string;
	/** The tenancy level an OAuth client belongs to; `platform` is the deployment. */
	readonly tier?: OAuthClientTier;
}

/** What the proxy does with one request, and why. */
export interface ConnectionDecision {
	/** What a rule answers. `ask` goes to an approval (#333). */
	readonly action: ConnectionRuleAction;
	/** What decided a request. */
	readonly by: ConnectionDecisionSource;
	/** One access rule on a connection. */
	readonly rule?: ConnectionRule;
	readonly reason: string;
	readonly rulesVersion: number;
}

/** What decided a request. */
export type ConnectionDecisionSource =
	| {
			readonly kind: "rule";
			readonly ruleId: string;
	  }
	| {
			readonly kind: "unmatched";
	  }
	| {
			readonly kind: "usage";
	  }
	| {
			readonly kind: "connection";
	  }
	| {
			readonly kind: "ceiling";
	  }
	| {
			readonly kind: "listing";
	  };

/** A connection's health, which Kantel sets from its token refreshes (#328), apart from its status. */
export interface ConnectionHealth {
	/** `ok`: the last refresh worked. `refresh_failing`: the last refresh failed in a way that may pass (no answer, a 5xx, a rate limit); the connection stays active and Kantel retries with backoff. `needs_reconnect`: the provider refused the refresh token; requests are refused with `connection_reconnect_required` until a person connects it again. */
	readonly state: "ok" | "refresh_failing" | "needs_reconnect";
	/** Epoch milliseconds, UTC. */
	readonly since: number;
	/** The last failure, in plain words. Never a secret. */
	readonly reason?: string;
	/** Refreshes that failed in a row. */
	readonly failures?: number;
	/** When Kantel tries again. Epoch milliseconds, UTC. */
	readonly retryAt?: number;
	/** When a refresh last worked. Epoch milliseconds, UTC. */
	readonly refreshedAt?: number;
}

/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
export type ConnectionKind = "mcp" | "http";

/** Who owns a connection: an organisation, a project or a person. */
export type ConnectionOwner =
	| {
			readonly kind: "organisation";
			readonly organisationId: string;
	  }
	| {
			readonly kind: "project";
			readonly organisationId: string;
			readonly projectId: string;
	  }
	| {
			readonly kind: "user";
			readonly organisationId: string;
			readonly userId: string;
	  };

export interface ConnectionPage {
	readonly items: readonly Connection[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** What a connection can reach at its provider (#461), read through it now: for GitHub, the app's installations and their repositories. Never a secret. */
export interface ConnectionReach {
	readonly connectionId: string;
	readonly installations: readonly ConnectionReachInstallation[];
	readonly repositories: readonly ConnectionReachRepository[];
	/** How many repositories GitHub counts in all, listed or not. */
	readonly total: number;
	/** GitHub has more than were listed (at most 300). */
	readonly truncated: boolean;
	/** Where to choose the repositories on GitHub. */
	readonly manageUrl?: string;
	/** Epoch milliseconds, UTC. */
	readonly checkedAt: number;
}

/** One installation of the GitHub App the person can reach. */
export interface ConnectionReachInstallation {
	/** GitHub's installation ID. */
	readonly id: number;
	readonly account: {
		readonly login: string;
		readonly type: "User" | "Organization";
	};
	/** `all`: every repository the account has. `selected`: only those chosen at install. */
	readonly repositorySelection: "all" | "selected";
	/** The installation's settings page on GitHub. */
	readonly manageUrl: string;
}

export interface ConnectionReachRepository {
	/** `owner/name`. */
	readonly fullName: string;
	readonly owner: string;
	readonly private: boolean;
}

/** What a disconnect did, in Kantel and at the provider. */
export interface ConnectionRemoval {
	readonly connectionId: string;
	readonly revocation: ConnectionRevocation;
	/** Standing access rules removed with it. */
	readonly rulesRemoved: number;
	/** Approvals of exact requests not yet used, withdrawn or stopped with it. */
	readonly approvalsWithdrawn: number;
}

export interface ConnectionRevocation {
	/** What a disconnect did at the provider: `revoked`, `unsupported` (the provider gives Kantel no way to revoke, or it is a key), `failed` (the provider refused or didn't answer; the connection is removed all the same) or `none` (nothing to revoke). */
	readonly outcome: RevocationOutcome;
	/** The endpoint Kantel called. Never carries a token. */
	readonly endpoint?: string;
	/** Why it is `unsupported` or `failed`, in plain words. */
	readonly reason?: string;
	/** The provider's page for removing an app's access. */
	readonly manageUrl?: string;
}

/** One access rule on a connection. */
export interface ConnectionRule {
	readonly id: string;
	readonly connectionId: string;
	/** Who a rule is for: any agent, organisation-level agents (sessions in no project), a project, an agent profile or one session. */
	readonly who: ConnectionRuleWho;
	/** What a rule covers: any request, an API endpoint by method and path pattern, or one MCP tool. */
	readonly what: ConnectionRuleWhat;
	/** What a rule answers. `ask` goes to an approval (#333). */
	readonly action: ConnectionRuleAction;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** It stops matching once `uses` reaches this. */
	readonly maxUses?: number;
	/** Requests it has allowed. */
	readonly uses: number;
	/** The template's defaults, a person, an approval's "always allow", or a migrated vault policy. */
	readonly source: "default" | "person" | "approval" | "migrated";
	/** The approval whose "always allow" saved it. */
	readonly approvalId?: string;
	readonly note?: string;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** What a rule answers. `ask` goes to an approval (#333). */
export type ConnectionRuleAction = "allow" | "ask" | "deny";

/** A connection's rules, and what a request no rule matches gets (`unmatched`). */
export interface ConnectionRules {
	readonly connectionId: string;
	readonly rules: readonly ConnectionRule[];
	/** What a rule answers. `ask` goes to an approval (#333). */
	readonly unmatched: ConnectionRuleAction;
	/** Goes up on every change to the rules, not on a use. Part of an approval's digest (#333). */
	readonly version: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt?: number;
	/** The last time Kantel set these rules to the template's defaults, and why. */
	readonly defaults?: {
		/** `created` with the connection, `migrated` from a connection made before rules (which let every request through), or `reset` by a person. */
		readonly reason: "created" | "migrated" | "reset";
		/** Epoch milliseconds, UTC. */
		readonly at: number;
	};
}

/** What a rule covers: any request, an API endpoint by method and path pattern, or one MCP tool. */
export type ConnectionRuleWhat =
	| {
			readonly kind: "any";
	  }
	| {
			readonly kind: "endpoint";
			readonly method: HttpMethod | "*";
			/** A path pattern of whole segments: `*` is one segment, a trailing `/**` any rest. */
			readonly path: string;
			/** One of the connection's hosts. Default any of them. */
			readonly host?: string;
	  }
	| {
			readonly kind: "tool";
			/** An MCP tool's exact name. */
			readonly tool: string;
	  };

/** Who a rule is for: any agent, organisation-level agents (sessions in no project), a project, an agent profile or one session. */
export type ConnectionRuleWho =
	| {
			readonly kind: "any";
	  }
	| {
			readonly kind: "organisation";
	  }
	| {
			readonly kind: "project";
			/** The project. */
			readonly projectId: string;
	  }
	| {
			readonly kind: "agent";
			/** The agent profile. */
			readonly agentId: string;
	  }
	| {
			readonly kind: "session";
			/** The session. */
			readonly sessionId: string;
	  };

/** A person's connection shared with a project (#335): explicit, audited and revocable. */
export interface ConnectionShare {
	/** The project it is shared with. */
	readonly projectId: string;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly sharedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly sharedAt: number;
}

/** How this deployment runs connections. No secrets. */
export interface ConnectionsSettings {
	/** Every session acting for a person is that person's alone (a deployment with one person), so their personal connections work in all their sessions. False: a session is seen by its project, and a person's connection is refused in it unless they share it with the project. */
	readonly personal: boolean;
}

export type ConnectionStatus = "active" | "needs_reauth" | "failing_test" | "disabled";

/** Where a connection may be used, by whom and in which sessions. */
export interface ConnectionUsage {
	/** Only sessions in these projects (an organisation's connection). */
	readonly projects?: readonly string[];
	/** Only sessions acting for these people. */
	readonly actingUsers?: readonly string[];
	/** Only sessions of these agent profiles. */
	readonly agents?: readonly string[];
	/** Whether sessions with no person behind them may use it. */
	readonly unattended: boolean;
	/** `private`: only in sessions nobody but the acting person can see. */
	readonly visibility: "private" | "shared";
}

/** Which connection a session used, at which step, and who could see it. */
export interface ConnectionUse {
	readonly id: string;
	readonly connectionId: string;
	readonly organisationId: string;
	readonly projectId?: string;
	readonly sessionId: string;
	readonly agentId?: string;
	readonly actingUserId?: string;
	/** Made in a session no person was watching, a schedule's run. With `actingUserId`, the run acted for that person. */
	readonly unattended?: true;
	/** The tool call (step) that used it. */
	readonly toolCallId?: string;
	readonly kind: "mcp_tools" | "mcp_call" | "http";
	readonly method: HttpMethod;
	readonly host: string;
	readonly path: string;
	readonly tool?: string;
	/** Who could see a session: only the person it acts for (`private`), or more people (`shared`). */
	readonly audience: SessionAudience;
	/** `allowed` went out, `denied` was refused, `held` waits for a person to approve the exact request and sent nothing (#333). */
	readonly outcome: "allowed" | "denied" | "held";
	readonly reason?: string;
	/** A person's connection used in a project it is shared with, not by its owner's own session. */
	readonly viaShare?: boolean;
	/** Sent by the sandbox through the egress gate with the connection's placeholder (#331). */
	readonly egress?: true;
	/** Why the egress gate refused a sandbox's request (#331): `host_not_bound` (the placeholder's connection is not for that host), `raw_secret` (a stored secret's own value, not its placeholder), `unknown_placeholder`, `ambiguous_placeholder`, `connection_not_usable`, `needs_reauth`, `https_required`, `rule_denied`, `approval_pending`, `egress_denied` or `egress_unavailable`. */
	readonly refusal?: EgressRefusalCode;
	/** What the access rules answered, when the request got as far as them. */
	readonly decision?: "allow" | "ask" | "deny";
	/** What decided it. */
	readonly decidedBy?: "rule" | "unmatched" | "usage" | "connection" | "ceiling" | "listing";
	/** The deciding rule, when one did. */
	readonly ruleId?: string;
	readonly rulesVersion?: number;
	/** For an approved `ask` (#333): the approval it spent. */
	readonly approvalId?: string;
	/** When a rule said ask: the approval this use waited on or used (#333). */
	readonly approval?: {
		/** The approval: a connection request of kind `request`. */
		readonly id: string;
		/** The exact request's digest. */
		readonly digest: string;
		/** `used` once it let the request out, `pending` while a person has yet to decide; a held use whose approval has since ended says how (#481). */
		readonly state: "pending" | "used" | "approved" | "denied" | "expired" | "withdrawn";
	};
	/** Epoch milliseconds, UTC. */
	readonly at: number;
}

export interface ConnectionUsePage {
	readonly items: readonly (ConnectionUse | RedactedConnectionUse)[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** A new session, with its first message's submission when it was sent one. */
export interface CreatedSession {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	/** The session's project. Absent for a session scoped to the organisation. */
	readonly projectId?: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	/** The person the session works for: whose own skills and prompt rules it gets. */
	readonly userId?: string;
	/** Started by a schedule, with no person watching: the schedule and occurrence it runs for (#335). With `userId`, a scheduled run acting for the person who made the schedule (a one-person deployment): it may use their own connections while it is private to them, and the organisation's and projects' only when they allow unattended use. Only a host app or Kantel names one; a child session has its parent's. */
	readonly unattended?: SessionUnattended;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	/** Who may see the session (#335). `private`: only the person it acts for (and the host app that made it); no project or organisation member, an admin included. `shared` (the default): its project's members, or the organisation's. A person's private connection is refused in a shared session unless they shared it with the project. */
	readonly visibility?: SessionVisibility;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	/** When the session was pinned to the top of the list, in epoch milliseconds. */
	readonly pinnedAt?: number;
	/** When the session was archived (out of the default list), in epoch milliseconds. */
	readonly archivedAt?: number;
	/** When someone marked the session unread, in epoch milliseconds. */
	readonly markedUnreadAt?: number;
	/** A message the session accepted. */
	readonly submission?: Submission;
}

/** A new server, and for a tunnel its first token. */
export interface CreatedToolServer {
	/** An MCP server Kantel calls for tools, owned by an organisation or one of its projects. */
	readonly server: ToolServer;
	/** A tunnel token just made: the only time its secret is given. */
	readonly token?: IssuedToolServerToken;
}

export interface CreateMemorySpaceBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
}

/** A new program and its first version. */
export interface CreateProgramBody {
	readonly projectId: string;
	/** Unique in the project. */
	readonly name: string;
	/** The program: the body of an async JavaScript function, run by code mode. `input` holds the run's input; `await tools.<name>(args)` calls an allowed tool; the value it `return`s is the run's output. */
	readonly code: string;
	readonly description?: string;
	/** A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`). */
	readonly inputSchema?: {
		readonly [key: string]: JsonValue;
	};
	/** A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`). */
	readonly outputSchema?: {
		readonly [key: string]: JsonValue;
	};
	/** The tools the program may call, as an agent profile names them: built-in tools (`read`, `bash`, …), a connection's tools and `<server>/<tool>` or `<server>/*` for a tool server. Nothing else is callable. Default none. */
	readonly tools?: readonly string[];
	/** The run's deadline, tool calls and approvals included. Default 300000 (5 minutes). */
	readonly timeoutMs?: number;
	/** The output's budget. Default 10000. */
	readonly maxOutputTokens?: number;
}

/** The program's next version. */
export interface CreateProgramVersionBody {
	/** The program: the body of an async JavaScript function, run by code mode. `input` holds the run's input; `await tools.<name>(args)` calls an allowed tool; the value it `return`s is the run's output. */
	readonly code: string;
	readonly description?: string;
	/** A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`). */
	readonly inputSchema?: {
		readonly [key: string]: JsonValue;
	};
	/** A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`). */
	readonly outputSchema?: {
		readonly [key: string]: JsonValue;
	};
	/** The tools the program may call, as an agent profile names them: built-in tools (`read`, `bash`, …), a connection's tools and `<server>/<tool>` or `<server>/*` for a tool server. Nothing else is callable. Default none. */
	readonly tools?: readonly string[];
	/** The run's deadline, tool calls and approvals included. Default 300000 (5 minutes). */
	readonly timeoutMs?: number;
	/** The output's budget. Default 10000. */
	readonly maxOutputTokens?: number;
}

/** Any other field is refused as `invalid`. */
export interface CreateProjectBody {
	/** The project's name, trimmed: not empty, and at most 100 characters. */
	readonly name: string;
}

export interface CreateResourceShareBody {
	/** A resource, optionally at one revision. */
	readonly resource: ResourceSelector;
	/** Who a share is for: a project (its sessions, and its people within their role), an agent profile, a person, or one session (what a supervisor passes on). */
	readonly grantee: ShareGrantee;
	/** Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on. */
	readonly permission: SharePermission;
	/** Let agents write through the share (default false). Only on an `edit` or `approve` share; a share passed on may turn it on only when the one held has it. */
	readonly agentWrites?: boolean;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** Required of an agent: the share it passes on. */
	readonly parentShareId?: string;
	readonly note?: string;
}

/** A new schedule. Needs the operator role on a project-owned schedule's project. */
export interface CreateScheduleBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
	readonly kind: ScheduleKind;
	readonly title: string;
	/** An IANA time zone, such as `Europe/London`. */
	readonly timezone: string;
	/** A one-off at this instant (epoch milliseconds). Exactly one of `at` and `repeat`. */
	readonly at?: number;
	readonly repeat?: Recurrence;
	/** No occurrence is due after this (epoch milliseconds). */
	readonly until?: number;
	/** At most this many occurrences. */
	readonly count?: number;
	/** Any JSON value. */
	readonly payload: JsonValue;
	readonly check?: CheckSettings;
}

/** Put the host's own reference for the session in `labels`, such as `{ lleverageRunId: "run-42" }`, and find it again with `GET /sessions?label.lleverageRunId=run-42`. */
export interface CreateSessionBody {
	/** The project the session runs in. Required unless `scope` is `organisation`. */
	readonly projectId?: string;
	/** Where a session works: `project` (in `projectId`) or `organisation`, above every project and in none of them. */
	readonly scope?: SessionScope;
	/** The person the session works for. A person may name only themselves; a host app any user. Default the person creating it. */
	readonly userId?: string;
	/** The agent profile it runs. */
	readonly agentId: string;
	readonly title?: string;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels?: Labels;
	/** An existing workspace to run in. */
	readonly workspaceId?: string;
	/** Creates a child session owned by this parent; aborting the parent aborts it. */
	readonly parentSessionId?: string;
	/** Who may see the session (#335). `private`: only the person it acts for (and the host app that made it); no project or organisation member, an admin included. `shared` (the default): its project's members, or the organisation's. A person's private connection is refused in a shared session unless they shared it with the project. */
	readonly visibility?: SessionVisibility;
	/** Started by a schedule, with no person watching: the schedule and occurrence it runs for (#335). With `userId`, a scheduled run acting for the person who made the schedule (a one-person deployment): it may use their own connections while it is private to them, and the organisation's and projects' only when they allow unattended use. Only a host app or Kantel names one; a child session has its parent's. */
	readonly unattended?: SessionUnattended;
	/** The session's first prompt, sent as soon as it exists. */
	readonly message?: FirstMessage;
}

/** A credential's state. Never its value. */
export interface CredentialState {
	readonly set: boolean;
	/** A key's or client secret's last four characters. */
	readonly last4?: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	readonly refreshable: boolean;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt?: number;
}

/** An opaque position in a session's stream. */
export type Cursor = string;

/** A grant may narrow what was asked (a weaker permission, an earlier expiry, a pinned revision), never widen it. */
export interface DecideAccessRequestBody {
	readonly decision: "grant" | "reject";
	readonly note?: string;
	/** Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on. */
	readonly permission?: SharePermission;
	/** Let agents write through the share the grant makes (default false). Only when it grants `edit` or `approve`. */
	readonly agentWrites?: boolean;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** Pins this revision. Without one, the share follows the latest. */
	readonly revision?: number;
}

/** `append` adds an item, `replace` swaps the item with the same id, `text` appends streamed text to an assistant item, `args` appends streamed text to a string in a tool item's arguments, and `status`, `title` and `usage` set the session's. */
export type DeltaOp =
	| {
			readonly op: "append";
			readonly item: TranscriptItem;
	  }
	| {
			readonly op: "replace";
			readonly item: TranscriptItem;
	  }
	| {
			readonly op: "text";
			readonly itemId: string;
			readonly append: string;
			readonly field?: "text" | "thinking" | "document";
	  }
	| {
			readonly op: "args";
			readonly itemId: string;
			/** Keys and indexes to a string in the tool item's `args`; missing ones are created. */
			readonly path: readonly (string | number)[];
			readonly append: string;
	  }
	| {
			readonly op: "status";
			readonly status: SessionStatus;
			/** How a session list groups the session: working, waiting on someone, or done. */
			readonly attention: Attention;
	  }
	| {
			readonly op: "title";
			readonly title: string;
	  }
	| {
			readonly op: "usage";
			/** Model token usage and cost: the session's running total on a snapshot and in a `usage` op, the answer's on a run result. `inputTokens` excludes input read from or written to the provider's cache. */
			readonly usage: Usage;
	  };

/** The document the model is writing in a `create_document` call, while the answer streams. Gone once the answer is done. */
export interface DraftDocument {
	/** The tool call writing it. */
	readonly callId: string;
	readonly title: string;
	/** Its Markdown so far. */
	readonly text: string;
}

/** Why the egress gate refused a sandbox's request (#331): `host_not_bound` (the placeholder's connection is not for that host), `raw_secret` (a stored secret's own value, not its placeholder), `unknown_placeholder`, `ambiguous_placeholder`, `connection_not_usable`, `needs_reauth`, `https_required`, `rule_denied`, `approval_pending`, `egress_denied` or `egress_unavailable`. */
export type EgressRefusalCode =
	| "host_not_bound"
	| "raw_secret"
	| "unknown_placeholder"
	| "ambiguous_placeholder"
	| "connection_not_usable"
	| "needs_reauth"
	| "https_required"
	| "rule_denied"
	| "approval_pending"
	| "egress_denied"
	| "egress_unavailable";

export interface EmbedBrowserBody {
	/** `live`: the open browser as it is now, watch-only. `replay`: its recording. */
	readonly mode: "live" | "replay";
	/** How long the link lasts. Default 15. */
	readonly minutes?: number;
}

export interface EndpointHint {
	readonly method: HttpMethod | "*";
	/** `*` matches one segment; a trailing `/**` the rest. */
	readonly path: string;
	readonly access: AccessKind;
}

export interface FileShare {
	/** The share's ID. */
	readonly id: string;
	/** The organisation. */
	readonly organisationId: string;
	/** The workspace the file is in. */
	readonly workspaceId: string;
	/** The file's path in the workspace. */
	readonly path: string;
	/** What the link's page calls the file. */
	readonly title?: string;
	/** `restricted`: only those who can see the session's workspace. `link`: anyone with the link. */
	readonly access: ShareAccess;
	/** The link's secret: the link is `/shared/<token>` on the deployment's hostname. Treat it as one. */
	readonly token: string;
	/** The person who shared the file, its owner. */
	readonly createdBy: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	readonly invites: readonly ShareInvite[];
	/** Epoch milliseconds, UTC. */
	readonly revokedAt?: number;
}

export interface FileSharePage {
	readonly items: readonly FileShare[];
}

/** The session's first prompt, sent as soon as it exists. */
export interface FirstMessage {
	/** The message's words. May be empty when `attachments` has a file; otherwise it is `invalid`. */
	readonly text: string;
	/** Files for this message, in the order they were attached. A deployment that stores no uploads refuses them (`invalid`), as it does a file from another project. */
	readonly attachments?: readonly PromptAttachment[];
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. Only a session's first message may choose its model: once the session has started, naming another is a `conflict` (naming its own is fine). */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

/** Where to fork: the answer the new session's history ends with. */
export interface ForkSessionBody {
	/** The transcript item ID of an assistant answer, as the session's stream gives it. */
	readonly itemId: string;
	/** The new session's title. Default the source's, with " (fork)". */
	readonly title?: string;
}

/** A GitHub App GitHub created from Kantel's manifest. */
export interface GitHubAppInfo {
	readonly slug: string;
	readonly appId: number;
	/** The app's settings page on GitHub. */
	readonly htmlUrl: string;
	/** Where to install it on accounts and repositories. */
	readonly installUrl: string;
}

/** A GitHub App manifest flow; GitHub requires it finished within an hour. */
export interface GitHubAppSetup {
	/** The flow's ID. */
	readonly id: string;
	readonly status: "pending" | "created" | "failed" | "expired";
	/** Kantel's page that posts the manifest on to GitHub, with the single-use state in it. Only in the answer that starts the flow. */
	readonly url?: string;
	/** The OAuth client record made, once created. */
	readonly clientId?: string;
	/** A GitHub App GitHub created from Kantel's manifest. */
	readonly githubApp?: GitHubAppInfo;
	readonly failure?: {
		readonly message: string;
	};
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

export interface HistoryPage {
	readonly sessionId: string;
	/** Oldest first. */
	readonly items: readonly TranscriptItem[];
	readonly hasEarlier: boolean;
}

export interface HistoryQuery {
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
	/** Items older than this item ID, such as a snapshot's `items[0].id`. */
	readonly before?: string;
	/** At most this many items. Default 50, cut to 200. */
	readonly limit?: number;
}

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface ImportSkillBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
	readonly description: string;
	/** Every file of the package, `SKILL.md` among them. */
	readonly files: readonly SkillFile[];
	/** Where a host's adapter imported something from. */
	readonly source: SourceRef;
	/** Namespaced host data Kantel keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
}

export interface InlineToolImage {
	/** The image types a tool item carries: raster only, never SVG. */
	readonly mimeType: ToolImageType;
	/** The image as base64. */
	readonly data: string;
}

/** A tunnel token just made: the only time its secret is given. */
export interface IssuedToolServerToken {
	/** A tunnel token as reads show it: never the token itself. */
	readonly token: ToolServerToken;
	/** `hbt_…`. Shown once, in this answer; Kantel keeps only its hash. */
	readonly secret: string;
}

/** Any JSON value. */
export type JsonValue = unknown;

/** How a key goes out on a request. */
export type KeyInjection =
	| {
			readonly kind: "bearer";
	  }
	| {
			readonly kind: "header";
			readonly header: string;
			readonly prefix?: string;
	  }
	| {
			readonly kind: "query";
			readonly param: string;
	  }
	| {
			readonly kind: "basic";
	  }
	| {
			readonly kind: "header_template";
			readonly header: string;
			/** Contains `{key}`. */
			readonly template: string;
	  };

export interface KeyShape {
	readonly label: string;
	readonly prefix?: string;
	readonly pattern?: string;
}

/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
export interface Labels {
	readonly [key: string]: string;
}

export interface ListAccessRequestsQuery {
	/** Kantel's `skills.skill`, `memory.space`, `workspace`, `models.connector` or `vault.item` (a secret in the encrypted store behind connections, under its stored name), or a kind a host registered, such as `workflows.workflow`. */
	readonly resourceKind?: string;
	/** With `resourceKind`. */
	readonly resourceId?: string;
	readonly granteeKind?: "project" | "agent" | "user" | "session";
	/** With `granteeKind`: the project's, agent's, person's or session's ID. */
	readonly granteeId?: string;
	readonly status?: AccessRequestStatus;
	/** Requests for resources this project owns. */
	readonly ownerProjectId?: string;
	/** Only those the caller may decide: its inbox. */
	readonly decidable?: boolean;
	readonly sessionId?: string;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListBindingsQuery {
	/** A resource kind, or `group`. */
	readonly objectKind?: string;
	/** With `objectKind`. */
	readonly objectId?: string;
	readonly subjectKind?: "user" | "service" | "group";
	/** With `subjectKind`. */
	readonly subjectId?: string;
	readonly relation?: BindingRelation;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListConceptsQuery {
	readonly status?: ConceptStatus;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListProgramsQuery {
	/** Only this project's programs. */
	readonly projectId?: string;
}

export interface ListPromptRulesQuery {
	/** Whose rules: the platform's, the organisation's, a project's or a user's. */
	readonly owner: "platform" | "organisation" | "project" | "user";
	/** The project, for `owner=project`. */
	readonly projectId?: string;
	/** The user, for `owner=user`. Default the calling person. */
	readonly userId?: string;
}

export interface ListResourceSharesQuery {
	/** Kantel's `skills.skill`, `memory.space`, `workspace`, `models.connector` or `vault.item` (a secret in the encrypted store behind connections, under its stored name), or a kind a host registered, such as `workflows.workflow`. */
	readonly resourceKind?: string;
	/** With `resourceKind`. */
	readonly resourceId?: string;
	readonly granteeKind?: "project" | "agent" | "user" | "session";
	/** With `granteeKind`: the project's, agent's, person's or session's ID. */
	readonly granteeId?: string;
	/** Shares of resources this project owns. */
	readonly ownerProjectId?: string;
	/** Include revoked and expired shares. */
	readonly includeInactive?: boolean;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSchedulesQuery {
	/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
	readonly kind?: ScheduleKind;
	readonly status?: ScheduleStatus;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSessionsQuery {
	readonly projectId?: string;
	/** Where a session works: `project` (in `projectId`) or `organisation`, above every project and in none of them. */
	readonly scope?: SessionScope;
	readonly agentId?: string;
	readonly status?: SessionStatus;
	readonly parentSessionId?: string;
	/** Sessions running in this workspace: the conversations that share its files, each with its own history. */
	readonly workspaceId?: string;
	/** Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`. */
	readonly label?: {
		readonly [key: string]: string;
	};
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSharesQuery {
	/** Only this file's share. */
	readonly path?: string;
}

export interface ListShareUsesQuery {
	/** The session. */
	readonly sessionId: string;
}

export interface ListSkillsQuery {
	/** Also list this project's skills. Needs the viewer role on it. */
	readonly projectId?: string;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

/** What Kantel learnt about a remote MCP server from its URL. */
export interface McpDiscovery {
	readonly url: string;
	readonly auth: "oauth" | "none" | "unknown";
	readonly resource?: string;
	readonly authorizationServer?: string;
	readonly registration: readonly ClientRegistration[];
	readonly scopes?: readonly string[];
	readonly templateId?: string;
}

export interface MemorySearchBody {
	/** The spaces to read. */
	readonly spaceIds: readonly string[];
	readonly query: string;
	/** Default 5. */
	readonly limit?: number;
	/** Also list superseded and forgotten concepts, scoring a quarter. */
	readonly includeInactive?: boolean;
}

export interface MemorySearchHit {
	readonly concept: Concept;
	readonly score: number;
	readonly stale: boolean;
	/** The first statement line holding a term, cut to 160 characters. */
	readonly snippet: string;
}

export interface MemorySearchResult {
	readonly hits: readonly MemorySearchHit[];
}

/** A whole space's concepts at one ref of a source. */
export interface MemorySnapshot {
	readonly sourceId: string;
	readonly ref: string;
	readonly concepts: readonly SnapshotConcept[];
}

/** Where a space's snapshot came from, and when it was imported. */
export interface MemorySnapshotRef {
	readonly sourceId: string;
	readonly ref: string;
	/** Epoch milliseconds, UTC. */
	readonly importedAt: number;
}

export interface MemorySpace {
	/** The space's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Where a space's snapshot came from, and when it was imported. */
	readonly snapshot?: MemorySnapshotRef;
}

export interface MemorySpacePage {
	readonly items: readonly MemorySpace[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** A message to the session's agent. `via` defaults to `prompt`. */
export interface MessageBody {
	/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, without stopping it (usually right after the tool call in progress), and `followUp` runs after the current run ends. A steer or follow-up to a session with no run in progress starts one, as a prompt does, so a message sent just as a run ends is never lost. */
	readonly via?: MessageVia;
	/** The message's words. May be empty when `attachments` has a file; otherwise it is `invalid`. */
	readonly text: string;
	/** Files for this message, in the order they were attached. A deployment that stores no uploads refuses them (`invalid`), as it does a file from another project. */
	readonly attachments?: readonly PromptAttachment[];
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. Only a session's first message may choose its model: once the session has started, naming another is a `conflict` (naming its own is fine). */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, without stopping it (usually right after the tool call in progress), and `followUp` runs after the current run ends. A steer or follow-up to a session with no run in progress starts one, as a prompt does, so a message sent just as a run ends is never lost. */
export type MessageVia = "prompt" | "steer" | "followUp";

/** A model a session may run with, as a model picker shows it. */
export interface ModelOption {
	/** What a message's `model` names: a route such as `default`, or `<route>:<modelId>` for an override. */
	readonly id: string;
	/** What a person reads, such as `Claude Sonnet 4.5`. */
	readonly label: string;
	/** Who serves the model, for grouping, such as `Anthropic`. */
	readonly provider?: string;
	readonly description?: string;
	/** What the model takes. A field left out is unknown. */
	readonly capabilities?: {
		/** Reads images. */
		readonly images?: boolean;
		/** The thinking levels it supports. */
		readonly thinking?: readonly ThinkingLevel[];
	};
	/** The model the session runs with when no message names one. At most one. */
	readonly default?: boolean;
	/** Set when the model is listed but can't be chosen now, with the reason. */
	readonly disabledReason?: string;
}

/** A model and thinking level. */
export interface ModelSelection {
	/** A `ModelOption.id`. */
	readonly model: string;
	readonly thinking?: ThinkingLevel;
}

export interface NewSessionModelsQuery {
	/** The project the session would run in. Required unless `scope` is `organisation`. */
	readonly projectId?: string;
	/** Where a session works: `project` (in `projectId`) or `organisation`, above every project and in none of them. */
	readonly scope?: SessionScope;
}

export interface NoticeItem {
	readonly kind: "notice";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly level: "info" | "warning" | "error";
	readonly text: string;
	readonly code?: string;
}

/** An OAuth app registration at a tenancy level. Its secret is write-only. */
export interface OAuthClient {
	/** The OAuth client record's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly templateId?: string;
	/** An authorisation server's issuer, for a server with no template. */
	readonly issuer?: string;
	readonly label: string;
	/** The public client ID. */
	readonly clientId: string;
	/** A credential's state. Never its value. */
	readonly secret: CredentialState;
	readonly scopes?: readonly string[];
	readonly redirectDomain?: string;
	/** The redirect URI to register with the provider. */
	readonly redirectUri: string;
	readonly disabled: boolean;
	/** How many connections are pinned to it. */
	readonly connections: number;
	/** A public client: no secret, so it signs in with a code or PKCE alone. */
	readonly public?: boolean;
	/** A GitHub App GitHub created from Kantel's manifest. */
	readonly githubApp?: GitHubAppInfo;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface OAuthClientPage {
	readonly items: readonly OAuthClient[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** The tenancy level an OAuth client belongs to; `platform` is the deployment. */
export type OAuthClientTier = "platform" | "organisation" | "project" | "user";

/** One run of a schedule. */
export interface Occurrence {
	/** `<scheduleId>@<dueAt>`: unique per schedule and due time. */
	readonly id: string;
	readonly scheduleId: string;
	/** Epoch milliseconds, UTC. */
	readonly dueAt: number;
	/** How many due times this run stands for (more than 1 after missed runs). */
	readonly coalesced: number;
	readonly status: OccurrenceStatus;
	readonly attempt: number;
	readonly claimedBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly leaseUntil?: number;
	/** Epoch milliseconds, UTC. */
	readonly finishedAt?: number;
	/** How the run went: a task's `{ sessionId, submissionId }` (the session it started), a check's `{ exitCode, raised }`, or `{ error }` for a failed run. */
	readonly result?: unknown;
}

export interface OccurrencePage {
	readonly items: readonly Occurrence[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export type OccurrenceStatus = "due" | "running" | "succeeded" | "failed";

/** Who owns a record: an organisation, a project, a user, or the platform. */
export type OwnerRef =
	| {
			readonly kind: "platform";
	  }
	| {
			readonly kind: "organisation";
			readonly organisationId: string;
	  }
	| {
			readonly kind: "project";
			readonly organisationId: string;
			readonly projectId: string;
	  }
	| {
			readonly kind: "user";
			readonly organisationId: string;
			readonly userId: string;
	  };

export interface PageQuery {
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

/** The run is still going (or queued): ask again. */
export interface PendingRun {
	readonly status: "pending";
	readonly sessionId: string;
	readonly submissionId: string;
}

/** A file the agent presented to the person (`present_files`). Read its bytes through the workspace read API with your own credentials. */
export interface PresentedFile {
	/** The session's workspace the file is in. */
	readonly workspaceId: string;
	/** Its path in the workspace, for `GET /v1/workspaces/{workspaceId}/content?path=`: "out/report.pdf", or "/project/README.md" under a mount. */
	readonly path: string;
	/** Its file name: "report.pdf". */
	readonly name: string;
	/** Its media type, from its name: "application/pdf". */
	readonly mimeType: string;
	/** Its size in bytes when it was presented. */
	readonly size: number;
	/** The first lines of a text file, for a preview card. */
	readonly preview?: string;
	/** A title to show rather than its name: a document's. */
	readonly title?: string;
	/** A document the agent wrote (`create_document`): Markdown the person edits. */
	readonly document?: boolean;
	/** The model that made the file: an image `generate_image` made, such as "gpt-image-1". */
	readonly model?: string;
}

export interface PreviewScheduleQuery {
	/** How many due times. Default 5. */
	readonly n?: number;
}

/** A named program in a project, and its versions. */
export interface Program {
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	readonly name: string;
	readonly description?: string;
	/** The newest version not deleted; runs use it by default. */
	readonly latestVersion?: number;
	/** The versions not deleted, oldest first. */
	readonly versions: readonly number[];
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
}

export interface ProgramList {
	readonly items: readonly Program[];
}

/** One run of a program version. */
export interface ProgramRun {
	readonly id: string;
	readonly programId: string;
	readonly version: number;
	readonly projectId: string;
	readonly status: ProgramRunStatus;
	/** A running program waits for a person to allow a tool call. */
	readonly waiting?: "approval";
	/** Any JSON value. */
	readonly input: JsonValue;
	/** Any JSON value. */
	readonly output?: JsonValue;
	/** The program's `console` lines. */
	readonly logs?: readonly string[];
	readonly error?: string;
	/** The run's session: its transcript, tool calls, approvals and audit trail, as for any session. */
	readonly sessionId: string;
	/** Epoch milliseconds, UTC. */
	readonly startedAt: number;
	/** Epoch milliseconds, UTC. */
	readonly endedAt?: number;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly startedBy: Actor;
}

export interface ProgramRunList {
	readonly items: readonly ProgramRun[];
}

export type ProgramRunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** One saved version of a program. Versions are immutable. */
export interface ProgramVersion {
	readonly programId: string;
	readonly version: number;
	readonly code: string;
	readonly description?: string;
	/** A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`). */
	readonly inputSchema?: {
		readonly [key: string]: JsonValue;
	};
	/** A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`). */
	readonly outputSchema?: {
		readonly [key: string]: JsonValue;
	};
	readonly tools: readonly string[];
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** The session whose agent saved it, if an agent did. */
	readonly sessionId?: string;
}

export interface ProgramVersionList {
	readonly items: readonly ProgramVersion[];
}

export interface Project {
	/** The project's ID. */
	readonly id: string;
	/** The organisation the project is in: always the caller's. */
	readonly organisationId: string;
	readonly name: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

/** A file for a message, uploaded first: on Cloudflare `POST /v1/attachments?projectId=&name=` with the file's bytes as the body answers this reference. The message carries only the reference; the model sees the file's contents. */
export interface PromptAttachment {
	/** The upload's ID, as the deployment's upload route answered it. Unique within the message. */
	readonly id: string;
	/** The file's name, such as `invoice.pdf`. */
	readonly name: string;
	/** The MIME type, such as `image/png` or `application/pdf`. */
	readonly type: string;
	/** In bytes. */
	readonly size: number;
	/** `image`: a PNG, JPEG, GIF or WebP the model looks at; `file`: any other file; `text`: a long paste folded into a file. */
	readonly kind: "image" | "file" | "text";
}

export interface PromptRule {
	/** The rule's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** Unique among its owner's rules. */
	readonly name: string;
	/** The prompt text. */
	readonly text: string;
	/** Its place among its owner's rules, lowest first; ties go by name. */
	readonly order: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface PromptRuleList {
	/** In layer order: platform, organisation, project, user. */
	readonly items: readonly PromptRule[];
}

export type ProviderCategory =
	| "developer"
	| "productivity"
	| "communication"
	| "knowledge"
	| "project_management"
	| "crm"
	| "payments"
	| "ai"
	| "cloud"
	| "data"
	| "design"
	| "other";

export interface ProviderOAuth {
	readonly discovery: "static" | "mcp";
	readonly authorizationUrl?: string;
	readonly tokenUrl?: string;
	/** Where a disconnect revokes the connection's tokens: RFC 7009, or the provider's own endpoint for `revocationStyle`. `{client_id}` is the connection's client ID. */
	readonly revocationUrl?: string;
	/** How a provider's revocation endpoint is called: `rfc7009` (a form POST of the token), or `github_grant` (GitHub's `DELETE /applications/{client_id}/grant`). */
	readonly revocationStyle?: RevocationStyle;
	readonly scopeSeparator?: string;
	readonly extraAuthorizationParams?: {
		readonly [key: string]: string;
	};
	readonly pkce: boolean;
	readonly refreshBufferSeconds?: number;
	readonly rotatesRefreshTokens?: boolean;
	readonly registration: readonly ClientRegistration[];
	/** The device authorisation endpoint (RFC 8628). With a public client a connect signs in with a code typed at the provider. */
	readonly deviceAuthorizationUrl?: string;
}

/** A catalogue entry: how a service authenticates and where it is reached. */
export interface ProviderTemplate {
	/** The template's ID, such as `github`. */
	readonly id: string;
	readonly version: number;
	readonly name: string;
	readonly description: string;
	/** An https URL or a `data:image/svg+xml` URI. */
	readonly icon: string;
	readonly docsUrl: string;
	readonly category: ProviderCategory;
	/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
	readonly kind: ConnectionKind;
	readonly authTypes: readonly ConnectionAuthType[];
	/** Hosts the credential may be sent to. Never empty. */
	readonly apiHosts: readonly string[];
	readonly mcp?: {
		readonly url: string;
	};
	readonly oauth?: ProviderOAuth;
	readonly key?: {
		/** How a key goes out on a request. */
		readonly injection: KeyInjection;
		readonly shapes?: readonly KeyShape[];
	};
	readonly scopeSets: readonly ScopeSet[];
	readonly endpointHints: readonly EndpointHint[];
	readonly testRequest?: TestRequest;
	readonly source: "shipped" | "deployment" | "organisation";
	/** Short notes for whoever registers an OAuth app for it. */
	readonly clientGuidance?: string;
	/** Which built-in guide to registering an app applies. */
	readonly guide?: "github_app_manifest" | "google";
	/** The provider's own page where a person removes an app's access. */
	readonly manageAccessUrl?: string;
}

export interface PutPromptRuleBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** 1 to 100 letters, digits, `.`, `_` and `-`. A rule of this name replaces the owner's rule. */
	readonly name: string;
	readonly text: string;
	/** Default 0. */
	readonly order?: number;
}

export interface QuestionCard {
	readonly type: "question";
	readonly questionId: string;
	readonly text: string;
	readonly options?: readonly string[];
	readonly status: "open" | "answered" | "withdrawn";
	readonly answer?: string;
}

export interface Recall {
	readonly concepts: readonly Concept[];
	/** What was recalled and why, in the same order. */
	readonly manifest: readonly RecallManifestEntry[];
	/** The recall as a prompt shows it. */
	readonly text: string;
	readonly skipped: readonly {
		readonly conceptId: string;
		readonly reason: string;
	}[];
	readonly profileOmitted: readonly string[];
	readonly truncated: boolean;
}

export interface RecallBody {
	/** The spaces to read. */
	readonly spaceIds: readonly string[];
	/** The task or message text to search by. */
	readonly query: string;
	readonly scopes?: {
		readonly projects?: readonly string[];
		readonly jobs?: readonly string[];
	};
	/** Concept IDs recalled whatever the query, within their own limits. */
	readonly profile?: readonly string[];
	/** Concept IDs never recalled. */
	readonly exclude?: readonly string[];
	/** Default 5 search matches. */
	readonly maxConcepts?: number;
	/** Default 4096. */
	readonly maxBytes?: number;
	readonly maxProfileConcepts?: number;
	/** Default 24576. */
	readonly maxProfileBytes?: number;
}

export interface RecallManifestEntry {
	readonly spaceId: string;
	readonly conceptId: string;
	readonly version: number;
	readonly reason: "profile" | "search" | "exception";
	readonly score?: number;
	readonly matched?: readonly string[];
	readonly stale: boolean;
	readonly truncated: boolean;
	readonly snapshotRef?: string;
}

export type Recurrence =
	| {
			readonly every: "minutes" | "hours";
			readonly interval: number;
			/** Epoch milliseconds, UTC. */
			readonly from: number;
	  }
	| {
			readonly every: "day";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
			readonly interval?: number;
	  }
	| {
			readonly every: "weekday";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
	  }
	| {
			readonly every: "week";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
			readonly on: readonly Weekday[];
	  }
	| {
			readonly every: "month";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
			readonly day: number;
	  };

/** A use in a private session the caller can't open (#335): when, how it ended and for whom. No session, step, agent, project, request or reason. */
export interface RedactedConnectionUse {
	readonly id: string;
	readonly connectionId: string;
	readonly organisationId: string;
	readonly redacted: true;
	/** The person the session acted for. */
	readonly actingUserId: string;
	readonly audience: {
		readonly kind: "private";
		readonly userId: string;
	};
	readonly outcome: "allowed" | "denied" | "held";
	/** Epoch milliseconds, UTC. */
	readonly at: number;
}

export interface RegisteredResource {
	/** The organisation. */
	readonly organisationId: string;
	/** A resource: its kind and ID. */
	readonly resource: ResourceRef;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name?: string;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly registeredBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly registeredAt: number;
}

/** A host's own resource and its owner. Kantel's kinds are refused. */
export interface RegisterResourceBody {
	/** A resource: its kind and ID. */
	readonly resource: ResourceRef;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name?: string;
}

/** How a tool call may be repeated after a crash. */
export type ReplayPolicy = "safe" | "idempotent" | "unsafe";

export interface RequestAccessBody {
	/** A resource, optionally at one revision. */
	readonly resource: ResourceSelector;
	/** Who a share is for: a project (its sessions, and its people within their role), an agent profile, a person, or one session (what a supervisor passes on). */
	readonly grantee?: ShareGrantee;
	/** Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on. */
	readonly permission?: SharePermission;
	readonly reason: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** The session the request is for. */
	readonly sessionId?: string;
}

/** The OAuth client a new connect would use. No secret. */
export interface ResolvedClientInfo {
	/** The tenancy level an OAuth client belongs to; `platform` is the deployment. */
	readonly tier: OAuthClientTier;
	/** Whose it is, in words: the deployment's name, `your organisation`, … */
	readonly ownerLabel: string;
	readonly label?: string;
	/** A public client: no secret, so it signs in with a code or PKCE alone. */
	readonly public: boolean;
	/** A GitHub App GitHub created from Kantel's manifest. */
	readonly githubApp?: GitHubAppInfo;
}

export interface ResolvedPromptRulesQuery {
	/** A project session's project. Absent: an organisation session. */
	readonly projectId?: string;
	/** The session's user. Default the calling person. */
	readonly userId?: string;
}

export interface ResourceBinding {
	/** The organisation. */
	readonly organisationId: string;
	/** A resource, or a group (for `member`). */
	readonly object: BindingObject;
	readonly relation: BindingRelation;
	readonly subject: BindingSubject;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly grantedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly grantedAt: number;
}

export interface ResourceBindingPage {
	readonly items: readonly ResourceBinding[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface ResourcePolicy {
	/** Whoever publishes an edit may not be one of its authors. */
	readonly twoPersonRule: boolean;
}

export interface ResourceQuery {
	/** Kantel's `skills.skill`, `memory.space`, `workspace`, `models.connector` or `vault.item` (a secret in the encrypted store behind connections, under its stored name), or a kind a host registered, such as `workflows.workflow`. */
	readonly kind: string;
	/** The resource's ID. */
	readonly id: string;
}

/** A resource: its kind and ID. */
export interface ResourceRef {
	/** Kantel's `skills.skill`, `memory.space`, `workspace`, `models.connector` or `vault.item` (a secret in the encrypted store behind connections, under its stored name), or a kind a host registered, such as `workflows.workflow`. */
	readonly kind: string;
	/** The resource's ID in its component. */
	readonly id: string;
}

/** A resource, optionally at one revision. */
export interface ResourceSelector {
	/** Kantel's `skills.skill`, `memory.space`, `workspace`, `models.connector` or `vault.item` (a secret in the encrypted store behind connections, under its stored name), or a kind a host registered, such as `workflows.workflow`. */
	readonly kind: string;
	/** The resource's ID in its component. */
	readonly id: string;
	/** Pins this revision. Without one, the share follows the latest. */
	readonly revision?: number;
}

export interface ResourceShare {
	/** The share's ID. */
	readonly id: string;
	/** The organisation. */
	readonly organisationId: string;
	/** A resource, optionally at one revision. */
	readonly resource: ResourceSelector;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** Who a share is for: a project (its sessions, and its people within their role), an agent profile, a person, or one session (what a supervisor passes on). */
	readonly grantee: ShareGrantee;
	/** Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on. */
	readonly permission: SharePermission;
	/** Whether agents covered by the share may write through it (`edit`, never `approve`). Off unless the granter turned it on. */
	readonly agentWrites: boolean;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly grantedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly grantedAt: number;
	/** The request this share answers. */
	readonly requestId?: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** The share a supervisor passed this one on from; revoking that revokes this. */
	readonly parentShareId?: string;
	readonly note?: string;
	/** Epoch milliseconds, UTC. */
	readonly revokedAt?: number;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly revokedBy?: Actor;
	readonly revokeReason?: string;
}

export interface ResourceSharePage {
	readonly items: readonly ResourceShare[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** What a disconnect did at the provider: `revoked`, `unsupported` (the provider gives Kantel no way to revoke, or it is a key), `failed` (the provider refused or didn't answer; the connection is removed all the same) or `none` (nothing to revoke). */
export type RevocationOutcome = "revoked" | "unsupported" | "failed" | "none";

/** How a provider's revocation endpoint is called: `rfc7009` (a form POST of the token), or `github_grant` (GitHub's `DELETE /applications/{client_id}/grant`). */
export type RevocationStyle = "rfc7009" | "github_grant";

export interface RevokeResourceShareBody {
	readonly reason?: string;
}

export interface RouteScope {
	/** An exact host name, lower case. */
	readonly host: string;
	readonly methods: readonly HttpMethod[];
	/** Whole segments: `/repos` covers `/repos/x`, never `/repositories`. */
	readonly pathPrefix: string;
}

export interface RunProgramBody {
	/** Any JSON value. */
	readonly input?: JsonValue;
	/** Default the latest version. */
	readonly version?: number;
	/** `sync` (default) answers when the run ends, or with 202 and the running run after `waitMs`; `async` answers 202 at once. Either way, poll `GET /programs/{programId}/runs/{runId}`. */
	readonly mode?: "sync" | "async";
	/** How long a sync call waits. Default 30000. */
	readonly waitMs?: number;
}

/** How the run a message started or joined ended. */
export interface RunResult {
	readonly sessionId: string;
	/** The submission the message was answered as (`Submission.id`). */
	readonly submissionId: string;
	/** `answered`: the run reached its final answer; `failed`: a model or tool error ended it (`error` says which); `aborted`: someone aborted the session's run. Files it changed stay changed. */
	readonly status: "answered" | "failed" | "aborted";
	/** The final answer's text, when it was answered. */
	readonly answer?: string;
	readonly error?: string;
	/** Model token usage and cost: the session's running total on a snapshot and in a `usage` op, the answer's on a run result. `inputTokens` excludes input read from or written to the provider's cache. */
	readonly usage?: Usage;
}

export interface RunResultQuery {
	/** The submission's ID, as `sendMessage` answered it. It holds a `/`, so it goes in the query. */
	readonly submission: string;
	/** How long to wait, in milliseconds, for the run to end before answering 202 (`pending`). Default 25 s, cut to the server's most (120 s). */
	readonly timeoutMs?: number;
}

export interface Schedule {
	/** The schedule's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
	readonly kind: ScheduleKind;
	readonly title: string;
	/** An IANA time zone, such as `Europe/London`. */
	readonly timezone: string;
	/** A one-off at this instant (epoch milliseconds). Exactly one of `at` and `repeat`. */
	readonly at?: number;
	readonly repeat?: Recurrence;
	/** No occurrence is due after this (epoch milliseconds). */
	readonly until?: number;
	/** At most this many occurrences. */
	readonly count?: number;
	/** Any JSON value. */
	readonly payload: JsonValue;
	readonly check?: CheckSettings;
	readonly status: ScheduleStatus;
	/** The next due time; absent when ended or paused. */
	readonly nextDueAt?: number;
	/** Occurrences so far; a coalesced one counts once. */
	readonly occurrences: number;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
export type ScheduleKind = "reminder" | "task" | "summary" | "check" | "heartbeat" | "program";

export interface SchedulePage {
	readonly items: readonly Schedule[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SchedulePreview {
	/** The next due times, soonest first. */
	readonly dueAt: readonly number[];
}

export type ScheduleStatus = "active" | "paused" | "ended";

/** A named group of scopes, marked read or write. */
export interface ScopeSet {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly access: AccessKind;
	readonly scopes: readonly string[];
	/** Asked for when nobody picks. */
	readonly default?: boolean;
}

/** One frame of `@kantel/protocol`: `hello`, then a `snapshot` (or the deltas after the client's cursor), then live `delta`s. */
export type ServerFrame =
	| {
			readonly type: "hello";
			readonly v: 1;
			readonly sessionId: string;
			/** An opaque position in a session's stream. */
			readonly cursor: Cursor;
			/** True when deltas after the client's cursor follow, false for a snapshot. */
			readonly resumed: boolean;
	  }
	| {
			readonly type: "snapshot";
			readonly snapshot: SessionSnapshot;
	  }
	| {
			readonly type: "delta";
			readonly delta: SessionDelta;
	  }
	| {
			readonly type: "history";
			readonly page: HistoryPage;
	  }
	| {
			readonly type: "error";
			readonly code: string;
			readonly message: string;
	  };

/** Who could see a session: only the person it acts for (`private`), or more people (`shared`). */
export type SessionAudience =
	| {
			readonly kind: "private";
			readonly userId: string;
	  }
	| {
			readonly kind: "shared";
	  };

/** Whether a session may use one connection, and if not, why (#335). */
export interface SessionConnectionEligibility {
	/** A connection as a session sees it: no credential. */
	readonly connection: UsableConnection;
	/** The owner's user or project ID; absent for the organisation's. */
	readonly ownerId?: string;
	readonly usable: boolean;
	/** Why the session may not use it. */
	readonly reason?: string;
	/** Usable because its owner shared it with the project. */
	readonly viaShare?: boolean;
}

export interface SessionConnections {
	readonly items: readonly SessionConnectionEligibility[];
}

export interface SessionDelta {
	readonly sessionId: string;
	/** An opaque position in a session's stream. */
	readonly cursor: Cursor;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly ops: readonly DeltaOp[];
}

export interface SessionHistoryPage {
	readonly sessionId: string;
	/** Newest first. */
	readonly items: readonly TranscriptItem[];
	/** Present when older items exist; pass it as `cursor`. */
	readonly nextCursor?: string;
}

/** The models a session's messages may name (`model` and `thinking` on a message), in the order to show them; `selected`, what the session's next model call uses (its agent profile's until its first message names another); `defaults`, what its agent profile names; and `locked`, set once the session has started. The first message fixes the session's model, so everything in its transcript comes from one model; its thinking level can change on any later message, though a change may cost the next call the provider's prompt cache. */
export interface SessionModelState {
	readonly models: readonly ModelOption[];
	/** A model and thinking level. */
	readonly selected?: ModelSelection;
	/** A model and thinking level. */
	readonly defaults?: ModelSelection;
	/** Set once the session has started (it holds a message): its model is `selected`'s for good, and a message naming another is a `conflict`. Its thinking level can still change. */
	readonly locked?: boolean;
}

export interface SessionPage {
	readonly items: readonly SessionRecord[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SessionRecord {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	/** The session's project. Absent for a session scoped to the organisation. */
	readonly projectId?: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	/** The person the session works for: whose own skills and prompt rules it gets. */
	readonly userId?: string;
	/** Started by a schedule, with no person watching: the schedule and occurrence it runs for (#335). With `userId`, a scheduled run acting for the person who made the schedule (a one-person deployment): it may use their own connections while it is private to them, and the organisation's and projects' only when they allow unattended use. Only a host app or Kantel names one; a child session has its parent's. */
	readonly unattended?: SessionUnattended;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	/** Who may see the session (#335). `private`: only the person it acts for (and the host app that made it); no project or organisation member, an admin included. `shared` (the default): its project's members, or the organisation's. A person's private connection is refused in a shared session unless they shared it with the project. */
	readonly visibility?: SessionVisibility;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	/** When the session was pinned to the top of the list, in epoch milliseconds. */
	readonly pinnedAt?: number;
	/** When the session was archived (out of the default list), in epoch milliseconds. */
	readonly archivedAt?: number;
	/** When someone marked the session unread, in epoch milliseconds. */
	readonly markedUnreadAt?: number;
}

/** Where a session works: `project` (in `projectId`) or `organisation`, above every project and in none of them. */
export type SessionScope = "project" | "organisation";

export interface SessionSnapshot {
	readonly v: 1;
	readonly sessionId: string;
	/** An opaque position in a session's stream. */
	readonly cursor: Cursor;
	readonly status: SessionStatus;
	/** How a session list groups the session: working, waiting on someone, or done. */
	readonly attention: Attention;
	readonly title?: string;
	/** The latest page of items, oldest first. */
	readonly items: readonly TranscriptItem[];
	/** True when items before `items[0]` exist. */
	readonly hasEarlier: boolean;
	/** Model token usage and cost: the session's running total on a snapshot and in a `usage` op, the answer's on a run result. `inputTokens` excludes input read from or written to the provider's cache. */
	readonly usage?: Usage;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

/** Started by a schedule, with no person watching: the schedule and occurrence it runs for (#335). With `userId`, a scheduled run acting for the person who made the schedule (a one-person deployment): it may use their own connections while it is private to them, and the organisation's and projects' only when they allow unattended use. Only a host app or Kantel names one; a child session has its parent's. */
export interface SessionUnattended {
	readonly scheduleId: string;
	readonly occurrenceId?: string;
}

/** Who may see the session (#335). `private`: only the person it acts for (and the host app that made it); no project or organisation member, an admin included. `shared` (the default): its project's members, or the organisation's. A person's private connection is refused in a shared session unless they shared it with the project. */
export type SessionVisibility = "private" | "shared";

export interface SessionWarmth {
	/** The session's container: `started` now, already `running`, `skipped` (the session has never needed one, so none is started for it) or `unavailable` (this deployment runs no containers, or the session has no workspace). */
	readonly container: "started" | "running" | "skipped" | "unavailable";
}

export interface SetResourcePolicyBody {
	/** A resource: its kind and ID. */
	readonly resource: ResourceRef;
	readonly policy: ResourcePolicy;
}

/** How to register an app for a template, with this deployment's values in it. */
export interface SetupGuide {
	/** `github_app_manifest`: Kantel can also have GitHub create the app (`startGitHubApp`). */
	readonly kind: "github_app_manifest" | "steps";
	/** Where the app is registered, such as `Google Cloud`. */
	readonly provider: string;
	/** This deployment's redirect URI, to register exactly. */
	readonly redirectUri: string;
	readonly steps: readonly SetupStep[];
	readonly notes?: readonly {
		readonly level: "info" | "warning";
		readonly text: string;
	}[];
}

/** One step of registering an app at a provider. */
export interface SetupStep {
	readonly title: string;
	readonly detail: string;
	readonly link?: {
		readonly label: string;
		readonly url: string;
	};
	/** Values to copy exactly, such as the redirect URI. */
	readonly values?: readonly {
		readonly label: string;
		readonly value: string;
	}[];
}

/** How a template connects for the caller: `none` (nothing to set up), `public_client` (the deployment's client with no secret), `own_app` (an app the person or project registers), `host_client` (the deployment's or the organisation's client) or `key`. */
export type SetupTier = "none" | "public_client" | "own_app" | "host_client" | "key";

/** `restricted`: only those who can see the session's workspace. `link`: anyone with the link. */
export type ShareAccess = "restricted" | "link";

export interface ShareFileBody {
	/** The file's path in the workspace. */
	readonly path: string;
	/** What the link's page calls it. */
	readonly title?: string;
	/** `restricted`: only those who can see the session's workspace. `link`: anyone with the link. */
	readonly access?: ShareAccess;
}

/** Who a share is for: a project (its sessions, and its people within their role), an agent profile, a person, or one session (what a supervisor passes on). */
export type ShareGrantee =
	| {
			readonly kind: "project";
			readonly projectId: string;
	  }
	| {
			readonly kind: "agent";
			readonly agentId: string;
	  }
	| {
			readonly kind: "user";
			readonly userId: string;
	  }
	| {
			readonly kind: "session";
			readonly sessionId: string;
	  };

export interface ShareInvite {
	/** As invited. Kantel sends no email. */
	readonly email: string;
	/** The person who invited them. */
	readonly invitedBy: string;
	/** Epoch milliseconds, UTC. */
	readonly invitedAt: number;
}

export interface ShareInviteBody {
	/** Who to invite. */
	readonly email: string;
}

/** Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on. */
export type SharePermission = "use" | "propose" | "edit" | "approve";

/** A resource a session used through a share: which revision, under which share. */
export interface ShareUse {
	/** The organisation. */
	readonly organisationId: string;
	/** The session. */
	readonly sessionId: string;
	/** A resource, optionally at one revision. */
	readonly resource: ResourceSelector;
	/** The share it was used through. */
	readonly shareId: string;
	/** Epoch milliseconds, UTC. */
	readonly usedAt: number;
}

export interface ShareUseList {
	readonly items: readonly ShareUse[];
}

export interface SkillFile {
	/** A relative path inside the package, such as `SKILL.md` or `scripts/run.sh`. */
	readonly path: string;
	readonly content: string;
}

/** One file of a revision, as UTF-8 text. */
export interface SkillFileContent {
	readonly path: string;
	readonly content: string;
}

export interface SkillFileQuery {
	/** The file's path in the package, such as `SKILL.md`. */
	readonly path: string;
}

/** What a session is shown of a skill: enough to decide whether to read it. */
export interface SkillListing {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	/** The latest published revision. */
	readonly revision: number;
	/** Where a session finds it, such as `/skills/pr-review/SKILL.md`. */
	readonly path: string;
}

export interface SkillListingPage {
	readonly items: readonly SkillListing[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SkillPackage {
	/** The skill's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** Unique per owner: lowercase letters, digits and dashes. */
	readonly name: string;
	readonly description: string;
	/** The newest published revision. */
	readonly latestRevision?: number;
	/** Present while a draft is open. */
	readonly draftDigest?: string;
	/** Where a host's adapter imported something from. */
	readonly source?: SourceRef;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface SkillRevision {
	readonly skillId: string;
	/** 1, 2, 3… per skill. A published revision never changes. */
	readonly revision: number;
	/** Hex SHA-256 over the sorted paths and contents. */
	readonly digest: string;
	readonly name: string;
	readonly description: string;
	readonly files: readonly {
		readonly path: string;
		/** Bytes, UTF-8. */
		readonly size: number;
	}[];
	/** Namespaced host data Kantel keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly publishedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly publishedAt: number;
	/** Where a host's adapter imported something from. */
	readonly source?: SourceRef;
}

export interface SkillRevisionPage {
	readonly items: readonly SkillRevision[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** One concept as a host's source holds it. */
export interface SnapshotConcept {
	/** A stable path, such as `projects/harbour/binding-codes`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	/** Where a concept applies. A `job` concept is an exception for one job. */
	readonly scope: ConceptScope;
	/** What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs. */
	readonly sources: readonly string[];
	/** After this, recall marks it stale (epoch milliseconds). */
	readonly staleAfter?: number;
	/** A job exception's general concept. */
	readonly overrides?: string;
	/** Namespaced host data Kantel keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	readonly tags?: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	readonly status: ConceptStatus;
	readonly supersededBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** Where a host's adapter imported something from. */
export interface SourceRef {
	/** The host's skill or memory source, such as `sal-skills`. */
	readonly sourceId: string;
	/** Its ref: a commit or a version. */
	readonly ref: string;
}

export interface StreamQuery {
	/** Resume after this cursor (a snapshot's or a delta's): the stream sends the deltas after it, or a snapshot when it no longer holds them. */
	readonly after?: string;
}

/** A message the session accepted. */
export interface Submission {
	/** The submission's ID, which names the run the message started or joined. */
	readonly id: string;
	readonly sessionId: string;
	/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, without stopping it (usually right after the tool call in progress), and `followUp` runs after the current run ends. A steer or follow-up to a session with no run in progress starts one, as a prompt does, so a message sent just as a run ends is never lost. */
	readonly via: MessageVia;
	/** The `Idempotency-Key` it was sent with. */
	readonly requestId?: string;
}

export interface TestRequest {
	readonly method: HttpMethod;
	/** An absolute https URL on one of the template's API hosts. */
	readonly url: string;
	readonly account?: {
		readonly id?: string;
		readonly name?: string;
		readonly email?: string;
	};
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** An image a tool returned, such as a browser screenshot or a generated image. By reference (`url`) wherever the server can serve it, so a snapshot or a delta carries no image bytes; inline as base64 (`data`) otherwise, such as on a self-hosted server. */
export type ToolImage = ToolImageReference | InlineToolImage;

export interface ToolImageReference {
	/** The image types a tool item carries: raster only, never SVG. */
	readonly mimeType: ToolImageType;
	/** A path on the API's origin, read with your own credentials: `/v1/sessions/{sessionId}/images/{imageId}` (`getSessionImage`), or a browser screenshot's `/v1/attachments/{id}?projectId=`, which may take a moment to be stored after its item arrives (a read that finds nothing is tried again shortly). */
	readonly url: string;
	/** Its width in pixels, when known. */
	readonly width?: number;
	/** Its height in pixels, when known. */
	readonly height?: number;
	/** Its size in bytes, when known. */
	readonly size?: number;
}

/** The image types a tool item carries: raster only, never SVG. */
export type ToolImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ToolItem {
	readonly kind: "tool";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly callId: string;
	readonly name: string;
	/** A plain-language label, such as "Reading notes/x.md". */
	readonly label: string;
	readonly status: "running" | "done" | "error" | "interrupted";
	/** The call's arguments; while `streaming`, the model's partial JSON parsed so far. */
	readonly args?: unknown;
	/** True while the model is still writing the call: its arguments are arriving and it hasn't started. */
	readonly streaming?: boolean;
	readonly output?: string;
	/** Images the call returned, in order, such as a browser's screenshot of the page it is on. */
	readonly images?: readonly ToolImage[];
	/** The files the call presented to the person (`present_files`; `create_document` its document; `generate_image` the images it made), the most relevant first. */
	readonly files?: readonly PresentedFile[];
	readonly tier?: "isolate" | "container";
	/** Epoch milliseconds, UTC. */
	readonly endedAt?: number;
}

/** An MCP server Kantel calls for tools, owned by an organisation or one of its projects. */
export interface ToolServer {
	/** The tool server's ID, `ts_…`. */
	readonly id: string;
	readonly organisationId: string;
	/** The owning project; absent for a server the organisation owns. */
	readonly projectId?: string;
	/** A slug, unique in the organisation: the `<server>` in the tool names the model sees. */
	readonly name: string;
	/** What it is for, for people; never sent to a model. */
	readonly description?: string;
	/** How Kantel reaches the server: `tunnel`, the server's side dials out over a WebSocket; `http`, Streamable HTTP to a public URL; `callback`, signed HTTPS host callbacks. Only `tunnel` is built yet. */
	readonly transport: ToolServerTransport;
	/** The server's tools as Kantel last took them. */
	readonly snapshot?: ToolServerSnapshot;
	/** Tools sessions are not offered. */
	readonly disabledTools: readonly string[];
	/** Whether the server's side is connected now. */
	readonly connection: ToolServerConnection;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** Whether the server's side is connected now. */
export interface ToolServerConnection {
	readonly status: "connected" | "offline";
	/** Epoch milliseconds, UTC. */
	readonly connectedAt?: number;
	/** Epoch milliseconds, UTC. */
	readonly lastSeenAt?: number;
	readonly serverInfo?: {
		readonly name: string;
		readonly version?: string;
	};
}

export interface ToolServerPage {
	readonly items: readonly ToolServer[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** The server's tools as Kantel last took them. */
export interface ToolServerSnapshot {
	readonly tools: readonly ToolServerTool[];
	/** `sha256:<hex>` of the tools' canonical JSON. */
	readonly hash: string;
	/** Epoch milliseconds, UTC. */
	readonly takenAt: number;
}

/** A tunnel token as reads show it: never the token itself. */
export interface ToolServerToken {
	/** The token's ID, `tst_…`. */
	readonly id: string;
	readonly toolServerId: string;
	/** The token's first characters (`hbt_` and four more). */
	readonly prefix: string;
	/** Who acted: a person, a host app's API key, an agent or Kantel itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly lastUsedAt?: number;
}

export interface ToolServerTokenList {
	readonly items: readonly ToolServerToken[];
}

/** One tool as the server listed it in `tools/list`. */
export interface ToolServerTool {
	/** The server's own name for the tool, as `tools/call` takes it. */
	readonly name: string;
	readonly description: string;
	/** The tool's input, a JSON Schema object. */
	readonly inputSchema: {
		readonly [key: string]: JsonValue;
	};
	/** MCP's tool annotations, as the server gave them. Hints only. */
	readonly annotations?: ToolServerToolAnnotations;
	/** How a tool call may be repeated after a crash. */
	readonly replay: ReplayPolicy;
}

/** MCP's tool annotations, as the server gave them. Hints only. */
export interface ToolServerToolAnnotations {
	readonly title?: string;
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

/** A server's latest snapshot, with what is enabled. */
export interface ToolServerTools {
	readonly toolServerId: string;
	readonly hash?: string;
	/** Epoch milliseconds, UTC. */
	readonly takenAt?: number;
	readonly tools: readonly ToolServerToolView[];
}

/** One tool of a server's snapshot, with what a session would see. */
export interface ToolServerToolView {
	/** The server's own name for the tool, as `tools/call` takes it. */
	readonly name: string;
	readonly description: string;
	/** The tool's input, a JSON Schema object. */
	readonly inputSchema: {
		readonly [key: string]: JsonValue;
	};
	/** MCP's tool annotations, as the server gave them. Hints only. */
	readonly annotations?: ToolServerToolAnnotations;
	/** How a tool call may be repeated after a crash. */
	readonly replay: ReplayPolicy;
	readonly enabled: boolean;
	/** `<server>__<tool>`: the name the model sees. */
	readonly modelName: string;
	/** Why a session can't be offered it although it may be enabled. */
	readonly unavailableReason?: string;
}

/** How Kantel reaches the server: `tunnel`, the server's side dials out over a WebSocket; `http`, Streamable HTTP to a public URL; `callback`, signed HTTPS host callbacks. Only `tunnel` is built yet. */
export type ToolServerTransport = "tunnel" | "http" | "callback";

export type TranscriptItem = UserItem | AssistantItem | ToolItem | CardItem | NoticeItem;

/** The fields to change; a field left out stays as it is, and `null` on `at`, `repeat`, `until` or `count` clears it. The owner and the kind are fixed at create. */
export interface UpdateScheduleBody {
	readonly title?: string;
	/** An IANA time zone, such as `Europe/London`. */
	readonly timezone?: string;
	/** A one-off at this instant (epoch milliseconds), or `null` to clear it, as when it becomes a recurrence. Exactly one of `at` and `repeat` is left set. */
	readonly at?: number | null;
	/** The recurrence, or `null` to clear it, as when it becomes a one-off. */
	readonly repeat?: Recurrence | null;
	/** No occurrence is due after this (epoch milliseconds), or `null` to drop the end date. */
	readonly until?: number | null;
	/** At most this many occurrences, or `null` to drop the run limit. */
	readonly count?: number | null;
	/** Any JSON value. */
	readonly payload?: JsonValue;
	readonly check?: CheckSettings;
}

/** The fields to change; one left out stays as it is. */
export interface UpdateShareBody {
	/** `restricted`: only those who can see the session's workspace. `link`: anyone with the link. */
	readonly access?: ShareAccess;
	readonly title?: string;
}

/** A connection as a session sees it: no credential. */
export interface UsableConnection {
	readonly id: string;
	readonly name: string;
	/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
	readonly kind: ConnectionKind;
	readonly templateId?: string;
	readonly owner: "organisation" | "project" | "user";
	readonly account?: ConnectionAccount;
	readonly hosts: readonly string[];
	readonly mcpUrl?: string;
	/** The connection's placeholder (#331), sent in the credential's place. */
	readonly placeholder?: string;
	/** The sandbox's environment variable holding it, such as KANTEL_CONNECTION_GITHUB. */
	readonly env?: string;
}

/** Model token usage and cost: the session's running total on a snapshot and in a `usage` op, the answer's on a run result. `inputTokens` excludes input read from or written to the provider's cache. */
export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly costUsd?: number;
}

/** A file sent with a message. The model saw its contents; `text` leaves them out. */
export interface UserAttachment {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly kind: "image" | "file" | "text";
}

export interface UserItem {
	readonly kind: "user";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly text: string;
	readonly via: "prompt" | "steer" | "followUp";
	readonly requestId?: string;
	readonly attachments?: readonly UserAttachment[];
}

/** @deprecated A `ConnectionApprovalCard` under its old type, `vault.approval`, as transcripts written before the rename carry it. Deprecated: a reader takes both types for one release. */
export interface VaultApprovalCard {
	readonly type: "vault.approval";
	/** The connection request's ID. */
	readonly proposalId: string;
	readonly status: "pending" | "approved" | "denied" | "expired" | "withdrawn";
	readonly bindingCode: string;
	readonly what: string;
	readonly why: string;
	readonly host: string;
	readonly methods: readonly string[];
	readonly pathPrefix: string;
	readonly injectionTemplate?: string;
	readonly termsSource: "agent-proposed" | "approved";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	readonly link: string;
	/** For an approval of one exact request a rule asked about (#333). Its headers and body are on the connection request page. */
	readonly request?: ConnectionApprovalRequest;
	/** The tool call waiting on this approval: a connection call's `callId`, or for a request a `codemode` script made, the script's inner call (`<scriptCallId>/<key>`, such as `toolu_01/c9`). A client that renders that call may show the approval in it and leave this card out; one that doesn't still has the card. Absent on cards written before it. */
	readonly callId?: string;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// Runtime

// The SDK's runtime, copied into `generated/sdk.ts` as it is, so the SDK is one file with no imports. Keep it free of
// imports and of anything but `fetch`.

export interface KantelClientOptions {
	/** The API's base URL with its version, such as `https://harbour.example/v1`, or `/v1` on the same origin. */
	readonly baseUrl: string;
	/**
	 * The bearer for every call: a host app's API key (`hbr_…`), or a function that gives one per call. Absent when the
	 * browser is signed in another way, such as Cloudflare Access's cookie.
	 */
	readonly token?: string | (() => string | undefined | Promise<string | undefined>);
	/** More headers for every call. */
	readonly headers?: () => { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * Opens a stream's WebSocket. Default the global `WebSocket`; with a bearer it passes `{ headers }`, which Node's
	 * (undici's) takes. A browser can't put a header on a socket, so in a browser the page must be signed in by cookie.
	 */
	readonly webSocket?: (url: string, headers: { readonly [name: string]: string }) => WebSocketLike;
}

/** The parts of a WHATWG WebSocket a stream uses. */
export interface WebSocketLike {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close(code?: number, reason?: string): void;
}

/** What a stream calls as frames arrive. */
export interface StreamHandlers<Frame> {
	/** The frames of one message, in order: `hello`, then a snapshot or the deltas after `after`, then live deltas. */
	onFrames(frames: readonly Frame[]): void;
	onOpen?(): void;
	/** The socket closed, by either side. Reconnect with `{ after: handle.cursor }` to resume. */
	onClose?(event: { readonly code: number; readonly reason: string }): void;
}

/** An open stream. */
export interface StreamHandle {
	/** The latest cursor the stream has sent (a hello's, a snapshot's or a delta's), to resume from. */
	readonly cursor: string | undefined;
	close(): void;
}

/** Per call. */
export interface CallOptions {
	readonly signal?: AbortSignal;
	/** Sent as `harbour-request-id`, which correlates the call in Kantel's audit trail. */
	readonly requestId?: string;
	/**
	 * Sent as `Idempotency-Key` on the calls that take one (their docs say so): a retry with the same key gets the first
	 * call's answer and does nothing again. Use a new key, such as a UUID, for each new call.
	 */
	readonly idempotencyKey?: string;
	readonly headers?: { readonly [name: string]: string };
}

/** An error Kantel answered with: its KantelError code (or `unauthenticated`), message and HTTP status. */
export class KantelApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: { readonly [key: string]: unknown };
	constructor(status: number, code: string, message: string, details?: { readonly [key: string]: unknown }) {
		super(message);
		this.name = "KantelApiError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/** One call, as the generated methods describe it. */
export interface ApiCall {
	readonly method: string;
	/** Relative to the base URL, with path parameters already encoded. */
	readonly path: string;
	/** Query parameters; a record value, such as `label`, is sent as `label.<key>=<value>`. */
	readonly query?: object;
	readonly body?: unknown;
	readonly headers?: { readonly [name: string]: string | undefined };
	/** The answer is bytes, such as an image, not JSON: the call resolves with a `Blob`. */
	readonly binary?: boolean;
}

const queryString = (query: object | undefined): string => {
	if (query === undefined) return "";
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			// A record, such as `label`: `label.<key>=<value>`.
			for (const [key, item] of Object.entries(value as { [key: string]: unknown })) {
				if (item !== undefined) params.append(`${name}.${key}`, String(item));
			}
		} else params.append(name, String(value));
	}
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
};

async function errorOf(response: Response): Promise<KantelApiError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
	const code =
		typeof error?.code === "string" ? error.code : response.status === 401 ? "unauthenticated" : "unavailable";
	const message = typeof error?.message === "string" ? error.message : `Kantel answered ${response.status}`;
	const details =
		typeof error?.details === "object" && error.details !== null
			? (error.details as { [key: string]: unknown })
			: undefined;
	return new KantelApiError(response.status, code, message, details);
}

/**
 * Sends one call and reads its JSON answer, or its bytes as a `Blob` for a `binary` call; a 204 resolves undefined.
 * Rejects with a `KantelApiError`.
 */
export async function send<T>(options: KantelClientOptions, call: ApiCall, callOptions: CallOptions = {}): Promise<T> {
	const headers: { [name: string]: string } = { accept: call.binary === true ? "*/*" : "application/json" };
	Object.assign(headers, (await options.headers?.()) ?? {});
	const token = typeof options.token === "function" ? await options.token() : options.token;
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (call.body !== undefined) headers["content-type"] = "application/json";
	if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
	if (callOptions.idempotencyKey !== undefined) headers["idempotency-key"] = callOptions.idempotencyKey;
	for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
	Object.assign(headers, callOptions.headers ?? {});
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
		method: call.method,
		headers,
		...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
	});
	if (!response.ok) throw await errorOf(response);
	if (response.status === 204) return undefined as T;
	if (call.binary === true) return (await response.blob()) as T;
	return (await response.json()) as T;
}

const cursorOf = (frame: unknown): string | undefined => {
	const value = frame as {
		type?: string;
		cursor?: string;
		snapshot?: { cursor?: string };
		delta?: { cursor?: string };
	};
	if (value.type === "snapshot") return value.snapshot?.cursor;
	if (value.type === "delta") return value.delta?.cursor;
	if (value.type === "hello") return value.cursor;
	return undefined;
};

function defaultWebSocket(url: string, headers: { readonly [name: string]: string }): WebSocketLike {
	const Socket = (globalThis as { WebSocket?: unknown }).WebSocket as
		| (new (
				url: string,
				init?: { headers: { readonly [name: string]: string } },
		  ) => WebSocketLike)
		| undefined;
	if (Socket === undefined) throw new KantelApiError(0, "not_supported", "This platform has no WebSocket");
	return Object.keys(headers).length === 0 ? new Socket(url) : new Socket(url, { headers });
}

/** Opens a stream route's WebSocket and hands each message's frames to `handlers`. */
export function openStream<Frame>(
	options: KantelClientOptions,
	call: ApiCall,
	handlers: StreamHandlers<Frame>,
	callOptions: CallOptions = {},
): StreamHandle {
	const base = options.baseUrl.replace(/\/+$/, "");
	const origin = (globalThis as { location?: { href?: string } }).location?.href;
	const url = new URL(`${base}${call.path}${queryString(call.query)}`, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
	let cursor: string | undefined;
	let socket: WebSocketLike | undefined;
	let closed = false;
	const handle: StreamHandle = {
		get cursor() {
			return cursor;
		},
		close() {
			closed = true;
			socket?.close(1000, "The client closed the stream");
		},
	};
	void (async () => {
		const headers: { [name: string]: string } = {};
		Object.assign(headers, (await options.headers?.()) ?? {});
		const token = typeof options.token === "function" ? await options.token() : options.token;
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
		Object.assign(headers, callOptions.headers ?? {});
		if (closed) return;
		socket = (options.webSocket ?? defaultWebSocket)(url.href, headers);
		socket.onopen = () => handlers.onOpen?.();
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let frames: unknown;
			try {
				frames = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!Array.isArray(frames) || frames.length === 0) return;
			for (const frame of frames) cursor = cursorOf(frame) ?? cursor;
			handlers.onFrames(frames as Frame[]);
		};
		socket.onerror = () => undefined;
		socket.onclose = (event) => {
			closed = true;
			handlers.onClose?.({ code: event.code, reason: event.reason });
		};
		callOptions.signal?.addEventListener("abort", () => handle.close(), { once: true });
	})().catch((error: unknown) => {
		closed = true;
		handlers.onClose?.({ code: 1006, reason: error instanceof Error ? error.message : "The stream failed to open" });
	});
	return handle;
}

// Client

/** Kantel's public API, one method per route. */
export interface KantelClient {
	/** Create a session. Starts a session of an agent profile in a project, and sends it `message` when there is one. Needs the operator role on the project. If the first message is refused, the session is closed and the refusal answered. `POST /sessions` */
	createSession(body: CreateSessionBody, options?: CallOptions): Promise<CreatedSession>;
	/** List sessions. The sessions the caller may see, newest first, a page at a time. `GET /sessions` */
	listSessions(query?: ListSessionsQuery, options?: CallOptions): Promise<SessionPage>;
	/** Get a session. `GET /sessions/{sessionId}` */
	getSession(sessionId: string, options?: CallOptions): Promise<SessionRecord>;
	/** Close a session. Ends the session for good: its sandbox leases, browser sessions and grants end. Closing a closed session does nothing. `POST /sessions/{sessionId}/close` */
	closeSession(sessionId: string, options?: CallOptions): Promise<void>;
	/** Abort a session's run. Interrupts the session's run in progress, and its child sessions' runs. The conversation keeps its history, and files the run changed stay changed; what the run held ends (its browsers, sandbox leases and grants). The run's result is `aborted`. The session stays open and takes new messages. `POST /sessions/{sessionId}/abort` */
	abortSession(sessionId: string, body?: AbortSessionBody, options?: CallOptions): Promise<void>;
	/** Fork a session from an answer. Starts a new session in the same project, with the same agent profile and workspace, whose history is this session's up to and including the answer `itemId` names: a second conversation that carries the first one's context and goes its own way. It starts idle. The source session is unchanged. Needs operator on the project; an item that is not an answer in the session's transcript is `not_found`. `POST /sessions/{sessionId}/fork` */
	forkSession(sessionId: string, body: ForkSessionBody, options?: CallOptions): Promise<SessionRecord>;
	/** Send a message. Sends the session's agent a message, `via` a prompt, a steer or a follow-up, optionally changing the session's `thinking` level from that run on. Only the session's first message may choose its `model`: once the session has started its model is fixed, and a message naming another is a `conflict`. The answer arrives on the session's stream, and `getRunResult` says when its run has ended. Send an `Idempotency-Key` so a retry can't send it twice: a retry with the same key answers the first call's submission without sending anything, and one with another `via` is a `conflict`. Idempotent with `options.idempotencyKey`. `POST /sessions/{sessionId}/messages` */
	sendMessage(sessionId: string, body: MessageBody, options?: CallOptions): Promise<Submission>;
	/** Wait for a message's run to end. How the run that a message started or joined ended: `answered` with its final answer, `failed` or `aborted`. Waits up to `timeoutMs` for it and answers 202 `pending` while it goes on, so a host that holds no stream polls this until it ends. A steer's result is the run that acted on it: the run in progress when the steer reached its next model call, or, when it arrived as that run gave its final answer, the run it started straight after on the same conversation. Needs viewer on the session. `GET /sessions/{sessionId}/result` */
	getRunResult(sessionId: string, query: RunResultQuery, options?: CallOptions): Promise<RunResult | PendingRun>;
	/** List the models a session may switch to. For a model and thinking picker: the models a message's `model` may name, what the session runs with now and what its agent profile names. Naming another model on a message switches the session from that run on (a steer's from the run's next model call) and keeps the conversation's context. Needs viewer on the session. `GET /sessions/{sessionId}/models` */
	getSessionModels(sessionId: string, options?: CallOptions): Promise<SessionModelState>;
	/** List the models a new session could use. What `getSessionModels` would answer for a session of this agent profile in `projectId`, before it exists, so a New session screen can offer the choice; the first message carries it. `selected` is `defaults`. Needs operator on the project, as creating the session does; `scope=organisation` with no `projectId` answers for a new organisation session, and needs operator across the organisation. `GET /profiles/{agentId}/models` */
	getNewSessionModels(
		agentId: string,
		query?: NewSessionModelsQuery,
		options?: CallOptions,
	): Promise<SessionModelState>;
	/** Warm a session's sandbox. A hint that a message is coming, such as when someone starts typing: the session's sandbox gets ready for its next command, so it waits for no start. Its container starts only if the session has used one. Idempotent and cheap to repeat; send it at most every few seconds. Needs the operator role on the session. `POST /sessions/{sessionId}/warm` */
	warmSession(sessionId: string, options?: CallOptions): Promise<SessionWarmth>;
	/** Stream a session. The session as `@kantel/protocol` frames: `hello`, then a `snapshot` of its state and latest items (or, with `after`, the deltas after that cursor when the stream still holds them), then a `delta` for every change, live. Fold them with the protocol's `applyFrames`. Over a WebSocket, compressed where the platform can, or as server-sent events. `GET /sessions/{sessionId}/stream` */
	streamSession(
		sessionId: string,
		handlers: StreamHandlers<ServerFrame>,
		query?: StreamQuery,
		options?: CallOptions,
	): StreamHandle;
	/** Page back through a session. The session's transcript in pages, newest first, for scrolling back past a snapshot's items: start with `before` set to the snapshot's `items[0].id`, then follow `nextCursor`. `GET /sessions/{sessionId}/history` */
	getSessionHistory(sessionId: string, query?: HistoryQuery, options?: CallOptions): Promise<SessionHistoryPage>;
	/** Read an image in a session's transcript. The bytes of an image a tool item names by reference (`images[].url`), such as a screenshot or a generated image: snapshots, deltas and history pages carry the reference, not the image. `imageId` is the SHA-256 of the image's bytes in lowercase hex, so the same URL always answers the same bytes, and the answer may be cached for good (`cache-control: private, max-age=31536000, immutable`). The model still reads the image itself. Needs viewer on the session; an ID the session's transcript doesn't name is `not_found`. `GET /sessions/{sessionId}/images/{imageId}` */
	getSessionImage(sessionId: string, imageId: string, options?: CallOptions): Promise<Blob>;
	/** List skills. The published skills the caller sees, by name: the platform's, the organisation's, the project's named by `projectId` and, for a person, their own. Never another project's or another person's. `GET /skills` */
	listSkills(query?: ListSkillsQuery, options?: CallOptions): Promise<SkillListingPage>;
	/** Get a skill. `GET /skills/{skillId}` */
	getSkill(skillId: string, options?: CallOptions): Promise<SkillPackage>;
	/** List a skill's revisions. `GET /skills/{skillId}/revisions` */
	listSkillRevisions(skillId: string, query?: PageQuery, options?: CallOptions): Promise<SkillRevisionPage>;
	/** Get a revision. A published revision: its digest, its files' paths and sizes, who published it and where it came from. `GET /skills/{skillId}/revisions/{revision}` */
	getSkillRevision(skillId: string, revision: string, options?: CallOptions): Promise<SkillRevision>;
	/** Read a file of a revision. One file of a published revision, such as its `SKILL.md`, by its path in the package. `GET /skills/{skillId}/revisions/{revision}/file` */
	readSkillFile(
		skillId: string,
		revision: string,
		query: SkillFileQuery,
		options?: CallOptions,
	): Promise<SkillFileContent>;
	/** Import a skill from a host's source. A host adapter's publish path: creates the skill if needed and publishes the files as its next revision, once per `source` (`sourceId` and `ref`); files identical to the latest revision publish nothing. People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role. `POST /skills/import` */
	importSkill(body: ImportSkillBody, options?: CallOptions): Promise<SkillRevision>;
	/** List an owner's prompt rules. The platform's, the organisation's, a project's or a user's rules, in order. A project's need the viewer role on it; the others are open to the organisation. `GET /rules` */
	listPromptRules(query: ListPromptRulesQuery, options?: CallOptions): Promise<PromptRuleList>;
	/** The rules a new session would get. Platform, organisation, project (for a project session) and user rules, in the order they wrap the profile's own prompt: platform, organisation, project, profile, user. A session keeps the rules it started with. `GET /rules/resolved` */
	resolvePromptRules(query?: ResolvedPromptRulesQuery, options?: CallOptions): Promise<PromptRuleList>;
	/** Get a prompt rule. `GET /rules/{ruleId}` */
	getPromptRule(ruleId: string, options?: CallOptions): Promise<PromptRule>;
	/** Create or replace a prompt rule. Creates the owner's rule of that name, or replaces its text and order. The organisation's rules need an organisation-wide admin, a project's an admin on it, a user's that user or an organisation-wide admin; agents never write rules. Audited as `rules.rule.put`, without the text. `PUT /rules` */
	putPromptRule(body: PutPromptRuleBody, options?: CallOptions): Promise<PromptRule>;
	/** Remove a prompt rule. Needs what writing it needs. New sessions stop getting it; running ones keep theirs. `DELETE /rules/{ruleId}` */
	removePromptRule(ruleId: string, options?: CallOptions): Promise<PromptRule>;
	/** List memory spaces. The spaces the caller may read, oldest first: the organisation's, a project's to those who may view it, and a person's own. A person never sees another person's space. `GET /memory/spaces` */
	listMemorySpaces(query?: PageQuery, options?: CallOptions): Promise<MemorySpacePage>;
	/** Create a memory space. People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role. `POST /memory/spaces` */
	createMemorySpace(body: CreateMemorySpaceBody, options?: CallOptions): Promise<MemorySpace>;
	/** List a space's concepts. By ID, every status unless `status` names one. `GET /memory/spaces/{spaceId}/concepts` */
	listConcepts(spaceId: string, query?: ListConceptsQuery, options?: CallOptions): Promise<ConceptPage>;
	/** Get a concept. `GET /memory/spaces/{spaceId}/concepts/{conceptId}` */
	getConcept(spaceId: string, conceptId: string, options?: CallOptions): Promise<Concept>;
	/** Search memory. Keyword search over the named spaces' concepts, best first, as a person browsing them would. `POST /memory/search` */
	searchMemory(body: MemorySearchBody, options?: CallOptions): Promise<MemorySearchResult>;
	/** Recall memory for a task. What a session would be given for this query: the profile, the best matches (BM25) and their exceptions, rendered, with a manifest of what was recalled and why. `POST /memory/recall` */
	recallMemory(body: RecallBody, options?: CallOptions): Promise<Recall>;
	/** Load a snapshot into a space. A host adapter's load path: the space's concepts become the snapshot's, recorded with its source and ref, so every recall names what it read. People and API keys only; a deployment may ask for more. `POST /memory/spaces/{spaceId}/snapshot` */
	importMemorySnapshot(spaceId: string, body: MemorySnapshot, options?: CallOptions): Promise<MemorySpace>;
	/** List schedules. The organisation's schedules the caller may see, a page at a time. A project's schedules are listed only to those with the viewer role on it. `GET /schedules` */
	listSchedules(query?: ListSchedulesQuery, options?: CallOptions): Promise<SchedulePage>;
	/** Create a schedule. Exactly one of `at` (a one-off) and `repeat`. A task's runs each start a session, in the schedule's project (the default project for one owned by the organisation or a user), running the payload's agent with its prompt sent exactly as written. Agents may not create schedules. Needs the operator role on a project-owned schedule's project. `POST /schedules` */
	createSchedule(body: CreateScheduleBody, options?: CallOptions): Promise<Schedule>;
	/** Get a schedule. `GET /schedules/{scheduleId}` */
	getSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** Change a schedule. Changes the fields given and works out the next due time again. A change that leaves the schedule never due again ends it. `PATCH /schedules/{scheduleId}` */
	updateSchedule(scheduleId: string, body?: UpdateScheduleBody, options?: CallOptions): Promise<Schedule>;
	/** Pause a schedule. Nothing runs while it is paused. `POST /schedules/{scheduleId}/pause` */
	pauseSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** Resume a paused schedule. Runs from the next due time after now; the paused time is not made up. `POST /schedules/{scheduleId}/resume` */
	resumeSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** End a schedule. Ends the schedule for good: nothing more runs. It stays listed, as `ended`, with its run history and the sessions its runs started. Ending an ended schedule does nothing. `DELETE /schedules/{scheduleId}` */
	deleteSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** Preview a schedule's next due times. `GET /schedules/{scheduleId}/preview` */
	previewSchedule(scheduleId: string, query?: PreviewScheduleQuery, options?: CallOptions): Promise<SchedulePreview>;
	/** List a schedule's runs. The run history, a page at a time: each occurrence's status and times, and its result. A task's result names the session it started (`sessionId`). `GET /schedules/{scheduleId}/runs` */
	listScheduleRuns(scheduleId: string, query?: PageQuery, options?: CallOptions): Promise<OccurrencePage>;
	/** Embed a session's browser. A link for an iframe: a watch-only live view of one of the session's open browsers, or a replay of one, open or closed. Needs viewer on the session; never an agent. The link carries a short-lived token scoped to that one view (never control), lasting `minutes`. A closed browser has no live view (`expired`); a deployment whose browsers keep no recordings has no replay (`unavailable`), and a recording past its retention is `expired`. Audited as `browser.session.embedded`, without the link. `POST /sessions/{sessionId}/browsers/{browserSessionId}/embed` */
	embedBrowserSession(
		sessionId: string,
		browserSessionId: string,
		body: EmbedBrowserBody,
		options?: CallOptions,
	): Promise<BrowserEmbed>;
	/** List a workspace's shares. The live shares of the workspace's files, or of one file, with their invites. Needs viewer on it. `GET /workspaces/{workspaceId}/shares` */
	listShares(workspaceId: string, query?: ListSharesQuery, options?: CallOptions): Promise<FileSharePage>;
	/** Share a file. The file's share, made if it has none: a file has one live share, and sharing it again returns that one unchanged. A new share is `restricted` unless `access` says otherwise. Needs operator on the workspace's project, as a person (never an agent or an API key). Audited as `workspace.share.created`, without the token. `POST /workspaces/{workspaceId}/shares` */
	shareFile(workspaceId: string, body: ShareFileBody, options?: CallOptions): Promise<FileShare>;
	/** Get a share. `GET /shares/{shareId}` */
	getShare(shareId: string, options?: CallOptions): Promise<FileShare>;
	/** Set a share's general access. `link` lets anyone with the link read the file; `restricted` stops the link at once, and `link` again restarts the same link. Needs operator, as a person. Audited as `workspace.share.changed`. `PATCH /shares/{shareId}` */
	updateShare(shareId: string, body?: UpdateShareBody, options?: CallOptions): Promise<FileShare>;
	/** Revoke a share. Its link stops for good; sharing the file again makes a new link. Needs operator, as a person. Audited as `workspace.share.revoked`. `DELETE /shares/{shareId}` */
	revokeShare(shareId: string, options?: CallOptions): Promise<FileShare>;
	/** Invite someone by email. Adds the email to the share's invites (one already invited stays as it is). Kantel stores and lists invites but sends no email, and an invite grants no access of its own. Needs operator, as a person. `POST /shares/{shareId}/invites` */
	inviteToShare(shareId: string, body: ShareInviteBody, options?: CallOptions): Promise<FileShare>;
	/** Remove an invite. `POST /shares/{shareId}/invites/remove` */
	removeShareInvite(shareId: string, body: ShareInviteBody, options?: CallOptions): Promise<FileShare>;
	/** List resource shares. Newest first, active ones unless `includeInactive`. Filter by resource, grantee or `ownerProjectId`. Each share is listed only to those who may read it: viewer on the owner's or the grantee's project, or authority over the resource. `GET /sharing/shares` */
	listResourceShares(query?: ListResourceSharesQuery, options?: CallOptions): Promise<ResourceSharePage>;
	/** Share a resource. Needs authority over the resource: `approver` on it, or admin where it lives. An agent may only pass on a share it holds (`parentShareId`) to a session it supervises, never wider, later or at another revision. Audited as `sharing.share.created`. `POST /sharing/shares` */
	createResourceShare(body: CreateResourceShareBody, options?: CallOptions): Promise<ResourceShare>;
	/** Get a resource share. `GET /sharing/shares/{shareId}` */
	getResourceShare(shareId: string, options?: CallOptions): Promise<ResourceShare>;
	/** Revoke a resource share. Revokes it and every share passed on from it; revoking a revoked share returns it unchanged. Needs authority over the resource, admin on the grantee's project (detaching it), or for a passed-on share, the session that passed it on. New uses and later reads stop at once. `POST /sharing/shares/{shareId}/revoke` */
	revokeResourceShare(shareId: string, body?: RevokeResourceShareBody, options?: CallOptions): Promise<ResourceShare>;
	/** List access requests. Newest first. `decidable=true` lists the caller's inbox: the pending requests it may decide. `GET /sharing/requests` */
	listAccessRequests(query?: ListAccessRequestsQuery, options?: CallOptions): Promise<AccessRequestPage>;
	/** Request access to a resource. Goes to the resource owner's approvers, not the requesting project's admins. Needs operator on the grantee's project; the grantee defaults to the call's project. Audited as `sharing.request.created`. `POST /sharing/requests` */
	requestAccess(body: RequestAccessBody, options?: CallOptions): Promise<AccessRequest>;
	/** Get an access request. `GET /sharing/requests/{requestId}` */
	getAccessRequest(requestId: string, options?: CallOptions): Promise<AccessRequest>;
	/** Withdraw an access request. Only the requester, while it is pending (`conflict` after). `POST /sharing/requests/{requestId}/withdraw` */
	withdrawAccessRequest(requestId: string, options?: CallOptions): Promise<AccessRequest>;
	/** Grant or reject an access request. Once (`conflict` after), by someone with authority over the resource, never by an agent. A grant makes the share in the same write and may narrow what was asked. `POST /sharing/requests/{requestId}/decision` */
	decideAccessRequest(
		requestId: string,
		body: DecideAccessRequestBody,
		options?: CallOptions,
	): Promise<AccessRequestDecided>;
	/** List bindings. Relation tuples: who maintains or approves a resource, and who is in a group. `GET /sharing/bindings` */
	listResourceBindings(query?: ListBindingsQuery, options?: CallOptions): Promise<ResourceBindingPage>;
	/** Add a binding. Needs authority over the resource, or organisation admin for a group. Adding one already there returns it. `POST /sharing/bindings` */
	addResourceBinding(body: BindingBody, options?: CallOptions): Promise<ResourceBinding>;
	/** Remove a binding. Removing a binding that isn't there does nothing. `POST /sharing/bindings/remove` */
	removeResourceBinding(body: BindingBody, options?: CallOptions): Promise<void>;
	/** Get a resource's policy. `GET /sharing/policies` */
	getResourcePolicy(query: ResourceQuery, options?: CallOptions): Promise<ResourcePolicy>;
	/** Set a resource's policy. Such as the two-person rule. Needs authority over the resource. `PUT /sharing/policies` */
	setResourcePolicy(body: SetResourcePolicyBody, options?: CallOptions): Promise<ResourcePolicy>;
	/** Register a host's resource. Tells Kantel who owns one of the host's own resources, so it can be shared. Idempotent; the owner can't change. Kantel's own kinds are `invalid`. `POST /sharing/resources` */
	registerResource(body: RegisterResourceBody, options?: CallOptions): Promise<RegisteredResource>;
	/** What a session used through shares. Each resource once, with the revision and the share it was used through: a session's provenance. `GET /sharing/uses` */
	listShareUses(query: ListShareUsesQuery, options?: CallOptions): Promise<ShareUseList>;
	/** Get how this deployment runs connections. Whether a person's own connections work in every session acting for them (`personal`, a deployment with one person), or only where they are shared, since a session is seen by its project. A client can warn before someone makes a connection no session could use. Anyone signed in may read it. `GET /connections/settings` */
	getConnectionsSettings(options?: CallOptions): Promise<ConnectionsSettings>;
	/** List the provider catalogue. The provider templates the caller can use: Kantel's, the deployment's and the organisation's own, filtered by category, auth type, kind or a search. Each says whether the caller can connect it now (`setup: ready`) or needs an OAuth app registered first (`needs_client`, with the tiers that could register one). No secrets. `GET /connections/catalogue` */
	listCatalogue(
		query?: {
			readonly category?: ProviderCategory;
			/** How a connection authenticates. */
			readonly authType?: ConnectionAuthType;
			/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
			readonly kind?: ConnectionKind;
			/** Matches the name, ID, description and category. */
			readonly q?: string;
			readonly limit?: number;
			/** A previous page's `nextCursor`. */
			readonly cursor?: string;
		},
		options?: CallOptions,
	): Promise<CataloguePage>;
	/** Get a provider template. `GET /connections/catalogue/{templateId}` */
	getProviderTemplate(templateId: string, options?: CallOptions): Promise<ProviderTemplate>;
	/** Inspect a remote MCP server. Reads a remote MCP server's protected-resource metadata and its authorisation server's metadata, without sending any credential: whether it needs a sign-in, and how Kantel would get a client (a pre-registered client, the deployment's client ID metadata document, or dynamic registration). `POST /connections/discover` */
	discoverMcpServer(
		body: {
			/** The server's Streamable HTTP endpoint, https. */
			readonly url: string;
		},
		options?: CallOptions,
	): Promise<McpDiscovery>;
	/** Start an OAuth connect. Starts connecting a template or a remote MCP server for an owner (an organisation, a project or a person). Answers a pending attempt with a `connectUrl` on this deployment that expires after 15 minutes and works once; the person it is for opens it and signs in at the provider. An open server is connected at once (`completed`). `refused` with `no_client` when the template needs an OAuth app nobody has registered. Creating needs admin on the owner, or being the person for their own. `POST /connections/connect` */
	startConnect(
		body: {
			/** A catalogue template. Give this or `mcpUrl`. */
			readonly templateId?: string;
			/** A remote MCP server's endpoint, for a server with no template. */
			readonly mcpUrl?: string;
			/** Who owns a connection: an organisation, a project or a person. */
			readonly owner: ConnectionOwner;
			readonly name?: string;
			/** Scope sets to ask for; default the template's default sets. */
			readonly scopeSets?: readonly string[];
			/** Explicit scopes, added to the sets'. */
			readonly scopes?: readonly string[];
			/** Where a connection may be used, by whom and in which sessions. */
			readonly usage?: ConnectionUsage;
			/** A handover link: the person who must complete it. Default the caller. */
			readonly forUserId?: string;
			/** Reconnect or widen this connection, keeping its ID. */
			readonly connectionId?: string;
			/** Where the final page sends the person afterwards. */
			readonly returnTo?: string;
		},
		options?: CallOptions,
	): Promise<ConnectAttempt>;
	/** Get a connect attempt. Its status: pending, completed (with the connection), failed (with why) or expired. `GET /connections/connect/{attemptId}` */
	getConnectAttempt(attemptId: string, options?: CallOptions): Promise<ConnectAttempt>;
	/** Connect with a key. Stores a key connection for a template with a key auth type, or a custom service with its https hosts and how the key goes out. The key is write-only: no answer, event or log carries it. `POST /connections/keys` */
	connectKey(
		body: {
			/** A template with a key auth type. Give this or `custom`. */
			readonly templateId?: string;
			readonly custom?: {
				/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
				readonly kind: ConnectionKind;
				/** https hosts the key may be sent to. */
				readonly hosts: readonly string[];
				/** How a key goes out on a request. */
				readonly injection: KeyInjection;
				readonly mcpUrl?: string;
			};
			/** Who owns a connection: an organisation, a project or a person. */
			readonly owner: ConnectionOwner;
			readonly name?: string;
			/** The key. Write-only: never returned. For `basic` injection, `username:password` (split at the first colon; no colon: the user name with an empty password). */
			readonly value: string;
			/** Where a connection may be used, by whom and in which sessions. */
			readonly usage?: ConnectionUsage;
		},
		options?: CallOptions,
	): Promise<Connection>;
	/** List connection uses. Which connection a session used, at which step, acting for whom, and who could see the session then; filtered by connection or session, newest first. A use in a private session is listed whole only to the connection's owner, the person the session acted for and whoever may open the session now. Anyone else, an organisation or project admin included, gets it as a `RedactedConnectionUse`: when, how it ended and for whom, with no session, step or request. Naming the session is `forbidden` to them. `GET /connections/uses` */
	listConnectionUses(
		query?: {
			readonly connectionId?: string;
			readonly sessionId?: string;
			readonly limit?: number;
			/** A previous page's `nextCursor`. */
			readonly cursor?: string;
		},
		options?: CallOptions,
	): Promise<ConnectionUsePage>;
	/** Which connections a session may use. Each connection that could reach the session (its organisation's, its project's, its person's and people's shared with its project), whether the session may use it, and if not, why: the same check every request goes through (#335). `visibility` answers as if the session had it, for a page offering the choice. Needs viewer on the session; another person's connection that doesn't reach it shows no account. `GET /connections/eligible` */
	listSessionConnections(
		query: {
			/** The session. */
			readonly sessionId: string;
			/** Answer as if the session had this visibility. Default its own. */
			readonly visibility?: "private" | "shared";
		},
		options?: CallOptions,
	): Promise<SessionConnections>;
	/** List OAuth clients. The OAuth app registrations the caller may see: the deployment's, the organisation's, its projects' and their own. Each shows only whether a secret is set and its last four characters, and the redirect URI to register. `GET /connections/clients` */
	listOAuthClients(
		query?: {
			readonly templateId?: string;
			/** The tenancy level an OAuth client belongs to; `platform` is the deployment. */
			readonly tier?: OAuthClientTier;
			readonly limit?: number;
			/** A previous page's `nextCursor`. */
			readonly cursor?: string;
		},
		options?: CallOptions,
	): Promise<OAuthClientPage>;
	/** Register an OAuth client. Registers an OAuth app at a tenancy level, for a template or an authorisation server. The deployment's need a system or deployment operator, an organisation's its admin, a project's its admin, a person's that person. `POST /connections/clients` */
	createOAuthClient(
		body: {
			/** Who owns a record: an organisation, a project, a user, or the platform. */
			readonly owner: OwnerRef;
			readonly templateId?: string;
			readonly issuer?: string;
			readonly label: string;
			readonly clientId: string;
			/** Write-only. A public client has none. */
			readonly clientSecret?: string;
			readonly scopes?: readonly string[];
			readonly redirectDomain?: string;
		},
		options?: CallOptions,
	): Promise<OAuthClient>;
	/** Get an OAuth client. `GET /connections/clients/{oauthClientId}` */
	getOAuthClient(oauthClientId: string, options?: CallOptions): Promise<OAuthClient>;
	/** Change an OAuth client. Its label, scopes, redirect domain, secret (write-only) or whether it is disabled. Disabling stops new connections through it; connections pinned to it keep working and refreshing. `PATCH /connections/clients/{oauthClientId}` */
	updateOAuthClient(
		oauthClientId: string,
		body?: {
			readonly label?: string;
			/** Replaces the secret. Write-only. */
			readonly clientSecret?: string;
			readonly scopes?: readonly string[];
			readonly redirectDomain?: string;
			readonly disabled?: boolean;
		},
		options?: CallOptions,
	): Promise<OAuthClient>;
	/** Remove an OAuth client. `conflict`, naming how many, while any connection is pinned to it. `DELETE /connections/clients/{oauthClientId}` */
	removeOAuthClient(oauthClientId: string, options?: CallOptions): Promise<void>;
	/** Have GitHub create a GitHub App. Starts GitHub's app manifest flow: answers `url`, a page on this deployment that posts a manifest for a GitHub App to GitHub (on the person's account, or `githubOrganisation`'s). Once the person chooses Create there, GitHub sends them back and Kantel stores the app's client as an OAuth client for the `github` template at `owner`'s tier, its secret write-only. A person only, with the same rights as registering that client by hand. The flow must finish within an hour; `url` holds its single-use state and is only in this answer. `POST /connections/github-app` */
	startGitHubApp(
		body: {
			/** Whose client the app becomes: the caller's organisation, a project (`projectId`) or the caller. */
			readonly owner: "organisation" | "project" | "user";
			readonly projectId?: string;
			/** The GitHub organisation to create it in; the person's own GitHub account when absent. */
			readonly githubOrganisation?: string;
			/** Where GitHub's redirect back ends up: a path on this deployment, or an https URL. */
			readonly returnTo?: string;
		},
		options?: CallOptions,
	): Promise<GitHubAppSetup>;
	/** Get a GitHub App manifest flow. Where it has got to: pending, created (with the OAuth client and the app), failed or expired. `GET /connections/github-app/{setupId}` */
	getGitHubApp(setupId: string, options?: CallOptions): Promise<GitHubAppSetup>;
	/** Get the organisation's ceiling. The hosts, methods and paths any connection may reach in this organisation. No rule may allow or ask outside it, and a request outside it is denied whatever a rule says. `set: false` when there is none. Anyone in the organisation may read it. `GET /connections/ceiling` */
	getConnectionCeiling(options?: CallOptions): Promise<ConnectionCeiling>;
	/** Set the organisation's ceiling. Replaces the ceiling. Rules already saved stay, but a request outside the new ceiling is denied from the next one. Needs organisation admin; agents are refused. `not_supported` where the deployment keeps no ceiling. `PUT /connections/ceiling` */
	setConnectionCeiling(
		body: {
			readonly routes: readonly RouteScope[];
		},
		options?: CallOptions,
	): Promise<ConnectionCeiling>;
	/** List connections. The connections the caller may see: the organisation's, its projects' and their own, with their owner, account, usage and credential state. Never a secret. `GET /connections` */
	listConnections(
		query?: {
			readonly ownerKind?: "organisation" | "project" | "user";
			readonly ownerId?: string;
			readonly templateId?: string;
			/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API. */
			readonly kind?: ConnectionKind;
			readonly limit?: number;
			/** A previous page's `nextCursor`. */
			readonly cursor?: string;
		},
		options?: CallOptions,
	): Promise<ConnectionPage>;
	/** Get a connection. `GET /connections/{connectionId}` */
	getConnection(connectionId: string, options?: CallOptions): Promise<Connection>;
	/** Change a connection. Its name, usage (where, by whom and in which sessions it may be used) or whether it is disabled. Takes effect on the next use. Needs admin on the owner, or being the person for their own. `PATCH /connections/{connectionId}` */
	updateConnection(
		connectionId: string,
		body?: {
			readonly name?: string;
			/** Where a connection may be used, by whom and in which sessions. */
			readonly usage?: ConnectionUsage;
			readonly status?: "active" | "disabled";
		},
		options?: CallOptions,
	): Promise<Connection>;
	/** Disconnect a connection. Stops every use at once, asks the provider to revoke its tokens where the provider can (RFC 7009, or the provider's own endpoint), destroys the stored credential, and removes the connection with its rules and any approvals not yet used. A revoke the provider refuses still removes it: `revocation` says what happened upstream, and the `connections.connection.removed` audit event records the same. Its uses and audit history stay. `DELETE /connections/{connectionId}` */
	removeConnection(connectionId: string, options?: CallOptions): Promise<ConnectionRemoval>;
	/** Replace a connection's key. Replaces a key connection's value in place: its ID, usage and history stay. Write-only. `POST /connections/{connectionId}/key` */
	rotateConnectionKey(
		connectionId: string,
		body: {
			/** The new key. Write-only: never returned. */
			readonly value: string;
		},
		options?: CallOptions,
	): Promise<Connection>;
	/** Share a person's connection with a project. Only its owner, as a person, into a project where they hold operator. Every attended session in the project may then use it, whoever it acts for and whoever can see it; its rules still decide each request, and unattended sessions never get it. Sharing again changes nothing. Audited as `connections.connection.shared` (#335). `POST /connections/{connectionId}/shares` */
	shareConnection(
		connectionId: string,
		body: {
			/** The project to share it with. */
			readonly projectId: string;
		},
		options?: CallOptions,
	): Promise<Connection>;
	/** Stop sharing a connection with a project. Its owner, or an admin of the project. The project's next request through it is refused and recorded as denied. Audited as `connections.connection.unshared` (#335). `DELETE /connections/{connectionId}/shares/{projectId}` */
	unshareConnection(connectionId: string, projectId: string, options?: CallOptions): Promise<Connection>;
	/** What a connection can reach. Asks the provider, through the connection, what it can reach now (#461). For GitHub: the installations of the app the person can reach (`GET /user/installations`) and each one's repositories, at most 300, with `truncated` when there are more. Only someone who manages the connection (admin on its owner, or the person for their own); never an agent. `not_supported` for a provider Kantel can't ask. Never answers a secret. `GET /connections/{connectionId}/reach` */
	getConnectionReach(connectionId: string, options?: CallOptions): Promise<ConnectionReach>;
	/** List a connection's access rules. Who may use it for what, and on what terms (`allow`, `ask` or `deny`), with what a request no rule matches gets (`unmatched`) and the rules' version. A connection made before rules is given its template's defaults (reads allow, writes ask, deletes deny, `unmatched` ask) the first time its rules are read, and `defaults` says when. Needs viewer on the connection's owner. `GET /connections/{connectionId}/rules` */
	getConnectionRules(connectionId: string, options?: CallOptions): Promise<ConnectionRules>;
	/** Change what unmatched requests get, or reset the defaults. Sets `unmatched`, or with `reset: template` replaces the template's default rules (reads allow, writes ask, deletes deny) and sets `unmatched` to ask, keeping people's own rules. Needs admin on the owner, or being the person for their own. `PATCH /connections/{connectionId}/rules` */
	updateConnectionRules(
		connectionId: string,
		body?: {
			/** What a rule answers. `ask` goes to an approval (#333). */
			readonly unmatched?: ConnectionRuleAction;
			/** Replace the `default` rules with the template's (reads allow, writes ask, deletes deny) and set `unmatched` to ask. */
			readonly reset?: "template";
		},
		options?: CallOptions,
	): Promise<ConnectionRules>;
	/** Add an access rule. Adds a rule naming who (any agent, organisation-level agents, a project, an agent or a session), what (any request, a method and path pattern, or an MCP tool) and the terms, with an optional expiry and use limit. `refused` when an allow or ask rule reaches outside the organisation's ceiling or names a project or agent the connection's usage never admits. Takes effect on the next request. Needs admin on the owner, or being the person for their own; agents are refused. `POST /connections/{connectionId}/rules` */
	createConnectionRule(
		connectionId: string,
		body: {
			/** Who a rule is for: any agent, organisation-level agents (sessions in no project), a project, an agent profile or one session. */
			readonly who: ConnectionRuleWho;
			/** What a rule covers: any request, an API endpoint by method and path pattern, or one MCP tool. */
			readonly what: ConnectionRuleWhat;
			/** What a rule answers. `ask` goes to an approval (#333). */
			readonly action: ConnectionRuleAction;
			/** Epoch milliseconds, UTC. */
			readonly expiresAt?: number;
			readonly maxUses?: number;
			readonly note?: string;
		},
		options?: CallOptions,
	): Promise<ConnectionRule>;
	/** Always allow requests like an approved one. Saves an allow rule from an approval of one exact request (#333), marked `source: approval` with its ID, as its own act the person can see and stop. The approval must be for a request through this connection, still open or approved, and the rule must cover that request. Checked as adding a rule is, with the same rights: admin on the owner, or being the person for their own. The approval itself is decided apart, on the connection request. `POST /connections/{connectionId}/rules/from-approval` */
	createConnectionRuleFromApproval(
		connectionId: string,
		body: {
			/** The approval of one exact request through this connection, still open or approved. */
			readonly approvalId: string;
			/** An allow rule that covers the approved request, for the agent and session that sent it. */
			readonly rule: {
				/** Who a rule is for: any agent, organisation-level agents (sessions in no project), a project, an agent profile or one session. */
				readonly who: ConnectionRuleWho;
				/** What a rule covers: any request, an API endpoint by method and path pattern, or one MCP tool. */
				readonly what: ConnectionRuleWhat;
				readonly action: "allow";
				/** Epoch milliseconds, UTC. */
				readonly expiresAt?: number;
				readonly maxUses?: number;
				readonly note?: string;
			};
		},
		options?: CallOptions,
	): Promise<ConnectionRule>;
	/** Try a request against a connection's rules. What the proxy would do with this request from a session like the one described, and what decides it: a rule, `unmatched`, the ceiling, or the connection's owner and usage. The same function as the real decision. Writes no use and opens no secret. Needs viewer on the connection's owner. `POST /connections/{connectionId}/rules/dry-run` */
	dryRunConnectionRequest(
		connectionId: string,
		body: {
			readonly method: HttpMethod;
			/** The full URL. For an MCP connection, default its server's. */
			readonly url?: string;
			/** For an MCP connection: the tool to call. Without it, listing. */
			readonly tool?: string;
			readonly agentId?: string;
			readonly projectId?: string;
			readonly sessionId?: string;
			/** The person the session acts for. Default the caller; `null` for an unattended session. */
			readonly actingUserId?: string | null;
			/** Who can see the session. Default `private` in a one-person deployment, else `shared`. */
			readonly audience?: "private" | "shared";
		},
		options?: CallOptions,
	): Promise<ConnectionDecision>;
	/** Change an access rule. Changes a rule's who, what, terms, expiry, use limit or note; `null` clears an expiry, limit or note. Checked as a new rule is. Takes effect on the next request. `PATCH /connections/{connectionId}/rules/{ruleId}` */
	updateConnectionRule(
		connectionId: string,
		ruleId: string,
		body?: {
			/** Who a rule is for: any agent, organisation-level agents (sessions in no project), a project, an agent profile or one session. */
			readonly who?: ConnectionRuleWho;
			/** What a rule covers: any request, an API endpoint by method and path pattern, or one MCP tool. */
			readonly what?: ConnectionRuleWhat;
			/** What a rule answers. `ask` goes to an approval (#333). */
			readonly action?: ConnectionRuleAction;
			/** When it stops matching, or `null` for never. */
			readonly expiresAt?: number | null;
			/** A use limit, or `null` for none. */
			readonly maxUses?: number | null;
			/** A note, or `null` to clear it. */
			readonly note?: string | null;
		},
		options?: CallOptions,
	): Promise<ConnectionRule>;
	/** Remove an access rule. Takes effect on the next request through any instance. `DELETE /connections/{connectionId}/rules/{ruleId}` */
	removeConnectionRule(connectionId: string, ruleId: string, options?: CallOptions): Promise<void>;
	/** Create a project. Creates a project in the caller's organisation, which the `harbour-organisation` header names for a person in more than one. Needs an organisation-wide admin, or an organisation API key with the `create_projects` permission; a project key is refused, whatever its role. An organisation key holds its role on the new project at once. Audited as `identity.project.created`, with the caller as its actor. `POST /projects` */
	createProject(body: CreateProjectBody, options?: CallOptions): Promise<Project>;
	/** List tool servers. The tool servers the caller may read, by name: the organisation's and its projects'. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `GET /tool-servers` */
	listToolServers(
		query?: {
			/** Only this project's servers and the organisation's: what its sessions could see. */
			readonly projectId?: string;
			readonly limit?: number;
			/** A previous page's `nextCursor`. */
			readonly cursor?: string;
		},
		options?: CallOptions,
	): Promise<ToolServerPage>;
	/** Register a tool server. Registers an MCP server for the organisation or one of its projects; needs admin on the owner. The name is unique in the organisation (`conflict` otherwise). A `tunnel` server comes with its first tunnel token, shown in this answer only. Only `tunnel` is accepted yet. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `POST /tool-servers` */
	createToolServer(
		body: {
			/** The owning project; leave it out for a server the organisation owns. */
			readonly projectId?: string;
			/** Lower-case letters, digits and single hyphens, at most 32 characters. Can't be changed. */
			readonly name: string;
			readonly description?: string;
			/** How Kantel reaches the server: `tunnel`, the server's side dials out over a WebSocket; `http`, Streamable HTTP to a public URL; `callback`, signed HTTPS host callbacks. Only `tunnel` is built yet. */
			readonly transport: ToolServerTransport;
		},
		options?: CallOptions,
	): Promise<CreatedToolServer>;
	/** Get a tool server. The server, whether its side is connected, and its latest tools. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `GET /tool-servers/{toolServerId}` */
	getToolServer(toolServerId: string, options?: CallOptions): Promise<ToolServer>;
	/** Change a tool server. Its description, or which tools are disabled. A disabled tool isn't offered to new sessions; one a session was offered already stays in its list, which never changes under it, and its calls answer an error result. Needs admin on the owner. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `PATCH /tool-servers/{toolServerId}` */
	updateToolServer(
		toolServerId: string,
		body?: {
			readonly description?: string;
			/** Replaces the disabled list. */
			readonly disabledTools?: readonly string[];
		},
		options?: CallOptions,
	): Promise<ToolServer>;
	/** Remove a tool server. Removes the server and its tokens and closes its tunnel. Needs admin on the owner. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `DELETE /tool-servers/{toolServerId}` */
	removeToolServer(toolServerId: string, options?: CallOptions): Promise<void>;
	/** List a tool server's tunnel tokens. Each token's ID, prefix and when it was made and last used; never the token. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `GET /tool-servers/{toolServerId}/tokens` */
	listToolServerTokens(toolServerId: string, options?: CallOptions): Promise<ToolServerTokenList>;
	/** Make a tunnel token. A new tunnel token, `hbt_…`, shown in this answer only; Kantel keeps its hash. Older tokens keep working until revoked. Needs operator on the owner. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `POST /tool-servers/{toolServerId}/tokens` */
	createToolServerToken(toolServerId: string, options?: CallOptions): Promise<IssuedToolServerToken>;
	/** Revoke a tunnel token. Revokes the token and closes any tunnel it opened. Needs operator on the owner. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `DELETE /tool-servers/{toolServerId}/tokens/{tokenId}` */
	revokeToolServerToken(toolServerId: string, tokenId: string, options?: CallOptions): Promise<void>;
	/** Get a tool server's tools. The latest snapshot of the server's `tools/list`, each tool with whether it is enabled, the name the model sees (`<server>__<tool>`), and why a session couldn't be offered it, such as a name too long. Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`. `GET /tool-servers/{toolServerId}/tools` */
	getToolServerTools(toolServerId: string, options?: CallOptions): Promise<ToolServerTools>;
	/** List programs. The programs of the projects the caller may view, by name. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `GET /programs` */
	listPrograms(query?: ListProgramsQuery, options?: CallOptions): Promise<ProgramList>;
	/** Save a new program. Saves a program and its version 1; needs operator on the project. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `POST /programs` */
	createProgram(body: CreateProgramBody, options?: CallOptions): Promise<Program>;
	/** Get a program. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `GET /programs/{programId}` */
	getProgram(programId: string, options?: CallOptions): Promise<Program>;
	/** Delete a program. Deletes the program and every version; its runs' sessions stay. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `DELETE /programs/{programId}` */
	removeProgram(programId: string, options?: CallOptions): Promise<void>;
	/** List a program's versions. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `GET /programs/{programId}/versions` */
	listProgramVersions(programId: string, options?: CallOptions): Promise<ProgramVersionList>;
	/** Save a program's next version. Versions are immutable and numbered from 1; needs operator on the project. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `POST /programs/{programId}/versions` */
	createProgramVersion(
		programId: string,
		body: CreateProgramVersionBody,
		options?: CallOptions,
	): Promise<ProgramVersion>;
	/** Get a program version. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `GET /programs/{programId}/versions/{version}` */
	getProgramVersion(programId: string, version: string, options?: CallOptions): Promise<ProgramVersion>;
	/** Delete a program version. A deleted version can't run; its number is never reused. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `DELETE /programs/{programId}/versions/{version}` */
	removeProgramVersion(programId: string, version: string, options?: CallOptions): Promise<void>;
	/** Run a program. Runs a version (default the latest) with `input`, checked against its input schema, in a session of its own as the caller, with no model: code mode runs the program, whose tool calls go through the same rules, approvals and audit as any session's. Needs operator on the project. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. Idempotent with `options.idempotencyKey`. `POST /programs/{programId}/runs` */
	runProgram(programId: string, body?: RunProgramBody, options?: CallOptions): Promise<ProgramRun>;
	/** List a program's runs. The newest 100 runs, newest first. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `GET /programs/{programId}/runs` */
	listProgramRuns(programId: string, options?: CallOptions): Promise<ProgramRunList>;
	/** Get a program run. Its status, and its output or error once it has ended. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `GET /programs/{programId}/runs/{runId}` */
	getProgramRun(programId: string, runId: string, options?: CallOptions): Promise<ProgramRun>;
	/** Cancel a program run. Stops a running run (its session's run is aborted); an ended run is answered as it is. Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`. `POST /programs/{programId}/runs/{runId}/cancel` */
	cancelProgramRun(programId: string, runId: string, options?: CallOptions): Promise<ProgramRun>;
}

/** A client for Kantel's public API over `fetch`. */
export function createKantelClient(options: KantelClientOptions): KantelClient {
	return {
		createSession: (body, callOptions) => send(options, { method: "POST", path: "/sessions", body }, callOptions),
		listSessions: (query, callOptions) => send(options, { method: "GET", path: "/sessions", query }, callOptions),
		getSession: (sessionId, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}` }, callOptions),
		closeSession: (sessionId, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/close` }, callOptions),
		abortSession: (sessionId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/abort`, body }, callOptions),
		forkSession: (sessionId, body, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/fork`, body }, callOptions),
		sendMessage: (sessionId, body, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/messages`, body }, callOptions),
		getRunResult: (sessionId, query, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/result`, query }, callOptions),
		getSessionModels: (sessionId, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/models` }, callOptions),
		getNewSessionModels: (agentId, query, callOptions) =>
			send(options, { method: "GET", path: `/profiles/${encodeURIComponent(agentId)}/models`, query }, callOptions),
		warmSession: (sessionId, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/warm` }, callOptions),
		streamSession: (sessionId, handlers, query, callOptions) =>
			openStream(
				options,
				{ method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/stream`, query },
				handlers,
				callOptions,
			),
		getSessionHistory: (sessionId, query, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/history`, query }, callOptions),
		getSessionImage: (sessionId, imageId, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`,
					binary: true,
				},
				callOptions,
			),
		listSkills: (query, callOptions) => send(options, { method: "GET", path: "/skills", query }, callOptions),
		getSkill: (skillId, callOptions) =>
			send(options, { method: "GET", path: `/skills/${encodeURIComponent(skillId)}` }, callOptions),
		listSkillRevisions: (skillId, query, callOptions) =>
			send(options, { method: "GET", path: `/skills/${encodeURIComponent(skillId)}/revisions`, query }, callOptions),
		getSkillRevision: (skillId, revision, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revision)}` },
				callOptions,
			),
		readSkillFile: (skillId, revision, query, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revision)}/file`,
					query,
				},
				callOptions,
			),
		importSkill: (body, callOptions) => send(options, { method: "POST", path: "/skills/import", body }, callOptions),
		listPromptRules: (query, callOptions) => send(options, { method: "GET", path: "/rules", query }, callOptions),
		resolvePromptRules: (query, callOptions) =>
			send(options, { method: "GET", path: "/rules/resolved", query }, callOptions),
		getPromptRule: (ruleId, callOptions) =>
			send(options, { method: "GET", path: `/rules/${encodeURIComponent(ruleId)}` }, callOptions),
		putPromptRule: (body, callOptions) => send(options, { method: "PUT", path: "/rules", body }, callOptions),
		removePromptRule: (ruleId, callOptions) =>
			send(options, { method: "DELETE", path: `/rules/${encodeURIComponent(ruleId)}` }, callOptions),
		listMemorySpaces: (query, callOptions) =>
			send(options, { method: "GET", path: "/memory/spaces", query }, callOptions),
		createMemorySpace: (body, callOptions) =>
			send(options, { method: "POST", path: "/memory/spaces", body }, callOptions),
		listConcepts: (spaceId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/memory/spaces/${encodeURIComponent(spaceId)}/concepts`, query },
				callOptions,
			),
		getConcept: (spaceId, conceptId, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/memory/spaces/${encodeURIComponent(spaceId)}/concepts/${encodeURIComponent(conceptId)}`,
				},
				callOptions,
			),
		searchMemory: (body, callOptions) => send(options, { method: "POST", path: "/memory/search", body }, callOptions),
		recallMemory: (body, callOptions) => send(options, { method: "POST", path: "/memory/recall", body }, callOptions),
		importMemorySnapshot: (spaceId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/memory/spaces/${encodeURIComponent(spaceId)}/snapshot`, body },
				callOptions,
			),
		listSchedules: (query, callOptions) => send(options, { method: "GET", path: "/schedules", query }, callOptions),
		createSchedule: (body, callOptions) => send(options, { method: "POST", path: "/schedules", body }, callOptions),
		getSchedule: (scheduleId, callOptions) =>
			send(options, { method: "GET", path: `/schedules/${encodeURIComponent(scheduleId)}` }, callOptions),
		updateSchedule: (scheduleId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/schedules/${encodeURIComponent(scheduleId)}`, body }, callOptions),
		pauseSchedule: (scheduleId, callOptions) =>
			send(options, { method: "POST", path: `/schedules/${encodeURIComponent(scheduleId)}/pause` }, callOptions),
		resumeSchedule: (scheduleId, callOptions) =>
			send(options, { method: "POST", path: `/schedules/${encodeURIComponent(scheduleId)}/resume` }, callOptions),
		deleteSchedule: (scheduleId, callOptions) =>
			send(options, { method: "DELETE", path: `/schedules/${encodeURIComponent(scheduleId)}` }, callOptions),
		previewSchedule: (scheduleId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/schedules/${encodeURIComponent(scheduleId)}/preview`, query },
				callOptions,
			),
		listScheduleRuns: (scheduleId, query, callOptions) =>
			send(options, { method: "GET", path: `/schedules/${encodeURIComponent(scheduleId)}/runs`, query }, callOptions),
		embedBrowserSession: (sessionId, browserSessionId, body, callOptions) =>
			send(
				options,
				{
					method: "POST",
					path: `/sessions/${encodeURIComponent(sessionId)}/browsers/${encodeURIComponent(browserSessionId)}/embed`,
					body,
				},
				callOptions,
			),
		listShares: (workspaceId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/workspaces/${encodeURIComponent(workspaceId)}/shares`, query },
				callOptions,
			),
		shareFile: (workspaceId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/workspaces/${encodeURIComponent(workspaceId)}/shares`, body },
				callOptions,
			),
		getShare: (shareId, callOptions) =>
			send(options, { method: "GET", path: `/shares/${encodeURIComponent(shareId)}` }, callOptions),
		updateShare: (shareId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/shares/${encodeURIComponent(shareId)}`, body }, callOptions),
		revokeShare: (shareId, callOptions) =>
			send(options, { method: "DELETE", path: `/shares/${encodeURIComponent(shareId)}` }, callOptions),
		inviteToShare: (shareId, body, callOptions) =>
			send(options, { method: "POST", path: `/shares/${encodeURIComponent(shareId)}/invites`, body }, callOptions),
		removeShareInvite: (shareId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/shares/${encodeURIComponent(shareId)}/invites/remove`, body },
				callOptions,
			),
		listResourceShares: (query, callOptions) =>
			send(options, { method: "GET", path: "/sharing/shares", query }, callOptions),
		createResourceShare: (body, callOptions) =>
			send(options, { method: "POST", path: "/sharing/shares", body }, callOptions),
		getResourceShare: (shareId, callOptions) =>
			send(options, { method: "GET", path: `/sharing/shares/${encodeURIComponent(shareId)}` }, callOptions),
		revokeResourceShare: (shareId, body = {}, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sharing/shares/${encodeURIComponent(shareId)}/revoke`, body },
				callOptions,
			),
		listAccessRequests: (query, callOptions) =>
			send(options, { method: "GET", path: "/sharing/requests", query }, callOptions),
		requestAccess: (body, callOptions) =>
			send(options, { method: "POST", path: "/sharing/requests", body }, callOptions),
		getAccessRequest: (requestId, callOptions) =>
			send(options, { method: "GET", path: `/sharing/requests/${encodeURIComponent(requestId)}` }, callOptions),
		withdrawAccessRequest: (requestId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sharing/requests/${encodeURIComponent(requestId)}/withdraw` },
				callOptions,
			),
		decideAccessRequest: (requestId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sharing/requests/${encodeURIComponent(requestId)}/decision`, body },
				callOptions,
			),
		listResourceBindings: (query, callOptions) =>
			send(options, { method: "GET", path: "/sharing/bindings", query }, callOptions),
		addResourceBinding: (body, callOptions) =>
			send(options, { method: "POST", path: "/sharing/bindings", body }, callOptions),
		removeResourceBinding: (body, callOptions) =>
			send(options, { method: "POST", path: "/sharing/bindings/remove", body }, callOptions),
		getResourcePolicy: (query, callOptions) =>
			send(options, { method: "GET", path: "/sharing/policies", query }, callOptions),
		setResourcePolicy: (body, callOptions) =>
			send(options, { method: "PUT", path: "/sharing/policies", body }, callOptions),
		registerResource: (body, callOptions) =>
			send(options, { method: "POST", path: "/sharing/resources", body }, callOptions),
		listShareUses: (query, callOptions) => send(options, { method: "GET", path: "/sharing/uses", query }, callOptions),
		getConnectionsSettings: (callOptions) =>
			send(options, { method: "GET", path: "/connections/settings" }, callOptions),
		listCatalogue: (query, callOptions) =>
			send(options, { method: "GET", path: "/connections/catalogue", query }, callOptions),
		getProviderTemplate: (templateId, callOptions) =>
			send(options, { method: "GET", path: `/connections/catalogue/${encodeURIComponent(templateId)}` }, callOptions),
		discoverMcpServer: (body, callOptions) =>
			send(options, { method: "POST", path: "/connections/discover", body }, callOptions),
		startConnect: (body, callOptions) =>
			send(options, { method: "POST", path: "/connections/connect", body }, callOptions),
		getConnectAttempt: (attemptId, callOptions) =>
			send(options, { method: "GET", path: `/connections/connect/${encodeURIComponent(attemptId)}` }, callOptions),
		connectKey: (body, callOptions) => send(options, { method: "POST", path: "/connections/keys", body }, callOptions),
		listConnectionUses: (query, callOptions) =>
			send(options, { method: "GET", path: "/connections/uses", query }, callOptions),
		listSessionConnections: (query, callOptions) =>
			send(options, { method: "GET", path: "/connections/eligible", query }, callOptions),
		listOAuthClients: (query, callOptions) =>
			send(options, { method: "GET", path: "/connections/clients", query }, callOptions),
		createOAuthClient: (body, callOptions) =>
			send(options, { method: "POST", path: "/connections/clients", body }, callOptions),
		getOAuthClient: (oauthClientId, callOptions) =>
			send(options, { method: "GET", path: `/connections/clients/${encodeURIComponent(oauthClientId)}` }, callOptions),
		updateOAuthClient: (oauthClientId, body = {}, callOptions) =>
			send(
				options,
				{ method: "PATCH", path: `/connections/clients/${encodeURIComponent(oauthClientId)}`, body },
				callOptions,
			),
		removeOAuthClient: (oauthClientId, callOptions) =>
			send(
				options,
				{ method: "DELETE", path: `/connections/clients/${encodeURIComponent(oauthClientId)}` },
				callOptions,
			),
		startGitHubApp: (body, callOptions) =>
			send(options, { method: "POST", path: "/connections/github-app", body }, callOptions),
		getGitHubApp: (setupId, callOptions) =>
			send(options, { method: "GET", path: `/connections/github-app/${encodeURIComponent(setupId)}` }, callOptions),
		getConnectionCeiling: (callOptions) => send(options, { method: "GET", path: "/connections/ceiling" }, callOptions),
		setConnectionCeiling: (body, callOptions) =>
			send(options, { method: "PUT", path: "/connections/ceiling", body }, callOptions),
		listConnections: (query, callOptions) => send(options, { method: "GET", path: "/connections", query }, callOptions),
		getConnection: (connectionId, callOptions) =>
			send(options, { method: "GET", path: `/connections/${encodeURIComponent(connectionId)}` }, callOptions),
		updateConnection: (connectionId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/connections/${encodeURIComponent(connectionId)}`, body }, callOptions),
		removeConnection: (connectionId, callOptions) =>
			send(options, { method: "DELETE", path: `/connections/${encodeURIComponent(connectionId)}` }, callOptions),
		rotateConnectionKey: (connectionId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/connections/${encodeURIComponent(connectionId)}/key`, body },
				callOptions,
			),
		shareConnection: (connectionId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/connections/${encodeURIComponent(connectionId)}/shares`, body },
				callOptions,
			),
		unshareConnection: (connectionId, projectId, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/connections/${encodeURIComponent(connectionId)}/shares/${encodeURIComponent(projectId)}`,
				},
				callOptions,
			),
		getConnectionReach: (connectionId, callOptions) =>
			send(options, { method: "GET", path: `/connections/${encodeURIComponent(connectionId)}/reach` }, callOptions),
		getConnectionRules: (connectionId, callOptions) =>
			send(options, { method: "GET", path: `/connections/${encodeURIComponent(connectionId)}/rules` }, callOptions),
		updateConnectionRules: (connectionId, body = {}, callOptions) =>
			send(
				options,
				{ method: "PATCH", path: `/connections/${encodeURIComponent(connectionId)}/rules`, body },
				callOptions,
			),
		createConnectionRule: (connectionId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/connections/${encodeURIComponent(connectionId)}/rules`, body },
				callOptions,
			),
		createConnectionRuleFromApproval: (connectionId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/connections/${encodeURIComponent(connectionId)}/rules/from-approval`, body },
				callOptions,
			),
		dryRunConnectionRequest: (connectionId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/connections/${encodeURIComponent(connectionId)}/rules/dry-run`, body },
				callOptions,
			),
		updateConnectionRule: (connectionId, ruleId, body = {}, callOptions) =>
			send(
				options,
				{
					method: "PATCH",
					path: `/connections/${encodeURIComponent(connectionId)}/rules/${encodeURIComponent(ruleId)}`,
					body,
				},
				callOptions,
			),
		removeConnectionRule: (connectionId, ruleId, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/connections/${encodeURIComponent(connectionId)}/rules/${encodeURIComponent(ruleId)}`,
				},
				callOptions,
			),
		createProject: (body, callOptions) => send(options, { method: "POST", path: "/projects", body }, callOptions),
		listToolServers: (query, callOptions) =>
			send(options, { method: "GET", path: "/tool-servers", query }, callOptions),
		createToolServer: (body, callOptions) =>
			send(options, { method: "POST", path: "/tool-servers", body }, callOptions),
		getToolServer: (toolServerId, callOptions) =>
			send(options, { method: "GET", path: `/tool-servers/${encodeURIComponent(toolServerId)}` }, callOptions),
		updateToolServer: (toolServerId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/tool-servers/${encodeURIComponent(toolServerId)}`, body }, callOptions),
		removeToolServer: (toolServerId, callOptions) =>
			send(options, { method: "DELETE", path: `/tool-servers/${encodeURIComponent(toolServerId)}` }, callOptions),
		listToolServerTokens: (toolServerId, callOptions) =>
			send(options, { method: "GET", path: `/tool-servers/${encodeURIComponent(toolServerId)}/tokens` }, callOptions),
		createToolServerToken: (toolServerId, callOptions) =>
			send(options, { method: "POST", path: `/tool-servers/${encodeURIComponent(toolServerId)}/tokens` }, callOptions),
		revokeToolServerToken: (toolServerId, tokenId, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/tool-servers/${encodeURIComponent(toolServerId)}/tokens/${encodeURIComponent(tokenId)}`,
				},
				callOptions,
			),
		getToolServerTools: (toolServerId, callOptions) =>
			send(options, { method: "GET", path: `/tool-servers/${encodeURIComponent(toolServerId)}/tools` }, callOptions),
		listPrograms: (query, callOptions) => send(options, { method: "GET", path: "/programs", query }, callOptions),
		createProgram: (body, callOptions) => send(options, { method: "POST", path: "/programs", body }, callOptions),
		getProgram: (programId, callOptions) =>
			send(options, { method: "GET", path: `/programs/${encodeURIComponent(programId)}` }, callOptions),
		removeProgram: (programId, callOptions) =>
			send(options, { method: "DELETE", path: `/programs/${encodeURIComponent(programId)}` }, callOptions),
		listProgramVersions: (programId, callOptions) =>
			send(options, { method: "GET", path: `/programs/${encodeURIComponent(programId)}/versions` }, callOptions),
		createProgramVersion: (programId, body, callOptions) =>
			send(options, { method: "POST", path: `/programs/${encodeURIComponent(programId)}/versions`, body }, callOptions),
		getProgramVersion: (programId, version, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/programs/${encodeURIComponent(programId)}/versions/${encodeURIComponent(version)}` },
				callOptions,
			),
		removeProgramVersion: (programId, version, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/programs/${encodeURIComponent(programId)}/versions/${encodeURIComponent(version)}`,
				},
				callOptions,
			),
		runProgram: (programId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/programs/${encodeURIComponent(programId)}/runs`, body }, callOptions),
		listProgramRuns: (programId, callOptions) =>
			send(options, { method: "GET", path: `/programs/${encodeURIComponent(programId)}/runs` }, callOptions),
		getProgramRun: (programId, runId, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/programs/${encodeURIComponent(programId)}/runs/${encodeURIComponent(runId)}` },
				callOptions,
			),
		cancelProgramRun: (programId, runId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/programs/${encodeURIComponent(programId)}/runs/${encodeURIComponent(runId)}/cancel` },
				callOptions,
			),
	};
}
