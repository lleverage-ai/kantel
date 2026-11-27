// Host-side Git signing: OpenPGP & OpenSSH key parsing, environment signing routes, multi-environment shadowing,
// version floors, host-only `signingKey` fetches, `recordSigning` audit events, and zero-leak guarantees.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { computeSchema } from "@kantel/api";
import { createKantelClient, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { BackendGitSigning, SandboxBackend, SandboxSpec } from "../src/backend.ts";
import { normaliseAllowedEmails, parseGitSigningKey } from "../src/git-signing.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";
import { bytesToBase64 } from "../src/util.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
};

const SECRETS_KEY = bytesToBase64(new Uint8Array(32).fill(11));
const PASSPHRASE = "correct-horse-battery-staple-test";

const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Programmatic key builders (no hardcoded private key literals, deterministic across all runtimes)

function encodeSshString(data: Uint8Array | string): Uint8Array {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const out = new Uint8Array(4 + bytes.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, bytes.length, false);
	out.set(bytes, 4);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function buildSshEd25519Key(options: { readonly seedByte?: number; readonly encrypted?: boolean } = {}): string {
	const pub = new Uint8Array(32).fill(options.seedByte ?? 0x42);
	const pubBlob = concat(encodeSshString("ssh-ed25519"), encodeSshString(pub));
	const cipher = options.encrypted === true ? "aes256-ctr" : "none";
	const kdf = options.encrypted === true ? "bcrypt" : "none";
	const kdfOpts =
		options.encrypted === true
			? concat(encodeSshString(new Uint8Array(16).fill(1)), new Uint8Array([0, 0, 0, 16]))
			: new Uint8Array(0);
	const privBody = concat(
		new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78]),
		encodeSshString("ssh-ed25519"),
		encodeSshString(pub),
		encodeSshString(new Uint8Array(64).fill(0x99)),
		encodeSshString("test@example.com"),
		new Uint8Array([1, 2, 3, 4]),
	);
	const full = concat(
		new TextEncoder().encode("openssh-key-v1\0"),
		encodeSshString(cipher),
		encodeSshString(kdf),
		encodeSshString(kdfOpts),
		new Uint8Array([0, 0, 0, 1]),
		encodeSshString(pubBlob),
		encodeSshString(privBody),
	);
	const b64 = bytesToBase64(full);
	return ["-----BEGIN OPENSSH PRIVATE KEY-----", b64, "-----END OPENSSH PRIVATE KEY-----", ""].join("\n");
}

function crc24(bytes: Uint8Array): string {
	let crc = 0xb704ce;
	for (const b of bytes) {
		crc ^= b << 16;
		for (let i = 0; i < 8; i++) {
			crc <<= 1;
			if ((crc & 0x1000000) !== 0) crc ^= 0x1864cfb;
		}
	}
	return bytesToBase64(new Uint8Array([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]));
}

function pgpPacket(tag: number, body: Uint8Array): Uint8Array {
	const header = new Uint8Array([0xc0 | tag, body.length]);
	return concat(header, body);
}

