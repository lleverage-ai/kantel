import { createHash } from "node:crypto";
import {
	API_KEY_PREFIX_LENGTH,
	apiKeyPrefix,
	generateApiKeySecret,
	hashApiKeySecret,
	strongestRole,
} from "@harbour/identity";
import { describe, expect, it } from "vitest";

describe("generateApiKeySecret", () => {
	it("is hbr_ followed by 32 random bytes in unpadded base64url", () => {
		const secret = generateApiKeySecret();
		expect(secret).toMatch(/^hbr_[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(secret.slice(4), "base64url")).toHaveLength(32);
	});

	it("never repeats", () => {
		const secrets = new Set(Array.from({ length: 200 }, () => generateApiKeySecret()));
		expect(secrets.size).toBe(200);
	});
});

describe("apiKeyPrefix", () => {
	it("keeps the first 12 characters", () => {
		const secret = generateApiKeySecret();
		expect(apiKeyPrefix(secret)).toBe(secret.slice(0, API_KEY_PREFIX_LENGTH));
		expect(apiKeyPrefix(secret)).toHaveLength(12);
	});
});

describe("hashApiKeySecret", () => {
	it("is the lowercase hex SHA-256 of the secret", async () => {
		const secret = generateApiKeySecret();
		expect(await hashApiKeySecret(secret)).toBe(createHash("sha256").update(secret).digest("hex"));
	});
});

describe("strongestRole", () => {
	it("picks the strongest role and is undefined for none", () => {
		expect(strongestRole([])).toBeUndefined();
		expect(strongestRole(["viewer"])).toBe("viewer");
		expect(strongestRole(["operator", "viewer"])).toBe("operator");
		expect(strongestRole(["viewer", "admin", "operator"])).toBe("admin");
	});
});
