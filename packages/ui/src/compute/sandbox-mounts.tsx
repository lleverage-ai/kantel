// A sandbox's read-only mounts (experimental), on its Overview after its details: one row per mount, with where it
// appears in the sandbox, whether it's a bundle or a bucket, what its files come from, and whether they're in place.
// A failed mount says why under its status; the sandbox runs without it. Each row wraps rather than scrolling, so the
// same list reads in the details' column on a wide screen and on a phone.

import { CopyButton } from "../primitives/controls.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import type { MountSource, SandboxMount } from "./compute-model.ts";
import { bucketPathText, MOUNT_KIND_LABELS, MOUNT_STATUS_LABELS, MOUNT_STATUS_STATUS, shortDigest } from "./mounts.ts";
import { SectionHeading } from "./parts.tsx";

/** What a mount's files come from: a bundle's digest, to copy whole, or a bucket source and its bucket and prefix. */
function MountSourceText({ source }: { source: MountSource }) {
	if (source.kind === "bundle") {
		return (
			<span className="inline-flex min-w-0 items-center gap-1">
				<span className="kt-selectable truncate font-mono text-code" title={source.digest}>
					{shortDigest(source.digest)}
				</span>
				<CopyButton text={source.digest} iconOnly size="xs" variant="ghost" label="Copy digest" />
			</span>
		);
	}
	const path = bucketPathText(source.bucket, source.prefix);
	return (
		<>
			<span className="min-w-0 truncate text-fg">{source.bucketSourceName ?? source.bucketSourceId}</span>
			{path === undefined ? null : (
				<span className="kt-selectable min-w-0 truncate font-mono text-code" title={path}>
					{path}
				</span>
			)}
		</>
	);
}

export function SandboxMounts({ mounts }: { mounts: readonly SandboxMount[] }) {
	return (
		<section className="flex min-w-0 flex-col gap-3" aria-labelledby="sandbox-mounts">
			<SectionHeading id="sandbox-mounts" title="Mounts" />
			<p className="m-0 text-sm text-muted">Read-only: the sandbox can read these files but not change them.</p>
			<ul className="m-0 flex min-w-0 flex-col p-0 text-sm">
				{mounts.map((mount) => (
					<li
						key={mount.path}
						className="flex min-w-0 flex-col gap-1 border-b border-border py-2 first:pt-0 last:border-b-0 last:pb-0"
						data-mount={mount.path}
					>
						<div className="flex min-w-0 items-baseline justify-between gap-3">
							<span className="kt-selectable min-w-0 truncate font-mono text-code text-fg" title={mount.path}>
								{mount.path}
							</span>
							<StatusLabel status={MOUNT_STATUS_STATUS[mount.status]}>{MOUNT_STATUS_LABELS[mount.status]}</StatusLabel>
						</div>
						<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
							<span>{MOUNT_KIND_LABELS[mount.source.kind]}</span>
							<MountSourceText source={mount.source} />
						</div>
						{mount.status === "failed" && mount.error !== undefined ? (
							<p className="m-0 text-xs text-status-error wrap-anywhere">{mount.error}</p>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}
