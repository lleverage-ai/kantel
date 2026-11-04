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
kantel e2e init --account <org> --yes          # prints the genesis to give members
kantel e2e host-ticket rack-1 --account <org>  # prints: sudo kantel-host e2e join <ticket>
```

### Turning it on retires existing sandboxes

A host opens E2E sessions only to sandboxes it made itself while the organisation's E2E was on. It keeps that record
on the machine, so the gateway can't set or change it. A sandbox made earlier, or before the host joined the chain,
was open to the gateway: it could have left a process running or changed files there. Such a sandbox is **retired**.
No device's session reaches it, and the gateway can't reach its content either. Nothing is deleted. Stop or delete
retired sandboxes as usual, and make new ones once the host has joined. Snapshots follow the same rule: a new sandbox
is made only from a snapshot taken of one made under E2E.

`kantel e2e init`, and `kantel e2e mode on` when E2E is off, list the sandboxes this retires and go ahead only with
`--yes`. Turning E2E off and on again retires every sandbox again, including those made while it was on, because the
gateway could reach them while it was off.

Run the printed command on the host. A self-hosted host with no route to the gateway's chain API can join offline
with `kantel-host e2e join --chain chain.json <ticket>`, which prints its signed entry for you to publish.

The host's entry counts once the gateway has taken it. If someone else's change lands first, the join fails. Run it
again, with a new ticket if the old one has run out, and the host signs a new entry on the chain as it is now.

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
organisation's sandboxes; starting, stopping and deleting them still go through the gateway. The gateway can't give
those sandboxes environment variables, SSH keys, an upstream proxy, a CA or intercepting egress rules (any of these
could read what runs there), so set variables in a session with `kantel e2e exec` or `kantel e2e put`. A host that
has joined a space is updated on the machine (`kantel-host update`), never by the gateway, even while the space is
off: the space still trusts its host key. An update the gateway started before the join finishes before the join goes
ahead.

### Command history and the local console

The host keeps each sandbox's last 200 commands from sessions, with the last 64 KiB of their output; the gateway never
has them. `kantel e2e history <sandbox> [--output]` reads them over a session, and works while the sandbox is stopped
as long as its host is online. Deleting the sandbox deletes its history.

`kantel console` serves the console from the CLI's own release on `127.0.0.1` and makes its E2E calls with this
device's key, which never reaches the browser. Only the browser that opens the link it prints gets in. What the
gateway answers there is shown as data only: the console runs no page or script the gateway sends.

## Take access away

`kantel e2e remove-device <device>`, `kantel e2e remove-member <user>` and `kantel e2e remove-host <host>` add a signed
entry. A host takes it with the next session that brings it (your own next `kantel e2e` command does); from then on
it refuses the device or person's calls, open sessions included, and closes their open ports within a few seconds. `kantel e2e mode strict` also keeps out devices of
the `web` class (the hosted console); `kantel e2e mode off` turns enforcement off, and turning it on again retires the
organisation's sandboxes (see above).
