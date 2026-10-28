import { HarbourError, systemContext } from "@harbour/contracts";
import { createHmacSessionTokens } from "@harbour/models/tokens";
import {
	assertWorkerCallRefused,
	createDeps,
	createExpectAssertions,
	ManualClock,
	RecordingAuditSink,
} from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const KEY = "model-session-token-key-for-tests-0123456789";
const RUNTIME = systemContext("session-runtime");
const GATEWAY = systemContext("model-gateway");
const scope = { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "sess-1" };

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof HarbourError ? error.code : String(error);
	}
}

describe("createHmacSessionTokens", () => {
	it("mints a compact token whose claims verify back to the scope", async () => {
		const clock = new ManualClock();
		const tokens = createHmacSessionTokens({ key: KEY, clock });
		const { token, expiresAt } = await tokens.mint(RUNTIME, scope);
		expect(token).toMatch(/^hms1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
		expect(expiresAt).toBe(clock.now() + 15 * 60_000);
		expect(await tokens.verify(GATEWAY, token)).toEqual(scope);
	});

	it("refuses a tampered, foreign-key or malformed token as forbidden", async () => {
		const tokens = createHmacSessionTokens({ key: KEY });
		const { token } = await tokens.mint(RUNTIME, scope);
		const [prefix, claims, mac] = token.split(".") as [string, string, string];
		const forged = JSON.parse(Buffer.from(claims, "base64url").toString()) as { o: string };
		forged.o = "org-b";
		const forgedClaims = Buffer.from(JSON.stringify(forged)).toString("base64url");
		expect(await code(tokens.verify(GATEWAY, `${prefix}.${forgedClaims}.${mac}`))).toBe("forbidden");
		const other = createHmacSessionTokens({ key: `${KEY}-other` });
		expect(await code(other.verify(GATEWAY, token))).toBe("forbidden");
		for (const bad of ["", "hms1", "hms1.a.b", `hms2.${claims}.${mac}`, `${token}.extra`, `${prefix}.${claims}.%%`]) {
			expect(await code(tokens.verify(GATEWAY, bad))).toBe("forbidden");
		}
	});

	it("expires a token after its lifetime, capped by maxTtlMs", async () => {
		const clock = new ManualClock();
		const tokens = createHmacSessionTokens({ key: KEY, clock, maxTtlMs: 60_000 });
		const { token, expiresAt } = await tokens.mint(RUNTIME, scope, 24 * 60 * 60_000);
		expect(expiresAt).toBe(clock.now() + 60_000);
		clock.advance(59_999);
		expect(await tokens.verify(GATEWAY, token)).toEqual(scope);
		clock.advance(1);
		expect(await code(tokens.verify(GATEWAY, token))).toBe("expired");
	});

	it("needs a key of at least 32 bytes and a full scope", async () => {
		expect(() => createHmacSessionTokens({ key: "short" })).toThrow(HarbourError);
		const tokens = createHmacSessionTokens({ key: new Uint8Array(32).fill(7) });
		expect(await code(tokens.mint(RUNTIME, { ...scope, sessionId: "" }))).toBe("invalid");
		expect(await code(tokens.mint(RUNTIME, scope, 0))).toBe("invalid");
	});

	it("mint and verify are worker calls", async () => {
		const deps = createDeps();
		const audit = new RecordingAuditSink();
		const tokens = createHmacSessionTokens({ key: KEY, clock: deps.clock, audit });
		const { token } = await tokens.mint(RUNTIME, scope);
		const a = createExpectAssertions(expect);
		await assertWorkerCallRefused(a, { audit }, "models.tokens.mint", (ctx) => tokens.mint(ctx, scope), "org-a");
		await assertWorkerCallRefused(a, { audit }, "models.tokens.verify", (ctx) => tokens.verify(ctx, token), "org-a");
	});
});