function buildPgpEd25519Key(
	options: {
		readonly uid?: string;
		readonly seedByte?: number;
		readonly encrypted?: boolean;
		readonly gnuDummy?: boolean;
		readonly badCrc?: boolean;
	} = {},
): string {
	const ed25519Oid = new Uint8Array([0x09, 0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01]);
	const pubPoint = new Uint8Array(33);
	pubPoint[0] = 0x40;
	pubPoint.fill(options.seedByte ?? 0x2a, 1);
	// MPI bit-length for 0x40 || 32 bytes = 263 bits (0x01, 0x07).
	const pubMpi = concat(new Uint8Array([0x01, 0x07]), pubPoint);
	const created = new Uint8Array([0x67, 0x00, 0x00, 0x01]);
	const pubBody = concat(new Uint8Array([4]), created, new Uint8Array([22]), ed25519Oid, pubMpi);

	let secretTail: Uint8Array;
	if (options.gnuDummy === true) {
		// s2kUsage 254, cipher 7 (AES128), s2kType 101, hash 2, "GNU", mode 1.
		secretTail = new Uint8Array([254, 7, 101, 2, 0x47, 0x4e, 0x55, 1]);
	} else if (options.encrypted === true) {
		secretTail = concat(
			new Uint8Array([254, 9, 3, 8]),
			new Uint8Array(8).fill(3),
			new Uint8Array([96]),
			new Uint8Array(48).fill(5),
		);
	} else {
		// s2kUsage 0 + dummy 32-byte scalar MPI + 2-byte checksum.
		secretTail = concat(new Uint8Array([0, 0x01, 0x00]), new Uint8Array(32).fill(0x55), new Uint8Array([0x0a, 0xa0]));
	}

	const packets: Uint8Array[] = [pgpPacket(5, concat(pubBody, secretTail))];
	if (options.uid !== undefined) {
		packets.push(pgpPacket(13, new TextEncoder().encode(options.uid)));
	}
	const raw = concat(...packets);
	const crc = options.badCrc === true ? "AAAA" : crc24(raw);
	return [
		"-----BEGIN PGP PRIVATE KEY BLOCK-----",
		"Comment: synthetic test key",
		"",
		bytesToBase64(raw),
		`=${crc}`,
		"-----END PGP PRIVATE KEY BLOCK-----",
		"",
	].join("\n");
}

function hasBinary(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

interface Recorded {
	readonly specs: SandboxSpec[];
	readonly signing: {
		readonly sandboxId: string;
		readonly signing: BackendGitSigning | null;
		readonly version: number;
	}[];
}

function setup(options: { readonly secretsKey?: string; readonly hostFeatures?: readonly string[] } = {}) {
	const stub = createStubBackend();
	const recorded: Recorded = { specs: [], signing: [] };
	let clock = 1_760_000_000_000;
	const backend: SandboxBackend = {
		...stub,
		capabilities: async () => {
			const base = await stub.capabilities();
			if (options.hostFeatures === undefined) return base;
			return {
				...base,
				hosts: base.hosts.map((host) => ({ ...host, features: options.hostFeatures })),
			};
		},
		create: async (spec) => {
			recorded.specs.push(spec);
			return stub.create(spec);
		},
		fork: async (source, targets) => {
			recorded.specs.push(...targets);
			return stub.fork(source, targets);
		},
		updateSigning: async (sandboxId, signing, version) => {
			recorded.signing.push({ sandboxId, signing, version });
		},
	};
	const sentWebhooks: string[] = [];
	const api = createComputeApi({
		backend,
		secretsKey: options.secretsKey === undefined ? SECRETS_KEY : options.secretsKey,
		now: () => {
			clock += 10;
			return clock;
		},
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async (input, init) => {
			sentWebhooks.push(await new Request(input, init).text());
			return new Response(null, { status: 204 });
		},
	});
	opened.push(api);
	const client = (token: string): KantelClient =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, recorded, sentWebhooks, tom: client("tom-token"), ann: client("ann-token") };
}

async function failure(work: Promise<unknown>): Promise<KantelApiError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected KantelApiError");
}

// ---------------------------------------------------------------------------------------------------------------------
// Key parsing tests

