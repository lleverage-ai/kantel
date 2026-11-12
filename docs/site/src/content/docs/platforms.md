---
title: Build a platform on Kantel
description: Run sandboxes for your own customers' agents and workflows on Kantel - one organisation per customer, an API key each, isolates for scripts and microVMs when a task needs a machine.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
This page describes the compute API, which every control plane serves. Its shapes may still change.
:::

This page is for a product that runs agents or workflows for its own customers and needs somewhere to run their commands and code: an agent platform, a workflow engine, a code-mode tool runner. Kantel gives it sandboxes, kept apart per customer, from one deployment on shared hosts.

## One organisation per customer

Make a Kantel [organisation](/accounts/organisations/) for each of your customers, and keep every sandbox of that customer in it. An organisation is where Kantel draws its lines:

- **Isolates run in their organisation's own VM.** On each host, all of an account's isolates run in one small Firecracker VM of that account's (one process, a V8 isolate per sandbox, inside it), with no network device. Two customers' isolates are never in the same VM or process, so a bug that broke out of V8 would land in that customer's own VM, not next to another's. On a host without KVM, each account's runtime is its own process, under its own user and cgroup, on its own Unix sockets.
- **A microVM is always its own VM**, whatever the account.
- **Keys, sandboxes, snapshots, environments, webhooks and usage** belong to the account. A record in another organisation answers `not_found`, so IDs leak nothing across customers.
- **Usage and limits** are per account, so each customer's use is counted on its own.

Inside one organisation, one sandbox's isolate can't read another's files, and every command, `node` run and `python` run has its own CPU and memory limits, so one runaway script stops only itself.

### Making the organisations

Creating an organisation needs a person, not an API key, so give your platform a person of its own (a service account you sign in as once), and a [personal access token](/accounts/api-keys/#personal-access-tokens) with no limits for it. With that token:

```sh
# One organisation per customer: it answers the new account, with its ID.
curl -s "$KANTEL_URL/v1/accounts" \
  -H "authorization: Bearer $KANTEL_PLATFORM_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: customer-4711" \
  -d '{"name": "customer-4711", "defaultVisibility": "organisation"}' | jq -r .id

# An API key in it, for your service to use for that customer.
curl -s "$KANTEL_URL/v1/api-keys" \
  -H "authorization: Bearer $KANTEL_PLATFORM_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name": "platform", "preset": "ci", "account": "acc_7f3k2m9q"}' | jq -r .secret
```

Store each customer's key in your secret manager, beside the customer's record, and use it for everything you do for that customer: a key acts only in the account it was made in, so a bug in your service can't send one customer's command to another's sandbox. A personal token lasts at most 366 days: make a new one before it runs out (making accounts and keys needs it; the keys it made carry on working).

## Picking a sandbox for each task

- **Start in an isolate.** It starts in milliseconds and costs almost nothing, and most of what an agent does fits: calling APIs, reading and reshaping files, short scripts with [`node` and `python`](/sandboxes/types/#node-and-python). Create it when the agent first needs to run something, not when its session starts.
- **Upgrade when the task needs a machine.** A command that needs something an isolate hasn't got (`git`, a package install, a build, Docker) answers `needsMicrovm`. [Upgrade](/sandboxes/types/#upgrade-an-isolate-to-a-microvm) the sandbox, or create it with `autoUpgrade: true` to have Kantel do it and run the command again. It keeps its ID, files, environments and grants, so your records don't change.
- **Make a microVM up front** only for work you know needs one: a repository to build, a browser, a server with a URL.

```ts
import { createKantelClient } from "./kantel-sdk.ts"; // the TypeScript SDK, copied into your project

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: customer.kantelKey });
const sandbox = await kantel.createSandbox({
	type: "isolate",
	labels: { session: session.id },
	environments: [customer.kantelEnvironmentId],
	autoUpgrade: true,
	idleStopMinutes: 15,
	wait: true,
});
const run = await kantel.runCommand(sandbox.id, { command: "python report.py", timeoutMs: 120_000 });
if (run.rerunAs !== undefined) {
	// It needed a microVM: Kantel upgraded the sandbox and ran the command again there.
}
```

An automatic upgrade runs the whole command again, so make commands that may need one safe to repeat. Opting a sandbox into `autoUpgrade` needs `sandboxes:write`; after that, a key with only `exec` can cause the upgrade.

## Secrets and the network

Put each customer's credentials in an [environment](/sandboxes/environments/) in their organisation, as protected variables. A sandbox made from it gets a placeholder, and the [egress proxy](/sandboxes/egress-proxy/) swaps in the real value only on requests to the hosts it's bound to, so code in the sandbox, a `node` or `python` script included, never holds the secret. Give the environment the grants (allowed hosts and methods) that customer's work needs. `kantel egress <sandbox>`, or the API's egress log, shows every request a sandbox made, and whether a secret went with it.

## Files in and out

The [files API](/sandboxes/commands-and-files/) reads and writes a sandbox's files without a command, up to 1 MiB a call, so your service can put a customer's inputs into a sandbox before the agent starts and read its outputs after. An isolate keeps its files in `/workspace`, and a relative path starts there; a microVM's start in `/home/user`, and an upgraded isolate's files are at `/home/user/workspace`, with `/workspace` a link to them.

## Hosts

Every customer can share the same hosts: the VM per account is what keeps them apart. To give a customer hosts of its own, add the hosts to that customer's organisation as [its own hosts](/own-hosts/), or label them and create that customer's sandboxes with `hostLabels`. Isolates' memory is the isolate's (128 to 512 MB); each account's isolate VM on a host holds all of that account's isolates there.

## What isn't there yet

- **One runtime per account per host.** An account with very many isolates on one host shares that VM's CPU and memory among them. Placement doesn't yet spread one account's isolates across hosts by load.
- **An isolate's memory limit is checked at allocations and garbage collections**, not continuously: the heap, buffers and WebAssembly memory share one budget, but a run can briefly go over it between collections before it is stopped.
- **No npm or pip packages in an isolate**, other than Pyodide's own (such as numpy). Code that needs them runs in a microVM.

See [What works today](/what-works-today/) for what has been shown on real machines.
