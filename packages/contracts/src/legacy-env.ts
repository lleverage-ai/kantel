/**
 * Imported for its effect, first, by every Node or Bun entry point: fills each unset `KANTEL_*` in `process.env` from
 * its `HARBOUR_*` name (see `env.ts`) before any other module reads it. Import it before anything else, as module
 * bodies run in import order.
 */
import { applyKantelEnv } from "./env.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
if (env !== undefined) applyKantelEnv(env);
