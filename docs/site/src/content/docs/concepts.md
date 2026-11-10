---
title: Concepts
description: "The words Kantel uses, each defined once: control plane, host, sandbox, type, stop, resume, fork, snapshot, saved snapshot, template, account, organisation, API key and proxy, and how they fit together."
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
Kantel is still being built. The pages for each part say what works today.
:::

## The control plane and hosts

Kantel has two halves.

The **control plane** is what you talk to. It serves the console and the API, signs people in, keeps accounts, organisations and API keys, and decides which machine each sandbox runs on. It holds the records and the credentials, and never runs a sandbox itself.

A **host** is a Linux machine that runs sandboxes. It needs KVM, so a bare-metal server, or a cloud VM that allows nested virtualisation. A host connects out to the control plane and keeps that connection open, so it needs no inbound ports and can sit behind NAT or a home router. It holds the sandboxes' disks and images, and no credential except its own, which the control plane can revoke at any time.

One control plane drives any number of hosts. You can mix a server under your desk, a few cloud machines and a spare laptop running Linux.

## Sandboxes

A **sandbox** is one isolated Linux environment, created for an agent or a task. You run commands in it, move files in and out, and connect to it. Every sandbox has an ID and belongs to a personal account or an organisation.

A sandbox is one of two **types**, or tiers:

| Type | What it is | Good for |
| --- | --- | --- |
| Isolate | A V8 isolate run by workerd, Cloudflare's open-source Workers runtime | Quick scripts and shell work that doesn't need a real Linux kernel. Starts fastest and costs least |
| microVM | A Firecracker virtual machine with its own Linux kernel | Anything a normal Linux machine does: root, packages, Docker, and `/dev/kvm` for virtualisation inside the sandbox |

Both are driven through the same API, so moving work from one to the other doesn't change your code.

## Lifecycle

A sandbox is **created** from a base image or a saved snapshot, and runs until you stop it or it stops itself.

- **Stop** shuts the sandbox down and keeps its disk. Running processes end.
- **Resume** starts a stopped sandbox again from its disk.
- **Fork** makes a new sandbox from a copy of an existing one, so you can prepare one sandbox and start many agents from it.
- **Recover** tries to bring back a sandbox that has gone into an error state.
- **Delete permanently** removes the sandbox and its snapshots. It can't be undone.

## Snapshots

A **snapshot** is a copy of a sandbox's disk at one moment. Kantel takes them for you, so each sandbox has a **history** you can browse and restore files from.

A **saved snapshot** is one you keep on purpose, under a name. It outlives the sandbox it came from, and you can create any number of new sandboxes from it: set a sandbox up once, with your repository cloned and your caches warm, save it, and start every new sandbox in that state.

## Templates

A **template** describes an environment rather than recording one: an image, a size, variables, a setup script and its network rules, in versions that never change once made. Kantel builds each version into a snapshot itself and keeps it as a cache, so sandboxes made from the template restore instead of booting, and when the template or its base image changes, Kantel builds it again. Templates are experimental, and on only where a deployment turns them on.

Use a template for an environment you want to reproduce and keep patched, and a saved snapshot for a particular state you can't easily script, such as a checkout at one commit with its build caches warm. They work together: start a sandbox from a template, do the slow work, and save the result.

## Accounts and organisations

Everyone has a **personal account**, and what you create is yours by default. An **organisation** is a group of people who share sandboxes, snapshots, API keys and settings. You can create one or be invited to one, and switch between your personal account and your organisations in the console.

## API keys

An **API key** lets a program act for an account or an organisation without signing in. Each key has **scopes**, the actions it may take, so you can give a CI job a key that creates and deletes sandboxes but can't touch your organisation's settings. Kantel shows a key's secret once and keeps only its hash.

## The proxy

Traffic leaving a sandbox can go through a **proxy** you configure. The proxy sees each request with the sandbox it came from, so it can allow or refuse it, log it, or add a credential on the way out. That keeps tokens out of the sandbox, where an agent could read them. Kantel has a proxy of its own, and you can point sandboxes at another, such as a credential-injecting proxy your team already runs.

On a host, the proxy is a sandbox's only way out. A sandbox has no public address, nothing on the internet or your network can connect to it, and it can't reach other sandboxes, its host or your network, through the proxy or around it (a host's operator can allow named private ranges through the proxy). You reach a sandbox's shell, desktop, browser and ports through Kantel, which relays them over the connection the host keeps open to the control plane.

## Webhooks and OpenTelemetry

**Webhooks** tell your systems when something happens to a sandbox, such as it becoming ready or stopping, with each delivery signed so you can check it came from Kantel. **OpenTelemetry** export sends sandbox metrics and lifecycle events to any OTLP collector.

<!-- Sources (e496aeb): written for the compute plane; checked against the code as each part lands. -->
