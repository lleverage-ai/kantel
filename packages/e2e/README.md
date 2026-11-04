# @kantel/e2e

End-to-end encryption for Kantel Connect: a person's devices talk to their own hosts through a Kantel gateway
(kantel.dev or a self-hosted one) that relays the bytes but can't read them, and can't add a key that hosts would
trust. Everything here is behind a space's E2E switch: in a space whose chain is `off`, or that has no chain, nothing
changes.

This package is the shared TypeScript half: the CLI and the hosted console use it as devices, the gateway uses it to
check what it stores (it can't sign anything), and tests use its TypeScript host. Hosts run the Go half,
`apps/host/internal/e2e`, which must pass the same vectors.

## Pieces

| File | What it is |
| --- | --- |
| `src/keys.ts` | Ed25519 signing and X25519 keys from 32-byte seeds, `kd_…` IDs and fingerprints. WebCrypto only. |
| `src/chain.ts` | The space chain: members, devices, hosts and the mode, each entry signed and hash-chained. |
| `src/noise.ts` | `Noise_IK_25519_AESGCM_SHA256`, checked against Cacophony's vector. |
| `src/session.ts` | A device's session with a host over a relay stream, and RPC on it. |
| `src/responder.ts` | The host's side in TypeScript (tests and the reference for the Go one). |
| `src/testing.ts` | A relay that records every byte, so tests can show it only saw ciphertext. |
| `vectors/` | `noise-ik.json` (Cacophony), `chain.json` and `session.json`, which both languages check. |

## The chain

One chain per space (a personal account or an organisation). An entry is `{ payload, sig }`: `payload` is base64url
JSON `{ v, space, seq, prev, at, by, type, body }`, `sig` is Ed25519 over `kantel-chain/1\n ‖ payload bytes`, and an
entry's hash is SHA-256 of `payload ‖ sig`. The genesis's hash is what devices and hosts pin.

| Entry | Signed by |
| --- | --- |
| `genesis` | the first device, which it lists; its person is the first admin |
| `member.add`, `member.remove` | an admin's device; removing a person removes their devices |
| `device.add`, `device.remove` | a device of the same person, or an admin's |
| `host.add` | the one-off key in a join ticket that an admin's device signed for this space |
| `host.remove`, `mode` | an admin's device |

`mode` is `off`, `on` (E2E, the hosted console allowed as a labelled, revocable `web` device) or `strict` (no `web`
devices). Keys, device IDs and ticket keys are never reused. At least one admin keeps a device after every entry.

Hosts take newer entries from the devices that open sessions to them (a device sends what the host lacks once the
session is up), so a gateway that withholds entries delays a change but can't fake one. A fork (another entry at a seq
already verified) is refused.

## A session

Over the relay's byte stream, each record has a two-byte big-endian length.

1. The device sends Noise IK's first message: its static key, encrypted, and a hello `{ v, sandbox, op, port? }`.
   The prologue binds `kantel-e2e/1`, the space and the host's ID.
2. The host answers with the second message, carrying its chain head `{ seq, hash }`.
3. Then transport records. Inside them, control messages have a four-byte length and JSON: the device's
   `{ type: "open", chain? }` (entries the host lacks), the host's `ready` or `refused`, then RPC
   `{ id, method, params }` and `{ id, result | error | event }`. A `port` session becomes raw bytes after `ready`.

The host finds the device by its static key in the chain, checks it's allowed (a member's, and not `web` in a `strict`
space) and that the hello's sandbox is its own, and only then runs anything.

## What it protects

The gateway sees which host a device talks to, when, and how many bytes; not the commands, files, output or port
traffic, nor which device it is. It can refuse service, delay entries and see the chain (public keys, user IDs and
labels). It can't read or change a session, pose as a host, or get a key of its own trusted. The hosted console is the
exception people choose: its code comes from the gateway, which is why it's a `web` device that `strict` turns off.

## Vectors

```sh
node packages/e2e/test/vectors.ts --write && pnpm biome format --write packages/e2e/vectors
```

`test/vectors.test.ts` fails when the files and the TypeScript disagree.
