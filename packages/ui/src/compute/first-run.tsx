// The first run (compute console): a super-admin's Sandboxes on a deployment with no host yet. Nothing can run a
// sandbox until a host joins, so the page leads with adding one: the join command, made as the page opens, and a wait
// for the host, then the two steps after it. Once a host joins, `onJoined` lets the console show Sandboxes as usual.

import type { ReactNode } from "react";
import type { Host, HostsSource } from "./compute-model.ts";
import { HostJoinCommand, JoinWaiting } from "./host-join.tsx";

export interface FirstRunProps {
	readonly source: HostsSource;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** A host joined. */
	readonly onJoined: (host: Host) => void;
	/** Stops the wait reading the hosts, for a story. */
	readonly poll?: boolean;
}

/**
 * A step's number: filled while it's the one to do, quiet after it. Its title sits beside the number; what the step
 * holds goes under the title, at every width.
 */
function Step({ n, current, title, children }: { n: number; current: boolean; title: string; children?: ReactNode }) {
	return (
		<li className="kt-first-run-step grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 max-sm:gap-x-2.5 border-t border-border py-4">
			<span
				className={`grid size-control-xs place-items-center rounded-sm text-sm font-medium tabular-nums ${current ? "bg-primary text-primary-fg" : "bg-active text-muted"}`}
				aria-hidden="true"
			>
				{n}
			</span>
			<h3
				className={`m-0 flex min-h-control-xs items-center text-sm leading-tight ${current ? "font-medium text-fg" : "font-regular text-muted"}`}
			>
				<span className="kt-sr-only">{`Step ${n}: `}</span>
				{title}
			</h3>
			{children === undefined ? null : <div className="col-start-2 flex min-w-0 flex-col gap-3">{children}</div>}
		</li>
	);
}

export function FirstRun({ source, now, onJoined, poll = true }: FirstRunProps) {
	return (
		<section
			className="kt-first-run flex w-full max-w-(--kt-content-width) min-w-0 flex-col gap-6 pt-4"
			aria-labelledby="kt-first-run-title"
		>
			<div className="flex min-w-0 flex-col gap-2">
				<h2 id="kt-first-run-title" className="m-0 text-lg font-strong leading-tight text-fg">
					Add a host to run sandboxes on
				</h2>
				<p className="m-0 text-muted">
					Any Linux machine with outbound HTTPS. It dials out, so it needs no open ports.
				</p>
			</div>
			<ol className="m-0 flex list-none flex-col p-0">
				<Step n={1} current title="Run this on the host">
					<HostJoinCommand source={source} {...(now === undefined ? {} : { now })} onJoined={onJoined} poll={poll} />
					{poll ? <JoinWaiting /> : null}
				</Step>
				<Step n={2} current={false} title="Create a sandbox" />
				<Step n={3} current={false} title="Use it from your code">
					<span className="-mt-2 text-sm text-faint">
						<code className="font-mono text-code">kantel login</code>, or an API key.
					</span>
				</Step>
			</ol>
		</section>
	);
}
