import { describe, expect, it } from "vitest";
import { parsePlatformClients } from "../src/platform-clients.ts";

const env: Record<string, string> = { GMAIL_SECRET: "gmail-secret-value", EMPTY: " " };
const secret = (name: string) => env[name];

describe("parsePlatformClients", () => {
	it("reads public and confidential clients, each secret from the variable its secretEnv names", () => {
		const parsed = parsePlatformClients(
			JSON.stringify([
				{ templateId: "github", clientId: "Iv23-public", label: "Harbour for GitHub" },
				{ templateId: "gmail", clientId: "gmail-client", secretEnv: "GMAIL_SECRET", scopes: ["a", "b"] },
				{ issuer: "https://auth.example.com", clientId: "issuer-client" },
			]),
			secret,
		);
		expect(parsed.problems).toEqual([]);
		expect(parsed.clients).toEqual([
			{ templateId: "github", clientId: "Iv23-public", label: "Harbour for GitHub" },
			{ templateId: "gmail", clientId: "gmail-client", clientSecret: "gmail-secret-value", scopes: ["a", "b"] },
			{ issuer: "https://auth.example.com", clientId: "issuer-client" },
		]);
	});

	it("is nothing when unset or blank", () => {
		expect(parsePlatformClients(undefined, secret)).toEqual({ clients: [], problems: [] });
		expect(parsePlatformClients("  ", secret)).toEqual({ clients: [], problems: [] });
	});

	it("reports bad JSON and a document that is not a list, without throwing", () => {
		expect(parsePlatformClients("[{", secret).problems).toHaveLength(1);
		expect(parsePlatformClients('{"clientId":"x"}', secret).problems).toHaveLength(1);
	});

	it("leaves out a bad entry and keeps the rest, never repeating a secret", () => {
		const parsed = parsePlatformClients(
			JSON.stringify([
				{ templateId: "github", clientId: "ok" },
				{ templateId: "github", clientId: "inline", clientSecret: "inline-secret-value" },
				{ templateId: "gmail", clientId: "missing", secretEnv: "NOT_SET" },
				{ templateId: "gmail", clientId: "blank", secretEnv: "EMPTY" },
				{ templateId: "gmail", clientId: "bad-name", secretEnv: "not a name" },
				{ clientId: "nowhere" },
				{ templateId: "github" },
				{ issuer: "http://auth.example.com", clientId: "insecure" },
				"not an object",
			]),
			secret,
		);
		expect(parsed.clients.map((client) => client.clientId)).toEqual(["ok"]);
		expect(parsed.problems).toHaveLength(8);
		expect(parsed.problems[0]).toMatch(/^HARBOUR_OAUTH_CLIENTS\[1\]/);
		expect(parsed.problems.join("\n")).not.toContain("inline-secret-value");
	});
});
