// The browser host's Kubernetes machines against a fake API server: a browser is a Secret with its agent's token and
// a Pod that reads it, reached at the Pod's IP; stopping removes both; the janitor removes only its own stack's
// leftovers. No cluster needed.
import { describe, expect, it } from "vitest";
import {
	browserPod,
	type KubernetesOptions,
	kubernetesMachine,
	labelValue,
	objectName,
	removeKubernetesLeftovers,
} from "../../src/browser/kubernetes.ts";

interface Pod {
	metadata: { name: string; labels: { [key: string]: string } };
	spec: unknown;
	status?: { phase: string; podIP?: string };
}

/** A namespace's Pods and Secrets, and what was asked of it. */
function fakeApi() {
	const pods = new Map<string, Pod>();
	const secrets = new Map<string, { metadata: { name: string }; stringData: { [key: string]: string } }>();
	const calls: string[] = [];
	const agentCalls: string[] = [];
	let nextIp = 10;
	const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(input);
		const method = init.method ?? "GET";
		if (url.hostname.startsWith("10.0.0.")) {
			agentCalls.push(`${method} ${url.host}${url.pathname}`);
			return Response.json({ ok: true });
		}
		expect(new Headers(init.headers).get("authorization")).toBe("Bearer sa-token");
		const path = url.pathname.replace("/api/v1/namespaces/browsers", "");
		calls.push(`${method} ${path}${url.search}`);
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const [, kind, name] = path.split("/");
		const store = kind === "pods" ? pods : secrets;
		if (method === "POST") {
			if (store.has(body.metadata.name)) return Response.json({ reason: "AlreadyExists" }, { status: 409 });
			if (kind === "pods") {
				body.status = { phase: "Pending" };
				// Scheduled and running by the second look.
				setTimeout(() => {
					body.status = { phase: "Running", podIP: `10.0.0.${nextIp++}` };
				}, 10);
			}
			store.set(body.metadata.name, body);
			return Response.json(body, { status: 201 });
		}
		if (method === "DELETE") {
			if (name === undefined || !store.delete(name)) return Response.json({ reason: "NotFound" }, { status: 404 });
			return Response.json({});
		}
		if (name !== undefined) {
			const found = store.get(name);
			return found === undefined ? Response.json({}, { status: 404 }) : Response.json(found);
		}
		const selector = url.searchParams.get("labelSelector") ?? "";
		const [key, value] = selector.split("=");
		return Response.json({ items: [...pods.values()].filter((pod) => pod.metadata.labels[key!] === value) });
	};
	return { pods, secrets, calls, agentCalls, fetch };
}

const options = (fetch: KubernetesOptions["fetch"], stack = "kantel"): KubernetesOptions => ({
	apiUrl: "https://kubernetes.invalid",
	token: async () => "sa-token",
	namespace: "browsers",
	image: "registry.example.com/harbour-browser:1",
	stack,
	memoryBytes: 2048 * 1024 * 1024,
	nanoCpus: 1e9,
	runtimeClass: "gvisor",
	fetch,
});

describe("the browser host's Kubernetes machines", () => {
	it("names a browser's objects as Kubernetes takes them", () => {
		expect(objectName("6F1C2E1A-0000-4000-8000-ABCDEFABCDEF")).toBe(
			"kantel-browser-6f1c2e1a-0000-4000-8000-abcdefabcdef",
		);
		expect(objectName("x".repeat(100))).toHaveLength(63);
		expect(labelValue("-a b-")).toBe("a-b");
	});

	it("runs a browser as a Pod reading its agent's token from a Secret, never from its spec", () => {
		const pod = browserPod(options(undefined), "b1");
		const text = JSON.stringify(pod);
		expect(pod.spec.runtimeClassName).toBe("gvisor");
		expect(pod.spec.automountServiceAccountToken).toBe(false);
		expect(pod.spec.containers[0]?.envFrom).toEqual([{ secretRef: { name: "kantel-browser-b1" } }]);
		expect(pod.spec.containers[0]?.resources.limits).toEqual({ memory: "2048Mi", cpu: "1000m" });
		expect(text).not.toContain("agent-token");
	});

	it("starts a browser, reaches its agent at the Pod's IP, and removes the Pod and Secret on stop", async () => {
		const api = fakeApi();
		const machine = kubernetesMachine(options(api.fetch), "b1");
		await machine.start({ AGENT_TOKEN: "agent-token" });
		expect(api.secrets.get("kantel-browser-b1")?.stringData).toEqual({ AGENT_TOKEN: "agent-token" });
		expect(JSON.stringify(api.pods.get("kantel-browser-b1")?.spec)).not.toContain("agent-token");
		expect(machine.address()).toEqual({ host: expect.stringMatching(/^10\.0\.0\./), port: 8080 });
		expect((await machine.fetch("/health")).ok).toBe(true);
		expect(api.agentCalls).toEqual([`GET ${machine.address()?.host}:8080/health`]);

		// Starting again while it runs makes nothing new.
		const created = api.calls.filter((call) => call.startsWith("POST")).length;
		await machine.start({ AGENT_TOKEN: "agent-token" });
		expect(api.calls.filter((call) => call.startsWith("POST")).length).toBe(created);

		await machine.stop();
		expect(api.pods.size).toBe(0);
		expect(api.secrets.size).toBe(0);
		expect(machine.address()).toBeUndefined();
		// Stopping one already gone is not an error.
		await machine.stop();
	});

	it("removes only its own stack's leftovers, keeping the browsers it knows", async () => {
		const api = fakeApi();
		await kubernetesMachine(options(api.fetch), "kept").start({ AGENT_TOKEN: "a" });
		await kubernetesMachine(options(api.fetch), "left").start({ AGENT_TOKEN: "b" });
		await kubernetesMachine(options(api.fetch, "other"), "theirs").start({ AGENT_TOKEN: "c" });
		expect(await removeKubernetesLeftovers(options(api.fetch), new Set(["kept"]))).toBe(1);
		expect([...api.pods.keys()].sort()).toEqual(["kantel-browser-kept", "kantel-browser-theirs"]);
		expect([...api.secrets.keys()].sort()).toEqual(["kantel-browser-kept", "kantel-browser-theirs"]);
	});
});
