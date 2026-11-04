import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { CommandBlock } from "../primitives/one-time-secret.tsx";
import { Field, FieldList } from "../primitives/surface.tsx";
import type { BrowserStanding } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

export type BrowserDeviceDialogProps = {
	open: boolean;
	/** The organisation whose chain this is about. */
	accountName: string;
	/** Where the browser stands now; undefined while it is being found out. */
	standing: BrowserStanding | undefined;
	/** Trust the chain from the genesis given. */
	onTrust: (genesis: string) => Promise<void>;
	/** Ask again, after an admin has added the browser. */
	onCheck: () => void;
	onClose: () => void;
};

/**
 * Making this browser a device in an organisation's chain, one step at a time: trust the chain from the genesis an
 * admin gives out of band, then have an admin add the browser's card after checking its fingerprint. Its keys stay in
 * the browser and can't be read out of it.
 */
export function BrowserDeviceDialog({
	open,
	accountName,
	standing,
	onTrust,
	onCheck,
	onClose,
}: BrowserDeviceDialogProps) {
	const [genesis, setGenesis] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();

	const close = () => {
		setGenesis("");
		setFailure(undefined);
		onClose();
	};
	const trust = async () => {
		setBusy(true);
		setFailure(undefined);
		try {
			await onTrust(genesis.trim());
			setGenesis("");
		} catch (error) {
			setFailure(messageOf(error, "This browser couldn't trust that chain."));
		} finally {
			setBusy(false);
		}
	};
	const title = "Use this browser end to end";

	if (standing === undefined) {
		return (
			<Dialog open={open} title={title} onClose={close} actions={<Button onClick={close}>Cancel</Button>}>
				<p>Checking {accountName}'s chain…</p>
			</Dialog>
		);
	}
	if (standing.kind === "unpinned") {
		return (
			<Dialog
				open={open}
				title={title}
				onClose={close}
				onSubmit={() => void trust()}
				actions={
					<>
						<Button onClick={close}>Cancel</Button>
						<Button type="submit" variant="primary" busy={busy} disabled={genesis.trim() === ""}>
							Trust this chain
						</Button>
					</>
				}
			>
				<p>
					Ask an admin of <strong>{accountName}</strong> for its chain's genesis, which <code>kantel e2e status</code>{" "}
					prints. Get it from them yourself, not through Kantel: this browser trusts the chain from it, so the gateway
					can't hand it another.
				</p>
				<div className="w-(--kt-card-width) max-w-full pt-2">
					<TextField
						label="Genesis"
						value={genesis}
						spellCheck={false}
						autoComplete="off"
						mono
						onChange={(event) => {
							setGenesis(event.currentTarget.value);
							setFailure(undefined);
						}}
					/>
				</div>
				{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
			</Dialog>
		);
	}
	if (standing.kind === "pending") {
		return (
			<Dialog
				open={open}
				title={title}
				onClose={close}
				onSubmit={onCheck}
				actions={
					<>
						<Button onClick={close}>Close</Button>
						<Button type="submit" variant="primary">
							Check again
						</Button>
					</>
				}
			>
				<p>
					This browser trusts {accountName}'s chain but isn't in it yet. Give an admin this command, and read them the
					fingerprint so they know the browser is yours.
				</p>
				<div className="flex w-(--kt-card-width) max-w-full flex-col gap-3 pt-2">
					<CommandBlock command={standing.command} />
					<FieldList>
						<Field label="Fingerprint">
							<code>{standing.fingerprint}</code>
						</Field>
					</FieldList>
				</div>
			</Dialog>
		);
	}
	if (standing.kind === "ready") {
		return (
			<Dialog
				open={open}
				title={title}
				onClose={close}
				actions={
					<Button variant="primary" onClick={close}>
						Done
					</Button>
				}
			>
				<p>
					This browser is in {accountName}'s chain as <strong>{standing.label}</strong>. Commands and their history go
					to each sandbox's host end to end, with keys that stay in this browser.
				</p>
				<p>
					This page's code still comes from the gateway. For code that doesn't, run <code>kantel console</code> on your
					computer.
				</p>
			</Dialog>
		);
	}
	return (
		<Dialog open={open} title={title} onClose={close} actions={<Button onClick={close}>Close</Button>}>
			<p>{standing.reason}</p>
			<p>
				Run <code>kantel console</code> on your computer to see commands and files.
			</p>
		</Dialog>
	);
}
