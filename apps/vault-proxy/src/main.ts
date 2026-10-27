// Harbour's stub vault: a default-deny HTTP forward proxy, the only way out of
// a sandbox on the self-hosted target.
//
// - Isolate tier: workerd sends every Dynamic Worker fetch() here in proxy
//   style (absolute-form request line, `https://` included), tagged by the
//   isolate host with the session and a host key the sandbox never sees.
// - Container tier: HTTP(S)_PROXY points here, with a per-container token as
//   proxy credentials; the token resolves to a session in Postgres. HTTPS
//   arrives as CONNECT. The vault terminates that TLS with a certificate from
//   its own CA (the sandbox trusts only that CA; it has no other route out),
//   then applies the same policy to each request inside, so it can inject
//   into HTTPS and answer a refusal as an ordinary 403.
// - Decision: a route policy (host, port, methods, path prefix). Allowed
//   requests get the route's header injected from a secret only this process
//   holds. Everything else is refused with 403. Every decision is audited.
// - Responses: any secret the upstream echoes back is replaced with
//   `[vault:redacted]` in headers and body, and counted in the audit.
// - A route with `tunnel: true` is passed through as raw TLS instead (no
//   injection, no per-request policy), for clients that pin certificates.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
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
const REDACTED = "[vault:redacted]";

const secrets = new Map<string, string>();
for (const route of policy.routes) {
	if (route.inject) secrets.set(route.id, env(route.inject.secretEnv));
}
const secretValues = [...new Set(secrets.values())].filter((s) => s.length > 0);

// ------------------------------------------------------------------ the CA

const caDir = env("VAULT_CA_DIR", "/var/lib/harbour-vault");
const ca = loadCa();
// One key for every intercepted host's certificate, new on each start.
const leafKeyPath = `${caDir}/leaf.key`;
const leafKey = execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"]).toString();
writeFileSync(leafKeyPath, leafKey, { mode: 0o600 });
const contexts = new Map<string, tls.SecureContext>();

/** The vault's CA, made on first start and kept in its volume so sandboxes keep trusting it across restarts. */
function loadCa(): { cert: string; keyPath: string; certPath: string } {
	mkdirSync(caDir, { recursive: true, mode: 0o700 });
	const keyPath = `${caDir}/ca.key`;
	const certPath = `${caDir}/ca.crt`;
	if (!existsSync(keyPath) || !existsSync(certPath)) {
		const args = ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
		args.push("-keyout", keyPath, "-out", certPath, "-days", "365", "-subj", "/CN=Harbour vault CA (M0 spike)");
		args.push("-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
		execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
	}
	return { cert: readFileSync(certPath, "utf8"), keyPath, certPath };
}

/** A certificate for one host, signed by the CA, cached for the process lifetime. */
function contextFor(host: string): tls.SecureContext {
	let context = contexts.get(host);
	if (context !== undefined) return context;
	const san = net.isIP(host) ? `IP:${host}` : `DNS:${host}`;
	const args = ["req", "-x509", "-key", leafKeyPath, "-CA", ca.certPath, "-CAkey", ca.keyPath];
	args.push("-subj", `/CN=${host.slice(0, 64)}`, "-days", "30", "-set_serial", `0x${crypto.randomUUID().replaceAll("-", "")}`);
	args.push("-addext", `subjectAltName=${san}`, "-addext", "basicConstraints=critical,CA:FALSE");
	args.push("-addext", "extendedKeyUsage=serverAuth");
	const cert = execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
	context = tls.createSecureContext({ key: leafKey, cert });
	contexts.set(host, context);
	return context;
}

// ------------------------------------------------------------------ policy

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

function match(host: string, portNumber: number, method: string, path: string): Route | undefined {
	return policy.routes.find(
		(route) =>
			route.tunnel !== true &&
			route.host === host.toLowerCase() &&
			(route.ports === undefined || route.ports.includes(portNumber)) &&
			route.methods.includes(method) &&
			path.startsWith(route.pathPrefix ?? "/"),
	);
}

function tunnelRoute(host: string, portNumber: number): Route | undefined {
	return policy.routes.find(
		(route) =>
			route.tunnel === true &&
			route.host === host.toLowerCase() &&
			(route.ports === undefined || route.ports.includes(portNumber)),
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
function redact(text: string): { text: string; count: number } {
	let out = text;
	let count = 0;
	for (const secret of secretValues) {
		const parts = out.split(secret);
		count += parts.length - 1;
		out = parts.join(REDACTED);
	}
	return { text: out, count };
}

function redactBytes(bytes: Buffer): { bytes: Buffer; count: number } {
	let out = bytes;
	let count = 0;
	for (const secret of secretValues) {
		const needle = Buffer.from(secret);
		if (out.indexOf(needle) === -1) continue;
		const pieces: Buffer[] = [];
		let from = 0;
		for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, from)) {
			pieces.push(out.subarray(from, at), Buffer.from(REDACTED));
			from = at + needle.length;
			count++;
		}
		pieces.push(out.subarray(from));
		out = Buffer.concat(pieces);
	}
	return { bytes: out, count };
}

function deny(res: http.ServerResponse, reason: string) {
	res.writeHead(403, { "content-type": "text/plain", "x-harbour-vault": "denied" });
	res.end(`harbour vault: denied: ${reason}\n`);
}

/** Apply the policy to one request, forward it if allowed, and audit the decision. */
async function proxy(req: http.IncomingMessage, res: http.ServerResponse, target: URL, caller: Caller | undefined) {
	const started = performance.now();
	const method = req.method ?? "GET";
	const portNumber = Number(target.port || (target.protocol === "https:" ? 443 : 80));
	const where = { method, host: target.hostname, port: portNumber, path: target.pathname };
	if (caller === undefined) {
		await audit(undefined, "vault.deny", { ...where, reason: "unknown caller" });
		return deny(res, "unknown caller");
	}
	const route = match(target.hostname, portNumber, method, target.pathname);
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
		let redactions = 0;
		const out: Record<string, string> = {};
		upstream.headers.forEach((value, name) => {
			if (HOP.has(name) || name === "content-encoding" || name === "content-length") return;
			const clean = redact(value);
			redactions += clean.count;
			out[name] = clean.text;
		});
		const clean = redactBytes(Buffer.from(await upstream.arrayBuffer()));
		redactions += clean.count;
		res.writeHead(upstream.status, { ...out, "content-length": String(clean.bytes.length), "x-harbour-vault": route.id });
		res.end(clean.bytes);
		await audit(caller, "vault.allow", {
			...where,
			route: route.id,
			injected: route.inject ? route.inject.header : null,
			redactions,
			status: upstream.status,
			ms: Math.round(performance.now() - started),
		});
	} catch (error) {
		const message = redact(error instanceof Error ? error.message : String(error)).text;
		await audit(caller, "vault.error", { ...where, route: route.id, error: message });
		res.writeHead(502, { "content-type": "text/plain" });
		res.end(`harbour vault: upstream error: ${message}\n`);
	}
}

