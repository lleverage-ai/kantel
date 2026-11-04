import { KantelApiError } from "@kantel/api/sdk";
import type { ThemePreference } from "@kantel/contracts";
import { Button, ComputeConsole, type ComputeSource, type HostingMode, Notice } from "@kantel/ui";
import { createComputeFixtures } from "@kantel/ui/compute/fixtures";
import { useEffect, useState } from "react";
import { navigate, searchWithout, usePathname } from "../app/router.ts";
import { NARROW_QUERY, useMedia } from "../app/use-media.ts";
import { apiCompute } from "./api-source.ts";
import { localBridge } from "./local.ts";

// The console: the compute plane's pages at the root of the app (`/sandboxes`, `/hosts` and the rest; `/` is
// Sandboxes).
//
// Where its data comes from: the gateway's compute API (api-source.ts), which a self-hosted install serves. Otherwise,
// and in the hosted demo, which has plans and billing the API doesn't, @kantel/ui's sample data, and the sidebar says
// so. `?data=sample` asks for the sample data anyway.
//
// Which Kantel it shows: self-hosted by default, or the hosted service's demo (plans and billing, a cost column) with
// `?hosting=hosted`, kept for the tab; `?hosting=self-hosted` goes back. `VITE_KANTEL_HOSTING` sets a build's default.

/** Where the compute console lives in the app: its root. */
export const COMPUTE_BASE = "";

/** Where it lived while the session console had the root. */
const LEGACY_BASE = "/compute";

/** The page an old `/compute/...` path is now, or undefined for any other path. */
export function legacyComputePath(pathname: string): string | undefined {
	if (pathname !== LEGACY_BASE && !pathname.startsWith(`${LEGACY_BASE}/`)) return undefined;
	return pathname.slice(LEGACY_BASE.length) || "/";
}

const HOSTING_KEY = "kantel.compute.hosting";

function hostingMode(): HostingMode {
	const asked = new URLSearchParams(location.search).get("hosting");
	try {
		if (asked === "hosted" || asked === "self-hosted") sessionStorage.setItem(HOSTING_KEY, asked);
		const kept = sessionStorage.getItem(HOSTING_KEY);
		if (kept === "hosted" || kept === "self-hosted") return kept;
	} catch {
		if (asked === "hosted" || asked === "self-hosted") return asked;
	}
	return import.meta.env.VITE_KANTEL_HOSTING === "hosted" ? "hosted" : "self-hosted";
}

/**
 * Goes to a page of the compute console. The app's `navigate` keeps the query, which carries `?hosting`; `?new` (open
 * New sandbox) and `?add` (open Add a host) are for the one page they were given to, so they are dropped first.
 */
function go(path: string): void {
	const search = new URLSearchParams(location.search);
	if (!path.includes("?") && (search.has("new") || search.has("add"))) {
		history.replaceState(null, "", `${location.pathname}${searchWithout(location.search, ["new", "add"])}`);
	}
	navigate(path);
}

/**
 * `source` with the person signed in as its viewer and their personal account named after them. The sample data would
 * otherwise greet them as someone else, and the compute API names a person by their user ID, as it has no profile.
 */
function namedFor(
	source: ComputeSource,
	person: { readonly name?: string; readonly email?: string } | undefined,
): ComputeSource {
	if (person?.name === undefined) return source;
	const { name } = person;
	const accounts: ComputeSource["accounts"] = {
		...source.accounts,
		viewer: async () => ({
			...(await source.accounts.viewer()),
			name,
			...(person.email === undefined ? {} : { email: person.email }),
		}),
		list: async () =>
			(await source.accounts.list()).map((account) => (account.kind === "personal" ? { ...account, name } : account)),
		// Their own row in an organisation's members too.
		members: async (accountId) => {
			const [viewer, members] = await Promise.all([source.accounts.viewer(), source.accounts.members(accountId)]);
			return members.map((member) =>
				member.id === viewer.id
					? { ...member, name, ...(member.email === "" && person.email !== undefined ? { email: person.email } : {}) }
					: member,
			);
		},
	};
	// Not a spread, which would fix the live source's `domain` at what it is now: it learns the domain later.
	return Object.defineProperties({ ...source, accounts }, { domain: { get: () => source.domain, enumerable: true } });
}

