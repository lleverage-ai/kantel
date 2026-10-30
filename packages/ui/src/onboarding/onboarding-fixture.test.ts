// The onboarding page's calls, on the fixture that runs the real onboarding and model provider services: what the
// stories and screenshots show is what those services answer.

import { describe, expect, it } from "vitest";
import { createFixtureOnboardingApi } from "./onboarding-fixture.ts";
import { ONBOARDING_STEP_TEXT } from "./onboarding-page.tsx";

describe("onboarding fixture", () => {
	it("starts a fresh install at connecting a model, with no subscription signed in", async () => {
		const api = createFixtureOnboardingApi();
		const state = await api.get();
		expect(state.status).toBe("active");
		expect(state.current).toBe("models");
		const providers = await api.modelProviders();
		expect(providers.defaultRoute?.owner).toBe("platform");
		const claude = providers.items.find((item) => item.id === "claude");
		expect(claude?.available).toBe(true);
		expect(claude?.connection).toBeUndefined();
	});

	it("has nothing serving sessions without CLIProxyAPI or a key", async () => {
		const api = createFixtureOnboardingApi({ subscriptions: false });
		expect((await api.modelProviders()).defaultRoute).toBeUndefined();
	});

	it("signs in to a subscription after polling, and then serves sessions", async () => {
		const api = createFixtureOnboardingApi({ signInPolls: 2 });
		const started = await api.startSignIn("claude");
		expect(started.status).toBe("pending");
		expect(started.url).toMatch(/^https:\/\//);
		expect((await api.signInStatus("claude", started.id)).status).toBe("pending");
		expect((await api.signInStatus("claude", started.id)).status).toBe("completed");
		const providers = await api.modelProviders();
		expect(providers.items.find((item) => item.id === "claude")?.connection).toBeDefined();
		expect(providers.defaultRoute?.connectorId).toBe("cliproxyapi");
	});

	it("connects a key provider without ever answering the key", async () => {
		const api = createFixtureOnboardingApi({ subscriptions: false });
		const connected = await api.connectModelKey("anthropic", { key: "sk-ant-api03-fixture-key" });
		expect(JSON.stringify(connected)).not.toContain("sk-ant-api03-fixture-key");
		expect((await api.modelProviders()).defaultRoute?.connectorId).toContain("anthropic");
	});

	it("offers no subscriptions where the deployment can't sign in", async () => {
		const api = createFixtureOnboardingApi({ subscriptions: false });
		const claude = (await api.modelProviders()).items.find((item) => item.id === "claude");
		expect(claude?.available).toBe(false);
		expect(claude?.unavailableReason).toBeTruthy();
	});

	it("advances through the steps, completes, and keeps a dismissal", async () => {
		const api = createFixtureOnboardingApi();
		expect((await api.setStep("models", "done")).current).toBe("connectors");
		expect((await api.setStep("connectors", "skipped")).current).toBe("session");
		expect((await api.setStep("session", "done")).status).toBe("completed");
		const other = createFixtureOnboardingApi();
		expect((await other.dismiss()).status).toBe("dismissed");
		expect((await other.get()).status).toBe("dismissed");
	});

	it("connects a connector through OAuth once the attempt completes", async () => {
		const api = createFixtureOnboardingApi();
		const connections = api.connections;
		if (connections === undefined) throw new Error("the fixture serves connections by default");
		const attempt = await connections.connect("github");
		expect(attempt.status).toBe("pending");
		await connections.attempt(attempt.id);
		expect((await connections.attempt(attempt.id)).status).toBe("completed");
		expect((await connections.connections()).map((connection) => connection.templateId)).toEqual(["github"]);
	});

	it("names every step", () => {
		expect(Object.keys(ONBOARDING_STEP_TEXT).sort()).toEqual(["connectors", "models", "session"]);
	});
});
