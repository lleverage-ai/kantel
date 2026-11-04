// A host's live usage on the Hosts page: its CPU and memory as sparklines in its row, and its CPU, memory and disk as
// larger graphs when the row is opened. Each row reads its own host's points through the hosts source's `usage`, every
// few seconds while the page is visible; an offline or joining host reads nothing and shows what's allocated on it.

import type { Host, HostsSource } from "./compute-model.ts";
import {
	gbBytes,
	gbText,
	type LiveUsage,
	lineOf,
	ROW_SPAN_MS,
	seriesOf,
	USAGE_KEEP_MS,
	useLiveUsage,
} from "./live-usage.ts";
import { Sparkline, UsageGraph } from "./parts.tsx";

/** Whether a host has usage to read: one that's up. */
const reports = (host: Host): boolean => host.state === "online" || host.state === "draining";

/** A host's live usage, or `off` where there's no live source or it's down. */
export const useHostUsage = (source: HostsSource, host: Host): LiveUsage =>
	useLiveUsage(reports(host) ? source.usage : undefined, host.id);

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** A row's live CPU: its line over the last 2 minutes and the latest figure. Undefined when it has none to show. */
export function HostCpu({ host, live }: { host: Host; live: LiveUsage }) {
	const series = seriesOf(live);
	const loading = live.status === "loading";
	const { values, timed } = lineOf(series, (point) => point.cpu, ROW_SPAN_MS);
	const latest = values.at(-1);
	return (
		<span className="flex items-center gap-2">
			<Sparkline
				values={values}
				timed={timed}
				loading={loading}
				label={
					loading
						? `Reading ${host.name}'s CPU`
						: `${host.name}'s CPU over the last 2 minutes, peak ${percent(Math.max(0, ...values))}`
				}
			/>
			<span className="w-8 text-right text-muted tabular-nums">
				{latest === undefined ? <span className="text-faint">–</span> : percent(latest)}
			</span>
		</span>
	);
}

/** A row's live memory: its share of the host's over the last 2 minutes, and how many GB of how many now. */
export function HostMemory({ host, live }: { host: Host; live: LiveUsage }) {
	const series = seriesOf(live);
	const loading = live.status === "loading";
	const total = series?.memLimitBytes ?? gbBytes(host.memoryGb);
	const { values: used, timed } = lineOf(series, (point) => point.memUsedBytes, ROW_SPAN_MS);
	const latest = used.at(-1);
	return (
		<span className="flex items-center gap-2">
			<Sparkline
				values={used.map((bytes) => bytes / total)}
				timed={timed}
				loading={loading}
				tone="working"
				label={loading ? `Reading ${host.name}'s memory` : `${host.name}'s memory over the last 2 minutes`}
			/>
			<span className="text-muted tabular-nums">
				{latest === undefined ? (
					<span className="text-faint">–</span>
				) : (
					<>
						<span className="text-fg">{gbText(latest)}</span> of {gbText(total)}
					</>
				)}
			</span>
		</span>
	);
}

/**
 * An opened row: the host's CPU, memory and disk over the last 10 minutes, side by side, or one under another on a
 * phone, and what's given to its sandboxes under them.
 */
export function HostGraphs({ host, live, narrow = false }: { host: Host; live: LiveUsage; narrow?: boolean }) {
	const series = seriesOf(live);
	const loading = live.status === "loading";
	const memTotal = series?.memLimitBytes ?? gbBytes(host.memoryGb);
	const diskTotal = series?.diskTotalBytes ?? gbBytes(host.diskGb);
	const cpu = lineOf(series, (point) => point.cpu, USAGE_KEEP_MS);
	const memory = lineOf(series, (point) => point.memUsedBytes, USAGE_KEEP_MS);
	const disk = lineOf(series, (point) => point.diskUsedBytes, USAGE_KEEP_MS);
	const last = series?.points.at(-1);
	const down = live.status === "off";
	return (
		<div className="flex min-w-0 flex-col gap-3" data-host-graphs={host.id}>
			<div className={`grid min-w-0 gap-4 ${narrow ? "grid-cols-1" : "grid-cols-3"}`}>
				<UsageGraph
					title="CPU"
					{...(last === undefined ? {} : { value: `${percent(last.cpu)} of ${host.vcpus} vCPU` })}
					values={cpu.values}
					timed={cpu.timed}
					loading={loading}
					label={`${host.name}'s CPU over the last 10 minutes, peak ${percent(Math.max(0, ...cpu.values))}`}
				/>
				<UsageGraph
					title="Memory"
					{...(last === undefined ? {} : { value: `${gbText(last.memUsedBytes)} of ${gbText(memTotal)} GB` })}
					values={memory.values}
					max={memTotal}
					timed={memory.timed}
					tone="working"
					loading={loading}
					label={`${host.name}'s memory over the last 10 minutes`}
				/>
				<UsageGraph
					title="Disk"
					{...(last?.diskUsedBytes === undefined
						? {}
						: { value: `${gbText(last.diskUsedBytes)} of ${gbText(diskTotal)} GB` })}
					values={disk.values}
					max={diskTotal}
					timed={disk.timed}
					tone="muted"
					loading={loading}
					label={`${host.name}'s disk over the last 10 minutes`}
				/>
			</div>
			<p className="m-0 text-xs text-muted">
				{down ? `No readings while it's ${host.state === "joining" ? "joining" : "offline"}. ` : "Last 10 minutes. "}
				{`Given to sandboxes: ${host.used.vcpus} of ${host.vcpus} vCPU, ${gbText(gbBytes(host.used.memoryGb))} of ${gbText(gbBytes(host.memoryGb))} GB memory.`}
			</p>
		</div>
	);
}
