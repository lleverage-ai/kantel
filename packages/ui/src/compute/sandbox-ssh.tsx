// A microVM's SSH, on its Overview. First the Kantel CLI's command, `kantel ssh <id>`, which lets a key of its own in
// and connects through Kantel's relay with nothing else installed; under it the one line that installs the CLI. Then,
// on demand, plain ssh for someone without the CLI: they paste an OpenSSH public key, or leave it empty and Kantel
// makes a key pair whose private half they download once, and the page shows the command that uses it, with websocat
// as ssh's ProxyCommand, and the host key ssh will ask them to trust. Nothing is let in until they ask.

import { type ReactNode, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, Disclosure, TextAreaField } from "../primitives/controls.tsx";
import { clockTime } from "../primitives/format.ts";
import { DownloadIcon } from "../primitives/lucide.tsx";
import { BreakableCommand, CommandBlock, commandTextClass } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { CLI_INSTALL_COMMAND, type SandboxAccess, type SandboxesSource, type SandboxSshKey } from "./compute-model.ts";
import { messageOf, SectionHeading } from "./parts.tsx";

/** One OpenSSH public key, as the API takes it: the type, the key and an optional comment, on one line. */
const PUBLIC_KEY =
	/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;

/** Why a pasted public key won't do, or nothing when it will (or is empty: Kantel makes one). */
export function publicKeyProblem(text: string): string | undefined {
	const key = text.trim();
	if (key === "") return undefined;
	if (key.includes("PRIVATE KEY")) return "That's a private key: paste the public one, from the .pub file.";
	return PUBLIC_KEY.test(key) ? undefined : "Paste one OpenSSH public key, such as the line in ~/.ssh/id_ed25519.pub.";
}

/**
 * A command in code's font, with a Copy pinned to the corner: all of it shown, wrapping at spaces and slashes where it
 * is wider than its box (a phone), so it can be read before it is copied.
 */
function CommandLine({ command, copyLabel }: { command: string | undefined; copyLabel: string }) {
	return (
		<div className="flex min-h-control-lg min-w-0 items-start gap-2 rounded-panel border border-border bg-sunken py-1 pr-1 pl-3 font-mono text-code">
			<span className="flex-none py-1 leading-normal text-faint" aria-hidden="true">
				$
			</span>
			{command === undefined ? (
				<span className="flex-1">
					<Skeleton />
				</span>
			) : (
				<code className={`kt-selectable ${commandTextClass}`}>
					<BreakableCommand command={command} />
				</code>
			)}
			{command === undefined ? null : (
				<>
					<span className="max-sm:hidden">
						<CopyButton text={command} label={copyLabel} size="sm" variant="ghost" />
					</span>
					{/* On a phone Copy is its icon alone, so the command keeps the width. */}
					<span className="sm:hidden">
						<CopyButton text={command} label={copyLabel} size="sm" variant="ghost" iconOnly />
					</span>
				</>
			)}
		</div>
	);
}

