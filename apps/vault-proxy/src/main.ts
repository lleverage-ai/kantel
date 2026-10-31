// Kantel's stub vault: a default-deny HTTP forward proxy, the only way out of
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
// - Decision, from one of two sources (KANTEL_EGRESS_SOURCE):
//   - `static` (the default): a route policy (host, port, methods, path
//     prefix) from VAULT_POLICY. Allowed requests get the route's header
//     injected from a secret only this process holds.
//   - `vault`: the M1 vault decides, through the gateway's egress decision
//     API (KANTEL_EGRESS_URL, with the shared key KANTEL_EGRESS_KEY), once
//     per request, for the session and the deployment's organisation and
//     project (GET /v1/egress/scope, asked again every 10 seconds). The vault injects only over https, so it
//     decides requests to port 443; a denial carries the vault's reason and its
//     fix. An allowed credential goes out only with the item values the gateway
//     names in `redact`, which are redacted from every response from then on. The policy file's routes with no credential stay this proxy's own
//     "open" routes, matched first without asking the vault, since the vault
//     has no way to allow a request without one; its credentialed routes are
//     the vault's (the gateway imports them). Without the key, or when the
//     vault can't be reached, every request but an open route's is refused,
//     saying why: never the static file's credentials instead.
//     A session placeholder in an auth header (see placeholder.ts) goes to
//     the vault with the request, never through an open route; the vault
//     allows it only on its item's own hosts while it is current, and the
//     header that carried it is swapped for the item's injection.
//   Everything else is refused with 403. Every decision is audited.
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
import { type PlaceholderFound, placeholderIn, withInjection } from "./placeholder.ts";
import { assertRedactable, Redactor } from "./redact.ts";

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

// Settings named before the rename (HARBOUR_*) still count: each unset KANTEL_* takes its old name's value (TASK-4231).
// This app has no workspace dependencies, so it does here what @kantel/contracts/legacy-env does elsewhere.
for (const key of Object.keys(process.env)) {
	if (!key.startsWith("HARBOUR_")) continue;
	const name = `KANTEL_${key.slice("HARBOUR_".length)}`;
	if (process.env[name] === undefined) process.env[name] = process.env[key];
}

const env = (name: string, fallback?: string) => {
	const value = process.env[name] ?? fallback;
	if (value === undefined) throw new Error(`missing ${name}`);
	return value;
};

