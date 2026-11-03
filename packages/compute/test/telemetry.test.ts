import type { computeSchema } from "@kantel/api";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/store.ts";
import { createTelemetryExporter, otlpLogs, otlpMetrics } from "../src/telemetry.ts";

const event: computeSchema.Event = {
	id: "evt_1",
	type: "sandbox.running",
	accountId: "acc_1",
	createdAt: 1_700_000_000_000,
	sandboxId: "sbx_1",
	data: { name: "brave-otter", state: "running", previousState: "starting" },
};

interface MetricShape {
	readonly name: string;
	readonly gauge?: { readonly dataPoints: { readonly asDouble?: number; readonly asInt?: string }[] };
	readonly sum?: { readonly dataPoints: { readonly [key: string]: unknown }[] };
}

interface Sent {
	readonly url: string;
	readonly headers: Headers;
	readonly body: string;
}

function fakeCollector(status: number) {
	const sent: Sent[] = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		sent.push({ url: request.url, headers: request.headers, body: await request.text() });
		return new Response("{}", { status });
	};
	return { sent, fakeFetch };
}

describe("the OTLP payloads", () => {
	it("makes a lifecycle event a log record", () => {
		const payload = otlpLogs("acc_1", [{ event, sandboxType: "isolate" }]);
		const resourceLogs = payload.resourceLogs[0];
		expect(resourceLogs?.resource.attributes).toEqual([
			{ key: "service.name", value: { stringValue: "kantel" } },
			{ key: "kantel.account.id", value: { stringValue: "acc_1" } },
		]);
		const record = resourceLogs?.scopeLogs[0]?.logRecords[0];
		expect(record?.timeUnixNano).toBe("1700000000000000000");
		expect(record?.severityText).toBe("INFO");
		expect(record?.body).toEqual({ stringValue: "sandbox.running" });
		expect(record?.attributes).toEqual(
			expect.arrayContaining([
				{ key: "event.name", value: { stringValue: "sandbox.running" } },
				{ key: "kantel.sandbox.id", value: { stringValue: "sbx_1" } },
				{ key: "kantel.sandbox.type", value: { stringValue: "isolate" } },
			]),
		);
	});

	it("makes usage gauges and a running-time sum", () => {
		const payload = otlpMetrics("acc_1", [
			{
				accountId: "acc_1",
				sandboxId: "sbx_1",
				sandboxType: "microvm",
				cpu: 0.25,
				memoryBytes: 1024,
				runningSeconds: 90,
				at: 1_700_000_090_000,
				startedAt: 1_700_000_000_000,
			},
		]);
		const metrics =
			(
				JSON.parse(JSON.stringify(payload)) as {
					resourceMetrics: { scopeMetrics: { metrics: MetricShape[] }[] }[];
				}
			).resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
		expect(metrics.map((metric) => metric.name)).toEqual([
			"kantel.sandbox.cpu",
			"kantel.sandbox.memory_bytes",
			"kantel.sandbox.running_seconds",
		]);
		expect(metrics[0]?.gauge?.dataPoints[0]?.asDouble).toBe(0.25);
		expect(metrics[2]?.sum?.dataPoints[0]).toMatchObject({
			asDouble: 90,
			startTimeUnixNano: "1700000000000000000",
			timeUnixNano: "1700000090000000000",
		});
	});
});

describe("the exporter", () => {
	it("sends each account's events to its endpoint with its headers, and records the export", async () => {
		const store = createMemoryStore();
		await store.telemetry.put({
			id: "acc_1",
			accountId: "acc_1",
			endpoint: "https://otel.example/",
			headerNames: ["x-api-key"],
			headers: { "x-api-key": "key-1" },
			signals: ["logs"],
			updatedAt: 0,
		});
		const { sent, fakeFetch } = fakeCollector(200);
		const exporter = createTelemetryExporter({ store, fetch: fakeFetch, now: () => 42 });
		exporter.record({ event, sandboxType: "isolate" });
		exporter.record({ event: { ...event, id: "evt_2", accountId: "acc_2" } });
		await exporter.flush();

		expect(sent.map((request) => request.url)).toEqual(["https://otel.example/v1/logs"]);
		expect(sent[0]?.headers.get("x-api-key")).toBe("key-1");
		expect(sent[0]?.headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(sent[0]?.body ?? "{}") as ReturnType<typeof otlpLogs>;
		expect(body.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(1);
		expect((await store.telemetry.get("acc_1"))?.lastExport).toEqual({ at: 42, ok: true, status: 200 });

		await exporter.flush();
		expect(sent).toHaveLength(1);
	});

	it("tests a target with an empty export and answers what the collector said", async () => {
		const store = createMemoryStore();
		const refusing = fakeCollector(401);
		const result = await createTelemetryExporter({ store, fetch: refusing.fakeFetch }).test({
			endpoint: "https://otel.example",
			headers: { authorization: "Bearer nope" },
			signals: ["logs", "metrics"],
		});
		expect(result).toEqual({ ok: false, status: 401, error: "The collector answered 401" });
		expect(refusing.sent[0]?.url).toBe("https://otel.example/v1/logs");
		expect(JSON.parse(refusing.sent[0]?.body ?? "")).toEqual({ resourceLogs: [] });

		const accepting = fakeCollector(200);
		const ok = await createTelemetryExporter({ store, fetch: accepting.fakeFetch }).test({
			endpoint: "https://otel.example",
			headers: {},
			signals: ["metrics"],
		});
		expect(ok).toEqual({ ok: true, status: 200 });
		expect(accepting.sent[0]?.url).toBe("https://otel.example/v1/metrics");
	});
});
