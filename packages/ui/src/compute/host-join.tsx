// Adding a host (compute console): the one-time join command to run on the new machine, made as soon as it shows,
// then a wait for the machine to join. Add host's dialog and the first run's first step share it. Where the address in
// the command is the control plane's loopback (a default install's `http://127.0.0.1:58090`), no other machine could
// follow it: a warning says so and, for a super-admin, takes the address hosts should use instead, then makes the
// command again with it.

import { useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { useLoad } from "../primitives/load.ts";
import { CommandBlock } from "../primitives/one-time-secret.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { expiresText, type Host, type HostJoin, type HostsSource, type PublicUrl } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

/** How often the wait reads the hosts again. */
const POLL_MS = 3000;

export type HostJoinInput = { readonly name?: string; readonly labels?: Readonly<Record<string, string>> };

export interface HostJoinCommandProps {
	readonly source: HostsSource;
	/** The new host's name and labels, which go with its token: a change makes the command again. */
	readonly input?: HostJoinInput;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** A host joined: one the hosts didn't have when the command was made. */
	readonly onJoined?: (host: Host) => void;
	/** Stops reading the hosts, for a story whose fixtures never change. */
	readonly poll?: boolean;
}

/** `http://127.0.0.1:58090` alone, or an origin: what the public URL field accepts. */
export function looksLikeOrigin(text: string): boolean {
	return /^https?:\/\/[^/\s?#]+\/?$/i.test(text.trim());
}

/**
 * The join command, the loopback warning when it needs one, what the machine needs, and the wait for it. Makes a
 * new command whenever `input` changes or the public URL is set.
 */
export function HostJoinCommand({ source, input, now: fixedNow, onJoined, poll = true }: HostJoinCommandProps) {
	const [made, setMade] = useState<{ readonly join?: HostJoin; readonly error?: string }>({});
	const [generation, setGeneration] = useState(0);
	const inputKey = JSON.stringify(input ?? {});
	const latestInput = useRef(input);
	latestInput.current = input;
	// The hosts there before any command is shown: a host that isn't among them joined with it.
	const waiting = poll && onJoined !== undefined;
	const baseline = useHostBaseline(source, waiting);

	useEffect(() => {
		// `generation` makes the command again after the public URL changes; `inputKey` after the name or labels do.
		void generation;
		void inputKey;
		if (baseline.known === undefined) return;
		let live = true;
		setMade({});
		source.join(latestInput.current ?? {}).then(
			(join) => {
				if (live) setMade({ join });
			},
			(caught: unknown) => {
				if (live) setMade({ error: messageOf(caught, "Kantel couldn't make a join command. Try again.") });
			},
		);
		return () => {
			live = false;
		};
	}, [source, inputKey, generation, baseline.known]);

	// The public URL, where this person may see and set it. An older gateway without the route leaves the warning out.
	const publicUrl = useLoad(
		() => (source.publicUrl === undefined ? Promise.resolve(undefined) : source.publicUrl.get()),
		[source],
	);
	const [shownUrl, setShownUrl] = useState<PublicUrl>();
	const url = shownUrl ?? (publicUrl.state.status === "ready" ? publicUrl.state.value : undefined);

	useJoinWait(source, waiting ? baseline.known : undefined, onJoined);

	const now = fixedNow ?? Date.now();
	// While other machines can't reach the console, the command works only on this machine: say so under it, with the
	// field that fixes it.
	const unreachable = url?.loopback === true && source.publicUrl !== undefined;
	const command =
		baseline.error !== undefined && baseline.known === undefined ? (
			<Notice level="error">{baseline.error}</Notice>
		) : made.error !== undefined ? (
			<Notice
				level="error"
				action={
					<Button size="sm" onClick={() => setGeneration((value) => value + 1)}>
						Try again
					</Button>
				}
			>
				{made.error}
			</Notice>
		) : made.join === undefined ? (
			<div aria-busy="true">
				<Skeleton lines={2} />
			</div>
		) : (
			<CommandBlock command={made.join.command} copyLabel="Copy" prompt />
		);
	const requirements = (
		<p className="m-0 text-sm text-muted">
			Linux on x86_64 or arm64, as root, with outbound HTTPS.{" "}
			{made.join === undefined
				? "The token works once."
				: `The token works once and ${expiresText(made.join.expiresAt, now).toLowerCase()}.`}
		</p>
	);
	return (
		<div className="kt-host-join flex min-w-0 flex-col gap-3">
			{command}
			{requirements}
			{/* Under the command, not instead of it: it runs as it is on this machine, and the field fixes it for others. */}
			{unreachable ? (
				<LoopbackWarning
					url={url}
					onSave={async (next) => {
						const saved = await (source.publicUrl as NonNullable<HostsSource["publicUrl"]>).set(next);
						setShownUrl(saved);
						setGeneration((value) => value + 1);
					}}
				/>
			) : null}
		</div>
	);
}

/** "Waiting for the host", while the wait runs: a spinner and the words, announced politely. */
export function JoinWaiting() {
	return (
		<span className="kt-host-join-waiting flex items-center gap-2 text-sm text-muted" role="status">
			<Spinner size="sm" />
			Waiting for the host
		</span>
	);
}

const NO_HOSTS: ReadonlySet<string> = new Set();

/**
 * The ids of the hosts there when adding one began, read once per source (and tried again until a read succeeds), so
 * neither making the command again nor a failed read in the wait forgets which hosts were already there. With no wait
 * (`on` false) there's nothing to compare with, and it's empty at once.
 */
function useHostBaseline(
	source: HostsSource,
	on: boolean,
): { readonly known?: ReadonlySet<string>; readonly error?: string } {
	const [state, setState] = useState<{ readonly known?: ReadonlySet<string>; readonly error?: string }>({});
	useEffect(() => {
		if (!on) {
			setState({ known: NO_HOSTS });
			return;
		}
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setState({});
		const read = () => {
			source.list().then(
				(hosts) => {
					if (live) setState({ known: new Set(hosts.map((host) => host.id)) });
				},
				(caught: unknown) => {
					if (!live) return;
					setState({ error: messageOf(caught, "Kantel couldn't read the hosts. Trying again.") });
					timer = setTimeout(read, POLL_MS);
				},
			);
		};
		read();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [source, on]);
	return state;
}

/**
 * Reads the hosts every few seconds once `known` (the hosts there before) is set, and calls `onJoined` with the first
 * host that isn't among them. A failed read is tried again at the next tick, against the same `known`.
 */
function useJoinWait(
	source: HostsSource,
	known: ReadonlySet<string> | undefined,
	onJoined: ((host: Host) => void) | undefined,
) {
	const latest = useRef(onJoined);
	latest.current = onJoined;
	useEffect(() => {
		if (known === undefined) return;
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			source.list().then(
				(hosts) => {
					if (!live) return;
					const joined = hosts.find((host) => !known.has(host.id));
					if (joined !== undefined) {
						latest.current?.(joined);
						return;
					}
					timer = setTimeout(tick, POLL_MS);
				},
				() => {
					if (live) timer = setTimeout(tick, POLL_MS);
				},
			);
		};
		timer = setTimeout(tick, POLL_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [source, known]);
}

/** The command's address is the control plane's loopback: say so, and take the one hosts should use. */
function LoopbackWarning({ url, onSave }: { url: PublicUrl; onSave: (url: string) => Promise<void> }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const save = () => {
		// Enter in the field while a save runs: one at a time.
		if (busy) return;
		if (!looksLikeOrigin(text)) {
			setError("Write an address such as https://kantel.example.com, with no path.");
			return;
		}
		setBusy(true);
		setError(undefined);
		onSave(text.trim()).then(
			() => {
				setBusy(false);
				setText("");
			},
			(caught: unknown) => {
				setBusy(false);
				setError(messageOf(caught, "Kantel couldn't save the address. Try again."));
			},
		);
	};
	return (
		<Notice level="warning">
			<div className="flex min-w-0 flex-col gap-2">
				<span>
					<strong className="font-medium text-fg">Other machines can't reach {url.publicUrl}.</strong> Give the console
					an address hosts can reach, then copy the command again.
				</span>
				<form
					className="flex min-w-0 items-start gap-2 max-sm:flex-col max-sm:items-stretch"
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<TextField
						className="min-w-0 flex-1"
						label="Public URL"
						hideLabel
						type="url"
						inputMode="url"
						placeholder="https://kantel.example.com"
						value={text}
						onChange={(event) => setText(event.currentTarget.value)}
						mono
						spellCheck={false}
						autoCapitalize="off"
						{...(error === undefined ? {} : { error })}
					/>
					<Button type="submit" size="md" busy={busy} disabled={text.trim() === ""}>
						Save
					</Button>
				</form>
			</div>
		</Notice>
	);
}