const source = env("KANTEL_EGRESS_SOURCE", "static");
if (source !== "static" && source !== "vault") throw new Error("KANTEL_EGRESS_SOURCE must be static or vault");
const policyPath = env("VAULT_POLICY", "/etc/harbour/vault-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Policy;
// With the vault deciding, the file's credentialed routes are the vault's; only those without a credential stay here.
const routes = source === "vault" ? policy.routes.filter((route) => !route.inject) : policy.routes;
const isolateKey = env("VAULT_ISOLATE_KEY");
const pool = new pg.Pool({ connectionString: env("KANTEL_DATABASE_URL"), max: 5 });
const port = Number(env("PORT", "3128"));

const egressUrl = env("KANTEL_EGRESS_URL", "http://gateway:8080").replace(/\/+$/, "");
const egressKey = process.env.KANTEL_EGRESS_KEY ?? "";
/** Why the vault can't be asked at all, when it can't: every request it would decide is refused with this. */
const unconfigured =
	source === "vault" && egressKey.length < 16
		? "egress decisions are not set up: KANTEL_EGRESS_KEY is missing or shorter than 16 characters"
		: undefined;

const secrets = new Map<string, string>();
for (const route of routes) {
	if (!route.inject) continue;
	const secret = env(route.inject.secretEnv);
	assertRedactable(route.inject.secretEnv, secret);
	secrets.set(route.id, secret);
}
const redacted = new Set(secrets.values());
let redactor = new Redactor([...redacted]);

function redactable(secret: string): boolean {
	try {
		assertRedactable("credential", secret);
		return true;
	} catch {
		return false;
	}
}

/**
 * Redact the item values in a credential the vault hands over from every response from now on. The gateway names them
 * (`redact`, cut out of the header by the item's template), since the proxy can't tell a template from its key: each
 * must be part of the header and one redaction can match. False when they aren't, or there are none, and the request
 * must not go out with the credential.
 */
function redactFromNowOn(value: string, keys: unknown): boolean {
	if (!Array.isArray(keys) || keys.length === 0) return false;
	if (!keys.every((key) => typeof key === "string" && value.includes(key) && redactable(key))) return false;
	const fresh = (keys as string[]).filter((key) => !redacted.has(key));
	if (fresh.length > 0) {
		for (const word of fresh) redacted.add(word);
		redactor = new Redactor([...redacted]);
	}
	return true;
}

// A bug in one request must not take the vault down for every session.
process.on("unhandledRejection", (error) =>
	console.error("vault: unhandled rejection:", redactor.text(String(error)).text),
);

// ------------------------------------------------------------------ the CA

const caDir = env("VAULT_CA_DIR", "/var/lib/harbour-vault");
const ca = loadCa();
// One key for every intercepted host's certificate, new on each start.
const leafKeyPath = `${caDir}/leaf.key`;
const leafKey = execFileSync("openssl", [
	"genpkey",
	"-algorithm",
	"EC",
	"-pkeyopt",
	"ec_paramgen_curve:P-256",
]).toString();
writeFileSync(leafKeyPath, leafKey, { mode: 0o600 });
const contexts = new Map<string, tls.SecureContext>();

/** The vault's CA, made on first start and kept in its volume so sandboxes keep trusting it across restarts. */
function loadCa(): { cert: string; keyPath: string; certPath: string } {
	mkdirSync(caDir, { recursive: true, mode: 0o700 });
	const keyPath = `${caDir}/ca.key`;
	const certPath = `${caDir}/ca.crt`;
	if (!existsSync(keyPath) || !existsSync(certPath)) {
		const args = ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
		args.push("-keyout", keyPath, "-out", certPath, "-days", "365", "-subj", "/CN=Kantel vault CA (M0 spike)");
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
	args.push(
		"-subj",
		`/CN=${host.slice(0, 64)}`,
		"-days",
		"30",
		"-set_serial",
		`0x${crypto.randomUUID().replaceAll("-", "")}`,
	);
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
				await pool.query(
					`SELECT session_id, tier FROM harbour.sandbox_tokens WHERE token = $1 AND expires_at > now()`,
					[token],
				)
			).rows[0];
			if (row) return { sessionId: row.session_id, tier: row.tier };
		}
	}
	return undefined;
}

function match(host: string, portNumber: number, method: string, path: string): Route | undefined {
	return routes.find(
		(route) =>
			route.tunnel !== true &&
			route.host === host.toLowerCase() &&
			(route.ports === undefined || route.ports.includes(portNumber)) &&
			route.methods.includes(method) &&
			path.startsWith(route.pathPrefix ?? "/"),
	);
}

