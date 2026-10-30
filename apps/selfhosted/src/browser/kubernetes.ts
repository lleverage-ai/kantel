// The browser host's machines on Kubernetes: one Pod of images/browser per browser, through the Kubernetes API, as
// docker.ts does with containers on one machine. The host runs in the cluster (deploy/kubernetes), with a service
// account that may only manage Pods, and create and delete Secrets, in its own namespace.
//
// - The agent's per-start token is in a Secret of its own (`harbour-browser-<id>`), which the Pod reads as its
//   environment: it is never in the Pod's spec, and the host's role cannot read Secrets back.
// - The host reaches the agent at the Pod's IP, port 8080. deploy/kubernetes's NetworkPolicy lets only the host in,
//   and lets the browser out to the internet but not into the cluster.
// - Labels: `harbour.dev/browser-host` (the stack) and `harbour.dev/browser` (the browser ID), so the janitor removes
//   only its own stack's leftovers.
// - Limits: the same HARBOUR_BROWSER_MEMORY_MB and HARBOUR_BROWSER_CPUS, a memory-backed /dev/shm, and
//   HARBOUR_BROWSER_RUNTIME_CLASS (gVisor's `gvisor`, say) when set.
//
// In the cluster it reads the service account's token, CA and namespace from their usual files; a test gives an API
// URL and token instead.

import { readFile } from "node:fs/promises";
import type { AgentAddress, DockerBrowserMachine } from "./docker.ts";
import { AGENT_PORT } from "./docker.ts";

