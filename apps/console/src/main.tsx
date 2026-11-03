// First: settings this browser stored under harbour.* keys before the rename move to kantel.*.
import "./legacy-storage.ts";
import { Button, Notice, reloadForNewBuild, SignInScreen, Spinner, themeController } from "@kantel/ui";
import { type ReactNode, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type ConsoleBoot,
	createConsoleIdentity,
	memoryChoice,
	memoryTokens,
	storageChoice,
	storageTokens,
} from "./api/identity.ts";
import { ComputeApp, legacyComputePath } from "./compute/compute-app.tsx";
import { syncTheme } from "./state/theme-sync.ts";
import { BOOT } from "./ui/shell-styles.ts";
import "./ui/styles.css";

// The console is the compute console (compute/compute-app.tsx): sandboxes, snapshots, keys, the egress proxy,
// webhooks, OpenTelemetry, organisations and, for a super-admin, hosts, on the gateway's compute API under /v1.
//
// It asks `GET /v1/me` first (api/identity.ts). A 401 shows Kantel's email-code sign-in where the deployment signs
// people in that way (self-hosted), and asks for a reload where Access does it at the edge.
//
// `?source=recorded` (or `VITE_KANTEL_SOURCE=recorded` for a build) shows the console on @kantel/ui's sample data with
// no backend and no sign-in, for demos and screenshots.

// The theme: the page already paints in the person's theme (index.html's boot script, from this browser's memory);
// this puts every theme's stylesheet on the page, so switching is instant. Their saved preference follows from the
// server once `/v1/me` has answered (state/theme-sync.ts).
themeController();

// The compute console lived under /compute while the session console had `/`: its old links (a bookmark, an older
// `kantel login`'s device page) go to the same page here.
const moved = legacyComputePath(location.pathname);
if (moved !== undefined) history.replaceState(null, "", `${moved}${location.search}${location.hash}`);

const params = new URLSearchParams(location.search);
const SOURCE_KEY = "kantel.console.source";
const asked = params.get("source");
if (asked === "api" || asked === "recorded") sessionStorage.setItem(SOURCE_KEY, asked);
const source =
	sessionStorage.getItem(SOURCE_KEY) ??
	import.meta.env.VITE_KANTEL_SOURCE ??
	import.meta.env.VITE_HARBOUR_SOURCE ??
	"api";

const identity = createConsoleIdentity(
	hasStorage()
		? { tokens: storageTokens(localStorage), choice: storageChoice(localStorage) }
		: { tokens: memoryTokens(), choice: memoryChoice() },
);

function hasStorage(): boolean {
	try {
		return typeof localStorage !== "undefined" && localStorage !== null;
	} catch {
		return false;
	}
}

type Boot = ConsoleBoot | { readonly kind: "failed"; readonly message: string };
const boot = (): Promise<Boot> =>
	identity.boot().then(
		(state) => state,
		(reason: unknown) => ({
			kind: "failed" as const,
			message: reason instanceof Error ? reason.message : String(reason),
		}),
	);

// Started here, not in render: a component that suspends before it mounts loses its state, so a promise made in
// render would be made again on every retry.
const firstBoot: Promise<Boot> | undefined = source === "recorded" ? undefined : boot();

/** The app's ground while the console learns who is signed in: no spinner on a reload. */
const Ground = () => <div className="kt-app h-dvh" aria-busy="true" />;

/** The console on the API: who is signed in first, then the console, or the way to sign in. */
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
	if (answer?.for !== booting) return <Ground />;
	const { state } = answer;
	if (state.kind === "signed-in") {
		const { signOut } = state.actor;
		return (
			<SignedIn state={state}>
				<ComputeApp
					signedInAs={{ name: state.me.name, ...(state.me.email === undefined ? {} : { email: state.me.email }) }}
					headers={state.headers}
					onUnauthenticated={() => {
						identity.forget();
						reboot();
					}}
					{...(signOut === undefined ? {} : { onSignOut: () => void signOut().finally(reboot) })}
				/>
			</SignedIn>
		);
	}
	if (state.kind === "choose-organisation") {
		return (
			<div className={BOOT}>
				<div className="flex w-full max-w-sm flex-col gap-3">
					<h1 className="text-lg font-medium">Choose an organisation</h1>
					<p className="text-sm opacity-70">You belong to more than one. Sign out to choose another.</p>
					{state.organisations.map((organisation) => (
						<Button
							key={organisation.id}
							variant="secondary"
							onClick={() => {
								state.choose(organisation.id);
								reboot();
							}}
						>
							{organisation.name}
						</Button>
					))}
				</div>
			</div>
		);
	}
	if (state.kind === "sign-in") {
		return (
			<div className={BOOT}>
				<SignInScreen api={state.api} onSignedIn={reboot} />
			</div>
		);
	}
	return (
		<div className={BOOT}>
			<Notice
				level={state.kind === "failed" ? "error" : "info"}
				action={
					<Button size="sm" onClick={() => location.reload()}>
						Reload
					</Button>
				}
			>
				{state.kind === "failed"
					? `Kantel can't open the console right now. ${state.message}`
					: "You're signed out. Reload the page to sign in."}
			</Notice>
		</div>
	);
}

/** The person's saved theme, once `/v1/me` has said who they are; a host app's key has none. */
function SignedIn({ state, children }: { state: Extract<ConsoleBoot, { kind: "signed-in" }>; children: ReactNode }) {
	useEffect(() => {
		const save =
			state.me.actor.kind === "human"
				? (preference: string) => {
						identity.client.setPreferences({ theme: preference }).catch((error: unknown) => {
							console.info("kantel: couldn't keep the theme:", error instanceof Error ? error.message : error);
						});
					}
				: undefined;
		syncTheme(themeController(), state.me.preferences, save);
	}, [state]);
	return children;
}

// A page's code that loads on demand failed to load: a deploy since this tab opened replaced it, or the Access sign-in
// expired. Vite reports it here; reloading once picks up the new build or signs in again (`reloadForNewBuild`). The
// import still fails as it would have (no `preventDefault`), so its caller shows its error until the page goes.
window.addEventListener("vite:preloadError", () => {
	reloadForNewBuild();
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{source === "recorded" ? (
			<ComputeApp />
		) : firstBoot !== undefined ? (
			<ApiConsole first={firstBoot} />
		) : (
			<div className={BOOT}>
				<Spinner label="Opening the console" />
			</div>
		)}
	</StrictMode>,
);
