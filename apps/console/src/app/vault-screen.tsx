import { type Decision, type DecisionInput, isHarbourError } from "@harbour/contracts";
import {
	Button,
	type GrantSummary,
	Notice,
	type PasskeyCheck,
	VaultPage,
	type VaultPageProps,
	type VaultRequest,
} from "@harbour/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleVault } from "../api/oversight.ts";

/** Why a request didn't load, as the page shows it. */
export function loadError(error: unknown): NonNullable<VaultPageProps["error"]> {
	if (isHarbourError(error, "forbidden")) return { kind: "forbidden" };
	if (isHarbourError(error, "not_found"))
		return {
			kind: "other",
			message: "There's no connection request at this link. Check it against the card in your session.",
		};
	return { kind: "other", message: "Couldn't load the request. Try again." };
}

/**
 * Offers a person with no passkey yet to set one up, on a host that takes them. Once they have, the page asks for it
 * before every approval; until then, approving rests on their sign-in and the binding code.
 */
function PasskeySetUp({
	register,
	onReady,
}: {
	register: () => Promise<PasskeyCheck | undefined>;
	onReady: (check: PasskeyCheck) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const setUp = async () => {
		setBusy(true);
		setFailed(false);
		try {
			const check = await register();
			if (check !== undefined) onReady(check);
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	};
	return (
		// The page's gap between blocks (gap-6), as it sits above the page's header.
		<div className="mb-6">
			<Notice
				level={failed ? "warning" : "info"}
				action={
					<Button size="sm" busy={busy} onClick={() => void setUp()}>
						Set up a passkey
					</Button>
				}
			>
				{failed
					? "Your passkey couldn't be set up. Try again."
					: "Approvals rest on your sign-in alone. Set up a passkey to confirm each one with your fingerprint, face or PIN."}
			</Notice>
		</div>
	);
}

/**
 * The vault page in the console: the request a link names beside the viewer's active grants, or the grants alone when
 * there is no request. Decisions and stops go through the console's vault seam, and the page reloads after each, so it
 * always shows what the vault holds.
 */
export function VaultScreen({ vault, proposalId }: { vault: ConsoleVault; proposalId?: string }) {
	const [request, setRequest] = useState<VaultRequest>();
	const [error, setError] = useState<VaultPageProps["error"]>();
	const [grants, setGrants] = useState<readonly GrantSummary[]>([]);
	const [grantsLoading, setGrantsLoading] = useState(true);
	const [grantsError, setGrantsError] = useState<string>();
	// Each read is numbered; only the latest of its kind may change the screen, so a slow older reply (a reload a stop
	// started before another stop's) never puts back what a newer one removed, and nothing lands after unmounting.
	const requestRead = useRef(0);
	const grantsRead = useRef(0);
	// The vault's passkey check, or the one a passkey set up here gives.
	const [passkey, setPasskey] = useState<PasskeyCheck | undefined>(() => vault.passkey);
	useEffect(() => setPasskey(() => vault.passkey), [vault]);

	const loadRequest = useCallback(async () => {
		const mine = ++requestRead.current;
		if (proposalId === undefined) return;
		try {
			const loaded = await vault.request(proposalId);
			if (requestRead.current !== mine) return;
			setRequest(loaded);
			setError(undefined);
		} catch (caught) {
			if (requestRead.current === mine) setError(loadError(caught));
		}
	}, [vault, proposalId]);

	const loadGrants = useCallback(async () => {
		const mine = ++grantsRead.current;
		try {
			const loaded = await vault.grants();
			if (grantsRead.current !== mine) return;
			setGrants(loaded);
			setGrantsError(undefined);
		} catch {
			if (grantsRead.current === mine) setGrantsError("Couldn't load your active grants.");
		} finally {
			if (grantsRead.current === mine) setGrantsLoading(false);
		}
	}, [vault]);

	useEffect(() => {
		setRequest(undefined);
		setError(undefined);
		void loadRequest();
		return () => {
			requestRead.current += 1;
		};
	}, [loadRequest]);
	useEffect(() => {
		void loadGrants();
		return () => {
			grantsRead.current += 1;
		};
	}, [loadGrants]);

	// A decision or stop that finishes after the screen moved to another request or vault, or went away, reloads nothing:
	// its reads would be of what the screen no longer shows.
	const scope = useMemo(() => ({ live: true, vault, proposalId }), [vault, proposalId]);
	useEffect(() => {
		// Set on every mount, as StrictMode mounts, cleans up and mounts again.
		scope.live = true;
		return () => {
			scope.live = false;
		};
	}, [scope]);

	const onDecide = useCallback((input: DecisionInput): Promise<Decision> => vault.decide(input), [vault]);
	const onDecided = useCallback(() => {
		if (!scope.live) return;
		void loadRequest();
		void loadGrants();
	}, [scope, loadRequest, loadGrants]);
	const onStop = useCallback(
		async (grantId: string) => {
			await vault.stop(grantId);
			onDecided();
		},
		[vault, onDecided],
	);
	const retry = useCallback(() => {
		setError(undefined);
		void loadRequest();
	}, [loadRequest]);

	return (
		<>
			{/* The request's own heading names it once it shows; until then, without one, or on an error, the page's. */}
			{request === undefined || error !== undefined ? (
				<h1 className="hb-sr-only">{proposalId === undefined ? "Connection requests" : "Connection request"}</h1>
			) : null}
			{passkey === undefined && vault.registerPasskey !== undefined ? (
				<PasskeySetUp register={vault.registerPasskey} onReady={(check) => setPasskey(() => check)} />
			) : null}
			<VaultPage
				embedded
				viewer={vault.viewer}
				vaultHost={vault.host}
				loading={proposalId !== undefined && request === undefined && error === undefined}
				{...(request === undefined ? {} : { request })}
				{...(error === undefined ? {} : { error })}
				onRetry={retry}
				onDecide={onDecide}
				onDecided={onDecided}
				{...(passkey === undefined ? {} : { passkey })}
				grants={{
					grants,
					onStop,
					loading: grantsLoading,
					...(grantsError === undefined ? {} : { error: grantsError }),
					...(request === undefined ? {} : { currentProposalId: request.proposal.id }),
				}}
			/>
		</>
	);
}
