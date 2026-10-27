/**
 * The in-memory session runtime: `createSessionRuntime` over a map-backed store, with each session's Harness on its own
 * Pi Durable `MemoryStorage`. Nothing survives the process.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { createSessionRuntime, type SessionRuntimeOptions, type SessionRuntimeService } from "./runtime.ts";
import { createMemorySessionStore } from "./store.ts";

export type MemoryRuntimeOptions = Omit<SessionRuntimeOptions, "store" | "storage" | "hostHandler">;

export type MemoryRuntime = SessionRuntimeService;

export function createMemoryRuntime(options: MemoryRuntimeOptions): MemoryRuntime {
	return createSessionRuntime({ ...options, store: createMemorySessionStore(), storage: () => new MemoryStorage() });
}