type Sourced =
	| { readonly source: ComputeSource; readonly sample: boolean }
	/** The gateway serves compute, but not to this person (403): say so, never the sample data in its place. */
	| { readonly refused: string };

/**
 * The compute API when this gateway serves it and the tab wants it, else the sample data. A refusal is not "not
 * served": someone signed in who may not use compute here sees why, rather than a demo that looks like theirs.
 */
async function sourceFor(
	hosting: HostingMode,
	signedInAs: { readonly name?: string; readonly email?: string } | undefined,
	api: { readonly headers?: () => Record<string, string>; readonly onUnauthenticated?: () => void } | undefined,
): Promise<Sourced> {
	const wantsSample = hosting === "hosted" || new URLSearchParams(location.search).get("data") === "sample";
	if (api !== undefined && !wantsSample) {
		try {
			// Served by `kantel console`: its bridge reads E2E sandboxes' history from their hosts (local.ts).
			const local = await localBridge();
			const options = { ...api, hosting, ...(local === undefined ? {} : { local }) };
			return { source: namedFor(await apiCompute(options), signedInAs), sample: false };
		} catch (error) {
			if (error instanceof KantelApiError && error.status === 403) return { refused: error.message };
			console.info("kantel: the compute API isn't served here, so the console shows sample data:", error);
		}
	}
	// `?data=empty`: the sample data with no sandboxes, snapshots, keys, webhooks or hosts, for the empty states.
	const empty = new URLSearchParams(location.search).get("data") === "empty";
	return { source: namedFor(createComputeFixtures({ hosting, now: Date.now(), empty }), signedInAs), sample: true };
}

export function ComputeApp({
	signedInAs,
	onSignOut,
	headers,
	onUnauthenticated,
	onThemeChoose,
}: {
	/** Who `GET /v1/me` says is signed in; the sample data's person without it. */
	signedInAs?: { readonly name?: string; readonly email?: string };
	onSignOut?: () => void;
	/** The signed-in session's headers for the compute API. Without them (a recording) it shows the sample data. */
	headers?: () => Record<string, string>;
	/** A 401 from the compute API: the sign-in has ended. */
	onUnauthenticated?: () => void;
	/** The person chose a theme in the sidebar: keep it for them. Without it (a recording) it is kept in this browser. */
	onThemeChoose?: (preference: ThemePreference) => void;
}) {
	const pathname = usePathname();
	const narrow = useMedia(NARROW_QUERY);
	// One source for the tab's life: what a person does on one page (a new sandbox, a revoked key) shows on the next.
	const [sourced, setSourced] = useState<Sourced>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: chosen once; who is signed in doesn't change under it.
	useEffect(() => {
		let live = true;
		const api =
			headers === undefined
				? undefined
				: { headers, ...(onUnauthenticated === undefined ? {} : { onUnauthenticated }) };
		void sourceFor(hostingMode(), signedInAs, api).then((chosen) => {
			if (live) setSourced(chosen);
		});
		return () => {
			live = false;
		};
	}, []);
	// The app's ground while the console asks the gateway, which takes one call: no spinner, and not the session shell.
	if (sourced === undefined) return <div className="kt-app h-dvh" aria-busy="true" />;
	if ("refused" in sourced) {
		return (
			<div className="kt-app flex h-dvh items-center justify-center p-6">
				<div className="flex w-full max-w-md flex-col gap-3">
					<Notice
						level="info"
						{...(onSignOut === undefined
							? {}
							: {
									action: (
										<Button size="sm" onClick={onSignOut}>
											Sign out
										</Button>
									),
								})}
					>
						{signedInAs?.email === undefined ? "You're signed in. " : `You're signed in as ${signedInAs.email}. `}
						{sourced.refused}.
					</Notice>
				</div>
			</div>
		);
	}
	return (
		<ComputeConsole
			source={sourced.source}
			pathname={pathname}
			search={location.search}
			navigate={go}
			base={COMPUTE_BASE}
			narrow={narrow}
			sample={sourced.sample}
			{...(signedInAs === undefined ? {} : { signedInAs })}
			{...(onSignOut === undefined ? {} : { onSignOut })}
			{...(onThemeChoose === undefined ? {} : { onThemeChoose })}
		/>
	);
}
