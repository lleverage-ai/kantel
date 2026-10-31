import { describe, expect, it } from "vitest";
import { DEVICE_FLOW_DISABLED, deviceAuthorization, devicePoll, publicUrl, tokenRequest } from "../src/oauth.ts";

describe("publicUrl", () => {
	it("takes a public https URL and refuses local, private and single-label hosts", () => {
		expect(publicUrl("https://mcp.example.com/mcp", "The URL").hostname).toBe("mcp.example.com");
		for (const url of [
			"http://mcp.example.com/",
			"https://localhost/",
			"https://localhost./",
			"https://intranet/",
			"https://10.0.0.1/",
			"https://169.254.169.254/",
			"https://[::1]/",
			"https://user:pass@mcp.example.com/",
		]) {
			expect(() => publicUrl(url, "The URL"), url).toThrow();
		}
	});
});

describe("tokenRequest", () => {
	it("never repeats what it sent in its error, whatever the server echoes back", async () => {
		const echo = async (_url: string, init?: RequestInit) =>
			new Response(
				JSON.stringify({
					error: "invalid_grant <script>",
					error_description: `bad ${new URLSearchParams(String(init?.body)).get("refresh_token")} with s3cret-client-value`,
				}),
				{ status: 400 },
			);
		const failure = await tokenRequest(
			echo,
			"https://auth.example.com/token",
			{ clientId: "client", clientSecret: "s3cret-client-value" },
			{ grant_type: "refresh_token", refresh_token: "rt-very-secret-1234" },
			{ now: 0 },
		).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).not.toContain("rt-very-secret-1234");
		expect(message).not.toContain("s3cret-client-value");
		expect(message).not.toContain("<script>");
		expect(message).toContain("[redacted]");
	});
});

describe("the device flow", () => {
	const answer = (body: unknown, status = 200) =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

	it("asks for codes with the client ID and scope only, and never follows a redirect", async () => {
		const sent: { url: string; init?: RequestInit }[] = [];
		const device = await deviceAuthorization(
			async (url, init) => {
				sent.push({ url, ...(init === undefined ? {} : { init }) });
				return answer({
					device_code: "dc-secret-1234",
					user_code: "WDJB-MJHT",
					verification_uri: "https://github.com/login/device",
					expires_in: 899,
					interval: 5,
				});
			},
			"https://github.com/login/device/code",
			{ clientId: "Iv23-public", scope: "repo read:org" },
		);
		expect(device).toEqual({
			deviceCode: "dc-secret-1234",
			userCode: "WDJB-MJHT",
			verificationUri: "https://github.com/login/device",
			expiresIn: 899,
			interval: 5,
		});
		const body = new URLSearchParams(String(sent[0]?.init?.body));
		expect([...body.keys()].sort()).toEqual(["client_id", "scope"]);
		expect(body.get("scope")).toBe("repo read:org");
		expect(sent[0]?.init?.redirect).toBe("manual");
	});

	it("says plainly when GitHub has the device flow turned off", async () => {
		const failure = await deviceAuthorization(
			async () => answer({ error: "device_flow_disabled" }, 400),
			"https://github.com/login/device/code",
			{ clientId: "Iv23-public" },
		).catch((error: Error) => error);
		expect((failure as Error).message).toBe(DEVICE_FLOW_DISABLED);
	});

	it("reads pending, slow down, an error and tokens, in JSON or form encoding", async () => {
		const poll = (body: unknown, status = 200) =>
			devicePoll(async () => answer(body, status), "https://github.com/login/oauth/access_token", "cid", "dc-1234", {
				now: 1000,
			});
		expect(await poll({ error: "authorization_pending" })).toEqual({ pending: true });
		expect(await poll("error=slow_down&interval=10")).toEqual({ slowDown: true, interval: 10 });
		expect(await poll({ error: "slow_down" })).toEqual({ slowDown: true });
		expect(await poll({ error: "access_denied", error_description: "no thanks for dc-1234" }, 400)).toEqual({
			error: "access_denied",
			description: "no thanks for [redacted]",
		});
		expect(await poll({ access_token: "gho_token", token_type: "bearer", scope: "repo", expires_in: 10 })).toEqual({
			tokens: { accessToken: "gho_token", scopes: ["repo"], expiresAt: 11_000 },
		});
	});

	it("sends the device code grant with no secret", async () => {
		let body: URLSearchParams | undefined;
		await devicePoll(
			async (_url, init) => {
				body = new URLSearchParams(String(init?.body));
				return answer({ error: "authorization_pending" });
			},
			"https://github.com/login/oauth/access_token",
			"cid",
			"dc-1234",
			{ now: 0 },
		);
		expect(body?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(body?.get("device_code")).toBe("dc-1234");
		expect(body?.has("client_secret")).toBe(false);
	});
});
