// A host's memory, beside its disk when its row on the Hosts page is opened: what its sandboxes were given and what they
// count for against what it has for them (its memory less what it keeps for itself), what their guests use and hold of
// the machine, and the machine's own figures: available, swap and pressure. With memory over-commit on (experimental),
// it admits by what they count for, else by what they were given; it says which, and how short of memory it is. A host
// agent from before it reported its memory says nothing.

import { bytesText } from "../primitives/format.ts";
import { type Host, type HostMemory, usedShare } from "./compute-model.ts";

const MIB = 1024 * 1024;

const STATES: Readonly<Record<HostMemory["state"], { readonly text: string; readonly tone: string }>> = {
	ok: { text: "", tone: "text-muted" },
	tight: { text: "Short of memory: reclaiming guests' page cache.", tone: "text-status-approval" },
	refusing: { text: "Short of memory: refusing new sandboxes.", tone: "text-status-error" },
	critical: { text: "Out of memory: ending the largest guest processes.", tone: "text-status-error" },
};

export interface HostMemoryUsageProps {
	readonly host: Pick<Host, "name" | "memory">;
	/** A phone: the figures in one column. */
	readonly narrow?: boolean;
}

/** A host's memory: given and committed against what it has for sandboxes, then use, the machine, and its state. */
export function HostMemoryUsage({ host, narrow = false }: HostMemoryUsageProps) {
	const { memory } = host;
	if (memory === undefined) return null;
	const mib = (value: number) => bytesText(value * MIB);
	const byUse = memory.mode === "used";
	// The bar: what decides admission, against what may be admitted.
	const counted = byUse ? memory.committedMiB : memory.reservedMiB;
	const share = usedShare(counted, memory.capacityMiB);
	const tone = share >= 0.9 ? "bg-status-error" : share >= 0.75 ? "bg-status-approval" : "bg-muted";
	// Given may be more than there is (over-commit): its share isn't capped.
	const given = memory.capacityMiB <= 0 ? 0 : Math.round((memory.reservedMiB / memory.capacityMiB) * 100);
	const parts: readonly { readonly label: string; readonly value: string }[] = [
		{ label: "Given", value: `${mib(memory.reservedMiB)} (${given}%)` },
		{ label: "Committed", value: mib(memory.committedMiB) },
		{ label: "Guests use", value: mib(memory.guestUsedMiB) },
		{ label: "Resident", value: mib(memory.residentMiB) },
		{ label: "Available", value: mib(memory.availableMiB) },
		{ label: "Kept for the host", value: mib(memory.reserveMiB) },
		{ label: "Swap in use", value: mib(memory.swapUsedMiB) },
		{ label: "Pressure", value: `${memory.pressureSome.toFixed(1)}% some, ${memory.pressureFull.toFixed(1)}% full` },
	];
	const state = STATES[memory.state];
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-label={`${host.name}'s memory`} data-host-memory>
			<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
				<h3 className="m-0 text-sm font-medium text-fg">Memory</h3>
				<span className="text-sm text-muted tabular-nums">
					<span className="text-fg">{mib(counted)}</span> {byUse ? "committed" : "given"} of {mib(memory.capacityMiB)}{" "}
					for sandboxes
				</span>
			</div>
			<span
				className="block h-1 w-full overflow-hidden rounded-full bg-active"
				role="img"
				aria-label={`${Math.round(share * 100)}% of the memory for sandboxes ${byUse ? "committed" : "given"}`}
			>
				<span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.round(share * 100)}%` }} />
			</span>
			<dl
				className={`m-0 grid min-w-0 gap-x-6 gap-y-1 text-sm ${narrow ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"}`}
			>
				{parts.map((part) => (
					<div key={part.label} className="flex min-w-0 items-baseline justify-between gap-2">
						<dt className="truncate text-muted">{part.label}</dt>
						<dd className="m-0 text-fg tabular-nums">{part.value}</dd>
					</div>
				))}
			</dl>
			<p className="m-0 text-sm text-muted">
				{byUse
					? `Admits sandboxes by what they use (memory over-commit, experimental), giving at most ${memory.maxRatio}× its memory for sandboxes.`
					: `Admits sandboxes by what they're given, at most ${memory.maxRatio}× its memory for sandboxes.`}
			</p>
			{state.text === "" ? null : <p className={`m-0 text-sm ${state.tone}`}>{state.text}</p>}
		</section>
	);
}
