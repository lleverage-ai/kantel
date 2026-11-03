/**
 * OpenTelemetry export over OTLP/HTTP with JSON bodies, with no dependencies: each account's lifecycle events become
 * log records (`POST <endpoint>/v1/logs`) and its sandboxes' usage becomes metrics (`POST <endpoint>/v1/metrics`:
 * gauges `kantel.sandbox.cpu` and `kantel.sandbox.memory_bytes`, the sum `kantel.sandbox.running_seconds`). Records
 * are batched per account and sent on `flush` (a timer's, or a test's), to the endpoint, headers and signals the account
 * set (`PutTelemetryBody`); the outcome is kept as the export's `lastExport`.
 */
import type { computeSchema } from "@kantel/api";
import type { ComputeStore } from "./store.ts";

/** A reading of one running sandbox, for the metrics export. */
export interface TelemetryUsageSample {
	readonly accountId: string;
	readonly sandboxId: string;
	readonly sandboxType: computeSchema.SandboxType;
	/** CPU utilisation, 0 to 1. */
	readonly cpu: number;
	readonly memoryBytes: number;
	/** Its running time so far, cumulative. */
	readonly runningSeconds: number;
	/** When it was read, epoch milliseconds. */
	readonly at: number;
	/** When it started running, for the sum's start time. */
	readonly startedAt?: number;
}

/** A lifecycle event and its sandbox's type, for the logs export. */
export interface TelemetryLogEntry {
	readonly event: computeSchema.Event;
	readonly sandboxType?: computeSchema.SandboxType;
}

/** Where to send an export. */
export interface TelemetryTarget {
	readonly endpoint: string;
	readonly headers: { readonly [name: string]: string };
	readonly signals: readonly ("metrics" | "logs")[];
}

/** What a collector answered. */
export interface TelemetryResult {
	readonly ok: boolean;
	readonly status?: number;
	readonly error?: string;
}

export interface TelemetryExporterOptions {
	readonly store: ComputeStore;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Default `Date.now`. */
	readonly now?: () => number;
	/** Default 10 000. */
	readonly timeoutMs?: number;
	/** Reads the running sandboxes' usage at each flush, for the metrics. */
	readonly collect?: () => Promise<readonly TelemetryUsageSample[]>;
}

export interface TelemetryExporter {
	/** Queues an event as a log record for its account. */
	record(entry: TelemetryLogEntry): void;
	/** Queues a usage reading for its account's metrics. */
	recordUsage(sample: TelemetryUsageSample): void;
	/** Sends every account's queued records (and fresh usage, with `collect`) now. */
	flush(): Promise<void>;
	/** Sends an empty export to a target, as saving it does, and answers what the collector said. */
	test(target: TelemetryTarget): Promise<TelemetryResult>;
	/** Flushes every `intervalMs` (default 60 000) until `stop`. */
	start(intervalMs?: number): void;
	stop(): void;
}

type AnyValue = { readonly stringValue: string } | { readonly doubleValue: number } | { readonly intValue: string };
interface KeyValue {
	readonly key: string;
	readonly value: AnyValue;
}

const text = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
/** Epoch milliseconds as OTLP's nanoseconds, a decimal string. */
const nanos = (ms: number): string => `${Math.round(ms)}000000`;
const SCOPE = { name: "kantel.compute", version: "0" };
/** The most records queued between flushes; older ones are dropped. */
const MAX_QUEUED = 10_000;

const resource = (accountId: string) => ({
	attributes: [text("service.name", "kantel"), text("kantel.account.id", accountId)],
});

function severityOf(type: computeSchema.EventType): { readonly severityNumber: number; readonly severityText: string } {
	if (type === "sandbox.error") return { severityNumber: 17, severityText: "ERROR" };
	if (type === "sandbox.degraded") return { severityNumber: 13, severityText: "WARN" };
	return { severityNumber: 9, severityText: "INFO" };
}

/** The OTLP/JSON logs body for one account's events. */
export function otlpLogs(accountId: string, entries: readonly TelemetryLogEntry[]) {
	return {
		resourceLogs: [
			{
				resource: resource(accountId),
				scopeLogs: [
					{
						scope: SCOPE,
						logRecords: entries.map(({ event, sandboxType }) => ({
							timeUnixNano: nanos(event.createdAt),
							observedTimeUnixNano: nanos(event.createdAt),
							...severityOf(event.type),
							body: { stringValue: event.type },
							attributes: [
								text("event.name", event.type),
								text("kantel.event.id", event.id),
								...(event.sandboxId === undefined ? [] : [text("kantel.sandbox.id", event.sandboxId)]),
								...(sandboxType === undefined ? [] : [text("kantel.sandbox.type", sandboxType)]),
								...(event.snapshotId === undefined ? [] : [text("kantel.snapshot.id", event.snapshotId)]),
								...(event.data.state === undefined ? [] : [text("kantel.sandbox.state", event.data.state)]),
								...(event.data.reason === undefined ? [] : [text("kantel.reason", event.data.reason)]),
							],
						})),
					},
				],
			},
		],
	};
}

