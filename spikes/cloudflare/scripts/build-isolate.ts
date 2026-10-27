/**
 * Bundles the isolate tier (src/isolate/entry.ts, just-bash included) into one ES module, stored as text so the main
 * Worker can hand it to the Worker Loader. `cloudflare:workers` and `node:*` stay external: the Dynamic Worker runs
 * with nodejs_compat.
 */
import { mkdir, writeFile } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: [new URL("../src/isolate/entry.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
  minify: true,
  external: ["cloudflare:workers", "node:*"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const output = result.outputs[0];
if (output === undefined) throw new Error("no output");
const code = await output.text();
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/isolate.bundle.txt", import.meta.url), code);
console.log(`dist/isolate.bundle.txt: ${(code.length / 1024).toFixed(0)} KiB`);
