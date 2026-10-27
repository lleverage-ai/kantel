import { type Decision, type DecisionInput, isHarbourError } from "@harbour/contracts";
import { type GrantSummary, VaultPage, type VaultPageProps, type VaultRequest } from "@harbour/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleVault } from "../api/oversight.ts";

/** Why a request didn't load, as the page shows it. */
export function loadError(error: unknown): NonNullable<VaultPageProps["error"]> {
	if (isHarbourError(error, "forbidden")) return { kind: "forbidden" };
	if (isHarbourError(error, "not_found"))
		return {
			kind: "other",
			message: "There's no vault request at this link. Check it against the card in your session.",
		};
	return { kind: "other", message: "Couldn't load the request. Try again." };
}

/**
 * The vault page in the console: the request a link names, if any, beside the viewer's active grants. Decisions and
 * stops go through the console's vault seam, and the page reloads after each, so it always shows what the vault holds.
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

	const onDecide = useCallback((input: DecisionInput): Promise<Decision> => vault.decide(input), [vault]);
	const onDecided = useCallback(() => {
		void loadRequest();
		void loadGrants();
	}, [loadRequest, loadGrants]);
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
				<h1 className="hb-sr-only">{proposalId === undefined ? "Vault" : "Vault request"}</h1>
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
				passkey={vault.passkey}
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
