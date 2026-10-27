import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import longUrl from "../../../fixtures/sessions/long-2000.jsonl?url";
import smallUrl from "../../../fixtures/sessions/small.jsonl?url";
import { createRecordedClient } from "./api/recorded.ts";
import { App } from "./app/app.tsx";
import { createCatalogue } from "./recorded/catalogue.ts";
import type { SessionClient } from "./state/session-client.ts";
import { profileStore } from "./ui/profile.tsx";
import "./ui/styles.css";

// Until the session API (M1-BE1) lands, the console runs on recorded sessions in the page: a catalogue of sessions in
// every state, served by in-page stand-ins for the session host over @harbour/protocol, exactly as the real host will
// serve them. `?speed=2` plays them faster; `?delay=1500` waits longer before an opened session's live part plays;
// `?profile=1` adds the render profiler.

const params = new URLSearchParams(location.search);
// The evidence script reads the open session's client and host from the page.
let current: { sessionId: string; session: SessionClient } | undefined;
const client = createRecordedClient(createCatalogue(Date.now(), { long: longUrl, small: smallUrl }), {
	speed: Number(params.get("speed") ?? "1") || 1,
	openDelayMs: Number(params.get("delay") ?? "600"),
	// With ?profile=1 the Profiler counts start here, with the rows already shown as the baseline.
	onPlay: (sessionId) => {
		if (current?.sessionId === sessionId) profileStore?.reset(current.session.getState().items.map((item) => item.id));
	},
});

Object.assign(window, {
	__harbour: {
		get client() {
			return current?.session;
		},
		get host() {
			return current === undefined ? undefined : client.hostFor(current.sessionId);
		},
	},
});
const onOpen = (sessionId: string, session: SessionClient) => {
	current = { sessionId, session };
};

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App client={client} onOpen={onOpen} />
	</StrictMode>,
);