describe("parseGitSigningKey", () => {
	it("parses an unencrypted OpenPGP Ed25519 key, extracts public key, fingerprint, keyId and User ID emails", async () => {
		const key = buildPgpEd25519Key({ uid: "Jeff <Jeff@Lleverage.AI>" });
		const parsed = await parseGitSigningKey(key);
		expect(parsed.format).toBe("gpg");
		expect(parsed.encrypted).toBe(false);
		expect(parsed.fingerprint).toMatch(/^[0-9A-F]{40}$/);
		expect(parsed.keyId).toBe(parsed.fingerprint.slice(-16));
		expect(parsed.userIdEmails).toEqual(["jeff@lleverage.ai"]);
		expect(parsed.publicKey).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
		expect(parsed.publicKey).toContain("-----END PGP PUBLIC KEY BLOCK-----");
		expect(parsed.publicKey).not.toContain("PRIVATE KEY");
	});

	it("detects encrypted OpenPGP keys and rejects offline gnu-dummy primary stubs without signing subkeys", async () => {
		const encrypted = await parseGitSigningKey(buildPgpEd25519Key({ uid: "dev@example.com", encrypted: true }));
		expect(encrypted.encrypted).toBe(true);

		await expect(parseGitSigningKey(buildPgpEd25519Key({ uid: "dev@example.com", gnuDummy: true }))).rejects.toThrow(
			/no usable secret key material/i,
		);
	});

	it("rejects OpenPGP keys with invalid CRC24 checksums or mismatched requested format", async () => {
		await expect(parseGitSigningKey(buildPgpEd25519Key({ badCrc: true }))).rejects.toThrow(/armor checksum/i);
		await expect(parseGitSigningKey(buildPgpEd25519Key(), "ssh")).rejects.toThrow(/is gpg, not ssh/i);
	});

	it("parses unencrypted and encrypted OpenSSH Ed25519 private keys", async () => {
		const unenc = await parseGitSigningKey(buildSshEd25519Key());
		expect(unenc.format).toBe("ssh");
		expect(unenc.encrypted).toBe(false);
		expect(unenc.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
		expect(unenc.keyId).toBe(unenc.fingerprint.slice("SHA256:".length, "SHA256:".length + 16));
		expect(unenc.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
		expect(unenc.userIdEmails).toEqual([]);

		const enc = await parseGitSigningKey(buildSshEd25519Key({ encrypted: true }), "ssh");
		expect(enc.format).toBe("ssh");
		expect(enc.encrypted).toBe(true);
		expect(enc.fingerprint).toBe(unenc.fingerprint);

		await expect(parseGitSigningKey(buildSshEd25519Key(), "gpg")).rejects.toThrow(/is ssh, not gpg/i);
		await expect(parseGitSigningKey("not a key at all")).rejects.toThrow(/OpenPGP.*OpenSSH/i);
	});

	it("normalises, deduplicates and validates allowedEmails", () => {
		expect(normaliseAllowedEmails([" Jeff@Lleverage.AI ", "jeff@lleverage.ai", "alex@lleverage.ai"])).toEqual([
			"jeff@lleverage.ai",
			"alex@lleverage.ai",
		]);
		expect(() => normaliseAllowedEmails([])).toThrow(/At least one/);
		expect(() => normaliseAllowedEmails(["not-an-email"])).toThrow(/Invalid email/);
	});

	it.skipIf(!hasBinary("gpg"))("matches real gpg --export-secret-keys fingerprint and public key", async () => {
		const home = mkdtempSync(join(tmpdir(), "kantel-gpg-test-"));
		try {
			execFileSync(
				"gpg",
				[
					"--batch",
					"--homedir",
					home,
					"--passphrase",
					"",
					"--quick-generate-key",
					"Kantel Test <test@kantel.dev>",
					"ed25519",
					"sign",
					"never",
				],
				{ stdio: "ignore" },
			);
			const colons = execFileSync("gpg", ["--batch", "--homedir", home, "--with-colons", "--fingerprint"], {
				encoding: "utf8",
			});
			const fprLine = colons.split("\n").find((line) => line.startsWith("fpr:"));
			const expectedFpr = fprLine?.split(":")[9] ?? "";
			const secretArmor = execFileSync(
				"gpg",
				["--batch", "--homedir", home, "--armor", "--export-secret-keys", "test@kantel.dev"],
				{ encoding: "utf8" },
			);

			const parsed = await parseGitSigningKey(secretArmor, "gpg");
			expect(parsed.fingerprint).toBe(expectedFpr);
			expect(parsed.keyId).toBe(expectedFpr.slice(-16));
			expect(parsed.userIdEmails).toEqual(["test@kantel.dev"]);
			expect(parsed.encrypted).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it.skipIf(!hasBinary("ssh-keygen"))("matches real ssh-keygen Ed25519 public key and SHA256 fingerprint", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kantel-ssh-test-"));
		try {
			const keyPath = join(dir, "id_ed25519");
			execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "test@kantel.dev", "-f", keyPath], {
				stdio: "ignore",
			});
			const fpOut = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], { encoding: "utf8" });
			const expectedFp = fpOut.trim().split(/\s+/)[1] ?? "";
			const pubLine = readFileSync(`${keyPath}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
			const privKey = readFileSync(keyPath, "utf8");

			const parsed = await parseGitSigningKey(privKey, "ssh");
			expect(parsed.fingerprint).toBe(expectedFp);
			expect(parsed.publicKey).toBe(pubLine);
			expect(parsed.encrypted).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Compute API, storage, resolution, host fetch, and audit tests

describe("environment host-side Git signing", () => {
	it("seals private keys and passphrases, exposes only public metadata, and serves host-only signingKey", async () => {
		const { api, tom, recorded } = setup();
		const gpgKey = buildPgpEd25519Key({ uid: "Jeff <jeff@lleverage.ai>", encrypted: true });
		const env = await tom.createEnvironment({ name: "work" });

		// Encrypted key without passphrase is refused.
		const missingPass = await failure(tom.setEnvironmentGitSigning(env.id, { privateKey: gpgKey }));
		expect(missingPass.code).toBe("invalid");

		// Set encrypted GPG key; allowedEmails defaults to the key's User ID email.
		const updated = await tom.setEnvironmentGitSigning(env.id, {
			privateKey: gpgKey,
			passphrase: PASSPHRASE,
		});
		expect(updated.gitSigning).toBeDefined();
		expect(updated.gitSigning?.format).toBe("gpg");
		expect(updated.gitSigning?.allowedEmails).toEqual(["jeff@lleverage.ai"]);
		expect(JSON.stringify(updated)).not.toContain(gpgKey);
		expect(JSON.stringify(updated)).not.toContain(PASSPHRASE);

		// Create a microVM with the environment: backend spec receives public metadata only, never private key.
		const sandbox = await tom.createSandbox({
			name: "signing-vm",
			type: "microvm",
			environment: env.id,
			wait: true,
		});
		expect(recorded.specs).toHaveLength(1);
		const spec = recorded.specs[0];
		expect(spec?.gitSigning).toMatchObject({
			format: "gpg",
			keyId: updated.gitSigning?.keyId,
			fingerprint: updated.gitSigning?.fingerprint,
			publicKey: updated.gitSigning?.publicKey,
		});
		expect(JSON.stringify(spec)).not.toContain(gpgKey);
		expect(JSON.stringify(spec)).not.toContain(PASSPHRASE);

		// Sandbox environments view exposes active gitSigning summary (without private key).
		const sbxEnvs = await tom.listSandboxEnvironments(sandbox.id);
		expect(sbxEnvs.gitSigning).toEqual({
			environmentId: env.id,
			format: "gpg",
			keyId: updated.gitSigning?.keyId,
			fingerprint: updated.gitSigning?.fingerprint,
			allowedEmails: ["jeff@lleverage.ai"],
		});

		// Host-only signingKey answers ONLY for the sandbox's own host.
		expect(await api.service.signingKey("host_other", sandbox.id)).toBeUndefined();
		expect(await api.service.signingKey(STUB_HOST_ID, "sbx_missing")).toBeUndefined();
		const hostKey = await api.service.signingKey(STUB_HOST_ID, sandbox.id);
		expect(hostKey).toMatchObject({
			enabled: true,
			format: "gpg",
			keyId: updated.gitSigning?.keyId,
			fingerprint: updated.gitSigning?.fingerprint,
			allowedEmails: ["jeff@lleverage.ai"],
			privateKey: gpgKey,
			passphrase: PASSPHRASE,
		});

		// Clearing passphrase on an encrypted key is refused.
		const badClear = await failure(tom.setEnvironmentGitSigning(env.id, { passphrase: "" }));
		expect(badClear.code).toBe("invalid");

		// Updating allowedEmails without privateKey rotates version and pushes updateSigning to the running sandbox.
		const updatedEmails = await tom.setEnvironmentGitSigning(env.id, {
			allowedEmails: ["jeff@lleverage.ai", "bot@lleverage.ai"],
		});
		expect(updatedEmails.gitSigning?.allowedEmails).toEqual(["jeff@lleverage.ai", "bot@lleverage.ai"]);
		await expect.poll(() => recorded.signing.length).toBeGreaterThanOrEqual(1);
		const pushed = recorded.signing.at(-1);
		expect(pushed?.sandboxId).toBe(sandbox.id);
		expect(pushed?.version).toBeGreaterThan(hostKey?.version ?? 0);
		expect(pushed?.signing?.keyId).toBe(updated.gitSigning?.keyId);

		// Deleting signing clears it on the environment and pushes null to the running sandbox.
		const cleared = await tom.deleteEnvironmentGitSigning(env.id);
		expect(cleared.gitSigning).toBeUndefined();
		await expect.poll(() => recorded.signing.at(-1)?.signing).toBeNull();
		const afterDelete = await api.service.signingKey(STUB_HOST_ID, sandbox.id);
		expect(afterDelete?.enabled).toBe(false);
		expect(afterDelete?.version).toBeGreaterThan(pushed?.version ?? 0);
	});

	it("handles multi-environment shadowing (later wins), attach/detach, fork, and environment deletion", async () => {
		const { api, tom, recorded } = setup();
		const envA = await tom.createEnvironment({ name: "base" });
		const envB = await tom.createEnvironment({ name: "override" });
		const gpgA = buildPgpEd25519Key({ uid: "a@example.com", seedByte: 0x11 });
		const sshB = buildSshEd25519Key({ seedByte: 0x22 });

		const savedA = await tom.setEnvironmentGitSigning(envA.id, { privateKey: gpgA });
		const savedB = await tom.setEnvironmentGitSigning(envB.id, {
			privateKey: sshB,
			allowedEmails: ["b@example.com"],
		});

		const sandbox = await tom.createSandbox({
			name: "multi-env-vm",
			type: "microvm",
			environments: [envA.id, envB.id],
			wait: true,
		});

		// Later environment (envB) wins; envA's gitSigning is marked shadowed.
		const list = await tom.listSandboxEnvironments(sandbox.id);
		expect(list.gitSigning).toEqual({
			environmentId: envB.id,
			format: "ssh",
			keyId: savedB.gitSigning?.keyId,
			fingerprint: savedB.gitSigning?.fingerprint,
			allowedEmails: ["b@example.com"],
		});
		expect(list.environments[0]?.shadowed.gitSigning).toBe(true);
		expect(list.environments[1]?.shadowed.gitSigning).toBeUndefined();

		const key1 = await api.service.signingKey(STUB_HOST_ID, sandbox.id);
		expect(key1?.format).toBe("ssh");
		expect(key1?.privateKey).toBe(sshB);

		// Fork inherits the same signing metadata (never the private key).
		const [forked] = (await tom.forkSandbox(sandbox.id, { name: "multi-env-fork", wait: true })).items;
		expect(forked).toBeDefined();
		const forkSpec = recorded.specs.find((s) => s.sandboxId === forked?.id);
		expect(forkSpec?.gitSigning?.keyId).toBe(savedB.gitSigning?.keyId);
		expect(JSON.stringify(forkSpec)).not.toContain(sshB);

		// Detaching envB falls back to envA with a monotonically higher version.
		await tom.detachSandboxEnvironment(sandbox.id, envB.id);
		const key2 = await api.service.signingKey(STUB_HOST_ID, sandbox.id);
		expect(key2?.format).toBe("gpg");
		expect(key2?.keyId).toBe(savedA.gitSigning?.keyId);
		expect(key2?.version).toBeGreaterThan(key1?.version ?? 0);

		// Deleting envA disables signing on the sandbox and pushes null.
		await tom.deleteEnvironment(envA.id);
		await expect.poll(() => recorded.signing.filter((r) => r.sandboxId === sandbox.id).at(-1)?.signing).toBeNull();
		const key3 = await api.service.signingKey(STUB_HOST_ID, sandbox.id);
		expect(key3?.enabled).toBe(false);
		expect(key3?.version).toBeGreaterThan(key2?.version ?? 0);
	});

	it("records sandbox.git_signed and sandbox.git_sign_refused audit events only from the sandbox's own host", async () => {
		const { api, tom, sentWebhooks } = setup();
		const env = await tom.createEnvironment({ name: "audit-env" });
		await tom.setEnvironmentGitSigning(env.id, { privateKey: buildPgpEd25519Key({ uid: "jeff@lleverage.ai" }) });

		await tom.createWebhook({
			name: "signing-audit",
			url: "https://hooks.example.com/signing",
			events: ["sandbox.git_signed", "sandbox.git_sign_refused"],
		});

		const sandbox = await tom.createSandbox({
			name: "audit-vm",
			type: "microvm",
			environment: env.id,
			wait: true,
		});

		// Reports from a different host are dropped.
		await api.service.recordSigning("host_imposter", [
			{
				at: Date.now(),
				sandboxId: sandbox.id,
				allowed: true,
				format: "gpg",
				keyId: "IMPOSTER",
				objectType: "commit",
				committer: "evil@example.com",
			},
		]);

		// Reports from the sandbox's real host are persisted and dispatched.
		await api.service.recordSigning(STUB_HOST_ID, [
			{
				at: Date.now(),
				sandboxId: sandbox.id,
				allowed: true,
				format: "gpg",
				keyId: "FD86B81C2E05E2A5",
				fingerprint: "AABBCCDD",
				objectType: "commit",
				committer: "jeff@lleverage.ai",
				object: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			},
			{
				at: Date.now(),
				sandboxId: sandbox.id,
				allowed: false,
				format: "gpg",
				keyId: "FD86B81C2E05E2A5",
				objectType: "commit",
				committer: "other@example.com",
				reason: "committer email other@example.com is not permitted",
			},
		]);

		const events = await tom.listEvents({ sandboxId: sandbox.id });
		const signed = events.items.filter((event) => event.type === "sandbox.git_signed");
		const refused = events.items.filter((event) => event.type === "sandbox.git_sign_refused");
		expect(signed).toHaveLength(1);
		expect(signed[0]?.data).toMatchObject({
			format: "gpg",
			keyId: "FD86B81C2E05E2A5",
			objectType: "commit",
			committer: "jeff@lleverage.ai",
		});
		expect(refused).toHaveLength(1);
		expect(refused[0]?.data).toMatchObject({
			committer: "other@example.com",
			reason: "committer email other@example.com is not permitted",
		});

		await api.dispatcher.drain();
		const webhookEvents = sentWebhooks.map((body) => (JSON.parse(body) as computeSchema.Event).type);
		expect(webhookEvents).toContain("sandbox.git_signed");
		expect(webhookEvents).toContain("sandbox.git_sign_refused");
	});

	it("refuses setting or attaching Git signing when a running microVM is on a host without git-signing", async () => {
		const { tom } = setup({ hostFeatures: ["egress-policy"] });
		const env = await tom.createEnvironment({ name: "old-host-env" });
		const sandbox = await tom.createSandbox({
			name: "old-host-vm",
			type: "microvm",
			environment: env.id,
			wait: true,
		});
		expect(sandbox.state).toBe("running");

		const err = await failure(
			tom.setEnvironmentGitSigning(env.id, { privateKey: buildPgpEd25519Key({ uid: "jeff@lleverage.ai" }) }),
		);
		expect(err.code).toBe("not_supported");
		expect(err.message).toMatch(/doesn't support host-side Git signing/i);
	});
});