function saveText(text: string, name: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Plain ssh's request and its answer, for one sandbox. */
interface Grant {
	readonly sandboxId: string;
	readonly publicKey: string;
	readonly busy: boolean;
	readonly failed?: Error;
	readonly granted?: SandboxSshKey;
}

/**
 * Plain ssh's state, kept by the SSH section rather than inside its disclosure, which unmounts what it hides: folding
 * it while a key is being let in, or after, keeps the answer (and the private key it carries, shown once) for when it
 * opens again. Another sandbox starts afresh, and an answer for one that's no longer shown is dropped.
 */
function useGrant(sandboxId: string, sshKey: SandboxesSource["sshKey"]) {
	const fresh: Grant = { sandboxId, publicKey: "", busy: false };
	const [grant, setGrant] = useState<Grant>(fresh);
	const shown = grant.sandboxId === sandboxId ? grant : fresh;
	const problem = publicKeyProblem(shown.publicKey);
	/** Changes this sandbox's state, starting afresh if the last one kept was another's. */
	const update = (change: (state: Grant) => Grant) =>
		setGrant((state) => change(state.sandboxId === sandboxId ? state : fresh));
	const setPublicKey = (publicKey: string) => update((state) => ({ ...state, publicKey }));
	const ask = () => {
		if (sshKey === undefined || problem !== undefined || shown.busy) return;
		const key = shown.publicKey.trim();
		update((state) => ({ sandboxId, publicKey: state.publicKey, busy: true, ...pick(state.granted) }));
		// Settles only the sandbox it was asked for: the page may show another by then.
		const settle = (change: (state: Grant) => Grant) =>
			setGrant((state) => (state.sandboxId === sandboxId ? change(state) : state));
		sshKey(sandboxId, key === "" ? undefined : key).then(
			(answer) => settle((state) => ({ sandboxId, publicKey: state.publicKey, busy: false, granted: answer })),
			(caught: unknown) =>
				settle((state) => ({
					...state,
					busy: false,
					failed: caught instanceof Error ? caught : new Error(String(caught)),
				})),
		);
	};
	return { ...shown, problem, setPublicKey, ask };
}

const pick = (granted: SandboxSshKey | undefined) => (granted === undefined ? {} : { granted });

/** Plain ssh: a key let in on request, and the command that uses it. */
function WithoutCli({ grant, now }: { grant: ReturnType<typeof useGrant>; now: number }) {
	const { publicKey, setPublicKey, busy, failed, granted, problem, ask } = grant;
	let result: ReactNode = null;
	if (granted !== undefined) {
		const { privateKey, keyFile, hostKeyFingerprint, expiresAt } = granted;
		result = (
			<div className="flex min-w-0 flex-col gap-3">
				{privateKey === undefined || keyFile === undefined ? null : (
					<div className="flex min-w-0 flex-col gap-2">
						<p className="m-0 text-sm text-muted">
							Kantel made a key pair and let its public key in. Download the private key now: it isn't shown again.
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="primary"
								icon={<DownloadIcon size="sm" />}
								onClick={() => saveText(privateKey, keyFile.name)}
							>
								Download key
							</Button>
							<CopyButton text={privateKey} label="Copy key" size="sm" />
							<span className="text-sm text-muted">
								Saved as <code className="font-mono text-code">{keyFile.path}</code>; change the path below if you keep
								it elsewhere.
							</span>
						</div>
					</div>
				)}
				<CommandBlock
					command={granted.command}
					label={
						expiresAt === undefined
							? "Run it in a terminal with websocat installed."
							: `Run it in a terminal with websocat installed, by ${clockTime(expiresAt, now)}; once connected it stays open.`
					}
				/>
				{privateKey === undefined ? (
					<p className="m-0 text-sm text-muted">
						ssh offers your default keys (such as <code className="font-mono text-code">~/.ssh/id_ed25519</code>) and
						ssh-agent's. If the key you pasted isn't one of them, add{" "}
						<code className="kt-selectable font-mono text-code text-fg">
							-i &lt;its private key file&gt; -o IdentitiesOnly=yes
						</code>{" "}
						after <code className="font-mono text-code">ssh</code>: the file on your machine without .pub, which never
						goes in the console.
					</p>
				) : null}
				{hostKeyFingerprint === undefined ? null : (
					<p className="m-0 text-sm text-muted">
						The first time, ssh asks you to trust the sandbox's host key: check it's{" "}
						<code className="kt-selectable font-mono text-code wrap-anywhere text-fg">{hostKeyFingerprint}</code>.
					</p>
				)}
			</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<p className="m-0 text-sm text-muted">
				Plain ssh, with{" "}
				<a href="https://github.com/vi/websocat" target="_blank" rel="noreferrer">
					websocat
				</a>{" "}
				as its ProxyCommand. Paste your OpenSSH public key to let it in, or leave it empty and Kantel makes a key pair
				for you to download.
			</p>
			<TextAreaField
				label="Your public key"
				hint="Optional: the line in ~/.ssh/id_ed25519.pub, or another .pub file."
				mono
				rows={2}
				value={publicKey}
				spellCheck={false}
				placeholder="ssh-ed25519 AAAA… you@laptop"
				{...(problem === undefined ? {} : { error: problem })}
				onChange={(event) => setPublicKey(event.target.value)}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" busy={busy} disabled={problem !== undefined} onClick={ask}>
					{granted === undefined ? "Get the command" : "Get another command"}
				</Button>
			</div>
			{failed === undefined ? null : (
				<Notice level="error">{messageOf(failed, "Kantel couldn't let the key in.")}</Notice>
			)}
			{result}
		</div>
	);
}

/** The SSH section: the CLI's command and how to get the CLI, then plain ssh on demand. */
export function SandboxSsh({
	source,
	sandboxId,
	access,
	onAccessRetry,
	now,
	withoutCliOpen = false,
}: {
	source: Pick<SandboxesSource, "sshKey">;
	sandboxId: string;
	access: SandboxAccess | "loading" | Error | undefined;
	onAccessRetry: () => void;
	now: number;
	/** Starts with "Without the Kantel CLI" open, for stories. */
	withoutCliOpen?: boolean;
}) {
	const ready = access !== undefined && access !== "loading" && !(access instanceof Error) ? access : undefined;
	const { sshKey } = source;
	const grant = useGrant(sandboxId, sshKey);
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="sandbox-ssh">
			<SectionHeading id="sandbox-ssh" title="SSH" />
			{access instanceof Error ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={onAccessRetry}>
							Try again
						</Button>
					}
				>
					{messageOf(access, "Kantel couldn't reach the sandbox.")}
				</Notice>
			) : (
				<>
					<CommandLine command={ready?.ssh} copyLabel="Copy" />
					<p className="m-0 text-sm text-muted">
						With the Kantel CLI, which needs Node.js 22 or later.{" "}
						{ready?.cliLogin === undefined ? "To install it:" : "Install it, then sign it in to this Kantel once:"}
					</p>
					<CommandLine command={CLI_INSTALL_COMMAND} copyLabel="Copy" />
					{ready?.cliLogin === undefined ? null : <CommandLine command={ready.cliLogin} copyLabel="Copy" />}
					{ready?.sshWithoutCli === true && sshKey !== undefined ? (
						<Disclosure summary="Without the Kantel CLI" defaultOpen={withoutCliOpen}>
							<WithoutCli grant={grant} now={now} />
						</Disclosure>
					) : null}
				</>
			)}
		</section>
	);
}
