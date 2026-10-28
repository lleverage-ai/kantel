import { Spinner } from "@harbour/ui";
import { StrictMode, Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import longUrl from "../../../fixtures/sessions/long-2000.jsonl?url";
import smallUrl from "../../../fixtures/sessions/small.jsonl?url";
import { apiAudit } from "./api/audit-http.ts";
import type { ConsoleClient } from "./api/client.ts";
import { createApiClient } from "./api/http.ts";
import type { ConsoleAudit, ConsoleVault } from "./api/oversight.ts";
import { createRecordedClient, type RecordedClient } from "./api/recorded.ts";
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
// The vault page and audit log follow the source. On `api` the audit log reads the audit query API (M1-BE8) the
// gateway serves on this origin; the vault page isn't listed, as the gateway serves no approval API yet. On `recorded`
// both run on the in-memory vault and audit store in the page (recorded/oversight.ts).

const params = new URLSearchParams(location.search);
const SOURCE_KEY = "harbour.console.source";
const asked = params.get("source");
if (asked === "api" || asked === "recorded") sessionStorage.setItem(SOURCE_KEY, asked);
const source = sessionStorage.getItem(SOURCE_KEY) ?? import.meta.env.VITE_HARBOUR_SOURCE ?? "api";

// The evidence script reads the open session's client and host from the page, and the vault fixture's proposals.
let current: { sessionId: string; session: SessionClient } | undefined;
let proposals: Readonly<Record<string, string>> | undefined;
let recorded: RecordedClient | undefined;
let client: ConsoleClient;
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
} else {
	client = createApiClient();
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
const oversight: Promise<Oversight> =
	source === "recorded"
		? createRecordedOversight().then((made: RecordedOversight) => {
				proposals = made.proposals;
				return made;
			})
		: Promise.resolve({ audit: apiAudit() });

function Console({ oversight }: { oversight: Promise<Oversight> }) {
	const { vault, audit } = use(oversight);
	return (
		<App
			client={client}
			{...(vault === undefined ? {} : { vault })}
			{...(audit === undefined ? {} : { audit })}
			onOpen={onOpen}
		/>
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
			<Console oversight={oversight} />
		</Suspense>
	</StrictMode>,
);
