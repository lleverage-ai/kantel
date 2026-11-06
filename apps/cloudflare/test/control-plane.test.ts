// Whether the deploy makes a new version of harbour (scripts/control-plane.ts): only when what a version is made of
// changed, since a new version resets every Durable Object and the connections they hold.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FINGERPRINT_PREFIX, fingerprint, whyDeploy } from "../scripts/control-plane.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A dry run's outdir and config, as files. */
function build(files: { readonly [path: string]: string }): string {
	const dir = mkdtempSync(join(tmpdir(), "kantel-control-plane-"));
	dirs.push(dir);
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), body);
	}
	return dir;
}

const harbour = {
	"bundle/index.js": "export default {}",
	"bundle/README.md": "built at 2026-11-06T10:00:00Z",
	"wrangler.deploy.json": JSON.stringify({ name: "harbour", vars: { A: "1" } }),
	"secrets.json": JSON.stringify({ KANTEL_VAULT_KEY: "k1" }),
};

const of = (dir: string, secrets = true) =>
	fingerprint({
		bundle: join(dir, "bundle"),
		config: join(dir, "wrangler.deploy.json"),
		...(secrets ? { secretsFile: join(dir, "secrets.json") } : {}),
	});

describe("harbour's fingerprint", () => {
	it("is the same for the same Worker, whenever and wherever it was built", () => {
		const one = of(build(harbour));
		expect(one).toMatch(/^[0-9a-f]{64}$/);
		expect(of(build({ ...harbour, "bundle/README.md": "built at 2026-11-07T09:00:00Z" }))).toBe(one);
	});

	it("changes with the bundle, the config or the secrets", () => {
		const one = of(build(harbour));
		expect(of(build({ ...harbour, "bundle/index.js": "export default { fetch() {} }" }))).not.toBe(one);
		expect(of(build({ ...harbour, "bundle/chunk.js": "" }))).not.toBe(one);
		expect(
			of(build({ ...harbour, "wrangler.deploy.json": JSON.stringify({ name: "harbour", vars: { A: "2" } }) })),
		).not.toBe(one);
		expect(of(build({ ...harbour, "secrets.json": JSON.stringify({ KANTEL_VAULT_KEY: "k2" }) }))).not.toBe(one);
		expect(of(build(harbour), false)).not.toBe(one);
	});

	it("never holds a secret, only a digest over everything", () => {
		const secret = "a-very-secret-value";
		const digest = of(build({ ...harbour, "secrets.json": JSON.stringify({ KANTEL_VAULT_KEY: secret }) }));
		expect(digest).not.toContain(secret);
	});

	it("covers a container app's build context when the config has one", () => {
		const withImage = (dockerfile: string) =>
			of(
				build({
					...harbour,
					"wrangler.deploy.json": JSON.stringify({
						containers: [{ class_name: "X", image: "./image/Dockerfile", image_build_context: "./image" }],
					}),
					"image/Dockerfile": dockerfile,
				}),
			);
		// Each build is in its own temporary directory: the same image in two checkouts is the same Worker.
		expect(withImage("FROM alpine:3.22")).toBe(withImage("FROM alpine:3.22"));
		expect(withImage("FROM alpine:3.22")).not.toBe(withImage("FROM alpine:3.23"));
	});
});

describe("whether harbour needs a new version", () => {
	const wanted = "a".repeat(64);
	const serving = (...ids: string[]) => ({
		versions: ids.map((id) => ({ version_id: id, percentage: 100 / ids.length })),
	});

	it("doesn't when its one version carries this fingerprint", () => {
		expect(whyDeploy(serving("v1"), () => `${FINGERPRINT_PREFIX}${wanted}`, wanted)).toBeUndefined();
	});

	it("does when anything differs or is uncertain", () => {
		expect(whyDeploy(serving("v1"), () => `${FINGERPRINT_PREFIX}${"b".repeat(64)}`, wanted)).toMatch(/is bbbbbbbbbbbb/);
		// A version made by hand, such as `wrangler secret put`, or by a deploy before fingerprints.
		expect(whyDeploy(serving("v1"), () => "Secret Change", wanted)).toMatch(/wasn't made by this deploy/);
		expect(whyDeploy(serving("v1"), () => "", wanted)).toMatch(/wasn't made by this deploy/);
		expect(whyDeploy(serving("v1"), () => undefined, wanted)).toMatch(/didn't say/);
		expect(whyDeploy(serving("v1", "v2"), () => `${FINGERPRINT_PREFIX}${wanted}`, wanted)).toMatch(/2 versions/);
		expect(whyDeploy(undefined, () => `${FINGERPRINT_PREFIX}${wanted}`, wanted)).toMatch(/no deployment/);
		expect(whyDeploy({ versions: [{ percentage: 100 }] }, () => "", wanted)).toMatch(/names no version/);
	});
});
