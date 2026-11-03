---
title: The admin command
description: kantel-admin (npx @kantel/admin) installs and upgrades a self-hosted Kantel, changes its settings, turns on the compute API, and adds, drains and revokes the Linux hosts that run its sandboxes.
---

`kantel-admin` is for whoever runs a self-hosted Kantel. It does what [Install Kantel](/self-hosting/install/) does by hand: it runs the installer, edits the stack's settings, reads the first compute key and manages hosts. Using sandboxes is the [`kantel` command's](/tools/cli/) job.

It needs Node.js 22 or later. Run it with `npx @kantel/admin <command>`, or install it with `npm install -g @kantel/admin` and run `kantel-admin <command>`.

## Set up a control plane

```sh
npx @kantel/admin install --email you@example.com
npx @kantel/admin status
```

`install` downloads [kantel.dev/install.sh](https://kantel.dev/install.sh) and runs it, passing on `--email`, `--ref`, `--repo`, `--tarball` and `--no-open`, and anything after `--`. `upgrade` runs it with `--upgrade`, which keeps your settings and data. `KANTEL_INSTALLER_URL` runs another copy of the installer, such as a path in a checkout.

`status` says whether the console answers, how many of the stack's services are running, and whether the compute API is on. It exits 1 when the console doesn't answer.

Both find the install in `~/.kantel`; `--home` or `KANTEL_HOME` says otherwise.

## Change settings

The stack's settings are in `~/.kantel/src/deploy/compose/.env` (the table in [Your own settings](/self-hosting/install/#your-own-settings) lists them).

```sh
npx @kantel/admin config list
npx @kantel/admin config set KANTEL_PUBLIC_URL=https://kantel.example.com --apply
npx @kantel/admin config unset KANTEL_SMTP_URL
```

`config list` shows secrets as `(set)`. `set` and `unset` change the lines in place. A change takes effect when the stack restarts with it: `kantel-admin apply` does that (`docker compose up -d --wait`, which recreates only the containers whose settings changed, and downloads nothing), and `--apply` does it straight after the change.

## Turn on the compute API

```sh
npx @kantel/admin compute enable --apply
npx @kantel/admin bootstrap-key --save
```

`compute enable` sets `KANTEL_COMPUTE=experimental`. `bootstrap-key` prints the compute API's first key, `computeKey` in the gateway's bootstrap file; with `--save` it checks the key and saves it, with the local URL, where `kantel login` would, so `kantel` and `kantel-admin` both use it. That key has every scope, `hosts:admin` too: keep it to yourself and give people, scripts and agents [keys of their own](/accounts/api-keys/#create-a-key).

## Add hosts

A host is a Linux machine with `/dev/kvm` that runs `kantel-host` (Firecracker microVMs and workerd isolates). It dials out to the control plane, so it needs no open port, but it has to reach the control plane's public URL:

```sh
npx @kantel/admin compute enable --hosts --public-url https://kantel.example.com --apply
npx @kantel/admin host add --name builder-1 --label zone=ams
```

`host add` makes a one-use join token (an hour unless `--expires-minutes` says otherwise) and prints the command to run on the machine as root:

```text
sudo npx -y @kantel/host@latest install --url https://kantel.example.com --token kth_...
```

`sudo npx -y @kantel/admin host join --url https://kantel.example.com --token kth_...` on the machine does the same. With `--ssh root@builder-1`, `host add` runs the command on the machine for you over SSH. Arguments after `--` go to `kantel-host install`, such as `-- --tiers isolate --isolate-runtime native` on a machine without KVM (for trusted code only).

`host run -- <command>` runs any other `kantel-host` command on the machine you're on: `doctor`, `status`, `update`, `uninstall`.

## Look after hosts

```sh
npx @kantel/admin host list
npx @kantel/admin host info host_6t5r4e
npx @kantel/admin host drain host_6t5r4e      # no new sandboxes; --undo takes it back
npx @kantel/admin host revoke host_6t5r4e --yes
```

`host list` shows each host's state, its agent's version (and a newer one when there is), the sandbox types it runs and how many sandboxes it has. Draining a host stops new sandboxes going on it; the ones there keep running. Revoking it revokes its credential and closes its connection: its sandboxes keep their disks but can't be reached until it joins again with a new token.

The host commands call the [hosts API](/api/reference/hosts/) and need a key with `hosts:admin`. They take the same settings as `kantel`: `--url` and `--key`, `KANTEL_URL` and `KANTEL_API_KEY`, or the file `kantel login` (or `bootstrap-key --save`) writes. Every command takes `--json`.
