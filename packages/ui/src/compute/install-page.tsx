// Admin's Install page (compute console): what a super-admin sets for the whole install. For now its public URL, the
// address hosts reach the control plane at, which every join command carries. The deployment sets one
// (`KANTEL_PUBLIC_URL`, or the address the console was opened at); one set here goes ahead of it until it's cleared.

import { useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { PublicUrl, PublicUrlSource } from "./compute-model.ts";
import { looksLikeOrigin } from "./host-join.tsx";
import { computePage, messageOf, SectionHeading } from "./parts.tsx";

export interface InstallPageProps {
	readonly source: PublicUrlSource;
	/** A phone. The page is the same at every width now that every title has the heading size; kept for callers. */
	readonly narrow?: boolean;
}

export function InstallPage({ source }: InstallPageProps) {
	const { state, reload } = useLoad(() => source.get(), [source]);
	const [saved, setSaved] = useState<PublicUrl>();
	const url = saved ?? (state.status === "ready" ? state.value : undefined);
	return (
		<div className={computePage}>
			<header className="kt-page-header flex min-h-control-md min-w-0 items-center border-b border-border pb-3">
				<h1 className={`m-0 truncate font-strong leading-tight text-fg text-heading`}>Install</h1>
			</header>
			<section className="flex max-w-(--kt-content-width) min-w-0 flex-col gap-3" aria-labelledby="kt-public-url">
				<SectionHeading id="kt-public-url" title="Public URL" />
				<p className="m-0 text-muted">The address hosts reach this install at. Every join command carries it.</p>
				{state.status === "error" && url === undefined ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the public URL.")}
					</Notice>
				) : url === undefined ? (
					<Skeleton lines={2} />
				) : (
					<PublicUrlForm key={url.publicUrl} url={url} source={source} onSaved={setSaved} />
				)}
			</section>
		</div>
	);
}

function PublicUrlForm({
	url,
	source,
	onSaved,
}: {
	url: PublicUrl;
	source: PublicUrlSource;
	onSaved: (url: PublicUrl) => void;
}) {
	const [text, setText] = useState(url.setHere ? url.publicUrl : "");
	const [busy, setBusy] = useState<"save" | "clear">();
	const [error, setError] = useState<string>();
	// One change at a time: a Save and a reset both write the same setting, and the later one the person pressed must
	// be the one that stays. The ref stops a second start in the same tick, before `busy` has re-rendered the buttons.
	const inFlight = useRef(false);
	const run = (kind: "save" | "clear", next: string | null) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(kind);
		setError(undefined);
		source.set(next).then(
			(made) => {
				inFlight.current = false;
				setBusy(undefined);
				onSaved(made);
			},
			(caught: unknown) => {
				inFlight.current = false;
				setBusy(undefined);
				setError(messageOf(caught, "Kantel couldn't save the public URL. Try again."));
			},
		);
	};
	const save = () => {
		if (!looksLikeOrigin(text)) {
			setError("Write an address such as https://kantel.example.com, with no path.");
			return;
		}
		run("save", text.trim());
	};
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<code className="font-mono text-code text-fg wrap-anywhere">{url.publicUrl}</code>
				<Badge>{url.setHere ? "Set here" : "The deployment's"}</Badge>
			</div>
			{url.loopback ? (
				<Notice level="warning">Other machines can't reach {url.publicUrl}. Set an address hosts can reach.</Notice>
			) : null}
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
				<Button
					type="submit"
					variant="primary"
					size="md"
					busy={busy === "save"}
					disabled={text.trim() === "" || busy !== undefined}
				>
					Save
				</Button>
			</form>
			{url.setHere ? (
				<div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted">
					<span>
						The deployment's is <code className="font-mono text-code">{url.deploymentUrl}</code>.
					</span>
					<Button
						size="sm"
						variant="ghost"
						busy={busy === "clear"}
						disabled={busy !== undefined}
						onClick={() => run("clear", null)}
					>
						Use the deployment's
					</Button>
				</div>
			) : null}
		</div>
	);
}
