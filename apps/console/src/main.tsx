import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import longUrl from "../../../fixtures/sessions/long-2000.jsonl?url";
import smallUrl from "../../../fixtures/sessions/small.jsonl?url";
import { FixtureHost, parseRecording } from "./server-sim/fixture-host.ts";
import { SessionClient } from "./state/session-client.ts";
import { profileStore } from "./ui/profile.tsx";
import { SessionView } from "./ui/session-view.tsx";
import "./ui/styles.css";

// M0: no backend. The page loads a recorded session, starts an in-page stand-in for the session host on it, and
// connects the console to that host exactly as it will connect to the real one.

const fixtures = [
	{ id: "long", label: "Platform migration (2,000 turns)", url: longUrl },
	{ id: "small", label: "Tidy the release notes (2 turns)", url: smallUrl },
] as const;

const params = new URLSearchParams(location.search);
const chosen = fixtures.find((fixture) => fixture.id === params.get("session")) ?? fixtures[0];
const speed = Number(params.get("speed") ?? "1") || 1;

function App() {
	const [client, setClient] = useState<SessionClient>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let host: FixtureHost | undefined;
		let session: SessionClient | undefined;
		let cancelled = false;
		let playTimer: ReturnType<typeof setTimeout> | undefined;
		void fetch(chosen.url)
			.then((response) => {
				if (!response.ok) throw new Error(`Could not load ${chosen.label} (${response.status})`);
				return response.text();
			})
			.then((text) => {
				if (cancelled) return;
				host = new FixtureHost(parseRecording(text), { speed });
				session = new SessionClient(host, host.sessionId);
				session.start();
				setClient(session);
				// Give the first snapshot a moment on screen before the live part starts.
				// With ?profile=1 the Profiler counts start here, with the rows already shown as the baseline.
				playTimer = setTimeout(() => {
					if (cancelled) return;
					profileStore?.reset(session?.getState().transcript.items.map((item) => item.id));
					host?.play();
				}, Number(params.get("delay") ?? "1200"));
				Object.assign(window, { __harbour: { host, client: session } });
			})
			.catch((reason: unknown) => setError(String(reason)));
		return () => {
			cancelled = true;
			clearTimeout(playTimer);
			host?.pause();
			session?.stop();
		};
	}, []);
	if (error !== undefined) return <div className="boot">{error}</div>;
	if (client === undefined) return <div className="boot">Opening session…</div>;
	return <SessionView client={client} fixtures={fixtures} current={chosen.id} />;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
