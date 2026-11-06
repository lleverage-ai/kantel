/**
 * The handshake and keys for end-to-end encryption between a client and an organisation's own hosts, a design deferred
 * for now (https://github.com/lleverage-ai/kantel/issues/784). Nothing uses this package yet. The Go host has the same
 * pieces in `apps/host/internal/e2e`, and both check Noise against Cacophony's vector.
 *
 *   bytes.ts  byte helpers
 *   keys.ts   Ed25519 and X25519 keys from 32-byte seeds, key IDs and fingerprints (WebCrypto only)
 *   noise.ts  Noise_IK_25519_AESGCM_SHA256
 */
export * from "./bytes.ts";
export * from "./keys.ts";
export * from "./noise.ts";
