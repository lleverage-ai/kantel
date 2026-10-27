// Projects every Pi Durable recording in fixtures/pi-durable into a protocol-frame fixture in fixtures/sessions, with
// the same name, using the console's projector. The output is deterministic: run it twice and nothing changes.
//
//   node apps/console/scripts/project-fixtures.ts [--check]
//
// --check writes nothing and exits non-zero when a committed frame fixture differs from what its recording projects
// to. Recordings that are generated (gitignored) are projected too, so their frames are generated alongside.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serializeFixture } from "@harbour/protocol";
import { parseRecording, toFrames } from "../src/server-sim/frames.ts";

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const recordings = fileURLToPath(new URL("../../../fixtures/pi-durable/", import.meta.url));
const sessions = fileURLToPath(new URL("../../../fixtures/sessions/", import.meta.url));

let stale = 0;
for (const name of readdirSync(recordings)
	.filter((file) => file.endsWith(".jsonl"))
	.sort()) {
	const text = serializeFixture(toFrames(parseRecording(readFileSync(recordings + name, "utf8"))));
	const target = sessions + name;
	const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	if (values.check) {
		if (current !== text) {
			stale++;
			console.error(`${target}: out of date; run \`pnpm fixtures\` in apps/console`);
		}
		continue;
	}
	if (current !== text) writeFileSync(target, text);
	console.log(`${target}: ${text.split("\n").length - 1} frames, ${Buffer.byteLength(text)} bytes`);
}
if (stale > 0) process.exit(1);
