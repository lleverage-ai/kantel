// The device sign-in page (compute console, experimental): where a person approves `kantel login` from a terminal.
// The command line shows a code and opens `/device?code=…`; the page shows what is asking to sign in and the
// account its key will act in, the one the account switcher has open, and Approve makes the key, which the terminal
// collects on its next poll. Without a code in the address the person types the one their terminal shows. Every call
// goes through the `DeviceLoginsSource` the host binds; stories bind it to fixtures.

import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { ComputeAccount, DeviceLogin, DeviceLoginsSource } from "./compute-model.ts";
import { computePage, messageOf } from "./parts.tsx";

export interface DeviceLoginPageProps {
	readonly source: DeviceLoginsSource;
	/** The account the key will act in. */
	readonly account: ComputeAccount;
	/** The code from the address (`?code=`), when the terminal opened the page. */
	readonly code?: string;
	/** A fixed time, for stories. */
	readonly now?: number;
}

type Looked =
	| { readonly status: "idle" }
	| { readonly status: "loading"; readonly code: string }
	| { readonly status: "ready"; readonly login: DeviceLogin }
	| { readonly status: "error"; readonly message: string };

/** `BCDF-GHJK` from what a person typed: `bcdfghjk`, `BCDF GHJK`. */
export function tidyCode(typed: string): string {
	const letters = typed.toUpperCase().replace(/[^A-Z]/g, "");
	return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : typed.trim().toUpperCase();
}

const canApprove = (account: ComputeAccount): boolean =>
	account.kind === "personal" || account.role === "owner" || account.role === "admin";

export function DeviceLoginPage({ source, account, code, now: fixedNow }: DeviceLoginPageProps) {
	const [typed, setTyped] = useState(code ?? "");
	const [looked, setLooked] = useState<Looked>(() =>
		code === undefined ? { status: "idle" } : { status: "loading", code: tidyCode(code) },
	);
	const [busy, setBusy] = useState<"approve" | "deny">();
	const [failure, setFailure] = useState<string>();
	const now = fixedNow ?? Date.now();

	// The code from the address is looked up once, as the page opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, for the code the page opened with.
	useEffect(() => {
		if (code !== undefined) void lookUp(tidyCode(code));
	}, []);

	async function lookUp(userCode: string) {
		setFailure(undefined);
		setLooked({ status: "loading", code: userCode });
		try {
			setLooked({ status: "ready", login: await source.get(userCode) });
		} catch (caught) {
			setLooked({ status: "error", message: messageOf(caught, "No sign-in has that code. Check it and try again.") });
		}
	}

	async function decide(login: DeviceLogin, how: "approve" | "deny") {
		setBusy(how);
		setFailure(undefined);
		try {
			const decided =
				how === "approve"
					? await source.approve(login.userCode, { accountId: account.id })
					: await source.deny(login.userCode);
			setLooked({ status: "ready", login: decided });
		} catch (caught) {
			setFailure(messageOf(caught, "Kantel couldn't record that. Try again."));
		} finally {
			setBusy(undefined);
		}
	}

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (typed.trim() !== "") void lookUp(tidyCode(typed));
	};

	return (
		<div className={computePage}>
			<PageHeader
				title="Sign in a device"
				lede="Approve a terminal running kantel login. It gets an API key of its own, in the account below, which you can revoke on the API keys page."
			/>
			{looked.status === "idle" || looked.status === "error" ? (
				<form className="flex max-w-card flex-col gap-3" onSubmit={submit}>
					<TextField
						label="Code"
						hint="The code your terminal shows, such as BCDF-GHJK."
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						mono
						{...(looked.status === "error" ? { error: looked.message } : {})}
					/>
					<div>
						<Button type="submit" variant="primary" disabled={typed.trim() === ""}>
							Continue
						</Button>
					</div>
				</form>
			) : looked.status === "loading" ? (
				<div className="flex max-w-card flex-col gap-2" aria-busy="true">
					<Skeleton width="60%" lines={3} />
				</div>
			) : (
				<Decision
					login={looked.login}
					account={account}
					now={now}
					busy={busy}
					onApprove={() => void decide(looked.login, "approve")}
					onDeny={() => void decide(looked.login, "deny")}
				/>
			)}
			{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
		</div>
	);
}

function Decision({
	login,
	account,
	now,
	busy,
	onApprove,
	onDeny,
}: {
	login: DeviceLogin;
	account: ComputeAccount;
	now: number;
	busy: "approve" | "deny" | undefined;
	onApprove: () => void;
	onDeny: () => void;
}) {
	const state = login.state === "pending" && login.expiresAt <= now ? "expired" : login.state;
	if (state === "approved") {
		return (
			<Notice level="info">
				{login.clientName} is signed in to {account.name}. You can close this tab and go back to the terminal.
			</Notice>
		);
	}
	if (state === "denied") {
		return <Notice level="info">Denied. The terminal won't be signed in.</Notice>;
	}
	if (state === "expired") {
		return <Notice level="warning">This code has expired. Run kantel login again for a new one.</Notice>;
	}
	const minutes = Math.max(1, Math.round((login.expiresAt - now) / 60_000));
	const allowed = canApprove(account);
	return (
		<section className="flex max-w-card flex-col gap-4" aria-label="The sign-in">
			<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
				<dt className="text-muted">Device</dt>
				<dd>{login.clientName}</dd>
				<dt className="text-muted">Code</dt>
				<dd>
					<span className="font-mono">{login.userCode}</span> <Badge>{`Expires in ${minutes} min`}</Badge>
				</dd>
				<dt className="text-muted">Account</dt>
				<dd>{account.name}</dd>
			</dl>
			<p className="text-muted">
				Check the code matches the one in your terminal. Only approve a sign-in you started yourself.
			</p>
			{allowed ? null : (
				<Notice level="warning">
					You need to be an admin or owner of {account.name} to give a device a key there. Switch to your personal
					account, or ask an owner.
				</Notice>
			)}
			<div className="flex gap-2">
				<Button
					variant="primary"
					onClick={onApprove}
					disabled={!allowed || busy !== undefined}
					aria-busy={busy === "approve"}
				>
					Approve
				</Button>
				<Button onClick={onDeny} disabled={busy !== undefined} aria-busy={busy === "deny"}>
					Deny
				</Button>
			</div>
		</section>
	);
}
