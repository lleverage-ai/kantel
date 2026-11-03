#!/usr/bin/env node
// Runs the kantel-host binary from this platform's package (@kantel/host-linux-x64 or -arm64), which npm installs as
// an optional dependency. `install` copies the binary to /usr/local/bin, so the service never depends on npm's cache.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (process.platform !== "linux" || arch === undefined) {
	console.error(
		`kantel-host runs on Linux (x64 or arm64), not ${process.platform}/${process.arch}. macOS support is planned.`,
	);
	process.exit(1);
}
const pkg = `@kantel/host-linux-${arch}`;
let binary;
try {
	binary = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", "kantel-host");
} catch {
	console.error(
		`kantel-host: ${pkg} isn't installed. npm skips optional dependencies with --omit=optional or --no-optional; ` +
			`reinstall without it, such as: sudo npx -y @kantel/host@latest install ...`,
	);
	process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
	console.error(`kantel-host: couldn't run ${binary}: ${result.error.message}`);
	process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
