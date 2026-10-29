import { createPasskeyClient } from "@harbour/identity/passkey/http";
import { Button, Notice, SignInScreen, Spinner } from "@harbour/ui";
import { StrictMode, Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import longUrl from "../../../fixtures/sessions/long-2000.jsonl?url";
import smallUrl from "../../../fixtures/sessions/small.jsonl?url";
import { apiAgent } from "./api/agent-http.ts";
import { apiAudit } from "./api/audit-http.ts";
import { withLocalCache } from "./api/cached.ts";
import type { ConsoleClient } from "./api/client.ts";
import { createApiClient, type TransportKind } from "./api/http.ts";
import { type ConsoleBoot, createConsoleIdentity, memoryTokens, storageTokens } from "./api/identity.ts";
import { apiKeys } from "./api/keys.ts";
import { apiMembers, type ConsoleMembers } from "./api/members.ts";
import type { ConsoleAgent, ConsoleAudit, ConsoleKeys, ConsoleSchedules, ConsoleVault } from "./api/oversight.ts";
import { createRecordedClient, type RecordedClient } from "./api/recorded.ts";
import { apiSchedules } from "./api/schedules-http.ts";
import { apiVault } from "./api/vault-http.ts";
import { App, ShellPlaceholder } from "./app/app.tsx";
import { createRecordedAgent } from "./recorded/agent.ts";
import { createCatalogue } from "./recorded/catalogue.ts";
import { createRecordedOversight, type RecordedOversight } from "./recorded/oversight.ts";
import { createRecordedSchedules } from "./recorded/schedules.ts";
import { cacheSwitch, indexedDbCacheStore, openLocalCache } from "./state/local-cache.ts";
import type { SessionClient } from "./state/session-client.ts";
import { profileStore } from "./ui/profile.tsx";
import { BrowserViewerPage, viewOf } from "./viewer/viewer.tsx";
import "./ui/styles.css";

// The console runs on one of two sources:
// - `api` (the default): the session API on this origin under /v1, as the gateway serves it. `pnpm dev` proxies it
//   to a local gateway (vite.config.ts).
// - `recorded`: recorded sessions in the page, a session in every state, served by in-page stand-ins for the session
//   host over @harbour/protocol. No backend. `?speed=2` plays them faster; `?delay=1500` waits longer before an
//   opened session's live part plays.
// `?source=recorded` or `?source=api` picks one for this tab; `VITE_HARBOUR_SOURCE` sets the default for a build.
// `?profile=1` adds the render profiler.
//
// On `api` the console asks `GET /v1/me` first (api/identity.ts). Signed in, the sidebar names the person and lists
// their projects by name. A 401, then or later, shows Harbour's email-code sign-in where the deployment signs people
// in that way (self-hosted), and asks for a reload where Access does it at the edge.
//
// The vault page and audit log follow the source. On `api` the vault page runs on the vault approval API and the audit
// log on the audit query API (M1-BE8), both served by the gateway on this origin; the vault page is listed once the
// approval API has said who is signed in, and not at all on a gateway without one. The audit log's vault rows link to
// the vault page only when it is there, and its project, agent and session filters come from the session API. On `recorded` both run on the
// in-memory vault and audit store in the page (recorded/oversight.ts).
//
// On `api` the API keys page runs on the key routes (`/v1/keys`) for an operator or above; recorded has none.
// The members page, with an admin's passkey reset (`/v1/members`), is listed only for an organisation admin.
//
// The skills and memory pages follow the source too: on `api` the public API's skills and memory routes (`/v1/skills`,
// `/v1/memory`), read-only; on `recorded` @harbour/ui's fixture stores in the page, with authoring and proposals.
//
// The schedules page runs on @harbour/ui's schedule fixtures on `recorded`, its task runs linking to the recorded
// sessions. On `api` it runs on the public API's schedule routes (`/v1/schedules`, api/schedules-http.ts); New
// schedule needs a project the person may operate in and an agent profile to ask.
//
// On `api` the audit log's Who and Organisation filters, and the names rows and schedules give people, come from the
// identity API (`/v1/organisations`, `/v1/members`).

const params = new URLSearchParams(location.search);
const SOURCE_KEY = "harbour.console.source";
const asked = params.get("source");
if (asked === "api" || asked === "recorded") sessionStorage.setItem(SOURCE_KEY, asked);
const source = sessionStorage.getItem(SOURCE_KEY) ?? import.meta.env.VITE_HARBOUR_SOURCE ?? "api";

// How a session's events come on `api`: over a compressed WebSocket by default, or as server-sent events with
// `?transport=sse` (kept for the tab, like the source; `?transport=websocket` goes back). The switch is for comparing
// the two and for a network that mangles sockets; without a socket the client falls back by itself.
const TRANSPORT_KEY = "harbour.console.transport";
const askedTransport = params.get("transport");
if (askedTransport === "sse" || askedTransport === "websocket") sessionStorage.setItem(TRANSPORT_KEY, askedTransport);
const sockets = sessionStorage.getItem(TRANSPORT_KEY) !== "sse";
/** How each session's events came, for the evidence script. */
const transports = new Map<string, TransportKind>();

// The evidence script reads the open session's client and host from the page, and the vault fixture's proposals.
let current: { sessionId: string; session: SessionClient } | undefined;
let proposals: Readonly<Record<string, string>> | undefined;
let recorded: RecordedClient | undefined;
let client: ConsoleClient | undefined;
const catalogue = source === "recorded" ? createCatalogue(Date.now(), { long: longUrl, small: smallUrl }) : undefined;
if (catalogue !== undefined) {
	recorded = createRecordedClient(catalogue, {
		speed: Number(params.get("speed") ?? "1") || 1,
		openDelayMs: Number(params.get("delay") ?? "600"),
		// With ?profile=1 the Profiler counts start here, with the rows already shown as the baseline.
		onPlay: (sessionId) => {
			if (current?.sessionId === sessionId) {
				profileStore?.reset(current.session.getState().items.map((item) => item.id));
			}
		},
	});
	client = recorded;
}

Object.assign(window, {
	__harbour: {
		source,
		get client() {
			return current?.session;
		},
		get host() {
			return current === undefined ? undefined : recorded?.hostFor(current.sessionId);
		},
		get proposals() {
			return proposals;
		},
		get transport() {
			return current === undefined ? undefined : transports.get(current.sessionId);
		},
	},
});
const onOpen = (sessionId: string, session: SessionClient) => {
	current = { sessionId, session };
};

type Oversight = {
	readonly vault?: ConsoleVault;
	readonly audit?: ConsoleAudit;
	readonly keys?: ConsoleKeys;
	readonly members?: ConsoleMembers;
	readonly schedules?: ConsoleSchedules;
	readonly agent?: ConsoleAgent;
};
const recordedOversight: Promise<Oversight> | undefined =
	catalogue !== undefined
		? Promise.all([
				createRecordedOversight(),
				// A schedule's task runs name the recorded Harbour project's sessions, so their links open.
				createRecordedSchedules(
					catalogue.sessions.filter((session) => session.projectId === "harbour").map((session) => session.id),
				),
				createRecordedAgent(),
			]).then(([made, schedules, agent]: [RecordedOversight, ConsoleSchedules, ConsoleAgent]): Oversight => {
				proposals = made.proposals;
				return { vault: made.vault, audit: made.audit, schedules, agent };
			})
		: undefined;

/** The console once its vault page and audit log are known: recorded ones, or the API's. */
function OversightConsole({ client, oversight }: { client: ConsoleClient; oversight: Promise<Oversight> }) {
	return <Console client={client} oversight={use(oversight)} />;
}

function Console({
	client,
	oversight,
	pending = false,
}: {
	client: ConsoleClient;
	oversight: Oversight;
	/** True while more of the organisation's pages may still come. */
	pending?: boolean;
}) {
	const { vault, audit, keys, members, schedules, agent } = oversight;
	return (
		<App
			client={client}
			oversightPending={pending}
			{...(vault === undefined ? {} : { vault })}
			{...(audit === undefined ? {} : { audit })}
			{...(keys === undefined ? {} : { keys })}
			{...(members === undefined ? {} : { members })}
			{...(schedules === undefined ? {} : { schedules })}
			{...(agent === undefined ? {} : { agent })}
			onOpen={onOpen}
		/>
	);
}

const identity = createConsoleIdentity({ tokens: hasStorage() ? storageTokens(localStorage) : memoryTokens() });

function hasStorage(): boolean {
	try {
		return typeof localStorage !== "undefined" && localStorage !== null;
	} catch {
		return false;
	}
}

// This browser's cache of what the console last showed (state/local-cache.ts), so a reload shows it at once: per
// person, opened once `/v1/me` has said who is signed in, and cleared on signing out or a 401. `?cache=off` turns it off
// (and clears it) for this browser; `?cache=on` turns it back on.
const cacheOn = cacheSwitch(params, hasStorage() ? localStorage : undefined);
const cacheStore = (() => {
	try {
		return indexedDbCacheStore(typeof indexedDB === "undefined" ? undefined : indexedDB);
	} catch {
		return undefined;
	}
})();
/** Bumped by each clear, so a cache opened before it stops reading and writing. */
let cacheGeneration = 0;
const forgetCache = (): Promise<void> => {
	cacheGeneration += 1;
	return cacheStore?.clear().catch(() => {}) ?? Promise.resolve();
};
// Opening IndexedDB takes a while on a cold start, so it opens beside `/v1/me` rather than after it.
if (!cacheOn) void forgetCache();
else if (source === "api") void cacheStore?.keys().catch(() => {});

/** This person's cache, for as long as it isn't cleared. */
function openCache(store: NonNullable<typeof cacheStore>, owner: string) {
	const generation = cacheGeneration;
	return openLocalCache(store, owner, { open: () => generation === cacheGeneration });
}

type Boot = ConsoleBoot | { readonly kind: "failed"; readonly message: string };
const boot = (): Promise<Boot> =>
	identity.boot().then(
		(state) => {
			// Nobody is signed in: nothing anyone was shown stays behind.
			if (state.kind !== "signed-in") void forgetCache();
			return state;
		},
		(reason: unknown) => ({
			kind: "failed" as const,
			message: reason instanceof Error ? reason.message : String(reason),
		}),
	);

// Started here, not in render: a component that suspends before it mounts loses its state, so a promise made in
// render would be made again on every retry.
// A view link (`/browser/<browser>#<token>`) is a page of its own: one browser, live or replayed, with no sign-in and nothing
// of the console (src/viewer/viewer.tsx).
const viewing = viewOf(location.pathname, location.hash);
const firstBoot: Promise<Boot> | undefined = source === "recorded" || viewing !== undefined ? undefined : boot();

/** The console on the API: who is signed in first, then the shell, or the way to sign in. */
function ApiConsole({ first }: { first: Promise<Boot> }) {
	const [booting, setBooting] = useState(first);
	const reboot = useCallback(() => setBooting(boot()), []);
	// Awaited in an effect rather than suspended on: React holds a Suspense boundary's fallback for at least 300 ms, which
	// was most of a reload's wait once `/v1/me` answers in a fraction of that.
	const [answer, setAnswer] = useState<{ for: Promise<Boot>; state: Boot }>();
	useEffect(() => {
		let live = true;
		void booting.then((state) => live && setAnswer({ for: booting, state }));
		return () => {
			live = false;
		};
	}, [booting]);
	if (answer?.for !== booting) return <ShellPlaceholder />;
	const { state } = answer;
	if (state.kind === "signed-in") return <SignedInConsole state={state} onSignedOut={reboot} />;
	if (state.kind === "sign-in") {
		return (
			<div className="boot hb-app">
				<SignInScreen api={state.api} onSignedIn={reboot} />
			</div>
		);
	}
	return (
		<div className="boot hb-app">
			<Notice
				level={state.kind === "failed" ? "error" : "info"}
				action={
					<Button size="sm" onClick={() => location.reload()}>
						Reload
					</Button>
				}
			>
				{state.kind === "failed"
					? `Harbour can't open the console right now. ${state.message}`
					: "You're signed out. Reload the page to sign in."}
			</Notice>
		</div>
	);
}

function SignedInConsole({
	state,
	onSignedOut,
}: {
	state: Extract<ConsoleBoot, { kind: "signed-in" }>;
	onSignedOut: () => void;
}) {
	const made = useMemo(() => {
		let over = false;
		const onUnauthenticated = () => {
			if (over) return;
			over = true;
			identity.forget();
			void forgetCache();
			onSignedOut();
		};
		// Signing out clears this browser's cache before the session ends.
		const { signOut } = state.actor;
		const actor =
			signOut === undefined
				? state.actor
				: {
						...state.actor,
						signOut: async () => {
							await forgetCache();
							await signOut();
						},
					};
		// The cache is this person's: their organisation and who `/v1/me` says they are.
		const owner = `${state.me.organisationId}/${JSON.stringify(state.me.actor)}`;
		const api = createApiClient({
			actor,
			roles: state.me.roles,
			headers: state.headers,
			onUnauthenticated,
			...(sockets ? {} : { openSocket: false }),
			onTransport: (sessionId, how) => transports.set(sessionId, how),
		});
		// Rows about a vault request link to its page, when the console has the vault page to open it on.
		const audit = (vaultRequests: boolean) => apiAudit({ headers: state.headers, vaultRequests });
		const keys = apiKeys(identity.client, state.me);
		const members = apiMembers(identity.client, createPasskeyClient({ headers: state.headers }), state.me);
		const agent = {
			...apiAgent({ headers: state.headers, onUnauthenticated }),
			...(state.me.actor.kind === "human" ? { viewer: state.me.actor.userId } : {}),
		};
		return {
			client: cacheOn && cacheStore !== undefined ? withLocalCache(api, openCache(cacheStore, owner)) : api,
			// What needs no answer first, so the console opens without waiting for the vault and schedules to answer.
			ready: {
				agent,
				...(keys === undefined ? {} : { keys }),
				...(members === undefined ? {} : { members }),
			} satisfies Oversight,
			// The vault page is listed once the approval API has said who is signed in, and not on a gateway without one.
			oversight: Promise.all([
				apiVault({ headers: state.headers }).then(
					(vault) => vault,
					(error: unknown) => {
						console.info("harbour: no vault page:", error instanceof Error ? error.message : error);
						return undefined;
					},
				),
				apiSchedules(state.me, { headers: state.headers, onUnauthenticated }),
			]).then(
				([vault, schedules]): Oversight => ({
					...(vault === undefined ? {} : { vault }),
					audit: audit(vault !== undefined),
					agent,
					schedules,
					...(keys === undefined ? {} : { keys }),
					...(members === undefined ? {} : { members }),
				}),
			),
		};
	}, [state, onSignedOut]);
	// The console opens at once; the vault page, audit log and schedules join the sidebar when they have answered.
	const [oversight, setOversight] = useState<{ for: typeof made; value: Oversight }>();
	useEffect(() => {
		let live = true;
		made.oversight.then(
			(value) => live && setOversight({ for: made, value }),
			(reason: unknown) => {
				console.info("harbour: no organisation pages:", reason instanceof Error ? reason.message : reason);
				if (live) setOversight({ for: made, value: made.ready });
			},
		);
		return () => {
			live = false;
		};
	}, [made]);
	const answered = oversight?.for === made ? oversight.value : undefined;
	return <Console client={made.client} oversight={answered ?? made.ready} pending={answered === undefined} />;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Suspense
			fallback={
				viewing === undefined ? (
					// The shell's frame while the console learns who is signed in: no page-wide spinner on a reload.
					<ShellPlaceholder />
				) : (
					<div className="boot hb-app">
						<Spinner label="Opening the console" />
					</div>
				)
			}
		>
			{viewing !== undefined ? (
				<BrowserViewerPage view={viewing} />
			) : client !== undefined && recordedOversight !== undefined ? (
				<OversightConsole client={client} oversight={recordedOversight} />
			) : firstBoot !== undefined ? (
				<ApiConsole first={firstBoot} />
			) : null}
		</Suspense>
	</StrictMode>,
);
