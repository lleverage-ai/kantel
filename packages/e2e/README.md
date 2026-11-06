# @kantel/e2e

The handshake and keys for end-to-end encryption between a client and an organisation's own hosts. The design is
deferred: [issue #784](https://github.com/lleverage-ai/kantel/issues/784) explains how it would work. Nothing uses
this package yet.

| File | What it is |
| --- | --- |
| `src/keys.ts` | Ed25519 signing and X25519 keys from 32-byte seeds, `kd_…` and `kh_…` IDs and fingerprints. WebCrypto only. |
| `src/noise.ts` | `Noise_IK_25519_AESGCM_SHA256`, checked against Cacophony's vector. |
| `src/bytes.ts` | Byte helpers. |
| `vectors/noise-ik.json` | Cacophony's vector, which the Go half (`apps/host/internal/e2e`) checks too. |

An earlier version (a signed chain per space, sessions over the gateway's relay and `kantel e2e` commands) was
removed; it's in Git history, and the issue links to it.
