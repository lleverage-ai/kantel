---
title: Isolates and microVMs
description: The two types of sandbox, what each can and can't do, how to choose one, and how to read a sandbox's capabilities and size.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

Every sandbox is one of two types. You choose with `type` when you [create it](/sandboxes/lifecycle/#create-a-sandbox), and the same API drives both.

| | `isolate` | `microvm` |
| --- | --- | --- |
| What it is | A workerd isolate, with a JavaScript shell over the sandbox's files | A Firecracker microVM with its own Linux kernel |
| Starts in | Milliseconds | Longer: a machine boots |
| Costs | Almost nothing | Its size's hourly rate while it runs |
| Commands and files | Yes, in the isolate's shell | Yes, with `bash` |
| Native binaries, packages, root | No | Yes |
| Docker | No | Yes |
| `/dev/kvm` inside, for virtual machines of its own | No | Yes, where its host allows nested virtualisation |
| Desktop, browser and SSH | No | Yes |
| Pause, keeping memory | No | Yes, where its host supports it |
| Size | None | `small`, `default`, `large` or `xlarge` |

A microVM on Kantel's own image has all of these. One on a [custom image](/sandboxes/custom-images/) has the desktop, browser and Docker only where its image does, and its `capabilities` say so.

An isolate is the default. Choose one for quick scripts and file work an agent does in JavaScript, where you want an answer in milliseconds and many sandboxes at almost no cost. Choose a microVM for anything a normal Linux machine does: installing packages, building and testing a project, running Docker, or using a desktop and browser.

## Capabilities

What a sandbox can do depends on its type and on the host it landed on. Each sandbox says so in `capabilities`, so read that rather than assume from the type:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq .capabilities
```

```json
{ "exec": true, "files": true, "ssh": true, "desktop": true, "browser": true, "ports": true, "docker": true, "kvm": true, "pause": true }
```

A call a sandbox can't take, such as SSH into an isolate, answers `501` with `not_supported`.

## Sizes

A microVM has a size: `small`, `default`, `large` or `xlarge`. Each deployment decides what the sizes hold, and may offer fewer of them. A running microVM shows what it got in `resources`:

```json
{ "size": "default", "resources": { "vcpus": 2, "memoryMb": 4096, "diskGb": 20 } }
```

To change a sandbox's size, stop it and resume it with another (`{"size": "large"}`), or fork it to a new size. An isolate has no size and no `resources`.

A microVM's disk can be larger than its size gives, without more vCPUs or memory: `"resources": {"diskGb": 60}` on a create, beside a size or vCPUs and memory, or `kantel new --type microvm --size large --disk 60`. `GET /v1/sandbox-shapes` says the range the hosts you may use give (`microvm.diskGb`). A fork, a start and a sandbox made from a snapshot keep the disk they copy.

## Base images

A microVM starts from a base image, such as `ubuntu-24.04`, which its `image` field names. Leave `image` out to get the deployment's default. To start every sandbox with your own tools already installed, set one up once and save it as a [saved snapshot](/snapshots/saved/), then create from that with `from`.

## Placing sandboxes on hosts

On a deployment with several hosts, Kantel picks one that can run the type and has room. Hosts can carry labels, such as `site: home`, and `hostLabels` on a create places the sandbox only on a host with every label you give:

```sh
curl -s "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type": "microvm", "hostLabels": {"site": "home"}}'
```

If no host has every label you give, the sandbox can't be placed, and the create answers `503` with `unavailable`.

<!-- Sources (9cc20eb3): packages/api/src/compute-schema.ts:201-264, packages/api/src/compute-schema.ts:365-404, packages/api/src/compute-routes.ts:334-350, packages/api/src/compute-routes.ts:417-432 -->
