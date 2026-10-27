// Harbour's stub vault: a default-deny HTTP forward proxy, the only way out of
// a sandbox on the self-hosted target.
//
// - Isolate tier: workerd sends every Dynamic Worker fetch() here in proxy
//   style (absolute-form request line), tagged by the isolate host with the
//   session and a host key the sandbox never sees.
// - Container tier: HTTP(S)_PROXY points here, with a per-container token as
//   proxy credentials; the token resolves to a session in Postgres.
// - Decision: a route policy (host, methods, path prefix). Allowed requests
//   get the route's header injected from a secret only this process holds.
//   Everything else is refused with 403. Every decision is audited.
// - CONNECT (HTTPS from a container) can only be allowed or refused per host:
//   injecting into TLS would need a MITM CA in the sandbox image. M0 refuses
//   CONNECT unless a route sets `tunnel: true`.

import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import pg from "pg";

interface Route {
	id: string;
	host: string;
	ports?: number[];
	methods: string[];
	pathPrefix?: string;
	inject?: { header: string; template: string; secretEnv: string };
	tunnel?: boolean;
}

interface Policy {
	routes: Route[];
}

const env = (name: string, fallback?: string) => {
	const value = process.env[name] ?? fallback;
	if (value === undefined) throw new Error(`missing ${name}`);
	return value;
};

const policyPath = env("VAULT_POLICY", "/etc/harbour/vault-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Policy;
const isolateKey = env("VAULT_ISOLATE_KEY");
const pool = new pg.Pool({ connectionString: env("HARBOUR_DATABASE_URL"), max: 5 });
const port = Number(env("PORT", "3128"));

const secrets = new Map<string, string>();
for (const route of policy.routes) {
	if (route.inject) secrets.set(route.id, env(route.inject.secretEnv));
}
const secretValues = [...secrets.values()];

const HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"x-harbour-session",
	"x-harbour-tier",
	"x-harbour-host-key",
]);

interface Caller {
	sessionId: string;
	tier: string;
}

async function callerOf(headers: http.IncomingHttpHeaders): Promise<Caller | undefined> {
	if (headers["x-harbour-host-key"] === isolateKey && typeof headers["x-harbour-session"] === "string") {
		return { sessionId: headers["x-harbour-session"], tier: String(headers["x-harbour-tier"] ?? "isolate") };
	}
	const auth = headers["proxy-authorization"];
	if (typeof auth === "string" && auth.startsWith("Basic ")) {
		const [, token] = Buffer.from(auth.slice(6), "base64").toString().split(":");
		if (token) {
			const row = (
				await pool.query(`SELECT session_id, tier FROM harbour.sandbox_tokens WHERE token = $1 AND expires_at > now()`, [
					token,
				])
			).rows[0];
			if (row) return { sessionId: row.session_id, tier: row.tier };
		}
	}
	return undefined;
}

function match(host: string, portNumber: number, method: string, path: string, forTunnel: boolean): Route | undefined {
	return policy.routes.find(
		(route) =>
			route.host === host.toLowerCase() &&
			(route.ports === undefined || route.ports.includes(portNumber)) &&
			(forTunnel
				? route.tunnel === true
				: route.methods.includes(method) && path.startsWith(route.pathPrefix ?? "/")),
	);
}

async function audit(caller: Caller | undefined, kind: string, detail: Record<string, unknown>) {
	await pool
		.query(`INSERT INTO harbour.audit_events (session_id, actor, kind, detail) VALUES ($1, $2, $3, $4)`, [
			caller?.sessionId ?? null,
			`vault:${caller?.tier ?? "unknown"}`,
			kind,
			JSON.stringify(detail),
		])
		.catch((error) => console.error("audit failed", error.message));
}

/** Never let a secret leave in a response, an error or a log line. */
function redact(text: string): string {
	let out = text;
	for (const secret of secretValues) out = out.split(secret).join("[redacted]");
	return out;
}

function deny(res: http.ServerResponse, reason: string) {
	res.writeHead(403, { "content-type": "text/plain", "x-harbour-vault": "denied" });
	res.end(`harbour vault: denied: ${reason}\n`);
}

// Runs on Node, not Bun: workerd's proxy-style requests carry the full URL in
// the request line and no Host header, which Bun's HTTP parser rejects.
const server = http.createServer({ requireHostHeader: false }, async (req, res) => {
	const started = performance.now();
	if (req.url === "/healthz") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, routes: policy.routes.length }));
		return;
	}
	let target: URL;
	try {
		target = new URL(req.url ?? "");
	} catch {
		return deny(res, "not a proxy request (absolute URL required)");
	}
	const method = req.method ?? "GET";
	const caller = await callerOf(req.headers);
	const portNumber = Number(target.port || (target.protocol === "https:" ? 443 : 80));
	const where = { method, host: target.hostname, port: portNumber, path: target.pathname };
	if (caller === undefined) {
		await audit(undefined, "vault.deny", { ...where, reason: "unknown caller" });
		return deny(res, "unknown caller");
	}
	const route = match(target.hostname, portNumber, method, target.pathname, false);
	if (route === undefined) {
		await audit(caller, "vault.deny", { ...where, reason: "no policy" });
		return deny(res, `no policy for ${method} ${target.host}${target.pathname}`);
	}
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (HOP.has(name) || value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
	}
	if (route.inject) headers.set(route.inject.header, route.inject.template.replace("{secret}", secrets.get(route.id)!));
	try {
		let body: Buffer | undefined;
		if (method !== "GET" && method !== "HEAD") {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			body = Buffer.concat(chunks);
		}
		const upstream = await fetch(target, { method, headers, body, redirect: "manual" });
		const out: Record<string, string> = {};
		upstream.headers.forEach((value, name) => {
			if (!HOP.has(name) && name !== "content-encoding" && name !== "content-length") out[name] = redact(value);
		});
		const bytes = Buffer.from(await upstream.arrayBuffer());
		res.writeHead(upstream.status, { ...out, "content-length": String(bytes.length), "x-harbour-vault": route.id });
		res.end(bytes);
		await audit(caller, "vault.allow", {
			...where,
			route: route.id,
			injected: route.inject ? route.inject.header : null,
			status: upstream.status,
			ms: Math.round(performance.now() - started),
		});
	} catch (error) {
		const message = redact(error instanceof Error ? error.message : String(error));
		await audit(caller, "vault.error", { ...where, route: route.id, error: message });
		res.writeHead(502, { "content-type": "text/plain" });
		res.end(`harbour vault: upstream error: ${message}\n`);
	}
});

server.on("connect", async (req, socket: net.Socket, head) => {
	const [host = "", portText = "443"] = (req.url ?? "").split(":");
	const caller = await callerOf(req.headers);
	const where = { method: "CONNECT", host, port: Number(portText) };
	const route = caller ? match(host, Number(portText), "CONNECT", "/", true) : undefined;
	if (caller === undefined || route === undefined) {
		await audit(caller, "vault.deny", { ...where, reason: caller ? "no tunnel policy" : "unknown caller" });
		socket.end("HTTP/1.1 403 Forbidden\r\nx-harbour-vault: denied\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	const upstream = net.connect(Number(portText), host, () => {
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	const close = () => {
		upstream.destroy();
		socket.destroy();
	};
	upstream.on("error", close);
	socket.on("error", close);
	await audit(caller, "vault.tunnel", { ...where, route: route.id });
});

server.listen(port, () => console.log(`vault proxy on ${port}: ${policy.routes.map((r) => r.id).join(", ")}`));
