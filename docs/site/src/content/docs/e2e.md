---
title: End-to-end encryption
description: Run commands and move files in your own hosts' sandboxes over sessions that Kantel's gateway relays but can't read, for every member of an organisation.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

With E2E on, what your devices send to a sandbox on [your own host](/own-hosts/) — commands, their output, files and
forwarded ports — goes in a Noise session between your device and the host. The gateway (kantel.dev, or your own)
relays the session's bytes over the host's connection but holds no key to read them, and no key it adds is trusted.

## How trust works

Each organisation has a **chain**: a signed, hash-linked log of its members, their devices, its hosts and its E2E mode
(`off`, `on` or `strict`). Every entry is signed by a device of an admin in the chain, so the gateway can store the
chain but not change it. A device trusts the chain from its **genesis**, the first entry, which it made itself
(`kantel e2e init`) or which an admin gave it directly (`kantel e2e join`); a host trusts it from the join ticket an
admin gave it. Both check each new entry before they use it.

## Set it up

An organisation admin starts the chain and enrols a host:

```sh
kantel e2e init --account <org>                # prints the genesis to give members
kantel e2e host-ticket rack-1 --account <org>  # prints: sudo kantel-host e2e join <ticket>
```

Run the printed command on the host. A self-hosted host with no route to the gateway's chain API can join offline
with `kantel-host e2e join --chain chain.json <ticket>`, which prints its signed entry for you to publish.

Each member trusts the genesis and sends their device's card to an admin, who checks its fingerprint with them:

```sh
kantel e2e join <org> <genesis>            # the member: prints a card and a fingerprint
kantel e2e add-device --member <card>      # the admin
```

## Use it

```sh
kantel e2e exec <sandbox> -- npm test
kantel e2e cat <sandbox> /home/user/app/.env
kantel e2e put <sandbox> ./secrets.json /home/user/app/secrets.json
kantel e2e ssh <sandbox>
kantel e2e status
```

While E2E is on, the host refuses the gateway's own command, file, port and snapshot-read calls for the
organisation's sandboxes; starting, stopping and deleting them still go through the gateway.

## Take access away

`kantel e2e remove-device <device>`, `kantel e2e remove-member <user>` and `kantel e2e remove-host <host>` add a signed
entry; hosts refuse the device or person from their next session. `kantel e2e mode strict` also keeps out devices of
the `web` class (the hosted console); `kantel e2e mode off` turns enforcement off.
