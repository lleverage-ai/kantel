---
title: OpenTelemetry
description: Send an account's sandbox metrics and lifecycle events to any OTLP/HTTP collector, such as Grafana, Honeycomb or your own OpenTelemetry Collector, and check or remove the export.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, and a control plane serves them only when it runs with `KANTEL_COMPUTE=experimental`. Their shapes may still change.
:::

Kantel can send an account's telemetry to an OpenTelemetry collector over OTLP/HTTP:

- **Metrics** about its sandboxes, such as `kantel.sandbox.running`, `kantel.sandbox.cpu.seconds` and `kantel.sandbox.cost`, every 60 seconds.
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

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:1047-1098, packages/api/src/compute-schema.ts:1033-1083 -->
