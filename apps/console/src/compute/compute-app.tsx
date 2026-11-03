import { ComputeConsole, type ComputeSource, type HostingMode } from "@kantel/ui";
import { createComputeFixtures } from "@kantel/ui/compute/fixtures";
import { useEffect, useState } from "react";
import { navigate, searchWithout, usePathname } from "../app/router.ts";
import { NARROW_QUERY, useMedia } from "../app/use-media.ts";
import { apiCompute } from "./api-source.ts";

// The compute console (experimental): the compute plane's pages under /compute, beside the session console, which
// stays as it is until the agent plane is retired.
//
// Where its data comes from: the gateway's compute API (api-source.ts) when it serves one, which a self-hosted install
// does with KANTEL_COMPUTE=experimental. Otherwise, and in the hosted demo, which has plans and billing the API
// doesn't, @kantel/ui's sample data, and the sidebar says so. `?data=sample` asks for the sample data anyway.
//
// Which Kantel it shows: self-hosted by default, or the hosted service's demo (plans and billing, a cost column) with
// `?hosting=hosted`, kept for the tab; `?hosting=self-hosted` goes back. `VITE_KANTEL_HOSTING` sets a build's default.

/** Where the compute console lives in the app. */
export const COMPUTE_BASE = "/compute";

/** Whether `pathname` is one of the compute console's pages. */
export const isComputePath = (pathname: string): boolean =>
	pathname === COMPUTE_BASE || pathname.startsWith(`${COMPUTE_BASE}/`);

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
 * New sandbox) is for the one page it was given to, so it is dropped first.
 */
function go(path: string): void {
	if (!path.includes("?") && new URLSearchParams(location.search).has("new")) {
		history.replaceState(null, "", `${location.pathname}${searchWithout(location.search, ["new"])}`);
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

type Sourced = { readonly source: ComputeSource; readonly sample: boolean };

/** The compute API when this gateway serves it and the tab wants it, else the sample data. */
async function sourceFor(
	hosting: HostingMode,
	signedInAs: { readonly name?: string; readonly email?: string } | undefined,
	api: { readonly headers?: () => Record<string, string>; readonly onUnauthenticated?: () => void } | undefined,
): Promise<Sourced> {
	const wantsSample = hosting === "hosted" || new URLSearchParams(location.search).get("data") === "sample";
	if (api !== undefined && !wantsSample) {
		try {
			return { source: namedFor(await apiCompute({ ...api, hosting }), signedInAs), sample: false };
		} catch (error) {
			console.info("kantel: the compute API isn't served here, so /compute shows sample data:", error);
		}
	}
	return { source: namedFor(createComputeFixtures({ hosting, now: Date.now() }), signedInAs), sample: true };
}

export function ComputeApp({
	signedInAs,
	onSignOut,
	headers,
	onUnauthenticated,
}: {
	/** Who `GET /v1/me` says is signed in; the sample data's person without it. */
	signedInAs?: { readonly name?: string; readonly email?: string };
	onSignOut?: () => void;
	/** The signed-in session's headers for the compute API. Without them (a recording) it shows the sample data. */
	headers?: () => Record<string, string>;
	/** A 401 from the compute API: the sign-in has ended. */
	onUnauthenticated?: () => void;
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
		/>
	);
}
