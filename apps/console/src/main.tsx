import { Button, Notice, SignInScreen, Spinner } from "@harbour/ui";
import { StrictMode, Suspense, use, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import longUrl from "../../../fixtures/sessions/long-2000.jsonl?url";
import smallUrl from "../../../fixtures/sessions/small.jsonl?url";
import { apiAudit } from "./api/audit-http.ts";
import type { ConsoleClient } from "./api/client.ts";
import { createApiClient } from "./api/http.ts";
import { type ConsoleBoot, createConsoleIdentity, memoryTokens, storageTokens } from "./api/identity.ts";
import type { ConsoleAudit, ConsoleVault } from "./api/oversight.ts";
import { createRecordedClient, type RecordedClient } from "./api/recorded.ts";
import { apiVault } from "./api/vault-http.ts";
import { App } from "./app/app.tsx";
import { createCatalogue } from "./recorded/catalogue.ts";
import { createRecordedOversight, type RecordedOversight } from "./recorded/oversight.ts";
import type { SessionClient } from "./state/session-client.ts";
import { profileStore } from "./ui/profile.tsx";
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
// approval API has said who is signed in, and not at all on a gateway without one. On `recorded` both run on the
// in-memory vault and audit store in the page (recorded/oversight.ts).

const params = new URLSearchParams(location.search);
const SOURCE_KEY = "harbour.console.source";
const asked = params.get("source");
if (asked === "api" || asked === "recorded") sessionStorage.setItem(SOURCE_KEY, asked);
const source = sessionStorage.getItem(SOURCE_KEY) ?? import.meta.env.VITE_HARBOUR_SOURCE ?? "api";

// The evidence script reads the open session's client and host from the page, and the vault fixture's proposals.
let current: { sessionId: string; session: SessionClient } | undefined;
let proposals: Readonly<Record<string, string>> | undefined;
let recorded: RecordedClient | undefined;
let client: ConsoleClient | undefined;
if (source === "recorded") {
	recorded = createRecordedClient(createCatalogue(Date.now(), { long: longUrl, small: smallUrl }), {
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
	},
});
const onOpen = (sessionId: string, session: SessionClient) => {
	current = { sessionId, session };
};

type Oversight = { readonly vault?: ConsoleVault; readonly audit?: ConsoleAudit };
const recordedOversight: Promise<Oversight> | undefined =
	source === "recorded"
		? createRecordedOversight().then((made: RecordedOversight) => {
				proposals = made.proposals;
				return made;
			})
		: undefined;

/** The console once its vault page and audit log are known: recorded ones, or the API's. */
function OversightConsole({ client, oversight }: { client: ConsoleClient; oversight: Promise<Oversight> }) {
	return <Console client={client} oversight={use(oversight)} />;
}

function Console({ client, oversight }: { client: ConsoleClient; oversight: Oversight }) {
	const { vault, audit } = oversight;
	return (
		<App
			client={client}
			{...(vault === undefined ? {} : { vault })}
			{...(audit === undefined ? {} : { audit })}
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

type Boot = ConsoleBoot | { readonly kind: "failed"; readonly message: string };
const boot = (): Promise<Boot> =>
	identity.boot().catch((reason: unknown) => ({
		kind: "failed" as const,
		message: reason instanceof Error ? reason.message : String(reason),
	}));

// Started here, not in render: a component that suspends before it mounts loses its state, so a promise made in
// render would be made again on every retry.
const firstBoot: Promise<Boot> | undefined = source === "recorded" ? undefined : boot();

/** The console on the API: who is signed in first, then the shell, or the way to sign in. */
function ApiConsole({ first }: { first: Promise<Boot> }) {
	const [booting, setBooting] = useState(first);
	const reboot = useCallback(() => setBooting(boot()), []);
	const state = use(booting);
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
			onSignedOut();
		};
		const audit = apiAudit({ headers: state.headers });
		return {
			client: createApiClient({ actor: state.actor, headers: state.headers, onUnauthenticated }),
			// The vault page is listed once the approval API has said who is signed in, and not on a gateway without one.
			oversight: apiVault({ headers: state.headers }).then(
				(vault): Oversight => ({ vault, audit }),
				(error: unknown): Oversight => {
					console.info("harbour: no vault page:", error instanceof Error ? error.message : error);
					return { audit };
				},
			),
		};
	}, [state, onSignedOut]);
	// A boundary of its own, so this component commits and keeps its promise while the vault answers.
	return (
		<Suspense
			fallback={
				<div className="boot hb-app">
					<Spinner label="Opening the console" />
				</div>
			}
		>
			<OversightConsole client={made.client} oversight={made.oversight} />
		</Suspense>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Suspense
			fallback={
				<div className="boot hb-app">
					<Spinner label="Opening the console" />
				</div>
			}
		>
			{client !== undefined && recordedOversight !== undefined ? (
				<OversightConsole client={client} oversight={recordedOversight} />
			) : firstBoot !== undefined ? (
				<ApiConsole first={firstBoot} />
			) : null}
		</Suspense>
	</StrictMode>,
);