/** The OTLP/JSON metrics body for one account's usage readings. */
export function otlpMetrics(accountId: string, samples: readonly TelemetryUsageSample[]) {
	const attributes = (sample: TelemetryUsageSample) => [
		text("kantel.sandbox.id", sample.sandboxId),
		text("kantel.sandbox.type", sample.sandboxType),
	];
	return {
		resourceMetrics: [
			{
				resource: resource(accountId),
				scopeMetrics: [
					{
						scope: SCOPE,
						metrics: [
							{
								name: "kantel.sandbox.cpu",
								unit: "1",
								description: "CPU utilisation, 0 to 1.",
								gauge: {
									dataPoints: samples.map((sample) => ({
										timeUnixNano: nanos(sample.at),
										asDouble: sample.cpu,
										attributes: attributes(sample),
									})),
								},
							},
							{
								name: "kantel.sandbox.memory_bytes",
								unit: "By",
								description: "Memory in use.",
								gauge: {
									dataPoints: samples.map((sample) => ({
										timeUnixNano: nanos(sample.at),
										asInt: String(Math.round(sample.memoryBytes)),
										attributes: attributes(sample),
									})),
								},
							},
							{
								name: "kantel.sandbox.running_seconds",
								unit: "s",
								description: "Running time, cumulative.",
								sum: {
									aggregationTemporality: 2,
									isMonotonic: true,
									dataPoints: samples.map((sample) => ({
										startTimeUnixNano: nanos(sample.startedAt ?? sample.at),
										timeUnixNano: nanos(sample.at),
										asDouble: sample.runningSeconds,
										attributes: attributes(sample),
									})),
								},
							},
						],
					},
				],
			},
		],
	};
}

const groupBy = <T extends { readonly accountId: string }>(items: readonly T[]): Map<string, T[]> => {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = groups.get(item.accountId) ?? [];
		group.push(item);
		groups.set(item.accountId, group);
	}
	return groups;
};

/** The exporter of every account's telemetry to its OTLP endpoint. */
export function createTelemetryExporter(options: TelemetryExporterOptions): TelemetryExporter {
	const { store } = options;
	const now = options.now ?? (() => Date.now());
	const doFetch: typeof fetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 10_000;
	let logs: { readonly accountId: string; readonly entry: TelemetryLogEntry }[] = [];
	let usage: TelemetryUsageSample[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	async function post(target: TelemetryTarget, path: string, body: unknown): Promise<TelemetryResult> {
		try {
			const response = await doFetch(`${target.endpoint.replace(/\/+$/, "")}${path}`, {
				method: "POST",
				headers: { ...target.headers, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			await response.body?.cancel().catch(() => undefined);
			return response.ok
				? { ok: true, status: response.status }
				: { ok: false, status: response.status, error: `The collector answered ${response.status}` };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function send(
		accountId: string,
		signal: "logs" | "metrics",
		body: unknown,
	): Promise<TelemetryResult | undefined> {
		const config = await store.telemetry.get(accountId);
		if (config === undefined || !config.signals.includes(signal)) return undefined;
		const result = await post(config, signal === "logs" ? "/v1/logs" : "/v1/metrics", body);
		const latest = (await store.telemetry.get(accountId)) ?? config;
		await store.telemetry.put({
			...latest,
			lastExport: {
				at: now(),
				ok: result.ok,
				...(result.status === undefined ? {} : { status: result.status }),
				...(result.error === undefined ? {} : { error: result.error }),
			},
		});
		return result;
	}

	const exporter: TelemetryExporter = {
		record(entry) {
			logs.push({ accountId: entry.event.accountId, entry });
			if (logs.length > MAX_QUEUED) logs = logs.slice(-MAX_QUEUED);
		},

		recordUsage(sample) {
			usage.push(sample);
			if (usage.length > MAX_QUEUED) usage = usage.slice(-MAX_QUEUED);
		},

		async flush() {
			if (options.collect !== undefined) usage.push(...(await options.collect()));
			const takenLogs = logs;
			const takenUsage = usage;
			logs = [];
			usage = [];
			for (const [accountId, group] of groupBy(takenLogs)) {
				await send(
					accountId,
					"logs",
					otlpLogs(
						accountId,
						group.map((item) => item.entry),
					),
				);
			}
			for (const [accountId, group] of groupBy(takenUsage)) {
				await send(accountId, "metrics", otlpMetrics(accountId, group));
			}
		},

		async test(target) {
			return target.signals.includes("logs")
				? post(target, "/v1/logs", { resourceLogs: [] })
				: post(target, "/v1/metrics", { resourceMetrics: [] });
		},

		start(intervalMs = 60_000) {
			if (timer !== undefined) return;
			timer = setInterval(() => {
				exporter.flush().catch(() => undefined);
			}, intervalMs);
			(timer as { unref?: () => void }).unref?.();
		},

		stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		},
	};
	return exporter;
}
