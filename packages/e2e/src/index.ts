/**
 * End-to-end encryption between people's devices and their own hosts, so a Kantel gateway (kantel.dev or a
 * self-hosted one) carries a space's sandbox traffic without being able to read or forge it. See README.md for the
 * wire format and what it protects and what it doesn't.
 *
 *   keys.ts       device and host keys, IDs and fingerprints
 *   chain.ts      the space chain: the signed, hash-chained log of members, devices, hosts and the E2E switch
 *   noise.ts      Noise_IK_25519_AESGCM_SHA256
 *   session.ts    a device's session with a host over a relay stream, and RPC on it
 *   responder.ts  the host's side, in TypeScript (hosts run the Go one)
 *   testing.ts    an in-memory relay that records every byte, for tests
 */
export * from "./bytes.ts";
export * from "./chain.ts";
export * from "./keys.ts";
export * from "./noise.ts";
export * from "./responder.ts";
export * from "./session.ts";
