---
title: SSH
description: Let your SSH key in to a microVM for a while and connect with ssh, copy files with scp, forward a port, or open the sandbox in an editor over Remote SSH.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A microVM has no address of its own that you can connect to. You reach its SSH through Kantel: either through your deployment's SSH gateway, or, on [your own hosts](/hosts/), through a relay on the control plane that carries SSH over a WebSocket. Kantel lets a key in and tells you the command that connects. Isolates have no SSH: the call answers `501` with `not_supported` for them.

With the [`kantel` command](/tools/cli/), one line does all of it, whichever way your deployment connects:

```sh
kantel ssh sbx_4kq9x2mt                 # a shell
kantel ssh sbx_4kq9x2mt -- uname -a     # one command, with its exit code
```

The examples use `KANTEL_URL` and `KANTEL_API_KEY` as set in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start), and `jq`. The key needs `access`.

## Connect with your own key

Send your public key. The answer's `command` connects:

```sh
jq -n --arg key "$(cat ~/.ssh/id_ed25519.pub)" '{publicKey: $key, ttlMinutes: 30}' |
  curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ssh" \
    -H "authorization: Bearer $KANTEL_API_KEY" \
    -H "content-type: application/json" \
    -d @- | jq -r .command
```

```text
ssh -p 2222 sbx_4kq9x2mt@ssh.kantel.example
```

Run that command to get a shell. The answer, an [SshAccess](/api/reference/types/#sshaccess), also has the gateway's `host` and `port`, the `user` that names the sandbox to the gateway, `hostKeyFingerprint` to check the first time you connect, and `expiresAt`.

You can start a connection until `expiresAt`, `ttlMinutes` from now: 10 by default, from 5 up to 60. A connection you started in time stays open. After that, ask again.

## Through Kantel's relay

On your own hosts there is no SSH gateway to dial. The answer then has `proxyUrl`, a WebSocket URL on the control plane's public address whose binary frames carry the sandbox's SSH, and a `command` that connects through it with a `ProxyCommand`. The control plane passes the bytes to the sandbox over the connection its host keeps open, so neither the host nor the sandbox needs an open port. SSH's own encryption and host key check run end to end inside it. Anyone holding `proxyUrl` can start a connection until it expires, so treat it like a password.

`kantel ssh` does this for you. It asks for access, saves the private key Kantel made in `~/.config/kantel/ssh/<sandbox ID>`, and runs `ssh` with `kantel ssh-proxy` as its `ProxyCommand`. Each run makes a new key pair, unless you give your own with `--public-key ~/.ssh/id_ed25519.pub`. It keeps the sandbox's host key in `~/.config/kantel/ssh/known_hosts`, learnt on the first connection.

After `--`, a command runs instead of a shell, as with `ssh host command`: one word is a shell command line (`kantel ssh sbx_4kq9x2mt -- 'make && make test'`) and several are a command and its arguments, and `kantel` exits with the command's exit code. With `--print`, `kantel ssh sbx_4kq9x2mt` prints the command instead of running it, such as:

```text
ssh -i ~/.config/kantel/ssh/sbx_4kq9x2mt -o IdentitiesOnly=yes -o 'ProxyCommand=kantel ssh-proxy --url wss://kantel.example/v1/hosts/tunnel/…' -o HostKeyAlias=sbx_4kq9x2mt -o UserKnownHostsFile=~/.config/kantel/ssh/known_hosts -o StrictHostKeyChecking=accept-new user@sbx_4kq9x2mt
```

followed by `(start it by 2026-11-03 09:48 UTC; once connected it stays open)`. `--ttl` sets how long you have to start a connection, in minutes: 10 by default, from 5 up to 60. `--json` prints, as JSON, the command, the key's path, the host key's fingerprint and `expiresAt`. The `ssh-proxy` step needs `kantel` on your `PATH`.

Any client that pipes its standard input and output through a WebSocket as binary frames works as the `ProxyCommand`. The answer's own `command` uses `websocat --binary`.

From the SDK:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ssh = await kantel.openSsh("sbx_4kq9x2mt", {
	publicKey: readFileSync(`${homedir()}/.ssh/id_ed25519.pub`, "utf8").trim(),
	ttlMinutes: 30,
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

Through the relay, `kantel scp` is simpler: it copies through the file routes, in parts for a file over 1 MiB on a microVM. To use `scp` itself, reuse the options `kantel ssh` prints:

```sh
opts=$(kantel ssh sbx_4kq9x2mt --json | jq -r .command | sed 's/^ssh //; s/ [^ ]*$//')
eval "scp $opts ./data.csv user@sbx_4kq9x2mt:data.csv"
```

## Forward a port

To open a port of the sandbox on your own machine without a [public URL](/sandboxes/public-ports/), forward it:

```sh
ssh -N -L 3000:localhost:3000 -p 2222 sbx_4kq9x2mt@ssh.kantel.example
```

Then open <http://localhost:3000/>. Through the relay, add the same flags to the options from [Copy files](#copy-files):

```sh
eval "ssh $opts -N -L 3000:localhost:3000 user@sbx_4kq9x2mt"
```

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

Through the relay, put the options `kantel ssh` prints into the entry instead:

```text
Host kantel-fix-login-bug
  HostName sbx_4kq9x2mt
  User user
  IdentityFile ~/.config/kantel/ssh/sbx_4kq9x2mt
  IdentitiesOnly yes
  HostKeyAlias sbx_4kq9x2mt
  UserKnownHostsFile ~/.config/kantel/ssh/known_hosts
  ProxyCommand kantel ssh-proxy --url wss://kantel.example.com/v1/hosts/tunnel/…
```

The relay URL in `ProxyCommand` works for an hour at most, so run `kantel ssh sbx_4kq9x2mt --ttl 60` and copy in the new one before you reconnect. A connection that is already open stays open.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:665-679, packages/api/src/compute-schema.ts:644-669; the relay: packages/hosts/src/backend.ts (openSsh), packages/hosts/src/tunnel.ts, packages/cli/src/ssh-proxy.ts. The CLI and the relay's scp and port forward (5be456c): packages/cli/src/commands.ts:1114-1125,1269-1345, packages/hosts/src/tunnel.ts:1-70; run through a local host for TASK-4706 -->
