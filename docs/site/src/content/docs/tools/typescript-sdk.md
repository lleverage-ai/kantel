---
title: TypeScript SDK
description: Add Kantel's TypeScript SDK to a project, make a client, and create a sandbox, run a command, move files and clean up; with per-call options, errors and every compute method by group.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The SDK's compute methods call routes a control plane serves only when it runs with `KANTEL_COMPUTE=experimental`. Their shapes may still change.
:::

The TypeScript SDK is generated from the same route definitions as the API, so it has one method for each route, named as the [API reference](/api/reference/) names it, and types for every request and answer. It's one file with no imports of its own, built on `fetch`, so it runs in Node.js 22.18 or later, Bun, Deno, Cloudflare Workers and browsers.

## Add it to your project

The SDK isn't on npm. Inside Kantel's own repository it is the `@kantel/api/sdk` package export. Anywhere else, copy the file into your project:

```sh
curl -fsSL https://raw.githubusercontent.com/lleverage-ai/kantel/main/packages/api/generated/sdk.ts -o src/kantel-sdk.ts
```

and import it from there:

```ts
import { createKantelClient } from "./kantel-sdk.ts";
```

Node.js runs the `.ts` file as it is. If your project compiles with `tsc`, set `allowImportingTsExtensions`, or import it as `./kantel-sdk.js` the way your project imports its other files. Copy the file again to pick up new routes.

## Make a client

```ts
import { createKantelClient } from "./kantel-sdk.ts";

const kantel = createKantelClient({
	baseUrl: `${process.env.KANTEL_URL}/v1`,
	token: process.env.KANTEL_API_KEY,
});
```

`baseUrl` is your control plane's address with `/v1`, such as `http://127.0.0.1:58090/v1`. `token` is a [scoped API key](/accounts/api-keys/), sent as a bearer token. It can also be a function, which the client calls before each request, for a key that lives somewhere else, such as a mounted secret:

```ts
import { readFile } from "node:fs/promises";

const kantel = createKantelClient({
	baseUrl: "https://kantel.example.com/v1",
	token: async () => (await readFile("/run/secrets/kantel-api-key", "utf8")).trim(),
});
```

The other options are `headers`, a function that answers more headers for every call, and `fetch`, to use a `fetch` of your own instead of the global one.

## A first program

This makes a microVM, writes a file into it, runs it, reads the result and deletes the sandbox, even when something fails. It needs a key with the `ci` preset, which can delete:

```ts
import { createKantelClient } from "./kantel-sdk.ts";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });

const sandbox = await kantel.createSandbox({ type: "microvm", labels: { job: "hello" }, wait: true });
try {
	await kantel.writeFile(sandbox.id, { path: "hello.sh", content: "#!/bin/sh\nuname -a > out.txt\n", mode: "0755" });
	const run = await kantel.runCommand(sandbox.id, { command: "./hello.sh" });
	if (run.exitCode !== 0) throw new Error(`hello.sh failed: ${run.stderr}`);
	const out = await kantel.readFile(sandbox.id, { path: "out.txt" });
	console.log(out.content);
} finally {
	await kantel.deleteSandbox(sandbox.id);
}
```

Save it as `hello.ts` and run it with `node hello.ts`.

## How methods take their arguments

Each method takes the route's path parameters first, in order, then its body or its query, then per-call options:

```ts
await kantel.getCommand("sbx_4kq9x2mt", "cmd_9a8b7c");
await kantel.runCommand("sbx_4kq9x2mt", { command: "ls" }, { idempotencyKey: crypto.randomUUID() });
await kantel.listSandboxes({ all: true, label: { ticket: "PROJ-12" } });
```

The per-call options are:

| Option | What it does |
| --- | --- |
| `signal` | An `AbortSignal` to cancel the call |
| `idempotencyKey` | Sent as `Idempotency-Key` on the calls that take one (creating and forking sandboxes, running commands), so a retry with the same key does nothing twice |
| `requestId` | Sent as `kantel-request-id`, which ties the call to its entries in Kantel's audit trail |
| `headers` | More headers for this call |

