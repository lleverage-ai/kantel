---
title: OpenTelemetry
description: Send an account's sandbox metrics and lifecycle events to any OTLP/HTTP collector, such as Grafana, Honeycomb or your own OpenTelemetry Collector, and check or remove the export.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

Kantel can send an account's telemetry to an OpenTelemetry collector over OTLP/HTTP:

- **Metrics** about its sandboxes: their CPU, memory and running time, every 60 seconds. They're listed [below](#metrics).
- **Logs**: each lifecycle event, the same ones [webhooks](/monitoring/webhooks/#events) deliver, as an OTLP log record when it happens.

Each account has one export. The examples use `KANTEL_URL` and `KANTEL_API_KEY` as set in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start), and need a key with `account:admin`.

## Set the export

Give the collector's base URL and any headers it needs, such as an API key. Kantel adds `/v1/metrics` and `/v1/logs` to the URL:

```sh
curl -s -X PUT "$KANTEL_URL/v1/telemetry" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"endpoint": "https://otlp.example.com", "headers": {"x-api-key": "your-collector-key"}, "signals": ["metrics", "logs"]}'
```

```ts
const { telemetry, test } = await kantel.putTelemetry({
	endpoint: "https://otlp.example.com",
	headers: { "x-api-key": process.env.COLLECTOR_KEY! },
});
if (!test.ok) console.error("The collector refused the test export:", test.status, test.error);
```

`signals` chooses `metrics`, `logs` or both, and both is the default. Setting the export replaces any earlier one.

When you save it, Kantel sends the collector an empty export and answers with what came back, in `test`: `ok`, the HTTP `status`, and an `error` if it failed. A wrong URL or header shows up here, straight away.

Header values are kept encrypted and never shown again; the export lists only their names, in `headerNames`.

## Send to your own collector

To run a collector beside a self-hosted install, start the OpenTelemetry Collector with an OTLP receiver on HTTP and point the export at it. A minimal `otel-collector.yaml` that prints what arrives:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
```

```sh
docker run --rm -p 4318:4318 -v "$PWD/otel-collector.yaml:/etc/otelcol/config.yaml" otel/opentelemetry-collector:latest
```

Then set `"endpoint": "http://<collector-address>:4318"`, at an address your control plane can reach. Swap the `debug` exporter for your backend's when you're happy with what you see.

## Metrics

Every 60 seconds Kantel sends each reading of the account's sandboxes taken since the last export, so one export can hold several data points per sandbox. A sandbox that stopped since still sends the readings it had.

| Metric | Type | Unit | What it is |
| --- | --- | --- | --- |
| `kantel.sandbox.cpu` | Gauge | `1` | CPU utilisation, from 0 to 1. |
| `kantel.sandbox.memory_bytes` | Gauge | `By` | Memory in use, in bytes. |
| `kantel.sandbox.running_seconds` | Sum, cumulative and monotonic | `s` | The sandbox's running time so far, over all its runs. Its start time is when the sandbox started. |

Each data point has these attributes:

| Attribute | Value |
| --- | --- |
| `kantel.sandbox.id` | The sandbox's ID, such as `sbx_4d8n1x7pe2`. |
| `kantel.sandbox.type` | `isolate` or `microvm`. |

Metrics and logs share one resource and scope. The resource has `service.name` set to `kantel` and `kantel.account.id` set to the account's ID. The scope is `kantel.compute`.

## Check the export

```sh
curl -s "$KANTEL_URL/v1/telemetry" -H "authorization: Bearer $KANTEL_API_KEY"
```

```json
{
  "accountId": "acc_7f3k2m9q",
  "endpoint": "https://otlp.example.com",
  "headerNames": ["x-api-key"],
  "signals": ["metrics", "logs"],
  "lastExport": { "at": 1793664060000, "ok": true, "status": 200 },
  "updatedAt": 1793660400000
}
```

`lastExport` says how the latest real export went. An account with no export answers `404` with `not_found`.

## Remove the export

```sh
curl -s -X DELETE "$KANTEL_URL/v1/telemetry" -H "authorization: Bearer $KANTEL_API_KEY"
```

Kantel stops sending the account's telemetry.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:1047-1098, packages/api/src/compute-schema.ts:1033-1083; (d98df8d7): packages/compute/src/telemetry.ts:84-169, packages/compute/src/service.ts:5390-5428 -->