// ------------------------------------------------------------------ servers

// Runs on Node, not Bun: workerd's proxy-style requests carry the full URL in
// the request line and no Host header, which Bun's HTTP parser rejects.
const server = http.createServer({ requireHostHeader: false }, async (req, res) => {
	if (req.url === "/healthz") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, routes: policy.routes.length }));
		return;
	}
	// The CA certificate is public: session hosts put it in each sandbox.
	if (req.url === "/ca.crt") {
		res.writeHead(200, { "content-type": "application/x-pem-file" });
		res.end(ca.cert);
		return;
	}
	let target: URL;
	try {
		target = new URL(req.url ?? "");
	} catch {
		return deny(res, "not a proxy request (absolute URL required)");
	}
	await proxy(req, res, target, await callerOf(req.headers));
});

/** Requests inside intercepted CONNECT tunnels, keyed by their TLS socket. */
const tunnels = new WeakMap<object, { caller: Caller; host: string; port: number }>();
const intercepted = http.createServer(async (req, res) => {
	const tunnel = tunnels.get(req.socket);
	if (tunnel === undefined) return deny(res, "no tunnel");
	const authority = tunnel.port === 443 ? tunnel.host : `${tunnel.host}:${tunnel.port}`;
	await proxy(req, res, new URL(`https://${authority}${req.url ?? "/"}`), tunnel.caller);
});

server.on("connect", async (req, socket: net.Socket, head) => {
	const [host = "", portText = "443"] = (req.url ?? "").split(":");
	const portNumber = Number(portText);
	const caller = await callerOf(req.headers);
	const where = { method: "CONNECT", host, port: portNumber };
	socket.on("error", () => socket.destroy());
	if (caller === undefined) {
		await audit(undefined, "vault.deny", { ...where, reason: "unknown caller" });
		socket.end("HTTP/1.1 403 Forbidden\r\nx-harbour-vault: denied\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	const raw = tunnelRoute(host, portNumber);
	if (raw !== undefined) {
		const upstream = net.connect(portNumber, host, () => {
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
		await audit(caller, "vault.tunnel", { ...where, route: raw.id });
		return;
	}
	// Intercept: answer the CONNECT, then speak TLS as `host` with a CA-signed
	// certificate and hand each request inside to the policy.
	let context: tls.SecureContext;
	try {
		context = contextFor(host);
	} catch (error) {
		await audit(caller, "vault.error", { ...where, error: String(error) });
		socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head.length > 0) socket.unshift(head);
	const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
	secure.on("error", () => secure.destroy());
	tunnels.set(secure, { caller, host, port: portNumber });
	intercepted.emit("connection", secure);
});

server.listen(port, () => console.log(`vault proxy on ${port}: ${policy.routes.map((r) => r.id).join(", ")}`));