## Errors

When Kantel answers with an error, the method rejects with a `KantelApiError`, which has the HTTP `status`, Kantel's error `code` and its `message`:

```ts
import { createKantelClient, KantelApiError } from "./kantel-sdk.ts";

try {
	await kantel.stopSandbox("sbx_4kq9x2mt", { keepMemory: true });
} catch (error) {
	if (error instanceof KantelApiError && error.code === "not_supported") {
		await kantel.stopSandbox("sbx_4kq9x2mt"); // an isolate: stop without keeping memory
	} else throw error;
}
```

The codes are listed under [ErrorCode](/api/reference/types/#errorcode). The ones to plan for are `conflict` (a sandbox in the wrong state, such as running a command in a stopped one), `exhausted` (a limit, or every host full: wait and try again) and `unavailable` (no host can take the call now). A call that never reaches Kantel, such as when the address is wrong, rejects with `fetch`'s own error instead.

## Types

Every type in the API is exported by name, so your code can use them:

```ts
import type { Sandbox, Command, Snapshot } from "./kantel-sdk.ts";

function summary(sandbox: Sandbox): string {
	return `${sandbox.name} (${sandbox.type}, ${sandbox.state})`;
}
```

## Methods

Each links to its route in the API reference.

| Group | Methods |
| --- | --- |
| [Sandboxes](/api/reference/sandboxes/) | `listSandboxes`, `createSandbox`, `getSandbox`, `updateSandbox`, `startSandbox`, `stopSandbox`, `resumeSandbox`, `forkSandbox`, `recoverSandbox`, `deleteSandbox`, `getSandboxUsage` |
| [Commands](/api/reference/commands/) | `runCommand`, `listCommands`, `getCommand`, `killCommand` |
| [Files](/api/reference/files/) | `readFile`, `writeFile`, `deleteFile`, `listFiles` |
| [Access](/api/reference/access/) | `listPorts`, `exposePort`, `hidePort`, `openSsh`, `openDesktop`, `openBrowser` |
| [Snapshots](/api/reference/snapshots/) | `listSnapshots`, `takeSnapshot`, `saveSnapshot`, `getSnapshot`, `listSnapshotFiles`, `readSnapshotFile`, `deleteSnapshot` |
| [Accounts](/api/reference/accounts/) | `getCaller`, `listAccounts`, `createOrganisation`, `joinOrganisation`, `getAccount`, `updateAccount`, `deleteOrganisation`, `getAccountUsage`, `listMembers`, `updateMember`, `removeMember`, `listInvites`, `createInvite`, `revokeInvite` |
| [API keys](/api/reference/api-keys/) | `listApiKeys`, `createApiKey`, `getApiKey`, `rotateApiKey`, `revokeApiKey` |
| [Events](/api/reference/events/) and [webhooks](/api/reference/webhooks/) | `listEvents`, `listWebhooks`, `createWebhook`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`, `testWebhook`, `listWebhookDeliveries` |
| [Telemetry](/api/reference/telemetry/) | `getTelemetry`, `putTelemetry`, `deleteTelemetry` |
| [Proxy](/api/reference/proxy/) | `getProxySettings`, `putProxySettings` |
| [Hosts](/api/reference/hosts/) | `listHosts`, `createHostJoinToken`, `getHost`, `updateHost`, `revokeHost` (super-admins only) |

The file also has methods for the routes of Kantel's earlier agent platform, which are being removed.

## Other languages

The SDK is made from Kantel's OpenAPI document, `packages/api/generated/openapi.json` in the repository. Any OpenAPI 3.1 generator can make a client from it in another language.

<!-- Sources (9cc20eb3): packages/api/generated/sdk.ts:4031-4120, packages/api/generated/sdk.ts:4842-4956, packages/api/src/sdk-runtime.ts:1-130, packages/api/package.json:1-20, packages/api/README.md:44-50 -->