export interface KubernetesOptions {
	/** The API server. Default: https://kubernetes.default.svc, with the service account's CA. */
	readonly apiUrl: string;
	/** The service account's token (read again on each call, as it is rotated). */
	readonly token: () => Promise<string>;
	/** The PEM CA the API server's certificate is checked against. */
	readonly ca?: string;
	readonly namespace: string;
	readonly image: string;
	readonly stack: string;
	readonly runtimeClass?: string;
	readonly memoryBytes: number;
	readonly nanoCpus: number;
	/** How long a Pod has to be scheduled, pull its image and get an IP. Default 120 s. */
	readonly startTimeoutMs?: number;
	readonly imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
	/** Default: the global fetch, given the CA as Bun's `tls.ca`. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The options in a cluster, from the service account's files and the host's environment. */
export async function inClusterOptions(
	rest: Omit<KubernetesOptions, "apiUrl" | "token" | "ca" | "namespace"> & { readonly namespace?: string },
): Promise<KubernetesOptions> {
	const host = process.env.KUBERNETES_SERVICE_HOST;
	const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
	const namespace = rest.namespace ?? (await readFile(`${SERVICE_ACCOUNT}/namespace`, "utf8")).trim();
	return {
		...rest,
		apiUrl:
			host === undefined
				? "https://kubernetes.default.svc"
				: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
		token: async () => (await readFile(`${SERVICE_ACCOUNT}/token`, "utf8")).trim(),
		ca: await readFile(`${SERVICE_ACCOUNT}/ca.crt`, "utf8"),
		namespace,
	};
}

/** A name Kubernetes takes (DNS-1123: lowercase letters, digits and `-`, at most 63) for a browser's objects. */
export function objectName(browserId: string): string {
	const cleaned = browserId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return `harbour-browser-${cleaned}`.slice(0, 63).replace(/-+$/, "");
}

/** A label value Kubernetes takes: at most 63 letters, digits, `-`, `_` and `.`, alphanumeric at both ends. */
export function labelValue(value: string): string {
	return value
		.replace(/[^A-Za-z0-9_.-]/g, "-")
		.slice(0, 63)
		.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

const STACK_LABEL = "harbour.dev/browser-host";
const BROWSER_LABEL = "harbour.dev/browser";

interface PodStatus {
	readonly metadata?: { readonly labels?: { readonly [key: string]: string } };
	readonly status?: { readonly phase?: string; readonly podIP?: string };
}

function client(options: KubernetesOptions) {
	const send =
		options.fetch ??
		((input: string, init?: RequestInit) =>
			fetch(input, { ...init, ...(options.ca === undefined ? {} : { tls: { ca: options.ca } }) } as RequestInit));
	const base = `${options.apiUrl.replace(/\/+$/, "")}/api/v1/namespaces/${encodeURIComponent(options.namespace)}`;
	return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
		const answer = await send(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${await options.token()}`,
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await answer.text();
		let parsed: unknown;
		try {
			parsed = text === "" ? undefined : JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: answer.status, body: parsed };
	};
}

const failure = (what: string, answer: { status: number; body: unknown }) =>
	new Error(`kubernetes ${what}: ${answer.status} ${JSON.stringify(answer.body ?? "").slice(0, 300)}`);

/** The Pod for one browser, as the API takes it. */
export function browserPod(options: KubernetesOptions, browserId: string) {
	const name = objectName(browserId);
	const labels = { [STACK_LABEL]: labelValue(options.stack), [BROWSER_LABEL]: labelValue(browserId) };
	const memory = `${Math.max(1, Math.round(options.memoryBytes / 1024 / 1024))}Mi`;
	const cpu = `${Math.max(1, Math.round(options.nanoCpus / 1e6))}m`;
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: { name, labels },
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			...(options.runtimeClass === undefined ? {} : { runtimeClassName: options.runtimeClass }),
			containers: [
				{
					name: "browser",
					image: options.image,
					imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
					ports: [{ name: "agent", containerPort: AGENT_PORT }],
					// The start's environment (the agent's token) from its Secret, never in the spec.
					envFrom: [{ secretRef: { name } }],
					resources: { requests: { memory, cpu }, limits: { memory, cpu } },
					securityContext: { allowPrivilegeEscalation: false },
					volumeMounts: [{ name: "shm", mountPath: "/dev/shm" }],
				},
			],
			volumes: [{ name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } }],
		},
	};
}

export function kubernetesMachine(options: KubernetesOptions, browserId: string): DockerBrowserMachine {
	const call = client(options);
	const name = objectName(browserId);
	const labels = { [STACK_LABEL]: labelValue(options.stack), [BROWSER_LABEL]: labelValue(browserId) };
	const send = options.fetch ?? fetch;
	let address: AgentAddress | undefined;

	const inspect = async (): Promise<AgentAddress | undefined> => {
		const answer = await call("GET", `/pods/${name}`);
		if (answer.status !== 200) return undefined;
		const pod = answer.body as PodStatus;
		const ip = pod.status?.podIP;
		return pod.status?.phase === "Running" && ip ? { host: ip, port: AGENT_PORT } : undefined;
	};

	const remove = async () => {
		const gone = (answer: { status: number }) => answer.status < 300 || answer.status === 404;
		const pod = await call("DELETE", `/pods/${name}`, { gracePeriodSeconds: 0 });
		const secret = await call("DELETE", `/secrets/${name}`);
		if (!gone(pod)) throw failure(`delete pod ${name}`, pod);
		if (!gone(secret)) throw failure(`delete secret ${name}`, secret);
	};

	return {
		async start(env) {
			address = await inspect();
			if (address !== undefined) return;
			await remove();
			// The Pod may still be terminating: wait for its name to be free.
			for (let i = 0; i < 100; i += 1) {
				if ((await call("GET", `/pods/${name}`)).status === 404) break;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			const secret = await call("POST", "/secrets", {
				apiVersion: "v1",
				kind: "Secret",
				metadata: { name, labels },
				type: "Opaque",
				stringData: { ...env },
			});
			if (secret.status !== 201) throw failure(`create secret ${name}`, secret);
			const pod = await call("POST", "/pods", browserPod(options, browserId));
			if (pod.status !== 201) throw failure(`create pod ${name}`, pod);
			const deadline = Date.now() + (options.startTimeoutMs ?? 120_000);
			while (address === undefined && Date.now() < deadline) {
				address = await inspect();
				if (address === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
			}
			if (address === undefined) throw new Error(`kubernetes pod ${name} did not start in time`);
		},
		async fetch(path, init) {
			if (address === undefined) address = await inspect();
			if (address === undefined) throw new Error(`browser ${browserId} is not running`);
			return send(`http://${address.host}:${address.port}${path}`, init);
		},
		async stop() {
			address = undefined;
			await remove();
		},
		address: () => address,
	};
}

/** Removes every Pod (and its Secret) of this stack's browser host that `keep` does not name. */
export async function removeKubernetesLeftovers(
	options: KubernetesOptions,
	keep: ReadonlySet<string>,
): Promise<number> {
	const call = client(options);
	const selector = encodeURIComponent(`${STACK_LABEL}=${labelValue(options.stack)}`);
	const listed = await call("GET", `/pods?labelSelector=${selector}`);
	if (listed.status !== 200) return 0;
	const kept = new Set([...keep].map(labelValue));
	let removed = 0;
	for (const pod of (listed.body as { items?: (PodStatus & { metadata?: { name?: string } })[] }).items ?? []) {
		const podName = pod.metadata?.name;
		const browser = pod.metadata?.labels?.[BROWSER_LABEL] ?? "";
		if (podName === undefined || kept.has(browser)) continue;
		await call("DELETE", `/pods/${podName}`, { gracePeriodSeconds: 0 });
		await call("DELETE", `/secrets/${podName}`);
		removed += 1;
	}
	return removed;
}