function tunnelRoute(host: string, portNumber: number): Route | undefined {
	return routes.find(
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
const redact = (text: string) => redactor.text(text);
const redactBytes = (bytes: Buffer) => redactor.bytes(bytes);

/** A CONNECT authority we will act on: a DNS name or IPv4 literal, and a port in range. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
	const match = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([0-9]{1,5})$/.exec(authority);
	if (match === null) return undefined;
	const port = Number(match[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	return { host: match[1]!.toLowerCase(), port };
}

/** Run a request handler; any failure becomes a 502 for that request only. */
async function guarded(res: http.ServerResponse, handle: () => Promise<void>) {
	try {
		await handle();
	} catch (error) {
		console.error("vault: request failed:", redact(String(error)).text);
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
		res.end("harbour vault: internal error\n");
	}
}

function deny(res: http.ServerResponse, reason: string) {
	res.writeHead(403, { "content-type": "text/plain", "x-harbour-vault": "denied" });
	res.end(`harbour vault: denied: ${reason}\n`);
}

// ------------------------------------------------------------------ decisions

type Verdict =
	| {
			allow: true;
			/** The static route's ID, or the vault's policy or grant. */
			route: string;
			inject?: { header: string; value: string };
			useId?: string;
	  }
	| { allow: false; reason: string; message: string };

/** The methods the vault's decision API knows (@kantel/vault's HTTP_METHODS). */
const VAULT_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const VAULT_TIMEOUT_MS = 5_000;

interface VaultScope {
	organisationId: string;
	projectId: string;
}
/**
 * How long the proxy keeps the organisation and project before asking again: a gateway restarted onto a new deployment
 * (a fresh database, or the in-memory gateway) has new ones, and the old ones hold no grants.
 */
const SCOPE_TTL_MS = 10_000;
let vaultScope: { scope: VaultScope; until: number } | undefined;

async function askVault(path: string, init: RequestInit = {}): Promise<unknown> {
	const response = await fetch(`${egressUrl}${path}`, {
		...init,
		headers: { authorization: `Bearer ${egressKey}`, "content-type": "application/json" },
		signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
	});
	const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
	if (!response.ok) {
		throw new Error(`the vault answered ${response.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
	}
	return body;
}

/** The organisation and project every decision is for, kept for SCOPE_TTL_MS. */
async function scopeOfVault(): Promise<VaultScope> {
	if (vaultScope !== undefined && Date.now() < vaultScope.until) return vaultScope.scope;
	const scope = (await askVault("/v1/egress/scope")) as Partial<VaultScope> | undefined;
	if (typeof scope?.organisationId !== "string" || typeof scope.projectId !== "string") {
		throw new Error("the vault's scope has no organisation and project");
	}
	const fresh = { organisationId: scope.organisationId, projectId: scope.projectId };
	vaultScope = { scope: fresh, until: Date.now() + SCOPE_TTL_MS };
	return fresh;
}

function staticVerdict(method: string, target: URL, portNumber: number): Verdict {
	const route = match(target.hostname, portNumber, method, target.pathname);
	if (route === undefined) {
		return { allow: false, reason: "no policy", message: `no policy for ${method} ${target.host}${target.pathname}` };
	}
	return {
		allow: true,
		route: route.id,
		...(route.inject
			? {
					inject: {
						header: route.inject.header,
						value: route.inject.template.replace("{secret}", secrets.get(route.id)!),
					},
				}
			: {}),
	};
}

/** An open route's (no credential, no question), else the vault's decision; refused when the vault can't be asked. */
async function vaultVerdict(
	caller: Caller,
	method: string,
	target: URL,
	portNumber: number,
	found: PlaceholderFound,
): Promise<Verdict> {
	if (found.kind === "ambiguous") {
		const reason = "the request's auth headers carry more than one placeholder";
		return { allow: false, reason, message: reason };
	}
	// A request naming a credential always goes to the vault, which checks the placeholder is current and bound to
	// this host; an open route never forwards it.
	const open = found.kind === "one" ? undefined : staticVerdict(method, target, portNumber);
	if (open?.allow) return open;
	if (unconfigured !== undefined) return { allow: false, reason: unconfigured, message: unconfigured };
	// The vault injects only over https, and its routes name no port: it decides https on 443 only.
	if (target.protocol !== "https:" || portNumber !== 443 || !VAULT_METHODS.has(method)) {
		const reason = `only https on port 443 with a standard method goes to the vault, and no open route allows ${method} ${target.host}${target.pathname}`;
		return { allow: false, reason, message: reason };
	}
	let decision: {
		allow?: boolean;
		reason?: string;
		useId?: string;
		policyId?: string;
		grantId?: string;
		inject?: { header?: unknown; value?: unknown };
		redact?: unknown;
		fix?: { message?: string };
	};
	try {
		const scope = await scopeOfVault();
		decision = (await askVault("/v1/egress/decisions", {
			method: "POST",
			body: JSON.stringify({
				organisationId: scope.organisationId,
				projectId: scope.projectId,
				sessionId: caller.sessionId,
				method,
				url: target.href,
				...(found.kind === "one" ? { placeholder: found.placeholder } : {}),
			}),
		})) as typeof decision;
	} catch (error) {
		const reason = `the vault could not be asked: ${error instanceof Error ? error.message : String(error)}`;
		return { allow: false, reason, message: reason };
	}
	if (decision?.allow === true) {
		const route = decision.policyId ?? decision.grantId ?? "vault";
		const inject = decision.inject;
		if (inject === undefined) return { allow: true, route, ...(decision.useId ? { useId: decision.useId } : {}) };
		if (
			typeof inject.header !== "string" ||
			typeof inject.value !== "string" ||
			!redactFromNowOn(inject.value, decision.redact)
		) {
			const reason = "the vault's credential for this route could not be redacted from responses";
			return { allow: false, reason, message: reason };
		}
		return {
			allow: true,
			route,
			inject: { header: inject.header, value: inject.value },
			...(decision.useId ? { useId: decision.useId } : {}),
		};
	}
	const reason = decision?.reason ?? "the vault denied it";
	const fix = decision?.fix?.message;
	return { allow: false, reason, message: fix ? `${reason}. ${fix}` : reason };
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
	const sent = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (HOP.has(name) || value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) sent.append(name, item);
	}
	// Only the vault issues placeholders; with a static policy there are none to find.
	const found: PlaceholderFound = source === "vault" ? placeholderIn(sent) : { kind: "none" };
	const verdict =
		source === "vault"
			? await vaultVerdict(caller, method, target, portNumber, found)
			: staticVerdict(method, target, portNumber);
	if (!verdict.allow) {
		await audit(caller, "vault.deny", { ...where, reason: verdict.reason, source });
		return deny(res, verdict.message);
	}
	const route = { id: verdict.route, inject: verdict.inject };
	const headers = withInjection(sent, found, verdict.inject);
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
		res.writeHead(upstream.status, {
			...out,
			"content-length": String(clean.bytes.length),
			"x-harbour-vault": route.id,
		});
		res.end(clean.bytes);
		await audit(caller, "vault.allow", {
			...where,
			route: route.id,
			injected: route.inject ? route.inject.header : null,
			source,
			...(verdict.useId === undefined ? {} : { useId: verdict.useId }),
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
const server = http.createServer({ requireHostHeader: false }, (req, res) => void guarded(res, () => serve(req, res)));

async function serve(req: http.IncomingMessage, res: http.ServerResponse) {
	if (req.url === "/healthz") {
		// Misconfigured, it still refuses every request saying why, but reports unhealthy so the stack doesn't come up.
		res.writeHead(unconfigured === undefined ? 200 : 503, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				ok: unconfigured === undefined,
				source,
				routes: routes.length,
				...(unconfigured === undefined ? {} : { reason: unconfigured }),
			}),
		);
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
}

/** Requests inside intercepted CONNECT tunnels, keyed by their TLS socket. */
const tunnels = new WeakMap<object, { caller: Caller; host: string; port: number }>();
const intercepted = http.createServer(
	(req, res) =>
		void guarded(res, async () => {
			const tunnel = tunnels.get(req.socket);
			if (tunnel === undefined) return deny(res, "no tunnel");
			if (!(req.url ?? "").startsWith("/")) return deny(res, "origin-form request expected inside a tunnel");
			const authority = tunnel.port === 443 ? tunnel.host : `${tunnel.host}:${tunnel.port}`;
			await proxy(req, res, new URL(`https://${authority}${req.url}`), tunnel.caller);
		}),
);

server.on("connect", (req, socket: net.Socket, head) => {
	socket.on("error", () => socket.destroy());
	connect(req, socket, head).catch((error) => {
		console.error("vault: CONNECT failed:", redact(String(error)).text);
		socket.destroy();
	});
});

async function connect(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
	const caller = await callerOf(req.headers);
	const authority = parseAuthority(req.url ?? "");
	if (authority === undefined) {
		await audit(caller, "vault.deny", {
			method: "CONNECT",
			host: String(req.url ?? "").slice(0, 200),
			reason: "bad authority",
		});
		socket.end("HTTP/1.1 400 Bad Request\r\nx-harbour-vault: denied\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	const { host, port: portNumber } = authority;
	const where = { method: "CONNECT", host, port: portNumber };
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
}

server.listen(port, () =>
	console.log(
		source === "vault"
			? `vault proxy on ${port}: decisions from the vault at ${egressUrl}${unconfigured ? ` (refusing all but open routes: ${unconfigured})` : ""}; open routes: ${routes.map((r) => r.id).join(", ") || "none"}`
			: `vault proxy on ${port}: ${routes.map((r) => r.id).join(", ")}`,
	),
);
