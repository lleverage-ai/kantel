import { ComputeConsole, type HostingMode } from "@kantel/ui";
import { createComputeFixtures } from "@kantel/ui/compute/fixtures";
import { useMemo } from "react";
import { navigate, searchWithout, usePathname } from "../app/router.ts";
import { NARROW_QUERY, useMedia } from "../app/use-media.ts";

// The compute console (experimental): the compute plane's pages under /compute, beside the session console, which
// stays as it is until the agent plane is retired. Every page runs on @kantel/ui's sample data until the public
// compute API lands; the sidebar says so.
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

export function ComputeApp({
	signedInAs,
	onSignOut,
}: {
	/** Who `GET /v1/me` says is signed in; the sample data's person without it. */
	signedInAs?: { readonly name?: string; readonly email?: string };
	onSignOut?: () => void;
}) {
	const pathname = usePathname();
	const narrow = useMedia(NARROW_QUERY);
	// One source for the tab's life: what a person does on one page (a new sandbox, a revoked key) shows on the next.
	const source = useMemo(() => createComputeFixtures({ hosting: hostingMode(), now: Date.now() }), []);
	return (
		<ComputeConsole
			source={source}
			pathname={pathname}
			search={location.search}
			navigate={go}
			base={COMPUTE_BASE}
			narrow={narrow}
			sample
			{...(signedInAs === undefined ? {} : { signedInAs })}
			{...(onSignOut === undefined ? {} : { onSignOut })}
		/>
	);
}
