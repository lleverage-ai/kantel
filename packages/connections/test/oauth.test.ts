import { describe, expect, it } from "vitest";
import { publicUrl, tokenRequest } from "../src/oauth.ts";

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
