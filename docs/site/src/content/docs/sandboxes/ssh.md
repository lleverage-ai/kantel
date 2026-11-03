---
title: SSH
description: Let your SSH key in to a microVM for a while and connect with ssh, copy files with scp, forward a port, or open the sandbox in an editor over Remote SSH.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, and a control plane serves them only when it runs with `KANTEL_COMPUTE=experimental`. Their shapes may still change.
:::

You reach a microVM over SSH through your deployment's SSH gateway, not at an address of its own. Kantel lets a key in for a limited time and tells you the command that connects. Isolates have no SSH: the call answers `501` with `not_supported` for them.

The examples use `KANTEL_URL` and `KANTEL_API_KEY` as set in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start), and `jq`. The key needs `access`.

## Connect with your own key

Send your public key. The answer's `command` connects:

```sh
jq -n --arg key "$(cat ~/.ssh/id_ed25519.pub)" '{publicKey: $key, ttlMinutes: 120}' |
  curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ssh" \
    -H "authorization: Bearer $KANTEL_API_KEY" \
    -H "content-type: application/json" \
    -d @- | jq -r .command
```

```text
ssh -p 2222 sbx_4kq9x2mt@ssh.kantel.example
```

Run that command to get a shell. The answer, an [SshAccess](/api/reference/types/#sshaccess), also has the gateway's `host` and `port`, the `user` that names the sandbox to the gateway, `hostKeyFingerprint` to check the first time you connect, and `expiresAt`.

Your key is let in for `ttlMinutes`: 60 by default, from 5 up to 1,440 (a day). After that, ask again.

From the SDK:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ssh = await kantel.openSsh("sbx_4kq9x2mt", {
	publicKey: readFileSync(`${homedir()}/.ssh/id_ed25519.pub`, "utf8").trim(),
	ttlMinutes: 120,
});
console.log(ssh.command);
```

## Connect with a key Kantel makes

Leave `publicKey` out and Kantel makes a key pair for this access, answering its private key once in `privateKey`. Save it with tight permissions and pass it to `ssh`:

```sh
access=$(curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ssh" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{}')
(umask 077; printf '%s\n' "$access" | jq -r .privateKey > sandbox-key)
printf '%s\n' "$access" | jq -r .command
```

Then run the command it prints with `-i sandbox-key` added, such as `ssh -i sandbox-key -p 2222 sbx_4kq9x2mt@ssh.kantel.example`.

## Copy files

`scp` and `rsync` go through the gateway like `ssh`. `scp` takes the port as a capital `-P`:

```sh
scp -P 2222 ./data.csv sbx_4kq9x2mt@ssh.kantel.example:data.csv
scp -P 2222 -r sbx_4kq9x2mt@ssh.kantel.example:app/dist ./dist
```

This is the way to move files bigger than the [file routes'](/sandboxes/commands-and-files/) 1 MiB.

## Forward a port

To open a port of the sandbox on your own machine without a [public URL](/sandboxes/public-ports/), forward it:

```sh
ssh -N -L 3000:localhost:3000 -p 2222 sbx_4kq9x2mt@ssh.kantel.example
```

Then open <http://localhost:3000/>.

## Editors over Remote SSH

VS Code's Remote SSH, Cursor and other editors that connect over SSH read `~/.ssh/config`. Add an entry with the values from the answer:

```text
Host kantel-fix-login-bug
  HostName ssh.kantel.example
  Port 2222
  User sbx_4kq9x2mt
  IdentityFile ~/.ssh/id_ed25519
```

and connect to `kantel-fix-login-bug`. The sandbox's ID stays the same across a stop and resume, so the entry keeps working; ask for access again when it expires.

<!-- Sources (712a09ae): packages/api/src/compute-routes.ts:665-679, packages/api/src/compute-schema.ts:644-669 -->
