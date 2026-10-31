/**
 * Usage analytics on the self-hosted gateway (docs/usage-analytics.md): the model gateway writes one row per call to
 * `usage_calls` in the gateway's Postgres schema, the record of truth. With `KANTEL_CLICKHOUSE_URL` set, a shipper
 * copies the rows to ClickHouse every `KANTEL_CLICKHOUSE_INTERVAL_S` seconds (default 15), in batches it can resend
 * without double counting; ClickHouse being down only delays it. `KANTEL_USAGE=off` writes no rows.
 */
import type { UsageWriter } from "@kantel/contracts";
import type { SqlDriver } from "@kantel/sql";
import {
	type ClickHouseUsageSinkOptions,
	clickHouseUsageSink,
	migrateClickHouseUsage,
} from "@kantel/usage/clickhouse";
import { createUsageShipper } from "@kantel/usage/shipper";
import { createSqlUsageLedger, migrateUsage } from "@kantel/usage/sql";

export interface UsageConfig {
	/** ClickHouse to ship to; without it the rows stay in Postgres only. */
	readonly clickhouse?: ClickHouseUsageSinkOptions & {
		readonly intervalMs: number;
		/** How long a row waits in the ledger before it ships (the shipper's default, 10 s); tests set 0. */
		readonly settleMs?: number;
	};
}

/** `KANTEL_USAGE`, `KANTEL_CLICKHOUSE_*`: undefined when usage is off. */
export function usageConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig | undefined {
	if (env.KANTEL_USAGE?.trim() === "off") return undefined;
	const url = env.KANTEL_CLICKHOUSE_URL?.trim() ?? "";
	if (url === "") return {};
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("KANTEL_CLICKHOUSE_URL must be ClickHouse's HTTP URL, such as http://clickhouse:8123");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("KANTEL_CLICKHOUSE_URL must be an http: or https: URL");
	}
	const interval = Number(env.KANTEL_CLICKHOUSE_INTERVAL_S?.trim() || "15");
	if (!Number.isFinite(interval) || interval < 1) throw new Error("KANTEL_CLICKHOUSE_INTERVAL_S must be at least 1");
	const user = env.KANTEL_CLICKHOUSE_USER?.trim();
	const password = env.KANTEL_CLICKHOUSE_PASSWORD;
	const database = env.KANTEL_CLICKHOUSE_DATABASE?.trim();
	return {
		clickhouse: {
			url,
			intervalMs: interval * 1_000,
			...(user ? { user } : {}),
			...(password ? { password } : {}),
			...(database ? { database } : {}),
		},
	};
}

export const CLICKHOUSE_USAGE_SINK = "clickhouse";

export interface SelfHostedUsage {
	readonly writer: UsageWriter;
	/** What `/v1/deployment` says backs usage. */
	readonly binding: string;
	close(): Promise<void>;
}

/** Migrates `usage_calls` and, with ClickHouse, starts its shipper. The shipper's failures are logged, never thrown. */
export async function selfHostedUsage(
	driver: SqlDriver,
	config: UsageConfig,
	log: (message: string) => void,
): Promise<SelfHostedUsage> {
	await migrateUsage(driver);
	const ledger = createSqlUsageLedger({ driver });
	const clickhouse = config.clickhouse;
	if (clickhouse === undefined) return { writer: ledger, binding: "postgres", close: async () => {} };

	let migrated = false;
	let failing = false;
	const shipper = createUsageShipper({
		ledger,
		sink: clickHouseUsageSink(clickhouse),
		name: CLICKHOUSE_USAGE_SINK,
		...(clickhouse.settleMs === undefined ? {} : { settleMs: clickhouse.settleMs }),
	});
	const tick = async () => {
		try {
			if (!migrated) {
				await migrateClickHouseUsage(clickhouse);
				migrated = true;
			}
			const shipped = await shipper.ship();
			if (failing) log(`[gateway] usage: ClickHouse is taking rows again (${shipped} shipped)`);
			failing = false;
		} catch (error) {
			// Logged once per outage; the ledger keeps the rows, and the next tick sends them.
			if (!failing) log(`[gateway] usage: shipping to ClickHouse failed, will retry: ${String(error)}`);
			failing = true;
		}
	};
	let running: Promise<void> | undefined;
	const start = () => {
		// A tick still running (a slow ClickHouse) is left to finish rather than queued behind.
		if (running !== undefined) return;
		running = tick().finally(() => {
			running = undefined;
		});
	};
	start();
	const timer = setInterval(start, clickhouse.intervalMs);
	timer.unref?.();
	return {
		writer: ledger,
		binding: "postgres + clickhouse",
		async close() {
			clearInterval(timer);
			await running;
		},
	};
}
